import assert from 'node:assert/strict';
const resume={education:[{institution:'示例大学 A',researchFocus:'城市计算'},
  {institution:'示例大学 B',researchFocus:'空间分析'}]};
const routed=process.argv.includes('--route');
let listener,phase='summary',values={},revision=0,resolveDone,adds=0;
const saved=[];
const completion=new Promise(resolve=>resolveDone=resolve);
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
console.log=()=>{};
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body),entries=Object.entries(body.questions.action.criteria);
  const ctx=body.state.section_context;
  let chosen;
  if(entries.some(([,action])=>Object.hasOwn(action,'block'))) {
    chosen=entries.find(([,action])=>action.block===(saved.length===2?null:'education'));
  } else if(entries.some(([,action])=>action.source_meaning !== undefined)) {
    const field=entries[0][1].page_label==='学校名称' ? 'institution' : 'researchFocus';
    chosen=entries.find(([,action])=>action.resume_field===`education[${ctx.record_index}].${field}`);
  } else chosen=entries.find(([,action])=>action.operation!=='RETURN') || entries[0];
  assert.ok(chosen);
  return {ok:true,json:async()=>({answers:{action:{choice:chosen[0],confidence:1}}})};
};
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
  sendMessage:msg=>{if(msg.type==='FILL_DONE') resolveDone(msg);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'学业资料',url:'https://example.test/editor'}],sendMessage(_id,msg,_opts,reply){
    if(['PING','CLOSE_TRANSACTIONS'].includes(msg.type)) return reply({ok:true});
    if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
    if(msg.type==='SNAPSHOT_FULL') {
      const section='学业资料';
      const elements=phase==='summary' ? [{index:'add',section,label:'添加教育经历',kind:'card',operations:['CLICK']}] : [
        {index:'school',stableKey:'school',section,recordIndex:0,label:'学校名称',kind:'input',value:values.school || '',operations:['TYPE_TEXT']},
        {index:'focus',stableKey:'focus',section,recordIndex:0,label:'学术主题摘要',kind:'input',value:values.focus || '',operations:['TYPE_TEXT']},
        {index:'save',section,label:'保存',kind:'action',operations:['CLICK']},
        {index:'cancel',section,label:'取消',kind:'action',operations:['CLICK']}
      ];
      return reply({ok:true,elements:elements.map((el,domOrder)=>({...el,domOrder})),fingerprint:String(revision),
        page:{title:section,activeSection:section,editorSurface:phase==='form',
          url:routed && phase==='form' ? `https://example.test/editor/record/${saved.length}` : 'https://example.test/editor',
          text:section+' '+saved.map(record=>record.school).join(' ')}});
    }
    if(msg.type==='EXECUTE') {
      if(msg.index==='add'){phase='form';values={};adds++;assert.ok(adds<=2);}
      else if(msg.index==='save'){saved.push({...values});phase='summary';}
      else if(msg.index==='cancel') phase='summary';
      else values[msg.index]=msg.value;
      revision++;
      return reply({ok:true,value:msg.value});
    }
    throw new Error(msg.type);
  }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic',resume},{},()=>{});
  const result=await completion;
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(saved,resume.education.map(record=>({school:record.institution,focus:record.researchFocus})),
    '编辑器每次 DOM recordIndex=0，仍绑定本地当前记录');
  assert.equal(adds,2);
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;console.log=original.log;}
console.log(`${routed?'Routed':'Repeated'} editors retain logical source indices and independent semantic field bindings`);
