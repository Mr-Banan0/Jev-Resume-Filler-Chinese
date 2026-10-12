import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {CONTENT_SCRIPT_VERSION} from '../lib/content-version.js';

const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
const dom=new JSDOM('<section><h3>求职意向</h3><dl><dt>期望薪酬</dt><dd><input id="salary" oninput="this.value=this.value.replace(/\\D/g,\'\')"></dd></dl></section>',
  {url:'https://synthetic.example/resume',runScripts:'dangerously',pretendToBeVisual:true});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
const content=[];
window.chrome={runtime:{onMessage:{addListener:fn=>content.push(fn)},sendMessage:(_m,cb)=>cb?.()}};
for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
let listener,finish,writes=0;
const completion=new Promise(resolve=>finish=resolve);
const events=[];
globalThis.setTimeout=(fn,ms,...args)=>ms<6000 ? (queueMicrotask(()=>fn(...args)),0) : original.setTimeout(fn,ms,...args);
globalThis.fetch=async(_url,args)=>{
  const entries=Object.entries(JSON.parse(args.body).questions.action.criteria);
  const choice=entries.find(([,a])=>a.operation==='WORK_SECTION') ||
    entries.find(([,a])=>a.block==='expected') || entries.find(([,a])=>a.operation==='FOCUS_FIELD') ||
    entries.find(([,a])=>a.operation==='BIND_FIELD') || entries.find(([,a])=>a.operation==='TYPE_TEXT') || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:choice[0],confidence:1}}})};
};
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
  sendMessage:message=>{events.push(message);if(message.type==='FILL_DONE')finish(message);},lastError:null},
  tabs:{query:async()=>[{id:1,url:'https://synthetic.example/resume',title:'合成表单'}],sendMessage(_tab,message,_options,reply){
    if(message.type==='EXECUTE' && message.action==='type_text') writes++;
    content[0](message,{},reply);
  }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{get:async()=>({}),set:async()=>{}}}};
console.log=()=>{};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',runtimeVersion:CONTENT_SCRIPT_VERSION,apiKey:'synthetic',
    resume:{expected:{salary:'1.8-2.5万元/月'}}},{},()=>{});
  const timeout=original.setTimeout(()=>finish({reason:'timeout'}),15000);
  const result=await completion;clearTimeout(timeout);
  assert.equal(window.document.getElementById('salary').value,'','被网站过滤的错误数值恢复到输入前状态');
  assert.equal(writes,2,'一次输入失败后执行一次回退，当前字段退出重试');
  assert.ok(events.some(event=>event.phase==='rollback'));
  assert.ok(result.pendingIssues.some(issue=>issue.status==='blocked' && /回读/.test(issue.reason)),
    '失败值曾经非空也须保留来源回读失败证据');
} finally {Object.assign(globalThis,{fetch:original.fetch,setTimeout:original.setTimeout});console.log=original.log;dom.window.close();}
console.log('Observed write failures roll back filtered values and retain a blocked audit result');
