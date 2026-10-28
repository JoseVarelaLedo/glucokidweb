/* Service worker mínimo: muestra los avisos entre cuidadores (notificaciones push de Firebase Cloud Messaging).
   No cachea nada ni intercepta peticiones. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let p = {};
  try {
    const j = e.data ? e.data.json() : {};
    p = j && typeof j.data === 'object' && j.data ? j.data : j || {};
  } catch (_) {
    /* payload no JSON */
  }
  const title = p.title || '⚠ Aviso de glucemia';
  const body = p.body || 'Se ha registrado una glucemia fuera de rango.';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Con la app a la vista ya se muestra el banner (con sonido): no duplicamos
      if (list.some((c) => c.visibilityState === 'visible' && c.focused)) return undefined;
      return self.registration.showNotification(title, {
        body,
        tag: p.id || 'glucokid-alerta', // misma etiqueta que usa la app: nunca salen dos iguales
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        requireInteraction: true,
        vibrate: [300, 120, 300, 120, 500],
        data: { url: '/registro' },
      });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    }),
  );
});
