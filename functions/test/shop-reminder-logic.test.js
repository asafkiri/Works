"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {pendingShopEvents,deliveryDue,activeShopDevices,shopMessage}=require("../shop-reminder-logic");
const at=(time,date="2026-09-27")=>Date.parse(`${date}T${time}:00+03:00`);
function data(){return {employees:{a:{name:"דני",active:true}},oneTimeShifts:{p:{employeeId:"a",date:"2026-09-27",startTime:"08:00",endTime:"16:00"}},shifts:{}};}
const kinds=(d,time,date)=>[...pendingShopEvents(d,at(time,date)).values()].map(e=>e.kind);

test("entry starts at scheduled time and actual entry stops it despite a stale pointer",()=>{
  const d=data();assert.deepEqual(kinds(d,"07:59"),[]);assert.deepEqual(kinds(d,"08:00"),["in"]);
  assert.deepEqual(kinds(d,"08:25"),["in"]);
  d.shifts.s={employeeId:"a",clockIn:at("08:26"),clockOut:null};
  assert.deepEqual(kinds(d,"08:26"),[]);assert.deepEqual(kinds(d,"15:59"),[]);
});
test("exit repeats until clock-out is recorded, including a future bonus clock-out",()=>{
  const d=data();d.shifts.s={employeeId:"a",clockIn:at("07:45"),clockOut:null};
  assert.deepEqual(kinds(d,"16:00"),["out"]);assert.deepEqual(kinds(d,"17:25"),["out"]);
  d.shifts.s.clockOut=at("17:30");d.employees.a.openShiftId="s";
  assert.deepEqual(kinds(d,"17:26"),[]);
});
test("an absent worker gets no exit reminder; completed entry never restarts",()=>{
  const d=data();assert.deepEqual(kinds(d,"16:00"),[]);
  d.shifts.s={employeeId:"a",clockIn:at("08:00"),clockOut:at("10:00")};
  assert.deepEqual(kinds(d,"11:00"),[]);assert.deepEqual(kinds(d,"16:00"),[]);
});
test("morning attendance cannot satisfy a second planned shift",()=>{
  const d=data();d.oneTimeShifts.p.endTime="12:00";
  d.oneTimeShifts.q={...d.oneTimeShifts.p,startTime:"17:00",endTime:"21:00"};
  d.shifts.s={employeeId:"a",clockIn:at("08:00"),clockOut:at("12:00")};
  assert.deepEqual(kinds(d,"17:00"),["in"]);
  d.shifts.t={employeeId:"a",clockIn:at("16:55"),clockOut:null};
  assert.deepEqual(kinds(d,"17:00"),[]);assert.deepEqual(kinds(d,"21:00"),["out"]);
});
test("overnight exit matches yesterday's entry after midnight",()=>{
  const d=data();Object.assign(d.oneTimeShifts.p,{startTime:"22:00",endTime:"06:00"});
  d.shifts.s={employeeId:"a",clockIn:at("21:55"),clockOut:null};
  assert.deepEqual(kinds(d,"05:59","2026-09-28"),[]);
  assert.deepEqual(kinds(d,"06:00","2026-09-28"),["out"]);
  d.shifts.s.clockOut=at("06:05","2026-09-28");assert.deepEqual(kinds(d,"06:05","2026-09-28"),[]);
});
test("duplicate recurring/one-time plans deduplicate; cancellation and inactive workers suppress reminders",()=>{
  const d=data();d.recurringShifts={r:{employeeId:"a",daysOfWeek:[0],startTime:"08:00",endTime:"16:00"}};
  assert.deepEqual(kinds(d,"08:00"),["in"]);
  d.recurringShifts.r.cancelledDates={"2026-09-27":true};d.oneTimeShifts={};
  assert.deepEqual(kinds(d,"08:00"),[]);
  d.recurringShifts.r.cancelledDates={};d.employees.a.active=false;assert.deepEqual(kinds(d,"08:00"),[]);
});
test("repeat cadence is five scheduler minutes, without duplicates or a sixth-minute jitter delay",()=>{
  const first=at("08:00")+2000;
  assert.equal(deliveryDue(null,first),true);
  assert.equal(deliveryDue({lastSentAt:first},at("08:04")+59000),false);
  assert.equal(deliveryDue({lastSentAt:first},at("08:05")+1000),true);
  assert.equal(deliveryDue({lastAttemptAt:first},at("08:00")+50000),false,"one attempt per scheduler minute");
  assert.equal(deliveryDue({lastAttemptAt:first},at("08:01")),true,"a failed attempt is retried next minute");
  assert.equal(deliveryDue({lastAttemptAt:first,failedAttempts:2},at("08:04")),false,"repeated failures back off");
  assert.equal(deliveryDue({lastAttemptAt:first,failedAttempts:2},at("08:05")),true);
  assert.equal(deliveryDue({lastAttemptAt:first,claimId:"legacy"},at("08:04")),false,"older rows: last attempt was the last send");
  assert.equal(deliveryDue({leaseUntil:first+75000},first+60000),false);
});
test("only explicitly enabled manager devices receive push and duplicate tokens are sent once",()=>{
  const devices=activeShopDevices({a:{enabled:true,uid:"mgr",token:"one",updatedAt:1},b:{enabled:true,uid:"mgr",token:"one",updatedAt:2},c:{enabled:false,uid:"mgr",token:"two"},d:{uid:"mgr",token:"three"},e:{enabled:true,uid:"worker",token:"four"}},"mgr");
  assert.deepEqual(devices.map(d=>d.deviceId),["b"]);
  const e=[...pendingShopEvents(data(),at("08:00")).values()][0];
  const message=shopMessage(e,devices[0],at("08:00"));
  assert.equal(message.audience,"shop");assert.equal(message.deviceId,"b");assert.match(message.title,/דני/);
  assert.equal(Number(message.expiresAt),at("08:03"));assert.equal(message.sentAt,String(at("08:00")));assert.match(message.ref,/^[a-f0-9]{16}$/);
  assert.ok(Object.values(message).every(v=>typeof v==="string"));
});

// Plans for one employee on 2026-09-28 (Monday) given as [start,end] pairs.
function plans(...pairs){
  const d={employees:{a:{name:"אסף",active:true}},oneTimeShifts:{},shifts:{}};
  pairs.forEach(([startTime,endTime],i)=>{d.oneTimeShifts["p"+i]={employeeId:"a",date:"2026-09-28",startTime,endTime};});
  return d;
}
const on=(d,time,date="2026-09-28")=>[...pendingShopEvents(d,at(time,date)).values()].map(e=>`${e.kind}@${e.start}`);
test("an employee already clocked in for hours gets no entry reminder for a later plan, and does get its exit reminder",()=>{
  const d=plans(["16:51","17:10"]);d.shifts.s={employeeId:"a",clockIn:at("07:30","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"16:51"),[]);assert.deepEqual(on(d,"16:56"),[]);
  assert.deepEqual(on(d,"17:10"),["out@16:51"]);
  d.shifts.s.clockOut=at("17:12","2026-09-28");assert.deepEqual(on(d,"17:15"),[]);
});
test("a late arrival counts for the plan it arrives in, and the next plan still reminds after they leave",()=>{
  const d=plans(["08:00","12:00"],["13:00","17:00"]);d.shifts.s={employeeId:"a",clockIn:at("11:00","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"11:30"),[]);assert.deepEqual(on(d,"12:00"),["out@08:00"]);
  d.shifts.s.clockOut=at("12:00","2026-09-28");assert.deepEqual(on(d,"13:00"),["in@13:00"]);
  d.shifts.t={employeeId:"a",clockIn:at("13:02","2026-09-28"),clockOut:null};assert.deepEqual(on(d,"13:05"),[]);
});
test("a punch that ended before the plan started does not satisfy its entry",()=>{
  const d=plans(["08:00","12:00"]);d.shifts.s={employeeId:"a",clockIn:at("06:00","2026-09-28"),clockOut:at("07:30","2026-09-28")};
  assert.deepEqual(on(d,"08:00"),["in@08:00"]);
});
test("one continuous punch across back-to-back plans: no exit at the first end and no entry for the second",()=>{
  const d=plans(["08:00","12:00"],["12:00","16:00"]);d.shifts.s={employeeId:"a",clockIn:at("07:58","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"12:00"),[]);assert.deepEqual(on(d,"15:59"),[]);assert.deepEqual(on(d,"16:00"),["out@12:00"]);
});
test("overlapping duplicate plans remind to clock out once, at the last end",()=>{
  const d=plans(["08:00","16:00"],["09:00","17:00"]);d.shifts.s={employeeId:"a",clockIn:at("07:58","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"09:00"),[]);assert.deepEqual(on(d,"16:00"),[]);assert.deepEqual(on(d,"17:00"),["out@09:00"]);
});
test("split shift: staying clocked in through the gap reminds to clock out until the second plan starts",()=>{
  const d=plans(["08:00","12:00"],["13:00","17:00"]);d.shifts.s={employeeId:"a",clockIn:at("07:55","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"12:00"),["out@08:00"]);assert.deepEqual(on(d,"12:55"),["out@08:00"]);
  assert.deepEqual(on(d,"13:05"),[]);assert.deepEqual(on(d,"17:00"),["out@13:00"]);
});
test("a forgotten open punch older than 12 hours does not count as attendance for a new plan",()=>{
  const d=plans(["20:00","22:00"]);d.shifts.s={employeeId:"a",clockIn:at("06:00","2026-09-27"),clockOut:null};
  assert.deepEqual(on(d,"20:00"),["in@20:00"]);
});
test("another employee's attendance never satisfies this employee's plan",()=>{
  const d=plans(["08:00","12:00"]);d.employees.b={name:"דוד",active:true};
  d.shifts.s={employeeId:"b",clockIn:at("07:55","2026-09-28"),clockOut:null};
  assert.deepEqual(on(d,"08:00"),["in@08:00"]);
});
