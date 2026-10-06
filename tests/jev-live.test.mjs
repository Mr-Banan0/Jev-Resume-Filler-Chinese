// 显式运行的真实判断评测；输入均为合成资料，密钥从环境或本机私有配置读取。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildActionPlan,buildDataBlockPlan,buildRecordBindingPlan,choose,fieldBindingThreshold} from '../lib/jev-client.js';
import {renderedRecordKey} from '../lib/traversal-state.js';

let apiKey=process.env.TYPESAFE_API_KEY;
if(!apiKey) {try {apiKey=readFileSync(join(homedir(),'.config/typesafe/api_key'),'utf8').trim();} catch {}}
assert.ok(apiKey,'配置 TYPESAFE_API_KEY 后运行真实判断评测');
const resume={basics:{name:'合成姓名',email:'synthetic@example.test'},
  education:[{institution:'合成大学',degree:'硕士',studyMode:'全日制',gpa:'3.5/4.3',researchFocus:'空间计算'}],
  internship:[{company:'合成企业甲',position:'软件实习生',summary:'开发测试平台'},
    {company:'合成企业乙',position:'研发实习生',summary:'交付评测平台'}],
  languages:[{language:'英语',certificate:'IELTS',score:'6.5'}],
  campusPractice:[{position:'班长',organization:'合成大学',summary:'组织班级活动'}]};
const control=(section,label,kind='input')=>({index:'f0_field',frameId:0,stableKey:'f0:field',section,label,kind,value:'',
  operations:kind==='custom-select'?['CLICK']:['TYPE_TEXT']});
const routes=[['学业资料',['学校名称','学术主题摘要'],'education'],
  ['个人信息',['语言证书名称','分数'],'languages'],
  ['校内职务',['职务','学校/组织名称'],'campusPractice'],
  ['紧急联系信息',['紧急联系人电话'],null]];
const bindings=[['education','教育经历','学习方式','custom-select','education[0].studyMode',0],
  ['education','教育经历','GPA/CGPA','input','education[0].gpa',0],
  ['internship','实习经历','所在单位','input','internship[1].company',1],
  ['languages','语言能力','等级/分数','input','languages[0].score',0],
  ['internship','实习经历','证明人联系电话','input',null,1]];
let passed=0;
const failures=[];
{
  const synthetic={awards:[{title:'合成奖项',date:'2024-08',details:'合成获奖详情'}]};
  const owner={...control('表彰与奖励','获奖年份','custom-select'),datePart:'year',dateSlot:0,recordIndex:0};
  const elements=[owner,...Array.from({length:227},(_,i)=>({index:`year${i}`,stableKey:`year${i}`,
    section:'表彰与奖励',context:'popup',kind:'option-item',label:String(2126-i),operations:['CLICK']}))];
  const history=[{kind:'bind',resumeField:'awards[0].date.year',controlStableKey:owner.stableKey},
    {kind:'click',resumeField:'awards[0].date.year',sourceTarget:owner.index,controlStableKey:owner.stableKey,
      sourceControl:owner,context:'form',page_changed:true}];
  const page={title:'表彰与奖励',dataBlock:'awards',sectionScope:true,recordScope:true,recordIndex:0,ignoreUnmapped:true};
  const plan=buildActionPlan(elements,synthetic,history,page);
  const decision=await choose({apiKey,goal:'选择当前获奖年份',page,elements,history,resume:synthetic,actionPlan:plan});
  assert.equal(decision.label,'2024');
  console.log('Long year dropdown: selected the bound year');
}
for(const [section,labels,expected] of routes) {
  const elements=labels.map((label,i)=>({...control(section,label),index:`f0_${i}`}));
  const plan=buildDataBlockPlan(section,elements,resume);
  const choice=await choose({apiKey,goal:'尽可能填写当前简历分区；仅选择实际对应的资料块，资料缺失时返回。',
    page:{title:section,sectionScope:true},elements,history:[],resume,actionPlan:plan});
  const valid=(choice.dataBlock || null)===expected;
  console.log(JSON.stringify({case:`route:${section}`,expected,actual:choice.dataBlock || null,confidence:choice.confidence,passed:valid}));
  if(valid) passed++; else failures.push(section);
}
for(const [dataBlock,section,label,kind,expected,recordIndex] of bindings) {
  const elements=[{...control(section,label,kind),recordIndex}];
  const page={title:section,dataBlock,sectionScope:true,recordScope:true,recordIndex,recordEditor:true,ignoreUnmapped:true,allowAddRecords:false};
  const plan=buildActionPlan(elements,resume,[],page);
  const choice=await choose({apiKey,goal:'把当前空字段绑定到当前记录的实际字段；缺少资料时跳过或返回。',page,elements,history:[],resume,actionPlan:plan});
  const actual=choice.operation==='BIND_FIELD'?choice.resumeField:null;
  const valid=actual===expected && (!expected || choice.confidence>=fieldBindingThreshold(choice));
  console.log(JSON.stringify({case:`field:${label}`,expected,actual,confidence:choice.confidence,passed:valid}));
  if(valid) passed++; else failures.push(label);
}
console.log(`Real Jev evaluation: ${passed}/${routes.length+bindings.length} passed`);
assert.deepEqual(failures,[],'检查失败用例的候选覆盖、上下文和置信策略');

const sourceRecords=[{name:'城市声景预测',startDate:'2023-12-01',endDate:'2024-09-01',description:'半监督训练并使用 SHAP 解释声景预测'},
  {name:'工程模型协同建模',startDate:'2023-03-01',endDate:'2024-03-01',description:'Java Spring 与 DLL 跨语言数据转换'}];
const observed=(description)=>[{index:'name',recordIndex:0,section:'项目经历',kind:'input',label:'项目名称',value:'合成研究机构',operations:['TYPE_TEXT']},
  {index:'desc',recordIndex:0,section:'项目经历',kind:'textarea',label:'项目描述',value:description,operations:['TYPE_TEXT']}];
for(const [description,expected] of [['用半监督学习预测城市声景，并通过SHAP解释噪声来源',0],['组织研究活动',null]]) {
  const elements=observed(description),resume={projects:sourceRecords};
  const plan=buildRecordBindingPlan(elements,resume,'projects');
  const decision=await choose({apiKey,goal:'结合当前网页记录证据判断其对应项目，证据不足时保留待核对。',
    page:{title:'项目经历',dataBlock:'projects',sectionScope:true},elements:plan.observed,history:[],resume,actionPlan:plan});
  const actual=decision.operation==='BIND_RECORD' && decision.confidence>=0.9 ? decision.recordIndex : null;
  console.log(JSON.stringify({case:'record binding',expected,actual,confidence:decision.confidence}));
  assert.equal(actual,expected);
}

const reorderedResume={projects:[{name:'合成新项目',startDate:'2026-09',endDate:'至今'},
  {name:'合成历史项目甲',startDate:'2026-03',endDate:'2026-05'},
  {name:'合成历史项目乙',startDate:'2023-12',endDate:'2024-09'},
  {name:'合成历史项目丙',startDate:'2023-03',endDate:'2024-03'}]};
for(const [label,kind,datePart,expected] of [
  ['开始年份','custom-select','year','projects[0].startDate.year'],
  ['开始月份','custom-select','month','projects[0].startDate.month'],
  ['至今','custom-checkbox',null,'projects[0].endDate.isPresent']]) {
  const rows=[1,2,3,0].flatMap((sourceIndex,recordIndex)=>[
    {...control('项目经验','项目名称'),index:`name-${recordIndex}`,stableKey:`name-${recordIndex}`,
      recordIndex,recordStableKey:`row-${recordIndex}`,value:sourceIndex===0?'':reorderedResume.projects[sourceIndex].name},
    {...control('项目经验',label,kind),index:`date-${recordIndex}`,stableKey:`date-${recordIndex}`,
      recordIndex,recordStableKey:`row-${recordIndex}`,datePart,dateSlot:datePart==='year'?0:1,checked:false,
      operations:['CLICK'],value:sourceIndex===0?'':datePart==='year'?reorderedResume.projects[sourceIndex].startDate.slice(0,4):
        datePart==='month'?String(Number(reorderedResume.projects[sourceIndex].startDate.slice(5,7))):''}]);
  const recordBindings=Object.fromEntries(rows.filter(row=>row.label==='项目名称').map((row,index)=>
    [renderedRecordKey(row),[1,2,3,0][index]]));
  const page={title:'项目经验',dataBlock:'projects',sectionScope:true,recordScope:true,recordIndex:0,
    recordBindings,ignoreUnmapped:true,allowAddRecords:false};
  const target=rows.at(-1);
  const history=[{kind:'bind',controlStableKey:'name-3',resumeField:'projects[0].name'}];
  // 名称已绑定供执行器使用；本例只评测重排记录中的日期语义绑定。
  rows.at(-2).value='合成新项目';
  const plan=buildActionPlan(rows,reorderedResume,history,page);
  const decision=await choose({apiKey,goal:'绑定当前来源记录的空日期字段，保留网页中已存在的其他经历。',
    page,elements:rows,history,resume:reorderedResume,actionPlan:plan});
  console.log(JSON.stringify({case:`reordered:${label}`,expected,actual:decision.resumeField,confidence:decision.confidence}));
  assert.equal(decision.operation,'BIND_FIELD');
  assert.equal(decision.target,target.index);
  assert.equal(decision.resumeField,expected);
  assert.ok(decision.confidence>=fieldBindingThreshold(decision));
}
