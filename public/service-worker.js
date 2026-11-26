self.addEventListener("push", (event) => {
  let notification = {};
  try {
    notification = event.data?.json() || {};
  } catch {
    notification.body = event.data?.text() || "";
  }
  event.waitUntil(self.registration.showNotification(notification.title || "Quotarr", {
    body: notification.body || "A profile has reached a storage alert level.",
    icon: "/quotarr.png",
    badge: "/quotarr.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const appWindow = windows.find((client) => new URL(client.url).origin === self.location.origin);
    return appWindow ? appWindow.focus() : clients.openWindow("/");
  }));
});
