import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {actionPermission} from '../lib/action-policy.js';
import {pageBoundaryReason,pageRouteKey} from '../lib/page-state.js';

const routes=new Set([pageRouteKey({url:'https://synthetic.example/form?step=1'})]);
assert.equal(pageBoundaryReason({url:'https://synthetic.example/form?step=2#education'},routes),'');
assert.match(pageBoundaryReason({url:'https://synthetic.example/campus/jobs'},routes),/停止填写/);
assert.equal(actionPermission({kind:'action',label:'预览并提交',operations:['CLICK']}).allowed,false);

const dom=new JSDOM(`<section><h2>个人信息</h2><div class="form-item">
  <label>最高学历</label><div class="phoenix-select"><input readonly placeholder="请选择"></div>
  </div></section><div id="footer" style="position:fixed"><button>暂存</button>
  <button id="cancel">取消</button><button>预览并提交</button></div>`,
  {url:'https://synthetic.example/form',runScripts:'outside-only',pretendToBeVisual:true});
const {window}=dom;let handler,cancels=0;
const footer=window.document.querySelector('#footer');
window.HTMLElement.prototype.getBoundingClientRect=function(){
  const top=footer.contains(this)?160:100;
  return {top,left:10,right:210,bottom:top+30,width:200,height:30};
};
window.document.elementFromPoint=(_x,y)=>y>=160?footer:window.document.querySelector('.phoenix-select input');
window.document.querySelector('#cancel').addEventListener('click',()=>cancels++);
window.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage(){}}};
for(const file of ['widget-drivers.js','platform-drivers.js','content.js'])
  window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
const ask=msg=>new Promise(resolve=>handler(msg,{},resolve));
let snap=await ask({type:'SNAPSHOT_FULL'});
let degree=snap.elements.find(c=>c.label==='最高学历' && c.kind==='custom-select');
assert.ok(degree);
await ask({type:'BEGIN_FIELD_TRANSACTION',index:degree.index});
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(!snap.elements.some(c=>c.context==='popup' && /暂存|取消|预览并提交/.test(c.label)),
  '常驻操作栏保持页面身份，邻近字段的几何位置提供辅助证据');
assert.equal((await ask({type:'CLOSE_TRANSACTIONS'})).ok,true);
assert.equal(cancels,0,'关闭字段事务保持表单的取消按钮原状');
const one=window.document.createElement('div');one.style.position='absolute';
one.innerHTML='<div>合成唯一学位</div>';window.document.body.append(one);
window.document.elementFromPoint=()=>one.firstElementChild;
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(snap.elements.some(c=>c.context==='popup' && c.label==='合成唯一学位'),
  '激活后出现的单结果列表继续提供唯一真实候选');
one.remove();
snap=await ask({type:'SNAPSHOT_FULL'});
degree=snap.elements.find(c=>c.label==='最高学历' && c.kind==='custom-select');
window.document.elementFromPoint=()=>window.document.querySelector('#cancel');
assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:degree.index})).ok,false,
  '真实指针执行前确认目标命中，遮挡时保留字段');
window.document.elementFromPoint=()=>window.document.querySelector('.phoenix-select');
assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:degree.index})).ok,true,
  '指针命中选择器控件的父级包装器时仍识别为有效命中');
dom.window.close();
console.log('Transaction boundaries: persistent footer, occlusion, final submission and route confinement');
