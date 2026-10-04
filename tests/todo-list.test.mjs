import assert from 'node:assert/strict';
import { buildTodoList } from '../lib/jev-client.js';

const action = (index, section, label) => ({
  index, section, label, kind:'action', role:'button', domOrder:Number(index), operations:['CLICK']
});

const input = (index, section, label) => ({
  index, section, label, kind:'input', role:'textbox', domOrder:Number(index),
  operations:['TYPE_TEXT'], value:'', fieldGroup:`${section}|record-1|${label}`, fieldProtocol:'direct-text', fieldSlot:0
});

const resume = {
  basics:{name:'示例姓名'},
  education:[{institution:'示例大学'}],
  awards:[],
  patents:[{name:'声景预测方法',number:'ZL 2023 1 1763103.9'}],
  publications:[{title:'Decoding urban soundscapes'}]
};

const todo = buildTodoList([
  action('1', '获奖经历', '新增获奖经历'),
  action('2', '发明专利', '新增发明专利'),
  action('3', '论文', '新增论文'),
  input('4', '教育经历', '学校名称')
], resume);

const patent = todo.items.find(item => item.section === '发明专利');
assert.equal(patent.collection, 'patents', '发明专利应关联 patents 集合');
assert.equal(patent.status, 'ready-add', '有本地专利且网页为空时应提示新增');
assert.equal(patent.nextOperation, 'ADD_RECORD');

const publication = todo.items.find(item => item.section === '论文');
assert.equal(publication.collection, 'publications', '论文应关联 publications 集合');
assert.equal(publication.status, 'ready-add', '有本地论文且网页为空时应提示新增');

const award = todo.items.find(item => item.section === '获奖经历');
assert.equal(award.status, 'no-local-data', '无本地奖项资料时清单应明确待补原因');

const education = todo.items.find(item => item.section === '教育经历');
assert.equal(education.status, 'ready-fill', '已打开的字段应显示为可填写');
assert.equal(education.fields[0].status, 'ready', '清单应携带字段组的回读状态');

console.log('todo list maps local collections, next operations, and field-group states');
