import assert from 'node:assert/strict';
let listener, email='', revision=1, complete, clicks=0;
const completion=new Promise(resolve=>complete=resolve);
const timer=globalThis.setTimeout, log=console.log;
globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0;};
console.log=()=>{};
globalThis.fetch=async(_url,args)=>({ok:true,json:async()=>({answers:{action:{choice:Object.keys(JSON.parse(args.body).questions.action.criteria)[0],confidence:1}}})});
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:m=>{if(m.type==='FILL_DONE') complete(m);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'个人信息',url:'https://example.test/form'}],sendMessage(_id,m,_opts,reply){
    if(m.type==='PING'||m.type==='CLOSE_TRANSACTIONS') return reply({ok:true});
    if(m.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
    if(m.type==='SNAPSHOT_FULL') return reply({ok:true,fingerprint:String(revision),page:{title:'个人信息',url:'https://example.test/form',text:'个人信息'},elements:[
      {index:'1',kind:'date',label:'出生日期',value:'',operations:['CLICK']},
      {index:'2',kind:'input',label:'邮箱',value:email,operations:['TYPE_TEXT']}
    ]});
    if(m.type==='EXECUTE') {
      if(m.action==='type_text'){email=m.value;revision++;} else clicks++;
      return reply({ok:true});
    }
    throw new Error(m.type);
  }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic-key',resume:{basics:{birthDate:'2001-02-10',email:'test@example.com'}}},{},()=>{});
  const result=await completion;
  assert.equal(email,'test@example.com',JSON.stringify(result));
  assert.ok(clicks<=4,'字段重试有界');
  assert.ok(result.pendingIssues?.length,'失败字段保留待补证据');
} finally {globalThis.setTimeout=timer;console.log=log;}
console.log('Field failure is isolated; remaining input filled and pending issue retained');
