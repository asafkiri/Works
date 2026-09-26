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
  assert.equal(deliveryDue({lastAttemptAt:first},at("08:04")),false);
  assert.equal(deliveryDue({leaseUntil:first+75000},first+60000),false);
});
test("only explicitly enabled manager devices receive push and duplicate tokens are sent once",()=>{
  const devices=activeShopDevices({a:{enabled:true,uid:"mgr",token:"one",updatedAt:1},b:{enabled:true,uid:"mgr",token:"one",updatedAt:2},c:{enabled:false,uid:"mgr",token:"two"},d:{uid:"mgr",token:"three"},e:{enabled:true,uid:"worker",token:"four"}},"mgr");
  assert.deepEqual(devices.map(d=>d.deviceId),["b"]);
  const e=[...pendingShopEvents(data(),at("08:00")).values()][0];
  const message=shopMessage(e,devices[0],at("08:00"));
  assert.equal(message.audience,"shop");assert.equal(message.deviceId,"b");assert.match(message.title,/דני/);
  assert.equal(Number(message.expiresAt),at("08:01"));assert.ok(Object.values(message).every(v=>typeof v==="string"));
});
