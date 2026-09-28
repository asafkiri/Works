"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../shop-notifications-client.js"),"utf8");
function device(enabled=true){
  const storage=new Map(),requests=[],policies=[],foreground=[],timers=new Map(),listeners={},intervals=[],swListeners=[];let enableDelay=null,serverOk=true,tokens=0,nextTimer=0,tokenError=null,localPolicy={enabled:false},clock=null,pendingFails=false,tokenHang=false,subscriptions=0;const rejected=new Set();
  class Channel{constructor(){this.port1={close(){}};this.port2={postMessage:data=>{this.port1.onmessage?.({data});}};}}
  const receipts=[],uploaded=[];
  const reg={active:{postMessage(data,ports){
    if(data.type==="SHOP_NOTIFICATION_POLICY"){policies.push(data);localPolicy=data;ports[0].postMessage({ok:true});}
    else if(data.type==="SHOP_RECEIPTS_TAKE")ports[0].postMessage({entries:receipts.slice()});
    else if(data.type==="SHOP_RECEIPTS_ACK")receipts.splice(0,receipts.length,...receipts.filter(e=>e.receivedAt>data.until));
    else foreground.push(data);
  }},update:async()=>{},pushManager:{getSubscription:async()=>subscription}};
  let subscription=null;
  const ctx={currentRole:"manager",auth:{currentUser:{uid:"manager",getIdToken:async()=>"auth"}},Notification:{permission:"granted"},
    messaging:{getToken:async()=>{tokens++;if(tokenHang)return new Promise(()=>{});if(tokenError)throw Error(tokenError);
      if(!subscription)subscription={id:++subscriptions,unsubscribe:async()=>{subscription=null;return true;}};
      return subscription.id===1?"shop-phone-token":"shop-phone-token-"+subscription.id;}},VAPID_KEY:"key",
    Date:{now:()=>clock??Date.now()},setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},
    shopNotificationsEnabled:()=>enabled,renderShopNotificationTest(){},
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),AbortController,MessageChannel:Channel,
    crypto:{randomUUID:()=>"10000000-1000-4000-8000-100000000001"},
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    navigator:{serviceWorker:{register:async()=>reg,ready:Promise.resolve(reg),getRegistration:async()=>reg,addEventListener:(name,fn)=>swListeners.push(fn)}},
    fetch:async(url,options)=>{const data=JSON.parse(options.body).data;requests.push(data);if(data.action==="enable"&&enableDelay)await enableDelay;
      if(data.action==="pending"&&pendingFails)return {ok:false,json:async()=>({error:{status:"FAILED_PRECONDITION",message:"המכשיר לא רשום להתראות חנות."}})};
      if(data.action==="report"){uploaded.push(...data.entries);return {ok:true,json:async()=>({result:{logged:data.entries.length}})};}
      if(data.action==="enable"&&rejected.has(data.token))return {ok:false,json:async()=>({error:{status:"FAILED_PRECONDITION",message:"פג",details:{reason:"token-rejected"}}})};
      return {ok:serverOk,json:async()=>serverOk?{result:{enabled:data.action==="enable",events:[]}}:{error:{message:"Server not deployed"}}};},
    document:{visibilityState:"visible",addEventListener:(name,fn)=>{listeners[name]=fn;}},addEventListener:(name,fn)=>{listeners[name]=fn;}
  };ctx.window=ctx;vm.runInNewContext(source,ctx);
  return {ctx,api:ctx.ShopNotifications,requests,policies,foreground,timers,listeners,intervals,swListeners,reg,tokens:()=>tokens,enabled:v=>{enabled=v;},delay:p=>{enableDelay=p;},serverOk:v=>{serverOk=v;},tokenError:v=>{tokenError=v;},policy:()=>localPolicy,
    clock:v=>{clock=v;},pendingFails:v=>{pendingFails=v;},tokenHang:v=>{tokenHang=v;},receipts,uploaded,reject:token=>rejected.add(token)};
}

test("a transient token or server refresh failure must not turn off a working receiver",async()=>{
  for(const failure of ["token","server"]){
    const d=device();await d.api.sync(true);const deviceId=d.policy().deviceId;
    if(failure==="token")d.tokenError("Registration failed - push service error");else d.serverOk(false);
    assert.equal(await d.api.sync(true),false);
    assert.equal(d.policy().enabled,true,"previously connected phone must still receive push");
    assert.equal(d.policy().deviceId,deviceId);
  }
});

test("routine renewal does not close or interrupt existing reminders",async()=>{
  const d=device();await d.api.sync(true);d.policies.length=0;
  let release;d.delay(new Promise(r=>{release=r;}));const renewal=d.api.sync(true);
  while(d.requests.filter(r=>r.action==="enable").length<2)await new Promise(r=>setImmediate(r));
  assert.equal(d.policy().enabled,true);
  release();await renewal;assert.ok(d.policies.every(p=>p.enabled));
});

async function runRetry(d){
  assert.equal(d.timers.size,1,"only one recovery attempt may be scheduled");
  const [id,timer]=d.timers.entries().next().value;d.timers.delete(id);timer.fn();
  for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  return timer.ms;
}
test("registration failures recover without a click, with bounded retry backoff",async()=>{
  const d=device();d.tokenError("Registration failed - push service error");
  await d.api.sync(true);assert.equal(d.policy().enabled,false);
  assert.equal(await runRetry(d),15000);assert.equal(await runRetry(d),30000);
  assert.equal(await runRetry(d),60000);
  d.tokenError(null);assert.equal(await runRetry(d),60000);
  assert.equal(d.api.getState(),"active");assert.equal(d.policy().enabled,true);assert.equal(d.timers.size,0);
});
test("opt-out cancels recovery and cannot be undone by a previously queued retry",async()=>{
  const d=device();d.tokenError("temporary");await d.api.sync(true);
  const queued=d.timers.values().next().value.fn;
  d.enabled(false);await d.api.stop();const calls=d.tokens();
  queued();await new Promise(r=>setImmediate(r));
  assert.equal(d.tokens(),calls);assert.equal(d.policy().enabled,false);assert.equal(d.timers.size,0);
});
test("background and foreground pushes remain enabled after a failed renewal until explicit opt-out",async()=>{
  const d=device();await d.api.sync(true);d.serverOk(false);await d.api.sync(true);
  const id=d.policy().deviceId;await d.api.receive({deviceId:id});
  assert.equal(d.foreground.length,1);assert.equal(d.policy().enabled,true);
  d.enabled(false);await d.api.stop().catch(()=>{});assert.equal(d.policy().enabled,false);
});
test("offline retry waits for connectivity and a denied permission never loops",async()=>{
  const d=device();d.tokenError("temporary");await d.api.sync(true);d.ctx.navigator.onLine=false;
  const calls=d.tokens();await runRetry(d);assert.equal(d.tokens(),calls);
  d.ctx.navigator.onLine=true;d.tokenError(null);d.listeners.online();
  for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
  assert.equal(d.api.getState(),"active");assert.equal(d.timers.size,0);
  const denied=device();denied.ctx.Notification.permission="denied";await denied.api.sync(true);
  assert.equal(denied.timers.size,0);assert.equal(denied.tokens(),0);
});
test("page lifecycle events during role loading must not disable a saved receiver",async()=>{
  const d=device();await d.api.sync(true);const requests=d.requests.length;
  d.ctx.currentRole=null;d.enabled(false);
  d.listeners.online();d.listeners.visibilitychange();d.listeners.storage();
  await new Promise(r=>setImmediate(r));
  assert.equal(d.requests.length,requests);assert.equal(d.policy().enabled,true);
  d.ctx.currentRole="manager";d.enabled(true);await d.api.sync(true);
  assert.equal(d.api.getState(),"active");
});
test("a failed first sync after page reload preserves the worker's earlier opt-in",async()=>{
  const previous=device();await previous.api.sync(true);
  const reloaded=device();reloaded.ctx.navigator.serviceWorker=previous.ctx.navigator.serviceWorker;
  reloaded.tokenError("Registration failed - push service error");
  await reloaded.api.sync(true);
  assert.equal(previous.policy().enabled,true);
  assert.equal(reloaded.api.getState(),"error");assert.equal(reloaded.timers.size,1);
});
test("permission without opt-in never creates a push registration",async()=>{
  const d=device(false);await d.api.sync(true);assert.equal(d.tokens(),0);assert.equal(d.requests.length,0);assert.equal(d.api.getState(),"off");
});
test("server registration must succeed before this device displays reminders",async()=>{
  const d=device();d.serverOk(false);assert.equal(await d.api.sync(true),false);
  assert.equal(d.api.getState(),"error");assert.ok(d.policies.every(p=>p.enabled===false));
  d.serverOk(true);assert.equal(await d.api.sync(true),true);assert.equal(d.api.getState(),"active");assert.equal(d.policies.at(-1).enabled,true);
});
test("opt-out and logout both beat an enable request already in flight",async()=>{
  for(const logout of [false,true]){
    const d=device();let release;d.delay(new Promise(r=>{release=r;}));
    const enabling=d.api.sync(true);
    while(!d.requests.some(r=>r.action==="enable"))await new Promise(r=>setImmediate(r));
    if(!logout)d.enabled(false);
    await d.api.stop();release();await enabling;
    assert.equal(d.api.getState(),"off");assert.equal(d.requests.at(-1).action,"disable");assert.ok(d.policies.every(p=>!p.enabled));
  }
});
test("foreground forwarding is limited to the opted-in device id",async()=>{
  const d=device();await d.api.sync(true);const deviceId=d.requests.find(r=>r.action==="enable").deviceId;
  await d.api.receive({deviceId:"other"});assert.equal(d.foreground.length,0);
  await d.api.receive({deviceId});assert.equal(d.foreground.length,1);
  d.enabled(false);await d.api.receive({deviceId});assert.equal(d.foreground.length,1);
});
test("snooze sends the exact event and duration only from an active opted-in phone",async()=>{
  const d=device();const event={eventKey:"plan-a",snoozeKey:"actual-shift-a"};
  await assert.rejects(d.api.snooze(event,20));assert.equal(d.requests.length,0);
  await d.api.sync(true);await d.api.snooze(event,20);
  const request=d.requests.at(-1);assert.equal(request.action,"snooze");assert.equal(request.minutes,20);
  assert.equal(request.eventKey,"plan-a");assert.equal(request.snoozeKey,"actual-shift-a");
  d.enabled(false);await assert.rejects(d.api.snooze(event,20));
});
test("cancel sends only this active event and updates the worker only after the server accepts",async()=>{
  const d=device(),event={eventKey:"entry-a",snoozeKey:"entry-snooze-a"};
  await assert.rejects(d.api.cancel(event));assert.equal(d.requests.length,0);
  await d.api.sync(true);d.serverOk(false);await assert.rejects(d.api.cancel(event));
  assert.equal(d.foreground.length,0);
  d.serverOk(true);await d.api.cancel(event);
  const request=d.requests.at(-1);assert.equal(request.action,"cancel");
  assert.equal(request.eventKey,event.eventKey);assert.equal(request.snoozeKey,event.snoozeKey);
  assert.equal(d.foreground.at(-1).type,"SHOP_REMINDER_CANCELLED");
  d.enabled(false);await assert.rejects(d.api.cancel(event));
});

const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
test("a failed worker update check does not block renewing the registration",async()=>{
  const d=device();d.reg.update=async()=>{throw TypeError("Failed to update a ServiceWorker");};
  assert.equal(await d.api.sync(true),true);assert.equal(d.api.getState(),"active");assert.equal(d.policy().enabled,true);
});
test("a push token request that never settles times out into the recovery loop instead of freezing renewal",{timeout:10000},async()=>{
  const d=device();d.tokenHang(true);const syncing=d.api.sync(true);
  await settle();const timeout=[...d.timers.values()].find(t=>t.ms===30000);assert.ok(timeout,"getToken must be bounded");
  timeout.fn();assert.equal(await syncing,false);assert.equal(d.api.getState(),"error");
  assert.equal(d.timers.size,1,"exactly one recovery attempt is scheduled");
  d.tokenHang(false);assert.equal(await runRetry(d),15000);assert.equal(d.api.getState(),"active");
});
test("the worker policy carries the server clock offset so freshness survives a wrong phone clock",async()=>{
  const d=device();d.ctx.db={ref:path=>({once:async()=>({val:()=>path===".info/serverTimeOffset"?-90000:null})})};
  await d.api.sync(true);assert.equal(d.policy().offset,-90000);
  const bogus=device();bogus.ctx.db={ref:()=>({once:async()=>({val:()=>"not a number"})})};
  await bogus.api.sync(true);assert.equal(bogus.policy().offset,0);
});
test("a phone the server no longer has enabled is noticed through the pending poll and re-registered",async()=>{
  const d=device();await d.api.sync(true);const enables=()=>d.requests.filter(r=>r.action==="enable").length;
  const before=enables();d.pendingFails(true);
  await assert.rejects(d.api.pending());await settle();
  assert.equal(enables(),before+1,"a failed-precondition from the server must trigger a renewal");
  await assert.rejects(d.api.pending());await settle();
  assert.equal(enables(),before+1,"renewal on this signal is rate limited");
});
test("storage writes by other apps on the origin do not trigger renewals; this app's keys still do",async()=>{
  const d=device();await d.api.sync(true);d.clock(Date.now()+120000);const count=()=>d.requests.length;
  const before=count();d.listeners.storage({key:"yotvata_order_draft"});await settle();assert.equal(count(),before);
  d.listeners.storage({key:"worksShopNotifications:manager"});await settle();assert.ok(count()>before);
  const after=count();d.listeners.storage({key:null});await settle();assert.ok(count()>after,"a full clear is relevant");
});
test("a kiosk that never changes visibility is renewed periodically, only while opted in",async()=>{
  const d=device();await d.api.sync(true);const renewal=d.intervals.find(i=>i.ms===15*60000);assert.ok(renewal);
  const enables=()=>d.requests.filter(r=>r.action==="enable").length,before=enables();
  d.clock(Date.now()+15*60000);renewal.fn();await settle();assert.equal(enables(),before+1);
  d.enabled(false);await d.api.stop();const stopped=d.requests.length;
  d.clock(Date.now()+30*60000);renewal.fn();await settle();assert.equal(d.requests.length,stopped);
});
test("a reminder shown by the worker refreshes the terminal's snooze controls",async()=>{
  const d=device();let refreshed=0;d.ctx.ShopSnooze={refresh:force=>{if(force)refreshed++;},clear(){}};
  d.swListeners.forEach(fn=>fn({data:{type:"SHOP_REMINDER_SHOWN"}}));d.swListeners.forEach(fn=>fn({data:{type:"OTHER"}}));
  assert.equal(refreshed,1);
});
test("a renewal of a working registration keeps it usable while in flight and after a transient failure",{timeout:10000},async()=>{
  const d=device();await d.api.sync(true);let release;d.delay(new Promise(r=>{release=r;}));
  const renewal=d.api.sync(true);await settle();assert.equal(d.api.getState(),"active","snooze/cancel stay available during renewal");
  release();await renewal;d.tokenError("Registration failed - push service error");
  assert.equal(await d.api.sync(true),false);assert.equal(d.api.getState(),"active");assert.equal(d.policy().enabled,true);
  assert.equal(d.timers.size,1,"recovery still retries in the background");
});
test("the heal never re-enables a phone that opted out or logged out while its pending poll was in flight",async()=>{
  const d=device();await d.api.sync(true);d.pendingFails(true);const enables=()=>d.requests.filter(r=>r.action==="enable").length,before=enables();
  const polling=d.api.pending();await d.api.stop();
  await assert.rejects(polling);await settle();assert.equal(enables(),before);assert.equal(d.requests.at(-1).action,"disable");
});
test("a service worker registration that never settles is bounded like the rest of renewal",{timeout:10000},async()=>{
  const d=device();d.ctx.navigator.serviceWorker.register=()=>new Promise(()=>{});
  const syncing=d.api.sync(true);await settle();const timeout=[...d.timers.values()].find(t=>t.ms===12000);assert.ok(timeout);
  timeout.fn();assert.equal(await syncing,false);assert.equal(d.api.getState(),"error");
});
test("a token the server reports as rejected is replaced by a new push subscription and token",async()=>{
  const d=device();await d.api.sync(true);assert.equal(d.requests.at(-1).token,"shop-phone-token");
  d.reject("shop-phone-token");d.clock(Date.now()+120000);
  assert.equal(await d.api.sync(true),true);assert.equal(d.api.getState(),"active");
  const enables=d.requests.filter(r=>r.action==="enable");assert.equal(enables.at(-1).token,"shop-phone-token-2");
  assert.equal(d.policy().enabled,true);
});
test("the worker's receipt log is uploaded after a successful registration and then acknowledged",async()=>{
  const d=device();d.receipts.push({outcome:"shown",ref:"r1",employeeId:"a",kind:"in",sentAt:1,receivedAt:10},{outcome:"expired",ref:"r2",employeeId:"a",kind:"in",sentAt:2,receivedAt:20});
  await d.api.sync(true);await settle();
  assert.deepEqual(d.uploaded.map(e=>e.ref),["r1","r2"]);assert.equal(d.receipts.length,0);
  assert.equal([...d.timers.values()].length,0,"no receipt timer left behind");
});
test("the policy offset comes from the server time returned by enable when available",async()=>{
  const d=device();const serverAhead=90000;
  d.ctx.fetch=(orig=>async(url,options)=>{const r=await orig(url,options);const data=JSON.parse(options.body).data;
    if(data.action!=="enable")return r;const body=await r.json();body.result.serverTime=Date.now()+serverAhead;return {ok:true,json:async()=>body};})(d.ctx.fetch);
  await d.api.sync(true);assert.ok(Math.abs(d.policy().offset-serverAhead)<1000);
});
test("a punch on the terminal closes that reminder on the worker and hides its controls immediately",async()=>{
  const d=device();let hidden=null;d.ctx.ShopSnooze={resolved:(e,k)=>{hidden=[e,k];},refresh(){},clear(){}};
  await d.api.sync(true);await d.api.resolved("a","in");
  assert.deepEqual(hidden,["a","in"]);assert.deepEqual(JSON.parse(JSON.stringify(d.foreground.at(-1))),{type:"SHOP_REMINDER_RESOLVED",employeeId:"a",kind:"in"});
  d.enabled(false);const before=d.foreground.length;await d.api.resolved("a","out");assert.equal(d.foreground.length,before);
});
test("a failed recovery after the server rejected the token is shown as an error, not as connected",async()=>{
  const d=device();await d.api.sync(true);d.reject("shop-phone-token");d.clock(Date.now()+120000);
  const original=d.ctx.messaging.getToken;let calls=0;
  d.ctx.messaging.getToken=async(...args)=>{calls++;if(calls>1)throw Error("Registration failed - push service error");return original(...args);};
  assert.equal(await d.api.sync(true),false);assert.equal(d.api.getState(),"error");assert.match(d.api.getError(),/push service error/);
  assert.equal(d.timers.size,1,"recovery keeps retrying in the background");
});
