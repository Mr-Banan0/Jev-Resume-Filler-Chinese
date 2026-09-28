import assert from 'node:assert/strict';
import {planObservedPopup,interactionIntent} from '../lib/interaction.js';
const option=(index,label)=>({index,label,kind:'option-item',context:'popup',operations:['CLICK']});
const field={path:'basics.hukou',label:'户口所在地',value:'广东省广州市黄埔区',
  pickerPath:['广东省','广州市','黄埔区'],controlStableKey:'hukou'};
const plan=(elements,history=[])=>planObservedPopup({elements,field,history,matchesValue:(el,value)=>el.label===value});
assert.equal(plan([option('city','广州市')]).actions[0].target,'city','已打开市级时依据当前可见选项选择');
const history=[{kind:'click',context:'form',resumeField:field.path,controlStableKey:'hukou'},
  {kind:'click',context:'popup',resumeField:field.path,label:'广东省',controlStableKey:'hukou'}];
assert.equal(plan([option('province','广东省'),option('city','广州市')],history).actions[0].target,'city');
history.push({kind:'click',context:'popup',resumeField:field.path,label:'广州市',controlStableKey:'hukou'});
assert.equal(plan([option('ok','确定')],history).actions[0].intent,'CONFIRM','两级页面按实际确认按钮结束');
assert.equal(plan([option('district','黄埔区')],history).actions[0].intent,'CHOOSE','三级页面继续选择');
const blocked=plan([option('unknown','未知地区'),option('back','返回')]);
assert.equal(blocked.status,'blocked');
assert.equal(blocked.actions[0].intent,'RETURN');
assert.equal(interactionIntent({operation:'TYPE_TEXT'}),'FILL');
assert.equal(interactionIntent({operation:'CLICK',context:'popup',label:'确定'}),'CONFIRM');
console.log('generic interaction tests passed');
const skillField={path:'professionalSkills[0].name',label:'技能名称',value:'Python'};
const skillOptions=[{...option('dev','开发编程类'),pickerBranch:true},option('sql','SQL'),option('close','Close')];
const skillPlan=planObservedPopup({elements:skillOptions,field:skillField,history:[],matchesValue:(el,value)=>el.label===value});
assert.equal(skillPlan.actions[0].target,'dev');
assert.equal(skillPlan.actions[0].intent,'OPEN');
assert.ok(!skillPlan.actions.some(a=>a.target==='sql'));
const customSkill=planObservedPopup({elements:[option('custom','其他技能'),...skillOptions],
 field:{...skillField,value:'LangGraph'},history:[],matchesValue:(el,value)=>el.label===value});
assert.equal(customSkill.actions[0].target,'custom');
assert.equal(customSkill.actions[0].intent,'OPEN');
const sourcePlan=planObservedPopup({elements:[option('official','龙湖官网/官微'),option('duplicate','龙湖官网/官微'),option('school','学校就业网'),option('other','其他')],
 field:{formRule:'recruitment-source',value:'校园招聘官网'},history:[],matchesValue:(el,value)=>el.label===value});
assert.deepEqual(sourcePlan.actions.filter(a=>a.intent==='CHOOSE').map(a=>a.target),['official']);
