"use strict";
const {addIsoDays, dayOfWeek, isoDayNumber, localClock, normalizeTime, normalizedDays} = require("./reminder-logic");
const {createHash} = require("node:crypto");
const REPEAT_MS = 5 * 60_000;
// Push validity at FCM and on the phone. Shorter than REPEAT_MS so at most one
// notice per reminder can be queued, long enough for a sleeping phone to reconnect.
const SHOP_TTL_SECONDS = 180;
// A punch may start this long before a planned shift and still count for it:
// covers continuous presence from an earlier shift. Matches the app's 12-hour auto-close.
const MAX_PRESENCE_MINUTES = 12 * 60;
function linear(date, time) { const [h,m]=time.split(":").map(Number); return isoDayNumber(date)*1440+h*60+m; }

function buildShopPlans(data, dates) {
  const plans=new Map();
  function add(shift,date) {
    const emp=data.employees?.[shift?.employeeId];
    if(!emp || emp.active===false || shift.cancelled===true) return;
    const start=normalizeTime(shift.startTime),end=normalizeTime(shift.endTime);
    if(!start || !end || start===end) return;
    const startLinear=linear(date,start);
    const endDate=end<start ? addIsoDays(date,1) : date;
    const key=JSON.stringify([shift.employeeId,date,start,end]);
    plans.set(key,{key,employeeId:shift.employeeId,name:emp.name||"עובד",date,start,end,startLinear,endLinear:linear(endDate,end)});
  }
  for(const date of dates) {
    for(const s of Object.values(data.recurringShifts||{})) {
      if(s && normalizedDays(s.daysOfWeek).includes(dayOfWeek(date)) && !s.cancelledDates?.[date]) add(s,date);
    }
    for(const s of Object.values(data.oneTimeShifts||{})) if(s?.date===date) add(s,date);
  }
  return [...plans.values()].sort((a,b)=>a.startLinear-b.startLinear || a.key.localeCompare(b.key));
}

// A punch covers every planned shift of that employee during which they were
// present: clocked in before the plan ended and not clocked out before it
// started. Covering satisfies entry, also for a continuous shift that began
// hours earlier; a punch that ended before the plan started does not. Closed
// punches still satisfy entry, so completing a shift never restarts reminders.
// Exit is due after a plan ends while a covering punch is still open, unless
// that punch already continues into a later plan of the employee that has
// started (back-to-back or overlapping plans remind only at the last end).
const shopCancelled=(data,plan)=>data.shopReminderCancellations?.[plan.date]?.[createHash("sha256").update(plan.key).digest("hex")]?.cancelled===true;
function pendingShopEvents(data, nowMs) {
  const now=localClock(nowMs);
  const plans=buildShopPlans(data,[addIsoDays(now.date,-1),now.date,addIsoDays(now.date,1)]);
  const covering=new Map(plans.map(p=>[p.key,[]]));
  for(const [shiftId,shift] of Object.entries(data.shifts||{})) {
    const stamp=Number(shift?.clockIn);
    // History older than the earliest plan window cannot cover a plan (skips most of 'shifts').
    if(!Number.isFinite(stamp) || stamp<=0 || stamp>nowMs || stamp<nowMs-3*86_400_000) continue;
    const at=localClock(stamp).linear;
    const outMs=Number(shift.clockOut);
    // The app's 12-hour auto-close writes clockIn+12h: an invented clock-out,
    // not presence. Such a punch counts only for plans already running at clock-in.
    const out=shift.autoCloseFlag===true ? at+1 : shift.clockOut && Number.isFinite(outMs) ? localClock(outMs).linear : Infinity;
    const mine=plans.filter(p=>p.employeeId===shift.employeeId && at<p.endLinear && out>p.startLinear && at>=p.startLinear-MAX_PRESENCE_MINUTES);
    for(const p of mine) {
      // A closed punch that is the attendance of an earlier plan (or began long
      // before this one) and merely ran past this plan's start - a late or
      // closing-grace clock-out - counts for it only if it stayed past its midpoint.
      const carried=out!==Infinity && at<p.startLinear && out<(p.startLinear+p.endLinear)/2 &&
        (at<p.startLinear-180 || mine.some(q=>q!==p && q.startLinear<p.startLinear));
      if(!carried) covering.get(p.key).push({...shift,shiftId});
    }
  }
  const events=new Map();
  for(const plan of plans) {
    const actual=covering.get(plan.key);
    // A punch that began in this plan's last 30 minutes and also covers the
    // employee's next plan starting within the hour is an early arrival for that
    // plan, not a stay in this one: no exit reminder for this plan.
    const open=actual.filter(s=>!s.clockOut && !(localClock(Number(s.clockIn)).linear>=plan.endLinear-30 &&
      plans.some(next=>next.employeeId===plan.employeeId && next.startLinear>=plan.endLinear && next.startLinear-plan.endLinear<=60 &&
        covering.get(next.key).some(c=>c.shiftId===s.shiftId))));
    let kind;
    if(now.linear>=plan.startLinear && now.linear<plan.endLinear && actual.length===0) kind="in";
    else if(now.linear>=plan.endLinear && open.length) {
      // Plans ending together remind once (tie broken by key); a plan cancelled
      // with "not coming" never absorbs the exit of the plan actually worked.
      const continues=open.every(s=>plans.some(next=>next!==plan && next.employeeId===plan.employeeId &&
        (next.endLinear>plan.endLinear || (next.endLinear===plan.endLinear && next.key>plan.key)) &&
        next.startLinear<=now.linear && !shopCancelled(data,next) && covering.get(next.key).some(c=>c.shiftId===s.shiftId)));
      if(!continues) kind="out";
    }
    if(!kind) continue;
    const key=JSON.stringify([plan.key,kind]);
    const openShiftIds=open.map(s=>s.shiftId).sort();
    events.set(key,{...plan,planKey:plan.key,key,kind,time:kind==="in"?plan.start:plan.end,
      snoozeKey:JSON.stringify([key,openShiftIds])});
  }
  return events;
}
// The scheduler ticks once a minute; compare minute buckets so second-level
// jitter (a send at :02, the next tick at :01) never adds a sixth minute.
// Reminders repeat every REPEAT_MS after a send FCM accepted. A failed or
// skipped attempt only waits for the next minute instead of a full cycle.
function deliveryDue(state, nowMs) {
  if(Number(state?.leaseUntil)>nowMs) return false;
  const minute=Math.floor(nowMs/60_000),attempt=Number(state?.lastAttemptAt)||0;
  // A claim that was never released may have been sent (lost release,
  // timeout): count it, as do older rows that never recorded lastSentAt.
  const sent=Math.max(Number(state?.lastSentAt)||0,state?.claimId ? attempt : 0);
  if(sent && minute-Math.floor(sent/60_000)<REPEAT_MS/60_000) return false;
  // One quick retry; while sends keep failing, fall back to the normal cadence.
  const retryMinutes=Number(state?.failedAttempts)>=2 ? REPEAT_MS/60_000 : 1;
  return !attempt || minute-Math.floor(attempt/60_000)>=retryMinutes;
}
function activeShopDevices(devices, managerUid) {
  const tokens=new Map();
  if(!managerUid) return [];
  for(const [deviceId,d] of Object.entries(devices||{})) {
    if(!d || d.enabled!==true || d.uid!==managerUid || typeof d.token!=="string" || !d.token) continue;
    const row={...d,deviceId};
    const prev=tokens.get(d.token);
    if(!prev || Number(row.updatedAt)>Number(prev.updatedAt)) tokens.set(d.token,row);
  }
  return [...tokens.values()];
}
// Short correlation id shared by server logs and the phone's receipt log.
const shopRef=event=>createHash("sha256").update(event.key).digest("hex").slice(0,16);
function shopMessage(event,device,nowMs) {
  const kind=event.kind==="in"?"כניסה":"יציאה";
  return {audience:"shop",deviceId:device.deviceId,employeeId:event.employeeId,kind:event.kind,ref:shopRef(event),sentAt:String(nowMs),
    title:`🔔 ${event.name} — צריך להחתים ${kind}`,
    body:`שעת ${kind}: ${event.time}. התזכורת תחזור כל 5 דקות עד לרישום ההחתמה.`,
    tag:`works-shop-${event.employeeId}-${event.kind}`,eventKey:event.key,planKey:event.planKey,snoozeKey:event.snoozeKey,
    expiresAt:String(nowMs+SHOP_TTL_SECONDS*1000)};
}
module.exports={REPEAT_MS,SHOP_TTL_SECONDS,buildShopPlans,pendingShopEvents,deliveryDue,activeShopDevices,shopMessage,shopRef};
