/**
 * Background jobs. A job is a named handler with a JSON payload. Services enqueue jobs
 * through `Effects.job(...)`, so nothing is enqueued for a transaction that rolled back.
 *
 * JOBS_MODE=queue  BullMQ on Redis; the worker process (worker.ts) runs the handlers.
 * JOBS_MODE=inline the handler runs in-process right after commit. Used by the
 *                  integration tests so assertions are deterministic.
 */
import { Queue, type JobsOptions } from "bullmq";
import { config } from "../core/config";
import { captureError, logger } from "../core/logger";
import { redisConnection } from "../integrations/redis";

export const QUEUES = ["gateway", "maintenance"] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobDefinitions {
  /** Release reservations whose request never settled. */
  "gateway.sweep-reservations": Record<string, never>;
  /** Probe every enabled route and feed the circuit breaker. */
  "gateway.health-probes": Record<string, never>;
  /** Fetch today's INR per USD rate. */
  "gateway.fx-sync": Record<string, never>;
  /** Email accounts whose available balance fell below the threshold. */
  "gateway.low-balance": Record<string, never>;
  "maintenance.lift-suspensions": Record<string, never>;
  /** Erase accounts whose deletion grace period is over. */
  "maintenance.purge-accounts": Record<string, never>;
  /** Delete expired request bodies, request rows past the retention setting, old probes and webhook ids. */
  "maintenance.retention": Record<string, never>;
}
export type JobName = keyof JobDefinitions;

type Handler<N extends JobName> = (data: JobDefinitions[N]) => Promise<void>;
const handlers = new Map<JobName, Handler<any>>();

export function registerJob<N extends JobName>(name: N, handler: Handler<N>): void {
  handlers.set(name, handler);
}

export function getHandler<N extends JobName>(name: N): Handler<N> | undefined {
  return handlers.get(name);
}

export function queueFor(name: JobName): QueueName {
  return name.split(".")[0] as QueueName;
}

const queues = new Map<QueueName, Queue>();
function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: redisConnection(),
      defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
    queues.set(name, q);
  }
  return q;
}

/** Per-job queue options. Scheduled jobs run again soon, so a failure is not retried at length. */
const JOB_OPTIONS: Partial<Record<JobName, JobsOptions>> = {
  "gateway.sweep-reservations": { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
  "gateway.health-probes": { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
  "gateway.low-balance": { attempts: 2, removeOnComplete: true, removeOnFail: 100 },
};

export async function enqueue<N extends JobName>(name: N, data: JobDefinitions[N], opts: JobsOptions = {}): Promise<void> {
  if (config.JOBS_MODE === "inline") {
    const handler = getHandler(name);
    if (!handler) {
      logger.warn({ job: name }, "inline job has no handler registered");
      return;
    }
    try {
      await handler(data);
    } catch (err) {
      captureError(err, { job: name });
    }
    return;
  }
  await queue(queueFor(name)).add(name, data, { ...JOB_OPTIONS[name], ...opts });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
