import assert from 'node:assert/strict';
import {buildActionPlan,buildDataBlockPlan,buildSectionPlan,buildSectionJevState,buildQuestions,fieldBindingThreshold,hasSelectedRadioPeer,choose,prepareResume} from '../lib/jev-client.js';
import {recordLedgerKey} from '../lib/traversal-state.js';
assert.deepEqual(prepareResume({basics:{highestDegree:'硕士'},education:[{studyType:'硕士'},{studyType:'本科'},{}]})
  .education.map(edu=>edu.isHighestEducation),['是','否',''],'最高学历判断来自已提供的学历；缺少学历保持待补');

const mixedControls=[
  {index:'name',stableKey:'name',section:'个人信息',kind:'input',label:'姓名',value:'示例姓名',operations:['TYPE_TEXT']},
  {index:'mode',stableKey:'mode',section:'个人信息',kind:'custom-select',label:'学习形式',value:'',operations:['CLICK']}
];
const mixedResume={basics:{name:'示例姓名'},education:[{studyMode:'全日制'}]};
const mixedPlan=buildDataBlockPlan('个人信息',mixedControls,mixedResume,['basics']);
const mixedState=buildSectionJevState({page:{title:'个人信息',sectionScope:true},elements:mixedControls,
  resume:mixedResume,actionPlan:mixedPlan});
assert.deepEqual(mixedState.remaining_fields.map(field=>field.label),['学习形式'],
  '混合分区再次路由时直接展示剩余字段标签');
assert.equal(mixedState.controls.find(control=>control.label==='姓名').routing_eligible,false);
assert.ok(mixedPlan.actions.some(action=>action.dataBlock==='education' && action.matched>0));
assert.equal(prepareResume({internship:[{company:'示例机构',position:'开发实习生'}]})
  .internship[0].hasExperience,'是','已提供的实习记录支持经历存在性问题');
assert.equal(prepareResume({internship:[{}]}).internship[0].hasExperience,'',
  '空记录保留存在性问题待补');
assert.deepEqual(prepareResume({projects:[
  {description:'项目背景：研究示例。\n评测：结果显示通过率提高。'},
  {description:'评测目标：目标通过率达到90%。'},
  {description:'最终成功定位问题来源。',outcomes:'用户提供的具体成果'},
  {description:'参加公开会议并发表学术海报。'}
]}).projects.map(project=>project.outcomes),
['评测：结果显示通过率提高。','','用户提供的具体成果','参加公开会议并发表学术海报。'],
'成果段落沿用原文，显式字段优先，计划指标保持独立');
const sourcePlan=buildDataBlockPlan('个人信息',[
  {index:'source',stableKey:'source',section:'个人信息',kind:'custom-select',
    label:'招聘信息的来源',value:'',operations:['CLICK']}
],{application:{recruitmentSource:'校园招聘官网'}},['basics','education']);
assert.ok(sourcePlan.actions.some(action=>action.dataBlock==='application' && action.matched===1),
  '混合分区在个人和教育资料之后继续发现招聘来源');

const resume={
  basics:{name:'示例姓名',photo:{name:'photo.png',dataUrl:'data:image/png;base64,PRIVATE_BYTES'}},
  education:[{institution:'示例大学 A',studyType:'硕士',researchFocus:'城市计算'},
    {institution:'示例大学 B',studyType:'本科',researchFocus:'空间分析'}],
  languages:[{language:'英语',score:'7.0'}],
  projects:[{name:'其他分区私有项目'}]
};
for (const label of ['人像面','身份证正面','国徽面','证件扫描']) {
  const idUpload={index:label,stableKey:label,section:'个人信息',kind:'file',label,value:'',operations:['UPLOAD_FILE']};
  const idPlan=buildActionPlan([idUpload],resume,[],{title:'个人信息',dataBlock:'basics',scopedSection:true,ignoreUnmapped:true});
  assert.ok(!idPlan.actions.some(a=>a.operation==='BIND_FIELD' && a.resumeField==='basics.photo'),
    '证件扫描与个人头像用途隔离');
}
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
const existingConflict=buildActionPlan([{...control,value:'博士'}],resume,[binding],page);
assert.equal(existingConflict.summary.satisfiedControls,0,'已有的学历值与本地不同时进入冲突账本');
assert.ok(existingConflict.summary.unresolved.some(item=>/已有值/.test(item.reason)));
assert.ok(!existingConflict.actions.some(action=>['CLICK','TYPE_TEXT','SELECT'].includes(action.operation)),
  '已有值冲突保留网页内容，不自动覆盖');
const englishDefault={index:'english-default',stableKey:'english-default',section:'个人信息',
  label:'英语等级',kind:'custom-select',value:'四级',operations:['CLICK']};
const conflictingEnglish=buildActionPlan([englishDefault],{englishLevels:[{level:'雅思IELTS',score:'7.0'}]},[],
  {title:'个人信息',dataBlock:'englishLevels',scopedSection:true,ignoreUnmapped:true});
assert.equal(conflictingEnglish.summary.satisfiedControls,0,'网站默认四级不能验收为雅思');
assert.ok(conflictingEnglish.summary.unresolved.some(item=>/已有值/.test(item.reason)));
const englishScore={index:'english-score',stableKey:'english-score',section:'个人信息',
  label:'英语等级成绩',kind:'input',value:'',operations:['TYPE_TEXT']};
const mismatchedExamScore=buildActionPlan([englishDefault,englishScore],
  {englishLevels:[{level:'雅思IELTS',score:'7.0'}]},
  [{kind:'bind',resumeField:'englishLevels[0].score',controlStableKey:englishScore.stableKey}],
  {title:'个人信息',dataBlock:'englishLevels',scopedSection:true,ignoreUnmapped:true});
assert.ok(mismatchedExamScore.summary.unresolved.some(item=>item.target===englishScore.index && /考试不同/.test(item.reason)),
  '雅思成绩在网页四级考试下进入组合字段冲突账本');
assert.ok(!mismatchedExamScore.actions.some(action=>action.target===englishScore.index),
  '考试类型核对通过后才开放成绩写入');
for (const label of ['高考总分','外语单科成绩','综合学科成绩']) {
  const unrelatedScore={...englishScore,index:label,stableKey:label,label};
  const scorePlan=buildActionPlan([unrelatedScore],{englishLevels:[{level:'雅思IELTS',score:'7.0'}]},[],
    {title:'个人信息',dataBlock:'englishLevels',scopedSection:true,ignoreUnmapped:true});
  assert.ok(!scorePlan.actions.some(action=>action.target===label && /\.score$/.test(action.resumeField || '')),
    `${label}与语言考试成绩保持数据用途隔离`);
}
const uncommitted=buildActionPlan([{...control,value:'本科',valueCommitted:false}],resume,[binding],page);
assert.notEqual(uncommitted.status,'done','选择框的搜索词通过网站提交后才算完成');
const skipped=buildActionPlan([control],resume,[{kind:'skip',skipControlKey:'local-selector'}],page);
assert.equal(skipped.status,'done','无匹配字段有明确出口');
assert.equal(skipped.summary.mappedControls,0);

const following={index:'f0_2',stableKey:'following-field',section:'学业资料',recordIndex:1,
  label:'学院名称',kind:'input',value:'',operations:['TYPE_TEXT']};
const completedPicker=buildActionPlan([{...control,value:'本科'},following],resume,
  [binding,{kind:'click',resumeField:binding.resumeField,controlStableKey:control.stableKey,
    controlKind:'custom-select'}],page);
assert.ok(completedPicker.actions.some(a=>a.operation==='BIND_FIELD' && a.target===following.index),
  '主表单回读完成后立即释放选择器事务，继续绑定其余空字段');

const schools=[0,1].map(i=>({index:`school-${i}`,stableKey:`school-key-${i}`,section:'学业资料',
  recordIndex:i,label:'学校名称',kind:'combobox',value:'',operations:['TYPE_TEXT','CLICK']}));
const currentSchool=buildActionPlan(schools,resume,[{kind:'type_text',resumeField:'education[1].institution',
  controlStableKey:schools[1].stableKey,controlKind:'combobox'}],page);
assert.ok(currentSchool.actions.filter(a=>a.operation==='TYPE_TEXT').every(a=>a.target===schools[1].index),
  '联想输入事务持续定位当前记录的稳定控件，保持其他记录完整');

const gender={index:'gender',stableKey:'gender-male',section:'个人信息',label:'性别',optionValue:'男',
  role:'radio',kind:'custom-radio',checked:true,operations:['CLICK']};
const blankName={index:'blank-name',stableKey:'name-field',section:'个人信息',label:'姓名',
  kind:'input',value:'',operations:['TYPE_TEXT']};
const afterRadio=buildActionPlan([gender,blankName],{basics:{gender:'男',name:'示例姓名'}},
  [{kind:'click',resumeField:'basics.gender',controlStableKey:gender.stableKey,controlKind:gender.kind}],
  {title:'个人信息',dataBlock:'basics',scopedSection:true,ignoreUnmapped:true});
assert.ok(afterRadio.actions.some(a=>a.operation==='BIND_FIELD' && a.target===blankName.index),
  '单选直接回读成功后继续发现当前分区的空字段');
const adjustment={index:'adjustment',stableKey:'adjustment-key',section:'个人信息',
  label:'是否接受志愿调剂',kind:'custom-select',value:'是',operations:['CLICK']};
const afterAdjustment=buildActionPlan([adjustment,blankName],{basics:{name:'示例姓名'}},
  [{kind:'click',formRule:'job-adjustment-yes',controlStableKey:adjustment.stableKey,
    controlKind:'option-item',context:'popup',label:'是'}],
  {title:'个人信息',dataBlock:'basics',scopedSection:true,recordScope:true,ignoreUnmapped:true});
assert.ok(afterAdjustment.actions.some(a=>a.operation==='BIND_FIELD' && a.target===blankName.index),
  '固定规则选择回读后释放事务，个人信息继续进入语义绑定');
const dateControl={index:'date',stableKey:'date-key',section:'教育经历',recordIndex:0,
  label:'起止时间 · 开始时间',kind:'date',value:'',operations:['CLICK']};
const years=[2023,2024,2025,2026].map(year=>({index:`year-${year}`,label:String(year),
  kind:'option-item',context:'popup',operations:['CLICK']}));
const yearPlan=buildActionPlan([dateControl,...years],{education:[{startDate:'2025-09-01'}]},
  [{kind:'click',resumeField:'education[0].startDate',controlStableKey:dateControl.stableKey}],
  {title:'教育经历',dataBlock:'education',recordScope:true,recordIndex:0,ignoreUnmapped:true});
assert.equal(yearPlan.actions[0]?.target,'year-2025','年月面板的年份网格直接选择来源年份');
const olderYear=buildActionPlan([dateControl,...years,{index:'previous-years',label:'上一页',
  kind:'option-item',context:'popup',operations:['CLICK']}],{education:[{startDate:'2001-02-10'}]},
  [{kind:'click',resumeField:'education[0].startDate',controlStableKey:dateControl.stableKey}],
  {title:'教育经历',dataBlock:'education',recordScope:true,recordIndex:0,ignoreUnmapped:true});
assert.equal(olderYear.actions[0]?.target,'previous-years','目标年份在网格之外时切换年份页');
const modeControl={index:'mode',stableKey:'mode-key',label:'学历类型',kind:'custom-select',
  section:'教育经历',recordIndex:0,value:'',operations:['CLICK']};
const inspectedMode=buildActionPlan([modeControl,{index:'overseas',label:'海外及港澳台',
  context:'popup',kind:'option-item',operations:['CLICK']}],
  {education:[{institution:'香港示例大学',studyMode:'全日制'}]},
  [{kind:'inspect',controlStableKey:'mode-key'},{kind:'bind',controlStableKey:'mode-key',
    resumeField:'education[0].studyMode'}],
  {title:'教育经历',dataBlock:'education',recordScope:true,recordIndex:0,ignoreUnmapped:true});
assert.equal(inspectedMode.actions[0]?.target,'overseas','观察选项后绑定字段，连续完成当前选择器事务');
assert.equal(buildQuestions('完成当前教育字段',inspectedMode).action.criteria[inspectedMode.actions[0].id].selected_value,
  '海外及港澳台','候选明确提供由学校证据解析出的页面分类值');
const declaration=buildActionPlan([{index:'declaration',kind:'custom-checkbox',role:'checkbox',
  label:'本人承诺以上资料全部属实，并接受背景调查',section:'候选人声明',checked:false,operations:['CLICK']}],{},[],
  {title:'候选人声明',dataBlock:'siteRules',sectionScope:true});
assert.ok(declaration.actions.some(action=>action.formRule==='agreement'),
  '真实性与背景调查勾选作为需本轮授权的声明处理');
const sourceControl={index:'source',stableKey:'source',label:'校招信息来源',section:'个人信息',
  kind:'custom-select',value:'',operations:['CLICK']};
const sourceResume={basics:{name:'示例'},application:{recruitmentSource:'校园招聘官网'}};
const sourcePopup=buildActionPlan([sourceControl,{index:'official-channel',label:'企业官网/招聘公众号',
  kind:'option-item',context:'popup',operations:['CLICK']}],sourceResume,
  [{kind:'click',resumeField:'application.recruitmentSource',controlStableKey:'source'}],
  {title:'个人信息',dataBlock:'application',sectionScope:true,recordScope:true});
assert.equal(sourcePopup.actions[0].resolvedValue,'企业官网/招聘公众号');
assert.equal(buildSectionJevState({page:{title:'个人信息',dataBlock:'application',sectionScope:true},
  elements:[sourceControl],resume:sourceResume,actionPlan:sourcePopup}).json_fields.recruitmentSource,'校园招聘官网');
assert.ok(!buildActionPlan([sourceControl],sourceResume,[],{title:'个人信息',dataBlock:'basics',recordScope:true})
  .actions.some(action=>action.formRule==='recruitment-source'), '来源随 application 资料块绑定和执行');
assert.equal(hasSelectedRadioPeer({role:'radio',label:'无',choiceGroup:'referral'},
  [{role:'radio',label:'大使推荐',choiceGroup:'referral',checked:true}]),true,
  '选项标签不同的同组单选由实际选中状态验收');
const availabilityControl={index:'available',stableKey:'available',kind:'date',section:'个人信息',
  label:'可提前实习周期 · 开始时间',operations:['CLICK']};
const availabilityPlan=buildActionPlan([availabilityControl],{internship:[{startDate:'2026-07-01'}]},[],
  {title:'个人信息',dataBlock:'internship',recordScope:true});
assert.ok(!availabilityPlan.actions.some(action=>action.resumeField==='internship[0].startDate'),
  '未来可实习时间只接受明确的可用时间事实，经历时间保留在经历记录内');
const explicitAvailability=buildActionPlan([availabilityControl],{application:{availabilityStartDate:'2026-11-30'}},[],
  {title:'个人信息',dataBlock:'application',recordScope:true});
assert.ok(explicitAvailability.actions.some(action=>action.resumeField==='application.availabilityStartDate'));

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
const splitEmployment=buildDataBlockPlan('工作经历',[],{internship:[{company:'实习公司'}],
  projects:[{name:'独立项目'}],campusPractice:[{position:'班长'}]},[],
  {sectionOutline:['工作经历','实习经历','项目经历']});
assert.ok(splitEmployment.actions.some(action=>action.dataBlock==='internship') &&
  splitEmployment.actions.some(action=>action.operation==='NO_DATA_BLOCK'),
  '标题提供语义提示，保留完整候选与无资料出口供 Jev 判断');
assert.ok(buildDataBlockPlan('工作经历',[],{internship:[{company:'实习公司'}]},[],
  {sectionOutline:['工作经历']}).actions.some(action=>action.dataBlock==='internship'),
  '只有一个工作经历入口时仍由 Jev 判断是否容纳实习资料');
const distinctRecords={internship:[{company:'实习公司'}],campusPractice:[{position:'班长'}],
  publications:[{title:'论文'}],patents:[{name:'发明专利'}]};
assert.equal(fieldBindingThreshold({kind:'checkbox',label:'至今',fieldTerms:['至今','目前'],
  resumeField:'internship[0].endDate.isPresent',semanticValue:'是'}),0.65,'明确持续中的日期与至今复选框使用精确绑定门槛');
assert.equal(fieldBindingThreshold({kind:'checkbox',label:'其他',fieldTerms:['至今'],
  resumeField:'internship[0].endDate.isPresent'}),0.75,'不匹配的复选框保持常规门槛');
assert.equal(buildDataBlockPlan('实习经历',[],distinctRecords).actions[0].dataBlock,'internship',
  '标题提示用于排序');
assert.equal(buildDataBlockPlan('论文/专著',[],distinctRecords).actions[0].dataBlock,'publications',
  '标题提示用于排序，同时保留其他候选');
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
const ledger={'个人信息|*':{activeBlock:'education'},[recordLedgerKey('个人信息','education',resume,0)]:{completed:true}};
const sectionPlan=buildSectionPlan(sectionControls,resume,ledger,{focusSection:'个人信息'});
assert.ok(sectionPlan.actions.every(action=>!action.section || action.section==='个人信息'),'深度优先保持当前 section');
assert.ok(sectionPlan.actions.some(action=>action.collection==='education'),'已选 JSON 块覆盖标题默认提示');
console.log('Hierarchical routing, persistent field binding, complete local context and bounded exits passed');

const descriptionTarget={index:'description',stableKey:'intern-description',section:'实习经历',
  label:'实习内容',kind:'textarea',recordIndex:0,value:'',operations:['TYPE_TEXT']};
const duplicateDescription=buildActionPlan([descriptionTarget],{internship:[{
  summary:'同一段实习正文',responsibilities:'同一段实习正文'
}]},[],{title:'实习经历',dataBlock:'internship',recordScope:true,recordIndex:0,
  scopedSection:true,ignoreUnmapped:true});
assert.equal(duplicateDescription.actions.filter(a=>a.operation==='BIND_FIELD' &&
  a.semanticValue==='同一段实习正文').length,1,'同一控件的相同写入结果合并，避免选择概率分散');
assert.equal(duplicateDescription.actions.find(a=>a.operation==='BIND_FIELD')?.resumeField,
  'internship[0].summary','沿匹配实习内容的别名保留明确来源');
const attachmentChoice=buildActionPlan([{index:'photo',label:'证件照',section:'附件',
  stableKey:'photo',kind:'file',value:'',operations:['UPLOAD_FILE']}],
  {basics:{photo:{name:'portrait.png',type:'image/png',dataUrl:'data:image/png;base64,LOCAL'}}},[],
  {title:'附件',dataBlock:'basics',scopedSection:true,ignoreUnmapped:true});
assert.equal(attachmentChoice.actions.find(a=>a.operation==='BIND_FIELD')?.fieldLabel,'简历照片',
  '附件候选保留用途语义，照片与简历文件可区分');

const presentControl={index:'present',stableKey:'present',section:'实习经历',label:'至今',
  kind:'checkbox',checked:false,recordIndex:0,operations:['CLICK']};
const presentResume={internship:[{company:'示例公司',isPresent:true,endDate:'至今'}]};
const presentPage={title:'实习经历',dataBlock:'internship',recordIndex:0,recordScope:true,
  scopedSection:true,ignoreUnmapped:true};
const presentChoice=buildActionPlan([presentControl],presentResume,[],presentPage);
const presentBinding=presentChoice.actions.find(a=>a.operation==='BIND_FIELD');
assert.ok(presentBinding,'至今勾选进入本记录的字段选择候选');
assert.ok(buildActionPlan([presentControl],presentResume,[{...presentBinding,kind:'bind'}],presentPage)
  .actions.some(a=>a.operation==='CLICK'),'绑定后由统一点击操作执行');
assert.equal(buildActionPlan([{...presentControl,checked:true}],presentResume,
  [{...presentBinding,kind:'bind'}],presentPage).status,'done','至今状态回读后完成事务');
const finiteInternship={internship:[{company:'示例公司',endDate:'2026-07'}]};
assert.equal(buildActionPlan([presentControl],finiteInternship,[],presentPage)
  .summary.fieldGroups.find(group=>group.label==='至今')?.status,'completed',
  '有明确结束月份的经历把未勾选至今判为已满足');
const patentDate=buildActionPlan([{index:'grant',stableKey:'grant',section:'附加信息',label:'授权日期',
  kind:'beisen-date',value:'',operations:['CLICK'],recordIndex:0}],
  {patents:[{date:'2024-11'}]},[],{title:'附加信息',dataBlock:'patents',recordScope:true,
    recordIndex:0,scopedSection:true,ignoreUnmapped:true});
assert.equal(patentDate.actions.find(action=>action.operation==='BIND_FIELD')?.resumeField,
  'patents[0].date','专利日期可绑定授权日期控件');

const fileResume={basics:{resumeFile:{name:'resume.pdf',dataUrl:'data:application/pdf;base64,LOCAL'}}};
const fileControls=[0,1].map(i=>({index:`file-${i}`,stableKey:`file-${i}`,section:'简历附件',
  label:'上传简历',kind:'file',value:'',operations:['UPLOAD_FILE']}));
const fileBindings=fileControls.map(control=>({kind:'bind',controlStableKey:control.stableKey,
  resumeField:'basics.resumeFile'}));
const filePlan=buildActionPlan(fileControls,fileResume,[...fileBindings,{kind:'upload_file',
  resumeField:'basics.resumeFile',controlStableKey:'file-0',verified:true}],
  {title:'简历附件',dataBlock:'basics',scopedSection:true,ignoreUnmapped:true});
assert.ok(filePlan.actions.some(a=>a.operation==='UPLOAD_FILE' && a.target==='file-1'),
  '同一附件在另一个上传控件中继续执行独立上传');
