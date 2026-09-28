import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan, countRenderedRecords } from '../lib/jev-client.js';

const html = [
  '<!doctype html><html><body>',
  '<h2>个人信息</h2>',
  '<div class="mFormSelect"><div>国籍</div><div><input id="nationality" placeholder="请选择"><span>必填项未填写</span></div></div>',
  '<div class="mFormSelect"><div>英文名 *</div><div><input id="english-name" placeholder="必填项未填写"></div></div>',
  '<div class="mFormSelect"><div>国家/地区 *</div><div class="sd-Select-container-1Eq4x"><input id="nationality-new" placeholder="请输入国家/地区"></div></div>',
  '<div class="mFormSelect"><div>籍贯 *</div><div class="sd-Select-container-1Eq4x"><input id="native-place-new" placeholder="请输入籍贯"></div></div>',
  '<h2>上传</h2>',
  '<div class="upload-row"><div>上传简历</div><div class="mFormUpload"><button>YE_Yaosen_CV.pdf</button><input id="chinese-cv" type="file"></div></div>',
  '<div class="upload-row"><div>英文简历</div><div class="mFormUpload"><button>上传</button><input id="english-cv" type="file"></div></div>',
  '<div class="upload-row"><div>加盖公章的成绩单</div><div class="mFormUpload"><button>上传</button><input id="transcript" type="file"></div></div>',
  '</body></html>'
].join('');
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://careers.ey.com.cn/campus-recruitment/ey/example'
});
const { window } = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners = [];
window.chrome = {
  runtime: {onMessage:{addListener: handler => listeners.push(handler)}, sendMessage:(_message,done) => done?.(), lastError:null}
};
window.eval(readFileSync(new URL('../content/widget-drivers.js', import.meta.url), 'utf8'));
window.eval(readFileSync(new URL('../content/content.js', import.meta.url), 'utf8'));
const snapshot = await new Promise(resolve => listeners[0]({type:'SNAPSHOT_REQUEST'}, {}, resolve));
assert.equal(snapshot.page.platform, 'moka-form');
assert.equal(snapshot.elements.find(el => el.placeholder === '必填项未填写')?.label, '英文名');
assert.equal(snapshot.elements.find(el => el.placeholder === '必填项未填写')?.required, true);
assert.equal(snapshot.elements.find(el => el.kind === 'file' && el.label === '英文简历')?.section, '上传');
assert.equal(snapshot.elements.find(el => el.kind === 'file' && el.label === '上传简历')?.value, 'YE_Yaosen_CV.pdf');
assert.ok(snapshot.elements.some(el => el.kind === 'file' && el.label === '加盖公章的成绩单'));
assert.ok(snapshot.elements.some(el => el.label === '国籍'));
for (const [placeholder,label] of [['请输入国家/地区','国家/地区'],['请输入籍贯','籍贯']]) {
  const field = snapshot.elements.find(el => el.placeholder === placeholder);
  assert.ok(field && field.kind === 'custom-select' && field.label.includes(label) && field.operations.includes('CLICK'));
  assert.equal(field.value, '', `空的${label}下拉不能被字段标题误认为已有值`);
}
const geoResume = {basics:{nationality:'中国',nativePlace:'广东省河源市和平县',
  nativePlaceDetail:{province:'广东省',city:'河源市',district:'和平县'}}};
const geoFields = snapshot.elements.filter(el => ['请输入国家/地区','请输入籍贯'].includes(el.placeholder));
const geoPlan = buildActionPlan(geoFields,geoResume,[],{title:'个人信息'});
assert.ok(geoPlan.actions.some(action => action.resumeField === 'basics.nationality' && action.operation === 'CLICK'));
assert.ok(geoPlan.actions.some(action => action.resumeField === 'basics.nativePlace' && action.operation === 'CLICK'));
const untouched = buildActionPlan([
  {index:'name',kind:'input',section:'个人信息',label:'姓名',value:'网站已有姓名',operations:['TYPE_TEXT']},
  {index:'country',kind:'custom-select',section:'个人信息',label:'国家/地区',value:'香港',operations:['CLICK']},
  {index:'empty',kind:'custom-select',section:'个人信息',label:'籍贯',value:'',operations:['CLICK']}
],{...geoResume,basics:{...geoResume.basics,name:'本地姓名'}},[],{title:'个人信息'});
assert.ok(untouched.actions.every(action => !['name','country'].includes(action.target)));
assert.ok(untouched.actions.some(action => action.target === 'empty'));
const eyEducation = [
  {index:'master-score',kind:'input',section:'教育背景',recordIndex:0,label:'历年平均成绩（百分制）',value:'',operations:['TYPE_TEXT']},
  {index:'bachelor-score',kind:'input',section:'教育背景',recordIndex:1,label:'历年平均成绩（百分制）',value:'',operations:['TYPE_TEXT']},
  {index:'minor',kind:'input',section:'教育背景',recordIndex:0,label:'辅修专业',value:'',operations:['TYPE_TEXT']},
  {index:'rank',kind:'custom-select',section:'个人信息',label:'GPA排名',value:'',operations:['CLICK']}
];
const eyPlan = buildActionPlan(eyEducation,{education:[{gpa:'3.5/4.3',area:'计算机科学与技术',ranking:'TOP 50%'},{gpa:'83/100'}]},[],{title:'教育背景'});
assert.ok(eyPlan.actions.some(action => action.target === 'bachelor-score' && action.resumeField === 'education[1].gpa'));
assert.ok(!eyPlan.actions.some(action => ['master-score','minor'].includes(action.target)));
const requiredGap = buildActionPlan([{index:'english-name',kind:'input',section:'个人信息',label:'英文名',required:true,value:'',operations:['TYPE_TEXT']}],
  {basics:{name:'示例姓名'}},[],{title:'个人信息',ignoreUnmapped:true});
assert.equal(requiredGap.status,'blocked');
const monthOnlyBirth = buildActionPlan([{index:'birth',kind:'input',section:'个人信息',label:'出生日期 (年龄)',value:'2003-02 (23岁)',operations:['CLICK']}],
  {basics:{birthDate:'2003-02-10'}},[],{title:'个人信息',ignoreUnmapped:true});
assert.equal(monthOnlyBirth.status,'done');
assert.equal(countRenderedRecords('实习经历',[
  {label:'公司名称 *',section:'实习经历'}, {label:'公司名称 *',section:'实习经历'}
]),2);
console.log('EY 表单控件族识别与上传字段标签通过');
