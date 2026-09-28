import assert from 'node:assert/strict';

// 用合成 Chrome 消息验证跨条目流程；测试不访问浏览器、网站或模型服务。
let listener, phase='form', value='', revision=1, loadingReads=0;
const saved=[];
const names=['技能甲','技能乙','技能丙','技能丁','技能戊','技能己'];
let complete;
const completion=new Promise(resolve=>complete=resolve);
const realTimeout=globalThis.setTimeout;
const realLog=console.log;
console.log=()=>{};
globalThis.setTimeout=(fn)=>{queueMicrotask(fn);return 0;};
globalThis.fetch=async()=>({ok:true,json:async()=>({answers:{action:{choice:'a1',confidence:1}}})});
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:message=>{if(message.type==='FILL_DONE') complete(message);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'专业技能',url:'https://example.test/edit?isFast='}],sendMessage(_id,msg,_options,reply){
    if(msg.type==='PING') return reply({ok:true});
    if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
    if(msg.type==='SNAPSHOT_FULL') {
      const form=phase==='form';
      const elements=form ? [
        {index:'1',kind:'input',label:'技能名称',value,operations:['TYPE_TEXT']},
        {index:'2',kind:'action',label:'保存',operations:['CLICK']}
      ] : loadingReads-- > 0 ? [] : [
        {index:'3',kind:'section-entry',label:'专业技能',domOrder:1,operations:['CLICK']},
        {index:'4',kind:'section-entry',label:'论文著作',domOrder:2,operations:['CLICK']}
      ];
      return reply({ok:true,elements,fingerprint:String(revision),page:{title:form?'专业技能':'在线填写完整简历',
        url:form?'https://example.test/edit?isFast=':'https://example.test/overview',text:`专业技能 ${saved.join(' ')} 论文著作`}});
    }
    if(msg.type==='EXECUTE') {
      if(msg.action==='type_text') value=msg.value;
      else if(msg.index==='2') {saved.push(value);phase='overview';loadingReads=1;}
      else if(msg.index==='3') {phase='form';value='';}
      revision++;
      return reply({ok:true});
    }
    throw new Error(`Unexpected message ${msg.type}`);
  }},
  scripting:{executeScript:async()=>[{frameId:0}]},
  storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'synthetic-key',resume:{professionalSkills:names.map(name=>({name}))}}, {}, ()=>{});
  const result=await completion;
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.sectionSaved,true);
  assert.deepEqual(saved,names);
  assert.equal(result.history.filter(item=>item.kind==='navigate').length,5);
} finally {
  console.log=realLog;
  globalThis.setTimeout=realTimeout;
}
console.log('✓ 同 URL 六条记录连续保存、分区延迟渲染和逐条重试隔离通过');
