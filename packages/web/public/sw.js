/*
 * Alka Vida's service worker: push notifications (15 Oct 2026).
 *
 * A push from Alka Vida carries no message. When one arrives, ask the server
 * for this person's unread notes (signed in on this device) and show them;
 * tapping one opens the screen it is about.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let notes = [];
    try {
      const r = await fetch('/api/push/inbox', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) notes = await r.json();
    } catch (e) { /* offline or signed out: fall through */ }
    if (!Array.isArray(notes) || notes.length === 0) {
      // Every push must show something (phones insist). Signed out, say so.
      await self.registration.showNotification('Alka Vida', {
        body: 'Something new needs you. Open Alka Vida to see it.',
        icon: '/apple-touch-icon.png', badge: '/favicon.png', tag: 'alka-vida', data: { url: '/#/' },
      });
      return;
    }
    for (const n of notes) {
      await self.registration.showNotification(n.title, {
        body: n.body || '', icon: '/apple-touch-icon.png', badge: '/favicon.png',
        tag: n.tag || n.id, renotify: true, data: { url: n.url || '/#/' },
      });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await w.focus();
        try { if ('navigate' in w) await w.navigate(url); } catch (e) { /* stays where it is */ }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
