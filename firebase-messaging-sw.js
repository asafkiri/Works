/* ============================================================
   firebase-messaging-sw.js — v77
   Service Worker לקבלת התראות פוש כשהאפליקציה סגורה/ברקע.
   יושב באותה תיקייה של index.html בריפו (חובה — לא בתת-תיקייה).
   ============================================================ */
// Handle store reminders and the local sound test before Firebase's listener.
self.addEventListener("notificationclick", (event) => {
  if(!event.notification.data || (!event.notification.data.worksSoundTest && !event.notification.data.worksShopReminder)) return;
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
const messaging = firebase.messaging();

const SHOP_POLICY_CACHE = "works-shop-notification-policy-v1";
const SHOP_POLICY_URL = new URL("__shop_notification_policy", self.registration.scope).href;
const SHOP_SNOOZE_URL = new URL("__shop_notification_snoozes", self.registration.scope).href;
// Serialize display and opt-out so no in-flight display can outlive disabling.
let shopQueue=Promise.resolve();
function queueShop(work){const next=shopQueue.then(work);shopQueue=next.catch(()=>{});return next;}
async function shopPolicy(){
  const response = await (await caches.open(SHOP_POLICY_CACHE)).match(SHOP_POLICY_URL);
  return response ? response.json() : {enabled:false};
}
async function showShopReminder(data){
  if(!data || data.audience !== "shop" || !(Number(data.expiresAt) > Date.now())) return;
  const policy = await shopPolicy();
  if(policy.enabled !== true || policy.deviceId !== data.deviceId) return;
  const saved=await (await caches.open(SHOP_POLICY_CACHE)).match(SHOP_SNOOZE_URL);
  if(saved && Number((await saved.json())[data.snoozeKey])>Date.now()) return;
  return self.registration.showNotification(data.title || "תזכורת החתמה", {
    body:data.body || "", icon:new URL("icon-192.png", self.registration.scope).href,
    dir:"rtl", lang:"he", tag:data.tag || "works-shop-reminder", renotify:true,
    silent:false, vibrate:[250,100,250], requireInteraction:true,
    data:{worksShopReminder:true,employeeId:data.employeeId || "",kind:data.kind || "",snoozeKey:data.snoozeKey || ""}
  });
}
self.addEventListener("message", event => {
  if(!event.source || !event.source.url.startsWith(self.registration.scope)) return;
  if(event.data?.type === "SHOP_NOTIFICATION_POLICY") {
    event.waitUntil(queueShop(async()=>{
      try{
        const cache=await caches.open(SHOP_POLICY_CACHE);
        await cache.put(SHOP_POLICY_URL,new Response(JSON.stringify({enabled:event.data.enabled === true,deviceId:event.data.deviceId || ""}),{headers:{"Content-Type":"application/json"}}));
        if(event.data.enabled !== true){
          const notifications=await self.registration.getNotifications();
          notifications.forEach(n=>{if(n.data?.worksShopReminder)n.close();});
        }
        event.ports[0]?.postMessage({ok:true});
      }catch(e){event.ports[0]?.postMessage({ok:false});}
    }));
  }else if(event.data?.type === "SHOP_REMINDER_SNOOZED"){
    event.waitUntil(queueShop(async()=>{
      const {snoozeKey,until}=event.data;
      if(typeof snoozeKey!=="string" || !snoozeKey || !(Number(until)>Date.now()))return;
      const cache=await caches.open(SHOP_POLICY_CACHE),saved=await cache.match(SHOP_SNOOZE_URL);
      const snoozes=Object.fromEntries(Object.entries(saved?await saved.json():{}).filter(([,v])=>Number(v)>Date.now()));
      snoozes[snoozeKey]=Number(until);
      await cache.put(SHOP_SNOOZE_URL,new Response(JSON.stringify(snoozes),{headers:{"Content-Type":"application/json"}}));
      (await self.registration.getNotifications()).forEach(n=>{if(n.data?.worksShopReminder && n.data.snoozeKey===snoozeKey)n.close();});
    }));
  }else if(event.data?.type === "SHOW_SHOP_REMINDER"){
    event.waitUntil(queueShop(()=>showShopReminder(event.data.data)));
  }
});
messaging.onBackgroundMessage(payload => {
  if(payload.data?.audience === "shop") return queueShop(()=>showShopReminder(payload.data));
});

// עדכון מהיר של ה-Service Worker בגרסאות חדשות
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
