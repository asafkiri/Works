/* Store-phone push registration. No database rules or employee data are changed here. */
(function(){
  let inflight=null,again=false,lastSync=0,state="off",error="",generation=0;
  let retryTimer=null,retryDelay=15000,lastHeal=0;
  const endpoint="https://europe-west1-mini-market-shalom.cloudfunctions.net/setShopNotificationDevice";
  const key=uid=>"worksShopDevice:"+uid;
  function uid(){return auth && auth.currentUser && auth.currentUser.uid;}
  // A registration step that never settles must not freeze renewal for the page's lifetime.
  function withTimeout(promise,ms,message){
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
  }
  // Server time minus this phone's clock, from Realtime Database. The worker uses
  // it to judge reminder freshness even when the phone clock is off.
  async function serverOffset(){
    try{
      if(typeof db==="undefined" || !db)return 0;
      const value=Number((await withTimeout(db.ref(".info/serverTimeOffset").once("value"),3000,"offset")).val());
      return Number.isFinite(value) && Math.abs(value)<86400000 ? value : 0;
    }catch(e){return 0;}
  }
  function deviceId(create){
    const user=uid();if(!user)return null;
    let id=localStorage.getItem(key(user));
    if(!id && create){
      id=crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c/4).toString(16));
      localStorage.setItem(key(user),id);
    }
    return id;
  }
  async function call(action,id,token,user=auth && auth.currentUser,extra={}){
    if(!user)throw Error("יש להתחבר מחדש כמנהל.");
    const bearer=await user.getIdToken();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+bearer},body:JSON.stringify({data:{...extra,action,deviceId:id,...(token?{token}:{})}}),signal:controller.signal});
      let body;try{body=await response.json();}catch(e){}
      if(!response.ok || body?.error){
        const failure=Error(body?.error?.message || "שרת תזכורות החנות עדיין אינו זמין. יש לפרסם את עדכון השרת ולנסות שוב.");
        failure.status=body?.error?.status;throw failure;
      }
      return body.result || body.data || {};
    }catch(e){
      if(e.name==="TypeError" || e.name==="AbortError")throw Error("לא ניתן להתחבר לשרת התזכורות. בדוק חיבור לאינטרנט; אם הבעיה נמשכת, יש לפרסם את עדכון השרת.");
      throw e;
    }finally{clearTimeout(timer);}
  }
  async function updateWorker(reg){
    await reg.update();
    const next=reg.installing || reg.waiting;
    if(!next || next.state==="activated")return;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error("עדכון ההתראות מתעכב. רענן ונסה שוב.")),12000);
      function finish(error){clearTimeout(timer);next.removeEventListener("statechange",changed);error?reject(error):resolve();}
      function changed(){if(next.state==="activated")finish();else if(next.state==="redundant")finish(Error("עדכון ההתראות נכשל. רענן ונסה שוב."));}
      next.addEventListener("statechange",changed);changed();
    });
  }
  function worker(){
    // register() queues behind any stalled update job of the same scope; bound it too.
    return withTimeout(navigator.serviceWorker.register("firebase-messaging-sw.js").then(()=>navigator.serviceWorker.ready),12000,"לא ניתן להכין התראות. רענן ונסה שוב.");
  }
  async function policy(enabled,id,reg,offset=0){
    reg=reg || await navigator.serviceWorker.getRegistration("firebase-messaging-sw.js");
    if(!reg?.active){if(enabled)throw Error("יש לרענן את האפליקציה כדי לעדכן את ההתראות.");return;}
    return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();reject(Error("יש לרענן את האפליקציה כדי לעדכן את ההתראות."));},4000);
      channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve():reject(Error("הגדרת ההתראות לא נשמרה במכשיר."));};
      reg.active.postMessage({type:"SHOP_NOTIFICATION_POLICY",enabled,deviceId:id,offset},[channel.port2]);
    });
  }
  async function stop(){
    ++generation;state="off";
    clearTimeout(retryTimer);retryTimer=null;retryDelay=15000;
    window.ShopSnooze?.clear();
    const user=auth && auth.currentUser,id=deviceId(false);
    // Local suppression and server deregistration must each run even if the
    // other fails (for example, when the phone is currently offline).
    const results=await Promise.allSettled([
      "serviceWorker" in navigator ? policy(false,id) : Promise.resolve(),
      id && user ? call("disable",id,undefined,user) : Promise.resolve()
    ]);
    const failed=results.find(r=>r.status==="rejected");
    if(failed)throw failed.reason;
  }
  async function performSync(renewing){
    const user=auth && auth.currentUser,version=generation;
    if(!shopNotificationsEnabled()){
      await stop();return false;
    }
    if(!user)return false;
    const stillEnabled=()=>version===generation && user.uid===uid() && shopNotificationsEnabled();
    if(!messaging || Notification.permission!=="granted")throw Error("צריך לאפשר התראות בטלפון ולבחור שוב ״עם התראות״.");
    // Renewing a working registration keeps it usable (snooze/cancel stay available).
    if(!renewing){state="pending";error="";renderShopNotificationTest();}
    const id=deviceId(true),reg=await worker();
    // Prefer the newest worker, but a failed update check (offline, slow
    // network) must not block renewing a registration the active worker serves.
    await withTimeout(updateWorker(reg),15000,"worker-update").catch(()=>{});
    // Renewal must not disable the last working registration. A temporary FCM
    // or network error would otherwise mute foreground AND background pushes
    // indefinitely. New devices remain off until their first server opt-in.
    if(!stillEnabled())return false;
    const token=await withTimeout(messaging.getToken({vapidKey:VAPID_KEY,serviceWorkerRegistration:reg}),30000,"קבלת מזהה ההתראות מתעכבת. ננסה שוב אוטומטית.");
    if(!token)throw Error("לא התקבל מזהה התראות. נסה שוב.");
    if(!stillEnabled())return false;
    await call("enable",id,token,user);
    if(!stillEnabled()){await policy(false,id,reg);await call("disable",id,undefined,user);return false;}
    await policy(true,id,reg,await serverOffset());
    if(!stillEnabled()){await policy(false,id,reg);await call("disable",id,undefined,user);return false;}
    state="active";return true;
  }
  function retry(version){
    if(version!==generation || !shopNotificationsEnabled() || !messaging || Notification.permission!=="granted")return;
    clearTimeout(retryTimer);
    const delay=retryDelay;retryDelay=Math.min(retryDelay*2,60000);
    retryTimer=setTimeout(()=>{
      retryTimer=null;
      if(version!==generation || !shopNotificationsEnabled())return;
      if(navigator.onLine===false){retry(version);return;}
      sync(true);
    },delay);
  }
  function sync(force){
    if(inflight){again=true;return inflight;}
    if(!force && Date.now()-lastSync<60000)return Promise.resolve(state==="active");
    lastSync=Date.now();
    clearTimeout(retryTimer);retryTimer=null;
    const version=generation,renewing=state==="active";
    inflight=performSync(renewing).then(connected=>{if(connected)retryDelay=15000;return connected;}).catch(e=>{
      if(version!==generation)return false;
      // A failed renewal leaves the previous token and worker policy in place, so
      // the phone keeps receiving; recovery retries in the background.
      state=shopNotificationsEnabled()?(renewing?"active":"error"):"off";error=e.message||"לא הצלחנו להתחבר לשרת ההתראות.";
      retry(version);return false;
    }).finally(()=>{
      inflight=null;renderShopNotificationTest();window.ShopSnooze?.refresh();if(again){again=false;sync(true);}
    });
    return inflight;
  }
  async function receive(data){
    if(!shopNotificationsEnabled() || data.deviceId!==deviceId(false))return;
    window.ShopSnooze?.refresh(true);
    const reg=await navigator.serviceWorker.ready;
    reg.active?.postMessage({type:"SHOW_SHOP_REMINDER",data});
  }
  async function test(){
    if(!shopNotificationsEnabled())return;
    if(!await sync(true))throw Error(error||"התראות החנות עדיין לא מחוברות לשרת.");
    await call("test",deviceId(false));
  }
  async function pending(){
    if(!shopNotificationsEnabled() || state!=="active")return {events:[]};
    const version=generation;
    try{return await call("pending",deviceId(false));}
    catch(e){
      // The server no longer has this phone enabled (for example after its push
      // token died) while the phone still believes it is connected: re-register.
      // Never after this page itself opted out or logged out meanwhile.
      if(e.status==="FAILED_PRECONDITION" && version===generation && state==="active" && shopNotificationsEnabled() && Date.now()-lastHeal>120000){lastHeal=Date.now();sync(true);}
      throw e;
    }
  }
  async function snooze(event,minutes){
    if(!shopNotificationsEnabled() || state!=="active")throw Error("יש להפעיל התראות בטלפון החנות.");
    const result=await call("snooze",deviceId(false),undefined,auth.currentUser,{eventKey:event.eventKey,snoozeKey:event.snoozeKey,minutes});
    // Dismiss notices already visible on this phone after successful server save.
    const reg=await navigator.serviceWorker.getRegistration("firebase-messaging-sw.js").catch(()=>null);
    reg?.active?.postMessage({type:"SHOP_REMINDER_SNOOZED",snoozeKey:event.snoozeKey,until:result.until});
    return result;
  }
  async function cancel(event){
    if(!shopNotificationsEnabled() || state!=="active")throw Error("יש להפעיל התראות בטלפון החנות.");
    const result=await call("cancel",deviceId(false),undefined,auth.currentUser,{eventKey:event.eventKey,snoozeKey:event.snoozeKey});
    const reg=await navigator.serviceWorker.getRegistration("firebase-messaging-sw.js").catch(()=>null);
    reg?.active?.postMessage({type:"SHOP_REMINDER_CANCELLED",planKey:result.planKey,until:result.until});
    return result;
  }
  window.ShopNotifications={sync,stop,receive,test,pending,snooze,cancel,getState:()=>state,getError:()=>error};
  function refreshWhenReady(force){
    // Auth and manager-role lookup finish asynchronously on page load. An
    // early lifecycle event must not mistake loading for an explicit opt-out.
    // Logout, role changes and device-mode changes already call stop/sync.
    if(!uid() || typeof currentRole==="undefined" || currentRole===null)return;
    sync(force);
  }
  window.addEventListener("online",()=>refreshWhenReady(true));
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refreshWhenReady(state==="error");});
  // Other apps on this origin write their own localStorage keys constantly;
  // only this app's opt-in, device id, device mode or a full clear matter here.
  window.addEventListener("storage",event=>{
    const changed=event && event.key;
    if(changed===null || changed===undefined || changed==="deviceMode" || /^worksShop(Notifications|Device):/.test(changed))refreshWhenReady(true);
  });
  // A kiosk that stays on screen never fires visibilitychange. Renew regularly so
  // a token that died or a worker policy that was lost is repaired within minutes.
  setInterval(()=>{if(shopNotificationsEnabled())refreshWhenReady(false);},15*60000);
  if(navigator.serviceWorker && navigator.serviceWorker.addEventListener)
    navigator.serviceWorker.addEventListener("message",event=>{if(event.data?.type==="SHOP_REMINDER_SHOWN")window.ShopSnooze?.refresh(true);});
})();
