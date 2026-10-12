import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {blockPlan,closeRegion,createGoalLedger,entryPlan,localRegion,recordBindingPlan,recordSourcePlan,recordSurfaces,regionPlan} from '../lib/goal-state.js';
import {frameObservation,regionTree} from '../lib/page-scope.js';
import {buildSectionJevState} from '../lib/jev-client.js';
import {scopeControls} from '../lib/traversal-state.js';
import {runGoalScheduler} from '../background/goal-runner.js';

for(const title of ['教育经历','学业档案']) for(const depth of [1,7]) {
  const wrap=html=>'<div>'.repeat(depth)+html+'</div>'.repeat(depth);
  const row=(tag,name)=>`<${tag}>${wrap('<label>开始时间<input placeholder="开始时间"></label>')}
    ${wrap('<label>结束时间<input placeholder="结束时间"></label>')}
    ${wrap(`<label>学校名称<input placeholder="学校名称" value="${name}"></label>`)}
    ${wrap('<label>学历类型<input placeholder="学历类型"></label>')}</${tag}>`;
  const dom=new JSDOM(`<nav><button>${title}</button></nav><section><h3>${title}</h3>
    ${row('div','合成学校甲')}${row('article','合成学校乙')}
    <button>添加新的${title}</button></section>
    <section><h3>${title}</h3><label>补充说明<textarea></textarea></label><button>新增一条</button></section>
    <div><div>探索档案</div><div><span style="cursor:pointer">新增空记录</span></div></div>`,
    {url:'https://synthetic.example/resume',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom;let handler;
  window.HTMLElement.prototype.getBoundingClientRect=()=>({width:200,height:30,top:10,left:10,right:210,bottom:40});
  window.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage(){}}};
  for(const file of ['widget-drivers.js','platform-drivers.js','content.js'])
    window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
  const snap=await new Promise(resolve=>handler({type:'SNAPSHOT_FULL'},{},resolve));
  const ledger=createGoalLedger(),menu=regionPlan(ledger,snap);
  const regions=[...ledger.regions.values()].filter(region=>region.title===title);
  assert.equal(regions.length,2,'同名分区由不同 DOM 容器区分');
  const region=regions.find(item=>localRegion(snap,item).some(control=>control.label==='学校名称'));
  assert.ok(region);
  const controls=localRegion(snap,region),surfaces=recordSurfaces(controls);
  assert.equal(surfaces.length,2,'不同 tag 与深层字段包装保持整条经历边界');
  assert.ok(surfaces.every(surface=>['开始时间','结束时间','学校名称','学历类型']
    .every(label=>surface.controls.some(control=>control.label===label))),'日期位于学校前面仍归属完整记录');
  const add=controls.find(control=>control.label===`添加新的${title}`);
  assert.equal(add.section,title,'新增入口继承实际父分区标题');
  assert.equal(add.regionId,region.id);
  assert.ok(entryPlan(controls,region,{adding:true}).actions.some(action=>action.target===add.index));
  assert.equal(menu.actions.filter(action=>action.section===title).length,2);
  const empty=regions.length && [...ledger.regions.values()].find(region=>region.title==='探索档案');
  assert.ok(empty,'任意名称的空模块由入口和相邻标题分支提供证据');
  assert.ok(localRegion(snap,empty).some(control=>control.label==='新增空记录'));
  closeRegion(region);
  assert.equal(regionPlan(ledger,snap).actions.filter(action=>action.section===title).length,1,
    '终结一个同名模块，另一个模块仍有独立填写资格');
  const hierarchy=regionTree(snap,region.id);
  assert.equal(hierarchy.filter(node=>node.kind==='record').length,2);
  assert.ok(!hierarchy.some(node=>node.label==='补充说明'),'局部树保持物理边界');
  const framed=frameObservation(snap.page.observation,7);
  assert.ok(framed.interactionTree.nodes.every(node=>node.id.startsWith('f7:')));
  assert.ok(framed.interactionTree.nodes.every(node=>!node.parentId || node.parentId.startsWith('f7:')));
  assert.deepEqual(scopeControls(snap.elements,{section:title,regionId:region.id}).map(control=>control.stableKey),
    controls.map(control=>control.stableKey),'字段执行器保持当前分区身份');
  const state=buildSectionJevState({page:{...snap.page,title,regionId:region.id,sectionScope:true,dataBlock:'education'},
    elements:snap.elements,resume:{education:[{institution:'合成学校甲'}]}});
  assert.ok(!state.controls.some(control=>control.label==='补充说明'));
  assert.equal(state.region_id,region.id,'分区身份在当前上下文声明一次');
  dom.window.close();
}

const longText='合成技术描述。'.repeat(300),source={projects:[{name:'合成项目',description:longText,
  customFact:{delivery:'合成交付结果'},photo:{name:'synthetic.png',mimeType:'image/png',dataUrl:'data:image/png;base64,SYNTHETIC_BYTES'}}]};
for(const plan of [recordSourcePlan(source,'projects',[0]),recordBindingPlan({},source,'projects',[0])]) {
  const record=plan.actions[0].value;
  assert.equal(record.description,longText,'记录候选保留完整文字');
  assert.equal(record.customFact.delivery,'合成交付结果','自定义字段保留完整上下文');
  assert.equal(record.photo.name,'synthetic.png');
  assert.equal(record.photo.dataUrl,undefined,'附件只提供元信息');
  assert.ok(!JSON.stringify(plan).includes('SYNTHETIC_BYTES'));
}
const completeRecord=[{index:'name',stableKey:'name',section:'合成经历',kind:'input',label:'名称',
  value:'已有合成项目',operations:['TYPE_TEXT']},
  {index:'add',stableKey:'add',section:'合成经历',kind:'action',label:'添加一条记录',operations:['CLICK']}];
const inventoryRegion={closed:false,blocks:new Map(),routingClosed:new Set(),routingAttempts:new Set()};
const inventory=blockPlan('合成经历',completeRecord,source,inventoryRegion);
assert.equal(inventory.recordInventory,true,'一条经历已填仍继续核对 JSON 中的记录清单');
assert.ok(inventory.actions.some(action=>action.dataBlock==='projects'));
assert.deepEqual(inventory.routingTargets,['add']);
inventoryRegion.blocks.set('projects','checked');
assert.ok(!blockPlan('合成经历',completeRecord,source,inventoryRegion).actions.some(action=>action.dataBlock==='projects'),
  '已经核对的记录清单从当前分区候选移除');
inventoryRegion.routingClosed.add('add');
assert.equal(blockPlan('合成经历',completeRecord,source,inventoryRegion).actions.length,0,
  '退出记录清单后，同一新增入口退出候选并结束当前层');
// Independent DOM containers for fields with the same scoped record position form one logical experience.
{
  const parts=[
    {index:'name',stableKey:'name-part',recordStableKey:'region-a:company-list',recordIndex:0,regionId:'region-a',frameId:2,section:'分段经历',kind:'input',label:'公司名称',value:'合成公司',operations:['TYPE_TEXT']},
    {index:'dates',stableKey:'date-part',recordStableKey:'region-a:date-list:record:0',recordIndex:0,regionId:'region-a',frameId:2,section:'分段经历',kind:'beisen-date',label:'开始时间',value:'2024-01',operations:['TYPE_TEXT']},
    {index:'description',stableKey:'description-part',recordStableKey:'region-a:description-list',recordIndex:0,regionId:'region-a',frameId:2,section:'分段经历',kind:'textarea',label:'工作职责',value:'合成职责',operations:['TYPE_TEXT']},
    {index:'next',stableKey:'next-part',recordStableKey:'region-a:company-list:record:1',recordIndex:1,regionId:'region-a',frameId:2,section:'分段经历',kind:'input',label:'公司名称',value:'另一合成公司',operations:['TYPE_TEXT']}
  ];
  const surfaces=recordSurfaces(parts,{regionId:'region-a'});
  assert.equal(surfaces.length,2,'同一经历在独立 DOM 容器中的字段按分区和记录序号合并');
  assert.deepEqual(surfaces[0].controls.map(control=>control.index),['name','dates','description']);
  assert.notEqual(surfaces[0].key,surfaces[1].key,'相邻经历保持独立身份');
  assert.equal(recordSurfaces(parts.slice(0,3)).length,3,'未启用区域记录归并时，各自 DOM 容器身份保持原状');
}
console.log('Physical hierarchy: DOM ownership, duplicate titles, date-first records, frame identity and complete local JSON');

// 一条经历可以用多个布局组展示，主信息与描述共同拥有同一个记录身份。
{
  const row=(label,tag='input')=>`<div><label>${label}</label><${tag}></${tag}></div>`;
  const record=()=>`<article><div class="ux-standard-form"><div class="form">
    <div class="form-part">${row('公司名称')}${row('职位名称')}${row('开始时间')}</div>
    <div class="form-part">${row('工作职责','textarea')}</div></div></div></article>`;
  const dom=new JSDOM(`<section><h2>组合经历</h2>${record()}<button>添加记录</button></section>`,
    {url:'https://unseen.example/form',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom;let handler;
  window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:210,bottom:40,width:200,height:30});
  window.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage(){}}};
  for(const file of ['widget-drivers.js','platform-drivers.js','content.js'])
    window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
  const read=()=>new Promise(resolve=>handler({type:'SNAPSHOT_FULL'},{},resolve));
  let snap=await read();
  assert.equal(recordSurfaces(snap.elements).length,1,'单条经历的布局分组共同进入当前 JSON 记录');
  window.document.querySelector('section').insertAdjacentHTML('beforeend',record());
  snap=await read();
  const surfaces=recordSurfaces(snap.elements);
  assert.equal(surfaces.length,2);
  assert.ok(surfaces.every(surface=>['公司名称','职位名称','开始时间','工作职责']
    .every(label=>surface.controls.some(control=>control.label===label))),'每条经历都有完整主信息和描述');
  dom.window.close();
}

const originalFetch=globalThis.fetch;
const requests=[],clicks=[],transactions=[];
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);requests.push(body);
  if(body.questions.match) return {ok:true,json:async()=>({answers:{match:{type:'noul',noul:1},unrelated:{type:'noul',noul:0}}})};
  const entries=Object.entries(body.questions.action.criteria);
  const selected=['WORK_SECTION','OPEN_EDITOR','SELECT_DATA_BLOCK','FILL_FACTS']
    .map(operation=>entries.find(([,action])=>action.operation===operation)).find(Boolean) || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:selected[0],confidence:1}}})};
};
try {
  const title='同名合成区';let expanded=false;
  const entry=(key,id)=>({index:key,stableKey:key,regionId:id,section:title,label:'编辑',kind:'action',operations:['CLICK']});
  const field=(key,id)=>({index:key,stableKey:key,regionId:id,section:title,label:'姓名',kind:'input',value:'',operations:['TYPE_TEXT']});
  const fields=[field('name-a','module-a'),field('name-b','module-b')];
  const result=await runGoalScheduler({tabId:1,resume:{education:[{institution:'合成学校',customFact:longText}]},
    apiKey:'synthetic',goal:'合成验收',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
    snapshot:async()=>({page:{documentId:'synthetic',text:'合成页面'},
      elements:[...(expanded?[fields[0]]:[]),entry('first-entry','module-a'),entry('second-entry','module-a'),fields[1]]}),
    closeTransactions:async()=>({ok:true}),
    executeClick:async(_tab,_frame,key)=>{clicks.push(key);if(key==='second-entry') expanded=true;return {ok:true};},
    transaction:async({scopeRegionId,recordControlKeys})=>{
      transactions.push(scopeRegionId);
      assert.equal(recordControlKeys.length,1,'当前同名模块只暴露自己的一条字段');
      fields.find(field=>field.regionId===scopeRegionId).value='合成姓名';return {ok:true,history:[]};
    }});
  assert.deepEqual(clicks,['first-entry','second-entry'],'无变化的入口退出候选，继续本模块其他入口');
  assert.deepEqual(transactions,['module-a','module-b']);
  assert.equal(result.sections.length,2);assert.ok(result.sections.every(section=>section.closed));
  assert.equal(result.pendingIssues.length,0);
  assert.ok(requests.some(body=>body.state.goal_context?.phase==='record-scope' &&
    body.state.section_context.json_fields[0].customFact===longText),'选择记录策略时完整资料块进入上下文一次');
  const regionMenus=requests.filter(body=>body.state.goal_context?.phase==='region-menu');
  assert.ok(requests.filter(body=>body.state.goal_context?.phase==='block-menu').every(body=>
    Object.values(body.questions.action.criteria).every(action=>!Object.hasOwn(action,'section_title_hint'))),
    '语义路由候选保留真实目录，未观察到的匹配结论保持省略');
  assert.equal(Object.keys(regionMenus[1].questions.action.criteria).length,1,'处理后的节点从外层候选移除');
  const blocked=await runGoalScheduler({tabId:1,resume:{basics:{name:'合成姓名'}},apiKey:'synthetic',
    goal:'合成失败验收',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
    snapshot:async()=>({page:{text:'合成页面'},elements:[entry('blocked','blocked-module')]}),
    closeTransactions:async()=>({ok:true}),executeClick:async()=>({ok:true}),
    transaction:async()=>assert.fail('打开失败时字段事务保持未启动')});
  assert.equal(blocked.sections[0].status,'blocked');
  assert.ok(blocked.pendingIssues.some(issue=>issue.field==='编辑入口'));

  let added=false,addClicks=0;
  const records=[{name:'已有合成项目'},{name:'缺少的合成项目'}];
  const projectControls=records.map((record,index)=>({index:`project-${index}`,stableKey:`project-${index}`,
    regionId:'projects-module',recordStableKey:`project-row-${index}`,recordIndex:index,
    section:'合成项目档案',kind:'input',label:'项目名称',value:index ? '' : record.name,operations:['TYPE_TEXT']}));
  const inventoryResult=await runGoalScheduler({tabId:1,resume:{projects:records},apiKey:'synthetic',
    goal:'补齐缺少的经历',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
    snapshot:async()=>({page:{documentId:'synthetic',text:'合成项目档案'},elements:[
      projectControls[0],...(added?[projectControls[1]]:[]),
      {index:'add-project',stableKey:'add-project',regionId:'projects-module',section:'合成项目档案',
        kind:'action',label:'添加项目记录',operations:['CLICK']}]}),
    closeTransactions:async()=>({ok:true}),
    executeClick:async(_tab,_frame,key)=>{assert.equal(key,'add-project');added=true;addClicks++;return {ok:true};},
    transaction:async({initialRecordIndex,recordControlKeys})=>{
      assert.deepEqual(recordControlKeys,[`project-${initialRecordIndex}`]);
      projectControls[initialRecordIndex].value=records[initialRecordIndex].name;return {ok:true,history:[]};
    }});
  assert.equal(addClicks,1,'已有完整记录保留，缺少的来源只新增一次');
  assert.equal(projectControls[1].value,records[1].name);
  assert.equal(inventoryResult.goalSummary.records,2);
  assert.equal(inventoryResult.pendingIssues.length,0);

  let openedFresh=false;const freshRecords=[{name:'当前项目'},{name:'新增项目',startDate:'2025-01'}];
  const freshBase={index:'fresh-name',stableKey:'fresh-name',regionId:'fresh-projects',
    recordStableKey:'fresh-name-part',recordIndex:1,section:'新建项目经历',kind:'input',label:'项目名称',value:'',operations:['TYPE_TEXT']};
  const freshDate={index:'fresh-date',stableKey:'fresh-date',regionId:'fresh-projects',
    recordStableKey:'fresh-date-part',recordIndex:1,section:'新建项目经历',kind:'input',label:'开始时间',value:'2025-01',operations:['TYPE_TEXT']};
  const bindingRequestCount=requests.filter(body=>body.state?.goal_context?.phase==='record-binding').length;
  let freshTransactions=0;
  const freshResult=await runGoalScheduler({tabId:1,resume:{projects:freshRecords},apiKey:'synthetic',
    goal:'填写新增项目',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
    snapshot:async()=>({page:{documentId:'fresh-record-test',text:'新建项目经历'},elements:[
      {index:'existing-name',stableKey:'existing-name',regionId:'fresh-projects',recordStableKey:'existing-row',
        recordIndex:0,section:'新建项目经历',kind:'input',label:'项目名称',value:'当前项目',operations:['TYPE_TEXT']},
      ...(openedFresh?[freshBase,freshDate]:[]),
      {index:'fresh-add',stableKey:'fresh-add',regionId:'fresh-projects',section:'新建项目经历',kind:'action',
        label:'添加项目记录',operations:['CLICK']}]}),
    closeTransactions:async()=>({ok:true}),
    executeClick:async()=>{openedFresh=true;return {ok:true};},
    transaction:async({initialRecordIndex,recordControlKeys})=>{
      freshTransactions++;
      assert.equal(initialRecordIndex,1,'新增表面沿用已选定的来源记录');
      assert.deepEqual(recordControlKeys,['fresh-name','fresh-date'],'新增记录事务纳入同序号日期字段');
      return {ok:true,history:[]};
    }});
  assert.equal(freshTransactions,1,'新纪录沿用已选来源进入字段事务');
  assert.equal(requests.filter(body=>body.state?.goal_context?.phase==='record-binding').length,bindingRequestCount,
    '新增空行的默认日期值不会触发二次记录猜测');
} finally {globalThis.fetch=originalFetch;}
console.log('Physical scheduler: separate same-title modules, bounded entry alternatives and complete block context');
