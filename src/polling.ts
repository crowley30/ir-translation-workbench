export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 5000;
export const POLL_TIMEOUT_MESSAGE = '读取服务状态超时，请稍后重试。';

interface PollingOptions<T> {
  request(signal: AbortSignal): Promise<T>;
  onSuccess(value: T): void;
  onError(error: Error): void;
  intervalMs?: number;
  timeoutMs?: number;
}

// One attempt at a time. Slow successful reads are applied before scheduling the next attempt.
// The deadline covers the entire request, including reading/parsing its response body.
export function startPolling<T>({
  request,
  onSuccess,
  onError,
  intervalMs = POLL_INTERVAL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
}: PollingOptions<T>): () => void {
  let stopped = false;
  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | undefined;

  async function attempt() {
    if (stopped) return;
    const controller = new AbortController();
    current = controller;
    let timedOut = false;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(timedOut ? POLL_TIMEOUT_MESSAGE : '读取已停止。'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          // React can dispose an effect before this first microtask runs.
          if (controller.signal.aborted) throw new Error('读取已停止。');
          return request(controller.signal);
        }),
        aborted,
      ]);
      if (!stopped) onSuccess(value);
    } catch (error) {
      if (!stopped) onError(error instanceof Error ? error : new Error('无法读取服务，请重试。'));
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      current = undefined;
      if (!stopped) nextTimer = setTimeout(() => void attempt(), intervalMs);
    }
  }

  void attempt();
  return () => {
    stopped = true;
    clearTimeout(nextTimer);
    // Native fetch aborts both the transport and body read. Even a non-cooperative
    // injected request cannot deliver a late callback or schedule another attempt.
    current?.abort();
  };
}
