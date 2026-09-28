import assert from 'node:assert/strict';
import {buildActionPlan} from '../lib/jev-client.js';
const resume={basics:{heightCm:175,weightKg:65},family:[
  {relationship:'父亲',name:'测试父亲',company:'甲公司'},
  {relationship:'母亲',name:'测试母亲',company:'乙公司'}]};
const input=(index,label,section)=>({index,label,section,kind:'input',operations:['TYPE_TEXT'],value:''});
const contactPlan=buildActionPlan([input('contact','紧急联系人姓名','其他信息'),input('phone','紧急联系方式','其他信息')],
  {basics:{name:'本人',phone:'10000'},application:{emergencyContactName:'联系人',emergencyContactPhone:'12345'}},[],{title:'其他信息'});
assert.deepEqual(contactPlan.actions.map(a=>a.resumeField),['application.emergencyContactName','application.emergencyContactPhone']);
const plan=buildActionPlan([input('a','母亲姓名','家庭关系'),input('b','父亲姓名','家庭关系'),
  input('c','工作单位','家庭关系'),input('d','工作单位','家庭关系')],resume,[],{title:'家庭关系'});
for(const [target,path] of [['a','family[1].name'],['b','family[0].name'],['c','family[0].company'],['d','family[1].company']]) {
  assert.deepEqual(plan.actions.filter(a=>a.target===target).map(a=>a.resumeField),[path]);
}
const personal=buildActionPlan([input('h','身高（cm）','个人基本信息'),input('w','体重（kg）','个人基本信息')],resume,[],{title:'个人基本信息'});
assert.deepEqual(personal.actions.map(a=>a.resumeField),['basics.heightCm','basics.weightKg']);
const unrelated=buildActionPlan([input('x','姓名','未知分区')],resume,[],{});
assert.ok(!unrelated.actions.some(a=>a.resumeField?.startsWith('family')));
const rank=buildActionPlan([input('r','本人班级排名','教育经历')],
  {education:[{ranking:'TOP50%'}]},[],{title:'教育经历'});
assert.ok(!rank.actions.some(a=>a.resumeField?.endsWith('.ranking')));
const certificatePlan=buildActionPlan([
  {...input('n','证书名称','证书'),value:'英语六级'},input('d','获得时间','证书')],
  {certificates:[{name:'发明专利',date:'2024-11'}]},[],{title:'证书'});
assert.ok(!certificatePlan.actions.some(a=>a.resumeField==='certificates[0].date'));
const birthdays=buildActionPlan(['first','second'].map(index=>({...input(index,'出生日期','家庭关系'),kind:'date',operations:['CLICK']})),
  {family:[{birthDate:'1969-10-05'},{birthDate:'1972-08-18'}]},[],{title:'家庭关系'});
assert.deepEqual(birthdays.actions.map(a=>a.resumeField),['family[0].birthDate','family[1].birthDate']);
console.log('Family identity and ordinal binding, height/weight and section isolation passed');
const languageResume={languages:[{language:'英语',certificate:'IELTS',score:'6.5',siteFluency:'良好'}]};
const languageControls=[input('c','证书','语言能力'),input('s','成绩','语言能力'),input('f','熟练程度','语言能力')];
const languagePlan=buildActionPlan(languageControls,languageResume,[],{title:'语言能力'});
assert.deepEqual(languagePlan.actions.map(a=>a.resumeField),['languages[0].certificate','languages[0].score','languages[0].siteFluency']);
const isolatedFailure=buildActionPlan(languageControls,languageResume,[{kind:'cancel',cancelField:'languages[0].certificate'}],{title:'语言能力'});
assert.ok(!isolatedFailure.actions.some(a=>a.resumeField==='languages[0].certificate'));
assert.ok(isolatedFailure.actions.some(a=>a.resumeField==='languages[0].score'));
const recoveredPopup=buildActionPlan([
  {index:'ielts',context:'popup',kind:'option-item',label:'雅思（IELTS）',operations:['CLICK']}
],languageResume,[{kind:'failed',resumeField:'languages[0].certificate',controlKind:'input'}],{title:'语言能力'});
assert.ok(recoveredPopup.actions.some(a=>a.target==='ielts' && a.resumeField==='languages[0].certificate'),
  '输入触发选择层后，即使文本回读失败也保留证书绑定');
