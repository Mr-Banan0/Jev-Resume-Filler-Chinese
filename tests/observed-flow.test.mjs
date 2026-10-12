// 真正加载 content.js 与调度器；默认仅替换 Jev，--live 使用付费真实判断。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {CONTENT_SCRIPT_VERSION} from '../lib/content-version.js';

const live=process.argv.includes('--live');
const apiProvider=process.argv.includes('--quickrouter') ? 'quickrouter' : 'typesafe';
const adapted=process.argv.includes('--adapted');
const closeFailure=process.argv.includes('--close-failure');
const fail=process.argv.includes('--failure') || closeFailure;
let apiKey='synthetic';
if(live) {
  apiKey=process.env[apiProvider==='quickrouter'?'QUICKROUTER_API_KEY':'TYPESAFE_API_KEY'];
  if(!apiKey && apiProvider==='typesafe') try {apiKey=readFileSync(join(homedir(),'.config/typesafe/api_key'),'utf8').trim();} catch {}
  assert.ok(apiKey,'配置所选 API 服务的环境变量 Key 后运行真实判断评测');
}
const resume={basics:{name:'已有测试姓名'},education:[
  {institution:'合成大学甲',studyMode:'全日制',endDate:'2026-11-30',researchFocus:'城市计算'},
  {institution:'合成大学乙',studyMode:'全日制',endDate:'2025-06-30',researchFocus:'空间分析'}
],languages:[{certificate:'IELTS',score:'6.5'}],projects:[{name:'外部分区隔离标记'}]};
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,log:console.log,warn:console.warn};
const dom=new JSDOM(readFileSync(new URL('./fixture/observed-form.html',import.meta.url),'utf8'),
  {runScripts:'dangerously',pretendToBeVisual:true,url:'https://unseen.example.test/resume'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
const contentListeners=[],requests=[],progress=[],executions=[];
window.chrome={runtime:{onMessage:{addListener:fn=>contentListeners.push(fn)},sendMessage:(_msg,cb)=>cb?.()}};
for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) {
  window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
}
if(!live) globalThis.setTimeout=(fn,ms,...args)=>ms<6000 ?
  (queueMicrotask(()=>fn(...args)),0) : original.setTimeout(fn,ms,...args);
console.log=()=>{};console.warn=()=>{};
function syntheticChoice(body) {
  const entries=Object.entries(body.questions.action.criteria),interaction=body.state.interaction;
  if(interaction) {
    if(interaction.phase==='focus') return entries.find(([,a])=>a.operation==='FOCUS_FIELD') || entries[0];
    if(interaction.phase==='bind') {
      const label=interaction.active_field;
      const field=/学校/.test(label) ? 'institution' : /方式/.test(label) ? 'studyMode' :
        /结束/.test(label) ? 'endDate' : /主题/.test(label) ? 'researchFocus' : /证书/.test(label) ? 'certificate' : 'score';
      return entries.find(([,a])=>a.operation==='BIND_FIELD' && a.source_field?.endsWith(`.${field}`));
    }
    const desired=String(interaction.desired_value);
    const options=entries.filter(([,a])=>['CLICK','SELECT'].includes(a.operation) &&
      body.state.section_context.controls.some(control=>control.target===a.target && control.context==='popup'));
    if(options.length) {
      const labels=options.map(([,a])=>a.label);
      const wanted=labels.some(label=>/年$/.test(label)) ? `${Number(desired.slice(0,4))}年` :
        labels.some(label=>/月$/.test(label)) ? `${Number(desired.slice(5,7))}月` :
        labels.some(label=>/日$/.test(label)) ? `${Number(desired.slice(8,10))}日` :
        desired==='全日制' ? 'Full-time' : 'IELTS（雅思）';
      return options.find(([,a])=>a.label===wanted);
    }
    return entries.find(([,a])=>a.operation==='TYPE_TEXT') || entries.find(([,a])=>a.operation==='CLICK') || entries[0];
  }
  const context=body.state.section_context;
  if(entries.some(([,a])=>Object.hasOwn(a,'block'))) {
    const block=context.section==='教育经历' ? 'education' : context.section==='语言能力' ? 'languages' : 'basics';
    return entries.find(([,a])=>a.block===block) || entries.find(([,a])=>a.block===null);
  }
  if(entries.some(([,a])=>a.source_meaning!==undefined)) {
    const label=entries[0][1].page_label;
    const field=/方式/.test(label) ? 'studyMode' : /主题/.test(label) ? 'researchFocus' : /证书/.test(label) ? 'certificate' : 'score';
    return entries.find(([,a])=>a.resume_field?.endsWith(`.${field}`)) || entries.at(-1);
  }
  return entries.find(([,a])=>a.operation!=='RETURN') || entries[0];
}
globalThis.fetch=async(url,args)=>{
  const body=JSON.parse(args.body);requests.push(body);
  assert.equal(url,apiProvider==='quickrouter'?'https://api.quickrouter.ai/v1/systemone':'https://api.typesafe.ai/v1/systemone');
  assert.equal(body.model,apiProvider==='quickrouter'?'jev-1.13.0':'jev-latest','每层决策保持同一服务配置');
  assert.ok(requests.length<=120,'决策次数有界');
  if(body.state.interaction) {
    assert.ok(!JSON.stringify(body).includes('PRIVATE_BYTES'));
    assert.ok(!JSON.stringify(body).includes('外部分区隔离标记'));
    const context=body.state.section_context;
    assert.ok(context.controls.every(c=>c.context==='popup' ||
      !['机构项目标题','外部分区隔离标记'].includes(c.label)),'局部上下文保留分区边界');
  }
  if(live) return original.fetch(url,args);
  const choice=syntheticChoice(body);
  assert.ok(choice,JSON.stringify(body.questions.action.criteria));
  return {ok:true,json:async()=>({model:'synthetic',answers:{action:{choice:choice[0],confidence:1}}})};
};
let listener,resolveDone;
const completion=new Promise(resolve=>resolveDone=resolve);
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
  sendMessage:msg=>{progress.push(msg);if(msg.type==='FILL_DONE')resolveDone(msg);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'合成简历表单',url:'https://unseen.example.test/resume'}],
    sendMessage(_tab,msg,_opts,reply){
      if(closeFailure && msg.type==='CLOSE_TRANSACTIONS') return reply({ok:false,reason:'合成关闭失败'});
      if(closeFailure && msg.type==='TRANSACTION_STATE') return reply({ok:true,open:true});
      if(msg.type==='EXECUTE') {
        executions.push(msg);
        if(fail && msg.action==='click' && window.document.querySelector('[role=listbox]')) return reply({ok:false,reason:'合成选项执行失败'});
      }
      contentListeners[0](msg,{},reply);
    }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{get:async()=>({}),set:async()=>{}}}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',runtimeVersion:CONTENT_SCRIPT_VERSION,apiKey,apiProvider,resume,
    ...(adapted ? {interactionPolicy:'adapted'} : {})},{},()=>{});
  const timeout=original.setTimeout(()=>resolveDone({ok:false,reason:'测试达到 180 秒预算'}),180000);
  const result=await completion;original.clearTimeout(timeout);
  assert.equal(progress.find(item=>item.phase==='start')?.interactionPolicy,adapted ? 'adapted' : 'observed',
    '省略策略时使用通用观察；显式对照策略仍可选择');
  assert.equal(progress.find(item=>item.phase==='start')?.apiProvider,apiProvider);
  const rows=[...window.document.querySelectorAll('#education .experience-item')];
  const actual=rows.map((_,i)=>({institution:window.document.getElementById(`school-${i}`).value,
    studyMode:window.document.getElementById(`mode-${i}`).textContent,
    endDate:window.document.getElementById(`date-${i}`).value,researchFocus:window.document.getElementById(`focus-${i}`).value}));
  const expected=resume.education.map(record=>({...record,studyMode:'Full-time'}));
  let correct=0;
  for(const [i,row] of expected.entries()) for(const [field,value] of Object.entries(row)) if(actual[i]?.[field]===value) correct++;
  if(window.document.getElementById('certificate').textContent==='IELTS（雅思）')correct++;
  if(window.document.getElementById('score').value==='6.5')correct++;
  assert.equal(window.document.getElementById('existing').value,'已有测试姓名');
  assert.equal(window.document.getElementById('referral').value,'KEEP-TEST-CODE');
  assert.ok(!window.testTrace.some(item=>item.submitted));
  if(!adapted && !fail) {
    assert.equal(result.ok,true,JSON.stringify({result,last:progress.slice(-8),actual}));
    assert.equal(correct,10,JSON.stringify({actual,choices:progress.filter(item=>item.phase==='decided').map(({operation,target,resumeField,confidence})=>({operation,target,resumeField,confidence}))}));
    assert.equal(rows.length,2,'两条记录只新增一次');
    assert.equal(window.testTrace.filter(item=>item.added).length,1);
    assert.ok(window.testTrace.some(item=>item.option==='30日'),'网站自动日期默认值仍继续补齐');
  }
  if(fail) {
    assert.equal(result.ok,false,'执行失败不能报告填写完成');
    assert.ok(requests.length<120,'失败字段退出后其他字段仍有机会执行');
    if(!closeFailure) assert.ok(window.document.getElementById('focus-0').value,JSON.stringify({message:'失败隔离后继续填写其他字段',result,
      decisions:progress.filter(item=>['decided','failed','blocked','section'].includes(item.phase)).slice(-24)}));
    if(closeFailure) assert.ok(progress.filter(item=>item.phase==='decided' && item.operation==='RETURN').length<8,
      '关闭持续失败时记录待核对并有限退出');
  }
  original.log(JSON.stringify({policy:adapted ? 'adapted' : 'observed',apiProvider,model:live ? 'real-jev' : 'synthetic',
    failureCase:fail,correct,total:10,requests:requests.length,executions:executions.length,
    submitted:false,ok:result.ok,reason:result.reason || '',pending:result.pendingIssues?.length || 0}));
} finally {
  globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;console.log=original.log;console.warn=original.warn;dom.window.close();
}
