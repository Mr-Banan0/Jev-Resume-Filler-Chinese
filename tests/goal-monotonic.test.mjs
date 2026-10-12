import assert from 'node:assert/strict';
import {runGoalScheduler} from '../background/goal-runner.js';
import {blockPlan,closeRegion,createGoalLedger,entryPlan,regionPlan} from '../lib/goal-state.js';

const field=(section,key,label,value='')=>({section,index:key,stableKey:key,label,value,
  kind:'input',operations:['TYPE_TEXT']});
const entry=(section,key,label='填写')=>({section,index:key,stableKey:key,label,kind:'action',operations:['CLICK']});

// 终结状态独立于可变的结果状态和 DOM 节点身份。
const snapshot={page:{text:'合成简历'},elements:[field('区域甲','a','姓名'),field('区域乙','b','性别')]};
const ledger=createGoalLedger();
assert.equal(regionPlan(ledger,snapshot).actions.length,2);
const first=ledger.regions.get('区域甲');
closeRegion(first,'pending');
assert.equal(closeRegion(first,'checked').status,'pending','终结结果由首次退出确定');
first.status='ready';
assert.deepEqual(regionPlan(ledger,snapshot).actions.map(action=>action.section),['区域乙'],
  '已终结分区保持在候选之外，即使结果状态被其他代码改写');
assert.equal(blockPlan('区域甲',snapshot.elements,{basics:{name:'合成姓名'}},first).actions.length,0);
assert.equal(entryPlan([entry('区域甲','open')],first).actions.length,0);
const rebuilt={...snapshot,elements:[field('区域甲','rebuilt','姓名'),...snapshot.elements.slice(1)]};
assert.deepEqual(regionPlan(ledger,rebuilt).actions.map(action=>action.section),['区域乙']);
assert.ok(regionPlan(createGoalLedger(),rebuilt).actions.some(action=>action.section==='区域甲'),
  '用户重新启动填写时建立新的清单');

const originalFetch=globalThis.fetch;
const menus=[];
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);
  if(body.questions.match) return {ok:true,json:async()=>({answers:{match:{type:'noul',noul:1},unrelated:{type:'noul',noul:0}}})};
  const entries=Object.entries(body.questions.action.criteria);
  if(body.state.goal_context?.phase==='region-menu') menus.push(entries.map(([,action])=>action.target));
  const selected=entries.find(([,action])=>action.operation==='WORK_SECTION') ||
    entries.find(([,action])=>action.operation==='SELECT_DATA_BLOCK') ||
    entries.find(([,action])=>action.operation==='OPEN_EDITOR') || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:selected[0],confidence:1}}})};
};
try {
  let openedBlocked=false,unlocked=false,secondOpen=true,firstClicks=0;
  const name=field('后续区域','name','姓名'),late=field('受阻区域','late','籍贯');
  const transactions=[],events=[];
  const result=await runGoalScheduler({tabId:1,resume:{basics:{name:'合成姓名',nativePlace:'合成籍贯'}},
    apiKey:'synthetic',goal:'补齐空字段',isCurrentRun:()=>true,sleep:async()=>{},
    report:event=>events.push(event),closeTransactions:async()=>({ok:true}),
    snapshot:async()=>({page:{text:'合成简历',observation:{feedback:openedBlocked && !unlocked ? ['请先完成后续区域'] : []}},
      elements:[entry('受阻区域','first'),...(unlocked?[late]:[]),
        ...(secondOpen?[name,entry('后续区域','second','保存')]:[
          {...entry('后续区域','edit','编辑'),summaryText:'合成姓名'}])]}),
    executeClick:async(_tab,_frame,key)=>{
      if(key==='first') {firstClicks++;openedBlocked=true;}
      else if(key==='second') {unlocked=true;secondOpen=false;}
      else assert.fail(`意外操作 ${key}`);
      return {ok:true};
    },
    transaction:async({scopeSection})=>{
      transactions.push(scopeSection);assert.equal(scopeSection,'后续区域');name.value='合成姓名';
      return {ok:true,history:[{kind:'bind',controlStableKey:'name',resumeField:'basics.name'}]};
    }});
  assert.equal(firstClicks,1,'受阻入口本轮只尝试一次');
  assert.deepEqual(transactions,['后续区域']);
  assert.deepEqual(menus,[['[region:受阻区域] 受阻区域','[region:后续区域] 后续区域'],['[region:后续区域] 后续区域']],
    '后续 Jev 区域候选中已移除终结分区');
  assert.equal(late.value,'','依赖解除后新出现的字段保持只读');
  assert.ok(result.pendingIssues.some(issue=>issue.section==='受阻区域' && issue.field==='编辑入口'));
  assert.ok(result.pendingIssues.some(issue=>issue.section==='受阻区域' && issue.field==='籍贯' && issue.status==='uninspected'));
  assert.equal(result.goalSummary.saved,1);
  assert.ok(result.sections.every(section=>section.closed));
  assert.deepEqual(events.filter(event=>event.phase==='section-closed').map(event=>event.section),['受阻区域','后续区域']);

  const composite=[field('合成复合区','fullName','姓名'),field('合成复合区','email','邮箱')];
  const scoped=[];
  const compositeResult=await runGoalScheduler({tabId:1,resume:{basics:{name:'合成姓名',email:'test@example.invalid'}},
    apiKey:'synthetic',goal:'逐项补齐',isCurrentRun:()=>true,sleep:async()=>{},report:()=>{},
    closeTransactions:async()=>({ok:true}),executeClick:async()=>assert.fail('内联字段无需点击其他入口'),
    snapshot:async()=>({page:{text:'合成复合区'},elements:composite}),
    transaction:async({recordControlKeys,fieldScope})=>{
      assert.equal(fieldScope,true,'复合问答使用单问题执行边界');
      assert.equal(recordControlKeys.length,1,'当前资料块执行时保持路由目标范围');
      scoped.push(recordControlKeys[0]);
      const control=composite.find(item=>item.stableKey===recordControlKeys[0]);
      control.value=control.label==='姓名'?'合成姓名':'test@example.invalid';
      return {ok:true,history:[]};
    }});
  assert.deepEqual(scoped,['fullName','email'],'同一资料块逐个供应多个问题');
  assert.equal(compositeResult.goalSummary.writes,2);
  assert.equal(compositeResult.pendingIssues.length,0);

  const originalChoice=globalThis.fetch;
  globalThis.fetch=async(url,args)=>{
    const body=JSON.parse(args.body);
    if(body.questions.match) return {ok:true,json:async()=>({answers:{match:{type:'noul',noul:1},unrelated:{type:'noul',noul:0}}})};
    const entries=Object.entries(body.questions.action.criteria);
    let selected;
    if(body.state.goal_context?.phase==='record-scope') selected=entries.find(([,a])=>a.operation==='FILL_RECORDS');
    if(body.state.goal_context?.phase==='record-binding') selected=entries.find(([,a])=>
      body.state.goal_context.webpageRecordPosition===0 ? a.operation==='SKIP_RECORD' : a.target==='source:0');
    return selected ? {ok:true,json:async()=>({answers:{action:{choice:selected[0],confidence:1}}})} : originalChoice(url,args);
  };
  const unknown=field('教育经历','unknown','学校名称','外部学校');
  const known=field('教育经历','known','学校名称','合成学校甲');
  const unknownMajor=field('教育经历','unknown-major','专业');
  const knownMajor=field('教育经历','known-major','专业');
  for(const control of [unknown,unknownMajor]) Object.assign(control,{recordIndex:0,recordStableKey:'unknown-record'});
  for(const control of [known,knownMajor]) Object.assign(control,{recordIndex:1,recordStableKey:'known-record'});
  const filled=[];
  const partialRecords=await runGoalScheduler({tabId:1,
    resume:{education:[{institution:'合成学校甲',area:'合成专业甲'},{institution:'合成学校乙',area:'合成专业乙'}]},
    apiKey:'synthetic',goal:'检查每条经历',isCurrentRun:()=>true,sleep:async()=>{},report:()=>{},
    snapshot:async()=>({page:{text:'教育经历'},elements:[unknown,unknownMajor,known,knownMajor,entry('教育经历','add','新增教育经历')]}),
    closeTransactions:async()=>({ok:true}),executeClick:async()=>assert.fail('归属未确定时保留已有记录并暂停新增'),
    transaction:async({recordControlKeys})=>{
      assert.ok(recordControlKeys.includes('known-major'));
      filled.push('known-major');knownMajor.value='合成专业甲';return {ok:true,history:[]};
    }});
  assert.deepEqual(filled,['known-major'],'一条记录无法绑定时继续检查后续已知记录');
  assert.equal(unknownMajor.value,'','归属未知的记录保持原样');
  assert.ok(partialRecords.pendingIssues.some(issue=>issue.field==='记录归属'));
  assert.ok(partialRecords.pendingIssues.some(issue=>issue.field==='剩余记录'));
} finally {globalThis.fetch=originalFetch;}

console.log('Goal monotonic: closed sections leave all candidates; late dependencies and fields remain read-only');
