import assert from 'node:assert/strict';
import {blockPlan,recordSourcePlan,createGoalLedger,reconcileRegions} from '../lib/goal-state.js';
import {choose,buildSectionJevState} from '../lib/jev-client.js';

const description='完整项目过程\n'.repeat(500)+'保留最后一句';
const record={name:'示例项目',description,custom:{delivery:'完整交付事实'},startDate:'2026-09'};
const resume={projects:Array.from({length:40},(_,i)=>({...record,name:`示例项目 ${i}`})),
  education:[{institution:'其他资料块'}]};
const field={index:'f0_1',stableKey:'field',section:'实践成果',regionId:'region',label:'项目名称',
  kind:'input',value:'',operations:['TYPE_TEXT']};
const snapshot={page:{title:'合成表单'},elements:[field]};
const ledger=createGoalLedger();reconcileRegions(ledger,snapshot);
const region=ledger.regions.get('region');
const plan=blockPlan(region.title,[field],resume,region);
const catalogue=plan.dataCatalogue.find(block=>block.block==='projects');
assert.equal(catalogue.records,40);
assert.ok(catalogue.fields.includes('custom.delivery'));
assert.ok(!catalogue.fields.some(path=>/\[\d+\]/.test(path)));
assert.ok(catalogue.fields.length<10,'目录大小由字段结构决定');
assert.ok(!JSON.stringify(plan.dataCatalogue).includes(description));
const page={title:region.title,regionId:'region',sectionScope:true,dataBlock:'projects'};
assert.deepEqual(buildSectionJevState({page,elements:[field],resume}).json_fields,resume.projects);
assert.deepEqual(buildSectionJevState({page:{...page,recordScope:true,recordIndex:2},elements:[field],resume}).json_fields,
  resume.projects[2],'当前记录包括完整长描述、自定义字段');
const originalFetch=globalThis.fetch;
try {
  const sourcePlan=recordSourcePlan(resume,'projects',[0,2]);
  let sent;
  globalThis.fetch=async(_url,options)=>{
    sent=JSON.parse(options.body);
    return {ok:true,json:async()=>({answers:{action:{choice:sourcePlan.actions[0].id,confidence:1}},usage:{input_tokens:123}})};
  };
  const result=await choose({apiKey:'synthetic-key',goal:'选择项目',resume,page,elements:[field],history:[],actionPlan:sourcePlan});
  assert.deepEqual(sent.state.section_context.json_fields,resume.projects);
  assert.equal(sent.questions.action.criteria.g1.current_state,'section_context.json_fields[0]');
  assert.ok(!JSON.stringify(sent.questions).includes(description),'候选引用完整资料，不复制正文');
  assert.equal(result.requestMetrics.inputTokens,123);
  globalThis.fetch=async()=>({ok:false,status:400,text:async()=>'{"error":"max_tokens_exceeded"}'});
  await assert.rejects(choose({apiKey:'synthetic-key',goal:'选择项目',resume,page,elements:[field],history:[],actionPlan:sourcePlan}),
    error=>error.decisionTrace.request.state.section_context.json_fields[2].description===description &&
      error.decisionTrace.requestMetrics.characters>0 && !JSON.stringify(error.decisionTrace).includes('synthetic-key'));
} finally {globalThis.fetch=originalFetch;}
console.log('Context budget: compact structure catalogue, complete selected block/record, references and failure metrics');
