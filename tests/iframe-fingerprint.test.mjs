import assert from 'node:assert/strict';

let listener,resolveDone;
const done=new Promise(resolve=>resolveDone=resolve);
const values={姓名:'',电子邮箱:'',手机号码:''};
const labels=Object.keys(values);
const realTimeout=globalThis.setTimeout;
const realLog=console.log;
globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0;};
console.log=()=>{};
globalThis.fetch=async()=>({ok:true,json:async()=>({answers:{action:{choice:'a1',confidence:1}}})});
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:message=>{if(message.type==='FILL_DONE') resolveDone(message);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'校园招聘',url:'https://example.test/resume/index.html'}],
    sendMessage(_id,msg,opts,reply){
      const frameId=opts.frameId;
      if(msg.type==='PING') return reply({ok:true});
      const fingerprint=frameId===0?'outer-static':JSON.stringify(values);
      if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint});
      if(msg.type==='SNAPSHOT_FULL') return reply({ok:true,fingerprint,
        elements:frameId===0?[]:labels.map((label,i)=>({index:String(i+1),domOrder:i,
          kind:'input',label,value:values[label],operations:['TYPE_TEXT']})),
        page:frameId===0?{title:'校园招聘',url:'https://example.test/resume/index.html',text:'我的简历'}:
          {title:'个人信息',url:'https://example.test/resume/base_info.html',text:'个人信息'}});
      if(msg.type==='EXECUTE') {
        assert.equal(frameId,80,'填写动作必须路由到表单 iframe');
        values[labels[Number(msg.index)-1]]=msg.value;
        return reply({ok:true,value:msg.value});
      }
      throw new Error(`unexpected ${msg.type}`);
    }},
  scripting:{executeScript:async()=>[{frameId:0},{frameId:80}]},
  storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'test-key',resume:{basics:{name:'测试姓名',email:'test@example.test',phone:'12345678900'}}},
    {},()=>{});
  const result=await done;
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.history.filter(item=>item.kind==='type_text').length,3);
  assert.ok(result.history.filter(item=>item.kind==='type_text').every(item=>item.page_changed===true));
  assert.deepEqual(values,{姓名:'测试姓名',电子邮箱:'test@example.test',手机号码:'12345678900'});
} finally {
  globalThis.setTimeout=realTimeout;
  console.log=realLog;
}
console.log('✓ 外层静止时 iframe 表单字段变化仍被识别，连续填写不中断');
