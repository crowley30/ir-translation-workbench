import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  professionalApi,
  PROFESSIONAL_REQUEST_TIMEOUT_MS,
  PROFESSIONAL_TIMEOUT_MESSAGE,
} from './professional-api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function signalOf(fetchMock: ReturnType<typeof vi.fn>): AbortSignal {
  return (fetchMock.mock.calls[0][1] as RequestInit).signal!;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded professional feature requests', () => {
  it('returns JSON and preserves request options while removing deadline and caller listeners', async () => {
    const caller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ saved: true }));
    vi.stubGlobal('fetch', fetchMock);
    const value = await professionalApi('/terminology', {
      method: 'POST',
      body: '{"source":"synthetic"}',
      signal: caller.signal,
      headers: { 'X-Synthetic': 'fixture' },
    });
    expect(value).toEqual({ saved: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe('/api/terminology');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"source":"synthetic"}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init.headers).get('X-Synthetic')).toBe('fixture');
    expect(init.signal).not.toBe(caller.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(init.signal!, 'abort')).toHaveLength(0);
    caller.abort();
    expect(init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(PROFESSIONAL_REQUEST_TIMEOUT_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(init.signal!.aborted).toBe(false);
  });

  it('aborts a hanging fetch at the deadline and ignores a noncooperative late success', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const success = vi.fn(),
      failure = vi.fn();
    const completed = professionalApi('/terminology').then(success, failure);
    await vi.advanceTimersByTimeAsync(PROFESSIONAL_REQUEST_TIMEOUT_MS - 1);
    expect(signalOf(fetchMock).aborted).toBe(false);
    expect(failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await completed;
    expect(signalOf(fetchMock).aborted).toBe(true);
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'TIMEOUT', message: PROFESSIONAL_TIMEOUT_MESSAGE }),
    );
    expect(success).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signalOf(fetchMock), 'abort')).toHaveLength(0);
    response.resolve(Response.json({ stale: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active after headers while JSON body reading hangs', async () => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    const fetchMock = vi.fn(async () => ({ ok: true, json }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const result = professionalApi('/tasks/example/terminology-preview', {
      method: 'POST',
      signal: caller.signal,
    });
    const assertion = expect(result).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: PROFESSIONAL_TIMEOUT_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PROFESSIONAL_REQUEST_TIMEOUT_MS);
    await assertion;
    expect(signalOf(fetchMock).aborted).toBe(true);
    body.resolve({ late: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(signalOf(fetchMock), 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors caller cancellation, cleans all resources and ignores a late rejection', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const result = professionalApi('/tasks/example/terminology-preview', { signal: caller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.advanceTimersByTimeAsync(0);
    caller.abort();
    expect(signalOf(fetchMock).aborted).toBe(true);
    await assertion;
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(signalOf(fetchMock), 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    response.reject(new Error('synthetic late network failure'));
    await vi.advanceTimersByTimeAsync(PROFESSIONAL_REQUEST_TIMEOUT_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start transport or timers for a caller that is already aborted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    caller.abort();
    await expect(professionalApi('/terminology', { signal: caller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('can be canceled before the first fetch microtask without performing work', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();
    const result = professionalApi('/terminology', { signal: caller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    caller.abort();
    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('redacts raw transport failures and removes timers on immediate failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('synthetic private provider body');
      }),
    );
    await expect(professionalApi('/terminology')).rejects.toMatchObject({
      code: 'NETWORK',
      message: '无法连接服务，请检查服务状态后重试。',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains safe server error text and rejects malformed successful JSON without retaining resources', async () => {
    const caller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: '合成版本冲突，请重新读取。' }, { status: 409 }),
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      professionalApi('/terminology/id', { signal: caller.signal }),
    ).rejects.toMatchObject({ code: 'HTTP', message: '合成版本冲突，请重新读取。' });
    await expect(professionalApi('/terminology', { signal: caller.signal })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('does not leak timers or caller listeners over repeated timeout attempts', async () => {
    const caller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = professionalApi('/terminology', { signal: caller.signal });
      const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(PROFESSIONAL_REQUEST_TIMEOUT_MS);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    }
    expect(signals).toHaveLength(10);
    expect(
      signals.every((signal) => signal.aborted && getEventListeners(signal, 'abort').length === 0),
    ).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });
});
