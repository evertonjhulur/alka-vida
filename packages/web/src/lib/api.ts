/** Typed client for the Alka Vida API. */

export type Role = 'admin' | 'user' | 'driver' | 'customer';

export interface Session {
  id: string;
  name: string;
  role: Role;
  customerId: string | null;
}

const TOKEN_KEY = 'alkavida.token';
const SESSION_KEY = 'alkavida.session';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch { return null; }
}

export function setSession(token: string, session: Session): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* private mode - the session simply will not persist */ }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      // Only claim a JSON body when there is one. An action call with no body
      // but a JSON content-type is rejected by the server's parser before it
      // ever reaches the route.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    clearSession();
    window.location.hash = '#/login';
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/**
 * A file from the API, rather than JSON.
 *
 * Needed because a plain `<a href>` to a PDF route carries no Authorization
 * header: the server would refuse it and the browser would show its own error
 * page instead of ours.
 */
async function requestBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (res.status === 401) {
    clearSession();
    window.location.hash = '#/login';
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    // A failure comes back as JSON even from a route that normally sends a file.
    const text = await res.text();
    let message = `Request failed (${res.status})`;
    try { message = JSON.parse(text)?.error ?? message; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  getBlob: (path: string) => requestBlob(path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),

  async login(email: string, password: string) {
    const out = await request<{ token: string; session: Session }>(
      'POST', '/api/auth/login', { email, password },
    );
    setSession(out.token, out.session);
    return out.session;
  },
};

/**
 * Fetch a file from the API and hand it to the browser as a download.
 *
 * A plain <a href> cannot carry the bearer token, so the bytes are fetched
 * and handed over as a blob instead.
 */
export async function download(path: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    let message = `Could not download (${res.status})`;
    try { message = JSON.parse(text).error ?? message; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A stable key for guarding a double-submitted action. */
export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
