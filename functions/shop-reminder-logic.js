"use strict";
const {addIsoDays, dayOfWeek, isoDayNumber, localClock, normalizeTime, normalizedDays} = require("./reminder-logic");
const REPEAT_MS = 5 * 60_000;
const EARLY_ENTRY_MINUTES = 180;
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

// Each actual shift belongs to at most one planned shift. Closed shifts still
// satisfy entry, so completing a morning shift cannot restart its reminders.
function pendingShopEvents(data, nowMs) {
  const now=localClock(nowMs);
  const plans=buildShopPlans(data,[addIsoDays(now.date,-1),now.date,addIsoDays(now.date,1)]);
  const punches=new Map(plans.map(p=>[p.key,[]]));
  for(const shift of Object.values(data.shifts||{})) {
    const stamp=Number(shift?.clockIn);
    if(!Number.isFinite(stamp) || stamp<=0 || stamp>nowMs) continue;
    const at=localClock(stamp).linear;
    const candidates=plans.filter(p=>p.employeeId===shift.employeeId && at>=p.startLinear-EARLY_ENTRY_MINUTES && at<p.endLinear);
    candidates.sort((a,b)=>Math.abs(at-a.startLinear)-Math.abs(at-b.startLinear)||a.startLinear-b.startLinear);
    if(candidates[0]) punches.get(candidates[0].key).push(shift);
  }
  const events=new Map();
  for(const plan of plans) {
    const actual=punches.get(plan.key);
    let kind;
    if(now.linear>=plan.startLinear && now.linear<plan.endLinear && actual.length===0) kind="in";
    else if(now.linear>=plan.endLinear && actual.some(s=>!s.clockOut)) kind="out";
    if(!kind) continue;
    const key=JSON.stringify([plan.key,kind]);
    events.set(key,{...plan,key,kind,time:kind==="in"?plan.start:plan.end});
  }
  return events;
}
function deliveryDue(state, nowMs) {
  const last=Math.max(Number(state?.lastSentAt)||0,Number(state?.lastAttemptAt)||0);
  // The scheduler ticks once a minute; ignore second-level delivery jitter so
  // a successful send at :02 does not postpone the next :01 tick a full minute.
  return (!last || Math.floor(nowMs/60_000)-Math.floor(last/60_000)>=REPEAT_MS/60_000) && !(Number(state?.leaseUntil)>nowMs);
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
function shopMessage(event,device,nowMs) {
  const kind=event.kind==="in"?"כניסה":"יציאה";
  return {audience:"shop",deviceId:device.deviceId,employeeId:event.employeeId,kind:event.kind,
    title:`🔔 ${event.name} — צריך להחתים ${kind}`,
    body:`שעת ${kind}: ${event.time}. התזכורת תחזור כל 5 דקות עד לרישום ההחתמה.`,
    tag:`works-shop-${event.employeeId}-${event.kind}`,eventKey:event.key,
    expiresAt:String(nowMs+60_000)};
}
module.exports={REPEAT_MS,buildShopPlans,pendingShopEvents,deliveryDue,activeShopDevices,shopMessage};
