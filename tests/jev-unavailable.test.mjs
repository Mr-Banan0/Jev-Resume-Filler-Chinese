import assert from 'node:assert/strict';
import {choose} from '../lib/jev-client.js';
import {runGoalScheduler} from '../background/goal-runner.js';
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
globalThis.fetch=async()=>{throw Error('synthetic outage');};
const action={id:'a1',operation:'CLICK',target:'f0_1',label:'打开分区',kind:'section-entry'};
try {
  await assert.rejects(choose({apiKey:'synthetic',goal:'fill',page:{},elements:[],history:[],resume:{},
    actionPlan:{actions:[action],byId:{a1:action}}}),/决策服务暂不可用/);
  const field={index:'name',stableKey:'name',regionId:'basic',section:'基本资料',
    label:'姓名',kind:'input',operations:['TYPE_TEXT'],value:''};
  const result=await runGoalScheduler({tabId:1,apiKey:'synthetic',goal:'检查资料',
    resume:{basics:{name:'合成姓名'}},report:()=>{},sleep:async()=>{},isCurrentRun:()=>true,
    snapshot:async()=>({page:{text:'基本资料'},elements:[field]}),
    transaction:async()=>assert.fail('服务受阻时保持表单原状'),
    executeClick:async()=>assert.fail('服务受阻时保持表单原状'),closeTransactions:async()=>({ok:true})});
  assert.equal(result.done,undefined);
  assert.equal(result.ok,false);
  assert.equal(result.goalSummary.regions,1,'观察到一个分区');
  assert.equal(result.goalSummary.regionsChecked,0,'已发现分区与已检查分区分别计数');
  assert.equal(result.goalSummary.writes,0);
  assert.ok(result.pendingIssues.some(issue=>issue.field==='模型服务连接' && issue.status==='blocked'));
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;}
console.log('An API outage reports a pending decision without fabricating a choice or confidence');
