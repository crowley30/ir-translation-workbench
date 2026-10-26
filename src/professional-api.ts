export const PROFESSIONAL_REQUEST_TIMEOUT_MS = 15000;
export const PROFESSIONAL_TIMEOUT_MESSAGE = '请求等待超时。更改可能已经保存，请重新读取后确认。';

export class ProfessionalRequestError extends Error {
  constructor(
    public code: 'TIMEOUT' | 'ABORTED' | 'NETWORK' | 'HTTP' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'ProfessionalRequestError';
  }
}

// Isolated from the original text/DOCX request path. The deadline includes the
// response body; stopping local waiting never claims a server mutation rolled back.
export async function professionalApi<T>(path: string, options?: RequestInit): Promise<T> {
  const caller = options?.signal;
  if (caller?.aborted)
    throw new ProfessionalRequestError(
      'ABORTED',
      '已停止等待请求。更改可能已经保存，请重新读取后确认。',
    );
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  let onAbort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        new ProfessionalRequestError(
          timedOut ? 'TIMEOUT' : 'ABORTED',
          timedOut
            ? PROFESSIONAL_TIMEOUT_MESSAGE
            : '已停止等待请求。更改可能已经保存，请重新读取后确认。',
        ),
      );
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  caller?.addEventListener('abort', onCallerAbort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROFESSIONAL_REQUEST_TIMEOUT_MS);
  try {
    const pending = Promise.resolve().then(async () => {
      if (controller.signal.aborted)
        throw new ProfessionalRequestError('ABORTED', '已停止等待请求。');
      let response: Response;
      try {
        const headers = new Headers(options?.headers);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        response = await fetch(`/api${path}`, { ...options, headers, signal: controller.signal });
      } catch {
        throw new ProfessionalRequestError('NETWORK', '无法连接服务，请检查服务状态后重试。');
      }
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          typeof data.error === 'string' &&
          data.error.length <= 1000
            ? data.error
            : '请求未成功，请重试。';
        throw new ProfessionalRequestError('HTTP', error);
      }
      if (data === null)
        throw new ProfessionalRequestError('INVALID_RESPONSE', '服务返回格式异常，请重试。');
      return data as T;
    });
    return await Promise.race([pending, stopped]);
  } finally {
    clearTimeout(deadline);
    caller?.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
