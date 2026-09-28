"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../shop-notifications.js"),"utf8");
const DEVICE="10000000-1000-4000-8000-100000000001";
const TOKEN="only-the-shop-phone-token";
const start=Date.parse("2026-09-27T08:00:00+03:00");
function server(){
  let now=start,sendError=null,afterClaim=null,attempts=0;const logs=[];
  const data={config:{managerUid:"manager"},employees:{a:{name:"דני"}},oneTimeShifts:{p:{employeeId:"a",date:"2026-09-27",startTime:"08:00",endTime:"16:00"}},shifts:{}};
  const sent=[];
  const clone=v=>v===undefined?null:structuredClone(v);
  function read(p){return p.split("/").filter(Boolean).reduce((o,k)=>o?.[k],data);}
  function write(p,v){const keys=p.split("/").filter(Boolean),last=keys.pop();let target=data;for(const k of keys)target=target[k]??={};if(v===null)delete target[last];else target[last]=clone(v);}
  const db={ref(p=""){return {
    async get(){return {val:()=>clone(read(p))};},
    async set(v){write(p,v);},async remove(){write(p,null);},
    async update(v){for(const [k,value]of Object.entries(v))write([p,k].filter(Boolean).join("/"),value);},
    // Like the Admin SDK with no listener: the update first runs on an empty local
    // cache (null); undefined aborts locally, anything else is re-run on the server value.
    async transaction(fn){
      let result=fn(null);if(result===undefined)return {committed:false};
      const actual=clone(read(p));
      if(actual!==null){result=fn(actual);if(result===undefined)return {committed:false};}
      write(p,result);if(result?.claimId&&afterClaim)afterClaim();return {committed:true};
    }
  };}};
  class HttpsError extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}
  const context={exports:{},Date:class extends Date{static now(){return now;}},require(name){
    if(name==="firebase-admin/database")return {getDatabaseWithUrl:()=>db};
    if(name==="firebase-admin/messaging")return {getMessaging:()=>({send:async message=>{attempts++;if(sendError)throw sendError;sent.push(clone(message));return "ok";}})};
    if(name==="firebase-functions/v2/https")return {onCall:(_,fn)=>fn,HttpsError};
    if(name==="firebase-functions/v2/scheduler")return {onSchedule:(_,fn)=>fn};
    if(name==="firebase-functions/logger")return {warn:(msg,o)=>logs.push({msg,...o}),info:(msg,o)=>logs.push({msg,...o})};
    if(name.startsWith("./"))return require("../"+name.slice(2));return require(name);
  }};
  vm.runInNewContext(source,context);
  const call=(action,uid="manager",extra={})=>context.exports.setShopNotificationDevice({auth:uid?{uid}:undefined,data:{action,deviceId:DEVICE,token:TOKEN,...extra}});
  return {data,sent,logs,call,tick:context.exports.sendShopShiftReminders,now:v=>{now=v;},fail:v=>{sendError=v;},afterClaim:fn=>{afterClaim=fn;},attempts:()=>attempts};
}
test("device enrollment is manager-authenticated and switches only explicit terminals to shop routing",async()=>{
  const s=server();await assert.rejects(s.call("enable",null),{code:"unauthenticated"});
  await assert.rejects(s.call("enable","employee"),{code:"permission-denied"});
  await assert.rejects(s.call("enable","manager",{deviceId:"../bad"}),{code:"invalid-argument"});
  assert.equal(s.data.shopNotificationDevices,undefined);
  await s.call("enable");assert.equal(s.data.shopNotificationDevices[DEVICE].token,TOKEN);
  assert.equal(s.data.shopNotificationRouting.mode,"shop-only");
  await s.call("disable");assert.equal(s.data.shopNotificationDevices[DEVICE].enabled,false);
  assert.equal(s.data.shopNotificationDevices[DEVICE].token,undefined);
  assert.equal(s.data.shopNotificationRouting.mode,"shop-only");
});
test("scheduler sends only to an opted-in terminal every five minutes and stops after entry",async()=>{
  const s=server();s.data.managerTokens={other:{token:"personal-manager-phone"}};
  s.data.pushTokens={a:{other:{token:"employee-phone"}}};
  await s.tick();assert.equal(s.sent.length,0);
  await s.call("enable");await s.tick();await s.tick();assert.equal(s.sent.length,1);
  s.now(start+4*60000);await s.tick();assert.equal(s.sent.length,1);
  s.now(start+5*60000);await s.tick();assert.equal(s.sent.length,2);
  assert.ok(s.sent.every(m=>m.token===TOKEN&&m.data.audience==="shop"&&!m.notification));
  s.data.shifts.s={employeeId:"a",clockIn:start+6*60000,clockOut:null};
  s.now(start+10*60000);await s.tick();assert.equal(s.sent.length,2);
  s.now(start+8*3600000);await s.tick();assert.equal(s.sent.length,3);assert.equal(s.sent[2].data.kind,"out");
  s.data.shifts.s.clockOut=start+8*3600000;s.now(start+8*3600000+5*60000);await s.tick();assert.equal(s.sent.length,3);
});
test("clock-in or opt-out racing a scheduler claim suppresses the pending send",async()=>{
  const s=server();await s.call("enable");
  s.afterClaim(()=>{s.data.shifts.s={employeeId:"a",clockIn:start,clockOut:null};});
  await s.tick();assert.equal(s.sent.length,0);
  const t=server();await t.call("enable");t.afterClaim(()=>{t.data.shopNotificationDevices[DEVICE].enabled=false;});
  await t.tick();assert.equal(t.sent.length,0);
});
test("overlapping scheduler invocations claim a delivery once",async()=>{
  const s=server();await s.call("enable");await Promise.all([s.tick(),s.tick()]);assert.equal(s.sent.length,1);
});
test("a failed send is retried once on the next minute, then backs off while failures continue",async()=>{
  const s=server();await s.call("enable");const temporary=Object.assign(Error("temporary"),{code:"messaging/server-unavailable"});
  s.fail(temporary);await s.tick();assert.equal(s.attempts(),1);
  s.fail(null);s.now(start+60000);await s.tick();assert.equal(s.sent.length,1,"the reminder is not lost for five minutes");
  s.now(start+5*60000);await s.tick();assert.equal(s.sent.length,1,"cadence counts from the successful send");
  s.now(start+6*60000);await s.tick();assert.equal(s.sent.length,2);
  s.fail(temporary);s.now(start+11*60000);await s.tick();s.now(start+12*60000);await s.tick();assert.equal(s.attempts(),5);
  for(const minute of [13,14,15,16])await (s.now(start+minute*60000),s.tick());
  assert.equal(s.attempts(),5,"no retry every minute while sends keep failing");
  s.now(start+17*60000);await s.tick();assert.equal(s.attempts(),6);
});
test("the delivery lease is released and the successful send is recorded under real transaction semantics",async()=>{
  const s=server();await s.call("enable");await s.tick();
  const [row]=Object.values(s.data.shopReminderDeliveries["2026-09-27"]);
  assert.equal(row.claimId,null);assert.equal(row.leaseUntil,0);assert.equal(row.lastSentAt,start);
  assert.ok(s.logs.some(l=>l.msg==="Shop reminder sent"&&l.employeeId==="a"&&l.kind==="in"&&l.ref));
});
test("a token FCM rejects is deactivated and cannot be re-enabled; a new token can",async()=>{
  const s=server();await s.call("enable");s.fail(Object.assign(Error("gone"),{code:"messaging/registration-token-not-registered"}));
  await s.tick();const row=s.data.shopNotificationDevices[DEVICE];
  assert.equal(row.enabled,false);assert.equal(row.token??null,null);assert.equal(row.disabledReason,"token-rejected");
  await assert.rejects(s.call("pending"),e=>e.code==="failed-precondition"&&e.details?.reason==="token-rejected");
  await assert.rejects(s.call("enable"),e=>e.code==="failed-precondition"&&e.details?.reason==="token-rejected");
  s.fail(null);const fresh=await s.call("enable","manager",{token:"a-brand-new-shop-phone-token"});
  assert.equal(fresh.enabled,true);assert.ok(fresh.serverTime>0);
  s.now(start+60000);await s.tick();assert.equal(s.sent.at(-1).token,"a-brand-new-shop-phone-token");
});
test("receipts from the phone are logged only for this manager's device and only with known outcomes",async()=>{
  const s=server();await assert.rejects(s.call("report","manager",{entries:[]}),{code:"failed-precondition"});
  await s.call("enable");
  const result=await s.call("report","manager",{entries:[{outcome:"shown",ref:"abc",employeeId:"a",kind:"in",sentAt:1,receivedAt:2,path:"push"},{outcome:"bogus"},null]});
  assert.equal(result.logged,1);assert.ok(s.logs.some(l=>l.msg==="Shop reminder receipt"&&l.outcome==="shown"&&l.deviceId===DEVICE));
  await assert.rejects(s.call("report","employee",{entries:[]}),{code:"permission-denied"});
});
test("server test targets this device, requires opt-in and is rate limited",async()=>{
  const s=server();await assert.rejects(s.call("test"),{code:"failed-precondition"});
  await s.call("enable");await s.call("test");assert.equal(s.sent.length,1);assert.equal(s.sent[0].data.kind,"test");
  await assert.rejects(s.call("test"),{code:"resource-exhausted"});
  await s.call("disable");s.now(start+10*60000);await s.tick();assert.equal(s.sent.length,1);
});

const end=start+8*3600000;
async function exitServer(){
  const s=server();await s.call("enable");
  s.data.shifts.s={employeeId:"a",clockIn:start,clockOut:null};s.now(end);
  const event=(await s.call("pending")).events[0];
  return {s,event};
}
test("all six exit snoozes pause until their deadline then resume five-minute repeats",async()=>{
  for(const minutes of [10,20,30,40,50,60]){
    const {s,event}=await exitServer();await s.tick();assert.equal(s.sent.length,1);
    const attendance=structuredClone(s.data.shifts);
    const result=await s.call("snooze","manager",{...event,minutes});
    assert.equal(result.until,end+minutes*60000);
    for(let m=1;m<minutes;m++){s.now(end+m*60000);await s.tick();}
    assert.equal(s.sent.length,1);
    s.now(result.until);await s.tick();assert.equal(s.sent.length,2);
    s.now(result.until+4*60000);await s.tick();assert.equal(s.sent.length,2);
    s.now(result.until+5*60000);await s.tick();assert.equal(s.sent.length,3);
    assert.deepEqual(s.data.shifts,attendance);
  }
});
test("snooze affects all shop devices for one shift, never another employee or a later actual shift",async()=>{
  const {s,event}=await exitServer();
  await s.call("enable","manager",{deviceId:DEVICE.replace(/1$/,"2"),token:TOKEN+"-second"});
  s.data.employees.b={name:"טל"};s.data.oneTimeShifts.q={...s.data.oneTimeShifts.p,employeeId:"b"};
  s.data.shifts.b={employeeId:"b",clockIn:start,clockOut:null};
  await s.call("snooze","manager",{...event,minutes:60});await s.tick();
  assert.equal(s.sent.length,2);assert.ok(s.sent.every(m=>m.data.employeeId==="b"));
  s.data.shifts.s.clockOut=end;
  s.data.shifts.next={employeeId:"a",clockIn:start+60000,clockOut:null};
  s.now(end+60000);await s.tick();
  assert.equal(s.sent.filter(m=>m.data.employeeId==="a").length,2);
  await assert.rejects(s.call("snooze","manager",{...event,minutes:10}),{code:"failed-precondition"});
});
test("closed shifts, stale events, unsupported durations and non-enrolled phones cannot snooze",async()=>{
  const {s,event}=await exitServer();
  for(const minutes of [5,15,0,-10,61,"10",null])await assert.rejects(s.call("snooze","manager",{...event,minutes}),{code:"invalid-argument"});
  await assert.rejects(s.call("snooze","employee",{...event,minutes:10}),{code:"permission-denied"});
  await s.call("disable");await assert.rejects(s.call("snooze","manager",{...event,minutes:10}),{code:"failed-precondition"});
  await s.call("enable");s.data.shifts.s.clockOut=end;
  await assert.rejects(s.call("snooze","manager",{...event,minutes:10}),{code:"failed-precondition"});
  assert.equal((await s.call("pending")).events.length,0);
  delete s.data.shifts.s;s.now(start);
  assert.equal((await s.call("pending")).events[0].kind,"in");
  await assert.rejects(s.call("snooze","manager",{...event,minutes:10}),{code:"failed-precondition"});
});

test("all six entry snoozes resume five-minute repeats; actual entry ends the pending control",async()=>{
  for(const minutes of [10,20,30,40,50,60]){
    const s=server();await s.call("enable");await s.tick();
    const event=(await s.call("pending")).events[0];assert.equal(event.kind,"in");
    const result=await s.call("snooze","manager",{...event,minutes});
    for(let m=1;m<minutes;m++){s.now(start+m*60000);await s.tick();}
    assert.equal(s.sent.length,1);
    assert.equal((await s.call("pending")).events[0].until,result.until);
    s.now(result.until);await s.tick();assert.equal(s.sent.length,2);
    s.now(result.until+4*60000);await s.tick();assert.equal(s.sent.length,2);
    s.now(result.until+5*60000);await s.tick();assert.equal(s.sent.length,3);
    await s.call("snooze","manager",{...event,minutes:60});
    s.data.shifts.s={employeeId:"a",clockIn:result.until+5*60000,clockOut:null};
    assert.equal((await s.call("pending")).events.length,0);
    s.now(result.until+65*60000);await s.tick();assert.equal(s.sent.length,3);
    s.now(end);await s.tick();assert.equal(s.sent.length,4);assert.equal(s.sent.at(-1).data.kind,"out");
  }
});
test("cancelling entry cancels both kinds for this plan across terminals without changing attendance or schedule",async()=>{
  const s=server();await s.call("enable");
  await s.call("enable","manager",{deviceId:DEVICE.replace(/1$/,"2"),token:TOKEN+"-second"});
  s.data.employees.b={name:"טל"};s.data.oneTimeShifts.q={...s.data.oneTimeShifts.p,employeeId:"b"};
  const event=(await s.call("pending")).events.find(e=>e.employeeId==="a");
  const attendance=structuredClone(s.data.shifts),schedule=structuredClone(s.data.oneTimeShifts);
  await s.call("snooze","manager",{...event,minutes:10});
  const result=await s.call("cancel","manager",event);assert.equal(result.planKey,event.planKey);
  assert.equal(result.cancelled,true);
  assert.deepEqual(s.data.shifts,attendance);assert.deepEqual(s.data.oneTimeShifts,schedule);
  assert.ok((await s.call("pending")).events.every(e=>e.employeeId==="b"));
  s.now(start+15*60000);await s.tick();assert.equal(s.sent.length,2);
  assert.ok(s.sent.every(m=>m.data.employeeId==="b"));
  // A later real punch must not resurrect the cancelled plan's exit reminder.
  s.data.shifts.s={employeeId:"a",clockIn:start+20*60000,clockOut:null};
  s.now(end);await s.tick();s.now(end+5*60000);await s.tick();assert.equal(s.sent.length,2);
  assert.equal((await s.call("pending")).events.length,0);
  assert.equal(s.data.shifts.s.clockOut,null);
});
test("cancellation does not mute a second same-day shift, the next recurring date, or another employee",async()=>{
  const s=server();await s.call("enable");delete s.data.oneTimeShifts.p;
  s.data.recurringShifts={r:{employeeId:"a",daysOfWeek:[0,1],startTime:"08:00",endTime:"16:00"}};
  const event=(await s.call("pending")).events[0];await s.call("cancel","manager",event);
  s.data.oneTimeShifts.late={employeeId:"a",date:"2026-09-27",startTime:"18:00",endTime:"22:00"};
  s.now(start+10*3600000);await s.tick();assert.equal(s.sent.length,1);assert.equal(s.sent[0].data.kind,"in");
  s.now(start+24*3600000);await s.tick();assert.equal(s.sent.length,2);
  assert.notEqual(s.sent[1].data.planKey,event.planKey);
});
test("cancellation requires an active entry reminder and an enrolled manager phone",async()=>{
  const s=server();await s.call("enable");const event=(await s.call("pending")).events[0];
  await assert.rejects(s.call("cancel",null,event),{code:"unauthenticated"});
  await assert.rejects(s.call("cancel","employee",event),{code:"permission-denied"});
  await s.call("disable");await assert.rejects(s.call("cancel","manager",event),{code:"failed-precondition"});
  await s.call("enable");await assert.rejects(s.call("cancel","manager",{...event,eventKey:"unknown"}),{code:"failed-precondition"});
  s.data.shifts.s={employeeId:"a",clockIn:start,clockOut:null};
  await assert.rejects(s.call("cancel","manager",event),{code:"failed-precondition"});
  s.now(end);const out=(await s.call("pending")).events[0];
  await assert.rejects(s.call("cancel","manager",out),{code:"failed-precondition"});
  assert.equal(s.data.shopReminderCancellations,undefined);
});
test("a cancellation racing dispatch or snooze cannot be undone by stale state",async()=>{
  const s=server();await s.call("enable");const event=(await s.call("pending")).events[0];
  await Promise.all([s.call("cancel","manager",event),s.call("snooze","manager",{...event,minutes:10})]);
  s.now(start+20*60000);await s.tick();assert.equal(s.sent.length,0);
  await assert.rejects(s.call("snooze","manager",{...event,minutes:10}),{code:"failed-precondition"});
  const t=server();await t.call("enable");const active=(await t.call("pending")).events[0];
  t.afterClaim(()=>{
    const hash=require("node:crypto").createHash("sha256").update(active.planKey).digest("hex");
    t.data.shopReminderCancellations={"2026-09-27":{[hash]:{cancelled:true}}};
  });
  await t.tick();assert.equal(t.sent.length,0);
});
test("snoozing after a send claim suppresses that send; exiting during snooze ends reminders",async()=>{
  const {s,event}=await exitServer();
  s.afterClaim(()=>{
    const hash=require("node:crypto").createHash("sha256").update(event.snoozeKey).digest("hex");
    s.data.shopReminderSnoozes={"2026-09-27":{[hash]:{until:end+10*60000}}};
  });
  await s.tick();assert.equal(s.sent.length,0);
  s.afterClaim(null);s.data.shifts.s.clockOut=end+60000;
  s.now(end+20*60000);await s.tick();assert.equal(s.sent.length,0);
  assert.equal((await s.call("pending")).events.length,0);
});
