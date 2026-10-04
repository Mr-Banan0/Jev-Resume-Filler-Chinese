import assert from 'node:assert/strict';
let listener,resolveDone,revision=0,calls=0,phone='';
const completion=new Promise(resolve=>resolveDone=resolve);
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
console.log=()=>{};
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body),entries=Object.entries(body.questions.action.criteria);
  const ctx=body.state.section_context;
  assert.ok(++calls<40,'返回与低置信选择保持有限尝试');
  let chosen,confidence=1;
  if(entries.some(([,action])=>Object.hasOwn(action,'block'))) {
    chosen=entries.find(([,action])=>action.block===(ctx.section==='联系资料' && phone ? null : 'basics')) ||
      entries.find(([,action])=>action.block===null);
  } else if(entries.some(([,action])=>action.source_meaning !== undefined)) {
    if(ctx.section==='返回测试') chosen=entries.find(([,action])=>action.target==='section:return');
    else {
      chosen=entries.find(([,action])=>action.resume_field===(ctx.section==='联系资料'?'basics.phone':'basics.name'));
      if(ctx.section==='置信测试') confidence=0.5;
    }
  } else chosen=entries.find(([,action])=>action.operation!=='RETURN') || entries[0];
  assert.ok(chosen);
  return {ok:true,json:async()=>({answers:{action:{choice:chosen[0],confidence}}})};
};
globalThis.chrome={runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
  sendMessage:msg=>{if(msg.type==='FILL_DONE') resolveDone(msg);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'简历',url:'https://example.test/exits'}],sendMessage(_id,msg,_opts,reply){
    if(['PING','CLOSE_TRANSACTIONS'].includes(msg.type)) return reply({ok:true});
    if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
    if(msg.type==='SNAPSHOT_FULL') return reply({ok:true,fingerprint:String(revision),
      page:{title:'简历',url:'https://example.test/exits',text:'返回测试 置信测试 联系资料'},elements:[
        {index:'1',stableKey:'return',section:'返回测试',label:'自定义姓名',kind:'input',value:'',operations:['TYPE_TEXT']},
        {index:'2',stableKey:'uncertain',section:'置信测试',label:'自定义姓名',kind:'input',required:true,value:'',operations:['TYPE_TEXT']},
        {index:'3',stableKey:'phone',section:'联系资料',label:'手机',kind:'input',value:phone,operations:['TYPE_TEXT']}
      ].map((el,domOrder)=>({...el,domOrder}))});
    if(msg.type==='EXECUTE') {
      assert.equal(msg.index,'3','返回与低置信的控件保持原值');
      phone=msg.value;revision++;
      return reply({ok:true,value:phone});
    }
    throw new Error(msg.type);
  }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}}};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic',resume:{basics:{name:'示例姓名',phone:'12345678900'}}},{},()=>{});
  const result=await completion;
  assert.equal(phone,'12345678900','离开局部失败后继续其他分区');
  assert.equal(result.done,true);
  assert.equal(result.ok,false,'待核对项目保留在最终报告');
  assert.ok(result.pendingIssues.some(issue=>/置信不足/.test(issue.reason)));
  assert.ok(result.pendingIssues.some(issue=>/返回/.test(issue.reason)));
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;console.log=original.log;}
console.log('Local return and uncertain bindings keep fields untouched, report gaps and continue other sections');
