/* Browser/Node helpers for creating paged PDFs from the existing RTL report. */
(function(root, factory){
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.ReportPdf=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const A4_WIDTH=595.28, A4_HEIGHT=841.89, MARGIN=18;

  // Move a page break above a row/block instead of cutting it in half.
  // Oversized blocks still make progress, one page at a time.
  function pageSlices(height, limit, blocks){
    if(!Number.isFinite(height) || height<=0 || !Number.isFinite(limit) || limit<1) throw new Error('Invalid report size');
    height=Math.ceil(height); limit=Math.floor(limit);
    // Adjacent rows must share the same integer pixel boundary. Flooring only
    // the break would make a fractional border overlap the preceding row.
    const ranges=(blocks||[])
      .filter(b=>Number.isFinite(b.top)&&Number.isFinite(b.bottom)&&b.bottom>b.top)
      .map(b=>({top:Math.round(b.top),bottom:Math.round(b.bottom)}));
    const result=[];
    for(let start=0; start<height;){
      const maximum=Math.min(height,start+limit);
      let end=maximum, changed=true;
      while(changed && end<height){
        changed=false;
        for(const b of ranges){
          if(b.top>start && b.top<end && b.bottom>end){
            const next=Math.floor(b.top);
            if(next>start && next<end){ end=next; changed=true; }
          }
        }
      }
      if(end<=start) end=maximum;
      result.push({start,height:end-start}); start=end;
    }
    return result;
  }

  async function fromCanvas(canvas, blocks, PDFDocument, createCanvas, title){
    if(!canvas || canvas.width<=0 || canvas.height<=0) throw new Error('Empty report');
    const contentWidth=A4_WIDTH-2*MARGIN;
    const maxHeight=canvas.width*(A4_HEIGHT-2*MARGIN)/contentWidth;
    const slices=pageSlices(canvas.height,maxHeight,blocks);
    const pdf=await PDFDocument.create();
    if(title) pdf.setTitle(title);
    pdf.setCreator('Works attendance');
    const part=createCanvas();
    try{
      for(let i=0; i<slices.length; i++){
        const slice=slices[i];
        part.width=canvas.width; part.height=slice.height;
        const ctx=part.getContext('2d');
        if(!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(canvas,0,slice.start,canvas.width,slice.height,0,0,canvas.width,slice.height);
        const png=await pdf.embedPng(part.toDataURL('image/png'));
        const page=pdf.addPage([A4_WIDTH,A4_HEIGHT]);
        const imageHeight=slice.height*contentWidth/canvas.width;
        page.drawImage(png,{x:MARGIN,y:A4_HEIGHT-MARGIN-imageHeight,width:contentWidth,height:imageHeight});
        page.drawText((i+1)+' / '+slices.length,{x:A4_WIDTH/2-10,y:7,size:8});
      }
      return new Blob([await pdf.save()],{type:'application/pdf'});
    }finally{
      // Release the temporary backing store, especially on mobile Safari.
      part.width=0; part.height=0;
    }
  }
  return {pageSlices,fromCanvas};
});
