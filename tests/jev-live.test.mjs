// 显式运行的真实判断评测；输入均为合成资料，密钥从环境或本机私有配置读取。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildActionPlan,buildDataBlockPlan,choose,fieldBindingThreshold} from '../lib/jev-client.js';

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
