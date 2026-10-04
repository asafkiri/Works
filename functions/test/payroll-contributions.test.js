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
    currentMonthKey: () => "2026-07", fmtHours: h => h.toFixed(2),
    db: { ref: key => ({
      update: async value => { writes.push({ key, value }); Object.assign(context.employees[key.split("/")[1]], value); },
      transaction: async updater => {
        const id=key.split('/')[2];
        const value=updater(context.secureRates[id]??null);
        writes.push({key,value}); context.secureRates[id]=value;
        return {committed:true};
      },
    }) },
  });
  const chunks = [
    section("function rateOf(empId, monthKey){", "// קוד החתמה לפי עובד"),
    section("const MIN_DEDUCT_MS =", "function fmtHours(h)"),
    section("function monthTotals(empId, rate){", "// 10ג. משמרות אחרונות"),
    section("function payShiftsFor(empId, monthKey){", "// רשימת חודשים שבהם יש לעובד פעילות"),
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
  assert.equal(writes.length, 2);
  assert.equal(writes[0].key, "secure/rates/sample");
  assert.equal(writes[1].key, "employees/sample");
  assert.deepEqual(Object.keys(writes[1].value), ['unpaidBreak']);
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

async function fixedHarness(amount=10000) {
  const h=harness(profile);
  h.context.openNetModal('sample');
  h.element('netPayMode').value='fixed';
  h.element('netFixedKind').value='fixedNet';
  h.element('netMonthlyAmount').value=String(amount);
  h.context.netSyncMode();
  await h.context.saveNetSettings();
  return h;
}
function addRoutine(c,month=6) {
  for (const [d,start,hours] of [[5,11,9],[6,8,8],[7,11,9],[8,8,8],[9,11,9],[10,8.5,7]]) {
    const at=+new Date(2026,month,d,Math.floor(start),(start%1)*60);
    c.shifts[d]={employeeId:'sample',clockIn:at,clockOut:at+hours*3600000};
  }
}

test('fixed salary never deducts pension or study fund again, regardless of attendance',async()=>{
  const {context:c,element:el}=await fixedHarness();
  assert.equal(el('netCalcFields').classList.contains('hidden'),false);
  assert.equal(el('netHourlyFields').classList.contains('hidden'),true);
  assert.equal(c.computeEmpPay('sample','2026-07').totalPay,10000);
  addRoutine(c);
  const pay=c.computeEmpPay('sample','2026-07');
  assert.equal(pay.totalPay,10000);
  assert.equal(pay.totalH,50);
  assert.equal(pay.regH,42);
  assert.equal(pay.ot125H,5);
  assert.equal(pay.ot150H,3);
  assert.equal(pay.fixedNet,true);
  assert.equal(c.fixedNetEquivalent(pay,c.payrollEmployee('sample'),'2026-07'),null);
  assert.match(c.fixedNetSummaryHtml(pay,c.payrollEmployee('sample'),'2026-07'),/לאחר סיום החודש/);
  assert.doesNotMatch(c.fixedNetSummaryHtml(pay,c.payrollEmployee('sample'),'2026-07'),/ברוטו משוער|−₪/);
});

test('all estimated gross is divided by actual hours, including overtime pay and both funds',async()=>{
  const {context:c}=await fixedHarness(10058.568825);
  c.currentMonthKey=()=> '2026-08';
  const pay={fixedNet:true,totalPay:10058.568825,totalH:50*52/12,regH:42*52/12,ot125H:5*52/12,ot150H:3*52/12};
  const e=c.payrollEmployee('sample','2026-07');
  const result=c.fixedNetEquivalent(pay,e,'2026-07');
  close(result.grossPerHour,53.805);
  close(result.gross,11657.75);
  close(result.pension,556.92);
  close(result.studyFund,232.05);
  close(result.net,pay.totalPay);
  const summary=c.fixedNetSummaryHtml(pay,e,'2026-07');
  assert.match(summary,/ממוצע ברוטו לשעת עבודה/);
  assert.match(summary,/₪53.81/);
  assert.match(summary,/בונוסים ותוספות/);
  assert.doesNotMatch(summary,/שכר בסיס מקביל|₪51.00/);
  assert.doesNotMatch(summary,/ממוצע נטו לשעה/);
});

test('a bonus included in the entered net increases the all-in gross average without changing hours',async()=>{
  const {context:c}=await fixedHarness();
  c.currentMonthKey=()=> '2026-08';
  // Full-gross contributions remove allocation assumptions from this fixture.
  const e={...profile,pensionBase:'gross',studyFundBase:'gross'};
  const hours={fixedNet:true,totalH:200,regH:170,ot125H:20,ot150H:10};
  const withoutBonus=c.estimateNet(9314,e,new Date(2026,6,15),9314).net;
  const withBonus=c.estimateNet(10314,e,new Date(2026,6,15),10314).net;
  const before=c.fixedNetEquivalent({...hours,totalPay:withoutBonus},e,'2026-07');
  const after=c.fixedNetEquivalent({...hours,totalPay:withBonus},e,'2026-07');
  close(before.grossPerHour,46.57);
  close(after.grossPerHour,51.57);
  close(after.grossPerHour-before.grossPerHour,5);
  assert.match(c.fixedNetSummaryHtml({...hours,totalPay:withBonus},e,'2026-07'),/₪51.57/);
});

test('inverse estimate round-trips tax brackets and independent fund bases',async()=>{
  const {context:c}=await fixedHarness();
  c.currentMonthKey=()=> '2026-08';
  const cp={fixedNet:true,totalH:220,regH:182,ot125H:25,ot150H:13};
  for(const target of [0,8000,10000,18000]) {
    for(const pensionBase of ['regular','gross']) {
      for(const studyFundBase of ['regular','gross']) {
        const e={...profile,pensionBase,studyFundBase,creditPoints:2.25};
        const n=c.fixedNetEquivalent({...cp,totalPay:target},e,'2026-07');
        close(n.net,target);
        close(n.pension,(pensionBase==='regular'?n.regularGross:n.gross)*.06);
        close(n.studyFund,(studyFundBase==='regular'?n.regularGross:n.gross)*.025);
      }
    }
  }
});

test('a new month preserves salary, rate, points and funds from previous months and supports switching back',async()=>{
  const {context:c,element:el}=await fixedHarness();
  addRoutine(c);
  const july=c.computeEmpPay('sample','2026-07');
  const julyProfile=JSON.stringify(c.payrollProfile('sample','2026-07'));
  c.currentMonthKey=()=> '2026-08';
  c.openNetModal('sample');
  el('netMonthlyAmount').value='12000'; el('netPoints').value='2.25';
  el('netStudyFund').checked=false;
  await c.saveNetSettings();
  assert.equal(JSON.stringify(c.payrollProfile('sample','2026-07')),julyProfile);
  assert.equal(c.computeEmpPay('sample','2026-07').totalPay,july.totalPay);
  assert.equal(c.computeEmpPay('sample','2026-08').totalPay,12000);
  el('netEffectiveMonth').value='2026-09'; c.loadNetMonth();
  el('netPayMode').value='hourly'; el('netHourlyRate').value='60';
  await c.saveNetSettings();
  assert.equal(c.payrollProfile('sample','2026-09').mode,'hourly');
  assert.equal(c.rateOf('sample','2026-09'),60);
  assert.equal(c.rateOf('sample','2026-06'),51);
  assert.equal(c.payrollProfile('sample','2026-06').studyFundOn,true);
  assert.equal(c.payrollProfile('sample','2026-07').mode,'fixedNet');
  assert.equal(c.payrollProfile('sample','2026-08').studyFundOn,false);
  // Editing the current month keeps an independently scheduled future change.
  c.openNetModal('sample'); el('netMonthlyAmount').value='12500';
  await c.saveNetSettings();
  assert.equal(c.rateOf('sample','2026-09'),60);
});

test('no hours and incomplete attendance produce clear messages without invalid rates',async()=>{
  const {context:c}=await fixedHarness();
  c.currentMonthKey=()=> '2026-08';
  const e=c.payrollEmployee('sample','2026-07');
  let cp=c.computeEmpPay('sample','2026-07');
  assert.equal(c.fixedNetEquivalent(cp,e,'2026-07'),null);
  assert.match(c.fixedNetSummaryHtml(cp,e,'2026-07'),/אין שעות לחישוב/);
  addRoutine(c);
  c.shifts[5].pendingReview=true;
  c.shifts[6].clockOut=null;
  cp=c.computeEmpPay('sample','2026-07');
  assert.equal(cp.totalH,33);
  assert.equal(cp.incomplete,true);
  assert.equal(cp.totalPay,10000);
  assert.match(c.fixedNetSummaryHtml(cp,e,'2026-07'),/עדיין לא סופי/);
});

test('private salary history works in the employee account without storing pay in public employee records',async()=>{
  const {context:c,writes}=await fixedHarness();
  const record=c.secureRates.sample;
  assert.equal(c.employees.sample.monthlyNet,undefined);
  assert.ok(writes.filter(w=>w.key.startsWith('employees/')).every(w=>!('monthlyNet' in w.value)));
  c.currentRole='employee'; c.currentEmpId='sample'; c.myRate=record; c.secureRates={};
  assert.equal(c.computeEmpPay('sample','2026-07').totalPay,10000);
  assert.equal(c.rateOf('sample','2026-06'),51);
});

test('invalid monthly amounts and retroactive edits are rejected before any write',()=>{
  const {context:c,element:el,writes}=harness(profile);
  c.openNetModal('sample'); el('netPayMode').value='fixed'; el('netFixedKind').value='fixedNet';
  for(const value of ['', '-1','Infinity','10000abc']){
    el('netMonthlyAmount').value=value; c.saveNetSettings();
  }
  el('netMonthlyAmount').value='10000'; el('netEffectiveMonth').value='2026-06'; c.saveNetSettings();
  assert.equal(writes.length,0);
});

test('manager view, balances and accountant report use the fixed net without phantom shift wages',async()=>{
  const {context:c,element:el}=await fixedHarness();
  addRoutine(c); c.currentMonthKey=()=> '2026-08';
  Object.assign(c,{
    paySubEmpId:'sample', paySelMonthKey:'2026-07',
    takingsListFor:()=>[{chargeCents:50000}], paymentsListFor:()=>[{amount:2000,createdAt:1}],
    takingsSumFor:()=>500, paymentsSumFor:()=>2000,
    fmtDate:()=> '05/07/2026', fmtTime:()=> '08:00', monthLabel:k=>k,
    esc:s=>s, hakafaDataReady:()=>true, giftMoney:n=>(n/100).toFixed(2),StoreGifts:{cents:n=>n*100},
  });
  vm.runInContext([
    section('function payBalanceSnapshot(empId, monthKey){','function payEmployeeSummaryHtml('),
    section('function renderPayDetail(){','let payFullMonthBusy='),
    section('function payReportData(){','// ---------- PDF (הדפסה)'),
  ].join('\n'),c);
  const balance=c.payBalanceSnapshot('sample','2026-07');
  assert.equal(balance.wage,10000); assert.equal(balance.balance,7500);
  c.renderPayDetail();
  assert.match(el('payBody').innerHTML,/נטו חודשי קבוע/);
  assert.doesNotMatch(el('payBody').innerHTML,/class="pl-amt"|שכר ברוטו לפי שעות/);
  const report=c.accountantReportHtml(c.payReportData());
  assert.match(report,/נטו חודשי קבוע: ₪10000/);
  assert.doesNotMatch(report,/תעריף לשעה/);
  c.shifts={};
  assert.equal(c.payReportData().totalPay,10000);
});

async function grossHarness() {
  const h=harness({...profile,creditPoints:4.75});
  const {context:c,element:el}=h;
  c.openNetModal('sample');
  el('netPayMode').value='fixed'; el('netFixedKind').value='fixedGross';
  c.netChangeFixedKind();
  el('netMonthlyAmount').value='10314';
  el('netPensionFixedBase').value='amount'; el('netPensionBaseAmount').value='7280';
  el('netStudyFundFixedBase').value='amount'; el('netStudyFundBaseAmount').value='7280';
  c.netSyncMode();
  await c.saveNetSettings();
  assert.equal(c.payrollProfile('sample').mode,'fixedGross');
  return h;
}

test('fixed gross uses the supplied payslip bases and is independent of attendance',async()=>{
  const {context:c,element:el}=await grossHarness();
  const emp=c.payrollEmployee('sample');
  const n=c.estimateNet(10314,emp,new Date(2026,6,15));
  close(n.pension,436.8); close(n.studyFund,182);
  close(n.ni,262.8812); close(n.health,383.7956);
  // The existing estimator does not include the pension income-tax credit.
  // Do not falsely assert an exact match to the payslip's 9048 net.
  close(n.incomeTax,29.3); close(n.net,9019.2232);
  const empty=c.computeEmpPay('sample','2026-07');
  close(empty.totalPay,9019.22); assert.equal(empty.monthlyGross,10314);
  assert.equal(empty.fixedGross,true); assert.equal(empty.fixedNet,false);
  addRoutine(c);
  const worked=c.computeEmpPay('sample','2026-07');
  assert.equal(worked.totalPay,empty.totalPay); assert.equal(worked.totalH,50);
  assert.equal(worked.monthlyGross,10314);
  assert.equal(el('netHourlyFields').classList.contains('hidden'),true);
  assert.equal(el('netPensionVariableBaseWrap').classList.contains('hidden'),true);
  assert.equal(el('netPensionFixedBaseWrap').classList.contains('hidden'),false);
  assert.equal(el('netContributionOtNote').classList.contains('hidden'),true);
  const open=c.fixedSalarySummaryHtml(worked,emp,'2026-07');
  assert.match(open,/לאחר סיום החודש/); assert.match(open,/נטו משוער/);
  assert.doesNotMatch(open,/ממוצע ברוטו לשעת עבודה/);
  c.currentMonthKey=()=> '2026-08';
  const summary=c.fixedSalarySummaryHtml({...worked,totalH:200},emp,'2026-07');
  assert.match(summary,/₪51.57/); assert.match(summary,/בונוסים ותוספות/);
  assert.match(summary,/זיכוי על הפקדות לפנסיה/);
  assert.doesNotMatch(summary,/כל הברוטו המשוער|ברוטו נאמד/);
  assert.match(c.fixedSalarySummaryHtml({...worked,totalH:0},emp,'2026-07'),/אין שעות לחישוב/);
  assert.match(c.fixedSalarySummaryHtml({...worked,incomplete:true},emp,'2026-07'),/עדיין לא סופי/);
});

test('credit and contribution changes affect fixed-gross net, never gross or average per actual hour',async()=>{
  const {context:c,element:el}=await grossHarness(); addRoutine(c);
  const before=c.computeEmpPay('sample','2026-07');
  c.openNetModal('sample'); el('netPoints').value='9'; await c.saveNetSettings();
  const after=c.computeEmpPay('sample','2026-07');
  close(after.totalPay-before.totalPay,29.3);
  assert.equal(after.monthlyGross,before.monthlyGross);
  const emp=c.payrollEmployee('sample');
  c.currentMonthKey=()=> '2026-08';
  assert.match(c.fixedSalarySummaryHtml(after,emp,'2026-07'),/₪206.28/);
  assert.match(c.fixedSalarySummaryHtml(before,emp,'2026-07'),/₪206.28/);
  const full=c.estimateNet(10314,{...emp,pensionBase:'gross'},new Date(2026,6,15));
  close(full.pension,618.84); close(full.studyFund,182);
  const mixed=c.estimateNet(10314,{...emp,studyFundBase:'amount',studyFundBaseAmount:6000},new Date(2026,6,15));
  close(mixed.pension,436.8); close(mixed.studyFund,150);
  const off=c.estimateNet(10314,{...emp,pensionOn:false,studyFundOn:false},new Date(2026,6,15));
  assert.equal(off.pension,0); assert.equal(off.studyFund,0);
});

test('saved fixed-net records reopen under the nested choice and switching type requires a new amount',async()=>{
  const {context:c,element:el,writes}=await fixedHarness(9048);
  c.openNetModal('sample');
  assert.equal(el('netPayMode').value,'fixed'); assert.equal(el('netFixedKind').value,'fixedNet');
  assert.equal(el('netMonthlyAmount').value,9048);
  el('netFixedKind').value='fixedGross'; c.netChangeFixedKind();
  assert.equal(el('netMonthlyAmount').value,'');
  const count=writes.length;
  await c.saveNetSettings(); assert.equal(writes.length,count);
  el('netFixedKind').value='fixedNet'; c.netChangeFixedKind();
  el('netMonthlyAmount').value='9048'; await c.saveNetSettings();
  assert.equal(c.computeEmpPay('sample','2026-07').totalPay,9048);
});

test('gross salary and contribution bases stay private and monthly history preserves all three salary modes',async()=>{
  const {context:c,element:el,writes}=await grossHarness();
  const july=JSON.stringify(c.payrollProfile('sample','2026-07'));
  c.currentMonthKey=()=> '2026-08'; c.openNetModal('sample');
  assert.equal(el('netFixedKind').value,'fixedGross');
  assert.equal(el('netPensionBaseAmount').value,7280);
  el('netFixedKind').value='fixedNet'; c.netChangeFixedKind(); el('netMonthlyAmount').value='9048';
  await c.saveNetSettings();
  assert.equal(c.payrollProfile('sample','2026-08').mode,'fixedNet');
  assert.equal(c.computeEmpPay('sample','2026-08').totalPay,9048);
  el('netEffectiveMonth').value='2026-09'; c.loadNetMonth();
  el('netPayMode').value='hourly'; el('netHourlyRate').value='60'; await c.saveNetSettings();
  assert.equal(c.rateOf('sample','2026-09'),60);
  assert.equal(c.payrollProfile('sample','2026-09').pensionBase,'regular');
  assert.equal(JSON.stringify(c.payrollProfile('sample','2026-07')),july);
  assert.equal(c.rateOf('sample','2026-06'),51);
  assert.equal(c.employees.sample.monthlyGross,undefined);
  assert.equal(c.employees.sample.pensionBaseAmount,undefined);
  assert.ok(writes.filter(w=>w.key.startsWith('employees/')).every(w=>Object.keys(w.value).join()==='unpaidBreak'));
  c.currentRole='employee'; c.currentEmpId='sample'; c.myRate=c.secureRates.sample; c.secureRates={};
  assert.equal(c.computeEmpPay('sample','2026-07').monthlyGross,10314);
  assert.equal(c.payrollEmployee('sample','2026-07').pensionBaseAmount,7280);
});

test('missing, negative, non-finite and oversized contribution bases cannot be saved',async()=>{
  const {context:c,element:el,writes}=await grossHarness();
  c.openNetModal('sample'); const count=writes.length;
  for(const id of ['netPensionBaseAmount','netStudyFundBaseAmount']){
    for(const value of ['', '-1', 'Infinity', '7280abc', '10315']){
      el(id).value=value; await c.saveNetSettings(); assert.equal(writes.length,count);
    }
    el(id).value='7280';
  }
  el('netPensionFixedBase').value='gross'; c.netSyncContributionHelp();
  assert.equal(el('netPensionBaseAmountWrap').classList.contains('hidden'),true);
  el('netPensionBaseAmount').value=''; await c.saveNetSettings();
  assert.equal(writes.length,count+2);
  assert.equal(c.payrollEmployee('sample').pensionBase,'gross');
});

test('fixed-gross balances and manager report use estimated net once and retain the entered gross',async()=>{
  const {context:c,element:el}=await grossHarness(); addRoutine(c);
  Object.assign(c,{
    paySubEmpId:'sample',paySelMonthKey:'2026-07',
    takingsListFor:()=>[{chargeCents:50000}],paymentsListFor:()=>[{amount:2000,createdAt:1}],
    takingsSumFor:()=>500,paymentsSumFor:()=>2000,
    fmtDate:()=> '05/07/2026',fmtTime:()=> '08:00',monthLabel:k=>k,
    esc:s=>s,hakafaDataReady:()=>true,giftMoney:n=>(n/100).toFixed(2),StoreGifts:{cents:n=>n*100},
  });
  vm.runInContext([
    section('function payBalanceSnapshot(empId, monthKey){','function payEmployeeSummaryHtml('),
    section('function renderPayDetail(){','let payFullMonthBusy='),
    section('function payReportData(){','// ---------- PDF (הדפסה)'),
  ].join('\n'),c);
  const balance=c.payBalanceSnapshot('sample','2026-07');
  close(balance.wage,9019.22); close(balance.balance,6519.22);
  c.renderPayDetail();
  assert.match(el('payBody').innerHTML,/ברוטו חודשי קבוע/);
  assert.match(el('payBody').innerHTML,/נטו משוער מברוטו קבוע/);
  assert.doesNotMatch(el('payBody').innerHTML,/class="pl-amt"|שכר ברוטו לפי שעות/);
  const report=c.accountantReportHtml(c.payReportData());
  assert.match(report,/ברוטו חודשי קבוע: ₪10314/); assert.match(report,/נטו משוער: ₪9019.22/);
  assert.match(report,/בסיס חודשי מהתלוש · ₪7280/); assert.doesNotMatch(report,/נטו מוסכם|תעריף לשעה/);
  c.shifts={}; assert.equal(c.payReportData().ot.monthlyGross,10314);
});

test('creating a monthly gross employee uses the nested option and writes the gross only to the private node',async()=>{
  const {context:c,element:el}=harness();
  const saved=[];
  Object.assign(c,{TS:123,db:{ref:()=>({push:()=>({key:'created'}),update:async value=>saved.push(value)})}});
  vm.runInContext(section('function newEmpSyncPayMode(clearAmount){','// הגדרה/שינוי של קוד החתמה'),c);
  el('newEmpPayMode').value='fixed'; el('newEmpFixedKind').value='fixedGross';
  c.newEmpSyncPayMode(true);
  assert.equal(el('newEmpFixedFields').classList.contains('hidden'),false);
  assert.equal(el('newEmpRateLabel').textContent,'ברוטו קבוע לחודש (₪)');
  el('newEmpName').value='Test'; el('newEmpRate').value='10314'; el('newEmpUser').value='test';
  el('newEmpPass').value='example-only'; el('newEmpPin').value='1234';
  c.addEmployee(); await Promise.resolve();
  assert.equal(saved.length,1);
  assert.equal(saved[0]['employees/created'].monthlyGross,undefined);
  const record=saved[0]['secure/rates/created'];
  assert.equal(record.history['2026-07'].mode,'fixedGross');
  assert.equal(record.history['2026-07'].monthlyGross,10314);
  assert.equal(el('newEmpPayMode').value,'hourly');
  assert.equal(el('newEmpFixedFields').classList.contains('hidden'),true);
});
