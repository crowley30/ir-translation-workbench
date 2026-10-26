import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from './polling';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const disposers: Array<() => void> = [];
function track(dispose: () => void) {
  disposers.push(dispose);
  return dispose;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded completion-based polling', () => {
  it('lets a 1800ms response finish before waiting another 1500ms, without overlapping requests', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    track(startPolling({ request, onSuccess, onError }));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1800);
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve('first result');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('first result');
    await vi.advanceTimersByTimeAsync(1499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses a 5000ms default deadline for the full request promise, then waits before retrying', async () => {
    const request = vi.fn((signal: AbortSignal) => {
      void signal;
      return new Promise<string>(() => {});
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    track(startPolling({ request, onSuccess, onError }));
    await vi.advanceTimersByTimeAsync(0);
    const signal = request.mock.calls[0][0] as AbortSignal;
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal.aborted).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: '读取服务状态超时，请稍后重试。',
    });
    expect(onSuccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps the deadline active after headers arrive while the response body is still pending', async () => {
    const headers = deferred<void>();
    const body = deferred<string>();
    const request = vi.fn(async (signal: AbortSignal) => {
      void signal;
      await headers.promise;
      return body.promise;
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    track(startPolling({ request, onSuccess, onError, timeoutMs: 100, intervalMs: 50 }));
    await vi.advanceTimersByTimeAsync(20);
    headers.resolve();
    await vi.advanceTimersByTimeAsync(79);
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request.mock.calls[0][0].aborted).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('读取服务状态超时，请稍后重试。');
    body.resolve('late parsed body');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('times out a promise that never settles and ignores its late value without adding another retry timer', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    track(startPolling({ request, onSuccess, onError, timeoutMs: 100, intervalMs: 50 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    first.resolve('stale timed-out value');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(request).toHaveBeenCalledTimes(2);
    second.resolve('current value');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('current value');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('reports two failures and recovers on the next successful poll, keeping one scheduled timer', async () => {
    const firstError = new Error('synthetic initial failure');
    const secondError = new Error('synthetic second failure');
    const third = deferred<string>();
    const request = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockReturnValueOnce(third.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    track(startPolling({ request, onSuccess, onError, intervalMs: 25, timeoutMs: 100 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenNthCalledWith(1, firstError);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(onError).toHaveBeenNthCalledWith(2, secondError);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(request).toHaveBeenCalledTimes(3);
    third.resolve('recovered task');
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('recovered task');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'aborts an active request on disposal and ignores a late %s without callbacks or timers',
    async (lateResult) => {
      const pending = deferred<string>();
      const request = vi.fn((signal: AbortSignal) => {
        void signal;
        return pending.promise;
      });
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const dispose = track(
        startPolling({ request, onSuccess, onError, intervalMs: 50, timeoutMs: 100 }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const signal = request.mock.calls[0][0];
      dispose();
      dispose();
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      if (lateResult === 'resolve') pending.resolve('late task');
      else pending.reject(new Error('synthetic late failure'));
      await vi.advanceTimersByTimeAsync(500);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    },
  );

  it('can be disposed before the initial request microtask runs without starting any work', async () => {
    const request = vi.fn(async () => 'should not run');
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const dispose = track(startPolling({ request, onSuccess, onError }));
    dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an already queued next-poll timer on disposal', async () => {
    const request = vi.fn(async (signal: AbortSignal) => {
      void signal;
      return 'completed request';
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const dispose = track(
      startPolling({ request, onSuccess, onError, intervalMs: 50, timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(getEventListeners(request.mock.calls[0][0], 'abort')).toHaveLength(0);
  });

  it('bounds abort-aware outstanding work to one request across repeated timeout retries and cleans signal listeners', async () => {
    let active = 0;
    let maximumActive = 0;
    const signals: AbortSignal[] = [];
    const request = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signals.push(signal);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          signal.addEventListener(
            'abort',
            () => {
              active -= 1;
              reject(new DOMException('Synthetic abort', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const dispose = track(
      startPolling({ request, onSuccess, onError, intervalMs: 25, timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(request).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledTimes(5);
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    }
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(5);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
