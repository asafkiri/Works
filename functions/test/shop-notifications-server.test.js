"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../shop-notifications.js"),"utf8");
const DEVICE="10000000-1000-4000-8000-100000000001";
const TOKEN="only-the-shop-phone-token";
const start=Date.parse("2026-09-27T08:00:00+03:00");
function server(){
  let now=start,sendError=null,afterClaim=null;
  const data={config:{managerUid:"manager"},employees:{a:{name:"דני"}},oneTimeShifts:{p:{employeeId:"a",date:"2026-09-27",startTime:"08:00",endTime:"16:00"}},shifts:{}};
  const sent=[];
  const clone=v=>v===undefined?null:structuredClone(v);
  function read(p){return p.split("/").filter(Boolean).reduce((o,k)=>o?.[k],data);}
  function write(p,v){const keys=p.split("/").filter(Boolean),last=keys.pop();let target=data;for(const k of keys)target=target[k]??={};if(v===null)delete target[last];else target[last]=clone(v);}
  const db={ref(p=""){return {
    async get(){return {val:()=>clone(read(p))};},
    async set(v){write(p,v);},async remove(){write(p,null);},
    async update(v){for(const [k,value]of Object.entries(v))write([p,k].filter(Boolean).join("/"),value);},
    async transaction(fn){const result=fn(clone(read(p)));if(result===undefined)return {committed:false};write(p,result);if(result?.claimId&&afterClaim)afterClaim();return {committed:true};}
  };}};
  class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
  const context={exports:{},Date:class extends Date{static now(){return now;}},require(name){
    if(name==="firebase-admin/database")return {getDatabase:()=>db};
    if(name==="firebase-admin/messaging")return {getMessaging:()=>({send:async message=>{if(sendError)throw sendError;sent.push(clone(message));return "ok";}})};
    if(name==="firebase-functions/v2/https")return {onCall:(_,fn)=>fn,HttpsError};
    if(name==="firebase-functions/v2/scheduler")return {onSchedule:(_,fn)=>fn};
    if(name==="firebase-functions/logger")return {warn(){},info(){}};
    if(name.startsWith("./"))return require("../"+name.slice(2));return require(name);
  }};
  vm.runInNewContext(source,context);
  const call=(action,uid="manager",extra={})=>context.exports.setShopNotificationDevice({auth:uid?{uid}:undefined,data:{action,deviceId:DEVICE,token:TOKEN,...extra}});
  return {data,sent,call,tick:context.exports.sendShopShiftReminders,now:v=>{now=v;},fail:v=>{sendError=v;},afterClaim:fn=>{afterClaim=fn;}};
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
test("failed sends do not retry every minute; invalid tokens are deactivated",async()=>{
  const s=server();await s.call("enable");s.fail(Object.assign(Error("temporary"),{code:"messaging/server-unavailable"}));
  await s.tick();s.fail(null);s.now(start+60000);await s.tick();assert.equal(s.sent.length,0);
  s.now(start+5*60000);await s.tick();assert.equal(s.sent.length,1);
  s.now(start+10*60000);s.fail(Object.assign(Error("gone"),{code:"messaging/registration-token-not-registered"}));
  await s.tick();assert.equal(s.data.shopNotificationDevices[DEVICE].enabled,false);
});
test("server test targets this device, requires opt-in and is rate limited",async()=>{
  const s=server();await assert.rejects(s.call("test"),{code:"failed-precondition"});
  await s.call("enable");await s.call("test");assert.equal(s.sent.length,1);assert.equal(s.sent[0].data.kind,"test");
  await assert.rejects(s.call("test"),{code:"resource-exhausted"});
  await s.call("disable");s.now(start+10*60000);await s.tick();assert.equal(s.sent.length,1);
});
