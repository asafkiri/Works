/* Works v63 — Firebase Cloud Messaging service worker */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

/*
 * Register our click handler before Firebase imports its own handler.
 * It only takes over notifications created by this app.
 */
self.addEventListener("notificationclick", event => {
  const data = event.notification && event.notification.data;
  if (!data || data.source !== "works-reminder" || !data.url) return;

  event.stopImmediatePropagation();
  event.notification.close();

  event.waitUntil((async () => {
    const scopeUrl = new URL(self.registration.scope);
    const fallback = new URL("./", scopeUrl);
    let target = fallback;

    try {
      const candidate = new URL(data.url, fallback);
      if (
        candidate.origin === self.location.origin &&
        candidate.pathname.startsWith(scopeUrl.pathname)
      ) {
        target = candidate;
      }
    } catch (_) {}

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windows) {
      try {
        const clientUrl = new URL(client.url);
        if (
          clientUrl.origin === target.origin &&
          clientUrl.pathname.startsWith(scopeUrl.pathname)
        ) {
          if ("navigate" in client) await client.navigate(target.href);
          return client.focus();
        }
      } catch (_) {}
    }

    return self.clients.openWindow(target.href);
  })());
});

importScripts(
  "https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js"
);
importScripts(
  "https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyABsjzRYpa2Kr6RPHOP4qgAmQtgUpHWuCM",
  authDomain: "mini-market-shalom.firebaseapp.com",
  databaseURL: "https://mini-market-shalom-default-rtdb.firebaseio.com",
  projectId: "mini-market-shalom",
  storageBucket: "mini-market-shalom.firebasestorage.app",
  messagingSenderId: "1057478582958",
  appId: "1:1057478582958:web:842ee59a54a70d99f2033f"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  // Our backend sends data-only. A notification payload is already shown by FCM.
  if (payload && payload.notification) return;

  const data = (payload && payload.data) || {};
  if (!["in", "out", "test"].includes(data.kind)) return;

  const appUrl = new URL("./", self.registration.scope);
  if (data.kind === "in" || data.kind === "out") {
    appUrl.searchParams.set("reminder", data.kind);
    if (data.time) appUrl.searchParams.set("time", data.time);
    if (data.date) appUrl.searchParams.set("date", data.date);
    if (data.slot) appUrl.searchParams.set("slot", data.slot);
  } else {
    appUrl.searchParams.set("pushTest", "1");
  }
  if (data.employeeId) {
    appUrl.searchParams.set("emp", data.employeeId);
  }

  const title =
    data.title ||
    (data.kind === "in"
      ? "🔔 תזכורת כניסה"
      : data.kind === "out"
        ? "🕔 תזכורת יציאה"
        : "🔔 התראת בדיקה");

  const body =
    data.body ||
    (data.kind === "in"
      ? `המשמרת שלך מתחילה${data.time ? ` ב-${data.time}` : ""}.`
      : data.kind === "out"
        ? `המשמרת שלך מסתיימת${data.time ? ` ב-${data.time}` : ""}.`
        : "ההתראות פועלות בהצלחה.");

  const tag =
    data.tag ||
    (data.kind === "test"
      ? "works-push-test"
      : `works-${data.date || "date"}-${data.slot || data.kind}`);

  return self.registration.showNotification(title.slice(0, 100), {
    body: body.slice(0, 240),
    icon: new URL("icon-192.png", self.registration.scope).href,
    badge: new URL("icon-192.png", self.registration.scope).href,
    tag: String(tag).slice(0, 120),
    renotify: true,
    dir: "rtl",
    lang: "he",
    data: {
      source: "works-reminder",
      url: appUrl.href
    }
  });
});
