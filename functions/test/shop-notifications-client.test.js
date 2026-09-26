"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../shop-notifications-client.js"),"utf8");
function device(enabled=true){
  const storage=new Map(),requests=[],policies=[],foreground=[];let enableDelay=null,serverOk=true,tokens=0;
  class Channel{constructor(){this.port1={close(){}};this.port2={postMessage:data=>{this.port1.onmessage?.({data});}};}}
  const reg={active:{postMessage(data,ports){if(data.type==="SHOP_NOTIFICATION_POLICY"){policies.push(data);ports[0].postMessage({ok:true});}else foreground.push(data);}},update:async()=>{}};
  const ctx={auth:{currentUser:{uid:"manager",getIdToken:async()=>"auth"}},Notification:{permission:"granted"},
    messaging:{getToken:async()=>{tokens++;return "shop-phone-token";}},VAPID_KEY:"key",
    shopNotificationsEnabled:()=>enabled,renderShopNotificationTest(){},setTimeout,clearTimeout,AbortController,MessageChannel:Channel,
    crypto:{randomUUID:()=>"10000000-1000-4000-8000-100000000001"},
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    navigator:{serviceWorker:{register:async()=>reg,ready:Promise.resolve(reg),getRegistration:async()=>reg}},
    fetch:async(url,options)=>{const data=JSON.parse(options.body).data;requests.push(data);if(data.action==="enable"&&enableDelay)await enableDelay;return {ok:serverOk,json:async()=>serverOk?{result:{enabled:data.action==="enable"}}:{error:{message:"Server not deployed"}}};},
    document:{addEventListener(){}},addEventListener(){}
  };ctx.window=ctx;vm.runInNewContext(source,ctx);
  return {ctx,api:ctx.ShopNotifications,requests,policies,foreground,tokens:()=>tokens,enabled:v=>{enabled=v;},delay:p=>{enableDelay=p;},serverOk:v=>{serverOk=v;}};
}
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
