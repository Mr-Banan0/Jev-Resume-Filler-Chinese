import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildActionPlan} from '../lib/jev-client.js';

const dom=new JSDOM(`<body>
  <div class="mFormTime"><input name="birthDate" placeholder="出生日期" readonly></div>
  <div class="layui-laydate" style="display:none"><div class="layui-laydate-header">
    <i class="laydate-prev-y"></i><div class="laydate-set-ym"><span>2026年</span><span>9月</span></div><i class="laydate-next-y"></i>
  </div><div class="layui-laydate-content"><table><tbody><tr><td>10</td></tr></tbody></table></div></div>
</body>`,{url:'https://iter.stongyw.cn/web/school/resume/education_info.html',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;
w.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,left:0,right:200,bottom:30,width:200,height:30});
const doc=w.document, input=doc.querySelector('input'), calendar=doc.querySelector('.layui-laydate');
input.addEventListener('click',()=>calendar.style.display='block');
let rangeEnd=2033,chosenYear='',chosenMonth='';
function renderYears(){
  const list=doc.createElement('ul'); list.className='layui-laydate-list laydate-year-list';
  for(let year=rangeEnd-14;year<=rangeEnd;year++){
    const li=doc.createElement('li');li.textContent=`${year}年`;
    li.addEventListener('click',()=>{chosenYear=String(year);list.remove();});
    list.append(li);
  }
  calendar.querySelector('.layui-laydate-content').append(list);
}
doc.querySelector('.laydate-set-ym span').addEventListener('click',renderYears);
doc.querySelector('.laydate-prev-y').addEventListener('click',()=>{rangeEnd-=15;doc.querySelector('.laydate-year-list').remove();renderYears();});
doc.querySelectorAll('.laydate-set-ym span')[1].addEventListener('click',()=>{
  const list=doc.createElement('ul');list.className='layui-laydate-list laydate-month-list';
  for(let month=1;month<=12;month++){
    const li=doc.createElement('li');li.textContent=`${['一','二','三','四','五','六','七','八','九','十','十一','十二'][month-1]}月`;
    li.addEventListener('click',()=>{chosenMonth=String(month);list.remove();});list.append(li);
  }
  calendar.querySelector('.layui-laydate-content').append(list);
});
doc.querySelector('td').addEventListener('click',()=>{input.value=`${chosenYear}-${chosenMonth.padStart(2,'0')}-10`;});
let handler;
w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:()=>{}}};
w.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const send=msg=>new Promise(resolve=>handler(msg,{},resolve));
const snapshot=await send({type:'SNAPSHOT_FULL'});
const field=snapshot.elements.find(el=>el.label==='出生日期');
assert.equal(field.kind,'layui-date');
assert.equal(JSON.stringify(field.operations),'["PICK_DATE"]');
const plan=buildActionPlan(snapshot.elements,{basics:{birthDate:'2001-02-10'}},[],{title:'个人信息'});
assert.ok(plan.actions.some(action=>action.operation==='PICK_DATE'&&action.resumeField==='basics.birthDate'));
const result=await send({type:'EXECUTE',action:'pick_date',index:field.index,value:'2001-02-10'});
assert.equal(result.ok,true,result.reason);
assert.equal(input.value,'2001-02-10');
const range=doc.createElement('div');range.className='mLeft';
range.innerHTML='<input name="beginTime" placeholder="开始时间" readonly>';
doc.body.append(range);
const rangeField=(await send({type:'SNAPSHOT_FULL'})).elements.find(el=>el.label==='开始时间');
assert.equal(rangeField.kind,'layui-date');
assert.deepEqual(Array.from(rangeField.operations),['PICK_DATE']);
console.log('✓ LayUI 只读日期控件跨年份选择并回读');
