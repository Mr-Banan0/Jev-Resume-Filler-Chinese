import assert from 'node:assert/strict';
import {CONTENT_SCRIPT_VERSION} from '../lib/content-version.js';

const resume={basics:{name:'合成姓名'},education:[
  {institution:'合成大学',startDate:'2021-09-01',endDate:'2025-06-30'},
  {institution:'合成大学',startDate:'2025-09-01',endDate:'2026-11-30'}]};
let listener,resolveDone,current='个人信息',editor=false,revision=0,values={};
const done=new Promise(resolve=>resolveDone=resolve);
const saved={'个人信息':[],'教育经历':[]},visited=[],executions=[];
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
console.log=()=>{};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body),entries=Object.entries(body.questions.action.criteria);
  const ctx=body.state.section_context;
  const block=current==='个人信息'?'basics':'education';
  const choice=entries.some(([,action])=>Object.hasOwn(action,'block')) ?
    entries.find(([,action])=>action.block===block) || entries.find(([,action])=>action.block===null) :
    entries.find(([,action])=>action.operation!=='RETURN') || entries[0];
  assert.ok(choice,JSON.stringify(ctx));
  return {ok:true,json:async()=>({answers:{action:{choice:choice[0],confidence:1}}})};
};
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
  lastError:null,sendMessage:msg=>{if(msg.type==='FILL_DONE') resolveDone(msg);}},
  storage:{session:{set:async()=>{}}},scripting:{executeScript:async()=>editor?[{frameId:0},{frameId:80}]:[{frameId:0}]},
  tabs:{query:async()=>[{id:1,url:'https://iter.stongyw.cn/web/school/resume/index.html'}],sendMessage(_tab,msg,{frameId},reply){
    if(msg.type==='PING') return reply({ok:true,version:CONTENT_SCRIPT_VERSION});
    if(msg.type==='CLOSE_TRANSACTIONS') return reply({ok:true});
    if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
    if(msg.type==='SNAPSHOT_FULL') {
      const elements=frameId===80 ? (editor ? current==='个人信息' ?
        [{index:'name',kind:'input',label:'姓名',value:values.name || '',operations:['TYPE_TEXT']}] :
        [{index:'school',kind:'input',label:'学校名称',value:values.school || '',operations:['TYPE_TEXT']},
          {index:'start',kind:'date',label:'开始时间',value:values.start || '',operations:['PICK_DATE']},
          {index:'end',kind:'date',label:'结束时间',value:values.end || '',operations:['PICK_DATE']}] : []) :
        ['个人信息','教育经历'].map((section,i)=>({index:`nav${i}`,kind:'section-entry',section,label:section,operations:['CLICK']}))
          .concat(editor ? [{index:'save',kind:'action',section:current,label:'确定',recordCommit:true,operations:['CLICK']},
            {index:'cancel',kind:'action',section:current,label:'取消',operations:['CLICK']}] :
            [{index:'add',kind:'card',section:current,label:'新增记录',operations:['CLICK']},
              ...saved[current].map((record,i)=>({index:`summary${i}`,section:current,kind:'record-summary',
                label:'已保存记录',summaryText:Object.values(record).join(' '),operations:[]}))]);
      return reply({ok:true,fingerprint:String(revision),elements:elements.map((el,i)=>({...el,domOrder:i})),page:{
        title:'校园招聘',url:frameId===80?'https://iter.stongyw.cn/web/school/resume/editor.html':'https://iter.stongyw.cn/web/school/resume/index.html',
        activeSection:frameId===0?current:'',editorSurface:editor,editorFrameUrls:editor?['https://iter.stongyw.cn/web/school/resume/editor.html']:[],text:current}});
    }
    if(msg.type==='EXECUTE') {
      executions.push({frameId,...msg});
      if(frameId===80) values[msg.index]=msg.value;
      else if(/^nav/.test(msg.index)){current=['个人信息','教育经历'][Number(msg.index.slice(3))];visited.push(current);}
      else if(msg.index==='add'){editor=true;values={};}
      else if(msg.index==='save'){saved[current].push({...values});editor=false;}
      else if(msg.index==='cancel') editor=false;
      revision++;
      return reply({ok:true,value:msg.value});
    }
    throw Error(`专用 RPC 不参与统一流程：${msg.type}`);
  }}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic',resume},{},()=>{});
  const result=await done;
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(saved['个人信息'],[{name:resume.basics.name}]);
  assert.deepEqual(saved['教育经历'],resume.education.map(record=>({school:record.institution,start:record.startDate,end:record.endDate})));
  assert.ok(executions.filter(item=>item.action==='type_text'||item.action==='pick_date').every(item=>item.frameId===80));
  assert.ok(executions.filter(item=>item.index==='save').every(item=>item.frameId===0));
  assert.ok(visited.includes('教育经历'));
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;console.log=original.log;}
console.log('Unified scheduler navigates a summary, fills iframe records and verifies parent-frame saves');
