/**
 * A signal that aborts when any parent aborts or after `timeoutMs`, built from a plain
 * AbortController and a timer. Node 20's AbortSignal.any() composites (and AbortSignal.timeout())
 * can be garbage-collected while still pending, so their abort never fires; this keeps strong
 * references until `dispose()`. Always call dispose() when the operation ends.
 */
export function linkedSignal(
  parents: ReadonlyArray<AbortSignal | undefined>,
  timeoutMs?: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const parent of parents) {
    if (!parent) continue;
    if (parent.aborted) {
      abort(parent.reason);
      break;
    }
    const onAbort = () => abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => parent.removeEventListener('abort', onAbort));
  }
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    const timer = setTimeout(
      () => abort(new DOMException('The operation timed out.', 'TimeoutError')),
      timeoutMs,
    );
    cleanups.push(() => clearTimeout(timer));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
