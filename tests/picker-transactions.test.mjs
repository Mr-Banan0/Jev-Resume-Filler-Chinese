import assert from 'node:assert/strict';
import { buildActionPlan, choose, prepareResume, getResumeValue, popupMatchesValue } from '../lib/jev-client.js';
assert.equal(popupMatchesValue({label:'企业招聘官网、公众号'}, '校园招聘官网'), true,
  '招聘官网来源可匹配网站的企业招聘官网选项');
const resume = { basics: { birthDate: '2001-02-10', nativePlace: '浙江省杭州市西湖区',
  nativePlaceDetail: { province: '浙江省', city: '杭州市', district: '西湖区' },
  idType: '身份证', idNumber: 'TEST-PRIVATE-ID' } };
const column = (index, value, options) => ({ index, kind: 'picker-column', context: 'popup',
  value, operations: ['SELECT'], options: options.map((label,i)=>({index:`${index}:${i+1}`,label})) });
const confirm = {index:'f0_9',kind:'option-item',context:'popup',operations:['CLICK'],label:'确定'};
const columns = [column('f0_1','2012年',['2001年','2012年']), column('f0_2','9月',['2月','9月']), column('f0_3','23日',['10日','23日']), confirm];
const history = [{ kind:'click',resumeField:'basics.birthDate' }];
let p = buildActionPlan(columns,resume,history);
assert.equal(p.actions[0].target,'f0_1:1');
columns[0].value='2001年';
history.push({kind:'select',context:'popup',resumeField:'basics.birthDate'});
p=buildActionPlan(columns,resume,history);
assert.equal(p.actions[0].target,'f0_2:1');
columns[1].value='2月';
p=buildActionPlan(columns,resume,history);
assert.equal(p.actions[0].target,'f0_3:1');
columns[2].value='10日';
assert.equal(buildActionPlan(columns,resume,history).actions[0].target,'f0_9');
const option=(index,label,role='option',checked=false)=>({index,label,role,checked,kind:'option-item',context:'popup',operations:['CLICK']});
assert.equal(popupMatchesValue(option('sep','九月'),'9'),true,
  'Moka 中文月选项应匹配简历中的数字月份');
assert.equal(popupMatchesValue(option('nov','十一月'),'11'),true,
  '双位数月份同样应精确匹配');
assert.equal(popupMatchesValue(option('ordinary','第九项'),'9'),false,
  '月份转换只适用于明确的月选项');
const beisenEthnicity={basics:{ethnicity:'汉族'}};
assert.equal(buildActionPlan([option('han','汉族','radio'),confirm],beisenEthnicity,
  [{kind:'click',resumeField:'basics.ethnicity'}]).actions[0].target,'han');
assert.equal(buildActionPlan([option('han','汉族','radio'),confirm],beisenEthnicity,
  [{kind:'click',context:'popup',resumeField:'basics.ethnicity',label:'汉族'}]).actions[0].target,'f0_9');
assert.equal(buildActionPlan([option('p','浙江省'),confirm],resume,[{kind:'click',resumeField:'basics.nativePlace'}]).actions[0].target,'p');
assert.equal(buildActionPlan([option('c','杭州市','radio'),confirm],resume,[{kind:'click',context:'popup',resumeField:'basics.nativePlace',pickerStep:0}]).actions[0].target,'c');
assert.equal(buildActionPlan([option('c','杭州市','radio',true),confirm],resume,[{kind:'click',context:'popup',resumeField:'basics.nativePlace',pickerStep:1,pickerLeaf:true}]).actions[0].target,'f0_9');
assert.equal(buildActionPlan([option('d','西湖区','radio'),confirm],resume,[{kind:'click',context:'popup',resumeField:'basics.nativePlace',pickerStep:1}]).actions[0].target,'d');
assert.equal(buildActionPlan([option('d','西湖区','radio',true),confirm],resume,[{kind:'click',context:'popup',resumeField:'basics.nativePlace',pickerStep:2,pickerLeaf:true}]).actions[0].target,'f0_9');
const input = {index:'f0_1',kind:'input',operations:['TYPE_TEXT'],label:'证件号码',value:''};
p=buildActionPlan([input],resume);
assert.deepEqual(p.actions.map(a=>a.resumeField),['basics.idNumber']);
const oldFetch=globalThis.fetch;
let request;
globalThis.fetch=async(_url,args)=>{request=JSON.parse(args.body);return {ok:true,json:async()=>({answers:{action:{choice:'a1',confidence:1}}})}};
try {
  await choose({apiKey:'test',goal:'fill',page:{url:'https://example.test/?private=SECRET',text:'SECRET'},elements:[{...input,value:'SECRET'}],history:[{kind:'type_text',text:'SECRET'}],resume,actionPlan:p});
  assert.ok(!JSON.stringify(request).includes('SECRET'));
  assert.ok(!JSON.stringify(request).includes('TEST-PRIVATE-ID'));
} finally { globalThis.fetch=oldFetch; }
console.log('✓ 日期逐列验证、两级地址叶节点、精确字段绑定和请求隐私边界通过');

const shortRegion = buildActionPlan([option('p','浙江'),confirm],resume,[{kind:'click',resumeField:'basics.nativePlace'}]);
assert.equal(shortRegion.actions[0].target,'p');
const partialRegionControl={index:'native-place',kind:'custom-select',label:'籍贯',value:'浙江',operations:['CLICK']};
assert.ok(buildActionPlan([partialRegionControl],resume,[],{url:'https://app.mokahr.com/apply'}).actions
  .some(action=>action.target==='native-place' && action.resumeField==='basics.nativePlace'),
  '级联地址只选到省份时，应继续打开市县选择');
const partialRegionWithPopup=buildActionPlan([partialRegionControl,option('city','杭州')],resume,
  [{kind:'click',context:'popup',label:'浙江',resumeField:'basics.nativePlace',controlKind:'option-item'}],
  {url:'https://app.mokahr.com/apply'});
assert.equal(partialRegionWithPopup.actions[0]?.target,'city',
  'Moka 级联地址应持续绑定到县级完成后再退出选择器事务');
assert.deepEqual(buildActionPlan([
  partialRegionControl,
  {index:'email',kind:'input',label:'邮箱',value:'',operations:['TYPE_TEXT']}
],{...resume,basics:{...resume.basics,email:'test@example.com'}},[],
{url:'https://app.mokahr.com/apply'}).actions.map(action=>action.target),['native-place'],
  'Moka 级联地址事务与普通字段分开决策');
const interviewResume=prepareResume({
  basics:{location:{city:'南京',region:{province:'浙江省',city:'南京市',district:'建邺区'}}},
  application:{interviewSite:'南京'}
});
assert.equal(buildActionPlan([option('gd','浙江')],interviewResume,
  [{kind:'click',resumeField:'application.interviewSite'}]).actions[0].target,'gd');
assert.equal(buildActionPlan([option('sz','南京','radio')],interviewResume,
  [{kind:'click',context:'popup',resumeField:'application.interviewSite',pickerStep:0}]).actions[0].target,'sz');
const notDone = buildActionPlan([{index:'x',kind:'input',label:'应聘渠道来源',value:'',operations:['TYPE_TEXT']},
  {index:'y',kind:'input',label:'证件号码',value:resume.basics.idNumber,operations:['TYPE_TEXT']}],resume);
assert.equal(notDone.status,'blocked');
assert.equal(notDone.summary.unresolved[0].label,'应聘渠道来源');
const scopedDone = buildActionPlan([
  {index:'known',kind:'input',label:'证件号码',value:resume.basics.idNumber,operations:['TYPE_TEXT']},
  {index:'optional',kind:'input',label:'可选补充说明',value:'',operations:['TYPE_TEXT']}
],resume,[],{ignoreUnmapped:true});
assert.equal(scopedDone.status,'done');
const eduResume={education:[{institution:'学校甲',country:'中国香港'},{institution:'学校乙'}]};
const searchPlan=buildActionPlan([{index:'open',kind:'custom-select',operations:['CLICK'],label:'毕业院校'},
  {index:'search',kind:'input',operations:['TYPE_TEXT'],label:'请输入毕业院校',value:''}],eduResume,[{kind:'click',resumeField:'education[0].institution'}]);
assert.equal(searchPlan.actions[0].target,'search');
assert.equal(searchPlan.actions[0].resumeField,'education[0].institution');
const addMajorPlan=buildActionPlan([option('empty','暂无选项'),option('add','添加专业全称')],
  {education:[{area:'示例交叉学科专业（城市数据方向）'}]},
  [{kind:'type_text',controlKind:'combobox',resumeField:'education[0].area'}]);
assert.equal(addMajorPlan.actions[0].target,'add');
const customMajorInput={index:'custom-major',kind:'input',context:'popup',operations:['TYPE_TEXT'],label:'请输入就读专业全称',value:''};
const customMajorResume={education:[{area:'示例交叉学科专业（城市数据方向）'}]};
const customMajorPlan=buildActionPlan([customMajorInput,option('commit-major','添加')],customMajorResume,
  [{kind:'click',context:'popup',resumeField:'education[0].area'}],{url:'https://app-tc.mokahr.com/apply'});
assert.equal(customMajorPlan.actions[0].target,'custom-major');
assert.equal(customMajorPlan.actions[0].resolvedValue,'示例交叉学科专业（城市数据方向）');
const labelLostCustomMajorPlan=buildActionPlan([
  {...customMajorInput,label:'专业',placeholder:'请输入就读专业全称',context:undefined}, option('commit-major','添加')
],customMajorResume,[{kind:'click',context:'popup',label:'添加专业全称',resumeField:'education[0].area'}],
{url:'https://app-tc.mokahr.com/apply'});
assert.equal(labelLostCustomMajorPlan.actions[0].target,'custom-major');
assert.equal(labelLostCustomMajorPlan.actions[0].resumeField,'education[0].area');
const separatedSchoolAndMajor=buildActionPlan([
  {index:'school',kind:'combobox',operations:['TYPE_TEXT','CLICK'],label:'学校名称',placeholder:'请填写学校全称',value:'示例大学'},
  {index:'major',kind:'combobox',operations:['TYPE_TEXT','CLICK'],label:'专业',placeholder:'请填写专业名称',value:'示例交叉学科专业（城市数据方向）'}
],{education:[{institution:'示例大学',area:'示例交叉学科专业（城市数据方向）'}]},
[{kind:'type_text',resumeField:'education[0].area',controlKind:'combobox'}],{title:'教育经历'});
assert.ok(!separatedSchoolAndMajor.actions.some(action=>action.target==='school' && action.resumeField==='education[0].area'),
  '专业联想事务应限定在专业控件内');
const rankOther=buildActionPlan([
  option('top30','前30%'),option('other','其他')
],{education:[{ranking:'TOP50%'}]},[{kind:'click',resumeField:'education[0].ranking'}],
{title:'教育经历',recordIndex:0});
assert.equal(rankOther.actions[0]?.target,'other',
  '排名枚举最高仅前30%时，TOP50%应归入其他');
const cachedSearchDoesNotCommit=buildActionPlan([
  {index:'main-major',kind:'combobox',operations:['TYPE_TEXT','CLICK'],label:'专业名称',value:'示例交叉学科专业（城市数据方向）'},
  {...customMajorInput,label:'专业',placeholder:'请输入就读专业全称'}, option('commit-major','添加')
],customMajorResume,[{kind:'click',context:'popup',label:'添加专业全称',resumeField:'education[0].area'}],
{url:'https://app-tc.mokahr.com/apply'});
assert.equal(cachedSearchDoesNotCommit.actions[0].target,'custom-major');
assert.equal(cachedSearchDoesNotCommit.actions[0].resumeField,'education[0].area');
const commitMajorPlan=buildActionPlan([{...customMajorInput,value:'示例交叉学科专业（城市数据方向）'},option('commit-major','添加')],customMajorResume,
  [{kind:'type_text',context:'popup',resumeField:'education[0].area'}],{url:'https://app-tc.mokahr.com/apply'});
assert.equal(commitMajorPlan.actions[0].target,'commit-major');
const committedSchoolPlan=buildActionPlan([
  {index:'school',kind:'combobox',fieldProtocol:'search-select',operations:['TYPE_TEXT','CLICK'],label:'学校名称',value:'学校甲',valueCommitted:true},
  option('unrelated','校招面试站点')
],eduResume,[{kind:'click',context:'popup',controlKind:'option-item',resumeField:'education[0].institution'}]);
assert.ok(!committedSchoolPlan.actions.some(action=>action.resumeField==='education[0].institution'));
const rawSchoolSearchPlan=buildActionPlan([
  {index:'school',kind:'combobox',fieldProtocol:'search-select',operations:['TYPE_TEXT','CLICK'],label:'学校名称',value:'学校甲',valueCommitted:false},
  option('unrelated','校招面试站点')
],eduResume,[{kind:'click',context:'popup',controlKind:'option-item',resumeField:'education[0].institution'}],
{url:'https://app-tc.mokahr.com/campus-recruitment/example'});
assert.ok(rawSchoolSearchPlan.actions.some(action=>action.resumeField==='education[0].institution'));
const stableDateControl={index:'date-main',stableKey:'教育背景|custom-select|textbox|入学年份|1',kind:'custom-select',
  operations:['CLICK'],label:'入学年份',value:'2025'};
const committedStableDate=buildActionPlan([stableDateControl,option('unrelated','校招面试站点')],
  {education:[{startDate:'2025-09-01'}]},[{kind:'click',context:'popup',resumeField:'education[0].startDate.year',
    controlStableKey:stableDateControl.stableKey}],{url:'https://app-tc.mokahr.com/campus-recruitment/example'});
assert.ok(!committedStableDate.actions.some(action=>action.resumeField==='education[0].startDate.year'));
const mokaDateResume={education:[
  {startDate:'2025-09-01',endDate:'2026-11-30'},
  {startDate:'2021-09-01',endDate:'2025-06-30'}
]};
const mokaLanguagePlan=buildActionPlan([
  {index:'english-proof',kind:'custom-select',label:'请选择您满足的英语能力证明标准',
    section:'语言能力',value:'',operations:['CLICK']}
],{languages:[{language:'英语',certificate:'IELTS',score:'7.0'}]},[],
{url:'https://app.mokahr.com/campus-recruitment/example',platform:'moka-form',title:'语言能力'});
assert.ok(mokaLanguagePlan.actions.some(action=>action.resumeField==='languages[0].certificate'),
  'Moka 英语能力证明标准绑定本地 IELTS 证书');
const mokaDateControls=[
  ['入学年份','2025'],['入学月份','1'],['毕业年份','2026'],['毕业月份','1'],
  ['入学年份','2021'],['入学月份','1'],['毕业年份','2025'],['毕业月份','1']
].map(([label,value], index)=>({index:`moka-date-${index}`,kind:'custom-select',label,value,
  operations:['CLICK'],section:'个人信息',recordIndex:Math.floor(index / 4),dateSlot:index % 4}));
const mokaMonthPlan=buildActionPlan(mokaDateControls,mokaDateResume,[
  {kind:'click',context:'popup',resumeField:'education[0].startDate.year',label:'2025'}
],
  {url:'https://app.mokahr.com/campus-recruitment/example',platform:'moka-form'});
assert.deepEqual(mokaMonthPlan.actions.map(action=>action.resumeField),['education[0].startDate.month'],
  'Moka 的年份已经回读后，计划器只开放同一段教育的入学月份');
const highestDegreeFirst=buildActionPlan([
  {index:'degree',kind:'custom-select',label:'最高学历',value:'',operations:['CLICK']},
  ...mokaDateControls
],{...mokaDateResume,basics:{highestDegree:'硕士'}},[],
{url:'https://app.mokahr.com/campus-recruitment/example',platform:'moka-form'});
assert.deepEqual(highestDegreeFirst.actions.map(action=>action.resumeField),['basics.highestDegree'],
  'Moka 的最高学历尚未回读时，先完成上游选择再填写日期');
const mokaTemporarilyClosedPlan=buildActionPlan([
  {index:'school',kind:'combobox',operations:['TYPE_TEXT','CLICK'],label:'学校名称',value:''},
  {index:'email',kind:'input',operations:['TYPE_TEXT'],label:'邮箱',value:''},
  option('unrelated','校招面试站点')
],{...eduResume,basics:{email:'synthetic@example.test'}},
[{kind:'click',context:'popup',controlKind:'option-item',resumeField:'education[0].institution'}],
{url:'https://app-tc.mokahr.com/campus-recruitment/example'});
assert.ok(mokaTemporarilyClosedPlan.actions.some(action=>action.resumeField==='education[0].institution'));
assert.ok(!mokaTemporarilyClosedPlan.actions.some(action=>action.resumeField==='basics.email'));
const mokaRecruitmentSource=buildActionPlan([
  option('official','官方公众号'), option('school','高校就业网'), option('other-source','其他')
],{application:{recruitmentSource:'校园招聘官网'}},[{kind:'click',resumeField:'application.recruitmentSource'}],
{url:'https://app-tc.mokahr.com/campus-recruitment/example'});
assert.ok(mokaRecruitmentSource.actions.some(a=>a.target==='other-source'));
assert.ok(mokaRecruitmentSource.actions.some(a=>a.target==='official' && a.semanticFallback && a.semanticValue==='校园招聘官网'));
assert.ok(mokaRecruitmentSource.actions.every(a=>a.resolvedValue!=='其他'),'来源保持用户事实，由模型比较网站枚举含义');
const countryLeaf=buildActionPlan([option('leaf','中国香港','radio'),confirm],eduResume,[{kind:'click',context:'popup',resumeField:'education[0].country'}]);
assert.equal(countryLeaf.actions[0].target,'leaf');
const jobIntent=buildActionPlan([{index:'intent',kind:'custom-select',label:'第二意向岗位',operations:['CLICK']}],{internship:[{position:'实习职位'}]});
assert.equal(jobIntent.actions.length,0);
const ordinaryInput=buildActionPlan([{index:'email',kind:'input',operations:['TYPE_TEXT'],label:'邮箱',value:''},
  option('irrelevant','说明')],{basics:{name:'姓名甲',email:'synthetic@example.test'}},[{kind:'type_text',resumeField:'basics.name'}]);
assert.ok(ordinaryInput.actions.some(a=>a.resumeField==='basics.email'));
const degreeResume={education:[{studyType:'硕士',degree:'工学'}]};
const degreePlan=buildActionPlan([option('master','硕士','radio'),option('bachelor','学士','radio'),confirm],degreeResume,[{kind:'click',resumeField:'education[0].degree'}]);
assert.equal(degreePlan.actions[0].target,'master');
assert.equal(buildActionPlan([{index:'degree',kind:'custom-select',label:'学位',value:'硕士',operations:['CLICK']}],degreeResume).status,'done');
const monthOnlyColumns=[column('year','2026年',['2026年']),column('month','11月',['11月']),
  column('day','10日',['1日','10日']),confirm];
const incompleteDate=buildActionPlan(monthOnlyColumns,{education:[{endDate:'2026-11'}]},
  [{kind:'click',resumeField:'education[0].endDate'}]);
assert.equal(incompleteDate.actions[0]?.target,'day:1');
const pendingEditor=buildActionPlan([{index:'editor',kind:'input',context:'popup',operations:['TYPE_TEXT'],label:'专业',value:'计算机'}],
  {education:[{area:'计算机'}]},[{kind:'type_text',context:'popup',resumeField:'education[0].area'}]);
assert.notEqual(pendingEditor.status,'done');
const gpaControl={index:'gpa',kind:'input',label:'GPA',value:'',operations:['TYPE_TEXT']};
assert.equal(buildActionPlan([gpaControl],{education:[{gpa:''},{gpa:'3.8'}]}).actions.length,0);
const dateControl={index:'start',kind:'custom-select',label:'开始时间',operations:['CLICK']};
const scoped=buildActionPlan([dateControl],{education:[{startDate:'2025-09'}],internship:[{startDate:'2026-07'}]},[],{title:'教育经历'});
assert.deepEqual(scoped.actions.map(a=>a.resumeField),['education[0].startDate']);
const beisenAwardDate={index:'award-date',kind:'beisen-date',label:'获奖时间',value:'',operations:['PICK_DATE']};
const beisenAwardPlan=buildActionPlan([beisenAwardDate],{awards:[{title:'奖项甲',date:'2024-08'}]},[],{title:'获奖情况'});
assert.deepEqual(beisenAwardPlan.actions.map(action=>[action.target,action.operation,action.resumeField]),
  [['award-date','PICK_DATE','awards[0].date']]);
const beisenFluency=[
  {index:'fluency',kind:'custom-select',label:'掌握程度',value:'',operations:['CLICK']},
  {index:'fluent-option',kind:'option-item',label:'熟练',value:'',operations:['CLICK'],context:'popup'}
];
const beisenFluencyPlan=buildActionPlan(beisenFluency,{languages:[{language:'英语',siteFluency:'良好'}]},
  [{kind:'click',resumeField:'languages[0].siteFluency'}],{title:'语言能力'});
assert.equal(beisenFluencyPlan.actions[0]?.target,'fluent-option',
  '北森将“良好”显示为“熟练”时应选择已观察到的站内选项');
const rawAwards={awards:[{title:'发明专利（专利号：TEST）'},{title:'2024 测试竞赛一等奖',date:'2024'}]};
const cleaned=prepareResume(rawAwards);
assert.equal(rawAwards.awards.length,2);
assert.equal(cleaned.awards.length,1);
assert.equal(cleaned.awards[0].grade,'一等奖');
assert.equal(cleaned.awards[0].type,'竞赛比赛');
assert.match(getResumeValue(cleaned,'basics.achievements'),/专利/);
const awardName={index:'award',kind:'input',label:'获奖名称',value:'',operations:['TYPE_TEXT']};
assert.equal(buildActionPlan([awardName],{awards:[{title:'奖项甲'},{title:'奖项乙'}]},[],{title:'获奖经历',recordIndex:1}).actions[0].resumeField,'awards[1].title');
const save={index:'save',kind:'action',label:'保存',operations:['CLICK']};
assert.ok(!buildActionPlan([{...gpaControl,required:true},save],{education:[{}]},[],{title:'教育经历'}).actions.some(a=>a.target==='save'));
const projectControls=['项目名称','项目职务','项目地点','项目职责','项目描述'].map((label,index)=>({index:`p${index}`,kind:'input',label,value:'',operations:['TYPE_TEXT']}));
const projectPlan=buildActionPlan(projectControls,{projects:[{name:'项目甲',role:'开发',responsibilities:'负责开发',description:'描述甲'},{name:'项目乙'},{name:'项目丙'}]},[],{title:'项目经验'});
assert.deepEqual(projectPlan.actions.map(a=>[a.target,a.resumeField]),[['p0','projects[0].name'],['p1','projects[0].role'],['p3','projects[0].responsibilities'],['p4','projects[0].description']]);
const skillResume=prepareResume({skills:[{name:'编程语言',items:[{skill:'Python',level:''},{skill:'TypeScript',level:'熟悉'}]}],awards:[{title:'国家发明专利（专利号：ZL TEST 123）'}]});
assert.deepEqual(skillResume.patents,[{number:'ZL TEST 123'}]);
assert.equal(skillResume.computerSkills.length,2);
const skillControl=(label,index)=>({index,label,kind:'input',operations:['TYPE_TEXT'],value:''});
const skillPlan=buildActionPlan([skillControl('技能名称','n'),skillControl('技能水平','l')],skillResume,[],{title:'专业技能'});
assert.deepEqual(skillPlan.actions.map(a=>a.resumeField),['professionalSkills[0].name']);
assert.deepEqual(buildActionPlan([skillControl('技能名称','n'),skillControl('技能水平','l')],skillResume,[],{title:'专业技能',recordIndex:1}).actions.map(a=>a.resumeField),['professionalSkills[1].name','professionalSkills[1].level']);
const otherPlan=buildActionPlan([option('other','其他','radio'),confirm],skillResume,[{kind:'click',resumeField:'computerSkills[1].name'}],{title:'计算机能力',recordIndex:1});
assert.equal(otherPlan.actions[0].target,'other');
assert.equal(otherPlan.actions[0].resolvedValue,'其他');
const otherReadback=buildActionPlan([{index:'n',label:'编程语言',kind:'custom-select',operations:['CLICK'],value:'其他'}],skillResume,[{kind:'click',resumeField:'computerSkills[1].name',resolvedValue:'其他'}],{title:'计算机能力',recordIndex:1});
assert.equal(otherReadback.status,'done');
