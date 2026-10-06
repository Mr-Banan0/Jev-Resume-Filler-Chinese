import assert from 'node:assert/strict';

const resume={education:[{studyType:'本科',studyMode:'全日制'}]};
let opened=false,value='',listener,resolveDone,inspections=0,revision=0;
const completion=new Promise(resolve=>resolveDone=resolve);
const originals={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
console.log=()=>{};
const requests=[];
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);requests.push(body);
  assert.ok(requests.length<30,'选择器观察与返回保持有界');
  const entries=Object.entries(body.questions.action.criteria);
  let chosen,confidence=1;
  if(entries.some(([,action])=>Object.hasOwn(action,'block'))) {
    chosen=entries.find(([,action])=>action.block==='education');
    confidence=0.35;
  } else if(entries.some(([,action])=>action.source_meaning !== undefined)) {
    chosen=entries.find(([,action])=>action.resume_field==='education[0].studyMode');
    confidence=opened ? 1 : 0.4;
    if(opened) assert.ok(body.state.section_context.controls.some(control=>control.label==='统招全日制'));
  } else chosen=entries.find(([,action])=>action.operation!=='RETURN') || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:chosen[0],confidence}}})};
};
function elements(){
  const fields=opened ? [] : [{index:'mode',stableKey:'mode',label:'学历类型',section:'教育经历',recordIndex:0,
    kind:'custom-select',value,operations:['CLICK'],required:true}];
  if(opened) fields.push(...['统招全日制','统招非全日制'].map((label,i)=>({
    index:`option-${i}`,label,section:'教育经历',context:'popup',kind:'option-item',operations:['CLICK']})));
  return fields.map((field,domOrder)=>({...field,domOrder}));
}
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},
  onInstalled:{addListener(){}},sendMessage:msg=>{if(msg.type==='FILL_DONE')resolveDone(msg);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'简历编辑',url:'https://example.test/form'}],
    sendMessage(_id,msg,_opts,reply){
      if(msg.type==='PING') return reply({ok:true,version:'2026-10-07.57'});
      if(msg.type==='FINGERPRINT')return reply({ok:true,fingerprint:String(revision)});
      if(msg.type==='CLOSE_TRANSACTIONS'){opened=false;return reply({ok:true});}
      if(msg.type==='SNAPSHOT_FULL')return reply({ok:true,elements:elements(),fingerprint:String(revision),
        page:{title:'简历编辑',url:'https://example.test/form',text:'教育经历'}});
      if(msg.type==='EXECUTE'){
        if(msg.index==='mode'){assert.equal(opened,false,'观察后直接选值，避免重新开关面板');opened=true;inspections++;}
        else {assert.equal(msg.index,'option-0');value='统招全日制';opened=false;}
        revision++;return reply({ok:true});
      }
      throw new Error(`unexpected ${msg.type}`);
    }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',runtimeVersion:'2026-10-07.57',apiKey:'synthetic',resume},{},()=>{});
  const result=await completion;
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(value,'统招全日制');assert.equal(inspections,1);
} finally {
  globalThis.fetch=originals.fetch;globalThis.setTimeout=originals.setTimeout;console.log=originals.log;
}
console.log('An uncertain field binding observes real options once, binds, selects and verifies.');
