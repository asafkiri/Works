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
  sameCost(grossHourly, { gross: 4000, regularGross: 4000, estimated: false, unknown: false, netOnly: false });

  // "Net is net": nothing is defined for the employee, so the net itself is the cost — no gross-up.
  const netHourly = c.empGrossCost("netHourly", "2026-07");
  sameCost(netHourly, { gross: 4000, regularGross: 4000, estimated: false, unknown: false, netOnly: true });

  const fixedGross = c.empGrossCost("fixedGross", "2026-07");
  sameCost(fixedGross, { gross: 10314, regularGross: 10314, estimated: false, unknown: false, netOnly: false });
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
  sameCost(c.empGrossCost("netHourly", "2026-07"), { gross: 0, regularGross: 0, estimated: false, unknown: false, netOnly: true });
  sameCost(c.empGrossCost("grossHourly", "2026-07"), { gross: 0, regularGross: 0, estimated: false, unknown: false, netOnly: false });
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
  assert.equal(t.grossEstimatedCount, 1);
  assert.equal(t.grossUnknownCount, 0);
  assert.equal(t.netOnlyCount, 1);
  assert.equal(t.count, 4);
  close(t.gross, 4000 + 4000 + 9000 + c.computeEmpPay("fixedGross", "2026-07").totalPay);
  close(t.due, t.gross - 1300);
  assert.ok(t.grossCost > t.gross, "gross cost includes the grossed-up fixed net salary");
  // Only the fixed-net gross-up and the fixed-gross employee's entered gross lift the gross above the pay totals.
  const fixedGrossNet = c.computeEmpPay("fixedGross", "2026-07").totalPay;
  close(t.grossCost - t.gross, (c.empGrossCost("fixedNet", "2026-07").gross - 9000) + (10314 - fixedGrossNet), 0.000001);

  c.renderPayTeamSummary();
  const out = el("payTeamSummary").innerHTML;
  assert.match(out, /ברוטו כל העובדים · משוער/);
  assert.match(out, new RegExp("₪" + Math.round(t.grossCost).toLocaleString("he-IL").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /עובד אחד שמוגדר ״נטו זה נטו״ נספר בנטו בלבד/);
  assert.match(out, /אצל עובד אחד עם נטו חודשי קבוע/);
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
  assert.match(out, /עלות מעביד<\/div>/);
});

const REDUCED = 7703, MAX = 51910;
const adultNi = gross => Math.min(gross, REDUCED) * 0.0451 + Math.max(0, Math.min(gross, MAX) - REDUCED) * 0.076;

test("employer cost adds the employer's national insurance, pension, severance and study fund on top of gross", () => {
  const { context: c } = harness();
  const emp = { pensionOn: true, pensionBase: "gross", studyFundOn: true, studyFundBase: "regular" };
  const cost = c.estimateEmployerCost(10000, emp, new Date(2026, 6, 15), 8000);
  close(cost.ni, 521.9773, 0.0001);
  close(cost.pension, 650, 0.0001);
  close(cost.severance, 600, 0.0001);
  close(cost.studyFund, 600, 0.0001);
  close(cost.contributions, 521.9773 + 650 + 600 + 600, 0.0001);
  close(cost.total, 10000 + cost.contributions, 0.0001);
  assert.equal(cost.isMinor, false);

  // Saved employer rates replace the statutory defaults; the basis follows the employee's share.
  const custom = c.estimateEmployerCost(10000, { ...emp, employerPensionRate: 7, severanceRate: 8.33, employerStudyFundRate: 5 }, new Date(2026, 6, 15), 8000);
  close(custom.pension, 700, 0.0001);
  close(custom.severance, 833, 0.0001);
  close(custom.studyFund, 400, 0.0001);

  // A payslip basis is capped at the month's gross, and disabled funds cost nothing.
  const capped = c.estimateEmployerCost(5000, { pensionOn: true, pensionBase: "amount", pensionBaseAmount: 7280 }, new Date(2026, 6, 15));
  close(capped.pension, 325, 0.0001);
  close(capped.severance, 300, 0.0001);
  assert.equal(capped.studyFund, 0);
  const none = c.estimateEmployerCost(10000, {}, new Date(2026, 6, 15));
  assert.equal(none.pension + none.severance + none.studyFund, 0);
  close(none.total, 10000 + 521.9773, 0.0001);
});

test("only what is defined for the employee counts: exemption removes employer NI, youth rates under 18, ceiling, net-is-net", () => {
  const { context: c } = harness();
  const asOf = new Date(2026, 6, 15);
  const exempt = c.estimateEmployerCost(10000, { niExempt: true, pensionOn: true, pensionBase: "gross" }, asOf);
  assert.equal(exempt.ni, 0);
  close(exempt.total, 10000 + 650 + 600, 0.0001);
  const netOnly = c.estimateEmployerCost(4000, { netIsNet: true, pensionOn: true, pensionBase: "gross" }, asOf);
  assert.equal(netOnly.netOnly, true);
  assert.equal(netOnly.contributions, 0);
  assert.equal(netOnly.total, 4000);
  const minor = c.estimateEmployerCost(10000, { birthDate: "2010-01-01" }, asOf);
  assert.equal(minor.isMinor, true);
  close(minor.ni, REDUCED * 0.0061 + (10000 - REDUCED) * 0.0212, 0.0001);
  close(c.estimateEmployerCost(60000, {}, asOf).ni, adultNi(60000), 0.0001);
  close(c.estimateEmployerCost(60000, {}, asOf).ni, 3707.1373, 0.0001);
  assert.equal(c.estimateEmployerCost(0, {}, asOf).total, 0);
  // Saved tax settings override the built-in employer rates.
  vm.runInContext("taxCfg={niEmployerRed:0.05,niEmployerFull:0.08,niMinorRed:0.01,niMinorFull:0.02}", c);
  close(c.estimateEmployerCost(10000, {}, asOf).ni, REDUCED * 0.05 + (10000 - REDUCED) * 0.08, 0.0001);
  close(c.estimateEmployerCost(10000, { birthDate: "2010-01-01" }, asOf).ni, REDUCED * 0.01 + (10000 - REDUCED) * 0.02, 0.0001);
  vm.runInContext("taxCfg=null", c);
  const T = c.txParams();
  assert.equal(T.niEmployerRed, 0.0451); assert.equal(T.niEmployerFull, 0.076);
  assert.equal(T.niMinorRed, 0.0061); assert.equal(T.niMinorFull, 0.0212);
});

test("per-employee employer cost builds on the exact or grossed-up gross of each salary mode", () => {
  const { context: c } = harness();
  addShifts(c, "grossHourly"); addShifts(c, "netHourly");
  const asOf = new Date(2026, 6, 15);
  const grossHourly = c.empEmployerCost("grossHourly", "2026-07");
  close(grossHourly.gross, 4000); close(grossHourly.ni, adultNi(4000), 0.0001);
  assert.equal(grossHourly.pension, 0); assert.equal(grossHourly.estimated, false);
  close(grossHourly.total, 4000 + adultNi(4000), 0.0001);

  const fixedGross = c.empEmployerCost("fixedGross", "2026-07");
  close(fixedGross.gross, 10314); close(fixedGross.ni, adultNi(10314), 0.0001);
  assert.equal(fixedGross.estimated, false);

  const fixedNet = c.empEmployerCost("fixedNet", "2026-07");
  const grossUp = c.empGrossCost("fixedNet", "2026-07");
  assert.equal(fixedNet.estimated, true);
  close(fixedNet.gross, grossUp.gross, 0.000001);
  close(fixedNet.pension, grossUp.gross * 0.065, 0.0001);
  close(fixedNet.severance, grossUp.gross * 0.06, 0.0001);
  close(fixedNet.total, grossUp.gross + adultNi(grossUp.gross) + grossUp.gross * 0.125, 0.0001);

  const netHourly = c.empEmployerCost("netHourly", "2026-07");
  assert.equal(netHourly.estimated, false);
  assert.equal(netHourly.netOnly, true);
  assert.equal(netHourly.gross, 4000);
  assert.equal(netHourly.ni, 0);
  assert.equal(netHourly.total, 4000);
  assert.equal(c.empEmployerCost("fixedGross", "2026-07").regularGross, 10314);
  assert.equal(c.estimateEmployerCost(0, c.payrollEmployee("grossHourly", "2026-07"), asOf).total, 0);
});

test("team totals and the summary card show the employer cost with its breakdown", () => {
  const { context: c, element: el } = harness();
  addShifts(c, "grossHourly"); addShifts(c, "netHourly"); addShifts(c, "gone");
  const t = c.teamMonthTotals("2026-07");
  const ids = ["grossHourly", "netHourly", "fixedNet", "fixedGross"];
  const parts = ids.map(id => c.empEmployerCost(id, "2026-07"));
  for (const k of ["gross", "ni", "pension", "severance", "studyFund", "contributions", "total"]) {
    close(t.employerCost[k], parts.reduce((s, p) => s + p[k], 0), 0.000001);
  }
  close(t.employerCost.gross, t.grossCost, 0.000001);
  assert.ok(t.employerCost.total > t.grossCost, "employer cost exceeds gross");
  assert.equal(t.employerCost.studyFund, 0);

  c.renderPayTeamSummary();
  let out = el("payTeamSummary").innerHTML;
  assert.match(out, /עלות מעביד · משוער/);
  assert.match(out, /כמה המעביד מוציא על משכורות החודש/);
  assert.match(out, /ביטוח לאומי · חלק המעסיק/);
  assert.match(out, /פנסיה ופיצויים · חלק המעסיק/);
  assert.doesNotMatch(out, /קרן השתלמות · חלק המעסיק/);
  const money = n => "₪" + Math.round(n).toLocaleString("he-IL").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(out, new RegExp(money(t.employerCost.total)));
  assert.match(out, new RegExp(money(t.employerCost.ni)));
  assert.match(out, new RegExp(money(t.employerCost.pension + t.employerCost.severance)));
  assert.match(out, /הסכום הסופי נקבע בתלושים/);

  c.secureRates.fixedNet.baseline.studyFundOn = true;
  c.secureRates.fixedNet.baseline.studyFundBase = "gross";
  const withFund = c.teamMonthTotals("2026-07");
  close(withFund.employerCost.studyFund, c.empGrossCost("fixedNet", "2026-07").gross * 0.075, 0.0001);
  c.renderPayTeamSummary();
  out = el("payTeamSummary").innerHTML;
  assert.match(out, /קרן השתלמות · חלק המעסיק/);
});

test("the employee detail page folds in the same employer cost estimate", () => {
  const { context: c, element: el } = harness();
  addShifts(c, "grossHourly");
  Object.assign(c, {
    paySubEmpId: "grossHourly", paySelMonthKey: "2026-07", currentMonthKey: () => "2026-08",
    takingsListFor: () => [], paymentsListFor: () => [],
    fmtDate: () => "05/07/2026", fmtTime: () => "08:00", hakafaDataReady: () => true,
    giftMoney: n => (n / 100).toFixed(2), StoreGifts: { cents: n => n * 100 },
  });
  vm.runInContext(section("function renderPayDetail(){", "let payFullMonthBusy="), c);
  c.renderPayDetail();
  const cost = c.empEmployerCost("grossHourly", "2026-07");
  const out = el("payBody").innerHTML;
  assert.match(out, /עלות מעביד משוערת · ₪4,1\d\d/);
  assert.match(out, new RegExp("₪" + Math.round(cost.ni)));
  assert.match(out, /לא הוגדרה פנסיה לעובד/);
  assert.doesNotMatch(out, /ברוטו משוער/);

  c.paySubEmpId = "fixedNet";
  c.renderPayDetail();
  const fixed = el("payBody").innerHTML;
  assert.match(fixed, /ברוטו משוער/);
  assert.match(fixed, /תגמולי מעסיק \(6.5%\)/);
  assert.match(fixed, /פיצויים \(6%\)/);

  // Net is net: the fold shows the net itself as the cost, with no employer additions.
  addShifts(c, "netHourly");
  c.paySubEmpId = "netHourly";
  c.renderPayDetail();
  const netOnly = el("payBody").innerHTML;
  assert.match(netOnly, /עלות מעביד · ₪4,000/);
  assert.match(netOnly, /נטו זה נטו/);
  assert.match(netOnly, /אין — לא הוגדרו הפרשות/);
  assert.doesNotMatch(netOnly, /משוערת|ביטוח לאומי · חלק המעסיק/);

  // An employee marked exempt from national insurance has no employer share either.
  c.employees.grossHourly.niExempt = true;
  c.paySubEmpId = "grossHourly";
  c.renderPayDetail();
  const exempt = el("payBody").innerHTML;
  assert.match(exempt, /עלות מעביד משוערת · ₪4,000/);
  assert.match(exempt, /לא מחושב — מסומן פטור/);
  delete c.employees.grossHourly.niExempt;

  c.shifts = {};
  c.renderPayDetail();
  assert.doesNotMatch(el("payBody").innerHTML, /עלות מעביד משוערת/);
});
