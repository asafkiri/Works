/* Compact controls for active entry/exit reminders on the shop terminal. */
(function(){
  let events=[],pending=null,lastRefresh=0,version=0,again=false;
  const busy=new Set();
  function enabled(){return shopNotificationsEnabled() && window.ShopNotifications?.getState()==="active";}
  function clear(){version++;events=[];lastRefresh=0;render();}
  // Any open shift of the employee counts, not only the openShiftId pointer
  // (it can be missing or stale, e.g. after a punch saved while offline).
  function inShift(id){
    const employee=employees[id],pointed=employee?.openShiftId && shifts[employee.openShiftId];
    return !!(pointed && !pointed.clockOut) || Object.values(shifts||{}).some(s=>s && s.employeeId===id && s.clockIn && !s.clockOut);
  }
  // A punch was just saved on this terminal: hide that reminder's controls at once.
  function resolved(employeeId,kind){
    version++;events=events.filter(e=>!(e.employeeId===employeeId && e.kind===kind));render();refresh(true);
  }
  function render(){
    document.querySelectorAll("[data-shop-snooze]").forEach(slot=>{
      const employee=employees[slot.dataset.shopSnooze],live=inShift(slot.dataset.shopSnooze);
      // Entry reminders matter while the employee is out, exit reminders while in.
      const row=enabled()?events.find(e=>e.employeeId===slot.dataset.shopSnooze && e.kind===(live?"out":"in")):null;
      if(!row){slot.replaceChildren();delete slot.dataset.signature;return;}
      const paused=Number(row.until)>Date.now(),working=busy.has(row.snoozeKey);
      const signature=JSON.stringify([row.snoozeKey,row.until,paused,working]);
      if(slot.dataset.signature===signature && slot.firstChild)return;
      const open=slot.querySelector("details")?.open||false;
      slot.dataset.signature=signature;
      const details=document.createElement("details"),summary=document.createElement("summary");
      details.open=open;details.style.cssText="margin-top:10px;font-size:13px;cursor:auto";
      summary.style.cssText="cursor:pointer;color:var(--primary);font-weight:600";
      summary.textContent=paused?"⏸ נדחה עד "+new Date(row.until).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"})+" · שינוי":"⏰ הזכר לי בעוד…";
      details.append(summary);
      const text=document.createElement("div");
      text.textContent="דוחה את תזכורת ה"+(row.kind==="in"?"כניסה":"יציאה")+" למשמרת הזו. לאחר מכן היא חוזרת כל 5 דקות עד להחתמה.";
      text.style.cssText="color:var(--muted);line-height:1.5;margin:8px 0";
      details.append(text);
      const choices=document.createElement("div");choices.style.cssText="display:grid;grid-template-columns:repeat(3,1fr);gap:6px";
      for(const minutes of [10,20,30,40,50,60]){
        const button=document.createElement("button");button.type="button";button.className="btn line sm";
        button.textContent=minutes===60?"שעה":minutes+" דקות";button.disabled=working;
        button.addEventListener("click",async event=>{
          event.stopPropagation();if(busy.has(row.snoozeKey))return;
          busy.add(row.snoozeKey);render();
          const requestVersion=version;
          try{
            const result=await ShopNotifications.snooze(row,minutes);
            if(requestVersion!==version || !enabled())return;
            version++;
            events.forEach(e=>{if(e.snoozeKey===row.snoozeKey)e.until=result.until;});
            const shown=slot.querySelector("details");if(shown)shown.open=false;
            toast("התזכורת נדחתה ב־"+minutes+" דקות");
          }catch(error){if(requestVersion===version)toast(error.message||"הדחייה לא נשמרה. נסה שוב.");}
          finally{busy.delete(row.snoozeKey);render();refresh(true);}
        });
        choices.append(button);
      }
      details.append(choices);
      if(row.kind==="in"){
        const cancel=document.createElement("button");cancel.type="button";cancel.className="btn line sm";
        cancel.textContent="לא מגיע — בטל תזכורות למשמרת הזו";cancel.disabled=working;
        cancel.style.cssText="width:100%;margin-top:8px";
        cancel.addEventListener("click",async event=>{
          event.stopPropagation();if(busy.has(row.snoozeKey))return;
          busy.add(row.snoozeKey);render();
          const requestVersion=version;
          try{
            const ok=await uiConfirm("לבטל את תזכורות הכניסה והיציאה של "+(employee?.name||"העובד")+" למשמרת הזו?\nהסידור וההחתמות לא ישתנו. המשמרת הבאה תמשיך לקבל תזכורות.", {title:"ביטול תזכורות למשמרת",okText:"בטל תזכורות"});
            if(!ok || requestVersion!==version || !enabled())return;
            await ShopNotifications.cancel(row);
            if(requestVersion!==version || !enabled())return;
            version++;
            events=events.filter(e=>e.planKey!==row.planKey);
            toast("תזכורות הכניסה והיציאה למשמרת הזו בוטלו");
          }catch(error){if(requestVersion===version)toast(error.message||"הביטול לא נשמר. נסה שוב.");}
          finally{busy.delete(row.snoozeKey);render();refresh(true);}
        });
        details.append(cancel);
      }
      slot.replaceChildren(details);
    });
  }
  async function refresh(force=false){
    if(!enabled()){clear();return;}
    if(pending){if(force)again=true;return;}
    if(!force && Date.now()-lastRefresh<30_000)return;
    const requestVersion=version;lastRefresh=Date.now();
    pending=ShopNotifications.pending().then(result=>{
      if(requestVersion===version && enabled()){events=result.events||[];render();}
    }).catch(()=>{lastRefresh=0;}).finally(()=>{pending=null;if(again){again=false;refresh(true);}});
    return pending;
  }
  window.ShopSnooze={render,refresh,clear,resolved};
  setInterval(()=>{if(document.visibilityState==="visible"){render();refresh();}},30_000);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refresh(true);});
})();
