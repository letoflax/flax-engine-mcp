import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * MCP progress notifications for long-running tool calls.
 *
 * A client opts in per request with `_meta.progressToken`. Handlers then call
 * reportProgress() from any polling loop; without a token it is a no-op, so
 * handlers never need to know whether the client asked for progress.
 *
 * `progress` is milliseconds elapsed since the tool call started. The MCP
 * spec requires the value to increase with every notification, which elapsed
 * time gives for free even when a tool polls several bridge operations.
 */
export type ProgressToken = string | number;

export interface ProgressNotificationParams {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
}

export type ProgressSink = (params: ProgressNotificationParams) => Promise<void> | void;
export type ProgressReporter = (message: string, totalMs?: number) => void;

/** Repeats of the same message are collapsed to one notification per interval. */
export const PROGRESS_REPEAT_INTERVAL_MS = 500;
/** Hard floor between any two notifications, so a loop with changing messages cannot flood the client. */
export const PROGRESS_MIN_INTERVAL_MS = 100;

const storage = new AsyncLocalStorage<ProgressReporter>();

export function createProgressReporter(
  progressToken: ProgressToken,
  sink: ProgressSink,
  now: () => number = Date.now,
): ProgressReporter {
  const startedAt = now();
  let lastProgress = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastMessage: string | undefined;
  return (message, totalMs) => {
    const at = now();
    const sinceLast = at - lastSentAt;
    if (sinceLast < PROGRESS_MIN_INTERVAL_MS) return;
    if (message === lastMessage && sinceLast < PROGRESS_REPEAT_INTERVAL_MS) return;
    const progress = Math.max(lastProgress + 1, at - startedAt);
    lastProgress = progress;
    lastSentAt = at;
    lastMessage = message;
    // A total the call has already outrun would read as more than 100%, so it is dropped.
    const total = totalMs !== undefined && totalMs >= progress ? totalMs : undefined;
    // Progress is best-effort: a client that went away must not fail the tool call.
    Promise.resolve()
      .then(() => sink({ progressToken, progress, ...(total === undefined ? {} : { total }), message }))
      .catch(() => undefined);
  };
}

export function runWithProgress<T>(reporter: ProgressReporter | undefined, fn: () => Promise<T>): Promise<T> {
  return reporter ? storage.run(reporter, fn) : fn();
}

/** Reports progress for the tool call running in the current async context, if its client asked for it. */
export function reportProgress(message: string, totalMs?: number): void {
  storage.getStore()?.(message, totalMs);
}
