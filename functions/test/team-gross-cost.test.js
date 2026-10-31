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
const close = (actual, expected, tol = 0.01) => assert.ok(Math.abs(actual - expected) < tol, `${actual} != ${expected}`);
// Objects created inside the vm context have a different Object prototype, so compare by value.
const sameCost = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

// Four active employees, one per salary mode, plus an inactive one that must be ignored.
function harness() {
  const elements = {};
  const element = id => elements[id] || (elements[id] = { value: "", textContent: "", innerHTML: "", classList: { toggle() {}, contains() { return false; } } });
  const context = vm.createContext({
    Date, console, Math, Number, Object,
    employees: {
      grossHourly: { name: "ברוטו שעתי", hourlyRate: 50 },
      netHourly: { name: "נטו שעתי", hourlyRate: 50, netIsNet: true, creditPoints: 2.25 },
      fixedNet: { name: "נטו קבוע" },
      fixedGross: { name: "ברוטו קבוע" },
      gone: { name: "מושבת", hourlyRate: 500, active: false },
    },
    shifts: {}, currentRole: "manager", currentEmpId: null, myRate: null,
    secureRates: {
      fixedNet: { baseline: { mode: "fixedNet", monthlyNet: 9000, creditPoints: 2.25, pensionOn: true, pensionRate: 6, pensionBase: "gross" } },
      fixedGross: { baseline: { mode: "fixedGross", monthlyGross: 10314, creditPoints: 4.75 } },
    },
    $: element, openModal() {}, closeModal() {}, toast() {},
    currentMonthKey: () => "2026-08", fmtHours: h => h.toFixed(2),
    monthLabel: k => k, esc: s => s,
    paymentsSumFor: () => 0, takingsSumFor: () => 0,
    payTeamMonthKey: "2026-07",
  });
  const chunks = [
    section("function rateOf(empId, monthKey){", "// קוד החתמה לפי עובד"),
    section("const MIN_DEDUCT_MS =", "function fmtHours(h)"),
    section("function monthTotals(empId, rate){", "// 10ג. משמרות אחרונות"),
    section("function payShiftsFor(empId, monthKey){", "// רשימת חודשים שבהם יש לעובד פעילות"),
    section("function payBalanceSnapshot(empId, monthKey){", "function renderPayCard(){"),
  ];
  for (const name of ["pad", "monthKeyOf", "parseIso"]) {
    chunks.push(html.match(new RegExp("^function " + name + "\\([^\\n]*", "m"))[0]);
  }
  vm.runInContext(chunks.join("\n"), context);
  return { context, element };
}
function addShifts(c, empId, hoursPerDay = 8, days = 10) {
  for (let d = 1; d <= days; d++) {
    const at = +new Date(2026, 6, d, 8);
    c.shifts[empId + d] = { employeeId: empId, clockIn: at, clockOut: at + hoursPerDay * 3600000 };
  }
}

test("gross cost is exact for gross-based salaries and grossed up for net-based ones", () => {
  const { context: c } = harness();
  addShifts(c, "grossHourly"); addShifts(c, "netHourly");
  const grossHourly = c.empGrossCost("grossHourly", "2026-07");
  sameCost(grossHourly, { gross: 4000, estimated: false, unknown: false });

  const netHourly = c.empGrossCost("netHourly", "2026-07");
  assert.equal(netHourly.estimated, true);
  assert.equal(netHourly.unknown, false);
  assert.ok(netHourly.gross > 4000, "net hourly must gross up above the net pay");
  const emp = { ...c.payrollEmployee("netHourly", "2026-07"), netIsNet: false };
  close(c.estimateNet(netHourly.gross, emp, new Date(2026, 6, 15)).net, 4000, 0.001);

  const fixedGross = c.empGrossCost("fixedGross", "2026-07");
  sameCost(fixedGross, { gross: 10314, estimated: false, unknown: false });
  const fixedGrossNet = c.computeEmpPay("fixedGross", "2026-07").totalPay;
  assert.ok(fixedGrossNet < 10314 && fixedGrossNet > 9000, "fixed gross pays an estimated net below the entered gross");

  const fixedNet = c.empGrossCost("fixedNet", "2026-07");
  assert.equal(fixedNet.estimated, true);
  const fixedEmp = { ...c.payrollEmployee("fixedNet", "2026-07"), netIsNet: false };
  close(c.estimateNet(fixedNet.gross, fixedEmp, new Date(2026, 6, 15)).net, 9000, 0.001);
  assert.ok(fixedNet.gross > 9000);
});

test("an empty month costs nothing and the gross-up helper agrees with the per-hour equivalent", () => {
  const { context: c } = harness();
  sameCost(c.empGrossCost("netHourly", "2026-07"), { gross: 0, estimated: false, unknown: false });
  sameCost(c.empGrossCost("grossHourly", "2026-07"), { gross: 0, estimated: false, unknown: false });
  const emp = c.payrollEmployee("fixedNet", "2026-07");
  const cp = { fixedNet: true, totalPay: 9000, totalH: 180, regH: 160, ot125H: 15, ot150H: 5 };
  const equivalent = c.fixedNetEquivalent(cp, emp, "2026-07");
  const direct = c.grossUpFromNet(9000, { ...emp, netIsNet: false }, new Date(2026, 6, 15), 160 / (160 + 15 * 1.25 + 5 * 1.5));
  close(equivalent.gross, direct.gross, 0.000001);
  close(equivalent.grossPerHour, direct.gross / 180, 0.000001);
  close(c.empGrossCost("fixedNet", "2026-07", cp).gross, direct.gross, 0.000001);
});

test("team totals report the gross cost separately from the balance due and skip inactive employees", () => {
  const { context: c, element: el } = harness();
  addShifts(c, "grossHourly"); addShifts(c, "netHourly"); addShifts(c, "gone");
  c.paymentsSumFor = id => id === "grossHourly" ? 1000 : 0;
  c.takingsSumFor = id => id === "fixedNet" ? 300 : 0;
  const t = c.teamMonthTotals("2026-07");
  const expectedGross = ["grossHourly", "netHourly", "fixedNet", "fixedGross"].reduce((s, id) => s + c.empGrossCost(id, "2026-07").gross, 0);
  close(t.grossCost, expectedGross, 0.000001);
  assert.equal(t.grossEstimatedCount, 2);
  assert.equal(t.grossUnknownCount, 0);
  assert.equal(t.count, 4);
  close(t.gross, 4000 + 4000 + 9000 + c.computeEmpPay("fixedGross", "2026-07").totalPay);
  close(t.due, t.gross - 1300);
  assert.ok(t.grossCost > t.gross, "gross cost includes the grossed-up net salaries");

  c.renderPayTeamSummary();
  const out = el("payTeamSummary").innerHTML;
  assert.match(out, /ברוטו כל העובדים · משוער/);
  assert.match(out, new RegExp("₪" + Math.round(t.grossCost).toLocaleString("he-IL").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /2 עובדים שמוגדרים נטו/);
  assert.match(out, /נותר לשלם לצוות/);
  assert.doesNotMatch(out, /לא ניתן היה לאמוד/);
});

test("a team with only gross-based salaries shows the gross cost without an estimate tag", () => {
  const { context: c, element: el } = harness();
  c.employees.netHourly.active = false;
  c.employees.fixedNet.active = false;
  addShifts(c, "grossHourly");
  const t = c.teamMonthTotals("2026-07");
  close(t.grossCost, 4000 + 10314);
  assert.equal(t.grossEstimatedCount, 0);
  c.renderPayTeamSummary();
  const out = el("payTeamSummary").innerHTML;
  assert.match(out, /ברוטו כל העובדים<\/span>/);
  assert.doesNotMatch(out, /משוער/);
  assert.match(out, /לפני תשלומים, הקפות וניכויים/);
});
