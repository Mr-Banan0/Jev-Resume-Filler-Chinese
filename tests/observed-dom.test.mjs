import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<form><h2>教育经历</h2><label for="date">结束时间</label><input id="date" readonly aria-haspopup="dialog" aria-controls="calendar">'+
  '<button id="add">补充一段经历</button><div id="calendar" role="listbox"><button role="option">2026</button></div>'+
  '<dl><dt>生源地*</dt><dd><input readonly value="广东省-广州市-荔湾区"><span class="inputTip">请选择生源地</span></dd></dl>'+
  '<dl><dt>学习方式*</dt><dd><span>请选择学习方式</span></dd></dl>'+
  '<dl><dt>入离职时间*</dt><dd><div><span style="cursor:pointer">请选择</span></div>—'+
  '<div><span style="cursor:pointer">请选择</span></div></dd></dl>'+
  Array.from({length:400},(_,i)=>`<input aria-label="扩展字段 ${i}">`).join('')+'</form>',
  {runScripts:'outside-only',pretendToBeVisual:true,url:'https://unseen.example.test/resume'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.()}};
for(const path of ['widget-drivers.js','platform-drivers.js','content.js']) {
  window.eval(readFileSync(new URL(`../content/${path}`,import.meta.url),'utf8'));
}
const snapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
const date=snapshot.elements.find(control=>control.label==='结束时间');
assert.equal(date.observed.readonly,true);
assert.equal(date.observed.controls,'calendar');
assert.ok(date.observed.capabilities.includes('CLICK'));
assert.ok(!date.observed.capabilities.includes('TYPE_TEXT'));
assert.ok(snapshot.elements.some(control=>control.label==='补充一段经历'));
assert.equal(snapshot.elements.filter(control=>control.label==='生源地').length,1,
  '静态校验提示与真实输入框共享字段时，候选只提供真实输入框');
assert.equal(snapshot.observationCoverage.complete,false);
assert.ok(Object.values(snapshot.observationCoverage.omittedBySection).reduce((a,b)=>a+b,0)>0);
assert.ok(snapshot.elements.every(control=>control.observed && control.stableKey));
window.document.querySelectorAll('input[aria-label^="扩展字段"]').forEach(node=>node.remove());
const compact=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
assert.ok(compact.elements.some(control=>control.label==='学习方式' && control.kind==='observed-field'),
  '只有展示槽的自定义选择器继续提供可观察的点击目标');
assert.deepEqual(Array.from(compact.elements.filter(control=>control.questionLabel==='入离职时间'),control=>control.label),
  ['入离职时间（开始）','入离职时间（结束）'],'同一时间行按实际位置提供开始与结束的独立语义');
const description=window.document.createElement('textarea');
description.setAttribute('aria-label','实践内容');
description.value='字数控制在500个汉字以内';
let fakeKeys=0;
description.addEventListener('keyup',()=>{fakeKeys++;description.value=description.value.replace(/[.%-]/g,'');});
window.document.querySelector('form').append(description);
const withDescription=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
const observedDescription=withDescription.elements.find(control=>control.label==='实践内容');
assert.equal(observedDescription.maxLength,500,'字段示例值中的字数上限进入输入约束');
const text='模型 Qwen2.5-14B，F1 从 14.61% 提升至 91.53%。';
const typed=await new Promise(resolve=>listeners[0]({type:'EXECUTE',action:'type_text',index:observedDescription.index,value:text},{},resolve));
assert.equal(typed.ok,true);
assert.equal(description.value,text);
assert.equal(fakeKeys,0,'粘贴式输入仅产生输入与变更事件，保持字符与数值完整');
description.addEventListener('input',()=>{description.value=description.value.replace(/[.%-]/g,'');});
const variant=await new Promise(resolve=>listeners[0]({type:'EXECUTE',action:'type_text',index:observedDescription.index,value:text},{},resolve));
assert.equal(variant.ok,true);
assert.equal(description.value.normalize('NFKC'),text.normalize('NFKC'),
  '网站过滤半角符号时，以全角等价形式保留小数、百分数与模型名');
const titleRow=window.document.createElement('dl');
titleRow.innerHTML='<dt>论著名称</dt><dd><input value="'+ 'x'.repeat(80) +'"><span class="inputTip">论著名称长度不能大于50</span></dd>';
window.document.querySelector('form').append(titleRow);
const limitSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
const titleControl=limitSnapshot.elements.find(c=>c.label==='论著名称');
assert.equal(titleControl.maxLength,50,'保存后显露的长度校验进入字段约束');
assert.equal(titleControl.validationError,'论著名称长度不能大于50');
titleRow.querySelector('input').value='Short paper title';
const correctedSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
assert.equal(correctedSnapshot.elements.find(c=>c.label==='论著名称').validationError,undefined,
  '已满足具体长度上限的修正值等待保存，不被旧提示重复判错');
const selectRow=window.document.createElement('dl');
selectRow.innerHTML='<dt>院校性质</dt><dd><div><span style="cursor:pointer">请选择</span></div><span class="inputTip">请选择院校性质</span></dd>';
window.document.querySelector('form').append(selectRow);
const selectSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
assert.equal(selectSnapshot.elements.filter(c=>c.label==='院校性质').length,1,
  '自定义显示槽旁的校验提示只提供错误证据，保持独立于可填字段');
assert.equal(selectSnapshot.elements.find(c=>c.label==='院校性质').validationError,'请选择院校性质');
const addRow=window.document.createElement('dl');
addRow.innerHTML='<dt>教育经历</dt><dd><div style="cursor:pointer">添加新的 教育经历</div></dd>';
window.document.querySelector('form').append(addRow);
const withAdd=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
const addControl=withAdd.elements.find(c=>/添加新的/.test(c.label));
assert.ok(addControl,'定义项里的新增入口保持入口语义');
assert.equal(addControl.observed.field,false,'新增入口的父级 caption 提供分区信息，入口自身保持动作身份');
const compositeRow=window.document.createElement('dl');
compositeRow.innerHTML='<dt>归属地点</dt><dd><input readonly aria-label="省选择"><input readonly aria-label="城市选择"></dd>';
window.document.querySelector('form').append(compositeRow);
const compound=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
assert.deepEqual(Array.from(compound.elements.filter(c=>c.questionLabel==='归属地点'),c=>c.observed.composite.position),[0,1]);
assert.ok(compound.elements.filter(c=>c.questionLabel==='归属地点').every(c=>c.observed.composite.count===2),
  '同 caption 的独立省市控件携带槽位与邻居值证据');
dom.window.close();
console.log('Observed DOM: readonly capability, ARIA relationship, unfamiliar button and truncation evidence passed');
