"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
const shopSource = html.slice(html.indexOf("let shopNotificationTestBusy"), html.indexOf("/* ---------- התראות מנהל: שמירת token"));
const managerInit = html.slice(html.indexOf("function initPushForManager()"), html.indexOf("async function enableManagerNotifs()"));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function device({storage = new Map(), permission = "granted", permissionRequest, registration} = {}) {
  const nodes = {shopNotificationTestCard:{innerHTML:""}, mgrNotifCard:{innerHTML:""}};
  const calls = {shown:0, closed:0, manager:0, requested:0};
  const listeners = {};
  const reg = {showNotification:async () => { calls.shown++; }, getNotifications:async () => [
    {data:{worksSoundTest:true}, close(){calls.closed++;}},
    {data:{kind:"employee"}, close(){throw new Error("Unrelated notification must remain");}}
  ]};
  const context = {
    currentRole:"manager", mode:"shop", auth:{currentUser:{uid:"manager-1"}},
    getDeviceMode(){return context.mode;}, $:id=>nodes[id], esc:s=>String(s),
    window:{isSecureContext:true, Notification:{}, addEventListener:(k,v)=>{listeners[k]=v;}},
    Notification:{permission, requestPermission:()=>{calls.requested++;return permissionRequest ? permissionRequest.promise : Promise.resolve(permission);}},
    navigator:{serviceWorker:{register:()=>registration ? registration.promise : Promise.resolve(reg), ready:Promise.resolve(reg),getRegistration:async()=>reg}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    location:{href:"https://asafkiri.github.io/Works/"}, URL, setTimeout, clearTimeout,
    messaging:{}, registerAndSaveManagerToken:async()=>{calls.manager++;}
  };
  vm.createContext(context); vm.runInContext(shopSource + managerInit, context);
  return {context, nodes, calls, storage, listeners};
}

test("OS permission does not opt in a new device or register it for manager push", async () => {
  const d = device();
  d.context.renderShopNotificationTest();
  assert.equal(d.context.shopNotificationsEnabled(), false);
  assert.match(d.nodes.shopNotificationTestCard.innerHTML, /aria-pressed="true" onclick="chooseShopNotifications\(false\)"/);
  await d.context.testShopNotification();
  d.context.mode="manager"; d.context.initPushForManager();
  assert.equal(d.calls.shown, 0); assert.equal(d.calls.manager, 0);
});

test("explicit opt-in survives reload only on this device and this account", async () => {
  const d = device(); await d.context.chooseShopNotifications(true);
  assert.equal(d.context.shopNotificationsEnabled(), true);
  await d.context.testShopNotification(); assert.equal(d.calls.shown, 1);
  assert.equal(device({storage:d.storage}).context.shopNotificationsEnabled(), true);
  assert.equal(device().context.shopNotificationsEnabled(), false);
  d.context.auth.currentUser.uid="another-manager";
  assert.equal(d.context.shopNotificationsEnabled(), false);
  d.context.auth.currentUser.uid="manager-1"; d.context.mode="manager";
  assert.equal(d.context.shopNotificationsEnabled(), false);
  d.context.initPushForManager(); assert.equal(d.calls.manager, 0);
});

test("opting out during a permission prompt wins over its late approval", async () => {
  const p = deferred(), d = device({permission:"default",permissionRequest:p});
  const enable = d.context.chooseShopNotifications(true);
  await d.context.chooseShopNotifications(false); p.resolve("granted"); await enable;
  assert.equal(d.context.shopNotificationsEnabled(), false);
  assert.match(d.nodes.shopNotificationTestCard.innerHTML, /נשמר: בלי התראות/);
  assert.doesNotMatch(d.nodes.shopNotificationTestCard.innerHTML, /מפעיל…/);
});

test("opting out cancels a test awaiting its worker and closes only its test notification", async () => {
  const r = deferred(), d = device({registration:r});
  await d.context.chooseShopNotifications(true);
  const pending = d.context.testShopNotification();
  await d.context.chooseShopNotifications(false); r.resolve({}); await pending;
  assert.equal(d.calls.shown, 0); assert.equal(d.calls.closed, 1);
  assert.equal(d.context.shopNotificationsEnabled(), false);
});

test("denied permission and failed persistence cannot enable notifications", async () => {
  const denied=device({permission:"denied"}); await denied.context.chooseShopNotifications(true);
  assert.equal(denied.context.shopNotificationsEnabled(),false);
  const failed=device(); failed.context.localStorage.setItem=()=>{throw Error("storage unavailable");};
  await failed.context.chooseShopNotifications(true);
  assert.equal(failed.context.shopNotificationsEnabled(),false);
  assert.match(failed.nodes.shopNotificationTestCard.innerHTML,/הבחירה לא נשמרה/);
});

test("another tab opting out cancels this tab's pending test", async () => {
  const r=deferred(),d=device({registration:r});await d.context.chooseShopNotifications(true);
  const pending=d.context.testShopNotification();
  d.storage.set("worksShopNotifications:manager-1","off");
  d.listeners.storage({key:"worksShopNotifications:manager-1"});r.resolve({});await pending;
  assert.equal(d.calls.shown,0);assert.equal(d.context.shopNotificationsEnabled(),false);
});

test("a late permission grant after account change cannot opt in either account", async () => {
  const p=deferred(),d=device({permission:"default",permissionRequest:p});
  const pending=d.context.chooseShopNotifications(true);d.context.auth.currentUser.uid="manager-2";
  p.resolve("granted");await pending;assert.equal(d.storage.size,0);
});

test("the terminal chime is on by default once this phone opted in, is saved per device and account, and never throws without audio", async () => {
  const d = device();
  assert.equal(d.context.shopChimeEnabled(), false, "no chime while shop notifications are off");
  await d.context.chooseShopNotifications(true);
  assert.equal(d.context.shopChimeEnabled(), true);
  assert.match(d.nodes.shopNotificationTestCard.innerHTML, /chooseShopChime\(this\.checked\)" checked/);
  assert.equal(d.context.playShopReminderChime(), false, "no audio in this environment, no exception");
  assert.equal(d.context.playShopReminderChime(true), false);
  d.context.chooseShopChime(false);
  assert.equal(d.context.shopChimeEnabled(), false);
  assert.doesNotMatch(d.nodes.shopNotificationTestCard.innerHTML, /chooseShopChime\(this\.checked\)" checked/);
  assert.equal(device({storage:d.storage}).context.shopChimeEnabled(), false, "the choice survives reload on this device");
  d.context.chooseShopChime(true);
  assert.equal(device({storage:d.storage}).context.shopChimeEnabled(), true);
  d.context.auth.currentUser.uid = "another-manager";
  assert.equal(d.context.shopChimeEnabled(), false, "another account on this phone has not opted in");
});

function fakeAudio(d, {state = "suspended", resume} = {}) {
  const audio = {created:0, oscillators:0, last:null, timers:[]};
  d.context.window.AudioContext = class {
    constructor(){ audio.created++; audio.last = this; this.state = state; this.currentTime = 0; this.destination = {}; }
    resume(){ return resume ? resume(this) : (this.state = "running", Promise.resolve()); }
    suspend(){ this.state = "suspended"; return Promise.resolve(); }
    createOscillator(){ audio.oscillators++; return {frequency:{}, connect:g => g, start(){}, stop(){}}; }
    createGain(){ return {gain:{setValueAtTime(){}, exponentialRampToValueAtTime(){}}, connect:n => n}; }
  };
  d.context.setTimeout = (fn, ms) => { audio.timers.push({fn, ms}); return audio.timers.length; };
  d.context.clearTimeout = () => {};
  return audio;
}
const ticks = async () => { for(let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

test("only an opted-in shop terminal prepares the chime audio, and it idles between reminders", async () => {
  const d = device(), audio = fakeAudio(d);
  d.context.unlockShopChime(); await ticks();
  assert.equal(audio.created, 0, "a phone without shop notifications never creates audio");
  await d.context.chooseShopNotifications(true);
  d.context.unlockShopChime(); await ticks();
  assert.equal(audio.created, 1); assert.equal(audio.last.state, "running");
  audio.timers.find(t => t.ms === 4000).fn(); assert.equal(audio.last.state, "suspended", "idle audio is suspended");
  assert.equal(d.context.playShopReminderChime(), true); await ticks();
  assert.equal(audio.oscillators, 6); assert.equal(audio.created, 1, "one audio context for the page");
  d.context.chooseShopChime(false); audio.oscillators = 0;
  assert.equal(d.context.playShopReminderChime(), false); assert.equal(audio.oscillators, 0);
});

test("a chime whose audio unlock is held back until a later tap never plays late", async () => {
  const d = device(); await d.context.chooseShopNotifications(true);
  let release; const audio = fakeAudio(d, {resume: ctx => new Promise(r => { release = () => { ctx.state = "running"; r(); }; })});
  let now = 1_000_000; d.context.Date = {now: () => now};
  assert.equal(d.context.playShopReminderChime(), true);
  now += 60_000; release(); await ticks();
  assert.equal(audio.oscillators, 0, "a reminder from a minute ago must not chime now");
  assert.equal(d.context.playShopReminderChime(), true); await ticks();
  assert.equal(audio.oscillators, 6, "once unlocked, the next reminder chimes at once");
});

test("an existing manager registration is refreshed without new-device enrollment", () => {
  const d=device({storage:new Map([["fcmSavedMgr","existing-token"]])});
  d.context.mode="manager";d.context.initPushForManager();assert.equal(d.calls.manager,1);
});
