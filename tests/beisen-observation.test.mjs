import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan } from '../lib/jev-client.js';

const dom = new JSDOM(`<!doctype html><html><body>
  <h2>个人信息</h2>
  <div class="form-row"><div class="field-title">姓名 *</div><div><input placeholder="请输入"></div></div>
  <div class="form-row"><div class="field-title">邮箱 *</div><div><input placeholder="请输入"></div></div>
  <h2>教育经历</h2>
  <div class="form-row"><div class="field-title">学校名称 *</div><div><input placeholder="请输入"></div></div>
  <h2>家庭情况</h2>
  <div class="form-row"><div class="field-title">家属姓名 *</div><div><input placeholder="请输入"></div></div>
  </body></html>`, {runScripts:'outside-only',pretendToBeVisual:true,url:'https://dongguanbank1.zhiye.com/form'});
const {window} = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.(),lastError:null}};
window.eval(readFileSync(new URL('../content/widget-drivers.js',import.meta.url),'utf8'));
window.eval(readFileSync(new URL('../content/platform-drivers.js',import.meta.url),'utf8'));
window.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const result=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const fields=result.elements.filter(el=>el.kind==='input');
assert.deepEqual(Array.from(fields,el=>el.label),['姓名','邮箱','家属姓名']);
assert.deepEqual(Array.from(fields,el=>el.section),['个人信息','个人信息','家庭情况']);
const schoolLookup=result.elements.find(el=>el.label==='学校名称');
assert.equal(schoolLookup?.kind,'combobox','学校名称应进入联想选择事务');
assert.equal(schoolLookup?.section,'教育经历');
const leadingRequired=window.document.createElement('div');
leadingRequired.className='form-row';
leadingRequired.innerHTML='<div class="field-title">* 证件号码</div><div><input placeholder="请输入"></div>';
window.document.body.append(leadingRequired);
const requiredSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.equal(requiredSnapshot.elements.find(el=>el.label==='证件号码')?.required,true,
  '北森标题以星号开头的个人字段必须报告为必填，预填姓名不能让整个分区提前完成');
leadingRequired.remove();
const beisenDate=window.document.createElement('div');
beisenDate.className='form-row';
beisenDate.innerHTML='<div class="field-title">获奖时间 *</div><div class="el-date-editor"><input readonly placeholder="请选择"></div>';
window.document.body.append(beisenDate);
const dateSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const dateField=dateSnapshot.elements.find(el=>String(el.label || '').includes('获奖时间'));
assert.equal(dateField?.kind,'beisen-date','北森 Element UI 日期框应使用确定性日期控件族');
assert.deepEqual(Array.from(dateField?.operations || []),['PICK_DATE']);
assert.equal(dateField?.required,true);
beisenDate.remove();
window.document.querySelectorAll('.form-row')[3]?.remove();
const familyRows=window.document.createElement('div');
familyRows.innerHTML=`<h2>家庭情况</h2>
  <div class="form-row"><div class="field-title">姓名 *</div><input placeholder="请输入"></div>
  <div class="form-row"><div class="field-title">与本人关系 *</div><input placeholder="请输入"></div>
  <div class="form-row"><div class="field-title">姓名 *</div><input placeholder="请输入"></div>
  <div class="form-row"><div class="field-title">与本人关系 *</div><input placeholder="请输入"></div>`;
window.document.body.append(familyRows);
const familySnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const familyNames=familySnapshot.elements.filter(el=>el.section==='家庭情况' && el.label==='姓名');
assert.deepEqual(Array.from(familyNames,el=>el.recordIndex),[0,1],
  '北森第二位家庭成员的姓名必须绑定到第二条记录');
const familyPlan=buildActionPlan(familySnapshot.elements.filter(el=>el.section==='家庭情况'),
  {family:[{name:'示例父亲',relationship:'父亲'},{name:'示例母亲',relationship:'母亲'}]},[],{title:'家庭情况'});
assert.equal(familyPlan.actions.find(action=>action.target===familyNames[1].index)?.resumeField,'family[1].name');
const studyPopup=window.document.createElement('div');
studyPopup.innerHTML='<input placeholder="搜索"><div>全国普通高等院校全日制</div><div>海外留学生</div>';
window.document.body.append(studyPopup);
const studySnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(studySnapshot.elements.some(el=>el.context==='popup' && el.label==='全国普通高等院校全日制'),
  '北森搜索式学习形式弹层的选项应进入候选，而非只采集搜索框');
studyPopup.remove();
const invalidMajor=window.document.createElement('div');
invalidMajor.className='form-item';
invalidMajor.innerHTML='<input placeholder="请输入"><span class="form-item__error">必填</span>';
window.document.body.append(invalidMajor);
const invalidSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(invalidSnapshot.elements.some(el=>el.validationError==='必填'),
  '北森输入框虽显示文字但仍有校验错误时应向调度器报告');
invalidMajor.remove();
const calendarPanel=window.document.createElement('div');
calendarPanel.className='el-picker-panel';
calendarPanel.innerHTML='<button class="el-date-picker__prev-btn"></button><button>1900 - 1999</button><table><tr><td>1960-1969</td></tr></table>';
window.document.body.append(calendarPanel);
const calendarSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(calendarSnapshot.elements.some(el=>el.context==='popup' && el.label==='上一页'),
  '北森日期面板的无文字上一页按钮应有可执行语义');
assert.ok(calendarSnapshot.elements.some(el=>el.context==='popup' && el.label==='1960-1969'),
  '北森日期面板的年代格应进入弹层候选');
window.document.addEventListener('keydown', event => {
  if (event.key === 'Escape') calendarPanel.remove();
}, {once:true});
await new Promise(resolve=>listeners[0]({type:'CLOSE_TRANSACTIONS'},{},resolve));
const closedCalendarSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(!closedCalendarSnapshot.elements.some(el=>el.context==='popup' && el.label==='1960-1969'),
  '离开北森日期字段时关闭旧日历，下一分区不会继承陈旧候选');
for (let index = 0; index < 25; index++) {
  const card = window.document.createElement('div');
  card.style.cursor = 'pointer';
  card.textContent = `普通入口 ${index}`;
  window.document.body.append(card);
}
const addEducation = window.document.createElement('div');
addEducation.style.cursor = 'pointer';
addEducation.textContent = '添加教育经历';
window.document.body.append(addEducation);
const longResult = await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(longResult.elements.some(el=>el.kind==='card' && el.label==='添加教育经历'),
  '长表单里的新增记录入口应优先进入控件候选');
const ethnicOptions=window.document.createElement('div');
ethnicOptions.className='constant-main-selector-container';
ethnicOptions.innerHTML='<div class="constant-main-layer-container"><div>汉族</div><div>蒙古族</div></div>';
window.document.body.append(ethnicOptions);
const ethnicResult=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(ethnicResult.elements.some(el=>el.context==='popup' && el.label==='汉族'),
  '北森常量选择器中的民族选项应进入浮层候选');
const firstChoice=ethnicOptions.querySelector('.constant-main-layer-container > div');
firstChoice.className='list-item-container';
firstChoice.innerHTML='<svg class="selection-circle"><circle r="4"></circle></svg><span>汉族</span>';
let circleClicks=0;
let circleDowns=0;
const circle=firstChoice.querySelector('circle');
firstChoice.querySelector('svg').addEventListener('click',()=>circleClicks++);
circle.addEventListener('mousedown',()=>circleDowns++);
window.document.elementFromPoint=()=>circle;
const choiceSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const hanOption=choiceSnapshot.elements.find(el=>el.context==='popup' && el.label==='汉族');
assert.ok(hanOption);
await new Promise(resolve=>listeners[0]({type:'EXECUTE',action:'click',index:hanOption.index},{},resolve));
assert.equal(circleClicks,1,'北森选项应命中同行单选圆圈');
assert.equal(circleDowns,0,'北森选项一次选择只触发一次切换事件');
const regionHost=window.document.createElement('div');
regionHost.innerHTML='<div class="form-item"><div class="form-item__title">籍贯</div><div class="phoenix-select"><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input" readonly></li><svg class="selector-arrow"></svg></div></div>';
window.document.body.append(regionHost);
let regionOpens=0;
regionHost.querySelector('.phoenix-select').addEventListener('click',()=>regionOpens++);
const regionSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const regionControl=regionSnapshot.elements.find(el=>el.label==='籍贯' && el.kind==='custom-select');
assert.ok(regionControl,'籍贯选择器应识别为可点击字段');
await new Promise(resolve=>listeners[0]({type:'EXECUTE',action:'click',index:regionControl.index},{},resolve));
assert.equal(regionOpens,1,'点击籍贯输入区时应命中北森选择器容器');
ethnicOptions.remove();
const areaPopup=window.document.createElement('div');
areaPopup.className='area-selector-container';
areaPopup.innerHTML='<div class="area-item">浙江省</div><div class="area-item">杭州市</div><button>确定</button>';
window.document.body.append(areaPopup);
window.document.elementFromPoint=()=>areaPopup;
const areaSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(areaSnapshot.elements.some(el=>el.context==='popup' && el.label==='浙江省'),
  '地区弹层省份应成为局部候选');
window.document.body.innerHTML='<div class="form-item"><div class="form-item__title">民族</div><div class="phoenix-select"><input readonly></div></div>';
const ethnicTrigger=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
await new Promise(resolve=>listeners[0]({type:'EXECUTE',action:'click',index:ethnicTrigger.elements.find(e=>e.label==='民族').index},{},resolve));
const compoundSelector=window.document.createElement('div');
compoundSelector.className='constant-main-selector-container';
compoundSelector.style.position='absolute';
compoundSelector.innerHTML='<input placeholder="搜索"><div><div class="list-item-container"><span>汉族</span></div><div class="list-item-container"><span>回族</span></div></div><div><button>取消</button><button>确定</button></div>';
window.document.body.append(compoundSelector);
window.document.elementFromPoint=()=>compoundSelector;
const compoundSnapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
assert.ok(compoundSnapshot.elements.some(e=>e.context==='popup' && e.label==='汉族'));
assert.ok(compoundSnapshot.elements.some(e=>e.context==='popup' && e.label==='确定'),
  '复合选择器的完整表面同时保留选项和确认，避免反复切换同一选项');
console.log('beisen observation tests passed');
