import assert from 'node:assert/strict';
import {runGoalScheduler} from '../background/goal-runner.js';
import {exactRecordIdentity} from '../lib/goal-state.js';

const originalFetch=globalThis.fetch,requests=[];
const controls=['CET-6','IELTS'].flatMap((certificate,index)=>[
  {index:`exam-${index}`,stableKey:`exam-${index}`,regionId:'language-module',recordStableKey:`language-${index}`,
    recordIndex:index,section:'语言档案',kind:'input',label:'考试名称',value:certificate,operations:['TYPE_TEXT']},
  {index:`score-${index}`,stableKey:`score-${index}`,regionId:'language-module',recordStableKey:`language-${index}`,
    recordIndex:index,section:'语言档案',kind:'input',label:'成绩',value:'',operations:['TYPE_TEXT']}
]);
const source={languages:[{language:'英语',certificate:'IELTS',score:'6.5',fluency:'CET-6、雅思 6.5'}]};
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);requests.push(body);
  if(body.questions.match) {
    const unrelated=body.state.webpage_values.some(field=>field.value==='CET-6');
    return {ok:true,json:async()=>({answers:{match:{type:'noul',noul:unrelated?0.01:0.99},
      unrelated:{type:'noul',noul:unrelated?0.99:0.01}}})};
  }
  const entries=Object.entries(body.questions.action.criteria);
  const selected=['WORK_SECTION','SELECT_DATA_BLOCK','FILL_RECORDS','BIND_RECORD']
    .map(operation=>entries.find(([,action])=>action.operation===operation)).find(Boolean) || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:selected[0],confidence:0.99}}})};
};
try {
  const transactions=[];
  const result=await runGoalScheduler({tabId:1,resume:source,apiKey:'synthetic',apiProvider:'quickrouter',
    goal:'核对考试记录',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
    snapshot:async()=>({page:{documentId:'synthetic',text:'语言档案'},elements:controls}),
    closeTransactions:async()=>({ok:true}),executeClick:async()=>assert.fail('保留已有记录，直接检查下一条'),
    transaction:async({recordControlKeys})=>{
      transactions.push(recordControlKeys);
      assert.deepEqual(recordControlKeys,['exam-1','score-1'],'高置信的错误 Choice 被独立身份核验拦截');
      controls[3].value='6.5';return {ok:true,history:[]};
    }});
  assert.equal(controls[1].value,'','雅思分数保持在雅思记录内');
  assert.equal(controls[3].value,'6.5');
  assert.equal(transactions.length,1);
  assert.equal(result.pendingIssues.length,0,'明确不同的原有考试保持原状，归属未知的记录仍由另一分支处理');
  assert.equal(requests.filter(body=>body.questions.match).length,1,'考试冲突进入语义核验');
  assert.equal(requests.filter(body=>body.state?.goal_context?.phase==='record-binding').length,1,
    '唯一精确匹配的 IELTS 记录直接绑定，Jev 只判断身份不确定的 CET-6 记录');
  assert.equal(exactRecordIdentity({controls:[controls[0]]},source.languages,0),false);
  assert.equal(exactRecordIdentity({controls:[controls[2]]},source.languages,0),true);
  assert.equal(exactRecordIdentity({controls:[{label:'语言类型',value:'英语'}]},source.languages,0),true,
    '唯一语言类型可直接确认既有语言记录');
  assert.equal(exactRecordIdentity({controls:[{label:'语言类型',value:'英语'}]},
    [source.languages[0],{...source.languages[0],certificate:'TOEFL'}],0),false,
    '重复语言类型仍需证书或成绩等记录证据');
  assert.equal(exactRecordIdentity({controls:[{...controls[2],value:'合成学校'},
    {...controls[3],value:'2018-09-01'}]},[{institution:'合成学校',startDate:'2025-09-01'}],0),true,
    '唯一字面单位名称仍能纠正此前写入的错误日期');
  assert.equal(exactRecordIdentity({controls:[{...controls[2],value:'合成学校'},
    {...controls[3],value:'2018-09-01',kind:'observed-field'},
    {...controls[3],value:'2025-09-01',kind:'beisen-date'}]},[{institution:'合成学校',startDate:'2025-09-01'}],0),true,
    '日期观察副本与真实日期控件冲突时，以实际日期控件核对身份');
  assert.equal(exactRecordIdentity({controls:[{...controls[2],value:'合成学校'},
    {...controls[3],value:'2018-09-01',kind:'observed-field'}]},[{institution:'合成学校',startDate:'2025-09-01'}],0),true,
    '仅有日期观察副本时以唯一明确名称确认记录，保留观察副本供字段回读');
  assert.equal(exactRecordIdentity({controls:[{...controls[2],value:'合成学校'},
    {...controls[3],value:'2025-09'}]},[{institution:'合成学校',startDate:'2025-09-01'}],0),true,
    '日期精度不同但事实一致时保留精确证据');
  assert.equal(exactRecordIdentity({controls:[controls[2]]},[source.languages[0],source.languages[0]],0),false,
    '同名来源仍需其他身份依据');
  assert.ok(!JSON.stringify(requests).includes('synthetic-key'));
} finally {globalThis.fetch=originalFetch;}
console.log('Record identity: high-confidence conflicting Choice is blocked and original exam remains preserved');
