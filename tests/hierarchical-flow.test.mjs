import assert from 'node:assert/strict';

// 原专用域名同样执行共享分区调度，覆盖复合资料块及重复记录。
const pageUrl=process.argv.includes('--former-honor-host') ?
  'https://career.honor.com/mc/deliver/resumerDetail' : 'https://example.test/form';

const resume={basics:{name:'示例姓名'},education:[
  {institution:'示例大学 A',studyType:'硕士',startDate:'2025-09-01',researchFocus:'城市计算'},
  {institution:'示例大学 B',studyType:'本科',startDate:'2021-09-01',researchFocus:'空间分析'}
],languages:[{language:'英语'}],projects:[{name:'外部分区项目'}],family:[{name:'示例父亲'}]};
const values={name:'',language:''};
const rows=[{school:'',level:'',date:'',focus:''}];
let popup=null,revision=0,listener,resolveDone,addCount=0;
const requests=[],executions=[];
const completion=new Promise(resolve=>resolveDone=resolve);
const originals={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,log:console.log};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
console.log=()=>{};
function elements() {
  const controls=[{index:'name',stableKey:'name',section:'个人信息',label:'姓名',kind:'input',value:values.name,operations:['TYPE_TEXT']}];
  rows.forEach((row,i)=>{
    for (const [key,label,kind,operations] of [
      ['school','学校名称','input',['TYPE_TEXT']],['level','攻读层次','custom-select',['CLICK']],
      ['date','开始时间','date',['PICK_DATE']],['focus','学术主题摘要','textarea',['TYPE_TEXT']]
    ]) controls.push({index:`${i}-${key}`,stableKey:`${i}-${key}`,section:'个人信息',recordIndex:i,label,kind,
      value:row[key],operations});
  });
  controls.push({index:'add',section:'个人信息',label:'添加教育经历',kind:'card',operations:['CLICK']},
    {index:'language',stableKey:'language',section:'语言能力',label:'语种',kind:'input',value:values.language,operations:['TYPE_TEXT']},
    {index:'submit',section:'个人信息',label:'提交简历',kind:'action',operations:['CLICK']});
  if(popup !== null) controls.push(...['硕士','本科'].map((label,i)=>({index:`option-${i}`,section:'个人信息',
    context:'popup',label,kind:'option-item',operations:['CLICK']})));
  return controls.map((control,domOrder)=>({...control,domOrder}));
}
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);
  requests.push(body);
  assert.ok(requests.length<100,'局部选择和返回必须有界');
  const entries=Object.entries(body.questions.action.criteria);
  const context=body.state.section_context;
  let chosen;
  if(entries.some(([,action])=>Object.hasOwn(action,'block'))) {
    const desired=context.section==='语言能力' ? values.language ? null : 'languages' : !values.name ? 'basics' :
      rows.length<2 || rows.some(row=>!row.school || !row.level || !row.date || !row.focus) ? 'education' : null;
    chosen=entries.find(([,action])=>action.block===desired);
  } else if(context?.selected_json_block && entries.some(([,action])=>action.source_meaning !== undefined)) {
    const field={姓名:'name',学校名称:'institution',开始时间:'startDate',攻读层次:'studyType',学术主题摘要:'researchFocus',语种:'language'}[entries[0][1].page_label];
    const path=context.selected_json_block==='basics' ? `basics.${field}` :
      `${context.selected_json_block}[${context.record_index}].${field}`;
    chosen=entries.find(([,action])=>action.resume_field===path) || entries.find(([,action])=>action.effect?.includes('无匹配'));
  } else chosen=entries.find(([,action])=>action.operation!=='RETURN') || entries[0];
  assert.ok(chosen,`有明确候选：${JSON.stringify(entries)}`);
  return {ok:true,json:async()=>({answers:{action:{choice:chosen[0],confidence:1}}})};
};
globalThis.chrome={
  runtime:{onMessage:{addListener:fn=>listener=fn},onConnect:{addListener(){}},onInstalled:{addListener(){}},
    sendMessage:msg=>{if(msg.type==='FILL_DONE') resolveDone(msg);},lastError:null},
  tabs:{query:async()=>[{id:1,title:'简历编辑',url:pageUrl}],
    sendMessage(_id,msg,_opts,reply){
      if(msg.type==='PING') return reply({ok:true,version:'2026-10-07.57'});
      if(msg.type==='CLOSE_TRANSACTIONS'){popup=null;return reply({ok:true});}
      if(msg.type==='FINGERPRINT') return reply({ok:true,fingerprint:String(revision)});
      if(msg.type==='SNAPSHOT_FULL') return reply({ok:true,elements:elements(),fingerprint:String(revision),
        page:{title:'简历编辑',url:pageUrl,text:'个人信息 语言能力'}});
      if(msg.type==='EXECUTE') {
        executions.push(msg);
        assert.notEqual(msg.index,'submit','最终投递始终保留用户操作');
        if(msg.index==='add'){rows.push({school:'',level:'',date:'',focus:''});addCount++;}
        else if(msg.index==='name' || msg.index==='language') values[msg.index]=msg.value;
        else if(msg.index?.startsWith('option-')) {rows[popup].level=msg.index==='option-0'?'硕士':'本科';popup=null;}
        else {
          const [i,key]=msg.index.split('-');
          if(msg.action==='click') popup=Number(i);
          else rows[Number(i)][key]=msg.value;
        }
        revision++;
        return reply({ok:true,value:msg.value});
      }
      throw new Error(`unexpected ${msg.type}`);
    }},scripting:{executeScript:async()=>[{frameId:0}]},storage:{session:{set:async()=>{}}}
};
try {
  await import('../background/service-worker.js');
  listener({type:'START_FILL',runtimeVersion:'2026-10-07.57',apiKey:'synthetic',resume},{},()=>{});
  const result=await completion;
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok(!result.pendingIssues.some(issue=>/family/.test(issue.reason || '')),
    '个人姓名验收只使用已选资料块，家庭姓名进入自己的分区');
  assert.equal(addCount,1,'两段教育只新增一次');
  assert.deepEqual(rows,resume.education.map(record=>({school:record.institution,level:record.studyType,
    date:record.startDate,focus:record.researchFocus})));
  assert.deepEqual(values,{name:'示例姓名',language:'英语'});
  const localRequests=requests.filter(body=>body.state.section_context?.selected_json_block);
  assert.ok(localRequests.length>0);
  for (const body of localRequests) {
    const ctx=body.state.section_context;
    assert.ok(ctx.controls.every(control=>ctx.section==='个人信息' ? control.label!=='语种' : control.label==='语种'));
    assert.ok(!JSON.stringify(ctx).includes('外部分区项目'));
  }
  const languageAt=executions.findIndex(msg=>msg.index==='language');
  assert.ok(executions.slice(languageAt+1).every(msg=>!/^\d-/.test(msg.index || '')),'完成当前 section 后进入其他分区');
} finally {
  globalThis.fetch=originals.fetch;globalThis.setTimeout=originals.setTimeout;console.log=originals.log;
}
console.log('Hierarchical scheduler filled a composite section, two inline records, raw fields and a separate section');
