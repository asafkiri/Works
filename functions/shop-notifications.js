"use strict";
const {randomUUID,createHash}=require("node:crypto");
const {getDatabaseWithUrl}=require("firebase-admin/database");
const {getMessaging}=require("firebase-admin/messaging");
const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {onSchedule}=require("firebase-functions/v2/scheduler");
const logger=require("firebase-functions/logger");
const {localClock,addIsoDays}=require("./reminder-logic");
const {pendingShopEvents,deliveryDue,activeShopDevices,shopMessage,shopRef,SHOP_TTL_SECONDS}=require("./shop-reminder-logic");
const DB_URL="https://mini-market-shalom-default-rtdb.firebaseio.com";
const db=()=>getDatabaseWithUrl(DB_URL);
const invalidTokens=new Set(["messaging/registration-token-not-registered","messaging/invalid-registration-token"]);
const digest=value=>createHash("sha256").update(value).digest("hex");
const snoozeMinutes=new Set([10,20,30,40,50,60]);
const receiptOutcomes=new Set(["shown","expired","policy-off","other-device","snoozed","cancelled","resolved","opted-out","error"]);
// The Admin SDK first runs a transaction update with its local cache, which is
// empty (null) when nothing listens. Returning undefined there aborts without
// asking the server; returning null makes the server resend the real value.
const whenLoaded=update=>state=>state===null?null:update(state);
const eventRoots=["employees","recurringShifts","oneTimeShifts","shifts","shopNotificationDevices","config/managerUid","shopReminderSnoozes","shopReminderCancellations"];
const snoozePath=event=>`shopReminderSnoozes/${event.date}/${digest(event.snoozeKey)}`;
function snoozedUntil(data,event) {
  return Number(data.shopReminderSnoozes?.[event.date]?.[digest(event.snoozeKey)]?.until)||0;
}
function cancelled(data,event) {return data.shopReminderCancellations?.[event.date]?.[digest(event.planKey)]?.cancelled===true;}
function suppressed(data,event,now) {return cancelled(data,event) || snoozedUntil(data,event)>now;}
async function roots(names) {
  const snaps=await Promise.all(names.map(n=>db().ref(n).get()));
  return Object.fromEntries(names.map((n,i)=>[n,snaps[i].val()||{}]));
}
// FCM rejected this exact token: switch the device off and remember the token,
// so the phone must create a new one (see action "enable").
function rejectToken(deviceId,token) {
  return db().ref(`shopNotificationDevices/${deviceId}`).transaction(whenLoaded(row=>row.token===token?
    {...row,enabled:false,token:null,rejectedToken:digest(token),disabledReason:"token-rejected",disabledAt:Date.now()}:undefined),undefined,false);
}
async function send(device,data) {
  return getMessaging().send({token:device.token,data,webpush:{headers:{Urgency:"high",TTL:String(SHOP_TTL_SECONDS)}}});
}

exports.setShopNotificationDevice=onCall({region:"europe-west1",timeoutSeconds:30,maxInstances:2},async request=>{
  const uid=request.auth?.uid;
  if(!uid) throw new HttpsError("unauthenticated","יש להתחבר כמנהל.");
  const managerUid=(await db().ref("config/managerUid").get()).val();
  if(uid!==managerUid) throw new HttpsError("permission-denied","הגדרת טלפון החנות מיועדת למנהל בלבד.");
  const {deviceId,action,token}=request.data||{};
  if(typeof deviceId!=="string" || !/^[a-f0-9-]{36}$/i.test(deviceId) || !["enable","disable","status","test","pending","snooze","cancel","report"].includes(action))
    throw new HttpsError("invalid-argument","בקשת מכשיר לא תקינה.");
  const ref=db().ref(`shopNotificationDevices/${deviceId}`);
  const current=(await ref.get()).val();
  if(action==="disable") {
    await ref.set({uid,enabled:false,updatedAt:Date.now()});
    return {enabled:false};
  }
  if(action==="status") return {enabled:current?.uid===uid && current.enabled===true};
  if(action==="enable") {
    if(typeof token!=="string" || token.length<20 || token.length>4096) throw new HttpsError("invalid-argument","חסר מזהה התראות תקין.");
    // FCM rejected this exact token: the phone must create a new one, or the
    // server would keep re-enabling a token that can never be delivered to.
    if(current?.uid===uid && current.rejectedToken===digest(token))
      throw new HttpsError("failed-precondition","מזהה ההתראות של הטלפון פג תוקף. מחדשים אותו אוטומטית.",{reason:"token-rejected"});
    // Atomic opt-in and routing switch. Disabling the last terminal never falls
    // back to employee phones; the requested channel stays shop-only.
    await db().ref().update({[`shopNotificationDevices/${deviceId}`]:{uid,enabled:true,token,updatedAt:Date.now()},"shopNotificationRouting/mode":"shop-only"});
    return {enabled:true,serverTime:Date.now()};
  }
  if(action==="report") {
    // Receipts recorded by the phone's service worker: what arrived and whether
    // it was shown. Only logged; they never change reminders or attendance.
    if(!current || current.uid!==uid) throw new HttpsError("failed-precondition","המכשיר לא רשום להתראות חנות.");
    const entries=Array.isArray(request.data.entries)?request.data.entries.slice(0,50):[];
    let logged=0;
    for(const e of entries) {
      if(!e || typeof e!=="object" || !receiptOutcomes.has(e.outcome)) continue;
      const text=(v,n)=>typeof v==="string"?v.slice(0,n):"";
      const time=v=>Number.isFinite(Number(v))?Number(v):0;
      logger.info("Shop reminder receipt",{deviceId,outcome:e.outcome,ref:text(e.ref,32),employeeId:text(e.employeeId,64),kind:text(e.kind,8),
        sentAt:time(e.sentAt),receivedAt:time(e.receivedAt),path:text(e.path,16)});
      logged++;
    }
    return {logged,serverTime:Date.now()};
  }
  if(!current || current.uid!==uid || current.enabled!==true)
    throw new HttpsError("failed-precondition","המכשיר לא רשום להתראות חנות.",{reason:current?.uid===uid && current.disabledReason || "not-registered"});
  if(action==="pending" || action==="snooze" || action==="cancel") {
    const now=Date.now(),data=await roots(eventRoots);
    const events=[...pendingShopEvents(data,now).values()].filter(e=>!cancelled(data,e));
    if(action==="pending") return {events:events.map(e=>({employeeId:e.employeeId,kind:e.kind,eventKey:e.key,planKey:e.planKey,snoozeKey:e.snoozeKey,until:snoozedUntil(data,e)}))};
    const {minutes,eventKey,snoozeKey}=request.data;
    if(typeof eventKey!=="string" || eventKey.length>2048 || typeof snoozeKey!=="string" || snoozeKey.length>4096)
      throw new HttpsError("invalid-argument","פרטי התזכורת אינם תקינים.");
    if(action==="snooze" && !snoozeMinutes.has(minutes))
      throw new HttpsError("invalid-argument","בחר דחייה של 10, 20, 30, 40, 50 דקות או שעה.");
    const event=events.find(e=>e.key===eventKey && e.snoozeKey===snoozeKey);
    if(!event) throw new HttpsError("failed-precondition","אין עוד תזכורת פעילה למשמרת הזאת. רענן את המסך.");
    if(action==="cancel") {
      if(event.kind!=="in") throw new HttpsError("failed-precondition","ביטול תזכורות למשמרת אפשרי מתוך תזכורת כניסה פעילה בלבד.");
      // Plan-level cancellation covers entry AND exit, even if the employee later
      // clocks in. Separate state ensures a concurrent snooze cannot undo it.
      await db().ref(`shopReminderCancellations/${event.date}/${digest(event.planKey)}`).set({cancelled:true,employeeId:event.employeeId,updatedAt:now});
      // The worker needs only a bounded guard against notices already in transit.
      return {cancelled:true,planKey:event.planKey,until:now+48*3600_000};
    }
    const until=now+minutes*60_000;
    // Shared by opted-in shop devices, scoped to this plan and its actual open shifts.
    // This never writes attendance records or changes another employee's reminder.
    await db().ref(snoozePath(event)).set({until,employeeId:event.employeeId,updatedAt:now});
    return {until};
  }
  const rate=db().ref(`shopNotificationTestRate/${deviceId}`),now=Date.now();
  const claim=await rate.transaction(last=>Number(last)>now-30_000?undefined:now,undefined,false);
  if(!claim.committed) throw new HttpsError("resource-exhausted","אפשר לבדוק שוב בעוד חצי דקה.");
  try{
    await send({...current,deviceId},{audience:"shop",deviceId,kind:"test",title:"🔔 בדיקת תזכורות החנות",body:"הודעת הבדיקה הגיעה מהשרת לטלפון הזה.",tag:"works-shop-server-test",
      ref:"server-test",sentAt:String(now),expiresAt:String(now+SHOP_TTL_SECONDS*1000)});
  }catch(error) {
    logger.warn("Shop test send failed",{code:error.code||"unknown",deviceId});
    if(invalidTokens.has(error.code)) {
      await rejectToken(deviceId,current.token);
      throw new HttpsError("failed-precondition","מזהה ההתראות של הטלפון פג תוקף. מחדשים אותו אוטומטית.",{reason:"token-rejected"});
    }
    throw new HttpsError("unavailable","שירות ההתראות של Google לא קיבל את הודעת הבדיקה. נסה שוב בעוד דקה.");
  }
  return {sent:true};
});

exports.sendShopShiftReminders=onSchedule({schedule:"* * * * *",timeZone:"Asia/Jerusalem",region:"us-central1",timeoutSeconds:55,maxInstances:1,concurrency:1,retryCount:0},async()=>{
  const startedAt=Date.now(),today=localClock(startedAt).date;
  const data=await roots(eventRoots);
  const devices=activeShopDevices(data.shopNotificationDevices,data["config/managerUid"]);
  if(devices.length===0) {logger.info("Shop reminders checked",{sent:0,devices:0});return;}
  const events=pendingShopEvents(data,startedAt);
  let sent=0;
  for(const event of events.values()) for(const device of devices) {
    if(Date.now()-startedAt>45_000) break;
    if(suppressed(data,event,Date.now())) continue;
    const ref=db().ref(`shopReminderDeliveries/${event.date}/${digest(event.key+device.deviceId)}`);
    const claimId=randomUUID(),now=Date.now();
    const claim=await ref.transaction(state=>deliveryDue(state,now)?{...(state||{}),claimId,leaseUntil:now+75_000,lastAttemptAt:now}:undefined,undefined,false);
    if(!claim.committed) continue;
    let success=false,failed=false;
    const context={ref:shopRef(event),employeeId:event.employeeId,kind:event.kind,date:event.date,start:event.start,deviceId:device.deviceId};
    try {
      // Never trust a device's UI state or a stale employee openShiftId pointer.
      // Recheck both recipient opt-in and actual punches just before dispatch.
      const fresh=await roots(eventRoots);
      const recipient=activeShopDevices(fresh.shopNotificationDevices,fresh["config/managerUid"]).find(d=>d.deviceId===device.deviceId && d.token===device.token);
      const pending=pendingShopEvents(fresh,Date.now()).get(event.key);
      if(!recipient) logger.info("Shop reminder skipped",{...context,reason:"recipient-changed"});
      else if(!pending) logger.info("Shop reminder skipped",{...context,reason:"resolved"});
      else if(suppressed(fresh,pending,Date.now())) logger.info("Shop reminder skipped",{...context,reason:"snoozed-or-cancelled"});
      else {
        const message=shopMessage(pending,recipient,Date.now());
        const messageId=await send(recipient,message);
        success=true;sent++;
        logger.info("Shop reminder sent",{...context,sentAt:Number(message.sentAt),messageId:String(messageId||"")});
      }
    }catch(error) {
      failed=true;
      if(invalidTokens.has(error.code)) await rejectToken(device.deviceId,device.token);
      logger.warn("Shop reminder send failed",{...context,code:error.code||"unknown"});
    }finally {
      await ref.transaction(whenLoaded(state=>state.claimId===claimId?{...state,claimId:null,leaseUntil:0,
        ...(success?{lastSentAt:Date.now(),failedAttempts:0}:failed?{failedAttempts:(Number(state.failedAttempts)||0)+1}:{})}:undefined),undefined,false);
    }
  }
  // Keep audit/deduplication state bounded without changing attendance records.
  if(localClock(startedAt).minute%60===0) {
    const history=(await db().ref("shopReminderDeliveries").get()).val()||{};
    const cutoff=addIsoDays(today,-45);
    await Promise.all(Object.keys(history).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<cutoff).map(d=>db().ref(`shopReminderDeliveries/${d}`).remove()));
    await Promise.all(Object.keys(data.shopReminderSnoozes||{}).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<cutoff).map(d=>db().ref(`shopReminderSnoozes/${d}`).remove()));
    await Promise.all(Object.keys(data.shopReminderCancellations||{}).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<cutoff).map(d=>db().ref(`shopReminderCancellations/${d}`).remove()));
  }
  logger.info("Shop reminders checked",{sent,devices:devices.length,pending:events.size});
});
