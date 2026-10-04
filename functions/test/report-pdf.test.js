'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ReportPdf=require('../../report-pdf');
const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a); return html.slice(a,b);
}
function harness(){
  const elements={},events=[],timers=[];
  function element(id){
    if(!elements[id]){
      const classes=new Set();
      elements[id]={textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(c,on){if(on)classes.add(c);else classes.delete(c);}},removeAttribute(k){delete this[k];}};
    }
    return elements[id];
  }
  const canvas={width:1588,height:4000};
  const report={getBoundingClientRect:()=>({top:0,width:794,height:2000}),querySelectorAll:()=>[{getBoundingClientRect:()=>({top:950,bottom:980})}]};
  const holder={style:{},firstElementChild:report,setAttribute(){},querySelectorAll:()=>[],remove:()=>events.push('remove holder')};
  const c=vm.createContext({
    $,Blob,File,Promise,console,ReportPdf:{fromCanvas:async(...args)=>{events.push({pdfArgs:args});return new Blob(['%PDF-test'],{type:'application/pdf'});}},
    navigator:{canShare:()=>true,share:async data=>events.push({share:data})},
    URL:{createObjectURL:blob=>{events.push({blob});return 'blob:ready';},revokeObjectURL:url=>events.push({revoked:url})},
    window:{html2canvas:async()=>canvas,PDFLib:{PDFDocument:{}}},
    document:{fonts:{ready:Promise.resolve()},body:{appendChild:()=>events.push('append holder')},head:{appendChild(){}},createElement:tag=>tag==='div'?holder:{remove(){}}},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},
    toast:text=>events.push({toast:text}),openModal:id=>events.push({open:id}),
  });
  function $(id){return element(id);}
  vm.runInContext(section('// Load only when exporting,','// מרנדר HTML של דוח לתמונה'),c);
  vm.runInContext(html.match(/^function closeModal\([^\n]+/m)[0],c);
  return {c,el:element,events,timers,canvas,holder};
}

test('pagination keeps rows intact and covers the whole report exactly once',()=>{
  const slices=ReportPdf.pageSlices(2400,1000,[{top:950,bottom:1040},{top:1880,bottom:1980}]);
  assert.deepEqual(slices,[{start:0,height:950},{start:950,height:930},{start:1880,height:520}]);
  assert.equal(slices.reduce((n,s)=>n+s.height,0),2400);
  assert.deepEqual(ReportPdf.pageSlices(3500,1000,[{top:0,bottom:3500}]),[
    {start:0,height:1000},{start:1000,height:1000},{start:2000,height:1000},{start:3000,height:500}
  ]);
  assert.throws(()=>ReportPdf.pageSlices(100,0));
});

test('PDF builder embeds readable images on A4 pages with margins and releases its crop buffer',async()=>{
  const drawings=[],crops=[],labels=[]; let saved=0;
  const part={getContext:()=>({drawImage:(...args)=>crops.push(args)}),toDataURL:type=>{assert.equal(type,'image/png');return 'png';}};
  const doc={setTitle:title=>assert.equal(title,'דוח אסף'),setCreator(){},embedPng:async()=>({}),addPage:size=>({drawImage:(img,position)=>drawings.push({size,position}),drawText:text=>labels.push(text)}),save:async()=>{saved++;return new Uint8Array([37,80,68,70]);}};
  const canvas={width:1588,height:4800};
  const blob=await ReportPdf.fromCanvas(canvas,[{top:2200,bottom:2350}],{create:async()=>doc},()=>part,'דוח אסף');
  assert.equal(blob.type,'application/pdf'); assert.equal(saved,1);
  assert.equal(drawings.length,3); assert.deepEqual(labels,['1 / 3','2 / 3','3 / 3']);
  assert.equal(crops.reduce((sum,x)=>sum+x[4],0),4800);
  for(const {size,position:p} of drawings){assert.deepEqual(size,[595.28,841.89]);assert.ok(p.y>=18-1e-8);assert.equal(p.x,18);assert.ok(p.height>0);}
  assert.equal(part.width,0); assert.equal(part.height,0);
});

test('adjacent table rows with fractional borders do not push every row to the next page',()=>{
  const rows=Array.from({length:33},(_,i)=>({top:400.5+i*65,bottom:400.5+(i+1)*65}));
  assert.deepEqual(ReportPdf.pageSlices(2746,2288,rows),[
    {start:0,height:2286},{start:2286,height:460}
  ]);
});

test('export prepares a downloadable PDF and shares only on a fresh explicit click',async()=>{
  const {c,el,events,canvas}=harness();
  await c.reportToPdf('<div>דוח</div>','אסף / אוגוסט');
  assert.equal(el('pdfExportOpen').href,'blob:ready');
  assert.equal(el('pdfExportOpen').download,'אסף _ אוגוסט.pdf');
  assert.equal(el('pdfExportActions').classList.contains('hidden'),false);
  assert.equal(events.filter(e=>e.share).length,0);
  const pdf=events.find(e=>e.pdfArgs);
  assert.equal(pdf.pdfArgs[1][0].top,1900);
  assert.equal(pdf.pdfArgs[1][0].bottom,1960);
  assert.equal(canvas.width,0); assert.ok(events.includes('remove holder'));
  await c.sharePreparedPdf();
  const shared=events.find(e=>e.share).share;
  assert.equal(shared.files[0].type,'application/pdf');
  assert.equal(shared.files[0].name,'אסף _ אוגוסט.pdf');
});

test('unsupported file sharing leaves an actionable PDF download',async()=>{
  const {c,el}=harness(); c.navigator.canShare=()=>false;
  await c.reportToPdf('<div>דוח</div>','דוח');
  assert.equal(el('pdfExportShare').classList.contains('hidden'),true);
  assert.equal(el('pdfExportOpen').href,'blob:ready');
});

test('share cancellation is quiet and sharing errors keep the prepared file available',async()=>{
  const {c,el}=harness(); await c.reportToPdf('<div>דוח</div>','דוח');
  const ready=el('pdfExportStatus').textContent;
  c.navigator.share=async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'});};
  await c.sharePreparedPdf(); assert.equal(el('pdfExportStatus').textContent,ready);
  c.navigator.share=async()=>{throw new Error('share failed');};
  await c.sharePreparedPdf(); assert.match(el('pdfExportStatus').textContent,/פתיחה \/ שמירה/);
  assert.equal(el('pdfExportOpen').href,'blob:ready');
});

test('failed rendering shows retry and a retry can successfully create the file',async()=>{
  const {c,el,events,canvas}=harness();let attempts=0;
  c.window.html2canvas=async()=>{if(++attempts===1)throw new Error('render failed');return canvas;};
  await c.reportToPdf('<div>דוח</div>','דוח');
  assert.equal(el('pdfExportRetry').classList.contains('hidden'),false);
  assert.equal(el('pdfExportActions').classList.contains('hidden'),true);
  await el('pdfExportRetry').onclick();
  assert.equal(el('pdfExportOpen').href,'blob:ready');
  assert.equal(events.filter(e=>e==='remove holder').length,2);
});

test('closing during preparation cancels presentation and prevents duplicate concurrent exports',async()=>{
  const {c,el,events,canvas}=harness();let finish;
  c.window.html2canvas=()=>new Promise(resolve=>{finish=resolve;});
  const pending=c.reportToPdf('<div>דוח</div>','דוח');
  for(let i=0; i<20 && !finish; i++) await Promise.resolve();
  assert.equal(typeof finish,'function');
  await c.reportToPdf('<div>דוח שני</div>','דוח שני');
  assert.equal(events.filter(e=>e.open).length,1);
  c.closeModal('pdfExportModal'); finish(canvas); await pending;
  assert.equal(el('pdfExportOpen').href,undefined);
  assert.equal(events.filter(e=>e.blob).length,0);
  assert.ok(events.includes('remove holder')); assert.equal(canvas.width,0);
});

test('closing a completed PDF clears the file and revokes its URL after viewers have time to load',async()=>{
  const {c,el,events,timers}=harness(); await c.reportToPdf('<div>דוח</div>','דוח');
  c.closeModal('pdfExportModal'); await c.sharePreparedPdf();
  assert.equal(el('pdfExportOpen').href,undefined);
  assert.equal(events.filter(e=>e.share).length,0);
  const cleanup=timers.find(t=>t.ms===60000);assert.ok(cleanup);cleanup.fn();
  assert.equal(events.find(e=>e.revoked).revoked,'blob:ready');
});

test('library errors reset the cached loader so the retry downloads a new script',async()=>{
  const {c}=harness(); delete c.window.PDFLib;let scripts=0;
  c.document.head.appendChild=script=>{scripts++;Promise.resolve().then(()=>{if(scripts===1)script.onerror();else{c.window.PDFLib={PDFDocument:{}};script.onload();}});};
  await assert.rejects(c.loadPdfLib());
  assert.ok((await c.loadPdfLib()).PDFDocument);assert.equal(scripts,2);
});

test('both PDF buttons route through file generation without window.print',async()=>{
  const calls=[];
  const c=vm.createContext({payReportData:()=>({e:{name:'אסף'}}),accountantReportHtml:()=>'<div>payroll</div>',paySelMonthKey:'2026-08',reportToPdf:(...args)=>calls.push(args),signedFormHtml:()=>'<div>signed</div>',employees:{sample:{name:'אסף'}},toast(){}});
  vm.runInContext(section('function exportPayrollAccountant(){','// ---------- תמונה'),c);
  vm.runInContext(section('function pdfSignedForm(empId, formId){','/* ============================================================\n   11.'),c);
  c.exportPayrollAccountant();c.pdfSignedForm('sample','form');
  assert.equal(calls.length,2);assert.match(calls[0][1],/2026-08/);
  assert.equal(calls[1][0],'<div>signed</div>');
  assert.doesNotMatch(html,/window\.print\(\)/);
});
