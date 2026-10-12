import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {buildObservedActionPlan} from '../lib/observed-interaction.js';
import {buildQuestions,choose} from '../lib/jev-client.js';

const cases=[
  {label:'证件号码',options:['15位身份证号','18位身份证号','护照号（外籍）','军官证','台湾居民来往大陆通行证','港澳居民来往内地通行证'],
    resume:{basics:{name:'合成姓名',gender:'男',height:'175',weight:'65',nationality:'中国',ethnicity:'汉族',
      politicalStatus:'中共党员',healthStatus:'健康',maritalStatus:'未婚',highestDegree:'硕士',
      idType:'身份证',idNumber:'000000200001010000',birthDate:'2000-01-01',partyJoinDate:'2025-04',
      birthPlace:'广东省广州市黄埔区',hukou:'广东省广州市黄埔区',studentOrigin:'广东省广州市',
      email:'synthetic@example.test',phone:'00000000000',summary:'合成个人简介',label:'合成岗位',
      nativePlace:'广东河源和平县',nativePlaceDetail:{province:'广东省',city:'河源市',district:'和平县'},
      homeAddress:'合成家庭地址',mailingAddress:'合成通讯地址',
      location:{city:'深圳',region:{province:'广东省',city:'深圳市',district:'宝安区'}}}},field:'basics.idType'},
  {label:'入党团时间',options:['2024年','2025年','2026年'],
    resume:{basics:{partyJoinDate:'2025-04',birthDate:'2000-01-01'}},field:'basics.partyJoinDate'},
  {label:'出生地',options:['广东省','北京市','上海市'],
    resume:{basics:{birthPlace:'广东省广州市黄埔区',studentOrigin:'广东省广州市'}},field:'basics.birthPlace'},
  {label:'现居住城市',options:['广东省','北京市','上海市'],
    resume:{basics:{location:{city:'深圳',region:{province:'广东省',city:'深圳市',district:'宝安区'}},
      birthPlace:'广东省广州市黄埔区',hukou:'广东省广州市黄埔区'}},field:'basics.location.region.city'},
  {label:'期望薪资范围',options:['10000-15000','15000-20000'],
    resume:{basics:{name:'合成姓名',height:'175'}},field:null},
  {label:'上传照片',kind:'file',options:[],resume:{basics:{name:'合成姓名',
    photo:{name:'synthetic-photo.png',type:'image/png',dataUrl:'data:image/png;base64,SYNTHETIC'},
    resumeFile:{name:'synthetic-cv.pdf',type:'application/pdf',dataUrl:'data:application/pdf;base64,SYNTHETIC'}}},field:'basics.photo'},
  {label:'工作描述',kind:'textarea',options:[],block:'internship',
    resume:{internship:[{company:'合成企业',position:'开发实习生',
      summary:'合成项目：负责后端接口开发、指标计算及回归验证。'.repeat(6),
      responsibilities:'合成项目：负责后端接口开发、指标计算及回归验证。'.repeat(6)}]},field:'internship[0].summary'},
  {label:'入离职时间（开始）',options:['2025年','2026年','2027年'],block:'internship',
    resume:{internship:[{startDate:'2026-07',endDate:'至今',position:'开发实习生'}]},field:'internship[0].startDate'},
  {label:'时间（结束）',options:['2025年','2026年','2027年'],block:'projects',
    resume:{projects:[{name:'合成项目',startDate:'2026-03',endDate:'2026-05'}]},field:'projects[0].endDate'}
];
const live=process.argv.includes('--live');
const apiKey=live ? process.env.TYPESAFE_API_KEY || readFileSync(join(homedir(),'.config/typesafe/api_key'),'utf8').trim() : '';
for(const item of cases) {
  const root={index:'root',stableKey:'root',section:'个人信息',label:item.label,
    kind:item.kind || 'observed-field',value:'请选择',operations:item.kind==='file' ? ['UPLOAD_FILE'] : item.kind==='textarea' ? ['TYPE_TEXT'] : ['CLICK']};
  const options=item.options.map((label,index)=>({index:`p${index}`,stableKey:`p${index}`,label,
    kind:'option-item',context:'popup',popupOwnerKey:'root',operations:['CLICK']}));
  const history=[{kind:'focus',controlStableKey:'root'},{kind:'inspect',controlStableKey:'root'}];
  const page={title:'个人信息',sectionScope:true,dataBlock:item.block || 'basics',recordScope:true,recordIndex:0};
  const plan=buildObservedActionPlan([root,...options],item.resume,history,page);
  assert.equal(plan.observation.phase,'bind');
  assert.deepEqual(plan.observation.visible_options || [],item.options);
  const question=buildQuestions('填写当前字段',plan).action;
  assert.ok(Object.values(question.criteria).every(c=>!Object.hasOwn(c,'label')),
    '绑定候选描述来源事实，页面标题只作为当前控件证据出现一次');
  if(live) {
    const result=await choose({apiKey,goal:'填写当前字段',page,elements:[root,...options],history,
      resume:item.resume,actionPlan:plan});
    console.log(JSON.stringify({field:item.label,source:result.resumeField || null,confidence:result.confidence}));
    assert.equal(result.resumeField || null,item.field);
    assert.ok(result.confidence>=0.75);
  }
}
console.log('Observed binding: shared captions, picker evidence, month dates and NO_SOURCE passed');
