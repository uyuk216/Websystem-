export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(code);
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Do not bounce to the login page on 401 (login flows handle it themselves). */
  noRedirect?: boolean;
}

/** Same-origin API client: /api/* is proxied to the API; cookies are handled by the browser. */
export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && !opts.noRedirect) {
      const locale = window.location.pathname.split('/')[1] === 'en' ? 'en' : 'ja';
      window.location.href = `/${locale}/login`;
    }
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'error', data);
  }
  return data as T;
}
