/* ============================================================
   firebase-messaging-sw.js — v80
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

// Shop reminders are displayed here, before Firebase's push listener. Firebase
// hands a push to ANY visible page of this origin (other apps on
// asafkiri.github.io included) and does not wait for the display to finish.
self.addEventListener("push", (event) => {
  let payload = null;
  try{ payload = event.data ? event.data.json() : null; }catch(e){ payload = null; }
  const data = payload && payload.data;
  if(!data || data.audience !== "shop") return;
  event.stopImmediatePropagation();
  // The queue moves on after SHOP_TASK_MS, but the push event itself stays alive
  // until the notification is really shown (its icon may load slowly).
  let settle;
  const displayed = new Promise(resolve => { settle = resolve; });
  queueShop(() => { const shown = showShopReminder(data); shown.then(settle, settle); return shown; }).catch(() => {});
  event.waitUntil(Promise.race([displayed, new Promise(resolve => setTimeout(resolve, SHOP_EVENT_MS))]));
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

// Up to v79 the policy lived only in Cache Storage. Other apps on this origin
// delete every cache but their own when they update, which silently muted all
// reminders. IndexedDB is the source of truth now; the old cache is read once.
const SHOP_POLICY_CACHE = "works-shop-notification-policy-v1";
const SHOP_POLICY_URL = new URL("__shop_notification_policy", self.registration.scope).href;
const SHOP_SNOOZE_URL = new URL("__shop_notification_snoozes", self.registration.scope).href;
const SHOP_DB = "works-shop-notifications", SHOP_STORE = "state";
const SHOP_TASK_MS = 15000, SHOP_EVENT_MS = 90000;
let shopDb = null, shopOptedOut = false;
function openShopDb(){
  if(!shopDb) shopDb = new Promise((resolve, reject) => {
    const request = indexedDB.open(SHOP_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(SHOP_STORE);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); shopDb = null; };
      db.onclose = () => { shopDb = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || Error("indexedDB"));
    request.onblocked = () => reject(Error("indexedDB blocked"));
  }).catch(error => { shopDb = null; throw error; });
  return shopDb;
}
async function shopStore(mode, work, retry = true){
  const db = await openShopDb();
  let tx;
  try{ tx = db.transaction(SHOP_STORE, mode); }
  catch(error){
    // The browser closed the connection (storage error, data cleared): reopen once.
    shopDb = null;
    if(retry) return shopStore(mode, work, false);
    throw error;
  }
  return new Promise((resolve, reject) => {
    const request = work(tx.objectStore(SHOP_STORE));
    tx.oncomplete = () => resolve(request && request.result);
    tx.onerror = tx.onabort = () => reject(tx.error || Error("indexedDB"));
  });
}
async function readShop(key, legacyUrl, fallback){
  try{
    const value = await shopStore("readonly", store => store.get(key));
    if(value !== undefined) return value;
  }catch(e){}
  try{
    const saved = await (await caches.open(SHOP_POLICY_CACHE)).match(legacyUrl);
    if(saved){
      const value = await saved.json();
      // Adopt the v79 copy only while nothing newer exists: add() fails when a
      // value (for example an opt-out) was written in the meantime.
      try{ await shopStore("readwrite", store => store.add(value, key)); }
      catch(e){
        const current = await shopStore("readonly", store => store.get(key)).catch(() => undefined);
        return current !== undefined ? current : value;
      }
      try{ await (await caches.open(SHOP_POLICY_CACHE)).delete(legacyUrl); }catch(e){}
      return value;
    }
  }catch(e){}
  return fallback;
}
async function writeShop(key, legacyUrl, value){
  await shopStore("readwrite", store => store.put(value, key));
  // A stale legacy copy must never override a newer IndexedDB value.
  try{ await (await caches.open(SHOP_POLICY_CACHE)).delete(legacyUrl); }catch(e){}
}
const shopPolicy = () => readShop("policy", SHOP_POLICY_URL, {enabled:false});
const shopSnoozes = () => readShop("snoozes", SHOP_SNOOZE_URL, {});
// expiresAt and snooze deadlines are server timestamps, and the shop phone's
// clock may be ahead or behind. The stored offset can itself go stale when the
// phone clock is corrected later, so every check leans towards showing:
// a reminder is fresh if either clock says so, and a local snooze holds only
// while both clocks agree. The server already stops sending while snoozed.
function shopClocks(policy){
  const offset = Number(policy && policy.offset);
  const corrected = Date.now() + (Number.isFinite(offset) && Math.abs(offset) < 86400000 ? offset : 0);
  return {earliest:Math.min(Date.now(), corrected), latest:Math.max(Date.now(), corrected)};
}
// Serialize display and opt-out so no in-flight display can outlive disabling.
// A task that never settles must not block every later reminder.
let shopQueue=Promise.resolve();
function queueShop(work){
  const next=shopQueue.then(() => {
    let timer;
    return Promise.race([work(), new Promise(resolve => { timer = setTimeout(resolve, SHOP_TASK_MS); })])
      .finally(() => clearTimeout(timer));
  });
  shopQueue=next.catch(()=>{});
  return next;
}
async function closeShopNotices(match){
  (await self.registration.getNotifications()).forEach(n => { if(n.data && n.data.worksShopReminder && match(n.data)) n.close(); });
}
async function showShopReminder(data){
  if(!data || data.audience !== "shop" || shopOptedOut) return;
  const policy = await shopPolicy();
  if(policy.enabled !== true || policy.deviceId !== data.deviceId) return;
  const clocks = shopClocks(policy);
  if(!(Number(data.expiresAt) > clocks.earliest)) return;
  const muted = await shopSnoozes();
  if(Number(muted[data.snoozeKey]) > clocks.latest || Number(muted["plan:"+data.planKey]) > clocks.latest) return;
  await self.registration.showNotification(data.title || "תזכורת החתמה", {
    body:data.body || "", icon:new URL("icon-192.png", self.registration.scope).href,
    dir:"rtl", lang:"he", tag:data.tag || "works-shop-reminder", renotify:true,
    silent:false, vibrate:[250,100,250], requireInteraction:true,
    data:{worksShopReminder:true,employeeId:data.employeeId || "",kind:data.kind || "",snoozeKey:data.snoozeKey || "",planKey:data.planKey || ""}
  });
  // An opt-out may have run while a slow display timed out of the queue.
  const after = await shopPolicy();
  if(shopOptedOut || after.enabled !== true || after.deviceId !== data.deviceId) await closeShopNotices(() => true);
  try{
    const scope = self.registration.scope;
    (await self.clients.matchAll({type:"window", includeUncontrolled:true}))
      .forEach(client => { if(client.url.startsWith(scope)) client.postMessage({type:"SHOP_REMINDER_SHOWN"}); });
  }catch(e){}
}
self.addEventListener("message", event => {
  if(!event.source || !event.source.url.startsWith(self.registration.scope)) return;
  if(event.data?.type === "SHOP_NOTIFICATION_POLICY") {
    const enabling=event.data.enabled === true;
    // Remembered for this worker's lifetime even if storage fails below.
    shopOptedOut=!enabling;
    event.waitUntil(queueShop(async()=>{
      try{
        const offset=Number(event.data.offset);
        await writeShop("policy",SHOP_POLICY_URL,{enabled:enabling,deviceId:event.data.deviceId || "",offset:Number.isFinite(offset)?offset:0});
        event.ports[0]?.postMessage({ok:true});
      }catch(e){event.ports[0]?.postMessage({ok:false});}
      finally{ if(!enabling) await closeShopNotices(() => true).catch(() => {}); }
    }));
  }else if(event.data?.type === "SHOP_REMINDER_SNOOZED" || event.data?.type === "SHOP_REMINDER_CANCELLED"){
    event.waitUntil(queueShop(async()=>{
      const cancelling=event.data.type==="SHOP_REMINDER_CANCELLED";
      const field=cancelling?"planKey":"snoozeKey",key=event.data[field],until=event.data.until;
      const now=shopClocks(await shopPolicy()).latest;
      if(typeof key!=="string" || !key || !(Number(until)>now))return;
      const snoozes=Object.fromEntries(Object.entries(await shopSnoozes()).filter(([,v])=>Number(v)>now));
      snoozes[(cancelling?"plan:":"")+key]=Number(until);
      await writeShop("snoozes",SHOP_SNOOZE_URL,snoozes);
      await closeShopNotices(data => data[field]===key);
    }));
  }else if(event.data?.type === "SHOW_SHOP_REMINDER"){
    event.waitUntil(queueShop(()=>showShopReminder(event.data.data)));
  }
});
// Fallback only: shop pushes are normally handled by the listener above.
messaging.onBackgroundMessage(payload => {
  if(payload.data?.audience === "shop") return queueShop(()=>showShopReminder(payload.data));
});

// עדכון מהיר של ה-Service Worker בגרסאות חדשות
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
