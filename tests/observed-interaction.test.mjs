import assert from 'node:assert/strict';
import {buildObservedActionPlan,observedValueMatches} from '../lib/observed-interaction.js';
import {buildQuestions,buildSectionJevState} from '../lib/jev-client.js';
import {DEFAULT_INTERACTION_POLICY,resolveInteractionPolicy} from '../lib/interaction-policy.js';

assert.equal(DEFAULT_INTERACTION_POLICY,'observed');
for(const value of [undefined,null,'','unknown','observed']) assert.equal(resolveInteractionPolicy(value),'observed');
assert.equal(resolveInteractionPolicy('adapted'),'adapted','保留用户显式选择的对照策略');

const resume={education:[{institution:'合成大学',endDate:'2026-11-30',studyMode:'全日制',
  novelFact:'城市计算',document:{name:'synthetic.pdf',dataUrl:'data:application/pdf;base64,PRIVATE_BYTES'}}],
  projects:[{name:'外部分区秘密项目'}]};
const page={title:'教育经历',dataBlock:'education',recordIndex:0,recordScope:true,sectionScope:true,ignoreUnmapped:true};
const control=(key,label,kind='input',more={})=>({index:key,stableKey:key,section:'教育经历',recordIndex:0,
  label,kind,value:'',operations:kind==='input' ? ['TYPE_TEXT'] : ['CLICK'],...more});
const controls=[control('school','学校名称'),control('date','完成学业日期','moka-date',{operations:['PICK_DATE']}),
  control('mode','课程修读方式','custom-select'),control('novel','科研方向'),
  control('existing','院系','input',{value:'已有院系'}),control('referral','内推码'),
  control('submit','立即投递','action'),control('other-record','科研方向','input',{recordIndex:1})];
let plan=buildObservedActionPlan(controls,resume,[],page);
assert.deepEqual(plan.actions.filter(a=>a.operation==='FOCUS_FIELD').map(a=>a.target),['school','date','mode','novel']);
assert.ok(plan.actions.some(a=>a.operation==='RETURN_SECTION'));
const focus=[{kind:'focus',controlStableKey:'novel',label:'科研方向'}];
plan=buildObservedActionPlan(controls,resume,focus,page);
assert.ok(plan.actions.some(a=>a.resumeField==='education[0].novelFact'),'当前 JSON 块的新字段进入候选');
assert.ok(Object.values(buildQuestions('填写当前记录',plan).action.criteria).some(a=>
  a.source_field==='education[0].studyMode' && a.source_meaning),'来源字段含义进入真实 Jev 请求');
assert.ok(plan.actions.some(a=>a.operation==='SKIP_FIELD'));
assert.ok(!JSON.stringify(buildQuestions('填写当前记录',plan)).includes('PRIVATE_BYTES'));
assert.ok(!JSON.stringify(buildSectionJevState({page,elements:controls,resume,actionPlan:plan})).includes('外部分区秘密项目'));

const dateHistory=[{kind:'focus',controlStableKey:'date'},
  {kind:'bind',controlStableKey:'date',resumeField:'education[0].endDate'}];
plan=buildObservedActionPlan(controls,resume,dateHistory,page);
assert.ok(plan.actions.some(a=>a.operation==='CLICK' && a.target==='date'));
assert.ok(!plan.actions.some(a=>a.operation==='PICK_DATE'),'实验日期由逐步观察驱动');
const popup=[control('nav','切换到所需年份','action',{context:'popup',popupOwnerKey:'date'}),
  control('day','30','option-item',{context:'popup',popupOwnerKey:'date',
    observed:{capabilities:['CLICK'],scrollableAncestor:{nodeKey:'scroll'}}}),
  control('foreign','外部选项','option-item',{context:'popup',popupOwnerKey:'school'}),
  control('disabled','31','option-item',{context:'popup',popupOwnerKey:'date',disabled:true})];
plan=buildObservedActionPlan([...controls,...popup],resume,dateHistory,page);
assert.ok(plan.actions.some(a=>a.target==='nav'),'日期导航使用真实弹层对象，完整交给 Jev 判断');
assert.ok(plan.actions.some(a=>a.target==='day'));
assert.ok(plan.actions.some(a=>a.operation==='SCROLL'));
assert.ok(!plan.actions.some(a=>['foreign','disabled'].includes(a.target)));
assert.ok(plan.actions.some(a=>a.operation==='RETURN'));
assert.equal(observedValueMatches({...controls[1],value:'2026-11-01'},'2026-11-30'),false);
assert.equal(observedValueMatches({...controls[1],value:'2026年11月30日'},'2026-11-30'),true);
assert.equal(observedValueMatches({...controls[1],value:'2026-11',datePrecision:'month'},'2026-11-30'),true);
assert.equal(observedValueMatches({kind:'checkbox',checked:false},'否'),true);

const modeHistory=[{kind:'focus',controlStableKey:'mode'},
  {kind:'bind',controlStableKey:'mode',resumeField:'education[0].studyMode'},
  {kind:'click',controlStableKey:'mode',resumeField:'education[0].studyMode',selectedLabel:'Full-time',semanticChoiceConfidence:.95}];
plan=buildObservedActionPlan([control('mode','课程修读方式','custom-select',{value:'Full-time'})],resume,modeHistory,page);
assert.equal(plan.status,'done','语义选择经过根字段回读后验收');
plan=buildObservedActionPlan([],resume,[],{...page,observationCoverage:[{omittedBySection:{教育经历:1}}]});
assert.equal(plan.status,'blocked','被截断的观察范围保留待核验');
assert.equal(plan.observation.coverage_complete,false);
plan=buildObservedActionPlan([control('save','保存并提交','action',{recordCommit:true})],resume,[],page);
assert.ok(!plan.actions.some(action=>action.recordCommit),'最终提交始终退出候选');
plan=buildObservedActionPlan([control('mode','课程修读方式','custom-select')],resume,
  [...modeHistory,{kind:'cancel',skipControlKey:'mode',reasonKind:'execution-gap',reason:'测试执行失败'}],page);
assert.equal(plan.summary.fieldGroups[0].status,'pending-readback','执行失败与资料缺失分别记录');
const largeResume={education:[Object.fromEntries(Array.from({length:270},(_,i)=>[`fact${i}`,`值${i}`]))]};
plan=buildObservedActionPlan(controls,largeResume,focus,page);
assert.equal(plan.observation.candidates_complete,false);
assert.ok(plan.actions.length<=255);
assert.ok(!plan.actions.some(action=>action.operation==='SKIP_FIELD'),'来源候选未完整覆盖时保留覆盖缺口');
console.log('Observed policy: broad control/source candidates, primitive dates, scoped popups, readback and coverage guards passed');
