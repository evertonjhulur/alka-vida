/**
 * Is this page behind the live version of Alka Vida, and if so which way
 * (components/StaleServerNotice.tsx)?
 *
 *  - null      up to date, or nothing to compare (dev server, offline)
 *  - 'page'    a newer version is live; this tab is running old screens.
 *              A reload fixes it.
 *  - 'server'  the screens on disk are newer than the running server (the
 *              office computer rebuilt the app without restarting it).
 *              Restarting Alka Vida fixes it.
 */
export type StaleKind = null | 'page' | 'server';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The script the server's own index page loads, e.g. "index-t1kr5hO0.js". */
export function bundleIn(html: string): string | null {
  const m = html.match(/\/assets\/(index-[^"'\s>]+\.js)/);
  return m ? m[1] : null;
}

export async function staleKind(fetchFn: Fetch, running: string | null): Promise<StaleKind> {
  if (!running) return null;
  try {
    const res = await fetchFn('/api/version', { cache: 'no-store' });
    // A server old enough not to have this endpoint IS a stale server.
    // 404 when it routes normally; 401 when its auth hook guards every /api/
    // path before routing, which older builds do.
    if (res.status === 404 || res.status === 401) return 'server';
    if (!res.ok) return null;
    const { build } = (await res.json()) as { build: string | null };
    if (!build || build === running) return null;

    // They differ. If the index page now being served loads the server's
    // build, the server is current and this tab is the old one.
    const page = await fetchFn('/', { cache: 'no-store' });
    if (!page.ok) return null;
    const served = bundleIn(await page.text());
    if (!served) return null;
    return served === build ? 'page' : 'server';
  } catch {
    return null; // offline or restarting: say nothing rather than cry wolf
  }
}
