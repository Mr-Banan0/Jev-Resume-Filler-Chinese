import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

for (const numeric of [true,false]) {
  const dom=new JSDOM(`<h2>教育经历</h2>
    <div class="form-item"><label>开始时间</label><input id="date" readonly></div>
    <div class="form-item"><label>导师姓名</label><input id="advisor"></div>
    <div class="el-picker-panel" style="display:none">
      <div><button>2026年</button><button>10月</button></div>
      <div id="grid"><a role="button" id="prev"></a><a role="button" id="year">2026</a><a role="button" id="next"></a><table><tbody></tbody></table></div>
    </div>`,{url:'https://sample.zhiye.com/form',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.HTMLElement.prototype.getBoundingClientRect=()=>({top:10,left:10,right:210,bottom:40,width:200,height:30});
  let handler,year=2026;
  w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:()=>{}}};
  const input=w.document.getElementById('date'),panel=w.document.querySelector('.el-picker-panel');
  const names=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  w.document.querySelector('tbody').innerHTML=Array.from({length:12},(_,i)=>`<tr><td><a>${numeric ? `${i+1}月` : names[i]}</a></td></tr>`).join('');
  input.onclick=()=>panel.style.display='block';
  w.document.getElementById('prev').onclick=()=>w.document.getElementById('year').textContent=String(--year);
  w.document.getElementById('next').onclick=()=>w.document.getElementById('year').textContent=String(++year);
  Array.from(w.document.querySelectorAll('td a')).forEach((cell,i)=>cell.onclick=()=>{
    input.value=`${year}-${String(i+1).padStart(2,'0')}`;
    panel.style.display='none';
  });
  for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
    w.eval(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'));
  }
  const send=msg=>new Promise(resolve=>handler(msg,{},resolve));
  const snap=await send({type:'SNAPSHOT_REQUEST'});
  const target=snap.elements.find(e=>e.label==='开始时间');
  assert.ok(target);
  const result=await send({type:'EXECUTE',action:'pick_date',index:target.index,value:'2021-09-01'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.precision,'month');
  assert.equal(input.value,'2021-09');
  const after=await send({type:'SNAPSHOT_REQUEST'});
  assert.ok(after.elements.some(e=>e.label==='导师姓名'));
  assert.equal(after.elements.find(e=>e.label==='开始时间').datePrecision,'month');
  dom.window.close();
}
for (const wrongDay of [false,true]) {
  const dom=new JSDOM(`<div class="form-item"><label>开始时间</label><input readonly></div>
    <div class="el-picker-panel" style="display:none"><button>2026年</button><button>10月</button>
      <table><tbody><tr>${Array.from({length:31},(_,i)=>`<td>${i+1}</td>`).join('')}</tr></tbody></table></div>`,
    {url:'https://sample.zhiye.com/form',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.HTMLElement.prototype.getBoundingClientRect=()=>({top:10,left:10,right:210,bottom:40,width:200,height:30});
  let handler;
  w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:()=>{}}};
  const input=w.document.querySelector('input'),panel=w.document.querySelector('.el-picker-panel');
  input.onclick=()=>panel.style.display='block';
  Array.from(w.document.querySelectorAll('td')).forEach((cell,i)=>cell.onclick=()=>{
    input.value=`2026-10-${String(wrongDay ? 4 : i+1).padStart(2,'0')}`;
    panel.style.display='none';
  });
  for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
    w.eval(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'));
  }
  const send=msg=>new Promise(resolve=>handler(msg,{},resolve));
  const snap=await send({type:'SNAPSHOT_REQUEST'});
  const result=await send({type:'EXECUTE',action:'pick_date',index:snap.elements.find(e=>e.label==='开始时间').index,value:'2026-10-05'});
  assert.equal(result.ok,!wrongDay,JSON.stringify(result));
  if(wrongDay) assert.equal(result.expected,'2026-10-05','日期回读同时验收年、月、日');
  dom.window.close();
}
console.log('Beisen month/day grids navigate local headers and verify the observed precision exactly');
