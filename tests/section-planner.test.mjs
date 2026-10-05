import assert from 'node:assert/strict';
import { buildActionPlan, buildSectionPlan, classifyRecordAddition, countRenderedRecords, isRecordSaveControl } from '../lib/jev-client.js';

import {recordLedgerKey} from '../lib/traversal-state.js';

const control = (index, section, label, kind = 'input') => ({
  index, section, label, kind, domOrder:Number(index.replace(/\D/g, '')),
  operations:kind === 'action' ? ['CLICK'] : ['TYPE_TEXT']
});

const resume = {
  basics:{name:'示例姓名',location:{city:'示例市',region:{province:'示例省',city:'示例市',district:'示例区'}}},
  education:[{institution:'示例大学 A'},{institution:'示例大学 B'}],
  internship:[{summary:'实习一'}]
};
const elements = [
  control('1','个人信息','姓名'),
  control('2','教育背景','添加','action'),
  control('3','教育背景','学校名称'),
  control('4','实习经历','实习职责')
];
const plan = buildSectionPlan(elements,resume);
assert.equal(countRenderedRecords('语言能力',[
  {...control('85','语言能力','请选择您满足的英语能力证明标准','custom-select'),operations:['CLICK']}
]),1,'Moka 已显示的英语能力证明行计为一条语言记录');
assert.equal(countRenderedRecords('语言能力',[
  {...control('85a','语言能力','请选择您满足的英语能力证明标准','custom-select'),recordIndex:1,operations:['CLICK']},
  {...control('85b','语言能力','请上传证明文件','file'),recordIndex:1,operations:['UPLOAD_FILE']}
]),1,'Moka 单条英语证明按稳定行锚点计数，忽略误标的容器记录索引');
const completedMokaLanguage = buildActionPlan([
  {...control('85c','语言能力','添加','action'),operations:['CLICK'],domOrder:1},
  {...control('85d','语言能力','请选择您满足的英语能力证明标准','custom-select'),
    value:'IELTS≥6.0',operations:['CLICK'],domOrder:2}
], {languages:[{language:'英语',certificate:'IELTS',score:'7.0'}]}, [],
  {title:'语言能力',url:'https://app.mokahr.com/apply',scopedSection:true,allowAddRecords:false});
assert.ok(!completedMokaLanguage.actions.some(action=>action.target==='85c'),
  '语言证明选好后，标题栏添加按钮不能充当保存按钮');
assert.equal(isRecordSaveControl(
  {index:'85c',label:'添加',kind:'action',operations:['CLICK'],domOrder:1},
  [{index:'85c',label:'添加',kind:'action',operations:['CLICK'],domOrder:1},
   {index:'85d',label:'语言证明',kind:'custom-select',domOrder:2}]),false,
  '分区标题栏添加不阻止内联记录验收');
const mokaOtherPlan=buildSectionPlan([
  {...control('86','其他','AI实操水平自评','custom-select'),operations:['CLICK']},
  {...control('87','其他','添加','action'),operations:['CLICK']}
],{application:{emergencyContactName:'示例联系人'}});
assert.ok(!mokaOtherPlan.actions.some(action=>action.operation==='ADD_RECORD'),
  '已有单例表单行时，其他分区不会重复新增空白行');
assert.equal(countRenderedRecords('教育经历',[
  {...control('90','教育经历','学校'),placeholder:'请填写学校'},
  {...control('91','教育经历','学校'),placeholder:'请填写学校'}]),2,
  '学校短标题也应正确统计已有记录');
assert.equal(countRenderedRecords('实习经历',[
  control('92','实习经历','单位名称'),
  control('93','实习经历','实习内容')]),1,
  '同一条实习的单位和内容只计算为一条记录');
assert.equal(countRenderedRecords('工作经历',[
  control('94','工作经历','公司名称'),
  control('95','工作经历','工作内容')]),1,
  '同一条工作的公司和内容只计算为一条记录');
assert.equal(countRenderedRecords('家庭情况',[
  control('96','家庭情况','姓名'),
  control('97','家庭情况','出生年月')]),1,
  '家庭成员按姓名识别记录数');
assert.equal(countRenderedRecords('项目经历',[
  {...control('97a','项目经历','项目名称'),recordIndex:0},
  {...control('97b','项目经历','添加项目经历','card'),recordIndex:1,operations:['CLICK']}
]),1,
  '飞书“添加”入口标注下一条位置时，不把入口本身当作已渲染项目');
const secondInternship = buildSectionPlan([
  {...control('98','实习经历','单位名称'),value:'示例科技公司 A'},
  {...control('99','实习经历','实习内容'),value:'已有内容'},
  control('100','实习经历','添加实习经历','action')
], {internship:[
  {company:'示例科技公司 A',summary:'已有内容'},
  {company:'示例研究中心 B'}
]});
assert.ok(secondInternship.actions.some(action=>action.operation==='ADD_RECORD' && action.recordIndex===1),
  '首条实习填完后应新增第二条，不能把实习内容误计为另一条记录');
const completedFirstProject = buildSectionPlan([
  {...control('101','项目经历','项目名称'),recordIndex:0,value:'项目甲'},
  {...control('102','项目经历','项目描述'),recordIndex:0,value:'已填写的项目描述'},
  {...control('103','项目经历','添加项目经历','card'),recordIndex:1,operations:['CLICK']}
], {projects:[
  {name:'项目甲',description:'已填写的项目描述'},
  {name:'项目乙',description:'待填写的项目描述'},
  {name:'项目丙',description:'待填写的项目描述'}
]});
assert.ok(completedFirstProject.actions.some(action=>action.operation==='ADD_RECORD' && action.recordIndex===1),
  '飞书完成第一条项目后应立即新增第二条，而不是反复验收第一条');
const selfEvaluationPlan = buildSectionPlan([
  {...control('104','自我评价','添加','card'),operations:['CLICK']}
], {basics:{summary:'面向数据与软件系统的个人总结'}});
assert.ok(selfEvaluationPlan.actions.some(action=>action.operation==='ADD_RECORD' && action.recordIndex===0),
  '单例自我评价有本地内容且网页为空时，应通过添加入口创建编辑区域');
const blockedFirstInternship=buildSectionPlan([
  {...control('110','实习经历','单位名称'),value:'示例科技公司 A'},
  {...control('111','实习经历','开始时间','custom-select'),operations:['CLICK'],value:''},
  control('112','实习经历','添加实习经历','action')
],{internship:[{company:'示例科技公司 A',startDate:'2026-07-01'},
  {company:'示例研究中心 B'}]},
{'实习经历|*':{workBlocked:true}});
assert.ok(!blockedFirstInternship.actions.some(action=>action.operation==='ADD_RECORD'),
  '第一条日期待补时保持当前记录，避免先新增第二条造成空白记录');
const recordSnapshot = (rendered, editable, page={}) => ({page:{url:'https://example.test/resume',...page},elements:[
  ...Array.from({length:rendered},(_,index)=>({section:'实习经历',recordIndex:index,label:'单位名称',kind:'input',operations:['TYPE_TEXT']})),
  ...Array.from({length:Math.max(0,editable-rendered)},(_,index)=>({section:'实习经历',label:`字段${index}`,kind:'input',operations:['TYPE_TEXT']}))
]});
assert.equal(classifyRecordAddition({section:'实习经历',before:recordSnapshot(1,5),after:recordSnapshot(2,10)}).mode,'inline',
  '内联新增必须通过记录数增加确认');
assert.equal(classifyRecordAddition({section:'实习经历',before:recordSnapshot(1,5),
  after:recordSnapshot(1,10,{activeSection:'实习经历',editorSurface:true})}).mode,'editor',
  '弹窗编辑必须通过编辑器表面确认');
assert.equal(classifyRecordAddition({section:'实习经历',before:recordSnapshot(1,5),
  after:recordSnapshot(1,9,{url:'https://example.test/resume/edit'})}).mode,'route',
  '独立编辑页必须通过 URL 与可编辑控件确认');
assert.equal(classifyRecordAddition({section:'实习经历',before:recordSnapshot(1,5),after:recordSnapshot(1,5)}).mode,'failed',
  '点击无新增证据时保留新增失败状态');
const beisenFields = [
  {section:'实习经历',label:'实习内容',path:'internship[0].summary',value:'实习项目'},
  {section:'家庭情况',label:'出生年月',path:'family[0].birthDate',value:'1964-10-05',kind:'custom-select'},
  {section:'获奖情况',label:'获奖原因',path:'awards[0].details',value:'竞赛获奖'},
  {section:'陈述情况',label:'个人陈述',path:'basics.summary',value:'个人简介'}
];
for (const [ordinal,field] of beisenFields.entries()) {
  const element={...control(String(120+ordinal),field.section,field.label,field.kind),
    operations:field.kind==='custom-select'?['CLICK']:['TYPE_TEXT'],value:''};
  const data={basics:{summary:'个人简介'},internship:[{summary:'实习项目'}],
    family:[{birthDate:'1964-10-05'}],awards:[{details:'竞赛获奖'}]};
  const actions=buildActionPlan([element],data,[],{title:field.section,recordIndex:0}).actions;
  assert.ok(actions.some(action=>action.resumeField===field.path),
    `北森「${field.label}」应映射到现有简历资料`);
}
const pendingEditor=buildSectionPlan(elements,resume,{'教育背景|*':{editorPending:true}});
assert.ok(!pendingEditor.actions.some(a=>a.operation==='ADD_RECORD'),'新编辑器等待填写期间保持单条事务');
assert.equal(plan.actions.find(a=>a.section==='教育背景' && a.operation==='WORK_SECTION').ledgerKey,recordLedgerKey('教育背景','education',resume,0));

assert.ok(plan.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'), '先填写当前已打开记录');
assert.ok(!plan.actions.some(a => a.operation === 'ADD_RECORD' && a.section === '教育背景'));
assert.ok(plan.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '实习经历'));
assert.ok(plan.actions.some(a => a.operation === 'EXIT_SECTION_MENU'));
assert.ok(plan.actions.some(a => a.operation === 'STOP_FILL'));
assert.ok(!plan.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '信息确认'));

const preserveExisting = buildActionPlan([
  {...control('30','个人信息','姓名'),value:'用户已填写的姓名'},
  {...control('31','个人信息','邮箱'),value:''}
], {basics:{name:'示例姓名',email:'example@example.com'}}, [], {title:'个人信息'});
assert.ok(!preserveExisting.actions.some(a => a.target === '30'), '插件保留网页中已有的姓名');
assert.ok(preserveExisting.actions.some(a => a.target === '31'), '插件仍补全空白邮箱');
const wrongFamilyIdentity=buildActionPlan([
  {...control('32','家庭情况','姓名'),recordIndex:1,value:'示例父亲'}
],{family:[{name:'示例父亲'},{name:'示例母亲'}]},[],{title:'家庭情况'});
assert.ok(!wrongFamilyIdentity.actions.some(a=>a.target==='32'),'已有姓名不自动覆盖');
assert.ok(wrongFamilyIdentity.summary.unresolved.some(item=>item.target==='32' && /不同/.test(item.reason)),
  '第二位家庭成员误填成父亲时应报告身份冲突');

const completed = buildSectionPlan(elements.map(el=>el.index==='3'?{...el,value:'示例大学 A'}:el),resume,{'教育背景|*':{activeBlock:'education'},[recordLedgerKey('教育背景','education',resume,0)]:{completed:true,status:'已回读'}});
assert.ok(!completed.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'));
assert.ok(completed.actions.some(a => a.operation === 'ADD_RECORD' && a.section === '教育背景'));

const blocked = buildSectionPlan(elements,resume,{'教育背景|*':{activeBlock:'education'},[recordLedgerKey('教育背景','education',resume,0)]:{workBlocked:true,status:'待处理'}});
assert.ok(!blocked.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'));
assert.ok(!blocked.actions.some(a => a.operation === 'ADD_RECORD' && a.section === '教育背景'),
  '内联表单存在待补字段时保持当前记录，避免新增空白重复记录');

const retriedThreeTimes = buildSectionPlan(elements,resume,{'教育背景|*':{activeBlock:'education'},[recordLedgerKey('教育背景','education',resume,0)]:{workAttempts:3,status:'待处理'}});
assert.ok(!retriedThreeTimes.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'));
const importedUnknownAward = buildSectionPlan([
  {...control('114','获奖情况','获奖项'),value:'网站导入的历史奖项'},
  {...control('115','获奖情况','获奖时间','beisen-date'),operations:['PICK_DATE'],value:''},
  control('116','获奖情况','添加获奖情况','action')
],{awards:[{title:'本地奖项 A',date:'2024-08'},{title:'本地奖项 B',date:'2023-11'}]});
assert.ok(!importedUnknownAward.actions.some(action=>action.operation==='ADD_RECORD'),
  '网站已有未匹配的用户记录时保留现场，不用本地条目继续追加');
const globallyBlocked = buildSectionPlan(elements,resume,{'教育背景|*':{workBlocked:true,status:'无可执行动作'}});
assert.ok(!globallyBlocked.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'),
  '同一分区无动作时跨记录计数变化也不能重复执行');

const addBlocked = buildSectionPlan(elements,resume,{'教育背景|*':{activeBlock:'education'},[recordLedgerKey('教育背景','education',resume,0)]:{addBlocked:true,status:'新增失败'}});
assert.ok(!addBlocked.actions.some(a => a.operation === 'ADD_RECORD' && a.section === '教育背景'));
assert.ok(addBlocked.actions.some(a => a.operation === 'WORK_SECTION' && a.section === '教育背景'), '新增被网站阻止时仍填写已有记录');

const openEditor = buildSectionPlan([
  {...control('60','教育经历','教育经历 未完成','section-entry'),operations:['CLICK']},
  {...control('61','教育经历','添加','card'),operations:['CLICK']},
  control('62','教育经历','学校名称'),
  {...control('70','教育经历','添 加','button'),operations:['CLICK']},
  {...control('71','个人信息','个人信息 未完成','section-entry'),operations:['CLICK']}
],resume,{}, {activeSection:'教育经历'});
assert.ok(openEditor.actions.some(a=>a.operation==='WORK_SECTION' && a.section==='教育经历'),
  '新增编辑器打开后应填写当前记录');
assert.equal(openEditor.actions.find(a=>a.operation==='WORK_SECTION' && a.section==='教育经历')?.recordIndex,0,
  '首个尚未保存的新增编辑器对应本地第一条教育记录');
assert.ok(!openEditor.actions.some(a=>a.operation==='ADD_RECORD' && a.section==='教育经历'),
  '新增编辑器打开后不应继续点击新增');
assert.ok(!openEditor.actions.some(a=>a.operation==='FOCUS_SECTION' && a.section==='个人信息'),
  '当前记录未保存时应留在本分区');
const spacedSaveEditor=buildSectionPlan([
  {...control('80','个人信息','个人信息 未完成','section-entry'),operations:['CLICK']},
  control('81','个人信息','邮箱'),
  {...control('82','个人信息','保 存','action'),operations:['CLICK']},
  {...control('83','教育经历','教育经历 未完成','section-entry'),operations:['CLICK']}
],resume,{[recordLedgerKey('个人信息','basics',resume,0)]:{workBlocked:true}}, {activeSection:'个人信息'});
assert.ok(!spacedSaveEditor.actions.some(a=>a.section==='教育经历'),
  '有未保存编辑器时停止跨分区导航');
const nextRecord=buildSectionPlan([
  {...control('65','教育经历','教育经历 未完成','section-entry'),operations:['CLICK']},
  {...control('66','教育经历','添加','card'),operations:['CLICK']}
],resume,{'教育经历|*':{activeBlock:'education'},[recordLedgerKey('教育经历','education',resume,0)]:{completed:true}}, {activeSection:'教育经历'});
assert.ok(nextRecord.actions.some(a=>a.operation==='ADD_RECORD' && a.section==='教育经历' && a.recordIndex===1),
  '首条保存并回读后应打开下一条记录');
const saveEditor=buildActionPlan([
  {...control('63','教育经历','学校名称'),value:'示例大学 A'},
  {...control('64','教育经历','添 加','button'),operations:['CLICK']}
],resume,[],{title:'教育经历',scopedSection:true});
assert.ok(saveEditor.actions.some(a=>a.operation==='CLICK' && a.target==='64'),
  '已有字段回读完成后应提供新增编辑器的保存动作');
const mixedExperience={internship:[{company:'实习单位'}],work:[{company:'工作单位'}]};
const internshipDepartment=buildActionPlan([
  {...control('69','实习经历','部门'),value:''},
  {...control('70','实习经历','部门'),value:''}
],{internship:[
  {company:'示例科技公司 A',department:'研发部门'},
  {company:'示例研究中心 B',department:''}
]});
assert.deepEqual(internshipDepartment.actions.map(a=>a.resumeField),['internship[0].department']);
const existingFirstDepartment=buildActionPlan([
  {...control('69','实习经历','部门'),value:'产品与研发部门'},
  {...control('70','实习经历','部门'),value:''}
],{internship:[
  {company:'示例科技公司 A',department:'研发部门'},
  {company:'示例研究中心 B',department:''}
]});
assert.equal(existingFirstDepartment.actions.length,0,'首条已有值仍占用重复字段序号，第二条保持空白');
assert.equal(buildActionPlan([{...control('71','家庭情况','出生日期'),value:''}],
  {basics:{birthDate:'2001-02-10'}}).actions.length,0,'家庭成员日期不能复用本人生日');
const mixedControl=[control('67','实习/工作经历','工作单位')];
const firstExperience=buildActionPlan(mixedControl,mixedExperience,[],{title:'实习/工作经历',recordIndex:0});
const secondExperience=buildActionPlan(mixedControl,mixedExperience,[],{title:'实习/工作经历',recordIndex:1});
assert.deepEqual(firstExperience.actions.map(a=>a.resumeField),['internship[0].company']);
assert.deepEqual(secondExperience.actions.map(a=>a.resumeField),['work[0].company']);
assert.equal(buildActionPlan([control('68','工作经历','开始时间','date')],
  {internship:[{startDate:'2026-07-01'}]},[],{title:'工作经历'}).actions.length,0,
  '独立工作经历分区不能复用实习资料');
const datePopup=buildActionPlan([
  {...control('68','实习/工作经历','入职时间','date'),operations:['CLICK']},
  {index:'69',section:'实习/工作经历',label:'20',kind:'option-item',role:'option',context:'popup',operations:['CLICK']}
],{internship:[{startDate:'2026-07-01'}]},[
  {kind:'click',resumeField:'internship[0].startDate',label:'入职时间',controlKind:'date'}
],{title:'实习/工作经历',recordIndex:0});
assert.ok(!datePopup.actions.some(a=>a.target==='69'),
  '日期选择器的日号不能以年份子串误匹配完整日期');
const calendarControls = [
  {...control('68','实习/工作经历','入职时间','date'),operations:['CLICK']},
  {index:'70',label:'2026 年',kind:'button',operations:['CLICK']},
  {index:'71',label:'9 月',kind:'button',operations:['CLICK']},
  {index:'72',label:'上个月',kind:'button',operations:['CLICK']},
  {index:'73',label:'1',kind:'option-item',context:'popup',calendarDate:'2026-09-01',operations:['CLICK']}
];
const dateHistory=[{kind:'click',resumeField:'internship[0].startDate',label:'入职时间',controlKind:'date'}];
const septemberCalendar=buildActionPlan(calendarControls,{internship:[{startDate:'2026-07-01'}]},dateHistory,
  {title:'实习/工作经历',recordIndex:0});
assert.deepEqual(septemberCalendar.actions.map(a=>a.target),['72'], '日历先导航到目标月份');
const monthPrecisionCalendar=buildActionPlan(calendarControls,{internship:[{startDate:'2026-07'}]},dateHistory,
  {title:'实习/工作经历',recordIndex:0});
assert.deepEqual(monthPrecisionCalendar.actions.map(a=>a.target),['72'], '仅有年月时使用当月一日作为完整日期');
const julyCalendar=buildActionPlan(calendarControls.map(el => el.index==='71' ? {...el,label:'7 月'} :
  el.index==='73' ? {...el,calendarDate:'2026-07-01'} : el),
  {internship:[{startDate:'2026-07-01'}]},dateHistory,{title:'实习/工作经历',recordIndex:0});
assert.deepEqual(julyCalendar.actions.map(a=>a.target),['73'], '到达目标月份后选完整日期');
const duplicateEndDate=buildActionPlan([
  {...control('80','实习/工作经历','离职时间','date'),operations:['CLICK'],domOrder:80},
  {...control('81','实习/工作经历','离职时间','date'),operations:['CLICK'],domOrder:81}
],{internship:[{endDate:'2026-11-30',isPresent:true}]},[],
{title:'实习/工作经历',recordIndex:0});
assert.deepEqual(duplicateEndDate.actions.map(a=>a.target),['80'], '同名日期按记录顺序绑定；控件代理去重由观察层负责');
const presentCalendar=buildActionPlan([
  {index:'82',label:'至今',kind:'button',context:'popup',operations:['CLICK']},
  {index:'83',label:'2026 年',kind:'button',context:'popup',operations:['CLICK']},
  {index:'84',label:'9 月',kind:'button',context:'popup',operations:['CLICK']},
  {index:'85',label:'1',kind:'option-item',context:'popup',calendarDate:'2026-09-01',operations:['CLICK']}
],{internship:[{endDate:'2026-11-30',isPresent:true}]},
[{kind:'click',resumeField:'internship[0].endDate',label:'离职时间',controlKind:'date'}],
{title:'实习/工作经历',recordIndex:0});
assert.deepEqual(presentCalendar.actions.map(a=>a.target),['82'], '仍在职记录优先使用网站的至今选项');

assert.equal(countRenderedRecords('教育背景', [
  {section:'教育背景',label:'2025',placeholder:'年'},
  {section:'教育背景',label:'1',placeholder:'月'},
  {section:'教育背景',label:'2026',placeholder:'年'},
  {section:'教育背景',label:'11',placeholder:'月'},
  {section:'教育背景',label:'2021',placeholder:'年'},
  {section:'教育背景',label:'9',placeholder:'月'},
  {section:'教育背景',label:'2025',placeholder:'年'},
  {section:'教育背景',label:'6',placeholder:'月'}
]), 2, '已选值导致标签漂移时仍按年月结构识别两条教育记录');
assert.equal(countRenderedRecords('教育背景', [
  {section:'教育背景',label:'请输入就读学校'},
  {section:'教育背景',label:'请输入就读学校'}
]), 2, 'Moka 学校联想框可直接作为记录锚点');
assert.equal(countRenderedRecords('教育背景', [
  {section:'教育背景',label:'2025',recordIndex:0},
  {section:'教育背景',label:'示例大学 A',recordIndex:0},
  {section:'教育背景',label:'2021',recordIndex:1},
  {section:'教育背景',label:'示例大学 B',recordIndex:1}
]), 2, '选值后字段文案漂移时优先使用稳定 recordIndex 计数');

const projectPlan = buildActionPlan([
  control('10','项目经验','项目描述','textarea'), control('11','项目经验','项目职责','textarea'),
  control('12','项目经验','项目描述','textarea'), control('13','项目经验','项目职责','textarea')
], {projects:[{description:'项目甲',responsibilities:'负责人'},{description:'项目乙',responsibilities:'开发'}]}, [], {title:'项目经验'});
assert.deepEqual(projectPlan.actions.filter(a => /项目(?:描述|职责)/.test(a.label)).map(a => a.resumeField), [
  'projects[0].description','projects[0].responsibilities','projects[1].description','projects[1].responsibilities'
]);

const indexedProjectPlan = buildActionPlan([
  {...control('14','项目经验','项目描述','textarea'),recordIndex:1},
  {...control('15','项目经验','项目职责','textarea'),recordIndex:1},
  {...control('16','项目经验','项目描述','textarea'),recordIndex:0},
  {...control('17','项目经验','项目职责','textarea'),recordIndex:0}
], {projects:[{description:'项目甲',responsibilities:'负责人'},{description:'项目乙',responsibilities:'开发'}]}, [], {title:'项目经验'});
assert.deepEqual(indexedProjectPlan.actions.filter(a => /项目(?:描述|职责)/.test(a.label)).map(a => a.resumeField), [
  'projects[1].description','projects[1].responsibilities','projects[0].description','projects[0].responsibilities'
], 'section 内容排序变化时仍按 recordIndex 绑定记录');

const awardPlan = buildActionPlan([
  control('20','获奖经历','获奖年份','custom-select'), control('21','获奖经历','获奖月份','custom-select'),
  control('22','获奖经历','获奖年份','custom-select'), control('23','获奖经历','获奖月份','custom-select')
], {awards:[{date:'2024-08-01'},{date:'2023-11-01'}]}, [], {title:'获奖经历'});
assert.deepEqual(awardPlan.actions.map(a => a.resumeField), [
  'awards[0].date.year','awards[0].date.month','awards[1].date.year','awards[1].date.month'
]);

const savedPersonalPlan=buildSectionPlan([
  {index:'edit',section:'个人信息',label:'编辑',kind:'button',operations:['CLICK']}
],{basics:{name:'测试'}},{[recordLedgerKey('个人信息','basics',{basics:{name:'测试'}},0)]:{completed:true}},{activeSection:'个人信息'});
assert.ok(!savedPersonalPlan.actions.some(a=>a.operation==='FOCUS_SECTION'),
  '单例分区关闭编辑器后保持同一完成状态');
const summaryPlan=buildSectionPlan([
  {index:'entry',section:'教育经历',label:'教育经历',kind:'section-entry',operations:['CLICK']},
  {index:'add',section:'教育经历',label:'添加',kind:'card',operations:['CLICK']},
  {index:'edit',section:'教育经历',label:'编辑',summaryText:'学校名称 示例大学 A 入学时间 2025-09-01',kind:'card',operations:['CLICK']}
],{education:[{institution:'示例大学 A'},{institution:'示例大学 B'}]}, {[recordLedgerKey('教育经历','education',resume,0)]:{completed:true}},
  {activeSection:'教育经历',text:'学校名称 示例大学 A 入学时间 2025-09-01'});
assert.equal(summaryPlan.actions.find(a=>a.operation==='ADD_RECORD')?.recordIndex,1,
  '摘要态已保存的学校用于记录盘点，下一条绑定本科');
console.log('section planner tests passed');
const datedResume={education:[{institution:'同名大学',startDate:'2021-09-01',endDate:'2025-06-30'},
  {institution:'同名大学',startDate:'2025-09-01',endDate:'2026-11-30'}]};
const reorderedSummary=[{index:'entry',section:'教育经历',label:'教育经历',kind:'section-entry',operations:['CLICK']},
  {index:'add',section:'教育经历',label:'添加',kind:'card',operations:['CLICK']},
  {index:'edit',section:'教育经历',label:'编辑',kind:'card',summaryText:'同名大学 2025-09-01 2026-11-30',operations:['CLICK']}];
const reorderedLedger={'教育经历|*':{activeBlock:'education'},
  [recordLedgerKey('教育经历','education',datedResume,1)]:{completed:true}};
assert.equal(buildSectionPlan(reorderedSummary,datedResume,reorderedLedger,{activeSection:'教育经历'})
  .actions.find(action=>action.operation==='ADD_RECORD')?.recordIndex,0,'新增由缺失来源决定，支持已有第二条排在前面');
assert.equal(buildSectionPlan(reorderedSummary,datedResume,{'教育经历|*':{activeBlock:'education'}},{activeSection:'教育经历'})
  .actions.find(action=>action.operation==='FOCUS_SECTION')?.recordIndex,1,'编辑摘要通过日期选择相同学校的正确来源');
const ambiguousSummary=reorderedSummary.map(el=>el.index==='edit'?{...el,summaryText:'同名大学'}:el);
assert.ok(!buildSectionPlan(ambiguousSummary,datedResume,{'教育经历|*':{activeBlock:'education'}},{activeSection:'教育经历'})
  .actions.some(action=>['ADD_RECORD','FOCUS_SECTION'].includes(action.operation)),'同名摘要无法消歧时保留现场');
const skillResume={professionalSkills:[{name:'Python'},{name:'TypeScript'},{name:'C++'}]};
const skillSummary=[{index:'nav',section:'专业技能',label:'专业技能',kind:'section-entry',operations:['CLICK']},
 {index:'edit',section:'专业技能',label:'编辑',summaryText:'专业技能 Python',kind:'card',operations:['CLICK']},
 {index:'add',section:'专业技能',label:'添加',kind:'card',operations:['CLICK']}];
const afterSkipped=buildSectionPlan(skillSummary,skillResume,{[recordLedgerKey('专业技能','professionalSkills',skillResume,0)]:{completed:true},[recordLedgerKey('专业技能','professionalSkills',skillResume,1)]:{skipped:true}},
 {activeSection:'专业技能',text:'专业技能 Python 编辑'});
assert.ok(afterSkipped.actions.some(a=>a.operation==='ADD_RECORD' && a.recordIndex===2),'一条资料缺少网站选项时继续下一条');
const exhaustedSkills=buildSectionPlan(skillSummary,skillResume,{[recordLedgerKey('专业技能','professionalSkills',skillResume,0)]:{completed:true},[recordLedgerKey('专业技能','professionalSkills',skillResume,1)]:{skipped:true},[recordLedgerKey('专业技能','professionalSkills',skillResume,2)]:{completed:true}},
 {activeSection:'奖励荣誉',text:'奖励荣誉'});
assert.ok(!exhaustedSkills.actions.some(a=>a.section==='专业技能'),'本轮已处理全部资料的分区不再进入候选');
const languageComplete=buildActionPlan([
 {index:'lang',kind:'custom-select',label:'语种',value:'英语',operations:['CLICK']},
 {index:'cert',kind:'input',label:'获得证书',value:'雅思(IELTS)',operations:['TYPE_TEXT','CLICK']},
 {index:'score',kind:'input',label:'等级/分数',value:'7.0',operations:['TYPE_TEXT']},
 {index:'extra',kind:'card',label:'添加',operations:['CLICK']},
 {index:'save',kind:'action',label:'保 存',operations:['CLICK']}
],{languages:[{language:'英语',certificate:'IELTS',score:'7.0'}]},[],{title:'语言能力',scopedSection:true,allowAddRecords:false});
assert.ok(languageComplete.actions.some(a=>a.target==='save'));
assert.ok(!languageComplete.actions.some(a=>a.target==='extra'));
const completedOther = buildActionPlan([
 {index:'name',kind:'input',label:'紧急联系人姓名',value:'测试联系人',operations:['TYPE_TEXT'],required:true},
 {index:'relative',kind:'custom-select',label:'是否有亲属受雇本公司',value:'否',operations:['CLICK'],required:true},
 {index:'save',kind:'action',label:'保 存',operations:['CLICK'],formRuleSignals:['relative-employment','job-adjustment']},
 {index:'cancel',kind:'action',label:'取 消',operations:['CLICK'],formRuleSignals:['relative-employment']}
],{application:{emergencyContactName:'测试联系人'}},[],{title:'其他信息',scopedSection:true,ignoreUnmapped:true});
assert.ok(completedOther.actions.some(a=>a.target==='save'),'保存按钮周围的问句不能将按钮绑定为未完成字段');
const customSkillControls=[{index:'nav',section:'专业技能',kind:'section-entry',label:'专业技能',operations:['CLICK']},
 ...[0,1,2,3].map(i=>({index:'edit'+i,section:'专业技能',kind:'card',label:'编辑',summaryText:['技能类型 Python','技能类型 C/C++','技能类型 其他技能 其他技能 --','技能类型 其他技能 其他技能 --'][i],operations:['CLICK']}))];
const customSkillPlan=buildSectionPlan(customSkillControls,{professionalSkills:[{name:'Python'},{name:'TypeScript'},{name:'C++'},{name:'LangGraph'}]},
 {[recordLedgerKey('专业技能','professionalSkills',skillResume,0)]:{completed:true},[recordLedgerKey('专业技能','professionalSkills',skillResume,2)]:{completed:true}},
 {activeSection:'专业技能',text:'技能类型 Python 编辑 技能类型 C/C++ 编辑 技能类型 其他技能 其他技能 -- 编辑 技能类型 其他技能 其他技能 -- 编辑'});
assert.ok(customSkillPlan.actions.some(a=>a.target==='edit2' && a.recordIndex===1),'空自定义记录绑定到尚未出现的资料，保留已有技能身份');
const customSkillField=buildActionPlan([
 {index:'type',kind:'input',label:'技能类型',value:'其他技能',operations:['TYPE_TEXT']},
 {index:'name',kind:'input',label:'其他技能',value:'',operations:['TYPE_TEXT']}
],{professionalSkills:[{name:'Python'},{name:'TypeScript'}]},[],{title:'专业技能',recordIndex:1,scopedSection:true});
assert.equal(customSkillField.actions[0].resumeField,'professionalSkills[1].name');
assert.equal(customSkillField.actions[0].target,'name');
const switchedSkill=buildActionPlan([
 {index:'type',kind:'input',label:'技能类型',value:'其他技能',operations:['TYPE_TEXT']},
 {index:'name',kind:'input',label:'其他技能',value:'',operations:['TYPE_TEXT']}
],{professionalSkills:[{name:'Hermes'}]},[{kind:'click',context:'popup',resumeField:'professionalSkills[0].name',label:'其他技能'}],
 {title:'专业技能',scopedSection:true});
assert.equal(switchedSkill.actions[0].target,'name','选择其他技能后将事务交还正文新字段，继续填写自定义名称');
const optionalSkill=buildActionPlan([
 {index:'name',kind:'input',label:'技能名称',value:'LangGraph',operations:['TYPE_TEXT']},
 {index:'level',kind:'custom-select',label:'技能掌握程度',value:'',operations:['CLICK']},
 {index:'save',kind:'action',label:'保 存',operations:['CLICK']}
],{professionalSkills:[{name:'LangGraph',level:'了解'}]},[{kind:'cancel',cancelField:'professionalSkills[0].level'}],
 {title:'专业技能',scopedSection:true,ignoreUnmapped:true});
assert.ok(optionalSkill.actions.some(a=>a.target==='save'),'未匹配的可选熟练度保留待补，已填写技能名称可以保存');
const monthPopup=[{index:'year',label:'2026 年',kind:'button',context:'popup',operations:['CLICK']},
  {index:'prev',label:'前一年',kind:'button',context:'popup',operations:['CLICK']},
  ...['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'].map((label,i)=>
    ({index:'month'+i,label,kind:'option-item',context:'popup',operations:['CLICK']}))];
const monthHistory=[{kind:'click',resumeField:'awards[0].date',controlKind:'date'}];
assert.equal(buildActionPlan(monthPopup,{awards:[{date:'2024-08'}]},monthHistory,{title:'奖励荣誉'}).actions[0].target,'year');
assert.equal(buildActionPlan(monthPopup.map(e=>e.index==='year'?{...e,label:'2024 年'}:e),
  {awards:[{date:'2024-08'}]},monthHistory,{title:'奖励荣誉'}).actions[0].target,'month7');
const numericMonthPopup=[{index:'year',label:'2026年',kind:'button',context:'popup',operations:['CLICK']},
  ...Array.from({length:12},(_,i)=>({index:`numeric-month-${i+1}`,label:`${i+1}月`,kind:'option-item',context:'popup',operations:['CLICK']}))];
assert.equal(buildActionPlan(numericMonthPopup,{internship:[{startDate:'2026-07-01'}]},
  [{kind:'click',resumeField:'internship[0].startDate',controlKind:'custom-select'}],
  {title:'实习经历'}).actions[0].target,'numeric-month-7',
  '北森日期弹层显示阿拉伯数字月份时应选择目标月');
assert.equal(buildActionPlan(numericMonthPopup.map(el=>el.index==='year'?{...el,label:'2026'}:el),
  {internship:[{startDate:'2026-07-01'}]},
  [{kind:'click',resumeField:'internship[0].startDate',controlKind:'custom-select'}],
  {title:'实习经历'}).actions[0].target,'numeric-month-7',
  '北森月份弹层将年份简写为数字时仍选择目标月');
assert.equal(buildActionPlan(numericMonthPopup.map(el=>el.index==='year'?{...el,label:'2026',kind:'option-item'}:el),
  {family:[{birthDate:'1964-10-05'}]},
  [{kind:'click',resumeField:'family[0].birthDate',controlKind:'custom-select'}],
  {title:'家庭情况'}).actions[0].target,'year',
  '北森日期控件目标跨年份时应打开年份选择层');
const awardLevelPopup=[{index:'national-level',label:'国家级',kind:'option-item',context:'popup',operations:['CLICK']}];
assert.equal(buildActionPlan(awardLevelPopup,{awards:[{level:'全国'}]},
  [{kind:'click',resumeField:'awards[0].level',controlKind:'custom-select'}],
  {title:'获奖情况'}).actions[0].target,'national-level',
  '全国奖项应匹配网站的国家级选项');
const studyModeOptions=[
  {index:'domestic',label:'全国普通高等院校全日制',kind:'option-item',context:'popup',operations:['CLICK']},
  {index:'overseas',label:'海外留学生',kind:'option-item',context:'popup',operations:['CLICK']}
];
const hongKongStudyMode=buildActionPlan(studyModeOptions,
  {education:[{country:'中国香港',studyMode:'全日制'}]},
  [{kind:'click',resumeField:'education[0].studyMode',controlKind:'custom-select'}],{title:'教育经历'});
assert.equal(hongKongStudyMode.actions[0].target,'overseas',
  '香港高校在北森学习形式枚举中应选择境外教育，不应误选内地普通高校');
const familyDateHistory=[{kind:'click',resumeField:'family[0].birthDate',controlKind:'custom-select'}];
const familyDateResume={family:[{birthDate:'1964-10-05'}]};
const beisenMonthGrid=[
  {index:'year-label',label:'2026年',kind:'button',context:'popup',operations:['CLICK']},
  {index:'year-open',label:'2026',kind:'button',context:'popup',operations:['CLICK']},
  ...Array.from({length:12},(_,i)=>({index:`month-${i+1}`,label:`${i+1}月`,kind:'option-item',context:'popup',operations:['CLICK']}))
];
assert.equal(buildActionPlan(beisenMonthGrid,familyDateResume,familyDateHistory,
  {title:'家庭情况'}).actions[0].target,'year-open','先从月份网格打开年份网格');
const beisenYearGrid=[
  {index:'decade-open',label:'2020 - 2029',kind:'button',context:'popup',operations:['CLICK']},
  ...Array.from({length:12},(_,i)=>({index:`year-${2019+i}`,label:String(2019+i),kind:'option-item',context:'popup',operations:['CLICK']}))
];
assert.equal(buildActionPlan(beisenYearGrid,familyDateResume,familyDateHistory,
  {title:'家庭情况'}).actions[0].target,'decade-open','目标年份不在当前十年时打开世纪网格');
assert.equal(buildActionPlan(beisenYearGrid.map(el=>el.index==='decade-open'?{...el,kind:'option-item'}:el),
  familyDateResume,familyDateHistory,{title:'家庭情况'}).actions[0].target,'decade-open',
  '北森十年标题被快照识别为弹层选项时仍可展开');
const beisenCenturyGrid=[
  {index:'century',label:'2000 - 2099',kind:'button',context:'popup',operations:['CLICK']},
  {index:'previous',label:'上一页',kind:'button',context:'popup',operations:['CLICK']},
  ...Array.from({length:12},(_,i)=>({index:`decade-${1990+i*10}`,label:`${1990+i*10}-${1999+i*10}`,
    kind:'option-item',context:'popup',operations:['CLICK']}))
];
assert.equal(buildActionPlan(beisenCenturyGrid,familyDateResume,familyDateHistory,
  {title:'家庭情况'}).actions[0].target,'previous','目标年份更早时切换至上一世纪');
const previousCenturyGrid=[
  {index:'century',label:'1900 - 1999',kind:'button',context:'popup',operations:['CLICK']},
  ...Array.from({length:12},(_,i)=>({index:`decade-${1890+i*10}`,label:`${1890+i*10}-${1899+i*10}`,
    kind:'option-item',context:'popup',operations:['CLICK']}))
];
assert.equal(buildActionPlan(previousCenturyGrid,
  familyDateResume,familyDateHistory,{title:'家庭情况'}).actions[0].label,'1960-1969',
  '上一世纪网格应定位到 1960 年代');
const missingCityEditor = [
  {...control('101','求职意向','求职意向','section-entry'),operations:['CLICK']},
  {...control('102','求职意向','意向调剂城市','custom-select'),operations:['CLICK'],required:true},
  control('103','求职意向','保 存','action'),
  control('104','求职意向','取 消','action'),
  {...control('105','语言能力','语言能力','section-entry'),operations:['CLICK']}
];
const skipCity = buildSectionPlan(missingCityEditor,resume,{}, {activeSection:'求职意向'});
assert.ok(skipCity.actions.some(a=>a.operation==='WORK_SECTION'), '进入当前 section 后由 Jev 判断可用资料块');
const unmatchedCity=buildSectionPlan(missingCityEditor,resume,{'求职意向|*':{deferred:true}}, {activeSection:'求职意向'});
assert.equal(unmatchedCity.actions.find(a=>a.operation==='DEFER_SECTION')?.target,'104');
assert.ok(!unmatchedCity.actions.some(a=>a.operation==='EXIT_SECTION_MENU'),'真实退出入口替代无效果的虚拟退出');
assert.ok(!skipCity.actions.some(a=>a.section==='语言能力'),'先确认退出当前编辑器再跨分区');
const afterSkip = buildSectionPlan(missingCityEditor.filter(el=>['101','105'].includes(el.index)),resume,
  {'求职意向|*':{deferred:true}}, {activeSection:'求职意向'});
assert.ok(afterSkip.actions.some(a=>a.section==='语言能力'));
assert.ok(!afterSkip.actions.some(a=>a.section==='求职意向'),'本轮跳过的分区保持待补状态，避免重入');
const stillFillable = buildSectionPlan([...missingCityEditor,control('106','求职意向','姓名')].map(el=>
  el.section==='求职意向'?{...el,section:'个人信息'}:el),resume,{}, {activeSection:'个人信息'});
assert.ok(stillFillable.actions.some(a=>a.operation==='WORK_SECTION'));
assert.ok(!stillFillable.actions.some(a=>a.operation==='DEFER_SECTION'),'有资料的空白项优先填写');
const readyToSave = buildSectionPlan([
  {...control('110','个人信息','个人信息','section-entry'),operations:['CLICK']},
  {...control('111','个人信息','姓名'),value:'示例姓名'},
  control('112','个人信息','保 存','action'),control('113','个人信息','取 消','action')
],resume,{}, {activeSection:'个人信息'});
assert.ok(readyToSave.actions.some(a=>a.operation==='WORK_SECTION'),'满足保存条件时优先提交当前分区编辑');
assert.ok(!readyToSave.actions.some(a=>a.operation==='DEFER_SECTION'));
