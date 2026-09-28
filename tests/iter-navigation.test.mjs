import assert from 'node:assert/strict';

let listener,resolveDone;
const done=new Promise(resolve=>resolveDone=resolve);
const sections=['个人信息','求职意向','教育经历'];
let current='个人信息',editorOpen=false;
let nameValue='';
const visited=[],opened=[],closed=[],saved=[];
const realTimeout=globalThis.setTimeout;
globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0;};
globalThis.fetch=async()=>({ok:true,json:async()=>({answers:{action:{choice:'a1',confidence:1}}})});
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:message=>{if(message.type==='FILL_DONE') resolveDone(message);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'校园招聘',url:'https://iter.stongyw.cn/web/school/resume/index.html'}],
    sendMessage(_id,msg,opts,reply){
      const frameId=opts.frameId;
      if(msg.type==='PING') return reply({ok:true});
      if(msg.type==='ITER_STATE') return reply({ok:true,state:{current,sections,editorOpen,editorCount:1}});
      if(msg.type==='ITER_NAVIGATE') {current=msg.section;visited.push(current);return reply({ok:true});}
      if(msg.type==='ITER_OPEN_EDITOR') {editorOpen=true;opened.push(current);return reply({ok:true});}
      if(msg.type==='ITER_DIALOG_BUTTON') {
        if(msg.label==='取消') {editorOpen=false;closed.push(current);return reply({ok:true});}
        if(msg.label==='确定' && editorOpen) {editorOpen=false;saved.push(current);return reply({ok:true});}
        return reply({ok:false});
      }
      if(msg.type==='EXECUTE') {nameValue=msg.value;return reply({ok:true,value:msg.value});}
      if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:`${current}:${editorOpen}:${nameValue}`});
      if(msg.type==='SNAPSHOT_FULL') return reply({ok:true,fingerprint:`${current}:${editorOpen}:${nameValue}`,
        elements:frameId===0?[]:editorOpen?[current==='个人信息' ?
          {index:'1',kind:'input',label:'姓名',value:nameValue,operations:['TYPE_TEXT']} :
          {index:'1',kind:'input',label:'无映射字段',value:'',operations:['TYPE_TEXT']}]:[],
        page:{title:'校园招聘',url:'https://iter.stongyw.cn/web/school/resume/index.html',text:current}});
      throw new Error(`unexpected ${msg.type}`);
    }},
  scripting:{executeScript:async()=>editorOpen?[{frameId:0},{frameId:80}]:[{frameId:0}]},
  storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',apiKey:'test-key',resume:{basics:{name:'测试'},expected:{city:'深圳'},education:[]}}, {},()=>{});
  const result=await done;
  assert.equal(result.done,true,result.reason);
  assert.deepEqual(visited,sections);
  assert.deepEqual(opened,['个人信息','求职意向']);
  assert.deepEqual(saved,['个人信息']);
  assert.deepEqual(closed,['求职意向']);
  assert.equal(nameValue,'测试');
  assert.equal(editorOpen,false);
} finally {
  globalThis.setTimeout=realTimeout;
}
console.log('✓ 匹配字段保存、无匹配字段退出，并继续下一个分区');
