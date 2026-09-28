// The runtime loop: heartbeats, the job lease loop, and delivery of results and failures.
import { CentralCityError, TransportError } from '../errors.js';
import { abortableSleep } from '../retry.js';
import { RuntimeClient, type FailureReason, type Job, type RuntimeOptions } from './client.js';
import type { SequenceStore } from './sequence.js';

export type Executor = (job: Job, context: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** Thrown by an executor to report a bounded failure under the current lease. */
export class ExecutorFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(`The executor reported ${reason}.`);
    this.name = 'ExecutorFailure';
  }
}

export type ConnectorEvent =
  | { type: 'connected' | 'stopped' | 'paused' | 'resumed' }
  | { type: 'retrying'; after: number; reason: string }
  | { type: 'claimed' | 'completed' | 'failed' | 'rejected'; jobId: string };

export interface ConnectorOptions extends RuntimeOptions {
  execute: Executor;
  sequenceStore: SequenceStore;
  signal: AbortSignal;
  /** Per-job execution deadline (default 35 s); on expiry the job is reported as execution-timeout. */
  executionTimeoutMs?: number;
  /** Idle poll interval for new jobs (default 2 s). */
  pollMs?: number;
  onEvent?: (event: ConnectorEvent) => void;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const FATAL = new Set(['auth', 'scope', 'forbidden']);

/**
 * Runs until the signal aborts (resolves) or a fatal error (rejects): an invalid credential, a
 * revoked agent, or a stale sequence store (409 "Heartbeat sequence must increase.").
 * - A rate limit (the runtime's 120/min per agent) pauses for Retry-After; it never stops the loop.
 * - While the workspace is paused, jobs come back empty or 409 paused: polling backs off from 30 s
 *   to 5 min.
 * - Claiming a job is never retried after an ambiguous failure; the server recovers a lost lease.
 * - Results and failures are retried with the same lease and output; never re-executed.
 * - An executor error or timeout is reported as runtime-unavailable or execution-timeout, so the
 *   lease does not simply lapse.
 */
export async function runConnector(options: ConnectorOptions): Promise<void> {
  const client = new RuntimeClient(options);
  const sleep = options.sleep ?? abortableSleep;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const emit = (event: ConnectorEvent) => options.onEvent?.(event);
  let fatal: unknown;
  const stop = (error: unknown) => {
    fatal ??= error;
    controller.abort();
  };
  const pause = (ms: number) => sleep(ms, signal).then(
    () => true,
    () => false,
  );
  const waitFor = (error: unknown, backoff: number) =>
    error instanceof CentralCityError && error.retryAfterMs ? Math.max(error.retryAfterMs, backoff) : backoff;
  const isFatal = (error: unknown) =>
    error instanceof CentralCityError &&
    (FATAL.has(error.kind) || error.code === 'runtime_sequence_stale' || error.kind === 'not_found');

  let heartbeatMs = 30_000;
  const heartbeat = async () => {
    let connected = false;
    let backoff = 1_000;
    while (!signal.aborted) {
      const sequence = await options.sequenceStore.next(); // storage errors are fatal
      try {
        const answer = await client.heartbeat(sequence, signal);
        heartbeatMs = Math.max(5, Math.min(60, answer.heartbeatSeconds ?? 30)) * 1000;
        if (!connected) {
          connected = true;
          emit({ type: 'connected' });
        }
        backoff = 1_000;
        if (!(await pause(heartbeatMs))) return;
      } catch (error) {
        if (signal.aborted) return;
        if (isFatal(error)) throw error;
        const after = waitFor(error, backoff);
        emit({ type: 'retrying', after, reason: 'heartbeat' });
        if (!(await pause(after))) return;
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  };

  const deliver = async (jobId: string, send: () => Promise<unknown>, done: 'completed' | 'failed') => {
    try {
      await send();
      emit({ type: done, jobId });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CentralCityError && ['conflict', 'paused', 'validation', 'not_found', 'gone'].includes(error.kind)) {
        emit({ type: 'rejected', jobId });
        return;
      }
      throw error;
    }
  };

  const jobs = async () => {
    const poll = options.pollMs ?? 2_000;
    let backoff = poll;
    let pausedBackoff = 0;
    while (!signal.aborted) {
      let claimed: Awaited<ReturnType<RuntimeClient['claimJob']>>;
      try {
        claimed = await client.claimJob(signal);
      } catch (error) {
        if (signal.aborted) return;
        if (isFatal(error)) throw error;
        if (error instanceof CentralCityError && error.kind === 'paused') {
          pausedBackoff = pausedBackoff ? Math.min(pausedBackoff * 2, 300_000) : 30_000;
          emit({ type: 'paused' });
          if (!(await pause(pausedBackoff))) return;
          continue;
        }
        const after = waitFor(error, backoff);
        emit({ type: 'retrying', after, reason: error instanceof CentralCityError ? error.code : 'network' });
        if (!(await pause(after))) return;
        backoff = Math.min(backoff * 2, 15_000);
        continue;
      }
      backoff = poll;
      if (pausedBackoff) {
        pausedBackoff = 0;
        emit({ type: 'resumed' });
      }
      if (!claimed) {
        if (!(await pause(poll))) return;
        continue;
      }
      const { job, leaseToken } = claimed;
      emit({ type: 'claimed', jobId: job.id });
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.executionTimeoutMs ?? 35_000)]);
      let outcome: { output: Record<string, unknown> } | { reason: FailureReason };
      try {
        outcome = { output: await runWithDeadline(options.execute, job, deadline) };
      } catch (error) {
        if (signal.aborted) return;
        outcome = {
          reason:
            error instanceof ExecutorFailure
              ? error.reason
              : error instanceof DeadlineError
                ? 'execution-timeout'
                : 'runtime-unavailable',
        };
      }
      if ('output' in outcome) {
        const output = outcome.output;
        let valid = true;
        try {
          await deliver(job.id, () => client.submitResult(job.id, leaseToken, output, signal), 'completed');
        } catch (error) {
          if (error instanceof TypeError) valid = false;
          else if (isFatal(error)) throw error;
          else emit({ type: 'retrying', after: 0, reason: 'result' });
        }
        if (!valid) await deliver(job.id, () => client.reportFailure(job.id, leaseToken, 'invalid-output', signal), 'failed').catch((error) => {
          if (isFatal(error)) throw error;
        });
      } else {
        const reason = outcome.reason;
        await deliver(job.id, () => client.reportFailure(job.id, leaseToken, reason, signal), 'failed').catch((error) => {
          if (isFatal(error)) throw error;
        });
      }
    }
  };

  try {
    await Promise.allSettled([heartbeat().catch(stop), jobs().catch(stop)]);
    if (fatal && !options.signal.aborted) throw fatal;
  } finally {
    controller.abort();
    await options.sequenceStore.close?.();
    emit({ type: 'stopped' });
  }
}

class DeadlineError extends Error {}

async function runWithDeadline(execute: Executor, job: Job, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DeadlineError('deadline'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([execute(Object.freeze({ ...job }) as Job, { signal }), timeout]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
