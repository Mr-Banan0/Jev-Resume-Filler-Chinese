import assert from 'node:assert/strict';
import {choose} from '../lib/jev-client.js';
import {verifiedOption,verifiedSource,OPTION_VERIFICATION_THRESHOLD,DESCRIPTION_VERIFICATION_QUESTION,SOURCE_VERIFICATION_QUESTION,GEOGRAPHIC_PROGRESS_QUESTION} from '../lib/jev-verification.js';
import {buildObservedActionPlan} from '../lib/observed-interaction.js';
import {actionPermission} from '../lib/action-policy.js';

const originalFetch=globalThis.fetch,requests=[];
let confidence=0.63,progress=0.99,equivalent=0.02,malformed=false,choice='china';
globalThis.fetch=async(url,args)=>{
  const body=JSON.parse(args.body);requests.push(body);
  assert.equal(url,'https://api.quickrouter.ai/v1/systemone');
  assert.equal(body.model,'jev-1.13.0');
  const answers=body.questions.action ? {action:{type:'choice',choice,confidence,
    probabilities:{[choice]:0.64,return:0.36}}} : body.questions.source ? {source:{type:'noul',noul:progress}} : {
      progress:{type:'noul',noul:progress},equivalent:malformed ? {type:'noul'} : {type:'noul',noul:equivalent}};
  return {ok:true,json:async()=>({model:'jev-1.13.0',answers})};
};
const actions=[{id:'china',operation:'CLICK',target:'country',context:'popup',label:'中国',
  resumeField:'basics.location.city',controlStableKey:'city',observed:true},
  {id:'return',operation:'RETURN',target:'city',label:'返回'}];
const params={apiKey:'synthetic-verification',apiProvider:'quickrouter',goal:'补齐当前字段',history:[],elements:[],
  resume:{},page:{title:'个人信息',sectionScope:true},actionPlan:{policy:'observed',actions,
    byId:Object.fromEntries(actions.map(action=>[action.id,action])),observation:{phase:'operate',
      active_field:'所在地点',desired_value:'深圳市',visible_options:['中国','澳大利亚']}}};
try {
  const result=await choose(params);
  assert.equal(requests.length,2,'一次 Choice 后增加一个双问题核验请求，保持有界');
  assert.equal(result.confidence,0.63,'原始 Choice 分数保持不变');
  assert.equal(result.optionVerification.progress,0.99);
  assert.equal(result.optionVerification.equivalent,0.02,'地理父级与最终城市语义分别核验');
  assert.ok(verifiedOption(result.optionVerification));
  assert.equal(result.verificationTrace.request.state.candidate.label,'中国');
  assert.equal(requests[1].state.interaction.desired_value,'深圳市');
  assert.equal(requests[1].state.section_context,undefined,'原子核验保留当前来源，分区树与其他记录留在选择层');
  assert.equal(JSON.stringify(result).includes(params.apiKey),false);
  requests.length=0;
  await choose({...params,actionPlan:{...params.actionPlan,
    observation:{...params.actionPlan.observation,navigation_kind:'geographic'}}});
  assert.deepEqual(requests[1].questions.progress,GEOGRAPHIC_PROGRESS_QUESTION);
  requests.length=0;progress=0.92;
  const branchActions=actions.map(action=>({...action,pickerBranch:action.id==='china'}));
  const branch=await choose({...params,actionPlan:{...params.actionPlan,actions:branchActions,
    byId:Object.fromEntries(branchActions.map(action=>[action.id,action])),
    observation:{...params.actionPlan.observation,navigation_kind:'geographic'}}});
  assert.equal(branch.optionVerification.mode,'geographic-branch');
  assert.ok(verifiedOption(branch.optionVerification),'包含关系结合观察到的分支证据允许有界导航');
  assert.equal(verifiedOption({...branch.optionVerification,mode:'final-option'}),false,'相同概率保持最终选项门槛');
  assert.ok(verifiedOption({...branch.optionVerification,progress:0.8}),'可逆父级导航采用独立风险门槛');
  assert.equal(verifiedOption({...branch.optionVerification,progress:0.79}),false);
  assert.equal(verifiedOption({...branch.optionVerification,progress:0.94,mode:'final-option'}),false);
  progress=0.99;

  requests.length=0;confidence=0.98;
  const certain=await choose(params);
  assert.equal(requests.length,1,'明确选择保持单次判断');
  assert.equal(certain.optionVerification,undefined);
  requests.length=0;confidence=0.63;progress=0.7;
  assert.equal(verifiedOption((await choose(params)).optionVerification),false);
  assert.equal(requests.length,2);
  malformed=true;
  await assert.rejects(choose(params),/有效的 Noul/,'核验契约缺失保持明确失败');
  assert.equal(verifiedOption({progress:OPTION_VERIFICATION_THRESHOLD-0.01}),false);
  malformed=false;progress=0.99;choice='summary';requests.length=0;
  const summaryActions=[{id:'summary',operation:'BIND_FIELD',target:'skills',kind:'textarea',
    controlStableKey:'skills',resumeField:'@summary:skills',fieldLabel:'技能汇总',semanticValue:'JavaScript、Python'},
    {id:'return',operation:'SKIP_FIELD',target:'skills'}];
  const summary=await choose({...params,actionPlan:{policy:'observed',actions:summaryActions,
    byId:Object.fromEntries(summaryActions.map(action=>[action.id,action])),observation:{phase:'bind',
      active_field:'计算机技能、使用时间、熟练程度描述'}}});
  assert.equal(requests.length,2);
  assert.equal(summary.confidence,0.63);
  assert.equal(summary.sourceVerification.probability,0.99);
  assert.equal(requests[1].state.candidate.target_kind,'textarea');
  assert.deepEqual(requests[1].questions.source,DESCRIPTION_VERIFICATION_QUESTION,'描述框核验已有部分的适用性');
  assert.equal(verifiedSource({mode:'known-description',probability:0.8}),true);
  assert.equal(verifiedSource({mode:'single-fact',probability:0.8}),false);
  assert.equal(verifiedSource({mode:'known-description',probability:0.54}),false,'不相关的项目全文保持待核对');
  assert.equal(verifiedSource({mode:'known-description',probability:Infinity}),false);
  const singleActions=summaryActions.map(action=>({...action,kind:'input'}));requests.length=0;
  await choose({...params,actionPlan:{policy:'observed',actions:singleActions,
    byId:Object.fromEntries(singleActions.map(action=>[action.id,action])),observation:{phase:'bind',active_field:'使用年限'}}});
  assert.deepEqual(requests[1].questions.source,SOURCE_VERIFICATION_QUESTION,'独立属性输入仍要求对应事实');

  const root={index:'city',stableKey:'city',section:'个人信息',kind:'custom-select',label:'所在地点',
    value:'中国',operations:['CLICK']};
  const history=[{kind:'bind',controlStableKey:'city',resumeField:'basics.location.city'},
    {kind:'click',controlStableKey:'city',resumeField:'basics.location.city',selectedLabel:'中国',
      semanticChoiceConfidence:0.98,semanticEquivalentProbability:0.02}];
  const plan=buildObservedActionPlan([root],{basics:{location:{city:'深圳市'}}},history,
    {title:'个人信息',dataBlock:'basics'});
  assert.notEqual(plan.summary.fieldGroups[0]?.status,'satisfied','父级回读保持未完成状态');
  assert.equal(actionPermission({section:'真实性声明',kind:'custom-select',label:'声明：本人保证以上资料属实'}).allowed,false);
} finally {globalThis.fetch=originalFetch;}
console.log('Bounded option verification preserves Choice confidence, validates native Noul and separates navigation from completion');
