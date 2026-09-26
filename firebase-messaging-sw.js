/* ============================================================
   firebase-messaging-sw.js — v61
   Service Worker לקבלת התראות פוש כשהאפליקציה סגורה/ברקע.
   יושב באותה תיקייה של index.html בריפו (חובה — לא בתת-תיקייה).
   ============================================================ */
// Handle only the local sound test. Register before Firebase's click listener.
self.addEventListener("notificationclick", (event) => {
  if(!event.notification.data || event.notification.data.worksSoundTest !== true) return;
  event.stopImmediatePropagation();
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const windows = await self.clients.matchAll({type:"window", includeUncontrolled:true});
    const existing = windows.find(client => client.url.startsWith(scope));
    if(existing) return existing.focus();
    return self.clients.openWindow(scope);
  })());
});

importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js");
importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js");

firebase.initializeApp({
  apiKey:            "AIzaSyABsjzRYpa2Kr6RPHOP4qgAmQtgUpHWuCM",
  authDomain:        "mini-market-shalom.firebaseapp.com",
  databaseURL:       "https://mini-market-shalom-default-rtdb.firebaseio.com",
  projectId:         "mini-market-shalom",
  storageBucket:     "mini-market-shalom.firebasestorage.app",
  messagingSenderId: "1057478582958",
  appId:             "1:1057478582958:web:842ee59a54a70d99f2033f"
});

// מספיק לאתחל — ה-SDK מציג לבד התראות שמגיעות ברקע (notification payload)
// ובלחיצה פותח את הקישור שהפונקציה שלחה (fcmOptions.link => ?reminder=...).
firebase.messaging();

// עדכון מהיר של ה-Service Worker בגרסאות חדשות
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
