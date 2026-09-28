"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../firebase-messaging-sw.js"),"utf8");
// Minimal asynchronous IndexedDB: one database, one object store, get/put.
// Minimal asynchronous IndexedDB: one database, one object store, get/put/add.
// Knobs: hideNextGet (a read that races a write), closeNext (the browser closed
// the connection), failWrites (storage errors).
function fakeIndexedDB(){
  const data=new Map(),knobs={hideNextGet:false,closeNext:false,failWrites:false,opens:0};let created=false;
  const later=fn=>setImmediate(fn);
  function transaction(){
    if(knobs.closeNext){knobs.closeNext=false;const e=Error("The database connection is closing.");e.name="InvalidStateError";throw e;}
    const tx={};let pending=0,failed=false;
    const done=()=>{if(--pending===0&&!failed)later(()=>tx.oncomplete?.());};
    const op=run=>{pending++;const request={};later(()=>{
      try{request.result=run();request.onsuccess?.();done();}
      catch(error){failed=true;request.error=error;tx.error=error;tx.onerror?.();}
    });return request;};
    const write=fn=>()=>{if(knobs.failWrites)throw Error("QuotaExceededError");return fn();};
    tx.objectStore=()=>({
      get:key=>op(()=>{if(knobs.hideNextGet){knobs.hideNextGet=false;return undefined;}return data.has(key)?structuredClone(data.get(key)):undefined;}),
      put:(value,key)=>op(write(()=>{data.set(key,structuredClone(value));return key;})),
      add:(value,key)=>op(write(()=>{if(data.has(key)){const e=Error("Key already exists");e.name="ConstraintError";throw e;}data.set(key,structuredClone(value));return key;}))
    });
    return tx;
  }
  return {data,knobs,open(){
    const request={};knobs.opens++;
    later(()=>{const db={transaction,close(){},createObjectStore(){}};request.result=db;if(!created){created=true;request.onupgradeneeded?.();}request.onsuccess?.();});
    return request;
  }};
}
function worker(){
  const listeners={},notices=[],stored=new Map(),timers=[],windows=[],firebaseSaw=[];let background,delay=null;
  const scope="https://asafkiri.github.io/Works/";
  const self={registration:{scope,
    async showNotification(title,options){if(delay)await delay;notices.push({title,...options,closed:false,close(){this.closed=true;}});},
    async getNotifications(){return notices;}
  },clients:{matchAll:async()=>windows},addEventListener:(name,fn)=>{(listeners[name]||=[]).push(fn);}};
  const indexedDB=fakeIndexedDB();
  const context={self,URL,Response,Date,indexedDB,importScripts(){},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},
    firebase:{initializeApp(){},messaging:()=>{self.addEventListener("push",event=>{firebaseSaw.push(event);});return {onBackgroundMessage:fn=>{background=fn;}};}},
    caches:{open:async()=>({match:async key=>stored.get(key)?.clone(),put:async(key,value)=>{stored.set(key,value);},delete:async key=>stored.delete(key)})}};
  vm.runInNewContext(source,context);
  async function message(data,url=scope){let pending;const ack=[];listeners.message[0]({source:{url},data,ports:[{postMessage:v=>ack.push(v)}],waitUntil:p=>{pending=p;}});await pending;return ack;}
  // Dispatches a real push event through every listener, as the browser does.
  async function push(json){
    const event={data:{json:()=>json},stopped:false,waited:null,stopImmediatePropagation(){this.stopped=true;},waitUntil(p){this.waited=p;}};
    for(const fn of listeners.push||[]){fn(event);if(event.stopped)break;}
    await event.waited;return event;
  }
  const payload={audience:"shop",deviceId:"this-device",expiresAt:String(Date.now()+60000),title:"דני — יציאה",tag:"same-employee",kind:"out"};
  return {notices,payload,message,push,listeners,stored,indexedDB,timers,windows,firebaseSaw,background:data=>background({data}),delay:p=>{delay=p;}};
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
test("opting out closes an in-flight reminder and prevents late queued background delivery",{timeout:10000},async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  let release;w.delay(new Promise(r=>{release=r;}));
  const displaying=w.background(w.payload);
  const disabling=w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"});
  const late=w.background(w.payload);release();await Promise.all([displaying,disabling,late]);
  // Nothing may remain visible: the racing display is either never shown or closed.
  assert.ok(w.notices.length<=1);assert.ok(w.notices.every(n=>n.closed));
});
test("snooze closes only this shift's notice and suppresses late delivery for it",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.background({...w.payload,snoozeKey:"first"});await w.background({...w.payload,snoozeKey:"other"});
  await w.message({type:"SHOP_REMINDER_SNOOZED",snoozeKey:"first",until:Date.now()+600000});
  assert.equal(w.notices[0].closed,true);assert.equal(w.notices[1].closed,false);
  await w.background({...w.payload,snoozeKey:"first"});assert.equal(w.notices.length,2);
  await w.background({...w.payload,snoozeKey:"next-shift"});assert.equal(w.notices.length,3);
});
test("plan cancellation closes both kinds and blocks late entry/exit notices while other plans still display",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.background({...w.payload,planKey:"first",kind:"in",snoozeKey:"entry-first"});
  await w.background({...w.payload,planKey:"first",kind:"out",snoozeKey:"exit-first"});
  await w.background({...w.payload,planKey:"other",snoozeKey:"exit-other"});
  await w.message({type:"SHOP_REMINDER_CANCELLED",planKey:"first",until:Date.now()+48*3600000});
  assert.equal(w.notices[0].closed,true);assert.equal(w.notices[1].closed,true);assert.equal(w.notices[2].closed,false);
  for(const kind of ["in","out"])await w.background({...w.payload,planKey:"first",kind,snoozeKey:"new-key"});
  assert.equal(w.notices.length,3);
  await w.background({...w.payload,planKey:"next",kind:"in",snoozeKey:"entry-next"});assert.equal(w.notices.length,4);
});
test("another app on the origin deleting every cache no longer mutes reminders or undoes a snooze",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.message({type:"SHOP_REMINDER_SNOOZED",snoozeKey:"snoozed",until:Date.now()+600000});
  w.stored.clear(); // what yotvata-app's service worker does to every cache but its own on update
  await w.push({data:w.payload});assert.equal(w.notices.length,1);
  await w.push({data:{...w.payload,snoozeKey:"snoozed"}});assert.equal(w.notices.length,1);
});
test("a v79 policy kept only in Cache Storage is honored once and migrated, and never overrides a newer opt-out",async()=>{
  const w=worker();
  w.stored.set("https://asafkiri.github.io/Works/__shop_notification_policy",new Response(JSON.stringify({enabled:true,deviceId:"this-device"})));
  await w.push({data:w.payload});assert.equal(w.notices.length,1);
  assert.equal(w.indexedDB.data.get("policy").enabled,true);assert.equal(w.stored.size,0);
  await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"});
  w.stored.set("https://asafkiri.github.io/Works/__shop_notification_policy",new Response(JSON.stringify({enabled:true,deviceId:"this-device"})));
  await w.push({data:w.payload});assert.equal(w.notices.length,1);
});
test("the worker displays shop pushes itself, keeps the push event alive until shown, and bypasses Firebase routing",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  // A visible page of ANOTHER app on the origin: Firebase would hand the push to it.
  w.windows.push({url:"https://asafkiri.github.io/yotvata-app/",visibilityState:"visible",postMessage(){throw Error("must not be routed to other apps");}});
  const seen=[];w.windows.push({url:"https://asafkiri.github.io/Works/",visibilityState:"hidden",postMessage:m=>seen.push(m)});
  assert.equal(w.listeners.push.length,2,"the worker's listener and then Firebase's");
  const event=await w.push({data:w.payload});
  assert.equal(event.stopped,true);assert.equal(w.firebaseSaw.length,0,"Firebase must not route shop pushes");assert.equal(w.notices.length,1);
  assert.equal(JSON.stringify(seen),JSON.stringify([{type:"SHOP_REMINDER_SHOWN"}]));
  const other=await w.push({notification:{title:"תלוש חדש"},data:{kind:"payslip"}});
  assert.equal(other.stopped,false);assert.equal(other.waited,null);assert.equal(w.firebaseSaw.length,1,"other pushes still reach Firebase");
});
test("freshness uses server time: a phone clock 90 s ahead still shows a fresh reminder and still drops a stale one",async()=>{
  const w=worker(),serverNow=Date.now()-90000;
  await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device",offset:-90000});
  await w.push({data:{...w.payload,expiresAt:String(serverNow+60000)}});assert.equal(w.notices.length,1);
  await w.push({data:{...w.payload,expiresAt:String(serverNow-1000)}});assert.equal(w.notices.length,1);
  const uncorrected=worker();await uncorrected.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await uncorrected.push({data:{...uncorrected.payload,expiresAt:String(serverNow+60000)}});assert.equal(uncorrected.notices.length,0);
});
test("a display task that never settles cannot block later reminders, and a late display after opt-out is closed",{timeout:10000},async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  let release;w.delay(new Promise(r=>{release=r;}));
  const hung=w.push({data:{...w.payload,tag:"hung"}});
  while(!w.timers.some(t=>t.ms===15000&&!t.cleared))await new Promise(r=>setImmediate(r));
  const disabling=w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"});
  w.timers.find(t=>t.ms===15000&&!t.cleared).fn(); // the queue timeout fires
  await disabling;release();await hung;
  for(let i=0;i<20 && !w.notices[0]?.closed;i++)await new Promise(r=>setImmediate(r));
  assert.equal(w.notices.length,1);assert.equal(w.notices[0].closed,true,"a display finishing after opt-out must be closed");
  w.delay(null);await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.push({data:{...w.payload,tag:"next"}});assert.equal(w.notices.length,2);assert.equal(w.notices[1].closed,false);
});
test("a stale clock offset (phone clock corrected later) never mutes fresh reminders",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device",offset:180000});
  await w.push({data:{...w.payload,expiresAt:String(Date.now()+60000)}});assert.equal(w.notices.length,1);
  await w.push({data:{...w.payload,expiresAt:String(Date.now()-1000)}});assert.equal(w.notices.length,1,"expired by both clocks is still dropped");
});
test("a local snooze holds only while both clocks agree; the server already stops sending during a snooze",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device",offset:180000});
  await w.message({type:"SHOP_REMINDER_SNOOZED",snoozeKey:"late",until:Date.now()+120000});
  await w.push({data:{...w.payload,snoozeKey:"late"}});assert.equal(w.notices.length,1,"past the snooze by server time");
  await w.message({type:"SHOP_REMINDER_SNOOZED",snoozeKey:"held",until:Date.now()+600000});
  await w.push({data:{...w.payload,snoozeKey:"held"}});assert.equal(w.notices.length,1);
});
test("the push event lives until the notification is shown even when the display outlasts the queue timeout",{timeout:10000},async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  let release;w.delay(new Promise(r=>{release=r;}));
  const event={data:{json:()=>({data:w.payload})},stopped:false,waited:null,stopImmediatePropagation(){this.stopped=true;},waitUntil(p){this.waited=p;}};
  w.listeners.push[0](event);let ended=false;event.waited.then(()=>{ended=true;});
  for(let i=0;i<50 && !w.timers.some(t=>t.ms===15000&&!t.cleared);i++)await new Promise(r=>setImmediate(r));
  w.timers.find(t=>t.ms===15000&&!t.cleared).fn();for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
  assert.equal(ended,false,"the queue timeout must not end the push event");
  assert.ok(w.timers.some(t=>t.ms===90000),"the push event itself is bounded");
  release();await event.waited;assert.equal(w.notices.length,1);
});
test("the v79 migration never overwrites an opt-out written meanwhile",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"});
  w.stored.set("https://asafkiri.github.io/Works/__shop_notification_policy",new Response(JSON.stringify({enabled:true,deviceId:"this-device"})));
  w.indexedDB.knobs.hideNextGet=true; // the display's read raced the opt-out's write
  await w.push({data:w.payload});assert.equal(w.notices.length,0);assert.equal(w.indexedDB.data.get("policy").enabled,false);
});
test("a closed database connection is reopened instead of failing every later read and write",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  w.indexedDB.knobs.closeNext=true;await w.push({data:w.payload});assert.equal(w.notices.length,1);
  w.indexedDB.knobs.closeNext=true;assert.equal(JSON.stringify(await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"})),JSON.stringify([{ok:true}]));
});
test("an opt-out closes visible reminders and blocks later ones even when storage fails",async()=>{
  const w=worker();await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:true,deviceId:"this-device"});
  await w.push({data:w.payload});assert.equal(w.notices.length,1);
  w.indexedDB.knobs.failWrites=true;
  assert.equal(JSON.stringify(await w.message({type:"SHOP_NOTIFICATION_POLICY",enabled:false,deviceId:"this-device"})),JSON.stringify([{ok:false}]));
  assert.equal(w.notices[0].closed,true);
  await w.push({data:w.payload});assert.equal(w.notices.length,1);
});
