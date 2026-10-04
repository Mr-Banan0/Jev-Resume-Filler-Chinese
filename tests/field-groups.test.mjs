import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan, buildFieldGroupAudit, prepareResume } from '../lib/jev-client.js';

const field = (label, control) => `<div class="field"><label>${label}</label>${control}</div>`;
const dom = new JSDOM(`<!doctype html><html><body>
  <h2>个人信息</h2>
  ${field('证件号码', '<div role="combobox" aria-label="请选择"></div><input placeholder="请输入证件号码">')}
  ${field('外语类型', '<div role="combobox" aria-label="外语类型"></div><div role="combobox" aria-label="外语类型"></div>')}
  ${field('外语等级', '<div role="combobox" aria-label="外语等级"></div>')}
  <h2>教育经历</h2>
  <div class="record">${field('学校名称', '<div class="el-autocomplete"><input placeholder="请输入学校名称"></div>')}${field('专业名称', '<input placeholder="请输入专业名称">')}</div>
  <div class="record">${field('学校名称', '<div class="el-autocomplete"><input placeholder="请输入学校名称"></div>')}${field('专业名称', '<input placeholder="请输入专业名称">')}</div>
  <h2>项目经历</h2>
  <div class="record">${field('项目名称', '<input placeholder="请输入项目名称">')}${field('项目职责', '<textarea placeholder="请输入"></textarea>')}${field('项目成果', '<textarea placeholder="请输入"></textarea>')}</div>
</body></html>`, {
  runScripts:'outside-only', pretendToBeVisual:true, url:'https://careers.example.com/resume'
});
const {window} = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_message, callback)=>callback?.(),lastError:null}};
for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
  window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}
const snapshot = () => new Promise(resolve => listeners[0]({type:'SNAPSHOT_REQUEST'}, {}, resolve));
const page = await snapshot();

const idControls = page.elements.filter(el => el.fieldGroup?.endsWith('证件号码'));
assert.equal(idControls.length, 2, '证件类型与号码输入应保留为两个控件');
assert.equal(new Set(idControls.map(el => el.fieldGroup)).size, 1, '复合证件字段应拥有共同的 FieldGroup');
assert.deepEqual(Array.from(idControls, el => el.fieldSlot), [0, 1], '复合字段保留稳定槽位顺序');
assert.deepEqual(Array.from(idControls, el => el.fieldProtocol), ['select', 'direct-text'], '复合字段应公开控件协议');

const schools = page.elements.filter(el => el.section === '教育经历' && el.label.includes('学校名称'));
assert.deepEqual(Array.from(schools, el => el.recordIndex), [0, 1], '重复教育记录应按学校锚点获得各自的记录索引');
assert.ok(schools.every(el => el.fieldProtocol === 'search-select'), '学校联想框应声明 search-select 协议');

const resume = prepareResume({
  basics:{idType:'居民身份证', idNumber:'000000200001010000'},
  languages:[{language:'英语', certificate:'IELTS', fluency:'雅思 7.0', siteFluency:'良好'}],
  education:[
    {institution:'示例大学 A', area:'示例专业 A', startDate:'2021-09-01', endDate:'2025-06-30'},
    {institution:'示例大学 B', area:'示例专业 B', startDate:'2025-09-01', endDate:'2026-11-30'}
  ],
  projects:[{name:'示例预测项目', role:'项目负责人', description:'项目描述', responsibilities:'负责模型训练与验证', outcomes:'完成预测模型与结果报告'}]
});
const basicsPlan = buildActionPlan(page.elements.filter(el => el.section === '个人信息'), resume, [], {title:'个人信息', scopedSection:true});
assert.deepEqual(basicsPlan.actions.filter(action => action.resumeField).map(action => action.resumeField).sort(), [
  'basics.idNumber', 'basics.idType', 'languages[0].certificate', 'languages[0].language', 'languages[0].siteFluency'
].sort(), '复合证件与外语控件应绑定到各自的 JSON 字段');

const projectPlan = buildActionPlan(page.elements.filter(el => el.section === '项目经历'), resume, [], {title:'项目经历', scopedSection:true});
assert.ok(projectPlan.actions.some(action => action.resumeField === 'projects[0].responsibilities'), '项目职责应绑定 responsibilities');
assert.ok(projectPlan.actions.some(action => action.resumeField === 'projects[0].outcomes'), '项目成果应绑定 outcomes');
const monthPlan = buildActionPlan([
  {index:'month', section:'教育经历', label:'开始月', kind:'date', datePrecision:'month', operations:['TYPE_TEXT','CLICK'], value:''}
], resume, [], {title:'教育经历', scopedSection:true});
assert.deepEqual(
  monthPlan.actions.filter(action => action.operation === 'TYPE_TEXT').map(action => [action.resumeField, action.resolvedValue]),
  [['education[0].startDate', '2021-09']],
  '月精度字段应提交 YYYY-MM，而完整日期仍留在本地简历中'
);
const audit = buildFieldGroupAudit(page.elements.filter(el => el.section === '项目经历'), {
  actions:projectPlan.actions,
  matchedControls:new Set(projectPlan.summary.mappedControls ? [] : [])
});
assert.ok(audit.some(group => group.label === '项目职责' && group.status === 'ready'), '字段组审计应标记可执行的项目职责');

console.log('field groups, control protocols, and generic transaction bindings stay aligned');
