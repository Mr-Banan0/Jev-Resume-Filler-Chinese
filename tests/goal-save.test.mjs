import assert from 'node:assert/strict';
import {runGoalScheduler} from '../background/goal-runner.js';
import {hasCommittedValue} from '../lib/action-policy.js';
import {fieldAudit} from '../lib/goal-state.js';

assert.equal(hasCommittedValue({kind:'textarea',value:'字数控制在500个汉字以内'}),false);
assert.equal(hasCommittedValue({kind:'textarea',value:'字数控制在50个字以内'}),false);
assert.equal(hasCommittedValue({kind:'textarea',value:'优化日志存储，响应时间下降50%。'}),true);

const originalFetch=globalThis.fetch;
let recordBindings=0,requestedView=null,rejectedBlock=null,narrowRecords=false;
globalThis.fetch=async(_url,args)=>{
  const body=JSON.parse(args.body);
  if(body.questions.match) return {ok:true,json:async()=>({answers:{match:{type:'noul',noul:1},unrelated:{type:'noul',noul:0}}})};
  const entries=Object.entries(body.questions.action.criteria);
  if(entries.some(([,a])=>a.operation==='BIND_RECORD')) recordBindings++;
  const choice=narrowRecords && body.state.goal_context?.phase==='record-source' &&
      (entries.find(([,a])=>a.operation==='SELECT_SOURCE_RECORD' &&
        body.state.section_context.json_fields[a.source_record_index]?.position==='班长') ||
        entries.find(([,a])=>a.operation==='END_RECORDS')) ||
    narrowRecords && entries.find(([,a])=>a.operation==='FILL_RECORDS') ||
    rejectedBlock && body.state.goal_context?.selectedBlock===rejectedBlock &&
      body.state.goal_context?.phase==='record-binding' && entries.find(([,a])=>a.operation==='SKIP_RECORD') ||
    rejectedBlock && entries.find(([,a])=>a.operation==='FILL_RECORDS') ||
    requestedView && body.state.goal_context?.phase==='editor-type' &&
    entries.find(([,a])=>a.operation==='OPEN_VIEW' && a.target.includes(requestedView)) ||
    entries.find(([,a])=>a.operation==='WORK_SECTION') ||
    entries.find(([,a])=>a.operation==='SELECT_DATA_BLOCK') ||
    (body.state.goal_context?.selectedBlock==='internship' && entries.find(([,a])=>a.operation==='FILL_RECORDS')) ||
    entries.find(([,a])=>a.operation==='FILL_FACTS') ||
    entries.find(([,a])=>a.operation==='BIND_RECORD') ||
    entries.find(([,a])=>a.operation==='OPEN_EDITOR') || entries[0];
  return {ok:true,json:async()=>({answers:{action:{choice:choice[0],confidence:1}}})};
};
try {
  {
    const url='https://synthetic.example/resume',resume={basics:{name:'合成姓名'},fillPolicy:{sitePolicies:[{
      host:'synthetic.example',excludedSections:['亲属关系'],excludedQuestions:['是否申请其他单位']}]}};
    const excluded={index:'omit',stableKey:'omit',section:'个人信息',kind:'input',label:'是否申请其他单位',
      value:'',operations:['TYPE_TEXT'],validationError:'网站要求补充'};
    assert.equal(fieldAudit([excluded],[],{},{resume,url})[0].status,'excluded-user');
    assert.equal(fieldAudit([excluded],[],{},{resume,url:'https://another.example/resume'})[0].status,'blocked',
      '用户跳过规则按指定站点生效');
    let noticeOpen=true,closes=0,transactions=0;
    const name={index:'name',stableKey:'name',section:'个人信息',kind:'input',label:'姓名',value:'',operations:['TYPE_TEXT']};
    const result=await runGoalScheduler({tabId:1,resume,apiKey:'synthetic',goal:'补齐可填字段',report:()=>{},
      isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{url,text:'合成表单'},elements:noticeOpen?[{
        index:'notice',stableKey:'notice',context:'popup',kind:'action',label:'确认',noticeDismissal:true,operations:['CLICK']
      }]:[name,excluded,{index:'relative',stableKey:'relative',section:'亲属关系',kind:'action',label:'添加',operations:['CLICK']}]}),
      executeClick:async(_tab,_frame,index)=>{assert.equal(index,'notice');noticeOpen=false;closes++;return {ok:true};},
      transaction:async()=>{transactions++;name.value='合成姓名';return {ok:true,history:[]};}});
    assert.equal(closes,1,'调度器先关闭已确认安全的非协议提示，再扫描表单');
    assert.equal(transactions,1,'排除区域保持在操作范围之外');
    assert.equal(result.sections.find(section=>section.title==='亲属关系').status,'excluded-user');
    assert.equal(result.pendingIssues.length,0,'指定跳过的字段独立记账，不计为填写失败');
  }
  for(const [hasSummary,saveDelay] of [[true,0],[false,0],[true,5]]) {
    let open=true,saves=0,saveReads=0;
    const controls=[{index:'name',stableKey:'name',section:'个人信息',kind:'input',label:'姓名',value:'',operations:['TYPE_TEXT']},
      {index:'school',stableKey:'school',section:'个人信息',kind:'input',label:'最高学历院校',value:'',operations:['TYPE_TEXT']}];
    const save={index:'save',stableKey:'save',section:'个人信息',kind:'action',label:'保存',operations:['CLICK']};
    const resume={basics:{name:'合成姓名'},education:[{institution:'合成大学'}]};
    const snapshot=async()=>{
      if(saves && open && ++saveReads>=saveDelay) open=false;
      return {elements:open?[...controls,save]:[
      {index:'edit',stableKey:'edit',section:'个人信息',kind:'action',label:'编辑',operations:['CLICK'],
        summaryText:hasSummary?'合成姓名 合成大学':''}],page:{text:'个人信息'},fingerprint:String(saves)};
    };
    const result=await runGoalScheduler({tabId:1,resume,apiKey:'synthetic',goal:'补齐空字段并保存草稿',
      report:()=>{},isCurrentRun:()=>true,snapshot,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      executeClick:async(_tab,_frame,index)=>{assert.equal(index,'save');saves++;if(!saveDelay)open=false;return {ok:true};},
      transaction:async({dataBlock})=>{
        const control=controls[dataBlock==='basics'?0:1],field=dataBlock==='basics'?'basics.name':'education[0].institution';
        control.value=dataBlock==='basics'?resume.basics.name:resume.education[0].institution;
        return {ok:true,history:[{kind:'bind',controlStableKey:control.stableKey,resumeField:field}]};
      }});
    assert.equal(controls[1].value,'合成大学','复合信息检查完多个资料块');
    assert.equal(saves,1,'复合表单在全部资料块结束后保存一次');
    assert.equal(result.goalSummary.saved,hasSummary?1:0,'关闭编辑器与摘要回读分别验收');
    assert.equal(result.pendingIssues.some(issue=>issue.field==='保存回读'),!hasSummary);
    assert.equal(result.sections.find(section=>section.title==='个人信息').status,hasSummary?'checked':'blocked',
      '保存失败的区域向用户报告阻塞状态');
  }
  {
    recordBindings=0;
    let open=true,transactions=0;
    const controls=[{index:'name',stableKey:'name',section:'实习经历',kind:'input',label:'工作单位',value:'',operations:['TYPE_TEXT']},
      {index:'description',stableKey:'description',section:'实习经历',kind:'textarea',label:'工作描述',
        value:'字数控制在500个汉字以内',operations:['TYPE_TEXT']},
      {index:'proof',stableKey:'proof',section:'实习经历',kind:'radio',label:'是否有证明',checked:true,operations:['CLICK']}];
    const save={index:'save',stableKey:'save',section:'实习经历',kind:'action',label:'保存',operations:['CLICK']};
    const result=await runGoalScheduler({tabId:1,resume:{internship:[{company:'合成企业'}]},apiKey:'synthetic',goal:'补齐经历',
      report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({elements:open?[...controls,save]:[{index:'add',stableKey:'add',section:'实习经历',kind:'action',
        label:'添加',operations:['CLICK'],summaryText:'合成企业'}],page:{text:'实习经历'}}),
      executeClick:async()=>{open=false;return {ok:true};},transaction:async()=>{
        transactions++;controls[0].value='合成企业';return {ok:true,history:[]};
      }});
    assert.equal(recordBindings,0,'空白经历的默认单选项作为表单设置，与经历身份区分');
    assert.equal(transactions,1);
    assert.equal(result.goalSummary.saved,1,JSON.stringify({reason:result.reason,pending:result.pendingIssues}));
  }
  {
    const controls=[{index:'name',stableKey:'name',section:'实习经历',kind:'input',label:'工作单位',
      value:'',operations:['TYPE_TEXT']},
      {index:'phone',stableKey:'phone',section:'实习经历',kind:'input',label:'证明人电话',
        value:'',operations:['TYPE_TEXT']}];
    const blocks=[];
    const result=await runGoalScheduler({tabId:1,
      resume:{internship:[{company:'合成企业'}],basics:{phone:'00000000000'}},
      apiKey:'synthetic',goal:'补齐经历',report:()=>{},isCurrentRun:()=>true,
      snapshot:async()=>({elements:controls,page:{text:'实习经历'}}),sleep:async()=>{},
      closeTransactions:async()=>({ok:true}),executeClick:async()=>({ok:true}),
      transaction:async({dataBlock})=>{
        blocks.push(dataBlock);
        if(dataBlock==='internship') controls[0].value='合成企业';
        else controls[1].value='00000000000';
        return {ok:true,history:[]};
      }});
    assert.deepEqual(blocks,['internship'],'重复经历锁定来源，缺少证明人电话时保留待补');
    assert.equal(controls[1].value,'','申请人电话保持在个人资料上下文内');
    assert.ok(result.pendingIssues.some(issue=>issue.field==='证明人电话'));
  }
  {
    const control={index:'geo',stableKey:'geo',section:'个人信息',kind:'input',label:'出生地',value:'',operations:['CLICK']};
    const result=await runGoalScheduler({tabId:1,resume:{basics:{birthPlace:'合成地点'},expected:{salary:'合成薪资'}},
      apiKey:'synthetic',goal:'检查字段',report:()=>{},isCurrentRun:()=>true,
      snapshot:async()=>({elements:[control],page:{text:'个人信息'}}),sleep:async()=>{},
      closeTransactions:async()=>({ok:true}),executeClick:async()=>({ok:true}),
      transaction:async({dataBlock})=>({ok:false,history:[{kind:'skip',skipControlKey:'geo',
        reasonKind:dataBlock==='basics'?'execution-gap':'missing-data',
        reason:dataBlock==='basics'?'地址确认尚未完成':'当前资料块没有出生地'}]})});
    assert.equal(result.pendingIssues.find(issue=>issue.field==='出生地')?.reason,'地址确认尚未完成',
      '后续资料块的无来源结果保留先前执行失败的具体原因');
  }
  for(const [replacement,rekey] of [['',false],['',true],['另一个已有姓名',false]]) {
    let savedSecond=false,firstSaves=0;
    const transactions=[];
    const name={index:'draft-name',stableKey:'draft-name',section:'待补区域',kind:'input',label:'姓名',value:'',operations:['TYPE_TEXT']};
    const missing={index:'proof',stableKey:'proof',section:'待补区域',kind:'input',label:'证明编号',value:'',
      validationError:'请补充证明编号',required:true,operations:['TYPE_TEXT']};
    const gender={index:'gender',stableKey:'gender',section:'可保存区域',kind:'input',label:'性别',value:'',operations:['TYPE_TEXT']};
    const button=section=>({index:section,stableKey:section,section,kind:'action',label:'保存',operations:['CLICK']});
    const result=await runGoalScheduler({tabId:1,resume:{basics:{name:'合成姓名',gender:'男'}},
      apiKey:'synthetic',goal:'补齐空字段',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},
      closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'合成简历'},elements:[name,missing,button('待补区域'),
        ...(savedSecond?[{index:'edit',stableKey:'edit',section:'可保存区域',kind:'action',label:'编辑',
          summaryText:'男',operations:['CLICK']}]:[gender,button('可保存区域')])]}),
      executeClick:async(_tab,_frame,index)=>{
        if(index==='待补区域') firstSaves++;
        else if(index==='可保存区域') {
          savedSecond=true;name.value=replacement;
          if(rekey) name.stableKey='rebuilt-draft-name';
        }
        else assert.fail(`意外操作：${index}`);
        return {ok:true};
      },
      transaction:async({scopeSection,recordControlKeys})=>{
        transactions.push(scopeSection);
        if(recordControlKeys.includes('proof')) return {ok:false,history:[{kind:'skip',skipControlKey:'proof',
          reasonKind:'missing-data',reason:'资料未提供证明编号'}]};
        const target=scopeSection==='待补区域'?name:gender;
        assert.ok(recordControlKeys.includes(target.stableKey),'事务只写当前路由字段');
        target.value=scopeSection==='待补区域'?'合成姓名':'男';
        return {ok:true,history:[{kind:'bind',controlStableKey:target.stableKey,
          resumeField:scopeSection==='待补区域'?'basics.name':'basics.gender'}]};
      }});
    assert.equal(savedSecond,true);
    assert.equal(firstSaves,1,'保存尝试集中在当前分区内');
    assert.deepEqual(transactions,['待补区域','待补区域','可保存区域'],'分区内逐个检查字段，终结后保持只读');
    assert.equal(name.value,replacement,'后续刷新产生的空值和已有冲突值保持原样');
    assert.equal(result.pendingIssues.some(issue=>issue.field==='姓名' && /离开分区后/.test(issue.reason)),!replacement,
      '只读复核记录被清空字段，DOM 重建后通过唯一字段证据关联');
    assert.ok(result.sections.every(section=>section.closed),'本轮处理过的分区均已终结');
  }
  {
    let firstOpen=true,secondOpen=true,firstSaves=0;
    const make=(section,label)=>({index:label,stableKey:label,section,kind:'input',label,value:'',required:true,operations:['TYPE_TEXT']});
    const name=make('先检查区域','姓名'),gender=make('后检查区域','性别');
    const region=(section,control,open,summary)=>open?[control,{index:section,stableKey:section,section,
      kind:'action',label:'保存',operations:['CLICK']}]:[{index:`edit:${section}`,stableKey:`edit:${section}`,
      section,kind:'action',label:'编辑',summaryText:summary,operations:['CLICK']}];
    const result=await runGoalScheduler({tabId:1,resume:{basics:{name:'合成姓名',gender:'男性'}},apiKey:'synthetic',
      goal:'填写并保存',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'合成简历'},elements:[
        ...region('先检查区域',name,firstOpen,'合成姓名'),...region('后检查区域',gender,secondOpen,'男性')]}),
      executeClick:async(_tab,_frame,index)=>{
        if(index==='先检查区域') {firstSaves++;if(!secondOpen)firstOpen=false;}
        else if(index==='后检查区域') secondOpen=false;
        else assert.fail(`意外操作：${index}`);
        return {ok:true};
      },
      transaction:async({scopeSection})=>{
        const first=scopeSection==='先检查区域',control=first?name:gender;
        control.value=first?'合成姓名':'男性';
        return {ok:true,history:[{kind:'bind',controlStableKey:control.stableKey,resumeField:first?'basics.name':'basics.gender'}]};
      }});
    assert.equal(firstSaves,1,'前置状态后续变化时，已终结分区保持原保存结果');
    assert.equal(result.goalSummary.saved,1);
    assert.equal(result.pendingIssues.some(issue=>issue.section==='先检查区域' && issue.field==='保存回读'),true);
  }
  {
    let revealed=false,open=true;
    const gates=['是','否'].map((optionLabel,index)=>({index:`gate${index}`,stableKey:`gate${index}`,
      recordStableKey:'gate',section:'语言证书',kind:'radio',label:'是否有外语能力',questionLabel:'是否有外语能力',
      optionLabel,checked:false,regionGate:true,choiceGroup:'language-gate',operations:['CLICK']}));
    const certificate={index:'certificate',stableKey:'certificate',recordStableKey:'editor',section:'语言证书',
      kind:'input',label:'证书名称',value:'',operations:['TYPE_TEXT']};
    const result=await runGoalScheduler({tabId:1,resume:{languages:[{certificate:'IELTS'}]},apiKey:'synthetic',
      goal:'填写语言能力',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'语言证书'},elements:[...gates,...(revealed && open?[certificate,
        {index:'save',stableKey:'save',section:'语言证书',kind:'action',label:'保存',operations:['CLICK']}]:
        revealed?[{index:'edit',stableKey:'edit',section:'语言证书',kind:'action',label:'编辑',summaryText:'IELTS',operations:['CLICK']}]:[])]}),
      executeClick:async()=>{open=false;return {ok:true};},
      transaction:async({gateScope,recordControlKeys})=>{
        if(gateScope) {gates[0].checked=true;revealed=true;return {ok:true,history:[]};}
        assert.deepEqual(recordControlKeys,['certificate'],'前置开关展开后，字段事务归属实际编辑表面');
        certificate.value='IELTS';
        return {ok:true,history:[{kind:'bind',controlStableKey:'certificate',resumeField:'languages[0].certificate'}]};
      }});
    assert.equal(result.goalSummary.saved,1);
    assert.equal(certificate.value,'IELTS');
  }
  {
    let open=true,saves=0,repairs=0;
    const title={index:'title',stableKey:'title',section:'论文',kind:'input',label:'论文名称',value:'',required:true,operations:['TYPE_TEXT']};
    const resume={publications:[{title:'A complete source title that exceeds the form limit',titleShort:'Short title'}]};
    const result=await runGoalScheduler({tabId:1,resume,apiKey:'synthetic',goal:'填写论文',report:()=>{},
      isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'论文'},elements:open?[title,{index:'save',stableKey:'save',section:'论文',
        kind:'action',label:'保存',operations:['CLICK']}]:[{index:'edit',stableKey:'edit',section:'论文',kind:'action',
        label:'编辑',summaryText:'Short title',operations:['CLICK']}]}),
      executeClick:async()=>{
        saves++;
        if(title.value.length>20) {title.maxLength=20;title.validationError='论文名称长度不能大于20';}
        else {title.validationError='';open=false;}
        return {ok:true};
      },
      transaction:async({repairDraft,fieldBindings})=>{
        if(repairDraft) {repairs++;assert.equal(fieldBindings[0].resumeField,'publications[0].titleShort');}
        title.value=repairDraft?resume.publications[0].titleShort:resume.publications[0].title;
        title.validationError='';
        return {ok:true,history:[{kind:'bind',controlStableKey:'title',
          resumeField:repairDraft?'publications[0].titleShort':'publications[0].title'}]};
      }});
    assert.equal(saves,2);
    assert.equal(repairs,1,'保存后才显露的长度约束使用同一来源短版完成一次有界修复');
    assert.equal(result.goalSummary.saved,1);
    assert.equal(title.value,'Short title');
  }
  {
    requestedView='英语证书';
    let certificateView=false,open=true,transactions=0;
    const views=['英语等级','英语证书'].map((label,index)=>({index:`view${index}`,stableKey:`view${index}`,
      section:'语言证书',kind:'action',label,localView:true,viewSelected:index===0,operations:['CLICK']}));
    const old={index:'old-grade',stableKey:'old-grade',recordStableKey:'old-editor',section:'语言证书',
      kind:'input',label:'成绩',value:'分',operations:['TYPE_TEXT']};
    const field={index:'certificate',stableKey:'certificate',recordStableKey:'new-editor',section:'语言证书',
      kind:'input',label:'证书名称',value:'',operations:['TYPE_TEXT']};
    const result=await runGoalScheduler({tabId:1,resume:{languages:[{certificate:'IELTS'}]},apiKey:'synthetic',
      goal:'填写语言能力',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'语言证书'},elements:open?[...views,certificateView?field:old,
        {index:'save',stableKey:'save',section:'语言证书',kind:'action',label:'保存',operations:['CLICK']}]:
        [{index:'edit',stableKey:'edit',section:'语言证书',kind:'action',label:'编辑',summaryText:'IELTS',operations:['CLICK']}]}),
      executeClick:async(_tab,_frame,index)=>{
        if(index==='view1') {certificateView=true;views.forEach((view,i)=>view.viewSelected=i===1);}
        else {assert.equal(index,'save');open=false;}
        return {ok:true};
      },
      transaction:async({recordControlKeys})=>{
        transactions++;assert.equal(certificateView,true,'先选择证书编辑类型，再开始字段事务');
        assert.deepEqual(recordControlKeys,['certificate'],'切换后绑定新的编辑表面');
        field.value='IELTS';return {ok:true,history:[{kind:'bind',controlStableKey:'certificate',resumeField:'languages[0].certificate'}]};
      }});
    assert.equal(transactions,1);
    assert.equal(result.goalSummary.saved,1);
    requestedView=null;
  }
  {
    rejectedBlock='certificates';
    let open=true,transactions=0;
    const controls=[{index:'certificate',stableKey:'certificate',section:'语言能力',kind:'input',
      label:'证书名称',value:'IELTS',operations:['TYPE_TEXT']},
      {index:'score',stableKey:'score',section:'语言能力',kind:'input',label:'成绩',value:'',operations:['TYPE_TEXT']}];
    const result=await runGoalScheduler({tabId:1,resume:{certificates:[{name:'合成专利'}],languages:[{language:'英语',certificate:'IELTS',score:'6.5'}]},
      apiKey:'synthetic',goal:'填写语言能力',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'语言能力'},elements:open?[...controls,{index:'save',stableKey:'save',section:'语言能力',
        kind:'action',label:'保存',operations:['CLICK']}]:[{index:'edit',stableKey:'edit',section:'语言能力',kind:'action',label:'编辑',
        summaryText:'英语 IELTS 6.5',operations:['CLICK']}]}),
      executeClick:async()=>{open=false;return {ok:true};},
      transaction:async({dataBlock})=>{transactions++;assert.equal(dataBlock,'languages');controls[1].value='6.5';return {ok:true,history:[]};}});
    assert.equal(transactions,1,'资料块与网页记录不匹配时继续选择另一个资料块');
    assert.equal(result.goalSummary.saved,1,JSON.stringify({reason:result.reason,pending:result.pendingIssues}));
    assert.ok(!result.pendingIssues.some(issue=>issue.field==='记录归属'),'正确绑定后清理先前资料块的归属待核对项');
    rejectedBlock=null;
  }
  {
    narrowRecords=true;
    let open=true,saves=0,transactions=0;
    const field={index:'post',stableKey:'post',section:'校内职务',kind:'input',label:'担任职务',value:'',operations:['TYPE_TEXT']};
    const result=await runGoalScheduler({tabId:1,resume:{campusPractice:[{position:'班长'},{position:'志愿者'}]},apiKey:'synthetic',
      goal:'填写校内职务',report:()=>{},isCurrentRun:()=>true,sleep:async()=>{},closeTransactions:async()=>({ok:true}),
      snapshot:async()=>({page:{text:'校内职务'},elements:open?[field,{index:'save',stableKey:'save',section:'校内职务',
        kind:'action',label:'保存',operations:['CLICK']}]:[{index:'edit',stableKey:'edit',section:'校内职务',kind:'action',label:'编辑',
        summaryText:'班长',operations:['CLICK']},{index:'add',stableKey:'add',section:'校内职务',kind:'action',label:'添加',operations:['CLICK']}]}),
      executeClick:async(_tab,_frame,index)=>{assert.equal(index,'save','不适用来源在新增之前退出');saves++;open=false;return {ok:true};},
      transaction:async({initialRecordIndex})=>{assert.equal(initialRecordIndex,0);transactions++;field.value='班长';return {ok:true,history:[]};}});
    assert.equal(saves,1);assert.equal(transactions,1);assert.equal(result.goalSummary.records,1);
    narrowRecords=false;
  }
} finally {globalThis.fetch=originalFetch;}
console.log('Goal saves: composite blocks save once; section closure preserves pending saves and read-only audit');
