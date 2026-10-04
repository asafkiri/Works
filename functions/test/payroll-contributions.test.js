"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");

function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
  return html.slice(a, b);
}
function harness(employee = {}) {
  const elements = {};
  function element(id) {
    if (!elements[id]) {
      const classes = new Set();
      elements[id] = { value: "", checked: false, textContent: "", classList: {
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); },
      } };
    }
    return elements[id];
  }
  const writes = [], messages = [];
  const context = vm.createContext({
    Date, console, employees: { sample: { name: "עובד לדוגמה", ...employee }, other: { hourlyRate: 40 } },
    shifts: {}, currentRole: "manager", currentEmpId: null, myRate: null, secureRates: {},
    $: element, openModal() {}, closeModal() {}, toast: s => messages.push(s),
    currentMonthKey: () => "2026-07",
    db: { ref: key => ({ update: async value => { writes.push({ key, value }); Object.assign(context.employees[key.split("/")[1]], value); } }) },
  });
  const chunks = [
    section("function rateOf(empId){", "// קוד החתמה לפי עובד"),
    section("const MIN_DEDUCT_MS =", "function fmtHours(h)"),
    section("function monthTotals(empId, rate){", "// 10ג. משמרות אחרונות"),
    section("function weekKeyOf(ts){", "// רשימת חודשים שבהם יש לעובד פעילות"),
  ];
  for (const name of ["pad", "monthKeyOf", "parseIso"]) {
    chunks.push(html.match(new RegExp("^function " + name + "\\([^\\n]*", "m"))[0]);
  }
  vm.runInContext(chunks.join("\n"), context);
  return { context, element, writes, messages };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);
const profile = { hourlyRate: 51, creditPoints: 11.75, pensionOn: true, pensionRate: 6, pensionBase: "regular", studyFundOn: true, studyFundRate: 2.5, studyFundBase: "regular", overtimeEnabled: true };

test("the supplied 50-hour week produces 42 regular, 5 at 125%, 3 at 150%, and the agreed net", () => {
  const { context: c } = harness(profile);
  const schedule = [[5,11,0,20,0], [6,8,0,16,0], [7,11,0,20,0], [8,8,0,16,0], [9,11,0,20,0], [10,8,30,15,30]];
  for (const [d,ih,im,oh,om] of schedule) c.shifts[d] = { employeeId: "sample", clockIn: +new Date(2026,6,d,ih,im), clockOut: +new Date(2026,6,d,oh,om) };
  const pay = c.computeEmpPay("sample", "2026-07");
  assert.equal(pay.totalH, 50);
  assert.equal(pay.regH, 42);
  assert.equal(pay.ot125H, 5);
  assert.equal(pay.ot150H, 3);
  close(pay.totalPay, 2690.25);
  const month = c.monthTotals("sample", 51);
  close(month.regularPay, 2142);
  const net = c.estimateNet(pay.totalPay * 52 / 12, profile, new Date(2026,9,4), month.regularPay * 52 / 12);
  close(net.pension, 556.92);
  close(net.studyFund, 232.05);
  close(net.net, 10058.568825);
  assert.equal(net.incomeTax, 0);
  const summary = c.netSummaryHtml(net.gross, profile, new Date(2026,9,4), 9282);
  assert.match(summary, /קרן השתלמות \(2.5%\)/);
  assert.match(summary, /שכר רגיל בלבד · ₪9282/);
  assert.match(summary, /₪10059/);
});

test("each fund has an independent contribution basis; the entire overtime amount is excluded", () => {
  const { context: c } = harness();
  for (const pensionBase of ["regular", "gross"]) {
    for (const studyFundBase of ["regular", "gross"]) {
      const emp = { ...profile, pensionBase, studyFundBase };
      const n = c.estimateNet(12000, emp, new Date(2026,9,4), 9000);
      close(n.pension, pensionBase === "regular" ? 540 : 720);
      close(n.studyFund, studyFundBase === "regular" ? 225 : 300);
      close(n.net, 12000 - n.niHealth - n.pension - n.studyFund);
    }
  }
});

test("legacy pension-only employees retain their old net until the basis is explicitly changed", () => {
  const { context: c } = harness();
  const old = { creditPoints: 11.75, pensionOn: true, pensionRate: 6 };
  const n = c.estimateNet(11657.75, old, new Date(2026,9,4), 9282);
  close(n.net, 10148.073825);
  assert.equal(n.studyFund, 0);
  assert.equal(c.contributionBasis(old, "pension"), "gross");
  assert.equal(c.contributionBasis({}, "pension"), "regular");
});

test("disabled contributions and net-rate mode do not deduct saved contribution settings", () => {
  const { context: c } = harness();
  const off = c.estimateNet(10000, { ...profile, pensionOn: false, studyFundOn: false }, new Date(2026,9,4), 8000);
  assert.equal(off.pension, 0);
  assert.equal(off.studyFund, 0);
  const netRate = c.estimateNet(10000, { ...profile, netIsNet: true }, new Date(2026,9,4), 8000);
  assert.equal(netRate.net, 10000);
  assert.equal(netRate.deductions, 0);
});

test("zero regular pay never falls back to gross, and an empty month has no deductions", () => {
  const { context: c } = harness();
  const otOnly = c.estimateNet(1000, profile, new Date(2026,9,4), 0);
  assert.equal(otOnly.pension, 0);
  assert.equal(otOnly.studyFund, 0);
  const empty = c.estimateNet(0, profile, new Date(2026,9,4), 0);
  assert.equal(empty.net, 0);
  assert.equal(empty.deductions, 0);
});

test("a week spanning two months only includes the selected month's regular pay", () => {
  const { context: c } = harness(profile);
  for (let offset = 0; offset < 6; offset++) {
    const day = new Date(2026,5,28 + offset,8);
    const hours = [9,8,9,8,9,7][offset];
    c.shifts[offset] = { employeeId: "sample", clockIn: +day, clockOut: +day + hours*3600000 };
  }
  const july = c.computeEmpPay("sample", "2026-07");
  assert.equal(july.regH, 18);
  assert.equal(july.ot125H, 3);
  assert.equal(july.ot150H, 3);
  close(c.monthTotals("sample",51).regularPay, 918);
});

test("saving and reopening settings keeps separate bases and only updates the selected employee", async () => {
  const { context: c, element: el, writes } = harness({ pensionOn: true, hourlyRate: 51 });
  c.openNetModal("sample");
  assert.equal(el("netPensionBase").value, "gross");
  assert.equal(el("netStudyFund").checked, false);
  assert.equal(el("netStudyFundFields").classList.contains("hidden"), true);
  el("netPensionBase").value = "regular";
  el("netStudyFund").checked = true;
  el("netStudyFundRate").value = "2.5";
  el("netStudyFundBase").value = "gross";
  c.netSyncStudyFund();
  assert.equal(el("netStudyFundFields").classList.contains("hidden"), false);
  assert.equal(el("netContributionOtNote").classList.contains("hidden"), false);
  el("netOvertime").checked = true;
  c.netSyncOt();
  assert.equal(el("netContributionOtNote").classList.contains("hidden"), true);
  await c.saveNetSettings();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, "employees/sample");
  assert.equal(c.employees.other.studyFundOn, undefined);
  c.openNetModal("other");
  assert.equal(el("netStudyFund").checked, false);
  c.openNetModal("sample");
  assert.equal(el("netPensionBase").value, "regular");
  assert.equal(el("netStudyFundBase").value, "gross");
  assert.equal(el("netStudyFundRate").value, 2.5);
  assert.equal(el("netStudyFund").checked, true);
});

test("invalid active fund rates are rejected without writing employee data", async () => {
  const { context: c, element: el, writes, messages } = harness(profile);
  c.openNetModal("sample");
  for (const value of ["", "-1", "26", "Infinity"]) {
    el("netStudyFundRate").value = value;
    await c.saveNetSettings();
  }
  assert.equal(writes.length, 0);
  assert.equal(messages.length, 4);
  assert.ok(messages.every(m => m.includes("קרן השתלמות")));
});
