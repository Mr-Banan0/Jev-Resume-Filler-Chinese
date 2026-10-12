import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {actionPermission,choiceAlreadySelected,hasCommittedValue} from '../lib/action-policy.js';
import {blockPlan,createGoalLedger,entryPlan,fieldAudit,localViewPlan,observedGateControls,recordSurfaces,recordTypeAllowed,regionPlan} from '../lib/goal-state.js';
import {buildObservedActionPlan} from '../lib/observed-interaction.js';
import {choose,listBlockChoiceFields,prepareResume} from '../lib/jev-client.js';
const educationFacts=prepareResume({basics:{highestDegree:'硕士'},education:[
  {studyType:'硕士',studyMode:'全日制'},
  {studyType:'本科',studyMode:'全日制'},
  {studyType:'本科',studyMode:'全日制'}]}).education;
assert.equal(recordTypeAllowed('工作经历','internship',['工作经历','实习经历']),false,'分开的经历编辑器保持来源类型');
assert.equal(recordTypeAllowed('实习/工作经历','work',['实习/工作经历','工作经历']),true,'组合经历编辑器接受两种就业记录');
assert.equal(recordTypeAllowed('能力展示与自我评价','languages',['语言能力']),true,'复合问答可汇总其他资料块');
assert.equal(educationFacts[0].isPrimaryEducation,'是','同一学历阶段仅一条来源记录时可计算主学习经历');
assert.equal(educationFacts[1].isPrimaryEducation,'','同阶段多条经历保持主次事实待确认');
assert.equal(educationFacts[0].isFullTimeHighestEducation,'是');
const educationCatalogue=listBlockChoiceFields({education:[{isOverseasStudy:'是',isPrimaryEducation:'是'}]},'education',0);
assert.match(educationCatalogue.find(field=>field.path.endsWith('.isOverseasStudy')).label,/海外留学/);
assert.match(educationCatalogue.find(field=>field.path.endsWith('.isPrimaryEducation')).label,/主学习经历/);
assert.match(listBlockChoiceFields({campusPractice:[{organization:'合成班级'}]},'campusPractice',0)[0].label,/组织团体名称/);
const localTabs=['英语等级','英语证书','其他语种'].map((label,index)=>({index:`tab${index}`,stableKey:`tab${index}`,
  kind:'action',label,localView:true,viewSelected:index===0,operations:['CLICK']}));
assert.equal(localViewPlan(localTabs).actions.filter(action=>action.operation==='OPEN_VIEW').length,2);
assert.equal(localViewPlan([...localTabs,{kind:'input',label:'成绩',value:'分'}]).draftLocked,false);
assert.deepEqual(localViewPlan([...localTabs,{kind:'input',label:'成绩',value:'6.5'}]).actions.map(action=>action.operation),['KEEP_VIEW'],
  '已填草稿固定编辑类型，防止完成字段后继续切换并丢失内容');
assert.equal(hasCommittedValue({kind:'input',label:'户口所在地',value:'户口所在地',observed:{readonly:true}}),false);

const dom=new JSDOM(`<main><h1>简历编辑</h1>
  <div id="permanent-navigation" style="position:fixed"><span>基础信息</span><span>教育经历</span></div>
  <section><h3><span>基础信息</span><small>详尽的信息能让企业更快了解您</small><a href="#">编辑</a></h3>
  <div><h2>合成姓名</h2></div>
  <dl><dt>国籍 *</dt><dd><span id="country" onclick="this.nextElementSibling.style.height='100px'">请选择</span>
  <div style="position:absolute;height:0;overflow:hidden"><h5><span>已选择：</span><span>广东省</span><a href="#">×</a><span>广州市</span><a href="#">×</a><span>黄埔区</span><a href="#">×</a></h5><a href="#">中国</a><a href="#">其他</a><button onclick="this.parentElement.style.height='0px'">取消</button></div></dd></dl>
  <dl><dt>姓名 *</dt><dd><input value="合成姓名"></dd></dl><h5>上传照片</h5><input type="file"></section>
  <section><h3><span>实习经历</span><small>实践能力展示</small><a href="#">添加</a></h3>
  <dl><dt>是否有实习经历 * <input type="radio" name="hasIntern" value="1"> 是
  <input type="radio" name="hasIntern" value="0"> 否 <em>注：选择【是】，请务必添加数据，否则影响正常投递</em></dt></dl>
  <a href="#">+ 填写实习经历</a><div hidden><input type="file"></div></section>
  <section><h3>陌生自定义分区</h3><dl><dt>特别事实 <span style="cursor:pointer">?</span></dt><dd><input></dd></dl></section>
  <section><h3>已保存经历 <a href="#">编辑</a></h3><div>合成大学乙 2025-06-30</div>
  <div hidden><input value="草稿不属于保存摘要"></div></section>
  <section><h3>保存事务</h3><dl><dt>名称</dt><dd><input></dd></dl><a href="javascript:saveRecord()">保存</a></section>
  <button>保存并提交</button></main>`,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://synthetic.example/resume'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=function(){const height=this.style.height==='0px' ? 0 : 30;
  return {left:10,top:10,right:110,bottom:10+height,width:100,height};};
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.()}};
for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
const ask=msg=>new Promise(resolve=>listeners[0](msg,{},resolve));
let snap=await ask({type:'SNAPSHOT_FULL'});
const country=snap.elements.find(c=>c.label==='国籍');
assert.ok(!snap.elements.some(c=>c.label==='中国'),'零高度裁切层中的选项保持不可见');
assert.ok(country,'无 ARIA 的显示槽进入观察');
assert.equal(country.section,'基础信息');
assert.equal(snap.elements.find(control=>control.label==='编辑')?.section,'基础信息',
  '个人姓名展示标题保持在带编辑入口的原分区中');
assert.equal(country.clickMode,'trusted-pointer','无原生语义的展示槽由浏览器指针激活');
const scriptSave=snap.elements.find(c=>c.section==='保存事务' && c.label==='保存');
assert.equal(scriptSave.clickMode,'trusted-pointer','脚本链接通过浏览器通道激活页面默认动作');
assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:scriptSave.index})).ok,true);
assert.equal(snap.elements.filter(c=>c.kind==='file').length,1,'折叠记录中的上传控件保持隐藏');
assert.ok(snap.elements.find(c=>c.section==='已保存经历' && c.label==='编辑')?.summaryText.includes('合成大学乙'));
assert.ok(!snap.elements.find(c=>c.section==='基础信息' && c.label==='编辑')?.summaryText,'编辑中的草稿保持独立于保存摘要');
const existing=snap.elements.find(c=>c.section==='已保存经历' && c.label==='编辑');
const add={...existing,index:'add',stableKey:'add',label:'添加',summaryText:undefined};
const entries=entryPlan([existing,add],{title:'已保存经历',attemptedEntries:new Set()},
  {adding:true,records:[{institution:'合成大学乙',endDate:'2025-06-30'}],available:[0]});
assert.equal(entries.actions.length,1,'先核对尚未检查的已有记录');
assert.equal(entries.actions[0].operation,'OPEN_EDITOR');
assert.equal(entryPlan([existing,add],{title:'已保存经历',attemptedEntries:new Set()}).actions[0].target,existing.index,
  '首次进入已有摘要区域时先检查已有记录，随后按未处理来源新增');
assert.ok(!snap.elements.some(c=>c.section==='上传照片'),'嵌套上传任务归属于基础信息');
const gates=snap.elements.filter(c=>c.kind==='radio');
assert.deepEqual(Array.from(gates,c=>c.optionLabel),['是','否']);
assert.ok(gates.every(c=>c.questionLabel==='是否有实习经历'));
assert.ok(gates.every(c=>actionPermission(c).allowed),'投递提醒保留为提示，不屏蔽前置开关');
assert.equal(observedGateControls(gates).length,2);
const personalQuestion=['是','否'].map((value,i)=>({index:`abroad${i}`,stableKey:`abroad${i}`,
  section:'基础信息',kind:'radio',label:'有无海外留学经历',questionLabel:'有无海外留学经历',
  optionLabel:value,choiceGroup:'abroad',checked:i===1,operations:['CLICK']}));
const personalControls=[{index:'personName',section:'基础信息',kind:'input',label:'姓名',value:'合成姓名',
  operations:['TYPE_TEXT']},...personalQuestion];
assert.equal(observedGateControls(personalControls).length,0);
const personalSurface=recordSurfaces(personalControls)[0];
assert.ok(personalQuestion.every(c=>personalSurface.controls.includes(c)),
  '个人信息中的有无问答保留在记录表面，可按用户确认事实修正');
const correctionSource={basics:{hasOverseasStudy:'是'},fillPolicy:{sitePolicies:[{host:'synthetic.example',
  corrections:[{question:'有无海外留学经历',sourceField:'basics.hasOverseasStudy'}]}]}};
const correctionPlan=buildObservedActionPlan(personalControls,correctionSource,
  [{kind:'focus',controlStableKey:'abroad0'}],{url:'https://synthetic.example/resume',title:'基础信息',
    dataBlock:'basics',recordControlKeys:personalSurface.controls.map(c=>c.stableKey || c.index)});
assert.ok(correctionPlan.actions.some(c=>c.operation==='CLICK' && c.label==='是'));
const expandedGate=[...gates,{index:'company',section:'实习经历',kind:'input',label:'公司',operations:['TYPE_TEXT']}];
assert.ok(recordSurfaces(expandedGate).every(s=>s.controls.every(c=>!gates.includes(c))),
  '题目明确指向当前经历区域的开关独立于重复记录');
const languageSection=window.document.createElement('section');
languageSection.innerHTML='<h3>语言证书</h3><dl><dt>是否有英语/其它外语能力 * <input type="radio" name="hasLanguage" checked> 是 <input type="radio" name="hasLanguage"> 否 <em>注：选择【是】，请务必添加数据，否则影响正常投递</em></dt></dl><dl><dt>证书名称</dt><dd><input value="IELTS"></dd></dl>';
window.document.body.append(languageSection);
const languageSnapshot=await ask({type:'SNAPSHOT_FULL'});
const languageControls=languageSnapshot.elements.filter(c=>c.section==='语言证书');
assert.ok(languageControls.filter(c=>c.kind==='radio').every(c=>c.regionGate),
  '页面明确要求选择后新增数据时，观察层保留区域前置开关身份');
assert.ok(recordSurfaces(languageControls).every(s=>s.controls.every(c=>c.kind!=='radio')),
  '分区标题与开关题目不同也能排除已展开的区域开关');
languageSection.remove();
const inlineQuestion=window.document.createElement('section');
inlineQuestion.innerHTML='<h3>额外问答</h3><dl><dt> </dt><dd><span>有无境外学习经历 <input type="radio" name="abroad">是 <input type="radio" name="abroad">否</span></dd></dl>';
window.document.body.append(inlineQuestion);
const inlineSnapshot=await ask({type:'SNAPSHOT_FULL'});
const inlineChoices=inlineSnapshot.elements.filter(c=>c.kind==='radio' && c.section==='额外问答');
assert.equal(inlineChoices.length,2);
assert.ok(inlineChoices.every(c=>c.questionLabel==='有无境外学习经历'),
  '空白 dt 时从单选控件之前的行内题目提取语义');
inlineQuestion.remove();
snap=await ask({type:'SNAPSHOT_FULL'});
const ledger=createGoalLedger(),regions=regionPlan(ledger,snap);
assert.ok(regions.actions.some(a=>a.section==='实习经历'));
assert.ok(regions.actions.some(a=>a.section==='陌生自定义分区'),'陌生区域具备检查资格');
assert.ok(!regions.actions.some(a=>a.section==='简历编辑'));
assert.ok(!snap.elements.some(c=>c.kind==='observed-field' && c.value==='?'),'帮助符号保留说明身份，空记录继续按空白表单识别');
const resume={basics:{name:'合成姓名'},internship:[{company:'合成单位'}],education:[{institution:'合成大学'}]};
assert.equal(blockPlan('陌生自定义分区',snap.elements.filter(control=>control.section==='陌生自定义分区'),resume,
  [...ledger.regions.values()].find(region=>region.title==='陌生自定义分区')).actions.filter(a=>a.dataBlock).length,3);
const routingRegion={closed:false,blocks:new Map(),routingClosed:new Set()};
const routingControls=['爱好与特长','外语类型及熟练程度描述','重要社会及学校活动及担任学生干部情况描述'].map((label,i)=>({
  label,index:`route${i}`,stableKey:`route${i}`,section:'合成复合区',kind:'textarea',value:'',operations:['TYPE_TEXT']}));
let routingPlan=blockPlan('合成复合区',routingControls,resume,routingRegion);
assert.deepEqual(routingPlan.routingTargets,['route0'],'一次路由只判断一个未核对问题');
routingRegion.routingClosed.add('route0');
routingPlan=blockPlan('合成复合区',routingControls,resume,routingRegion);
assert.deepEqual(routingPlan.routingTargets,['route1'],'无来源问题退出后继续本区其他问题');
routingRegion.blocks.set('basics','checked');
assert.ok(blockPlan('合成复合区',routingControls,resume,routingRegion).actions.some(action=>action.dataBlock==='basics'),
  '同一资料块可以供应本区的另一个问题');
routingRegion.routingAttempts=new Set(['route1|basics']);
assert.ok(!blockPlan('合成复合区',routingControls,resume,routingRegion).actions.some(action=>action.dataBlock==='basics'),
  '同一问题已经检查过的资料块退出候选');
routingRegion.routingClosed.add('route1');routingRegion.routingClosed.add('route2');
assert.equal(blockPlan('合成复合区',routingControls,resume,routingRegion).actions.length,0,'全部问题检查后关闭当前路由');
const photoRoute=blockPlan('合成复合区',[{...routingControls[0],kind:'file',label:'个人照片',operations:['UPLOAD_FILE']}],
  {...resume,basics:{photo:{name:'synthetic.png',dataUrl:'data:image/png;base64,AA=='}}},
  {closed:false,blocks:new Map(),routingClosed:new Set()});
assert.deepEqual(photoRoute.actions.filter(action=>action.dataBlock).map(action=>action.dataBlock),['basics'],
  '上传问题只提供本地确有附件的资料块，附件字节保持本地');
assert.deepEqual(photoRoute.dataCatalogue[0].fields,['photo'],'上传路由目录聚焦附件用途');
const diverseRecords=blockPlan('合成复合区',routingControls,
  {projects:[{name:'合成项目甲'},{name:'合成项目乙',deliveryEvidence:'合成成果'}]},
  {closed:false,routingClosed:new Set(),routingAttempts:new Set()});
assert.ok(diverseRecords.dataCatalogue.find(block=>block.block==='projects').fields.includes('deliveryEvidence'),
  '路由目录涵盖所有记录的字段，丰富的后续记录同样可见');
const gatePlan=buildObservedActionPlan(gates,resume,[{kind:'focus',controlStableKey:gates[0].stableKey}],{
  title:'实习经历',dataBlock:'internship',gateScope:true,recordIndex:0});
assert.ok(gatePlan.actions.some(a=>a.resumeField==='@presence:internship'));
const gateChoice=await choose({apiKey:'unused',goal:'检查已有实习资料的前置开关',page:{},elements:gates,
  history:[],resume,actionPlan:gatePlan});
assert.equal(gateChoice.resumeField,'@presence:internship','存在资料的前置开关由已选资料块的事实确定');
assert.equal(choiceAlreadySelected(gates[1],[{...gates[0],checked:true},gates[1]]),true);
assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:country.index})).ok,true);
await ask({type:'TRUSTED_CLICK_POINT',index:country.index});
window.document.getElementById('country').click();
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(snap.elements.some(c=>c.context==='popup' && c.label==='中国' && c.popupOwnerKey===country.stableKey),'匿名嵌套弹层具有字段归属');
assert.ok(snap.elements.find(c=>c.context==='popup' && c.label==='中国')?.popupSelection.includes('黄埔区'),
  '选择摘要按可见文字读取，标题类容器同样提供确认前证据');
assert.ok(snap.elements.find(c=>c.context==='popup' && c.label==='中国')?.popupSelection.startsWith('已选择：'),
  '分散在文本节点中的摘要保留冒号和完整层级');
assert.ok(!snap.elements.some(c=>c.context==='popup' && ['广东省','广州市','黄埔区','×'].includes(c.label)),
  '摘要中的地址文字与移除符号独立于可选列表');
await ask({type:'CLOSE_TRANSACTIONS'});
assert.equal((await ask({type:'TRANSACTION_STATE'})).open,false,'常驻固定导航不构成待关闭的选择器');
const birthday=window.document.createElement('section');
birthday.innerHTML='<h3>家庭成员</h3><dl><dt>出生日期</dt><dd><span id="birthday-trigger" style="cursor:pointer" onclick="this.nextElementSibling.hidden=false">请选择</span><div hidden style="position:absolute"><div><a href="javascript:;">&lt;</a><a href="javascript:;">&gt;</a><span>2020-2031</span></div><ul>'+Array.from({length:12},(_,i)=>`<li>${2020+i}</li>`).join('')+'</ul></div></dd></dl>';
window.document.body.append(birthday);
snap=await ask({type:'SNAPSHOT_FULL'});
const birthdayRoot=snap.elements.find(control=>control.section==='家庭成员' && control.label==='出生日期');
await ask({type:'TRUSTED_CLICK_POINT',index:birthdayRoot.index});
window.document.getElementById('birthday-trigger').click();
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(snap.elements.some(control=>control.context==='popup' && control.label==='<'),
  '年份列表与外层翻页按钮提供同一弹层的完整操作候选');
const birthdayHistory=[{kind:'focus',controlStableKey:birthdayRoot.stableKey},
  {kind:'bind',controlStableKey:birthdayRoot.stableKey,resumeField:'family[0].birthDate'}];
const birthdayPlan=buildObservedActionPlan(snap.elements,{family:[{birthDate:'1954-08-17'}]},birthdayHistory,{
  title:'家庭成员',dataBlock:'family',recordIndex:0,recordScope:true});
assert.ok(birthdayPlan.actions.some(action=>action.calendarStep && action.label==='<'),
  '来源年份早于可见范围时，生成确定的上一组导航事务');
assert.equal((await choose({apiKey:'unused',goal:'填写生日',page:{},elements:snap.elements,
  history:birthdayHistory,resume:{family:[{birthDate:'1954-08-17'}]},actionPlan:birthdayPlan})).label,'<');
birthday.remove();
await ask({type:'CLOSE_TRANSACTIONS'});
const notice=window.document.createElement('div');
notice.style.position='fixed';
notice.innerHTML='<h3>提示</h3><p>温馨提示：请及时保存填写的简历信息，避免丢失</p><a href="javascript:;">确认</a>';
notice.getBoundingClientRect=()=>({left:200,top:100,right:600,bottom:300,width:400,height:200});
window.document.body.append(notice);
snap=await ask({type:'SNAPSHOT_FULL'});
assert.equal(snap.elements.filter(control=>control.noticeDismissal).length,1,'非协议遮挡提示具有独立关闭动作');
assert.ok(snap.elements.every(control=>control.context==='popup'),'提示出现时观察只提供当前浮层');
notice.querySelector('p').textContent='请及时保存，并确认接受隐私协议';
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(!snap.elements.some(control=>control.noticeDismissal),'协议确认保留用户授权边界');
notice.querySelector('p').textContent='同一岗位请勿多渠道重复投递，如重复投递，将提示投递失败。';
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(snap.elements.some(control=>control.noticeDismissal),'告知重复申请的通知可关闭，不触发任何申请操作');
notice.querySelector('p').textContent='请确认提交简历。';
snap=await ask({type:'SNAPSHOT_FULL'});
assert.ok(!snap.elements.some(control=>control.noticeDismissal),'最终提交确认保持不可自动接受');
notice.remove();
snap=await ask({type:'SNAPSHOT_FULL'});
const submit=snap.elements.find(c=>c.label==='保存并提交');
assert.equal(actionPermission(submit).allowed,false);
const blank={index:'blank',stableKey:'blank',kind:'input',label:'待补',operations:['TYPE_TEXT']};
assert.equal(hasCommittedValue({...blank,value:'附件只支持zip和rar格式',observed:{readonly:true}}),false);
assert.equal(hasCommittedValue({...blank,value:'毕业论文请从题目、主题、研究方向等方面描述（500字以内）'}),false);
assert.equal(hasCommittedValue({...blank,value:'输入证件号码'}),false);
assert.equal(hasCommittedValue({...blank,value:'输入毕业院校名称'}),false);
assert.equal(hasCommittedValue({...blank,value:'输入数据的清洗与训练使模型准确率提高'}),true);
assert.equal(fieldAudit([blank],[{skipControlKey:'blank',reasonKind:'missing-data',reason:'资料未提供'}],{} )[0].status,'missing-data');
const upload=window.document.createElement('section');
upload.innerHTML='<h3>附加信息</h3><dl><dt>简历附件</dt><dd><input readonly value="fixture-cv.pdf"><span><input type="file"></span><b hidden>上传中...</b><em>上传成功</em></dd></dl>';
window.document.body.append(upload);
snap=await ask({type:'SNAPSHOT_FULL'});
const uploaded=snap.elements.find(c=>c.section==='附加信息' && c.kind==='file');
assert.equal(uploaded.value,'fixture-cv.pdf','已上传文件名可从同一字段的只读显示槽回读');
assert.equal(snap.elements.filter(c=>c.section==='附加信息' && c.label==='简历附件').length,1,
  '文件显示槽与真实上传输入作为同一个字段');
upload.querySelector('input[type="file"]').replaceWith(window.document.createElement('input'));
upload.querySelector('span input').type='file';
snap=await ask({type:'SNAPSHOT_FULL'});
assert.equal(snap.elements.find(c=>c.section==='附加信息' && c.kind==='file').stableKey,uploaded.stableKey,
  '网站替换上传 input 后，字段沿稳定容器保留身份');
dom.window.close();
console.log('Goal observation: dl captions, anonymous popup, gates, region coverage, missing-data and submission safety passed');
