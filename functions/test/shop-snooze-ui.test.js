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
function ui(){
  let opted=true,fail=false,stopped=false;
  const slot=new Element("div");slot.dataset.shopSnooze="a";
  const row={employeeId:"a",eventKey:"plan",snoozeKey:"shift",until:0},calls=[],messages=[];
  const ctx={Date,setInterval(){},employees:{a:{openShiftId:"s"}},shifts:{s:{clockOut:null}},
    document:{querySelectorAll:()=>[slot],createElement:tag=>new Element(tag),addEventListener(){}},
    shopNotificationsEnabled:()=>opted,toast:m=>messages.push(m),
    ShopNotifications:{getState:()=>"active",pending:async()=>({events:[structuredClone(row)]}),snooze:async(event,minutes)=>{
      calls.push({event,minutes});if(fail)throw Error("אין חיבור");row.until=Date.now()+minutes*60000;return {until:row.until};
    }}};
  ctx.window=ctx;vm.runInNewContext(source,ctx);
  const click=minutes=>slot.querySelector("details").children[2].children.find(b=>b.textContent===(minutes===60?"שעה":minutes+" דקות")).listeners.click({stopPropagation(){stopped=true;}});
  return {ctx,slot,calls,messages,click,stopped:()=>stopped,opted:v=>{opted=v;},fail:()=>{fail=true;}};
}
test("exit snooze stays folded, offers all durations, saves without triggering attendance and shows its deadline",async()=>{
  const d=ui();await d.ctx.ShopSnooze.refresh(true);
  assert.equal(d.slot.firstChild.open,false);
  assert.deepEqual(d.slot.firstChild.children[2].children.map(b=>b.textContent),["10 דקות","20 דקות","30 דקות","40 דקות","50 דקות","שעה"]);
  d.slot.firstChild.open=true;await d.click(20);
  assert.equal(d.stopped(),true);assert.equal(d.calls[0].minutes,20);
  assert.equal(d.ctx.shifts.s.clockOut,null);assert.equal(d.slot.firstChild.open,false);
  assert.match(d.slot.querySelector("summary").textContent,/נדחה עד/);
  d.ctx.shifts.s.clockOut=Date.now();d.ctx.ShopSnooze.render();assert.equal(d.slot.children.length,0);
});
test("failed snooze does not show success; opting out removes controls",async()=>{
  const d=ui();await d.ctx.ShopSnooze.refresh(true);d.fail();await d.click(10);
  assert.equal(d.messages.at(-1),"אין חיבור");assert.doesNotMatch(d.slot.querySelector("summary").textContent,/נדחה עד/);
  d.opted(false);d.ctx.ShopSnooze.clear();assert.equal(d.slot.children.length,0);
});
