import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildActionPlan,buildDataBlockPlan,buildRecordBindingPlan,buildSectionPlan,buildSectionJevState,choose,fieldBindingThreshold,prepareResume} from '../lib/jev-client.js';
import {addedRecordEvidence,dateDependencyCandidates,observeDateDefaults,matchRecordSources,renderedRecordKey} from '../lib/traversal-state.js';
import {CONTENT_SCRIPT_VERSION,SNAPSHOT_PROTOCOL_VERSION} from '../lib/content-version.js';

const field=(title,body)=>`<div class="apply-field-test"><div class="title-test">${title}</div>${body}</div>`;
const datePart=(value,unit)=>`<label role="combobox"><span>${value}</span><input readonly placeholder="${unit}" /></label>`;
const dates=(month,ongoing)=>field('起止时间',datePart('2026','年')+datePart(month,'月')+
  (ongoing ? '<label><input type="checkbox" checked>至今</label>' : datePart('2026','年')+datePart('7','月')));
const row=(name,month,ongoing)=>`<div class="record-test">${dates(month,ongoing)}${field('公司名称',`<input value="${name}" placeholder="公司名称">`)}${field('职位名称','<input value="开发实习生" placeholder="职位名称">')}${field('工作职责','<textarea placeholder="内容"></textarea>')}</div>`;
for(const [host,order] of [['app.mokahr.com',false],['app-tc.mokahr.com',true]]) {
  const award=`<section><h3>表彰与奖励<button>添加</button></h3><div class="award-test">${field('奖项名称','<input placeholder="奖项名称">')}${field('奖项时间',datePart('','年')+datePart('','月'))}${field('简述','<input placeholder="简述">')}</div></section>`;
  const internship=`<section><h3>实习经历<button>添加</button></h3>${row('合成企业甲','7',true)}${row('合成企业乙','6',false)}</section>`;
  const custom=`<section><h3>成长足迹</h3>${field('学习方式','<input placeholder="学习方式">')}</section>`;
  const location=`<section><h3>个人信息</h3>${field('目前所在地','<div role="combobox"><span>深圳</span><input placeholder="请选择"></div><div class="field-error">必填项未填写</div>')}</section>`;
  const dom=new JSDOM((order?award+custom+internship:internship+award+custom)+location,{url:`https://${host}/campus-recruitment/tenant/resume`,runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;let handler;
  w.HTMLElement.prototype.getBoundingClientRect=()=>({width:200,height:30,top:10,left:10,right:210,bottom:40});
  w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage(){}}};
  for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) w.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
  const snap=await new Promise(resolve=>handler({type:'SNAPSHOT_FULL'},{},resolve));
  assert.equal(snap.version,CONTENT_SCRIPT_VERSION);assert.equal(snap.protocolVersion,SNAPSHOT_PROTOCOL_VERSION);
  const intern=snap.elements.filter(el=>el.section==='实习经历');
  const years=intern.filter(el=>/开始年份|结束年份/.test(el.label));
  assert.deepEqual(Array.from(years,el=>[el.recordIndex,el.label,el.value]),[[0,'开始年份','2026'],[1,'开始年份','2026'],[1,'结束年份','2026']]);
  const months=intern.filter(el=>/开始月份|结束月份/.test(el.label));
  assert.deepEqual(Array.from(months,el=>[el.recordIndex,el.label,el.value]),[[0,'开始月份','7'],[1,'开始月份','6'],[1,'结束月份','7']]);
  assert.ok(intern.filter(el=>/公司名称|工作职责/.test(el.label)).every(el=>el.recordStableKey));
  const source=prepareResume({internship:[{company:'合成企业甲',position:'开发实习生',startDate:'2026-07-01',endDate:'至今'},
    {company:'合成企业乙',position:'开发实习生',startDate:'2026-06-01',endDate:'2026-07-01'}]});
  const readback=buildActionPlan(intern,source,[],{title:'实习经历',dataBlock:'internship',recordIndex:1,recordScope:true,ignoreUnmapped:true});
  assert.ok(!readback.summary.unresolved.some(issue=>/月份|年份/.test(issue.label || '') && /页面已有值/.test(issue.reason)),'年月各列以自己的精度回读');
  const emptyDates=intern.map(el=>/年份|月份/.test(el.label) ? {...el,value:''} : el);
  const write=buildActionPlan(emptyDates,source,[],{title:'实习经历',dataBlock:'internship',recordIndex:1,recordScope:true,ignoreUnmapped:true});
  assert.ok(write.actions.some(action=>action.resumeField==='internship[1].startDate.year'));
  const nextMonth=buildActionPlan(emptyDates.map(el=>el.recordIndex===1 && el.dateSlot===0 ? {...el,value:'2026'} : el),source,[],
    {title:'实习经历',dataBlock:'internship',recordIndex:1,recordScope:true,ignoreUnmapped:true});
  assert.ok(nextMonth.actions.some(action=>action.resumeField==='internship[1].startDate.month'));
  assert.equal(snap.elements.find(el=>el.placeholder==='奖项名称')?.section,'表彰与奖励');
  assert.equal(snap.elements.find(el=>el.label==='获奖年份')?.section,'表彰与奖励');
  const awardFields=snap.elements.filter(el=>el.section==='表彰与奖励' && el.kind!=='action');
  assert.ok(awardFields.every(el=>el.recordIndex===0 && el.recordStableKey),'单条记录的名称、日期、简介共享物理身份');
  assert.equal(snap.elements.find(el=>el.placeholder==='学习方式')?.section,'成长足迹');
  const region=snap.elements.find(el=>el.label==='目前所在地');
  assert.equal(region.validationError,'必填项未填写');
  const invalid=buildActionPlan([{...region,value:'深圳',operations:['CLICK']}],{basics:{location:{city:'深圳'}}},[],{title:'个人信息',dataBlock:'basics',ignoreUnmapped:true});
  assert.notEqual(invalid.status,'done','网站错误保留在验收状态');
  assert.ok(invalid.actions.some(action=>action.operation==='CLICK'),'相同选项可以重新提交以恢复未提交状态');
  dom.window.close();
}

const sources=[{name:'新项目',startDate:'2026-09-01'},
  {name:'城市分析—可解释半监督学习',startDate:'2023-12-01',endDate:'2024-09-01'},
  {name:'城市分析—可解释半监督学习',startDate:'2024-12-01',endDate:'2025-09-01'}];
const anchor={index:'name',section:'项目经验',kind:'input',label:'项目名称',recordIndex:0,recordStableKey:'row0',value:'合成研究院',operations:['TYPE_TEXT']};
const peers=[anchor,{...anchor,index:'desc',kind:'textarea',label:'项目描述',value:'项目名称：城市分析-可解释半监督学习。交付可重复训练流程。'},
  {...anchor,index:'start',kind:'date',label:'开始时间',value:'2023-12'}];
assert.deepEqual(matchRecordSources([anchor],peers,sources,'name'),{0:1},'解析后的机构名由描述及日期对齐');
const ambiguous=[anchor,{...anchor,index:'desc',kind:'textarea',label:'项目描述',value:'研发声景预测模型并分析噪声来源'}];
const binding=buildRecordBindingPlan(ambiguous,{projects:sources},'projects');
assert.ok(binding.actions.some(action=>action.operation==='SKIP_RECORD'));
assert.ok(binding.actions.every(action=>action.intent==='CHOOSE'||action.intent==='RETURN'));
assert.equal(buildRecordBindingPlan(ambiguous,{projects:sources},'projects',{[renderedRecordKey(anchor)]:null}),null,'退出按稳定记录身份记账');
const blank={...anchor,index:'blank',recordIndex:1,recordStableKey:'row1',value:''};
const confirmed={[renderedRecordKey(anchor)]:1};
const plan=buildActionPlan([anchor,blank],{projects:sources},[],{title:'项目经验',dataBlock:'projects',recordScope:true,recordIndex:0,recordBindings:confirmed});
assert.ok(plan.actions.some(action=>action.target==='blank' && action.resumeField==='projects[0].name'),'新增空记录使用尚未占用的来源');
const language=prepareResume({languages:[{language:'英语',certificate:'IELTS',score:'6.5'}]});
assert.equal(language.languages[0].qualification,'IELTS/6.5');
const languagePlan=buildActionPlan([{index:'score',section:'语言能力',kind:'input',label:'英文等级/分数（如CET6/500）',value:'',operations:['TYPE_TEXT']}],language,[],{title:'语言能力',dataBlock:'languages',ignoreUnmapped:true});
assert.ok(languagePlan.actions.some(action=>action.resumeField==='languages[0].qualification'));
const employmentControls=[
  {index:'company',stableKey:'company',section:'实习经历',kind:'input',label:'公司名称',value:'合成企业甲',operations:['TYPE_TEXT'],recordIndex:0},
  {index:'year',stableKey:'year',section:'实习经历',kind:'custom-select',label:'开始年份',datePart:'year',value:'2026',operations:['CLICK'],recordIndex:0},
  {index:'location',stableKey:'location',section:'实习经历',kind:'input',label:'工作地点',value:'',operations:['TYPE_TEXT'],recordIndex:0},
  {index:'add',section:'实习经历',kind:'action',label:'添加',operations:['CLICK']}];
const mixedResume=prepareResume({internship:[{company:'合成企业甲',startDate:'2026-07'}],
  projects:[{name:'新项目',startDate:'2026-09'},{name:'旧项目',startDate:'2026-03'}]});
const remaining=buildDataBlockPlan('实习经历',employmentControls,mixedResume,['internship']);
assert.deepEqual(remaining.routingTargets,['location'],'已处理字段仅作为上下文；后续路由只查看未归属的空字段');
const wrongType=buildSectionPlan(employmentControls,mixedResume,{'实习经历|*':{activeBlock:'projects'}});
assert.ok(!wrongType.actions.some(action=>action.operation==='ADD_RECORD'),'新增记录需要当前资料块的身份字段证据');
const yearOwner={index:'year',stableKey:'owner',section:'表彰与奖励',kind:'custom-select',label:'获奖年份',
  value:'',dateSlot:0,datePart:'year',recordIndex:0,operations:['CLICK']};
const yearOptions=Array.from({length:227},(_,i)=>({index:`year-${i}`,section:'表彰与奖励',context:'popup',
  kind:'option-item',label:String(2126-i),operations:['CLICK']}));
const yearResume=prepareResume({awards:[{title:'合成奖项',date:'2024-08',details:'合成获奖详情'}]});
const yearHistory=[{kind:'bind',resumeField:'awards[0].date.year',controlStableKey:'owner'},
  {kind:'click',resumeField:'awards[0].date.year',controlStableKey:'owner',sourceTarget:'year',sourceControl:yearOwner,context:'form'}];
const yearPage={title:'表彰与奖励',dataBlock:'awards',sectionScope:true,recordScope:true,recordIndex:0};
const yearPlan=buildActionPlan([yearOwner,...yearOptions],yearResume,yearHistory,yearPage);
const compact=buildSectionJevState({page:yearPage,elements:[yearOwner,...yearOptions],resume:yearResume,actionPlan:yearPlan});
assert.ok(compact.controls.length<=3,'弹层仅保留有限候选对应的控件，分区值继续保留');
const execute=await choose({apiKey:'synthetic',page:yearPage,elements:[yearOwner,...yearOptions],history:yearHistory,
  resume:yearResume,actionPlan:yearPlan});
assert.equal(execute.label,'2024');assert.equal(execute.decisionSource,'verified-binding','明确的已绑定选项由代码执行');
for(const [block,dateKey] of [['awards','date'],['projects','startDate'],['education','startDate']]) {
  const source=prepareResume({[block]:[{title:'合成奖项',name:'合成项目',institution:'合成学校',[dateKey]:'2024-08'}]});
  const year={...yearOwner,label:block==='awards' ? '获奖年份' : '开始年份',section:'成长经历',dateSlot:0,recordStableKey:'record0',value:'2024'};
  const month={...year,index:'month',stableKey:'month',dateSlot:1,datePart:'month',label:'开始月份',value:''};
  const field=`${block}[0].${dateKey}.year`;
  const bindings=[{kind:'bind',resumeField:field,controlStableKey:'owner'}];
  const candidates=dateDependencyCandidates([year,month],field,bindings);
  assert.equal(candidates.length,1);
  const after=[year,{...month,value:'1'}];
  const evidence=observeDateDefaults(candidates,after);
  const next=buildActionPlan(after,source,[...bindings,...evidence],{
    title:'成长经历',dataBlock:block,recordScope:true,recordIndex:0,ignoreUnmapped:true});
  assert.ok(next.actions.some(action=>action.operation==='BIND_FIELD' && action.resumeField===`${block}[0].${dateKey}.month`),
    `${block} 的网站生成月份沿语义绑定继续填写`);
  assert.equal(dateDependencyCandidates([year,{...month,value:'1'}],field,bindings).length,0,'原有月份始终保留');
  const original={...year,recordIndex:0,recordStableKey:'original',stableKey:'original-year'};
  const generated=[{...year,recordIndex:1,recordStableKey:'added'},
    {...month,recordIndex:1,recordStableKey:'added',value:'1'}];
  const added=addedRecordEvidence([original,...generated],{section:'成长经历',mode:'inline',beforeElements:[original]});
  assert.equal(added.recordKey,renderedRecordKey(generated[0]));
  assert.equal(added.defaults.length,2);
  assert.ok(added.defaults.every(item=>item.controlStableKey!=='original-year'),'原有记录不取得新增事务所有权');
  const prepended=generated.map(el=>({...el,recordIndex:0}));
  const prependEvidence=addedRecordEvidence([...prepended,{...original,recordIndex:1}],{
    section:'成长经历',mode:'inline',beforeElements:[original]});
  assert.equal(prependEvidence.recordKey,renderedRecordKey(prepended[0]),'新增到头部同样按物理身份识别');
  assert.ok(prependEvidence.defaults.every(item=>item.controlStableKey!=='original-year'));
  const pending=buildActionPlan(generated,source,added.defaults,{title:'成长经历',dataBlock:block,
    recordScope:true,recordIndex:0,ignoreUnmapped:true,recordBindings:{[added.recordKey]:0}});
  assert.ok(pending.actions.some(action=>action.operation==='BIND_FIELD' && action.resumeField===`${block}[0].${dateKey}.month`),
    '新增时生成的日期默认值可以继续绑定当前来源记录');
  const localState=buildSectionJevState({page:{title:'成长经历',dataBlock:block,sectionScope:true,
    recordScope:true,recordIndex:0,recordBindings:{[added.recordKey]:0}},elements:generated,resume:source,actionPlan:pending});
  assert.ok(localState.controls.every(control=>control.recordIndex===0 && control.rendered_record_index===1 && control.active_record),
    'Jev 状态明确展示来源记录与网页位置，重排后保持当前记录上下文');
}
const presentPlan=buildActionPlan([{index:'present',stableKey:'present',section:'项目经验',recordIndex:0,
  kind:'custom-checkbox',label:'至今',checked:false,operations:['CLICK']}],
  prepareResume({projects:[{name:'合成项目',startDate:'2026-09',endDate:'至今'}]}),[],
  {title:'项目经验',dataBlock:'projects',recordScope:true,recordIndex:0,ignoreUnmapped:true});
const presentBinding=presentPlan.actions.find(action=>action.operation==='BIND_FIELD');
assert.equal(presentBinding.resumeField,'projects[0].endDate.isPresent');
assert.equal(fieldBindingThreshold(presentBinding),0.65,'明确至今派生布尔字段使用精确绑定阈值');
assert.equal(fieldBindingThreshold({...presentBinding,label:'真实性声明'}),0.75,'阈值不应用于协议与声明');
const reorderedProjects=prepareResume({projects:[
  {name:'新项目',endDate:'至今'},
  {name:'旧项目',endDate:'2026-05'}]});
const projectRows=[
  {index:'old-name',stableKey:'old-name',recordStableKey:'old-row',recordIndex:0,section:'项目经验',
    kind:'input',label:'项目名称',value:'旧项目',operations:['TYPE_TEXT']},
  {index:'old-present',stableKey:'old-present',recordStableKey:'old-row',recordIndex:0,section:'项目经验',
    kind:'custom-checkbox',label:'至今',checked:false,operations:['CLICK']},
  {index:'new-name',stableKey:'new-name',recordStableKey:'new-row',recordIndex:1,section:'项目经验',
    kind:'input',label:'项目名称',value:'新项目',operations:['TYPE_TEXT']},
  {index:'new-present',stableKey:'new-present',recordStableKey:'new-row',recordIndex:1,section:'项目经验',
    kind:'custom-checkbox',label:'至今',checked:true,operations:['CLICK']}];
const presentAudit=buildActionPlan(projectRows,reorderedProjects,[],{
  title:'项目经验',dataBlock:'projects',ignoreUnmapped:true});
assert.equal(presentAudit.status,'done','持续与已结束状态沿记录身份在整页审计中回读');
assert.ok(presentAudit.summary.fieldGroups.filter(group=>group.label==='至今').every(group=>group.status==='completed'));
const localPresentAudit=buildActionPlan(projectRows,reorderedProjects,[],{
  title:'项目经验',dataBlock:'projects',recordScope:true,recordIndex:0,ignoreUnmapped:true});
assert.ok(localPresentAudit.summary.fieldGroups.every(group=>!group.targets.includes('old-present')),
  '局部审计只包含当前来源记录');
const protectedCode={index:'referral',stableKey:'referral',section:'申请信息',kind:'input',label:'推荐码',value:'',operations:['TYPE_TEXT']};
assert.ok(!buildSectionPlan([protectedCode],reorderedProjects).actions.some(action=>action.section==='申请信息'),
  '受保护字段沿观察清单退出，免除重复路由');
const protectedWithEntry=[protectedCode,{index:'nav',section:'申请信息',kind:'section-entry',label:'申请信息',operations:['CLICK']}];
assert.ok(!buildSectionPlan(protectedWithEntry,reorderedProjects).actions.some(action=>action.section==='申请信息'));
assert.ok(!buildDataBlockPlan('申请信息',protectedWithEntry,reorderedProjects).actions.some(action=>action.operation==='SELECT_DATA_BLOCK'));
assert.ok(!buildDataBlockPlan('申请信息',[protectedCode],reorderedProjects).actions.some(action=>action.operation==='SELECT_DATA_BLOCK'));
assert.deepEqual(buildActionPlan([protectedCode],reorderedProjects,[],{title:'申请信息',dataBlock:'projects'}).summary.fieldGroups,[]);
console.log('Local dates, renamed/reordered sections, record evidence, validation and language qualification passed');
