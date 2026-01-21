/**
 * Job queue for processing Actor runs.
 *
 * Uses PostgreSQL for durability and Redis for notifications.
 */

import pg from 'pg';
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { executeRun, buildActorEnv } from './docker.js';

const { Pool } = pg;

interface RunJob {
  id: string;
  actor_id: string;
  status: string;
  default_dataset_id: string;
  default_key_value_store_id: string;
  default_request_queue_id: string;
  timeout_secs: number;
  memory_mbytes: number;
}

interface ActorRow {
  id: string;
  name: string;
  default_run_options: {
    image?: string;
    envVars?: Record<string, string>;
  } | null;
}

let pool: pg.Pool;
let redis: Redis;
let isProcessing = false;
let activeRuns = 0;

/**
 * Initialize job queue connections.
 */
export async function initJobQueue(): Promise<void> {
  pool = new Pool({
    connectionString: config.databaseUrl,
  });

  redis = new Redis(config.redisUrl);

  // Subscribe to run notifications
  const subscriber = new Redis(config.redisUrl);
  await subscriber.subscribe('run:new');

  subscriber.on('message', (_channel, message) => {
    console.log(`New run notification: ${message}`);
    void processNextRun();
  });

  console.log('Job queue initialized');
}

/**
 * Main processing loop.
 */
export async function startProcessing(): Promise<void> {
  console.log('Starting run processor...');

  // Start webhook retry processor (every 10 seconds)
  void (async () => {
    while (true) {
      await processWebhookRetries();
      await sleep(10_000);
    }
  })();

  // Process any pending runs on startup

  while (true) {
    await processNextRun();
    await sleep(1000); // Check every second
  }
}

/**
 * Process the next pending run.
 */
async function processNextRun(): Promise<void> {
  if (isProcessing || activeRuns >= config.maxConcurrentRuns) {
    return;
  }

  isProcessing = true;

  try {
    // Get next pending run (FIFO)
    const result = await pool.query<RunJob>(`
      SELECT * FROM runs 
      WHERE status = 'READY' 
      ORDER BY created_at ASC 
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (!result.rows[0]) {
      return; // No pending runs
    }

    const run = result.rows[0];
    console.log(`Processing run ${run.id}`);

    // Update status to RUNNING
    await pool.query(
      `
      UPDATE runs SET status = 'RUNNING', started_at = NOW(), modified_at = NOW() 
      WHERE id = $1
    `,
      [run.id]
    );

    activeRuns++;

    // Process in background
    void processRun(run).finally(() => {
      activeRuns--;
    });
  } finally {
    isProcessing = false;
  }
}

/**
 * Process a single run.
 */
async function processRun(run: RunJob): Promise<void> {
  const runId = run.id;

  try {
    // Get actor details
    const actorResult = await pool.query<ActorRow>('SELECT * FROM actors WHERE id = $1', [
      run.actor_id,
    ]);

    if (!actorResult.rows[0]) {
      throw new Error(`Actor not found: ${run.actor_id}`);
    }

    const actor = actorResult.rows[0];
    const image = actor.default_run_options?.image ?? `crawlee-cloud/actor-${actor.name}:latest`;
    const actorEnvVars = actor.default_run_options?.envVars ?? {};

    // Fetch runtime env vars from Redis (set by CLI -e flag)
    const runtimeEnvVarsJson = await redis.get(`run:${run.id}:envVars`);
    const runtimeEnvVars = runtimeEnvVarsJson
      ? (JSON.parse(runtimeEnvVarsJson) as unknown as Record<string, string>)
      : {};

    // Build environment variables
    const baseEnv = buildActorEnv({
      runId: run.id,
      actorId: run.actor_id,
      apiBaseUrl: config.apiBaseUrl,
      token: config.apiToken,
      defaultDatasetId: run.default_dataset_id,
      defaultKeyValueStoreId: run.default_key_value_store_id,
      defaultRequestQueueId: run.default_request_queue_id,
      memoryMbytes: run.memory_mbytes,
      timeoutSecs: run.timeout_secs,
    });

    // Merge: base env < actor env (from actor.json) < runtime env (from -e flag)
    const env = { ...baseEnv, ...actorEnvVars, ...runtimeEnvVars };

    // Execute container
    const result = await executeRun({
      runId: run.id,
      actorId: run.actor_id,
      image,
      env,
      memoryMb: run.memory_mbytes,
      timeoutSecs: run.timeout_secs,
    });

    // Determine final status
    let status: string;
    if (result.exitCode === 0) {
      status = 'SUCCEEDED';
    } else if (result.exitCode === 143) {
      status = 'TIMED-OUT';
    } else {
      status = 'FAILED';
    }

    // Update run record
    await pool.query(
      `
      UPDATE runs 
      SET status = $1, finished_at = $2, modified_at = NOW()
      WHERE id = $3
    `,
      [status, result.finishedAt, runId]
    );

    console.log(`Run ${runId} completed with status: ${status}`);

    // Trigger webhooks
    await triggerWebhooks(runId, status);
  } catch (err) {
    console.error(`Run ${runId} failed with error:`, err);

    await pool.query(
      `
      UPDATE runs 
      SET status = 'FAILED', status_message = $1, finished_at = NOW(), modified_at = NOW()
      WHERE id = $2
    `,
      [(err as Error).message, runId]
    );

    await triggerWebhooks(runId, 'FAILED');
  }
}

/**
 * Trigger webhooks for run events.
 * Creates delivery records and attempts immediate delivery.
 */
async function triggerWebhooks(runId: string, status: string): Promise<void> {
  const eventType = `ACTOR.RUN.${status}`;

  // Get run details for payload
  const runResult = await pool.query<RunJob>('SELECT * FROM runs WHERE id = $1', [runId]);
  const run = runResult.rows[0];
  if (!run) return;

  // Get applicable webhooks (global OR scoped to this actor)
  const webhooks = await pool.query<{
    id: string;
    request_url: string;
    payload_template: string | null;
    headers: Record<string, string> | null;
    actor_id: string | null;
  }>(
    `SELECT * FROM webhooks
     WHERE is_enabled = true AND $1 = ANY(event_types)
       AND (actor_id IS NULL OR actor_id = $2)`,
    [eventType, run.actor_id]
  );

  if (webhooks.rows.length === 0) return;

  for (const webhook of webhooks.rows) {
    const deliveryId = nanoid();

    // Create delivery record
    await pool.query(
      `INSERT INTO webhook_deliveries (id, webhook_id, run_id, event_type, status, attempt_count, max_attempts, next_retry_at)
       VALUES ($1, $2, $3, $4, 'PENDING', 0, 5, NOW())`,
      [deliveryId, webhook.id, runId, eventType]
    );

    // Attempt immediate delivery
    await attemptWebhookDelivery(deliveryId, webhook, run, eventType);
  }
}

/**
 * Attempt a single webhook delivery.
 */
async function attemptWebhookDelivery(
  deliveryId: string,
  webhook: {
    id: string;
    request_url: string;
    payload_template: string | null;
    headers: Record<string, string> | null;
  },
  run: RunJob,
  eventType: string
): Promise<void> {
  const RETRY_DELAYS = [10, 30, 60, 300, 900]; // seconds

  try {
    const payload = webhook.payload_template
      ? JSON.parse(
          webhook.payload_template.replace(
            /\{\{([^}]+)\}\}/g,
            (_match: string, key: string): string => {
              const value = (run as unknown as Record<string, unknown>)[key];
              if (value !== undefined && (typeof value === 'string' || typeof value === 'number')) {
                return String(value);
              }
              return '';
            }
          )
        )
      : {
          eventType,
          eventData: { actorId: run.actor_id, actorRunId: run.id, status: run.status },
          createdAt: new Date().toISOString(),
        };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(webhook.headers ?? {}),
    };

    console.log(`Delivering webhook ${webhook.id} to ${webhook.request_url}`);

    const response = await fetch(webhook.request_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      // Success
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'DELIVERED', attempt_count = attempt_count + 1,
             response_status = $1, response_body = $2,
             finished_at = NOW(), next_retry_at = NULL
         WHERE id = $3`,
        [response.status, responseBody.slice(0, 1024), deliveryId]
      );
    } else {
      // HTTP error — schedule retry
      await scheduleRetry(deliveryId, response.status, responseBody.slice(0, 1024), RETRY_DELAYS);
    }
  } catch (err) {
    // Network error — schedule retry
    await scheduleRetry(deliveryId, null, (err as Error).message.slice(0, 1024), RETRY_DELAYS);
  }
}

/**
 * Schedule a retry with exponential backoff, or mark as failed if max attempts reached.
 */
async function scheduleRetry(
  deliveryId: string,
  responseStatus: number | null,
  responseBody: string,
  retryDelays: number[]
): Promise<void> {
  // Get current attempt count
  const delivery = await pool.query<{ attempt_count: number; max_attempts: number }>(
    'SELECT attempt_count, max_attempts FROM webhook_deliveries WHERE id = $1',
    [deliveryId]
  );

  if (!delivery.rows[0]) return;

  const newAttempt = delivery.rows[0].attempt_count + 1;

  if (newAttempt >= delivery.rows[0].max_attempts) {
    // Max retries exhausted
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'FAILED', attempt_count = $1,
           response_status = $2, response_body = $3,
           finished_at = NOW(), next_retry_at = NULL
       WHERE id = $4`,
      [newAttempt, responseStatus, responseBody, deliveryId]
    );
  } else {
    // Schedule next retry
    const delaySecs = retryDelays[newAttempt - 1] ?? retryDelays[retryDelays.length - 1]!;
    await pool.query(
      `UPDATE webhook_deliveries
       SET attempt_count = $1, response_status = $2, response_body = $3,
           next_retry_at = NOW() + INTERVAL '1 second' * $4
       WHERE id = $5`,
      [newAttempt, responseStatus, responseBody, delaySecs, deliveryId]
    );
  }
}

/**
 * Process pending webhook delivery retries.
 * Runs on a 10-second interval.
 */
async function processWebhookRetries(): Promise<void> {
  try {
    const pending = await pool.query<{
      id: string;
      webhook_id: string;
      run_id: string;
      event_type: string;
    }>(
      `SELECT wd.id, wd.webhook_id, wd.run_id, wd.event_type
       FROM webhook_deliveries wd
       WHERE wd.status = 'PENDING' AND wd.next_retry_at <= NOW()
       LIMIT 10
       FOR UPDATE SKIP LOCKED`
    );

    for (const delivery of pending.rows) {
      const webhook = await pool.query<{
        id: string;
        request_url: string;
        payload_template: string | null;
        headers: Record<string, string> | null;
      }>('SELECT * FROM webhooks WHERE id = $1', [delivery.webhook_id]);

      if (!webhook.rows[0]) {
        // Webhook deleted — mark delivery as failed
        await pool.query(
          `UPDATE webhook_deliveries SET status = 'FAILED', finished_at = NOW(), next_retry_at = NULL WHERE id = $1`,
          [delivery.id]
        );
        continue;
      }

      const run = await pool.query<RunJob>('SELECT * FROM runs WHERE id = $1', [delivery.run_id]);
      if (!run.rows[0]) continue;

      await attemptWebhookDelivery(delivery.id, webhook.rows[0], run.rows[0], delivery.event_type);
    }
  } catch (err) {
    console.error('Webhook retry processor error:', err);
  }
}

/**
 * Notify about new run.
 */
export async function notifyNewRun(runId: string): Promise<void> {
  await redis.publish('run:new', runId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
