"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../firebase-messaging-sw.js"),"utf8");
function worker(){
  const listeners={},notices=[],stored=new Map();let background,delay=null;
  const scope="https://asafkiri.github.io/Works/";
  const self={registration:{scope,
    async showNotification(title,options){if(delay)await delay;notices.push({title,...options,closed:false,close(){this.closed=true;}});},
    async getNotifications(){return notices;}
  },addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const context={self,URL,Response,Date,importScripts(){},firebase:{initializeApp(){},messaging:()=>({onBackgroundMessage:fn=>{background=fn;}})},
    caches:{open:async()=>({match:async key=>stored.get(key)?.clone(),put:async(key,value)=>{stored.set(key,value);}})}};
  vm.runInNewContext(source,context);
  async function message(data,url=scope){let pending;const ack=[];listeners.message({source:{url},data,ports:[{postMessage:v=>ack.push(v)}],waitUntil:p=>{pending=p;}});await pending;return ack;}
  const payload={audience:"shop",deviceId:"this-device",expiresAt:String(Date.now()+60000),title:"דני — יציאה",tag:"same-employee",kind:"out"};
  return {notices,payload,message,background:data=>background({data}),delay:p=>{delay=p;}};
}
test("background push is silent until this device opts in and rejects another or expired device payload",async()=>{
  const w=worker();await w.background(w.payload);assert.equal(w.notices.length,0);
  await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.background({...w.payload,deviceId:"other"});await w.background({...w.payload,expiresAt:"1"});assert.equal(w.notices.length,0);
  await w.background(w.payload);assert.equal(w.notices.length,1);
  assert.equal(w.notices[0].renotify,true);assert.equal(w.notices[0].silent,false);
});
test("foreground delivery uses the same local gate and unrelated clients cannot enable it",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"},"https://other.example/");
  await w.message({type:"SHOW_SHOP_REMINDER",data:w.payload});assert.equal(w.notices.length,0);
  await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.message({type:"SHOW_SHOP_REMINDER",data:w.payload});assert.equal(w.notices.length,1);
});
test("opting out closes an in-flight reminder and prevents late queued background delivery",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  let release;w.delay(new Promise(r=>{release=r;}));
  const displaying=w.background(w.payload);
  const disabling=w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"});
  const late=w.background(w.payload);release();await Promise.all([displaying,disabling,late]);
  assert.equal(w.notices.length,1);assert.equal(w.notices[0].closed,true);
});
test("snooze closes only this shift's notice and suppresses late delivery for it",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.background({...w.payload,snoozeKey:"first"});await w.background({...w.payload,snoozeKey:"other"});
  await w.message({type:"SHOP_REMINDER_SNOOZED",snoozeKey:"first",until:Date.now()+600000});
  assert.equal(w.notices[0].closed,true);assert.equal(w.notices[1].closed,false);
  await w.background({...w.payload,snoozeKey:"first"});assert.equal(w.notices.length,2);
  await w.background({...w.payload,snoozeKey:"next-shift"});assert.equal(w.notices.length,3);
});
