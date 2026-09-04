/* Notification-only service worker: no fetch interception, no page/API caching. */
const pushWorker = globalThis;
const defaultDestination = '/settings/notifications';
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const notificationRoute = new RegExp(
  `^/(?:events(?:/${uuidPattern})?|companies/${uuidPattern}|operations|settings/notifications)$`,
  'i',
);

function unsafeCharacters(value) {
  return [...value].some(
    (character) =>
      character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function safeNotificationDestination(value) {
  if (typeof value !== 'string' || value.length > 1000 || unsafeCharacters(value))
    return defaultDestination;
  try {
    const parsed = new URL(value, pushWorker.location.origin);
    if (parsed.origin !== pushWorker.location.origin) return defaultDestination;
    if (parsed.pathname === '/search' && parsed.searchParams.get('type') === 'news') {
      const query = parsed.searchParams.get('q')?.trim();
      if (!query || query.length > 120 || unsafeCharacters(query)) return defaultDestination;
      return `/search?${new URLSearchParams({ type: 'news', q: query })}`;
    }
    return notificationRoute.test(parsed.pathname) ? parsed.pathname : defaultDestination;
  } catch {
    return defaultDestination;
  }
}

pushWorker.addEventListener('install', (event) => event.waitUntil(pushWorker.skipWaiting()));
pushWorker.addEventListener('activate', (event) => event.waitUntil(pushWorker.clients.claim()));
pushWorker.addEventListener('push', (event) => {
  let payload = {};
  try {
    const parsed = event.data?.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    /* Show a generic notification for an invalid payload. */
  }
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.slice(0, 120)
      : 'ORSEM';
  const body =
    typeof payload.body === 'string' && payload.body.trim()
      ? payload.body.slice(0, 500)
      : '새로운 관측 알림이 있습니다.';
  event.waitUntil(
    pushWorker.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      ...(typeof payload.tag === 'string' ? { tag: payload.tag.slice(0, 120) } : {}),
      data: { url: safeNotificationDestination(payload.url) },
    }),
  );
});
pushWorker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = new URL(
    safeNotificationDestination(event.notification.data?.url),
    pushWorker.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await pushWorker.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        try {
          if (new URL(client.url).origin !== pushWorker.location.origin) continue;
          const navigated = await client.navigate(destination);
          if (navigated) {
            await navigated.focus();
            return;
          }
        } catch {
          /* Another same-origin window may still be available. */
        }
      }
      await pushWorker.clients.openWindow(destination);
    })(),
  );
});
