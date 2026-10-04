import assert from 'node:assert/strict';
import {buildActionPlan,buildDataBlockPlan,buildSectionPlan,buildSectionJevState,choose} from '../lib/jev-client.js';

const resume={
  basics:{name:'示例姓名',photo:{name:'photo.png',dataUrl:'data:image/png;base64,PRIVATE_BYTES'}},
  education:[{institution:'示例大学 A',studyType:'硕士',researchFocus:'城市计算'},
    {institution:'示例大学 B',studyType:'本科',researchFocus:'空间分析'}],
  languages:[{language:'英语',score:'7.0'}],
  projects:[{name:'其他分区私有项目'}]
};
const control={index:'f0_1',stableKey:'local-selector',section:'学业资料',recordIndex:1,
  label:'攻读层次',kind:'custom-select',value:'',operations:['CLICK']};
const page={title:'学业资料',sectionScope:true,scopedSection:true,ignoreUnmapped:true,
  dataBlock:'education',recordIndex:1,recordScope:true,allowAddRecords:false};
const plan=buildActionPlan([control],resume,[],page);
assert.ok(plan.actions.some(action=>action.operation==='BIND_FIELD' && action.resumeField==='education[1].studyType'));
assert.ok(plan.actions.filter(action=>action.resumeField).every(action=>action.resumeField.startsWith('education[1]')));
assert.ok(plan.actions.some(action=>action.operation==='SKIP_FIELD'));
assert.ok(plan.actions.some(action=>action.operation==='RETURN_SECTION'));
const nameHint=buildActionPlan([{...control,recordIndex:undefined,label:'导师姓名',kind:'input',operations:['TYPE_TEXT']}],resume,[],
  {...page,dataBlock:'basics',recordIndex:0});
assert.ok(nameHint.actions.some(action=>action.operation==='BIND_FIELD'));
assert.ok(!nameHint.actions.some(action=>action.operation==='TYPE_TEXT'),
  '姓名别名只排序候选，空字段经过 Jev 绑定后执行');

const binding={kind:'bind',resumeField:'education[1].studyType',controlStableKey:'local-selector',label:control.label};
const boundPlan=buildActionPlan([control],resume,[binding],page);
const opened=boundPlan.actions.find(action=>action.operation==='CLICK');
assert.equal(opened.resumeField,binding.resumeField,'字段选择先绑定，再执行控件');
assert.equal(opened.controlStableKey,'local-selector');
const popup={index:'f0_9',section:'学业资料',context:'popup',label:'本科',kind:'option-item',operations:['CLICK']};
const pickerPlan=buildActionPlan([control,popup],resume,[binding,{kind:'click',resumeField:binding.resumeField,
  controlStableKey:'local-selector',controlKind:'custom-select'}],page);
assert.ok(pickerPlan.actions.some(action=>action.target==='f0_9' && action.resumeField===binding.resumeField),
  '未知字段的下拉选项继续沿用已选择的 JSON 字段');
const readback=buildActionPlan([{...control,value:'本科'}],resume,[binding],page);
assert.equal(readback.status,'done');
assert.equal(readback.summary.satisfiedControls,1);
const uncommitted=buildActionPlan([{...control,value:'本科',valueCommitted:false}],resume,[binding],page);
assert.notEqual(uncommitted.status,'done','选择框的搜索词通过网站提交后才算完成');
const skipped=buildActionPlan([control],resume,[{kind:'skip',skipControlKey:'local-selector'}],page);
assert.equal(skipped.status,'done','无匹配字段有明确出口');
assert.equal(skipped.summary.mappedControls,0);

const custom={...control,index:'f0_2',stableKey:'raw-field',label:'学术主题摘要',kind:'textarea',operations:['TYPE_TEXT']};
const rawBinding={kind:'bind',resumeField:'education[1].researchFocus',controlStableKey:'raw-field',label:custom.label};
const rawPlan=buildActionPlan([custom],resume,[rawBinding],page);
assert.ok(rawPlan.actions.some(action=>action.operation==='TYPE_TEXT' && action.resumeField===rawBinding.resumeField),
  '当前 JSON 块新增的实际字段也可绑定与执行');
assert.equal(buildActionPlan([{...custom,value:'空间分析'}],resume,[rawBinding],page).status,'done');

const state=buildSectionJevState({page,elements:[control,{...control,index:'foreign',section:'项目经历',value:'外部分区内容'}],resume,actionPlan:plan});
assert.equal(state.record_index,1);
assert.deepEqual(state.json_fields,resume.education,'当前资料块的完整字段与所有记录进入局部状态');
assert.equal(state.controls.length,1);
assert.ok(!JSON.stringify(state).includes('其他分区私有项目'));
const attachmentState=buildSectionJevState({page:{...page,dataBlock:'basics'},elements:[control],resume});
assert.ok(!JSON.stringify(attachmentState).includes('PRIVATE_BYTES'),'附件字节留在本地');

const keys=['basics','application','expected','education','internship','work','projects','campusPractice',
  'awards','languages','englishLevels','skills','professionalSkills','computerSkills','certificates','patents',
  'publications','family','training','interests','profiles'];
const ruleControl={index:'agree',section:'确认信息',label:'我已阅读并同意招聘隐私政策',kind:'checkbox',
  checked:false,operations:['CLICK'],formRuleSignals:['agreement']};
assert.ok(buildDataBlockPlan('确认信息',[ruleControl],{}).actions.some(action=>action.dataBlock==='siteRules'),
  '协议分区独立提供已授权规则候选');
const richResume=Object.fromEntries(keys.map(key=>[key,
  ['basics','application','expected'].includes(key) ? {customField:`${key} 示例`} :
    key==='interests' ? ['示例兴趣'] : [{customField:`${key} 示例`}]]));
const blockPlan=buildDataBlockPlan('自定义表单',[],richResume);
let body;
const fetchBefore=globalThis.fetch;
try {
  globalThis.fetch=async(_url,args)=>{
    body=JSON.parse(args.body);
    return {ok:true,json:async()=>({answers:{action:{choice:blockPlan.actions.at(-1).id,confidence:1}}})};
  };
  const decision=await choose({apiKey:'synthetic',goal:'choose',page:{title:'自定义表单',sectionScope:true},
    elements:[],history:[],resume:richResume,actionPlan:blockPlan});
  assert.equal(decision.operation,'NO_DATA_BLOCK');
  assert.equal(Object.keys(body.questions.action.criteria).length,keys.length+1,'资料块候选完整，不截断为前八项');
} finally {globalThis.fetch=fetchBefore;}

const sectionControls=[{index:'1',section:'个人信息',label:'学校',kind:'input',recordIndex:0,value:'',operations:['TYPE_TEXT']},
  {index:'2',section:'语言能力',label:'语种',kind:'input',value:'',operations:['TYPE_TEXT']}];
const ledger={'个人信息|*':{activeBlock:'education'},'个人信息|education|0':{completed:true}};
const sectionPlan=buildSectionPlan(sectionControls,resume,ledger,{focusSection:'个人信息'});
assert.ok(sectionPlan.actions.every(action=>!action.section || action.section==='个人信息'),'深度优先保持当前 section');
assert.ok(sectionPlan.actions.some(action=>action.collection==='education'),'已选 JSON 块覆盖标题默认提示');
console.log('Hierarchical routing, persistent field binding, complete local context and bounded exits passed');
