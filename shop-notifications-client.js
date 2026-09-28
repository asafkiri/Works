/* Store-phone push registration. No database rules or employee data are changed here. */
(function(){
  let inflight=null,again=false,lastSync=0,state="off",error="",generation=0;
  let retryTimer=null,retryDelay=15000;
  const endpoint="https://europe-west1-mini-market-shalom.cloudfunctions.net/setShopNotificationDevice";
  const key=uid=>"worksShopDevice:"+uid;
  function uid(){return auth && auth.currentUser && auth.currentUser.uid;}
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
      if(!response.ok || body?.error)throw Error(body?.error?.message || "שרת תזכורות החנות עדיין אינו זמין. יש לפרסם את עדכון השרת ולנסות שוב.");
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
  async function worker(){
    await navigator.serviceWorker.register("firebase-messaging-sw.js");
    let timer;
    try{return await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("לא ניתן להכין התראות. רענן ונסה שוב.")),12000);})]);}
    finally{clearTimeout(timer);}
  }
  async function policy(enabled,id,reg){
    reg=reg || await navigator.serviceWorker.getRegistration("firebase-messaging-sw.js");
    if(!reg?.active){if(enabled)throw Error("יש לרענן את האפליקציה כדי לעדכן את ההתראות.");return;}
    return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();reject(Error("יש לרענן את האפליקציה כדי לעדכן את ההתראות."));},4000);
      channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.ok?resolve():reject(Error("הגדרת ההתראות לא נשמרה במכשיר."));};
      reg.active.postMessage({type:"SHOP_NOTIFICATION_POLICY",enabled,deviceId:id},[channel.port2]);
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
  async function performSync(){
    const user=auth && auth.currentUser,version=generation;
    if(!shopNotificationsEnabled()){
      await stop();return false;
    }
    if(!user)return false;
    const stillEnabled=()=>version===generation && user.uid===uid() && shopNotificationsEnabled();
    if(!messaging || Notification.permission!=="granted")throw Error("צריך לאפשר התראות בטלפון ולבחור שוב ״עם התראות״.");
    state="pending";error="";renderShopNotificationTest();
    const id=deviceId(true),reg=await worker();
    // Ensure the current worker has taken over before enabling server sends.
    await updateWorker(reg);
    // Renewal must not disable the last working registration. A temporary FCM
    // or network error would otherwise mute foreground AND background pushes
    // indefinitely. New devices remain off until their first server opt-in.
    if(!stillEnabled())return false;
    const token=await messaging.getToken({vapidKey:VAPID_KEY,serviceWorkerRegistration:reg});
    if(!token)throw Error("לא התקבל מזהה התראות. נסה שוב.");
    if(!stillEnabled())return false;
    await call("enable",id,token,user);
    if(!stillEnabled()){await policy(false,id,reg);await call("disable",id,undefined,user);return false;}
    await policy(true,id,reg);
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
    const version=generation;
    inflight=performSync().then(connected=>{if(connected)retryDelay=15000;return connected;}).catch(e=>{
      if(version!==generation)return false;
      state=shopNotificationsEnabled()?"error":"off";error=e.message||"לא הצלחנו להתחבר לשרת ההתראות.";
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
    return call("pending",deviceId(false));
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
  window.addEventListener("storage",()=>refreshWhenReady(true));
})();
