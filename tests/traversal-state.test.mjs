import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildActionPlan} from '../lib/jev-client.js';
import {createRunMemory,matchRecordSources,recordLedgerKey,recordOutcome,savedRecordEvidence,scopeControls,sourceRecordId} from '../lib/traversal-state.js';

const records=[{company:'同名公司',startDate:'2025-01-01',endDate:'2025-06-01',position:'开发实习生'},
  {company:'同名公司',startDate:'2026-01-01',endDate:'2026-06-01',position:'开发实习生'}];
assert.notEqual(sourceRecordId('internship',records[0]),sourceRecordId('internship',records[1]));
assert.equal(sourceRecordId('internship',records[0]),sourceRecordId('internship',{...records[0],summary:'更新描述'}));
assert.equal(recordLedgerKey('实习经历','internship',{internship:records},0),
  recordLedgerKey('实习经历','internship',{internship:[records[1],records[0]]},1),'来源重排保留记录身份');
const anchors=[0,1].map(i=>({index:`f7_company${i}`,frameId:7,recordIndex:i,kind:'input',label:'公司名称',value:'同名公司'}));
const dates=[records[1],records[0]].map((record,i)=>({index:`f7_start${i}`,frameId:7,recordIndex:i,
  kind:'date',label:'开始时间',value:record.startDate,operations:['PICK_DATE']}));
assert.deepEqual(matchRecordSources(anchors,[...anchors,...dates],records,'company'),{0:1,1:0});
assert.deepEqual(matchRecordSources(anchors.map(el=>({...el,recordStableKey:'shared-container'})),
  [...anchors,...dates].map(el=>({...el,recordStableKey:'shared-container'})),records,'company'),{0:1,1:0},
  '共享大容器内的日期仍归属具体记录');
assert.deepEqual(matchRecordSources(anchors,anchors,records,'company'),{0:null,1:null},'同名无日期保持冲突');
assert.deepEqual(matchRecordSources([{recordIndex:0,value:'企业乙'},{recordIndex:1,value:''}],[],
  [{company:'企业甲'},{company:'企业乙'}],'company'),{0:1,1:0},'混合已有与空白记录使用未占用来源');
const existingDescription='围绕城市多源数据构建空间预测系统，整合传感器和地理空间特征，设计可解释的学习流程并分析影响因素。';
const partialProject={section:'项目经验',recordIndex:0,recordStableKey:'partial',kind:'input',label:'项目名称',value:''};
const projectDescription={...partialProject,kind:'textarea',label:'项目描述',value:existingDescription};
const projectSources=[{name:'新项目',description:'新项目的独立交付内容'},
  {name:'城市分析项目',description:`项目背景：${existingDescription}\n成果：完成预测系统。`}];
assert.deepEqual(matchRecordSources([partialProject],[partialProject,projectDescription],projectSources,'name'),{0:1},
  '名称为空的已有记录使用描述证据绑定来源');
assert.deepEqual(matchRecordSources([partialProject],[partialProject,{...projectDescription,value:'无关的已有经历描述'.repeat(8)}],projectSources,'name'),{0:null},
  '无法确认的已有描述保留为身份冲突');
const ongoingProject={...partialProject,value:'合成工具项目'};
const ongoingSources=[{name:'合成工具项目',role:'独立开发者',startDate:'2026-09',endDate:'至今'}];
const projectRole={...ongoingProject,label:'职务',value:'独立开发者'};
const projectStart={...ongoingProject,label:'开始时间',value:'2026-09-01'};
assert.deepEqual(matchRecordSources([ongoingProject],[ongoingProject,projectRole,projectStart],ongoingSources,'name'),{0:0},
  '项目职务使用 role，日期身份按双方共有精度核对');
assert.deepEqual(matchRecordSources([ongoingProject],[ongoingProject,projectRole,{...projectStart,value:'请选择'}],ongoingSources,'name'),{0:0},
  '空日期提示不参与记录身份判断');
assert.deepEqual(matchRecordSources([ongoingProject],[ongoingProject,{...projectRole,value:'另一职务'}],ongoingSources,'name'),{0:null},
  '明确不同的项目职务保留冲突');
const nameAnchors=anchors.map(el=>({...el,operations:['TYPE_TEXT']}));
const fullControls=[...nameAnchors,...dates,{index:'f7_role',frameId:7,recordIndex:0,kind:'input',label:'职位名称',value:'',operations:['TYPE_TEXT']}];
assert.ok(buildActionPlan(fullControls,{internship:records},[],{title:'实习经历',dataBlock:'internship',recordScope:true,recordIndex:1})
  .actions.some(action=>action.target==='f7_role' && action.resumeField==='internship[1].position'));
const owner={index:'f7_1',frameId:7,section:'个人信息',stableKey:'f7:doc:field'};
const popups=[{index:'f7_2',frameId:7,context:'popup',popupOwnerKey:owner.stableKey},
  {index:'f8_1',frameId:8,context:'popup',popupOwnerKey:'f8:doc:field'},
  {index:'f7_3',frameId:7,context:'popup',popupOwnerKey:'f7:doc:other'}];
assert.deepEqual(scopeControls([owner,...popups],{section:'个人信息',ownerKey:owner.stableKey}),[owner,popups[0]]);
assert.deepEqual(scopeControls([owner,...popups],{section:'个人信息'}),[owner]);
const modalFields=[{...owner,index:'underlying',surfaceId:'root'},
  {...owner,index:'modal',surfaceId:'editor'},
  {...owner,index:'navigation',kind:'section-entry',surfaceId:'root'}];
assert.deepEqual(scopeControls(modalFields,{section:'个人信息',editorSurfaceId:'editor'}),modalFields.slice(1),
  '编辑器只暴露自身字段及外层导航');
const wrongEditor=buildActionPlan([...nameAnchors.slice(0,1),dates[0],
  {index:'summary',kind:'textarea',label:'工作描述',value:'',operations:['TYPE_TEXT']}],{internship:records},[],
  {title:'实习经历',dataBlock:'internship',recordScope:true,recordEditor:true,recordIndex:0});
assert.ok(wrongEditor.summary.recordConflict,'同公司不同日期的编辑器保持身份冲突');
assert.ok(!wrongEditor.actions.some(action=>['TYPE_TEXT','BIND_FIELD'].includes(action.operation)));
const freshEditor=buildActionPlan([nameAnchors[0],
  {index:'summary',kind:'textarea',label:'工作描述',value:'',operations:['TYPE_TEXT']}],{internship:records},[],
  {title:'实习经历',dataBlock:'internship',recordScope:true,recordEditor:true,recordIndex:0});
assert.ok(!freshEditor.summary.recordConflict,'新建编辑器尚未填写日期时保持调度器已选来源');
assert.equal(recordOutcome({hasData:true,recognized:false}).status,'recognition-gap');
assert.equal(recordOutcome({hasData:false}).status,'data-gap');
assert.equal(recordOutcome({hasData:true,recognized:true,filled:true}).status,'filled');
assert.equal(recordOutcome({hasData:true,recognized:true,filled:true,saveRequested:true,editorClosed:true}).status,'save-unverified');
assert.equal(recordOutcome({hasData:true,recognized:true,saveRequested:true,editorClosed:true,saveEvidence:true}).status,'saved');
assert.equal(recordOutcome({hasData:true,recognized:true,filled:true,errors:['必填错误']}).completed,false);
assert.equal(recordOutcome({hasData:true,recognized:true,conflicts:['身份冲突']}).status,'record-conflict');
assert.equal(savedRecordEvidence([{section:'其他',summaryText:'同名公司 2025-01-01 2025-06-01'}],
  {section:'实习经历',record:records[0]}),false);
assert.equal(savedRecordEvidence([{section:'实习经历',summaryText:'同名公司 2025-01-01 2025-06-30'}],
  {section:'实习经历',record:records[0]}),false,'完整日期出现时逐日核验');
assert.equal(savedRecordEvidence([{section:'实习经历',summaryText:'同名公司 2025年1月 2025年6月'}],
  {section:'实习经历',record:records[0]}),true,'年月显示按页面实际精度核验');
const memory=createRunMemory();
memory.attempts.set('same-field',3);
assert.equal(memory.attempts.get('same-field'),3,'字段执行器共享调度器创建的预算对象');

const dom=new JSDOM('<h2>个人信息</h2><label>邮箱<input id="email"></label><label>邮箱<input id="second"></label>',
  {url:'https://example.test/resume',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;
w.HTMLElement.prototype.getBoundingClientRect=()=>({width:180,height:30,top:0,left:0,right:180,bottom:30});
let handler;
w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage(){}}};
for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) w.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
const snapshot=()=>new Promise(resolve=>handler({type:'SNAPSHOT_FULL'},{},resolve));
const before=await snapshot();
const first=before.elements.filter(el=>el.kind==='input')[0];
const label=w.document.createElement('label');label.innerHTML='邮箱<input id="inserted">';
w.document.getElementById('email').parentElement.before(label);
const after=await snapshot();
assert.equal(after.elements.find(el=>el.stableKey===first.stableKey)?.index,'2','插入同标签字段改变索引，已有控件身份保留');
const editor=w.document.createElement('div');editor.className='el-dialog';editor.innerHTML='<h2>教育经历</h2><form><label>学校名称<input></label><label>开始时间<input></label><button>保存</button></form>';
w.document.body.append(editor);
const editorSnapshot=await snapshot();
assert.equal(editorSnapshot.page.editorSurface,true);
assert.equal(editorSnapshot.page.activeSection,'教育经历');
assert.ok(editorSnapshot.elements.filter(el=>el.label==='学校名称'||el.label==='开始时间').every(el=>el.context!=='popup'),
  '记录编辑器字段与选择器弹层使用不同归属');
assert.ok(editorSnapshot.elements.filter(el=>el.label==='学校名称'||el.label==='开始时间')
  .every(el=>el.surfaceId===editorSnapshot.page.editorSurfaceId),'编辑器内 form 共享所属弹窗身份');
dom.window.close();
console.log('Stable identities, compound matching, transaction ownership and honest completion states passed');
