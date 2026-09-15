"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const gifts = require("../../store-gifts");
const taking = (price, createdAt, extra = {}) => ({ name: "קנייה", price, createdAt, ...extra });
const grant = (giftCents, createdAt) => ({ kind: "store_gift", amount: 0, giftCents, note: "ראש השנה", createdAt });

test("100 gift leaves an existing 300 debt alone; 40 and 80 purchases add only 20 debt", () => {
  const payments = { gift: grant(10000, 20) };
  const purchases = { old: taking(300, 10), first: taking(40, 30), second: taking(80, 40) };
  const before = structuredClone({ payments, purchases });
  const r = gifts.compute(purchases, payments);
  assert.equal(r.items.old.chargeCents, 30000);
  assert.equal(r.items.first.chargeCents, 0);
  assert.equal(r.items.second.chargeCents, 2000);
  assert.equal(r.balanceCents, 0);
  assert.equal(r.usedCents, 10000);
  assert.deepEqual({ payments, purchases }, before);
});

test("a later gift cannot cover any preceding debt, including the grant timestamp", () => {
  const r = gifts.compute({ old: taking(60, 10), same: taking(40, 20) }, { gift: grant(10000, 20) });
  assert.equal(r.balanceCents, 10000);
  assert.equal(r.items.old.chargeCents + r.items.same.chargeCents, 10000);
});

test("simultaneous purchases use a deterministic total, regardless of arrival order", () => {
  const payments = { gift: grant(10000, 10) };
  const a = taking(80, 20), b = taking(80, 20);
  const first = gifts.compute({ a, b }, payments);
  const second = gifts.compute({ b, a }, payments);
  assert.deepEqual(first, second);
  assert.equal(first.items.a.giftCents, 8000);
  assert.equal(first.items.b.giftCents, 2000);
  assert.equal(first.items.a.chargeCents + first.items.b.chargeCents, 6000);
  assert.equal(first.balanceCents, 0);
});

test("unused gifts accumulate and survive the month and year boundary", () => {
  const dec = Date.UTC(2025, 11, 20), jan = Date.UTC(2026, 0, 3);
  const r = gifts.compute({ a: taking(140, jan) }, { one: grant(10000, dec), two: grant(5000, dec + 1) });
  assert.equal(r.balanceCents, 1000);
  assert.equal(r.grantedCents, 15000);
  assert.equal(r.items.a.chargeCents, 0);
});

test("all money calculations preserve agorot and never make a negative gift balance", () => {
  const r = gifts.compute({ a: taking(0.1, 20), b: taking(0.2, 21), c: taking(0.01, 22) }, { g: grant(30, 10) });
  assert.equal(r.items.a.giftCents + r.items.b.giftCents, 30);
  assert.equal(r.items.c.chargeCents, 1);
  assert.equal(r.balanceCents, 0);
});

test("payroll payments and malformed gifts do not grant store credit", () => {
  const r = gifts.compute({ a: taking(100, 20) }, {
    salary: { amount: 1000, createdAt: 10 },
    invalid: grant(-100, 10), fractional: grant(1.5, 10),
    pending: grant(10000, { ".sv": "timestamp" }),
  });
  assert.equal(r.items.a.chargeCents, 10000);
  assert.equal(r.balanceCents, 0);
  assert.deepEqual(r.history, []);
});

test("deleting a gift purchase refunds only at deletion time and leaves later existing debt unchanged", () => {
  const old = taking(80, 20);
  const deleted = gifts.reviseTaking(old, old, "r1", old.name, 0, 40, true);
  const r = gifts.compute({ a: deleted, debt: taking(70, 30), future: taking(90, 50) }, { g: grant(10000, 10) });
  assert.equal(r.items.a.chargeCents, 0);
  assert.equal(r.items.a.giftCents, 0);
  assert.equal(r.items.debt.chargeCents, 5000);
  assert.equal(r.items.future.giftCents, 8000);
  assert.equal(r.items.future.chargeCents, 1000);
  assert.equal(r.balanceCents, 0);
  assert.equal(r.history.find(h => h.type === "refund").amountCents, 8000);
});

test("reducing a mixed purchase refunds debt first, then restores only the gift portion", () => {
  const old = taking(140, 20);
  const reduced = gifts.reviseTaking(old, old, "r1", old.name, 11000, 30, false);
  let r = gifts.compute({ a: reduced }, { g: grant(10000, 10) });
  assert.equal(r.items.a.chargeCents, 1000);
  assert.equal(r.items.a.giftCents, 10000);
  assert.equal(r.balanceCents, 0);
  const again = gifts.reviseTaking(reduced, reduced, "r2", old.name, 8000, 40, false);
  r = gifts.compute({ a: again }, { g: grant(10000, 10) });
  assert.equal(r.items.a.chargeCents, 0);
  assert.equal(r.items.a.giftCents, 8000);
  assert.equal(r.balanceCents, 2000);
});

test("editing a pre-gift purchase never spends a gift on that old purchase", () => {
  const old = taking(300, 10);
  const edited = gifts.reviseTaking(old, old, "r1", "תיקון", 32000, 30, false);
  const r = gifts.compute({ old: edited }, { g: grant(10000, 20) });
  assert.equal(r.items.old.chargeCents, 32000);
  assert.equal(r.balanceCents, 10000);
});

test("correction transaction rejects a stale edit and is independent of Firebase property order", () => {
  const old = taking(80, 20);
  const reordered = { createdAt: 20, price: 80, name: "קנייה" };
  assert.ok(gifts.reviseTaking(reordered, old, "r", "עריכה", 4000, 30, false));
  const changed = { ...old, name: "שינוי ממכשיר אחר" };
  assert.equal(gifts.reviseTaking(changed, old, "r", "עריכה", 4000, 30, false), undefined);
  assert.equal(gifts.reviseTaking(null, old, "r", "עריכה", 4000, 30, false), undefined);
  const deleted = gifts.reviseTaking(old, old, "r", old.name, 0, 30, true);
  assert.equal(gifts.reviseTaking(deleted, old, "r2", "עריכה", 4000, 40, false), undefined);
});

test("an untouched gift can be cancelled; it drops the balance and leaves debts alone", () => {
  const g = grant(10000, 20);
  const r = gifts.compute({ old: taking(300, 10) }, { g });
  assert.equal(r.grants.g.removable, true);
  const canceled = gifts.cancelGrant(g, 10000, 30);
  const after = gifts.compute({ old: taking(300, 10), later: taking(50, 40) }, { g: canceled });
  assert.equal(after.balanceCents, 0);
  assert.equal(after.grantedCents, 0);
  assert.equal(after.usedCents, 0);
  assert.equal(after.items.old.chargeCents, 30000);
  assert.equal(after.items.later.chargeCents, 5000);
  assert.equal(after.grants.g.canceled, true);
  assert.equal(after.grants.g.removable, false);
  assert.equal(after.history[0].type, "cancel");
  assert.equal(after.history[0].amountCents, 10000);
});

test("a gift already used, even in part, is not offered for cancellation", () => {
  const partial = gifts.compute({ a: taking(1, 20) }, { g: grant(10000, 10) });
  assert.equal(partial.grants.g.removable, false);
  const refunded = gifts.reviseTaking(taking(1, 20), taking(1, 20), "r1", "קנייה", 0, 30, true);
  assert.equal(gifts.compute({ a: refunded }, { g: grant(10000, 10) }).grants.g.removable, false);
  assert.equal(gifts.compute({}, { g: grant(10000, 10) }).grants.g.removable, true);
});

test("a purchase racing the cancellation keeps its cover and the cancellation lapses", () => {
  const g = gifts.cancelGrant(grant(10000, 10), 10000, 30);
  const r = gifts.compute({ a: taking(100, 20), same: taking(60, 30) }, { g });
  assert.equal(r.items.a.giftCents, 10000);
  assert.equal(r.items.a.chargeCents, 0);
  assert.equal(r.items.same.chargeCents, 6000);
  assert.equal(r.balanceCents, 0);
  assert.equal(r.grants.g.canceled, false);
  assert.equal(r.grants.g.canceledAt, 30);
  assert.equal(r.grants.g.removable, false);
  assert.ok(!r.history.some(h => h.type === "cancel"));
});

test("cancelling one gift never spends another grant's unused credit", () => {
  const payments = { a1: grant(10000, 10), b2: grant(10000, 20) };
  const purchases = { p: taking(100, 30) };
  const both = gifts.compute(purchases, payments);
  assert.equal(both.grants.a1.removable, true);
  assert.equal(both.grants.b2.removable, true);
  payments.a1 = gifts.cancelGrant(payments.a1, 10000, 40);
  const one = gifts.compute(purchases, payments);
  assert.equal(one.balanceCents, 0);
  assert.equal(one.items.p.giftCents, 10000);
  assert.equal(one.grants.b2.removable, false);
  payments.b2 = gifts.cancelGrant(payments.b2, 10000, 50);
  const none = gifts.compute(purchases, payments);
  assert.equal(none.balanceCents, 0);
  assert.equal(none.items.p.giftCents, 10000);
  assert.equal(none.items.p.chargeCents, 0);
  assert.equal(none.grants.b2.canceled, false);
});

test("the cancellation transaction rejects a repeat, a changed amount and a payment", () => {
  const g = grant(10000, 10);
  const canceled = gifts.cancelGrant(g, 10000, 20);
  assert.equal(canceled.canceledAt, 20);
  assert.equal(canceled.giftCents, 10000);
  assert.equal(gifts.cancelGrant(canceled, 10000, 30), undefined);
  assert.equal(gifts.cancelGrant(g, 9900, 30), undefined);
  assert.equal(gifts.cancelGrant(null, 10000, 30), undefined);
  assert.equal(gifts.cancelGrant({ amount: 100, createdAt: 10 }, 10000, 30), undefined);
  const pending = gifts.cancelGrant(g, 10000, { ".sv": "timestamp" });
  assert.equal(gifts.compute({}, { g: pending }).balanceCents, 10000);
  assert.equal(gifts.compute({}, { g: { ...g, canceledAt: 5 } }).balanceCents, 10000);
});

test("amount input rejects partial, negative, infinite and over-precise values", () => {
  for (const v of ["", "100abc", "-5", "Infinity", "NaN", "1.001", "1e5", "9007199254740992"]) {
    assert.equal(gifts.parseAmount(v), null, v);
  }
  assert.equal(gifts.parseAmount("100"), 10000);
  assert.equal(gifts.parseAmount("12,50"), 1250);
  assert.equal(gifts.parseAmount("0"), 0);
});

// Exercise the real application readers and report generator, not a second
// implementation of their financial filters.
const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
function sourceFunction(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  if (html.startsWith("async ", start - 6)) start -= 6;
  const next = html.indexOf("\nfunction ", start + 1);
  const asyncNext = html.indexOf("\nasync function ", start + 1);
  return html.slice(start, Math.min(...[next, asyncNext].filter(n => n >= 0)));
}
function appContext() {
  const ctx = { StoreGifts: gifts, Map, Date, Number, Object, Set,
    currentRole: "manager", currentEmpId: null, currentMonthKey: () => "2026-09",
    myTakings: {}, myPayments: {}, giftLedgerCache: new Map(),
    allTakings: {}, allPayments: {}, employees: { e1: { name: "עובד לבדיקה" } },
    hakafaDataReady: () => true, paySubEmpId: "e1", paySelMonthKey: "2026-09",
    rateOf: () => 40, pad: n => String(n).padStart(2, "0"),
    fmtTime: () => "08:00", fmtHours: h => `${h} שעות`, esc: s => s,
    breakMsOf: () => 0, isNightShift: () => false, netHoursOf: () => 8,
    monthKeyOf: ts => new Date(ts).toISOString().slice(0, 7), fmtDate: () => "01/09/2026",
    monthLabel: key => key, computeEmpPay: () => ({ totalPay: 320, totalH: 8 }),
    payShiftsFor: () => [{ clockIn: Date.UTC(2026, 8, 1, 8), clockOut: Date.UTC(2026, 8, 1, 16) }],
  };
  vm.createContext(ctx);
  for (const name of ["giftLedgerFor", "giftMoney", "giftHistoryHtml", "takingsListFor", "takingsSumFor", "paymentsListFor", "paymentsSumFor", "payBalanceSnapshot", "payReportData", "accountantReportHtml"]) {
    vm.runInContext(sourceFunction(name), ctx);
  }
  return ctx;
}

test("real payroll, employee balance and accountant export include only uncovered purchases", () => {
  const ctx = appContext(), at = Date.UTC(2026, 8, 1);
  ctx.allPayments.e1 = { gift: grant(10000, at + 20), payment: { amount: 25, createdAt: at + 50 } };
  ctx.allTakings.e1 = { old: taking(300, at + 10), a: taking(40, at + 30), b: taking(80.25, at + 40) };
  assert.equal(ctx.takingsSumFor("e1", "2026-09"), 320.25);
  assert.equal(ctx.paymentsSumFor("e1", "2026-09"), 25);
  assert.equal(ctx.payBalanceSnapshot("e1", "2026-09").balance, -25.25);
  const report = ctx.payReportData();
  assert.equal(report.tkSum, 320.25);
  assert.equal(report.paidPay, 25);
  assert.equal(report.payList.length, 1);
  const exported = ctx.accountantReportHtml(report);
  assert.match(exported, /320\.25/);
  assert.doesNotMatch(exported, /מתנה|ראש השנה|gift/);
  ctx.currentRole = "employee"; ctx.currentEmpId = "e1";
  ctx.myTakings = ctx.allTakings.e1; ctx.myPayments = ctx.allPayments.e1;
  ctx.allTakings = {}; ctx.allPayments = {};
  assert.equal(ctx.takingsSumFor("e1", "2026-09"), 320.25);
  assert.equal(ctx.payBalanceSnapshot("e1", "2026-09").balance, -25.25);
});

test("the real gift history offers cancellation only to a manager, only while unused", () => {
  const ctx = appContext(), at = Date.UTC(2026, 8, 1);
  ctx.allPayments.e1 = { fresh: grant(10000, at) };
  assert.match(ctx.giftHistoryHtml("e1"), /delStoreGift\('e1','fresh'\)/);
  ctx.allTakings.e1 = { a: taking(1, at + 10) };
  assert.doesNotMatch(ctx.giftHistoryHtml("e1"), /delStoreGift/);
  ctx.allPayments.e1 = { fresh: gifts.cancelGrant(grant(10000, at), 10000, at + 5) };
  ctx.allTakings.e1 = { a: taking(1, at + 10) };
  const canceled = ctx.giftHistoryHtml("e1");
  assert.match(canceled, /המתנה בוטלה/);
  assert.doesNotMatch(canceled, /delStoreGift/);
  ctx.currentRole = "employee"; ctx.currentEmpId = "e1";
  ctx.myPayments = { fresh: grant(10000, at) }; ctx.myTakings = {};
  assert.doesNotMatch(ctx.giftHistoryHtml("e1"), /delStoreGift/);
});

// The real manager action, with the database and the dialogs stubbed.
function cancelContext(at) {
  const ctx = appContext();
  ctx.giftSaving = false; ctx.dbConnected = true; ctx.TS = { ".sv": "timestamp" };
  ctx.toasts = []; ctx.writes = []; ctx.answer = true;
  ctx.toast = message => ctx.toasts.push(message);
  ctx.uiConfirm = () => Promise.resolve(ctx.answer);
  ctx.db = { ref: path => ({ transaction(fn) {
    const [, empId, id] = path.split("/");
    const next = fn((ctx.allPayments[empId] || {})[id]);
    ctx.writes.push({ path, next });
    // The server resolves the sentinel and the listener hands back a new object.
    if (next) ctx.allPayments[empId] = { ...ctx.allPayments[empId], [id]: { ...next, canceledAt: at + 90 } };
    return Promise.resolve({ committed: !!next });
  } }) };
  vm.runInContext(sourceFunction("delStoreGift"), ctx);
  return ctx;
}

test("the manager's cancel action stamps the grant and the balance drops to zero", async () => {
  const at = Date.UTC(2026, 8, 1), ctx = cancelContext(at);
  ctx.allPayments.e1 = { fresh: grant(10000, at) };
  await ctx.delStoreGift("e1", "fresh");
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.writes[0].path, "payments/e1/fresh");
  assert.deepEqual(ctx.writes[0].next.canceledAt, { ".sv": "timestamp" });
  assert.equal(ctx.writes[0].next.giftCents, 10000);
  assert.match(ctx.toasts.join(" "), /בוטלה/);
  const after = ctx.giftLedgerFor("e1");
  assert.equal(after.balanceCents, 0);
  assert.equal(after.grants.fresh.canceled, true);
});

test("the cancel action refuses a used gift, a declined dialog and a purchase made during it", async () => {
  const at = Date.UTC(2026, 8, 1);
  const used = cancelContext(at);
  used.allPayments.e1 = { g: grant(10000, at) };
  used.allTakings.e1 = { a: taking(1, at + 5) };
  await used.delStoreGift("e1", "g");
  assert.deepEqual(used.writes, []);
  assert.match(used.toasts.join(" "), /שטרם נוצלה/);

  const declined = cancelContext(at);
  declined.allPayments.e1 = { g: grant(10000, at) };
  declined.answer = false;
  await declined.delStoreGift("e1", "g");
  assert.deepEqual(declined.writes, []);
  assert.deepEqual(declined.toasts, []);

  const raced = cancelContext(at);
  raced.allPayments.e1 = { g: grant(10000, at) };
  raced.uiConfirm = () => { raced.allTakings.e1 = { a: taking(100, at + 5) }; return Promise.resolve(true); };
  await raced.delStoreGift("e1", "g");
  assert.deepEqual(raced.writes, []);
  assert.match(raced.toasts.join(" "), /כבר נוצלה/);
  assert.equal(raced.giftLedgerFor("e1").items.a.giftCents, 10000);

  const employee = cancelContext(at);
  employee.allPayments.e1 = { g: grant(10000, at) };
  employee.currentRole = "employee";
  await employee.delStoreGift("e1", "g");
  assert.deepEqual(employee.writes, []);
});

test("gift-only purchases never appear as salary deductions or advances in accountant output", () => {
  const ctx = appContext(), at = Date.UTC(2026, 8, 1);
  ctx.allPayments.e1 = { gift: grant(10000, at) };
  ctx.allTakings.e1 = { a: taking(40, at + 1) };
  const exported = ctx.accountantReportHtml(ctx.payReportData());
  assert.doesNotMatch(exported, /מתנה|ראש השנה|ניכוי משכר —|מקדמות \/ תשלומים ששולמו/);
  assert.equal(ctx.payBalanceSnapshot("e1", "2026-09").balance, 320);
});
