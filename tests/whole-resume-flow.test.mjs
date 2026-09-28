import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {honorSections,recordIdentity} from '../lib/honor-flow.js';

const popupHtml=readFileSync(new URL('../popup/popup.html',import.meta.url),'utf8');
assert.match(popupHtml,/<script\s+type="module"\s+src="popup\.js"/);

const education = [
  {institution:'示例大学 A',department:'示例院系 A',area:'示例专业 A',startDate:'2023-09-01',endDate:'2026-06-30'},
  {institution:'示例大学 B',department:'示例院系 B',area:'示例专业 B',startDate:'2019-09-01',endDate:'2023-06-30'}
];

const names=['语言能力','教育经历','个人基本信息'];
const overviewUrl='https://career.honor.com/mc/deliver/resumerDetail?resumeId=synthetic';
let phase='overview',section='',inputs={},revision=1,listener;
const saved={};
let done;
const completed=new Promise(resolve=>done=resolve);
const realTimeout=globalThis.setTimeout;
const realLog=console.log;
globalThis.setTimeout=fn=>{queueMicrotask(fn);return 0;};
console.log=()=>{};
globalThis.fetch=async()=>({ok:true,json:async()=>({answers:{action:{choice:'a1',confidence:1}}})});
const formLabels={
  '语言能力':['语种'],
  '教育经历':['学校','就读院/系','专业','开始时间','结束时间'],
  '个人基本信息':['姓名']
};
const resume={basics:{name:'测试姓名'},languages:[{language:'英语'}],education};
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:message=>{if(message.type==='FILL_DONE') done(message);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'在线填写完整简历',url:overviewUrl}],
    update:async(_id,info)=>{if(info.url) phase='overview';},
    sendMessage(_id,msg,_opts,reply){
      if(msg.type==='PING') return reply({ok:true});
      if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
      if(msg.type==='MATCH_RECORD'){
        const rows=saved[msg.section] || [];
        const matches=rows.filter(row=>msg.identities.some(identity=>row.includes(identity)));
        if(msg.click && matches.length===1){section=msg.section;phase='form';inputs={};}
        return reply({ok:true,found:matches.length===1,count:matches.length,clicked:!!msg.click && matches.length===1});
      }
      if(msg.type==='SNAPSHOT_FULL'){
        const elements=phase==='overview' ?
          names.map((label,i)=>({index:String(i+1),domOrder:i,kind:'section-entry',label,operations:['CLICK']})) :
          [...formLabels[section].map((label,i)=>({index:String(i+1),domOrder:i,kind:'input',label,
            value:inputs[label] || '',operations:['TYPE_TEXT']})),
            {index:'9',domOrder:9,kind:'action',label:'保存',operations:['CLICK']}];
        return reply({ok:true,elements,fingerprint:String(revision),page:{
          title:phase==='overview'?'在线填写完整简历':section,
          url:phase==='overview'?overviewUrl:'https://career.honor.com/mc/deliver/operationResumer?isFast=',
          text:phase==='overview'?'在线填写完整简历':section
        }});
      }
      if(msg.type==='EXECUTE'){
        if(msg.action==='type_text'){
          const label=formLabels[section][Number(msg.index)-1];
          inputs[label]=msg.value;
        } else if(msg.index==='9'){
          const identity=section==='教育经历'?inputs['学校']:
            section==='语言能力'?inputs['语种']:inputs['姓名'];
          (saved[section] ||= []).push(identity);
          phase='overview';
        } else if(phase==='overview'){
          section=names[Number(msg.index)-1];
          phase='form';
          inputs={};
        }
        revision++;
        return reply({ok:true});
      }
      throw new Error('Unexpected '+msg.type);
    }},
  scripting:{executeScript:async()=>[{frameId:0}]},
  storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  const start=listener({type:'START_FILL',apiKey:'synthetic-key',resume,goal:''},{},()=>{});
  assert.equal(start,true);
  const result=await completed;
  assert.equal(result.ok,true,result.reason);
  assert.deepEqual(result.sections.map(item=>item.status),['saved','saved','saved','saved']);
  assert.deepEqual(saved['教育经历'],['示例大学 A','示例大学 B']);
  assert.deepEqual(saved['语言能力'],['英语']);
  assert.deepEqual(saved['个人基本信息'],['测试姓名']);
assert.equal(recordIdentity(education[1])[0],'示例大学 B');
assert.equal(honorSections(resume,names.map(label=>({kind:'section-entry',label}))).length,3);
const allSectionNames=['语言能力','获奖经历','荣耀亲属','工作经历','项目经验','专业技能',
  '论文著作','个人专利','专业资格认证','培训经历','计算机能力','教育经历','个人基本信息'];
const allSections=honorSections(resume,allSectionNames.map(label=>({kind:'section-entry',label})));
assert.deepEqual(allSections.map(item=>item.name),allSectionNames);
assert.equal(allSections.find(item=>item.name==='论文著作').records.length,0);
assert.equal(allSections.find(item=>item.name==='教育经历').records.length,2);
} finally {
  globalThis.setTimeout=realTimeout;
  console.log=realLog;
}
console.log('✓ 从空白总览一次启动，自动完成跨分区与两段教育并逐条回读');
