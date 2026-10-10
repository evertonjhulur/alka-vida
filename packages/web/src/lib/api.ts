/** Typed client for the Alka Vida API. */

export type Role = 'admin' | 'user' | 'driver' | 'customer';

export interface Session {
  id: string;
  name: string;
  role: Role;
  customerId: string | null;
}

/*
 * Signing in (tester's findings, 10 Oct 2026, point 18): the server sets an
 * httpOnly cookie that this code never sees, and the browser sends it with
 * every request to this site. All that is kept here is WHO is signed in, for
 * drawing the screens - no secret. A token left over from before the change
 * is removed.
 */
const SESSION_KEY = 'alkavida.session';
const RETURN_KEY = 'alkavida.return';
try { localStorage.removeItem('alkavida.token'); } catch { /* ignore */ }

/** Sent with every request: the server refuses a change made with the cookie without it. */
const APP_HEADER = { 'x-alka-request': '1' };

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch { return null; }
}

export function setSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* private mode - the session simply will not persist */ }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

/**
 * The page somebody was on when their session ran out (point 12), so signing
 * in again takes them back to it rather than to the start.
 */
export function takeReturnPath(): string | null {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return p && p.startsWith('#/') && !p.startsWith('#/login') ? p : null;
  } catch { return null; }
}

/** The session ran out: remember where they were, and show the sign-in page. */
function sessionExpired(): void {
  try {
    const here = window.location.hash;
    if (here && here !== '#/' && !here.startsWith('#/login')) sessionStorage.setItem(RETURN_KEY, here);
  } catch { /* ignore */ }
  clearSession();
  window.dispatchEvent(new Event('alkavida:signed-out'));
  window.location.hash = '#/login';
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The server's answer as JSON - or, when what came back is not JSON (a
 * Railway 502 page while the app restarts, say), a message a person can act
 * on instead of "Unexpected token <" (point 13).
 */
function readJson(text: string, status: number): { data: unknown; ok: boolean } {
  if (!text) return { data: null, ok: true };
  try { return { data: JSON.parse(text), ok: true }; } catch { return { data: null, ok: false }; }
}
export function notJsonMessage(status: number): string {
  if (status === 502 || status === 503 || status === 504) {
    return `Alka Vida is not answering just now (error ${status}). It may be restarting: wait a minute and try again.`;
  }
  return `The server sent back something unexpected (error ${status}). Try again; if it keeps happening, tell the office.`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...APP_HEADER,
        // Only claim a JSON body when there is one. An action call with no body
        // but a JSON content-type is rejected by the server's parser before it
        // ever reaches the route.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Could not reach Alka Vida. Check the internet connection and try again.');
  }

  // A 401 from signing in is a wrong email or password, not an expired
  // session: say what the server said, and stay on the page.
  if (res.status === 401 && path !== '/api/auth/login') {
    sessionExpired();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }

  const text = await res.text();
  const { data, ok } = readJson(text, res.status);
  if (!ok) throw new ApiError(res.status, notJsonMessage(res.status));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
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
  const res = await fetch(path, { credentials: 'same-origin', headers: APP_HEADER });

  if (res.status === 401) {
    sessionExpired();
    throw new ApiError(401, 'Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    // A failure comes back as JSON even from a route that normally sends a file.
    const text = await res.text();
    let message = `Request failed (${res.status})`;
    try { message = JSON.parse(text)?.error ?? message; } catch { message = notJsonMessage(res.status); }
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
    const out = await request<{ session: Session }>('POST', '/api/auth/login', { email, password });
    setSession(out.session);
    return out.session;
  },

  /** Sign out: the server clears the cookie; the screens forget who it was. */
  async logout() {
    try { await request('POST', '/api/auth/logout'); } catch { /* signing out anyway */ }
    clearSession();
  },
};

/**
 * Fetch a file from the API and hand it to the browser as a download.
 *
 * A plain <a href> cannot carry the bearer token, so the bytes are fetched
 * and handed over as a blob instead.
 */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { credentials: 'same-origin', headers: APP_HEADER });
  if (res.status === 401) { sessionExpired(); throw new ApiError(401, 'Your session has expired. Please sign in again.'); }
  if (!res.ok) {
    const text = await res.text();
    let message = `Could not download (${res.status})`;
    try { message = JSON.parse(text).error ?? message; } catch { message = notJsonMessage(res.status); }
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

/**
 * A file the server builds from a list sent to it (several invoices in one
 * PDF, a receipt for several payments), handed to the browser as a download.
 */
export async function downloadPost(path: string, body: unknown, filename: string): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...APP_HEADER, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { sessionExpired(); throw new ApiError(401, 'Your session has expired. Please sign in again.'); }
  if (!res.ok) {
    const text = await res.text();
    let message = `Could not download (${res.status})`;
    try { message = JSON.parse(text).error ?? message; } catch { message = notJsonMessage(res.status); }
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

/**
 * Open a PDF from the API in a new tab, where the browser's own Print button
 * prints it (team feedback, point 6: "downloadable or printable"). The tab is
 * opened first, synchronously, so a pop-up blocker treats it as the click it is.
 */
export async function openPdf(path: string): Promise<void> {
  // The sign-in cookie goes with an ordinary visit now (10 Oct 2026), so the
  // tab opens the PDF's own address and the browser's viewer shows it.
  const win = window.open(path, '_blank');
  if (!win) window.location.href = path;
}
