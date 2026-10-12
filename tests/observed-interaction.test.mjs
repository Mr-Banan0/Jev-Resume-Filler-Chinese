import assert from 'node:assert/strict';
import {buildObservedActionPlan,observedValueMatches} from '../lib/observed-interaction.js';
import {buildQuestions,buildSectionJevState,choose} from '../lib/jev-client.js';
import {DEFAULT_INTERACTION_POLICY,resolveInteractionPolicy} from '../lib/interaction-policy.js';
import {sourceContracts} from '../lib/source-contracts.js';

assert.equal(DEFAULT_INTERACTION_POLICY,'observed');
for(const value of [undefined,null,'','unknown','observed']) assert.equal(resolveInteractionPolicy(value),'observed');
assert.equal(resolveInteractionPolicy('adapted'),'adapted','保留用户显式选择的对照策略');
const academic=sourceContracts([],{education:[{gpa:'82/100',ranking:'TOP40%'}]},'education',0);
assert.equal(academic.find(f=>f.contract==='academic-results').value,'成绩：82/100；排名：TOP40%');
const summaries=sourceContracts([],{campusPractice:[{position:'班长'},{position:'志愿者'}]},'campusPractice',0,{summaryScope:true});
assert.equal(summaries.filter(f=>f.contract==='record-summary').length,2,
  '汇总文本可选择单条相关经历，保持混合资料的主题边界');

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
const schoolAlternative=control('schoolOther','学校名称','checkbox',{questionLabel:'学校名称',optionLabel:'其他',checked:false});
{
  const history=[{kind:'focus',controlStableKey:'school'},
    {kind:'bind',controlStableKey:'school',resumeField:'education[0].institution'}];
  const search=control('search','搜索学校','input',{context:'popup',popupOwnerKey:'school',
    value:'合成大学',observed:{tag:'input',rawValue:'合成大学'}});
  const searched=buildObservedActionPlan([controls[0],search],resume,history,page);
  assert.ok(searched.actions.some(a=>a.operation==='SUBMIT_SEARCH'));
  assert.ok(!searched.actions.some(a=>a.operation==='TYPE_TEXT'),'相同搜索词保持原状，只提交一次搜索');
  const read=buildObservedActionPlan([controls[0],search],resume,[...history,
    {kind:'submit_search',controlStableKey:'school',resumeField:'education[0].institution'}],page);
  assert.ok(!read.actions.some(a=>a.operation==='SUBMIT_SEARCH'),'同一查找事务的 Enter 有界执行');
}
assert.ok(!buildObservedActionPlan([{...controls[0],value:'合成大学'},schoolAlternative],resume,[],page).actions
  .some(action=>action.target==='schoolOther'),'学校已填写时，辅助其他选项保持未勾选并退出空字段候选');
assert.ok(buildObservedActionPlan([controls[0],schoolAlternative],resume,[],page).actions
  .some(action=>action.target==='schoolOther'),'学校为空时，其他路径仍可被观察');
const focus=[{kind:'focus',controlStableKey:'novel',label:'科研方向'}];
plan=buildObservedActionPlan(controls,resume,focus,page);
assert.ok(plan.actions.some(a=>a.resumeField==='education[0].novelFact'),'当前 JSON 块的新字段进入候选');
assert.ok(Object.values(buildQuestions('填写当前记录',plan).action.criteria).some(a=>
  a.source_field==='education[0].studyMode' && a.source_meaning),'来源字段含义进入真实 Jev 请求');
assert.ok(plan.actions.some(a=>a.operation==='SKIP_FIELD'));
{
  const searchable=control('searchable','所在地','combobox',{role:'combobox',operations:['TYPE_TEXT','CLICK']});
  const inspected=buildObservedActionPlan([searchable],resume,[{kind:'focus',controlStableKey:'searchable'}],page);
  assert.equal(inspected.observation.phase,'inspect','搜索型选择器先读取可选项再绑定来源');
  assert.equal(inspected.actions[0].inspectField,true);
  const after=buildObservedActionPlan([searchable],resume,[{kind:'focus',controlStableKey:'searchable'},
    {kind:'inspect',controlStableKey:'searchable'}],page);
  assert.equal(after.observation.phase,'bind','一次观察无可见选项后进入绑定，有界退出');
  assert.ok(after.actions.some(a=>a.operation==='SKIP_FIELD'));
}
const salary={index:'salary',stableKey:'salary',section:'求职意向',label:'期望薪酬（元）',kind:'input',value:'',
  operations:['TYPE_TEXT'],observed:{type:'number',inputMode:'decimal'}};
const salaryFacts={expected:{salary:'1.6-2.4万元/月',salaryMinimumMonthly:'16000',salaryMaximumMonthly:'24000'}};
const salaryPage={title:'求职意向',dataBlock:'expected',recordIndex:0,sectionScope:true};
const salaryPlan=buildObservedActionPlan([salary],salaryFacts,[{kind:'focus',controlStableKey:'salary'}],salaryPage);
assert.ok(!salaryPlan.actions.some(action=>action.resumeField==='expected.salary'),
  '数字控件提供可写标量来源，保留区间原文在资料中');
assert.ok(salaryPlan.actions.some(action=>action.resumeField==='expected.salaryMinimumMonthly'));
assert.equal(buildSectionJevState({page:salaryPage,elements:[salary],resume:salaryFacts,actionPlan:salaryPlan})
  .controls[0].observed.inputMode,'decimal','字段约束进入局部语义判断');
assert.ok(!JSON.stringify(buildQuestions('填写当前记录',plan)).includes('PRIVATE_BYTES'));
assert.ok(!JSON.stringify(buildSectionJevState({page,elements:controls,resume,actionPlan:plan})).includes('外部分区秘密项目'));

const description='合成工作描述：实现指标计算、接口开发及回归验证。'.repeat(6);
const duplicatePlan=buildObservedActionPlan([control('description','工作描述')],
  {internship:[{summary:description,responsibilities:description,startDate:'2026-07',endDate:'2026-07'}]},
  [{kind:'focus',controlStableKey:'description'}],{...page,dataBlock:'internship'});
const descriptionChoices=duplicatePlan.actions.filter(action=>action.semanticValue===description);
assert.equal(descriptionChoices.length,1,'相同长文内容合并为一个值候选，减少等价答案分摊置信');
assert.ok(descriptionChoices[0].sourceAliases.some(alias=>alias.path.endsWith('.responsibilities')));
assert.ok(Object.values(buildQuestions('填写工作描述',duplicatePlan).action.criteria).some(choice=>
  choice.identical_value_aliases?.length),'等价内容保留全部字段语义');
assert.ok(duplicatePlan.actions.some(action=>action.resumeField==='internship[0].startDate'));
assert.ok(duplicatePlan.actions.some(action=>action.resumeField==='internship[0].endDate'),
  '独立日期字段继续保留各自归属');

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
assert.equal(observedValueMatches({...controls[1],value:'2026-11-04'},'2026-11'),false,'需要具体日时验证用户约定的 1 日');
assert.equal(observedValueMatches({...controls[1],value:'2026-11-01'},'2026-11'),true);
assert.equal(observedValueMatches({kind:'checkbox',checked:false},'否'),true);
{
  const source={education:[{endDate:'2026-11-30'}]};
  const calendar=[control('calendar-input','日期检索','date',{context:'popup',popupOwnerKey:'date',operations:['TYPE_TEXT']}),
    control('year-select','2026年','action',{context:'popup',popupOwnerKey:'date',observed:{title:'选择年份'}}),
    control('month-select','10月','action',{context:'popup',popupOwnerKey:'date',observed:{title:'选择月份'}}),
    control('visible-day','30','option-item',{context:'popup',popupOwnerKey:'date',calendarDate:'2026-10-30'})];
  const opened=buildObservedActionPlan([...controls,...calendar],source,dateHistory,page);
  assert.deepEqual(opened.actions.filter(a=>a.calendarStep).map(a=>a.target),['month-select']);
  assert.ok(!opened.actions.some(a=>a.operation==='TYPE_TEXT'),'真实日历存在时，通过日期节点提交值');
  const dayPlan=buildObservedActionPlan([...controls,...calendar,
    control('desired-day','30','option-item',{context:'popup',popupOwnerKey:'date',calendarDate:'2026-11-30'})],
    source,dateHistory,page);
  assert.deepEqual(dayPlan.actions.filter(a=>a.calendarStep).map(a=>a.target),['desired-day'],
    '相同日数字通过格子的完整日期区分');
  const yearGrid=Array.from({length:12},(_,i)=>control(`year-${i}`,String(2019+i),'option-item',
    {context:'popup',popupOwnerKey:'date'}));
  const yearPlan=buildObservedActionPlan([...controls,...calendar,...yearGrid],source,dateHistory,page);
  assert.deepEqual(yearPlan.actions.filter(a=>a.calendarStep).map(a=>a.label),['2026'],
    '年份列表出现后优先选择年份格子，底层日历保留时也能推进');
  const months=Array.from({length:12},(_,i)=>control(`month-${i}`,`${i+1}月`,'option-item',
    {context:'popup',popupOwnerKey:'date'}));
  const yearHeader=control('grid-year','2030','option-item',{context:'popup',popupOwnerKey:'date'});
  const monthGrid=buildObservedActionPlan([...controls,yearHeader,...months],source,dateHistory,page);
  assert.deepEqual(monthGrid.actions.filter(a=>a.calendarStep).map(a=>a.target),['grid-year'],
    '月份面板中的单个年份先进入年份选择，保证月份归属正确的年份');
  const rightYear=buildObservedActionPlan([...controls,{...yearHeader,label:'2026'},...months],source,dateHistory,page);
  assert.deepEqual(rightYear.actions.filter(a=>a.calendarStep).map(a=>a.label),['11月']);
  const beisenDate={awards:[{date:'2026-10-05'}]};
  const beisenControl=control('beisen-date','获奖时间','beisen-date',{section:'获奖情况'});
  const beisenHistory=[{kind:'focus',controlStableKey:'beisen-date'},
    {kind:'bind',controlStableKey:'beisen-date',resumeField:'awards[0].date'}];
  const beisenGrid=[control('beisen-year','2026年','action',{context:'popup',popupOwnerKey:'beisen-date',observed:{capabilities:['CLICK']}}),
    control('beisen-month','10月','action',{context:'popup',popupOwnerKey:'beisen-date',observed:{capabilities:['CLICK']}}),
    ...Array.from({length:42},(_,i)=>control(`beisen-day-${i}`,String([28,29,30,...Array.from({length:31},(_,n)=>n+1),1,2,3,4,5,6,7,8][i]),
      'option-item',{context:'popup',popupOwnerKey:'beisen-date',domOrder:i,observed:{capabilities:['CLICK']}}))];
  const beisenDay=buildObservedActionPlan([beisenControl,...beisenGrid],beisenDate,beisenHistory,
    {...page,title:'获奖情况',dataBlock:'awards'});
  assert.deepEqual(beisenDay.actions.filter(a=>a.calendarStep).map(a=>a.target),['beisen-day-7'],
    '北森年月标题可确定当前月份，并按网格位置定位唯一的本月日期');
  const beisenNavigate=buildObservedActionPlan([beisenControl,...beisenGrid],
    {awards:[{date:'2026-11-05'}]},beisenHistory,{...page,title:'获奖情况',dataBlock:'awards'});
  assert.deepEqual(beisenNavigate.actions.filter(a=>a.calendarStep).map(a=>a.target),['beisen-month'],
    '北森日历先将标题导航到来源月份，再点日期');
}
const awardLevel={index:'award-level',stableKey:'award-level',section:'教育经历',kind:'observed-field',label:'奖励级别',value:'',operations:['CLICK']};
const awardHistory=[{kind:'focus',controlStableKey:'award-level'},{kind:'bind',controlStableKey:'award-level',resumeField:'awards[0].level'}];
const awardOptions=['国际级','国家级','省部级'].map(label=>({index:label,stableKey:label,section:'教育经历',context:'popup',
  popupOwnerKey:'award-level',kind:'option-item',label,operations:['CLICK']}));
const awardPlan=buildObservedActionPlan([awardLevel,...awardOptions],{awards:[{level:'全国'}]},awardHistory,{...page,dataBlock:'awards'});
const awardChoice=await choose({apiKey:'unused',goal:'填写奖励级别',resume:{awards:[{level:'全国'}]},history:awardHistory,
  actionPlan:awardPlan,page:{...page,dataBlock:'awards'},elements:[awardLevel,...awardOptions]});
assert.equal(awardChoice.label,'国家级','已绑定的全国奖项使用明确等价的国家级选项');
assert.equal(awardChoice.decisionSource,'verified-binding');

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
const generic=control('generic','证件号码','observed-field');
plan=buildObservedActionPlan([generic],resume,[{kind:'focus',controlStableKey:'generic'}],page);
assert.equal(plan.observation.phase,'inspect','无语义显示槽通过实际选项消歧');
assert.ok(plan.actions[0].inspectField);
const basics={basics:{birthPlace:'广东省广州市黄埔区'}};
const geoPage={title:'基础信息',dataBlock:'basics',recordIndex:0,recordScope:true};
const geo={index:'geo',stableKey:'geo',section:'基础信息',kind:'input',label:'出生地',value:'',operations:['CLICK'],observed:{readonly:true,capabilities:['CLICK']}};
const geoHistory=[{kind:'focus',controlStableKey:'geo'},{kind:'bind',controlStableKey:'geo',resumeField:'basics.birthPlace'}];
const options=['广东省','广州市','深圳市'].map(label=>({index:label,stableKey:label,section:'基础信息',kind:'option-item',label,context:'popup',popupOwnerKey:'geo',operations:['CLICK']}));
plan=buildObservedActionPlan([geo,...options],basics,geoHistory,geoPage);
assert.deepEqual(plan.actions.filter(a=>a.addressStep).map(a=>a.label),['广东省'],'显示的下级列表可能是缓存，从省份开始确认当前地址');
plan=buildObservedActionPlan([geo,...options],basics,[...geoHistory,{kind:'click',resumeField:'basics.birthPlace',selectedLabel:'广东省',page_changed:true}],geoPage);
assert.deepEqual(plan.actions.filter(a=>a.addressStep).map(a=>a.label),['广州市']);
plan=buildObservedActionPlan([geo,...options],basics,[...geoHistory,{kind:'click',resumeField:'basics.birthPlace',selectedLabel:'广东省',page_changed:false}],geoPage);
assert.deepEqual(plan.actions.filter(a=>a.addressStep).map(a=>a.label),['广州市'],
  '父级已选导致文字不变时，成功点击后仍按下一层可见选项推进');
const confirmed={index:'confirm',stableKey:'confirm',section:'基础信息',kind:'option-item',label:'确认',context:'popup',popupOwnerKey:'geo',operations:['CLICK'],popupSelection:'已选择：广东省 > 广州市 > 黄埔区'};
plan=buildObservedActionPlan([geo,confirmed],basics,geoHistory,geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'地址须由已选择摘要证实后才能确认');
plan=buildObservedActionPlan([geo,{...confirmed,popupSelection:'已选择：广东省 × 广州市 × 黄埔区 ×'}],basics,geoHistory,geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'摘要中的删除图标保留为界面装饰');
plan=buildObservedActionPlan([geo,{...confirmed,popupSelection:'已选择：广东省 × 河源市 × 和平县 ×'}],
  {basics:{birthPlace:'广东河源和平县'}},geoHistory,geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'行政区后缀省略的来源可与完整摘要核对');
plan=buildObservedActionPlan([geo,...options.map(option=>({...option,label:option.label==='广州市'?'河源市':option.label}))],
  {basics:{birthPlace:'广东河源和平县'}},[...geoHistory,{kind:'click',resumeField:'basics.birthPlace',selectedLabel:'广东省',page_changed:true}],geoPage);
assert.deepEqual(plan.actions.filter(a=>a.addressStep).map(a=>a.label),['河源市'],'行政区后缀省略的来源仍可导航到城市');
plan=buildObservedActionPlan([geo,...options.map(option=>({...option,popupSelection:'已选择：广东省 × 广州市 ×'}))],basics,geoHistory,geoPage);
assert.equal(plan.actions.filter(a=>a.addressStep).length,0,'已选摘要中的省市继续保持选中状态');
plan=buildObservedActionPlan([geo,{...confirmed,popupSelection:'已选择：广东省 > 深圳市 > 宝安区'}],basics,geoHistory,geoPage);
assert.ok(!plan.actions.some(a=>a.selectionCommit),'不同地址保持待核对');
const calendarPopup=Array.from({length:12},(_,i)=>({...control(`year-${i}`,String(2020+i),'option-item'),context:'popup',popupOwnerKey:'date'}));
plan=buildObservedActionPlan([...controls,...calendarPopup],resume,dateHistory,page);
assert.deepEqual(plan.actions.filter(a=>a.calendarStep).map(a=>a.label),['2026']);
const olderBirthday={education:[{endDate:'1954-08-17'}]};
for(const firstYear of [2020,2008,1996,1984,1972,1960,1948]) {
  const years=Array.from({length:12},(_,i)=>({...control(`year-${i}`,String(firstYear+i),'option-item'),context:'popup',popupOwnerKey:'date'}));
  const nav=['<','>'].map(label=>({...control(label,label,'action'),context:'popup',popupOwnerKey:'date'}));
  const olderPlan=buildObservedActionPlan([...controls,...years,...nav],olderBirthday,dateHistory,page);
  assert.deepEqual(olderPlan.actions.filter(action=>action.calendarStep).map(action=>action.label),[firstYear>1954?'<':'1954'],
    '跨组年份导航逐次根据新范围选择，直到目标年份可见');
}
const monthResume={education:[{endDate:'2026-11'}]};
const days=Array.from({length:30},(_,i)=>({...control(`day-${i}`,String(i+1),'option-item'),context:'popup',popupOwnerKey:'date'}));
plan=buildObservedActionPlan([...controls,...days],monthResume,dateHistory,page);
assert.deepEqual(plan.actions.filter(a=>a.calendarStep).map(a=>a.label),['1'],'年月来源遇到日历按已授权约定选择 1 日');
const cityResume={basics:{location:{city:'深圳',region:{province:'广东省',city:'深圳市',district:'宝安区'}}}};
assert.equal(observedValueMatches({label:'出生地',value:'广东省-广州市-黄埔区'},'广东省广州市黄埔区'),true);
assert.equal(observedValueMatches({label:'出生地',value:'广东省-深圳市-宝安区'},'广东省广州市黄埔区'),false);
plan=buildObservedActionPlan([geo],cityResume,[{kind:'focus',controlStableKey:'geo'},{kind:'inspect',controlStableKey:'geo'}],geoPage);
assert.ok(plan.actions.some(a=>a.resumeField==='basics.location.region.city'));
assert.ok(!plan.actions.some(a=>a.resumeField==='basics.location.city'),'同一地址的等价城市只提供一个候选');
const cityHistory=[{kind:'focus',controlStableKey:'geo'},{kind:'bind',controlStableKey:'geo',resumeField:'basics.location.region.city'}];
plan=buildObservedActionPlan([{...geo,label:'现居城市'},{...confirmed,popupSelection:'已选择：广东省 × 深圳市 ×'}],
  cityResume,cityHistory,geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'城市字段的确认只需要同一地址的省市证据');
plan=buildObservedActionPlan([{...geo,label:'现居城市'},
  {...confirmed,popupSelection:'已选择：广东省 × 深圳市 ×'},
  {...confirmed,index:'district',label:'宝安区',popupSelection:'已选择：广东省 × 深圳市 ×'}],cityResume,cityHistory,geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'城市来源在区县列表可见时仍按城市精度确认');
assert.deepEqual(plan.actions.filter(a=>a.addressStep).map(a=>a.label),[]);
plan=buildObservedActionPlan([{...geo,label:'现居城市'},
  {...confirmed,popupSelection:'已选择：广东省 × 深圳市 ×'},
  ...['广东省','深圳市','宝安区'].map(label=>({...confirmed,index:label,label,popupSelection:'已选择：广东省 × 深圳市 ×'}))],
  cityResume,cityHistory,geoPage);
assert.ok(!plan.actions.some(a=>a.label==='深圳市'),'已选城市退出操作候选');
const cityChoice=await choose({apiKey:'synthetic',goal:'填写当前地址',resume:cityResume,history:cityHistory,
  actionPlan:plan,elements:[],page:geoPage});
assert.equal(cityChoice.label,'确认','当前绑定城市已在选择摘要中时优先确认该精度');
plan=buildObservedActionPlan([{...geo,label:'生源地'},
  {...confirmed,popupSelection:'已选择：广东省 × 广州市 ×'},
  {...confirmed,index:'county',label:'黄埔区',popupSelection:'已选择：广东省 × 广州市 ×'}],
  {basics:{studentOrigin:'广东省广州市'}},[{kind:'focus',controlStableKey:'geo'},
    {kind:'bind',controlStableKey:'geo',resumeField:'basics.studentOrigin'}],geoPage);
assert.ok(plan.actions.some(a=>a.selectionCommit),'来源到城市且网站提供确认时，验证城市摘要即可确认');
const partialChoice=await choose({apiKey:'synthetic',goal:'填写当前地址',resume:{basics:{studentOrigin:'广东省广州市'}},
  history:[{kind:'bind',controlStableKey:'geo',resumeField:'basics.studentOrigin'}],actionPlan:plan,elements:[],page:geoPage});
assert.equal(partialChoice.operation,'CLICK');
assert.equal(partialChoice.label,'确认');
plan=buildObservedActionPlan([{...geo,label:'生源地'},
  {...confirmed,popupSelection:undefined},{...confirmed,index:'county',label:'黄埔区',popupSelection:undefined}],
  {basics:{studentOrigin:'广东省广州市'}},[{kind:'focus',controlStableKey:'geo'},
    {kind:'bind',controlStableKey:'geo',resumeField:'basics.studentOrigin'},
    {kind:'click',resumeField:'basics.studentOrigin',selectedLabel:'广州市',page_changed:false}],geoPage);
assert.ok(!plan.observation.source_detail_gap,'区县列表的存在独立于字段要求的地址精度');
assert.ok(!plan.actions.some(a=>a.selectionCommit),'确认仍需真实已选摘要证据');
assert.equal(observedValueMatches({...geo,value:'中国大陆 / 广东省 / 深圳市'},'深圳市'),true);
assert.equal(observedValueMatches({...geo,value:'中国大陆 / 广东省 / 广州市'},'深圳市'),false);
const parentPlan=buildObservedActionPlan([{...geo,label:'现居城市'},
  {...confirmed,index:'country',label:'合成国家',pickerBranch:true,popupSelection:undefined}],
  cityResume,cityHistory,geoPage);
const parentCriterion=Object.values(buildQuestions('选择当前城市的上级',parentPlan).action.criteria)
  .find(action=>action.target==='country' && action.operation==='CLICK');
assert.equal(parentCriterion.option_kind,'branch','可展开选项向 Jev 明确表达中间导航用途');
assert.equal(parentCriterion.intermediate_navigation,true);
const selectableCityPlan=buildObservedActionPlan([{...geo,label:'现居城市'},
  ...['广东','深圳','宝安'].map(label=>({...confirmed,index:label,label,pickerBranch:true,popupSelection:undefined}))],
  cityResume,[...cityHistory,{kind:'click',resumeField:'basics.location.region.city',selectedLabel:'广东'}],geoPage);
const cityAction=selectableCityPlan.actions.find(action=>action.target==='深圳');
assert.deepEqual(selectableCityPlan.actions.filter(action=>action.addressStep).map(action=>action.label),['深圳'],
  '父级和目标已经同时可见时直接选择唯一等价目标');
assert.equal(cityAction.optionIntent,'select','达到来源城市精度时选择可展开城市的值槽');
assert.equal(cityAction.pickerBranch,false,'目标城市选择属于最终选择');
assert.equal(selectableCityPlan.actions.find(action=>action.target==='广东').optionIntent,'expand','上级节点继续用于导航');
assert.equal(Object.values(buildQuestions('填写城市',selectableCityPlan).action.criteria)
  .find(action=>action.target==='深圳').option_intent,'select','Jev 看到明确的选择意图');
const cityReceipt=[...cityHistory,{kind:'click',controlStableKey:'geo',resumeField:'basics.location.region.city',
  selectionEvidence:'已选择：广东省 × 深圳市 × 宝安区 ×'}];
plan=buildObservedActionPlan([{...geo,label:'现居城市',value:'广东省-深圳市-宝安区'}],cityResume,cityReceipt,geoPage);
assert.equal(plan.summary.fieldGroups[0].status,'satisfied','确认后的根字段回读与已选摘要一致时验收');
plan=buildObservedActionPlan([{...geo,label:'现居城市',value:'广东省-广州市-黄埔区'}],cityResume,cityReceipt,geoPage);
assert.notEqual(plan.summary.fieldGroups[0].status,'satisfied','确认摘要与根字段不一致时继续保留待核对');
plan=buildObservedActionPlan([control('other','最高学历院校','checkbox')],resume,[{kind:'focus',controlStableKey:'other'}],page);
assert.ok(!plan.actions.some(a=>a.resumeField==='education[0].institution'),'勾选框仅绑定布尔事实');
const largeResume={education:[Object.fromEntries(Array.from({length:270},(_,i)=>[`fact${i}`,`值${i}`]))]};
plan=buildObservedActionPlan(controls,largeResume,focus,page);
assert.equal(plan.observation.candidates_complete,false);
assert.ok(plan.actions.length<=255);
assert.ok(!plan.actions.some(action=>action.operation==='SKIP_FIELD'),'来源候选未完整覆盖时保留覆盖缺口');
{
  const end={index:'end',stableKey:'end',section:'实习经历',kind:'observed-field',label:'结束日期',value:'请选择',operations:['CLICK']};
  const years=[2025,2026,2027].map(year=>({index:`year${year}`,kind:'option-item',label:String(year),context:'popup',popupOwnerKey:'end',operations:['CLICK']}));
  const dates={internship:[{endDate:'至今',endDateFallback:'2026-11-30'}]};
  const localPage={title:'实习经历',dataBlock:'internship',recordIndex:0};
  const h=[{kind:'focus',controlStableKey:'end'},{kind:'inspect',controlStableKey:'end'}];
  const binding=buildObservedActionPlan([end,...years],dates,h,localPage).actions.find(a=>a.resumeField==='internship[0].endDate');
  assert.equal(binding.sourceValueOverride,'2026-11-30','日历无至今时，仅使用用户明确提供的替代日期');
  h.push({kind:'bind',controlStableKey:'end',resumeField:binding.resumeField,sourceValueOverride:binding.sourceValueOverride});
  const operate=buildObservedActionPlan([end,...years],dates,h,localPage);
  assert.ok(operate.actions.some(a=>a.label==='2026' && a.calendarStep));
  const done=buildObservedActionPlan([{...end,value:'2026-11-30'}],dates,h,localPage);
  assert.equal(done.summary.fieldGroups[0].status,'satisfied','替代日期在弹层关闭后继续按绑定值回读');
  const ongoing={index:'ongoing',section:'实习经历',label:'至今',kind:'checkbox',operations:['CLICK']};
  const native=buildObservedActionPlan([end,ongoing,...years],dates,h.slice(0,2),localPage);
  assert.equal(native.actions.find(a=>a.resumeField==='internship[0].endDate').sourceValueOverride,undefined);
}
{
  const dates={internship:[{company:'合成公司',endDate:'至今'}]};
  const localPage={title:'实习经历',dataBlock:'internship',recordIndex:0,recordScope:true};
  const end={index:'end',stableKey:'end',section:'实习经历',recordIndex:0,recordStableKey:'internship-row-0',
    kind:'date',label:'结束时间',value:'',operations:['CLICK']};
  const present={index:'present',stableKey:'present',section:'实习经历',recordIndex:0,
    recordStableKey:'internship-row-0',kind:'checkbox',role:'checkbox',label:'至今',checked:true,operations:['CLICK']};
  const history=[{kind:'focus',controlStableKey:'end'},
    {kind:'bind',controlStableKey:'end',resumeField:'internship[0].endDate'},
    {kind:'bind',controlStableKey:'present',resumeField:'internship[0].endDate.isPresent'}];
  const done=buildObservedActionPlan([end,present],dates,history,localPage);
  assert.ok(!done.actions.some(action=>action.target==='end' && action.operation==='FOCUS_FIELD'),
    '同条实习的至今已勾选时，结束日期事务按组合状态完成');
  assert.equal(done.summary.fieldGroups.find(group=>group.targets.includes('end'))?.status,'satisfied');
  const unchecked=buildObservedActionPlan([end,{...present,checked:false}],dates,
    history.filter(item=>item.controlStableKey!=='present'),localPage);
  assert.ok(unchecked.actions.some(action=>action.target==='end' && action.operation==='CLICK'),
    '至今未确认时，结束日期仍保留待处理');
}
{
  const source={internship:[{company:'合成公司',startDate:'2026-07',endDate:'至今',isPresent:false}]};
  const localPage={title:'实习经历',dataBlock:'internship',recordIndex:0,recordScope:true};
  const end={index:'end',stableKey:'end',section:'实习经历',recordIndex:0,recordStableKey:'internship-row-0',
    kind:'date',label:'结束时间',questionLabel:'结束时间',value:'',operations:['CLICK']};
  const present={index:'present',stableKey:'present',section:'实习经历',recordIndex:0,
    recordStableKey:'internship-row-0',kind:'checkbox',role:'checkbox',label:'至今',optionLabel:'至今',
    checked:false,operations:['CLICK']};
  const initial=buildObservedActionPlan([end,present],source,[],localPage);
  assert.ok(initial.actions.some(action=>action.operation==='FOCUS_FIELD' && action.target==='present'));
  assert.ok(!initial.actions.some(action=>action.operation==='FOCUS_FIELD' && action.target==='end'),
    '来源为至今且同记录有对应勾选框时，优先检查勾选框');
  const focus=[{kind:'focus',controlStableKey:'present'}];
  const bindingPlan=buildObservedActionPlan([end,present],source,focus,localPage);
  const binding=await choose({goal:'填写实习经历',resume:source,history:focus,page:localPage,
    elements:[end,present],actionPlan:bindingPlan});
  assert.equal(binding.resumeField,'internship[0].endDate.isPresent');
  assert.equal(binding.decisionSource,'same-record-present-checkbox');
  const bound=[...focus,{kind:'bind',controlStableKey:'present',resumeField:binding.resumeField}];
  const operatePlan=buildObservedActionPlan([end,present],source,bound,localPage);
  const click=await choose({goal:'填写实习经历',resume:source,history:bound,page:localPage,
    elements:[end,present],actionPlan:operatePlan});
  assert.equal(click.operation,'CLICK');
  assert.equal(click.target,'present');
  assert.equal(click.decisionSource,'same-record-present-checkbox');
  const complete=buildObservedActionPlan([end,{...present,checked:true}],source,bound,localPage);
  assert.equal(complete.summary.fieldGroups.find(group=>group.targets.includes('end'))?.status,'satisfied',
    '同记录勾选状态回读后，至今结束时间组合完成');
}
{
  const tab={index:'tab',stableKey:'tab',section:'语言证书',kind:'action',label:'英语证书',localView:true,operations:['CLICK']};
  const localPage={title:'语言证书',dataBlock:'languages',recordIndex:0,recordControlKeys:[]};
  const nav=buildObservedActionPlan([tab],{languages:[{certificate:'IELTS',score:'6.5'}]},[],localPage);
  assert.ok(!nav.actions.some(a=>a.viewNavigation),'互斥页签由调度器在字段填写前选择');
  const visited=buildObservedActionPlan([tab],{languages:[{certificate:'IELTS'}]},[{kind:'click',controlStableKey:'tab'}],localPage);
  assert.ok(!visited.actions.some(a=>a.viewNavigation),'字段循环保持记录编辑类型');
}
{
  const url='https://synthetic.example/resume',localPage={url,title:'个人信息',dataBlock:'basics'};
  const correctionResume={basics:{hasOverseasStudy:'是'},fillPolicy:{sitePolicies:[{host:'synthetic.example',
    corrections:[{question:'有无海外留学经验',sourceField:'basics.hasOverseasStudy'}]}]}};
  const choices=['是','否'].map((value,i)=>({index:`overseas${i}`,stableKey:`overseas${i}`,section:'个人信息',
    kind:'radio',questionLabel:'有无海外留学经验',label:'有无海外留学经验',optionLabel:value,checked:i===1,
    choiceGroup:'overseas',operations:['CLICK']}));
  const h=[{kind:'focus',controlStableKey:'overseas0'}];
  const correction=buildObservedActionPlan(choices,correctionResume,h,localPage);
  assert.equal(correction.observation.user_authorized_correction,true);
  assert.ok(correction.actions.some(action=>action.operation==='CLICK' && action.label==='是'),
    '用户指定问题的已有值按确认来源修正');
  const done=buildObservedActionPlan(choices.map((c,i)=>({...c,checked:i===0})),correctionResume,h,localPage);
  assert.ok(!done.actions.some(action=>action.operation==='FOCUS_FIELD'));
  assert.ok(done.summary.fieldGroups.every(group=>group.status==='satisfied'),'整组回读一致后结束修正');
  const elsewhere=buildObservedActionPlan(choices,correctionResume,h,{...localPage,url:'https://elsewhere.example/resume'});
  assert.ok(!elsewhere.actions.some(action=>action.operation==='CLICK'),'修正授权限定到指定网站');
  const untouched=buildObservedActionPlan(choices,{basics:{hasOverseasStudy:'是'}},h,localPage);
  assert.ok(!untouched.actions.some(action=>action.operation==='CLICK'),'普通填写继续保留已有值');
}
{
  const briefResume={projects:[{description:'完整描述'.repeat(200),descriptionShort:'来自同一经历的短版描述。'}]};
  const target={index:'description',stableKey:'description',section:'项目经历',kind:'textarea',label:'项目描述',
    maxLength:500,operations:['TYPE_TEXT']};
  const localPage={title:'项目经历',dataBlock:'projects',recordIndex:0};
  const history=[{kind:'focus',controlStableKey:'description'}];
  const bind=buildObservedActionPlan([target],briefResume,history,localPage);
  const chosen=bind.actions.find(action=>action.resumeField==='projects[0].description');
  assert.equal(chosen.sourceValueOverride,briefResume.projects[0].descriptionShort);
  const full=buildObservedActionPlan([{...target,maxLength:2000}],briefResume,history,localPage);
  assert.equal(full.actions.find(action=>action.resumeField==='projects[0].description').sourceValueOverride,undefined,
    '容量足够时保留完整原文');
}
{
  const author={index:'author',stableKey:'author',section:'论文',kind:'observed-field',label:'作者排序',
    value:'请选择',operations:['CLICK']};
  const options=['第一作者','第二作者','其他'].map((label,index)=>({index:`order${index}`,label,
    kind:'option-item',context:'popup',popupOwnerKey:'author',operations:['CLICK']}));
  const source={publications:[{authorOrder:'第三作者'}]},page={title:'论文',dataBlock:'publications',recordIndex:0};
  const history=[{kind:'focus',controlStableKey:'author'},{kind:'inspect',controlStableKey:'author'},
    {kind:'bind',controlStableKey:'author',resumeField:'publications[0].authorOrder'}];
  const plan=buildObservedActionPlan([author,...options],source,history,page);
  const choice=await choose({apiKey:'synthetic',goal:'填写作者排序',resume:source,history,page,elements:[author,...options],actionPlan:plan});
  assert.equal(choice.label,'其他');assert.equal(choice.decisionSource,'verified-binding');
  const incomplete=buildObservedActionPlan([author,...options,{index:'search',label:'搜索',kind:'action',
    context:'popup',popupOwnerKey:'author',operations:['CLICK']}],source,history,page);
  assert.ok(!incomplete.actions.some(action=>action.ordinalStep),'选项集合含未知项时保留语义判断');
  const arbitrary=buildObservedActionPlan([{...author,label:'论文类别'},...options],source,history,page);
  assert.ok(!arbitrary.actions.some(action=>action.ordinalStep),'序号分类转换限于明确的排序字段');
}
console.log('Observed policy: broad control/source candidates, primitive dates, scoped popups, readback and coverage guards passed');
