import assert from 'node:assert/strict';
const stale=process.argv.includes('--stale');
let listener,resolveDone,page=0,revision=0,inputs=0,navigations=0;
const values=['',''],completion=new Promise(resolve=>resolveDone=resolve);
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
console.log=()=>{};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000)queueMicrotask(fn);return 0;};
globalThis.fetch=async(_url,args)=>({ok:true,json:async()=>({answers:{action:{choice:Object.keys(JSON.parse(args.body).questions.action.criteria)[0],confidence:1}}})});
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},lastError:null,
  sendMessage:msg=>{if(msg.type==='FILL_DONE')resolveDone(msg);}},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}},
  tabs:{query:async()=>[{id:1,url:'https://example.test/form'}],sendMessage(_tab,msg,_opts,reply){
    if(msg.type==='PING'||msg.type==='CLOSE_TRANSACTIONS')return reply({ok:true});
    if(msg.type==='FINGERPRINT')return reply({ok:true,fingerprint:String(stale?++revision:revision)});
    if(msg.type==='SNAPSHOT_FULL')return reply({ok:true,fingerprint:String(revision),page:{url:'https://example.test/form',title:'简历'},elements:[
      {index:'field',stableKey:'reused-node',label:page===0?'姓名':'手机号码',kind:'input',value:values[page],operations:['TYPE_TEXT']},
      ...(page===0?[{index:'next',label:'下一步',kind:'action',operations:['CLICK']}]:[]),
      {index:'submit',label:'提交申请',kind:'action',operations:['CLICK']}]});
    if(msg.type==='EXECUTE'){
      assert.notEqual(msg.index,'submit');
      if(msg.index==='next'){page=1;navigations++;}
      else {values[page]=msg.value;inputs++;}
      revision++;
      return reply({ok:true,value:msg.value});
    }
    throw Error(msg.type);
  }}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic',resume:{basics:{name:'合成姓名',phone:'13000000000'}}},{},()=>{});
  const result=await completion;
  if(stale){assert.equal(result.ok,false);assert.equal(inputs,0,'过期目标始终保持只读');}
  else {assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(values,['合成姓名','13000000000']);assert.equal(navigations,1);}
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;console.log=original.log;}
console.log(stale?'Continuously stale decisions stop before mutation':'The scheduler owns next-page traversal and rebinds reused nodes on the new page');
