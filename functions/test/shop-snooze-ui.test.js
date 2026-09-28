"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../shop-snooze-ui.js"),"utf8");
class Element {
  constructor(tag){this.tag=tag;this.dataset={};this.children=[];this.style={};this.listeners={};this.open=false;}
  append(child){this.children.push(child);}
  replaceChildren(...children){this.children=children;}
  get firstChild(){return this.children[0];}
  querySelector(tag){return this.children.find(c=>c.tag===tag)||this.children.map(c=>c.querySelector(tag)).find(Boolean);}
  addEventListener(type,handler){this.listeners[type]=handler;}
}
function ui(kind="out",extra=[]){
  let opted=true,fail=false,stopped=false,cancelled=false,confirmed=true;
  const slot=new Element("div");slot.dataset.shopSnooze="a";
  const row={employeeId:"a",kind,eventKey:"event",planKey:"plan",snoozeKey:"shift",until:0},calls=[],messages=[];
  const ctx={Date,setInterval(){},employees:{a:{name:"דני",openShiftId:kind==="out"?"s":null}},shifts:kind==="out"?{s:{clockOut:null}}:{},
    document:{querySelectorAll:()=>[slot],createElement:tag=>new Element(tag),addEventListener(){}},
    shopNotificationsEnabled:()=>opted,toast:m=>messages.push(m),uiConfirm:async()=>confirmed,
    ShopNotifications:{getState:()=>"active",pending:async()=>({events:cancelled?[]:[...extra.map(e=>structuredClone(e)),structuredClone(row)]}),snooze:async(event,minutes)=>{
      calls.push({event,minutes});if(fail)throw Error("אין חיבור");row.until=Date.now()+minutes*60000;return {until:row.until};
    },cancel:async event=>{calls.push({action:"cancel",event});if(fail)throw Error("אין חיבור");cancelled=true;return {cancelled:true};}}};
  ctx.window=ctx;vm.runInNewContext(source,ctx);
  const click=minutes=>slot.querySelector("details").children[2].children.find(b=>b.textContent===(minutes===60?"שעה":minutes+" דקות")).listeners.click({stopPropagation(){stopped=true;}});
  const cancel=()=>slot.querySelector("details").children[3].listeners.click({stopPropagation(){stopped=true;}});
  return {ctx,slot,calls,messages,click,cancel,confirm:v=>{confirmed=v;},stopped:()=>stopped,opted:v=>{opted=v;},fail:()=>{fail=true;}};
}
test("exit snooze stays folded, offers all durations, saves without triggering attendance and shows its deadline",async()=>{
  const d=ui();await d.ctx.ShopSnooze.refresh(true);
  assert.equal(d.slot.firstChild.open,false);
  assert.equal(d.slot.firstChild.children.length,3); // No cancellation control for exit.
  assert.deepEqual(d.slot.firstChild.children[2].children.map(b=>b.textContent),["10 דקות","20 דקות","30 דקות","40 דקות","50 דקות","שעה"]);
  d.slot.firstChild.open=true;await d.click(20);
  assert.equal(d.stopped(),true);assert.equal(d.calls[0].minutes,20);
  assert.equal(d.ctx.shifts.s.clockOut,null);assert.equal(d.slot.firstChild.open,false);
  assert.match(d.slot.querySelector("summary").textContent,/נדחה עד/);
  d.ctx.shifts.s.clockOut=Date.now();d.ctx.ShopSnooze.render();assert.equal(d.slot.children.length,0);
});
test("entry offers snooze and cancellation only while pending, then hides immediately after a punch",async()=>{
  const d=ui("in");d.ctx.ShopSnooze.render();assert.equal(d.slot.children.length,0);
  await d.ctx.ShopSnooze.refresh(true);assert.equal(d.slot.firstChild.open,false);
  assert.match(d.slot.firstChild.children[1].textContent,/כניסה/);
  assert.match(d.slot.firstChild.children[3].textContent,/בטל תזכורות/);
  await d.click(30);assert.equal(d.calls[0].minutes,30);assert.equal(Object.keys(d.ctx.shifts).length,0);
  d.ctx.employees.a.openShiftId="s";d.ctx.shifts.s={clockOut:null};d.ctx.ShopSnooze.render();
  assert.equal(d.slot.children.length,0);
});
test("cancelling entry asks for confirmation, hides all controls and never punches attendance",async()=>{
  const d=ui("in");await d.ctx.ShopSnooze.refresh(true);d.confirm(false);await d.cancel();
  assert.equal(d.calls.length,0);assert.equal(d.slot.children.length,1);
  d.confirm(true);await d.cancel();assert.equal(d.calls[0].action,"cancel");
  assert.equal(d.stopped(),true);assert.equal(d.slot.children.length,0);
  assert.equal(Object.keys(d.ctx.shifts).length,0);assert.equal(d.ctx.employees.a.openShiftId,null);
  assert.match(d.messages.at(-1),/הכניסה והיציאה/);
});
test("failed cancellation retains the pending controls and does not report success",async()=>{
  const d=ui("in");await d.ctx.ShopSnooze.refresh(true);d.fail();await d.cancel();
  assert.equal(d.messages.at(-1),"אין חיבור");assert.equal(d.slot.children.length,1);
});
test("failed snooze does not show success; opting out removes controls",async()=>{
  const d=ui();await d.ctx.ShopSnooze.refresh(true);d.fail();await d.click(10);
  assert.equal(d.messages.at(-1),"אין חיבור");assert.doesNotMatch(d.slot.querySelector("summary").textContent,/נדחה עד/);
  d.opted(false);d.ctx.ShopSnooze.clear();assert.equal(d.slot.children.length,0);
});
test("exit controls appear for an open shift the employee pointer does not reference",async()=>{
  const d=ui("out");d.ctx.employees.a.openShiftId=null;d.ctx.shifts={orphan:{employeeId:"a",clockIn:Date.now()-3600000,clockOut:null}};
  await d.ctx.ShopSnooze.refresh(true);assert.equal(d.slot.children.length,1);assert.match(d.slot.firstChild.children[1].textContent,/יציאה/);
});
test("with two reminders for one employee the card offers the one matching whether they are in",async()=>{
  const d=ui("in",[{employeeId:"a",kind:"out",eventKey:"earlier",planKey:"earlier-plan",snoozeKey:"earlier-shift",until:0}]);
  d.ctx.employees.a.openShiftId=null;d.ctx.shifts={};
  await d.ctx.ShopSnooze.refresh(true);assert.match(d.slot.firstChild.children[1].textContent,/כניסה/);
});
test("a punch on this terminal hides that reminder's controls before the server answers",async()=>{
  const d=ui("in");await d.ctx.ShopSnooze.refresh(true);assert.equal(d.slot.children.length,1);
  d.ctx.ShopSnooze.resolved("a","in");assert.equal(d.slot.children.length,0);
});
test("a punch by another employee while 'not coming' is being confirmed does not void the cancellation",async()=>{
  const d=ui("in");await d.ctx.ShopSnooze.refresh(true);
  let answer;d.ctx.uiConfirm=()=>new Promise(r=>{answer=r;});
  const cancelling=d.cancel();d.ctx.ShopSnooze.resolved("b","in");answer(true);await cancelling;
  assert.equal(d.calls.at(-1).action,"cancel");assert.match(d.messages.at(-1),/הכניסה והיציאה/);
});
test("snooze and 'not coming' apply to every overlapping plan reminding the same employee",async()=>{
  const other={employeeId:"a",kind:"in",eventKey:"event-2",planKey:"plan-2",snoozeKey:"shift-2",until:0};
  const d=ui("in",[other]);await d.ctx.ShopSnooze.refresh(true);await d.click(20);
  assert.deepEqual(d.calls.map(c=>c.event.snoozeKey).sort(),["shift","shift-2"]);
  const e=ui("in",[other]);await e.ctx.ShopSnooze.refresh(true);await e.cancel();
  assert.deepEqual(e.calls.filter(c=>c.action==="cancel").map(c=>c.event.planKey).sort(),["plan","plan-2"]);
});
