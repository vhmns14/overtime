// Overtime service worker: shows Web Push notifications from your Hermes office and opens the
// office viewer when you tap one. Nothing is cached; the app works the same without it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const title = typeof d.title === "string" && d.title ? d.title : "Overtime";
  const url = typeof d.url === "string" && /^https?:\/\//.test(d.url) ? d.url : self.registration.scope;
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === "string" ? d.body : "",
    tag: typeof d.tag === "string" ? d.tag : "overtime",
    renotify: true,
    requireInteraction: typeof d.tag === "string" && d.tag.startsWith("approval"),
    data: { url },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.split("#")[0] === url.split("#")[0] && "focus" in w) {
        if ("navigate" in w) await w.navigate(url).catch(() => undefined);
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
