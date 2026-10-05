import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan, prepareResume } from '../lib/jev-client.js';

const field = (label, control) => `<div class="field"><label>${label}</label>${control}</div>`;
const dom = new JSDOM(`<!doctype html><html><body>
  <h2>教育经历</h2>
  ${field('学校名称', '<input placeholder="请输入">')}
  ${field('学习方式', '<input placeholder="请选择">')}
  <h2>实习经历</h2>
  ${field('公司名称', '<input placeholder="请输入">')}
  ${field('工作描述', '<textarea placeholder="请输入"></textarea>')}
</body></html>`, {
  runScripts: 'outside-only', pretendToBeVisual: true,
  url: 'https://careers.midea.com/schoolOut/resume'
});
const { window } = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ top: 10, left: 10, right: 210, bottom: 40, width: 200, height: 30, x: 10, y: 10 });
const listeners = [];
window.chrome = { runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: (_message, callback) => callback?.(), lastError: null } };
for (const path of ['content/widget-drivers.js', 'content/platform-drivers.js', 'content/content.js']) {
  window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}
const snapshot = () => new Promise(resolve => listeners[0]({ type: 'SNAPSHOT_REQUEST' }, {}, resolve));
const page = await snapshot();
const school = page.elements.find(el => el.label === '学校名称');
assert.equal(school?.kind, 'combobox', '普通 input 外观的学校检索框应按联想选择器处理');
assert.equal(school?.fieldProtocol, 'search-select', '学校检索框应公开选项确认协议');

const resume = prepareResume({
  education: [{ institution: '示例大学 B', studyType: '本科', studyMode: '全日制' }],
  internship: [{ company: '示例公司', summary: '负责整理实验数据并交付分析报告。' }]
});
const educationPlan = buildActionPlan(page.elements.filter(el => el.section === '教育经历'), resume, [],
  { title: '教育经历', scopedSection: true });
assert.ok(educationPlan.actions.some(action => action.resumeField === 'education[0].institution' && action.operation === 'TYPE_TEXT'),
  '学校为空时先输入检索词');
assert.ok(educationPlan.actions.some(action => action.resumeField === 'education[0].studyMode' && action.operation === 'CLICK'),
  '学习方式为空时应打开对应的自定义下拉');

const schoolChoice = buildActionPlan([
  { index: 'school', section: '教育经历', recordIndex: 0, kind: 'combobox', fieldProtocol: 'search-select', label: '学校名称', value: '示例大学 B', operations: ['TYPE_TEXT', 'CLICK'] },
  { index: 'school-option', context: 'popup', kind: 'option-item', label: '示例大学 B', operations: ['CLICK'], value: '' }
], resume, [{ kind: 'type_text', controlKind: 'combobox', resumeField: 'education[0].institution' }],
{ title: '教育经历', scopedSection: true });
assert.equal(schoolChoice.actions[0]?.target, 'school-option', '学校输入后存在候选时应先选择候选项');

const workPlan = buildActionPlan(page.elements.filter(el => el.section === '实习经历'), resume, [{
  kind: 'type_text', resumeField: 'internship[0].summary', resolvedValue: resume.internship[0].summary
}], { title: '实习经历', scopedSection: true });
assert.ok(workPlan.actions.some(action => action.resumeField === 'internship[0].summary' && action.operation === 'TYPE_TEXT'),
  '历史输入记录不能替代工作描述的页面回读');

const option = (index, label) => ({ index, context: 'popup', kind: 'option-item', label, operations: ['CLICK'] });
const dateResume = { awards: [{ title: '奖项', date: '2024-08' }] };
let history = [{ kind: 'click', resumeField: 'awards[0].date' }];
let datePlan = buildActionPlan([option('year', '2024年'), option('month', '8月'), option('confirm', '确定')], dateResume, history,
  { title: '获奖经历', scopedSection: true });
assert.equal(datePlan.actions[0]?.target, 'year', '普通年月下拉先选择年份');
history.push({ kind: 'click', context: 'popup', resumeField: 'awards[0].date', label: '2024年' });
datePlan = buildActionPlan([option('year', '2024年'), option('month', '8月'), option('confirm', '确定')], dateResume, history,
  { title: '获奖经历', scopedSection: true });
assert.equal(datePlan.actions[0]?.target, 'month', '年份确认后选择月份');
history.push({ kind: 'click', context: 'popup', resumeField: 'awards[0].date', label: '8月' });
datePlan = buildActionPlan([option('year', '2024年'), option('month', '8月'), option('confirm', '确定')], dateResume, history,
  { title: '获奖经历', scopedSection: true });
assert.equal(datePlan.actions[0]?.target, 'confirm', '年月完整后确认选择器');

console.log('Midea-style school lookup, study mode, descriptions, and split date pickers stay executable');
