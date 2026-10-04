import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan, classifyRecordAddition, countRenderedRecords } from '../lib/jev-client.js';

const field = (label, value = '') => `
  <div class="form-item"><div class="form-item__title">${label} *</div><input value="${value}" placeholder="请输入"></div>`;
const record = fields => `<section class="resume-record">${fields.join('')}</section>`;
const html = `<!doctype html><html><body>
  <h2>个人信息</h2>
  ${record([field('姓名'), '<div class="form-item"><div class="form-item__title">自我评价 *</div><div><textarea></textarea><span>0 / 2000</span></div></div>', field('最高学历')])}
  <h2>教育经历</h2>
  ${record([field('开始时间'), field('学校名称')])}
  ${record([field('开始时间'), field('学校名称')])}
  <h2>项目经历</h2>
  ${record([field('开始时间'), field('项目名称'), field('项目中职责')])}
  ${record([field('开始时间'), field('项目名称'), field('项目中职责')])}
  ${record([field('开始时间'), field('项目名称'), field('项目中职责')])}
  <h2>语言能力</h2>
  ${record([field('语言类型'), field('掌握程度'), field('听说'), field('读写')])}
  <h2>获奖情况</h2>
  ${record([field('获奖时间'), field('获奖项')])}
  ${record([field('获奖时间'), field('获奖项')])}
  <button id="add-award">添加获奖情况</button>
  <div class="form-item"><div class="form-item__title">简历附件 *</div><div><label>重新上传<input type="file"></label></div></div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts:'outside-only', pretendToBeVisual:true, url:'https://sample.zhiye.com/form'
});
const { window } = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_message,callback)=>callback?.(),lastError:null}};
for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
  window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}
const snapshot = () => new Promise(resolve => listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const before = await snapshot();

assert.equal(before.page.platform, 'beisen');
assert.equal(before.elements.filter(element => ['自我评价','最高学历'].includes(element.label))
  .map(element => element.section).join(','), '个人信息,个人信息',
  '字段标题不会被识别为新的 section');
assert.equal(before.elements.find(element => element.kind === 'file')?.section, '简历附件',
  '北森简历上传控件归入简历附件');
assert.equal(before.elements.find(element => element.role === 'textbox' && element.label === '自我评价')?.section, '个人信息',
  '北森富文本计数器回溯到字段标题');
const sectionRecords = section => before.elements.filter(element =>
  element.section === section && element.context !== 'popup' && Number.isInteger(element.recordIndex));
assert.equal(countRenderedRecords('教育经历', sectionRecords('教育经历')), 2,
  '北森教育记录从每条记录最前面的开始时间分组');
assert.equal(countRenderedRecords('项目经历', sectionRecords('项目经历')), 3,
  '北森项目记录保持三个独立 recordIndex');
assert.equal(countRenderedRecords('获奖情况', sectionRecords('获奖情况')), 2,
  '北森获奖项别名参与记录分组');

const projectPlan = buildActionPlan(before.elements.filter(element => element.section === '项目经历'), {
  projects:[
    {name:'项目一', responsibilities:'负责人', startDate:'2024-01-01'},
    {name:'项目二', responsibilities:'开发', startDate:'2024-02-01'},
    {name:'项目三', responsibilities:'研究员', startDate:'2024-03-01'}
  ]
}, [], {title:'项目经历', platform:'beisen'});
assert.deepEqual(projectPlan.actions.filter(action => action.label === '项目中职责').map(action => action.resumeField), [
  'projects[0].responsibilities','projects[1].responsibilities','projects[2].responsibilities'
]);

const languagePlan = buildActionPlan(before.elements.filter(element => element.section === '语言能力'), {
  languages:[{language:'英语', siteFluency:'良好'}]
}, [], {title:'语言能力', platform:'beisen'});
assert.deepEqual(languagePlan.actions.filter(action => ['掌握程度','听说','读写'].includes(action.label))
  .map(action => action.resumeField), [
  'languages[0].siteFluency','languages[0].siteFluency','languages[0].siteFluency'
]);

const awardPlan = buildActionPlan(before.elements.filter(element => element.section === '获奖情况'), {
  awards:[{title:'奖项一',date:'2024-01-01'},{title:'奖项二',date:'2024-02-01'}]
}, [], {title:'获奖情况', platform:'beisen'});
assert.deepEqual(awardPlan.actions.filter(action => action.label === '获奖项').map(action => action.resumeField), [
  'awards[0].title','awards[1].title'
]);

window.document.getElementById('add-award').insertAdjacentHTML('beforebegin',
  record([field('获奖时间'), field('获奖项')]));
const after = await snapshot();
const addition = classifyRecordAddition({section:'获奖情况',before,after});
assert.equal(addition.mode, 'inline');
assert.equal(addition.verified, true);

// 新增事务只接受新增记录的页面证据。动态出现的单个字段不能被当作一条新记录，
// 否则下一条简历资料会写回当前记录。
const fallbackAddition = classifyRecordAddition({section:'项目经历',before:{
  page:{platform:'beisen',url:'https://sample.zhiye.com/form'},
  elements:[{section:'项目经历',label:'字段',operations:['TYPE_TEXT']}]
},after:{
  page:{platform:'beisen',url:'https://sample.zhiye.com/form'},
  elements:[
    {section:'项目经历',label:'字段',operations:['TYPE_TEXT']},
    {section:'项目经历',label:'新字段',operations:['TYPE_TEXT']}
  ]
}});
assert.equal(fallbackAddition.mode, 'failed');
assert.equal(fallbackAddition.verified, false);

console.log('beisen platform tests passed');
