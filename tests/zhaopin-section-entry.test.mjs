import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildSectionPlan} from '../lib/jev-client.js';

const dom = new JSDOM(`<!doctype html><html><body>
  <h2>教育经历</h2><div style="cursor:pointer">添加</div>
  <div style="cursor:pointer">个人信息 未完成</div>
  <div style="cursor:pointer">教育经历 未完成</div>
  <div style="cursor:pointer">实习/工作经历 未完成</div>
  <div style="cursor:pointer">求职意向 未完成</div>
  </body></html>`, {runScripts:'outside-only',pretendToBeVisual:true,
  url:'https://xiaoyuan.zhaopin.com/scrd/resume2'});
const {window} = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.(),lastError:null}};
window.eval(readFileSync(new URL('../content/widget-drivers.js',import.meta.url),'utf8'));
window.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const snapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const entries=snapshot.elements.filter(el=>el.kind==='section-entry');
assert.deepEqual(Array.from(entries,el=>el.section),['个人信息','教育经历','实习/工作经历','求职意向']);
const plan=buildSectionPlan(snapshot.elements,{basics:{name:'示例姓名'},education:[{institution:'示例大学'}],expected:{city:'示例城市'}});
assert.deepEqual(plan.actions.filter(action=>action.operation==='FOCUS_SECTION').map(action=>action.section),
  ['个人信息','教育经历','实习/工作经历','求职意向']);
assert.ok(!plan.actions.some(action=>action.operation==='WORK_SECTION'),
  '总览卡片需要先进入分区，再计划字段');
assert.equal(snapshot.page.activeSection,'教育经历');
const activePlan=buildSectionPlan(snapshot.elements,{education:[{institution:'示例大学'}]}, {},snapshot.page);
assert.ok(activePlan.actions.some(action=>action.operation==='ADD_RECORD' && action.section==='教育经历'),
  '当前分区的空列表应优先进入新增记录');
assert.ok(!activePlan.actions.some(action=>action.operation==='FOCUS_SECTION' && action.section==='教育经历'),
  '当前分区不应重复点击导航入口');
console.log('zhaopin section-entry tests passed');
window.document.body.innerHTML='<div class="apply-module__body"><div class="form-content--title-box"><h6>其他信息</h6><span>添加</span></div><div class="el-form-item"><label class="el-form-item__label">自我评价</label><textarea placeholder="请填写"></textarea></div></div><li class="resume-menu-item" style="cursor:pointer"><h6>校园活动经历</h6></li>';
const completeNav=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(completeNav.elements.some(el=>el.kind==='section-entry' && el.section==='校园活动经历'));
assert.equal(completeNav.elements.find(el=>el.label==='自我评价' && el.operations.includes('TYPE_TEXT'))?.section,'其他信息');
assert.equal(completeNav.page.activeSection,'其他信息');

const editDom = new JSDOM(`<!doctype html><html><body>
  <div class="form-content--title-box">个人信息 必填</div>
  <div class="form-content--subtitle">详尽的个人信息能让企业更快的了解您</div>
  <div class="edit" style="cursor:pointer"> 编辑</div>
  <div style="cursor:pointer">个人信息 未完成</div>
  <div class="el-select"><input placeholder="请选择工作类型" readonly></div>
  </body></html>`, {runScripts:'outside-only',pretendToBeVisual:true,
  url:'https://xiaoyuan.zhaopin.com/scrd/resume2'});
const ew=editDom.window;
ew.HTMLElement.prototype.getBoundingClientRect=()=>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const editListeners=[];
ew.chrome={runtime:{onMessage:{addListener:fn=>editListeners.push(fn)},sendMessage:(_msg,cb)=>cb?.(),lastError:null}};
ew.eval(readFileSync(new URL('../content/widget-drivers.js',import.meta.url),'utf8'));
ew.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const editSnapshot=await new Promise(resolve=>editListeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const choiceHost=ew.document.createElement('div');
choiceHost.className='el-select';choiceHost.innerHTML='<span>其他</span>';
ew.document.querySelector('.edit').before(choiceHost);
const markerSnapshot=await new Promise(resolve=>editListeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.equal(markerSnapshot.elements.find(e=>e.label.includes('编辑'))?.section,'个人信息',
  '已选值“其他”保持字段身份，不成为新的分区边界');
assert.equal(editSnapshot.page.activeSection,'个人信息');
assert.ok(editSnapshot.elements.some(el=>el.kind==='custom-select' && el.operations.includes('CLICK')));
assert.equal(editSnapshot.elements.find(el=>el.label.includes('编辑'))?.section,'个人信息');
const editPlan=buildSectionPlan(editSnapshot.elements,{basics:{name:'示例姓名'}},{},editSnapshot.page);
assert.ok(editPlan.actions.some(action=>action.operation==='FOCUS_SECTION' && /编辑个人信息/.test(action.label)));
const photoHost=ew.document.createElement('div');
photoHost.className='el-upload';
photoHost.innerHTML='<div class="uploader-img"><img src="https://mypics.zhaopin.cn/avatar/test.png"></div><input type="file">';
ew.document.body.append(photoHost);
const uploadedPhotoSnapshot=await new Promise(resolve=>editListeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(uploadedPhotoSnapshot.elements.some(el=>el.kind==='file' && el.value==='已上传照片'),
  '证件照预览应作为已上传回执，避免重复上传');
const schoolHost=ew.document.createElement('div');
schoolHost.className='el-autocomplete';
schoolHost.setAttribute('role','combobox');
schoolHost.innerHTML='<div class="el-input"><input role="textbox" placeholder="请填写学校全称"></div>';
ew.document.body.append(schoolHost);
const schoolSnapshot=await new Promise(resolve=>editListeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(schoolSnapshot.elements.some(el=>el.kind==='combobox' &&
  el.placeholder==='请填写学校全称' && el.operations.includes('TYPE_TEXT')),
  `可输入的学校联想框应允许先输入学校全称：${JSON.stringify(schoolSnapshot.elements.filter(el=>el.placeholder==='请填写学校全称'))}`);
schoolHost.querySelector('input').disabled=true;
schoolHost.querySelector('input').value='示例大学';
const disabledSnapshot=await new Promise(resolve=>editListeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const savedSchool=disabledSnapshot.elements.find(el=>el.placeholder==='请填写学校全称');
assert.equal(savedSchool?.value,'示例大学','禁用的已保存字段保留盘点值');
assert.equal(savedSchool?.operations.length,0,'禁用字段只读，执行器不生成写操作');
