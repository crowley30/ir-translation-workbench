export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
  } catch {
    throw new Error('无法连接服务，请检查服务状态后重试。');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || '请求未成功，请重试。');
  if (data === null) throw new Error('服务返回格式异常，请重试。');
  return data as T;
}
