import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildObservedActionPlan,observedValueMatches} from '../lib/observed-interaction.js';
import {sourceContracts,interactionAttemptKey,collectionSummary} from '../lib/source-contracts.js';
import {listBlockChoiceFields,choose,buildQuestions} from '../lib/jev-client.js';
import {recordSurfaces} from '../lib/goal-state.js';
import {hasCommittedValue} from '../lib/action-policy.js';
import {createPageExecutor} from '../background/page-executor.js';

for(const prefix of ['atsx','renamed','feishu']) {
  const row=(label,control)=>`<div class="${prefix==='renamed'?'form-item':'atsx-form-item'}"><div class="${prefix}-label"><label>${label}</label></div><div>${control}</div></div>`;
  const module=(title,body)=>`<div class="${prefix}-module"><div>${title}</div><div><div class="records"><div class="record">${body}</div></div></div></div>`;
  const internship=row('单位名称','<input value="合成单位甲">')+row('工作描述','<textarea></textarea>');
  const dom=new JSDOM(`<main>${module('实习经历',internship)}
    ${module('能力展示与自我评价',row('语言能力','<textarea></textarea>')+row('科研成果','<textarea></textarea>'))}
    ${module('其他信息',row('预计毕业日期','<input placeholder="YYYY-MM">')+row('备注','<span role="note">请从高中填起，各阶段教育经历务必填写完整</span><input>'))}
    ${module('个人形象',row('照片','<div role="button" aria-label="照片">'+'<div>'.repeat(9)+'<input type="file" style="display:none">'+'</div>'.repeat(9)+'</div>'))}
    ${module('教育经历',row('起止时间','<span role="note">无准确的毕业时间可填写预计毕业时间</span><input placeholder="YYYY-MM">')+
      row('学校名称','<div role="combobox" aria-expanded="true"><input aria-autocomplete="list" value="合成大学"></div>'))}
    </main>`,{runScripts:'dangerously',pretendToBeVisual:true,url:prefix==='feishu'?'https://example.jobs.feishu.cn/resume/apply':'https://unseen.example/resume'});
  const {window}=dom;
  window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
  const listeners=[];window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.()}};
  for(const file of ['widget-drivers.js','platform-drivers.js','content.js']) window.eval(readFileSync(new URL(`../content/${file}`,import.meta.url),'utf8'));
  const ask=msg=>new Promise(resolve=>listeners[0](msg,{},resolve));
  let snap=await ask({type:'SNAPSHOT_FULL'});
  for(const [field,title] of [['语言能力','能力展示与自我评价'],['预计毕业日期','其他信息'],['学校名称','教育经历']]) {
    assert.equal(snap.elements.find(c=>c.label===field)?.section,title,`${prefix}: 物理模块决定字段边界`);
  }
  assert.equal(snap.elements.find(c=>c.kind==='file')?.section,'个人形象','隐藏上传 input 的单字段模块保持独立分区');
  assert.equal(snap.elements.filter(c=>c.label==='照片').length,1,'上传入口与隐藏输入合并为唯一逻辑字段');
  assert.ok(!snap.elements.some(c=>c.value?.includes('请从高中填起') || c.value?.includes('无准确的毕业时间')),'说明保持帮助身份');
  const school=snap.elements.find(c=>c.label==='学校名称');
  assert.equal(school.valueCommitted,false,'学校检索文字保持未提交状态');
  const host=window.document.querySelector('[aria-autocomplete]').closest('[role="combobox"]');
  host.insertAdjacentHTML('beforeend','<span class="search-field-mirror">合成大学</span>');
  const mirrored=await ask({type:'SNAPSHOT_FULL'});
  assert.equal(mirrored.elements.find(c=>c.stableKey===school.stableKey)?.valueCommitted,false,'搜索宽度镜像文字继续保持未提交状态');
  host.insertAdjacentHTML('afterbegin','<span class="selected-value">合成大学</span>');
  const withSelection=await ask({type:'SNAPSHOT_FULL'});
  assert.equal(withSelection.elements.find(c=>c.stableKey===school.stableKey)?.label,'学校名称','适配器保留真实问题标题，选中值只作值');
  host.innerHTML='<ul role="listbox"><li aria-selected="true">合成已选中学</li><li class="search-inline"><input value=""><span class="search-mirror">旧搜索</span></li></ul>';
  host.setAttribute('aria-expanded','false');
  const inlineSelection=await ask({type:'SNAPSHOT_FULL'});
  assert.equal(inlineSelection.elements.find(c=>c.stableKey===school.stableKey)?.value,'合成已选中学',
    '关闭选择器内的已选标签保持根值，搜索输入与镜像独立');
  const choiceRow=window.document.createElement('div');
  choiceRow.className=prefix==='renamed'?'form-item':'atsx-form-item';
  choiceRow.innerHTML='<label>国籍</label><div role="combobox" aria-controls="owned-options"><span title="中国">中国</span><input style="display:none"></div>';
  window.document.querySelector('main').append(choiceRow);
  const stale=window.document.createElement('div');stale.setAttribute('role','listbox');
  stale.innerHTML='<button role="option">未婚</button><button role="option">已婚</button>';
  window.document.body.append(stale);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const closed=snap.elements.find(c=>c.label==='国籍');
  assert.equal(closed.value,'中国');
  await ask({type:'BEGIN_FIELD_TRANSACTION',index:closed.index});
  choiceRow.querySelector('input').style.display='block';
  const owned=window.document.createElement('div');owned.id='owned-options';owned.setAttribute('role','listbox');
  owned.innerHTML='<button role="option">中国</button><button role="option">其他国家<svg aria-label="caret-down"></svg></button>';
  window.document.body.append(owned);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const opened=snap.elements.filter(c=>c.label==='国籍' && c.context!=='popup');
  assert.equal(opened.length,1,'展示槽与搜索框共用单一逻辑字段');
  assert.equal(opened[0].stableKey,closed.stableKey,'展开后保留根字段身份');
  assert.equal(opened[0].value,'中国','内层空搜索框保持已有选择');
  assert.equal(opened[0].valueCommitted,true);
  assert.equal(snap.elements.find(c=>c.label==='其他国家')?.popupOwnerKey,closed.stableKey);
  assert.equal(snap.elements.find(c=>c.label==='其他国家')?.pickerBranch,false,
    '装饰箭头单独出现时保持普通选项');
  let expansions=0;
  owned.querySelector('[role=option]:last-child').innerHTML='<span role="button" aria-haspopup="tree"><svg aria-label="caret-down"></svg></span><span>其他国家</span>';
  owned.querySelector('[aria-haspopup]').addEventListener('click',()=>expansions++);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const branch=snap.elements.find(c=>c.label==='其他国家' && c.pickerBranch);
  await ask({type:'EXECUTE',action:'click',index:branch.index,optionIntent:'expand'});
  assert.equal(expansions,1,'父级选择命中同行的实际展开按钮，状态锚点继续使用父级名称');
  const leaf=window.document.createElement('li');leaf.setAttribute('role','treeitem');
  leaf.innerHTML='<span class="synthetic-tree-switcher synthetic-tree-switcher-noop"><svg aria-label="caret-down"></svg></span><span class="synthetic-tree-title">合成城市</span>';
  owned.append(leaf);
  let selectedCities=0;leaf.querySelector('.synthetic-tree-title').addEventListener('click',()=>selectedCities++);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const city=snap.elements.find(c=>c.label==='合成城市' && c.context==='popup');
  assert.equal(city.pickerBranch,false,'带装饰箭头的城市叶节点保持选择语义');
  await ask({type:'EXECUTE',action:'click',index:city.index});
  assert.equal(selectedCities,1,'城市选择命中内容文字，随后交由根字段回读验收');
  const selectableParent=window.document.createElement('li');selectableParent.setAttribute('role','treeitem');
  selectableParent.innerHTML='<span class="renamed-tree-switcher renamed-tree-switcher_open"><svg aria-label="caret-down"></svg></span><span class="renamed-tree-node-content-wrapper renamed-tree-node-content-wrapper-open"><span class="renamed-tree-title">合成可选父级</span></span><ul role="group"><li role="treeitem"><span class="renamed-tree-title">合成子级</span></li></ul>';
  owned.append(selectableParent);
  let parentSelections=0,parentExpansions=0;
  const parentSlot=selectableParent.querySelector('.renamed-tree-node-content-wrapper'),parentSwitch=selectableParent.querySelector('.renamed-tree-switcher');
  parentSlot.addEventListener('click',()=>parentSelections++);parentSwitch.addEventListener('click',()=>parentExpansions++);
  parentSlot.getBoundingClientRect=()=>({left:100,top:10,right:200,bottom:40,width:100,height:30});
  parentSwitch.getBoundingClientRect=()=>({left:10,top:10,right:30,bottom:40,width:20,height:30});
  snap=await ask({type:'SNAPSHOT_FULL'});
  const parent=snap.elements.find(c=>c.label==='合成可选父级' && c.context==='popup');
  assert.equal(snap.elements.filter(c=>c.label==='合成可选父级' && c.context==='popup').length,1,
    '标题、值槽与外层树节点合并为同一个可选对象');
  assert.equal(parent.pickerBranch,true,'有下级的可选节点保留真实展开能力');
  await ask({type:'EXECUTE',action:'click',index:parent.index,optionIntent:'select'});
  assert.equal(parentSelections,1);assert.equal(parentExpansions,0);
  await ask({type:'EXECUTE',action:'click',index:parent.index,optionIntent:'expand'});
  assert.equal(parentSelections,1);assert.equal(parentExpansions,1);
  if(parent.clickMode==='trusted-pointer') {
    assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:parent.index,optionIntent:'select'})).point.x,150);
    assert.equal((await ask({type:'TRUSTED_CLICK_POINT',index:parent.index,optionIntent:'expand'})).point.x,20,
      '真实点击与 DOM 点击共享同一意图和当前目标');
  }
  assert.equal(snap.elements.find(c=>c.label==='未婚')?.popupOwnerKey,undefined,'其他字段的常驻选项保持无归属');
  const lookupRow=window.document.createElement('div');lookupRow.className='atsx-form-item';
  lookupRow.innerHTML='<label>合成搜索字段</label><div role="combobox" aria-expanded="true" aria-controls="lookup-options"><input value="合成学校"><span class="search-mirror">合成学校</span></div>';
  window.document.querySelector('main').append(lookupRow);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const lookup=snap.elements.find(c=>c.label==='合成搜索字段');
  await ask({type:'BEGIN_FIELD_TRANSACTION',index:lookup.index});
  const lookupMenu=window.document.createElement('ul');lookupMenu.id='lookup-options';lookupMenu.setAttribute('role','listbox');
  lookupMenu.innerHTML='<li role="option"><span><span>合成学校</span></span></li>';
  lookupMenu.querySelector('li').addEventListener('click',()=>{
    lookupMenu.style.display='none';lookupRow.querySelector('[role=combobox]').setAttribute('aria-expanded','false');
  });
  window.document.body.append(lookupMenu);
  const lookupLayer=window.document.createElement('div');
  lookupLayer.className='searchInputComponent';lookupLayer.style.position='absolute';
  lookupLayer.innerHTML='<input placeholder="搜索学校"><span>选择学校</span>';
  window.document.body.append(lookupLayer);
  snap=await ask({type:'SNAPSHOT_FULL'});
  assert.ok(snap.elements.some(c=>c.stableKey===lookup.stableKey && c.context!=='popup'),
    '检索弹窗打开时保留外层根字段，维持字段事务归属');
  lookupLayer.remove();
  const lookupChoices=snap.elements.filter(c=>c.context==='popup' && c.label==='合成学校');
  assert.equal(lookupChoices.length,1,'同一个真实选项的嵌套文字只保留一个候选');
  await ask({type:'EXECUTE',action:'click',index:lookupChoices[0].index});
  snap=await ask({type:'SNAPSHOT_FULL'});
  assert.equal(snap.elements.find(c=>c.stableKey===lookup.stableKey)?.valueCommitted,true,
    '输入型选择器以选项点击、弹层关闭和根值共同回读');
  assert.equal(snap.elements.find(c=>c.stableKey===lookup.stableKey)?.value,'合成学校');
  const content=readFileSync(new URL('../content/content.js',import.meta.url),'utf8');
  window.eval(content.replace(/const CONTENT_SCRIPT_VERSION = '[^']+'/,
    "const CONTENT_SCRIPT_VERSION = 'synthetic-reloaded'"));
  const reloadedAsk=msg=>new Promise(resolve=>listeners.at(-1)(msg,{},resolve));
  const reloaded=await reloadedAsk({type:'SNAPSHOT_FULL'});
  assert.equal(reloaded.elements.find(c=>c.label==='合成搜索字段')?.valueCommitted,true,
    '同一文档更新观察器后，真实选项回执继续保护已有选择');
  window.eval(content);
  listeners[0]=listeners.at(-1);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const liveLookup=snap.elements.find(c=>c.label==='合成搜索字段');
  await ask({type:'BEGIN_FIELD_TRANSACTION',index:liveLookup.index});
  assert.equal((await ask({type:'SNAPSHOT_FULL'})).elements.find(c=>c.stableKey===liveLookup.stableKey)?.valueCommitted,false,
    '新的搜索事务清除旧选项回执');
  const freeformRow=window.document.createElement('div');
  freeformRow.className='form-item has-success';
  freeformRow.innerHTML='<label>自定义输入名称</label><div class="custom-select custom-select-combobox"><div role="combobox" class="custom-select-selection custom-select-selection--single"><input class="custom-select-search__field" value="合成自定义学校"><span class="custom-select-search__field__mirror">合成自定义学校</span></div></div>';
  window.document.querySelector('main').append(freeformRow);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const freeform=snap.elements.find(c=>c.label==='自定义输入名称');
  assert.equal(freeform.value,'合成自定义学校');
  assert.equal(freeform.valueCommitted,true);
  assert.equal(freeform.observed.commitEvidence.contract,'rc-select-freeform');
  assert.equal(freeform.observed.searchText,'','已验收自由输入与检索词分别提供');
  freeformRow.className='form-item has-error';
  assert.equal((await ask({type:'SNAPSHOT_FULL'})).elements.find(c=>c.label==='自定义输入名称')?.valueCommitted,false);
  const before=recordSurfaces(snap.elements.filter(c=>c.section==='实习经历'));
  assert.equal(before.length,1);const key=before[0].key;
  window.document.querySelector('.records').insertAdjacentHTML('beforeend',`<div class="record">${internship.replace('value="合成单位甲"','')}</div>`);
  snap=await ask({type:'SNAPSHOT_FULL'});
  const after=recordSurfaces(snap.elements.filter(c=>c.section==='实习经历'));
  assert.equal(after.length,2);assert.equal(after[0].key,key,'新增前后的第一条经历保留物理身份');
  window.close();
}
const resume={basics:{birthDate:'2000-10-10'},internship:[{startDate:'2026-07',endDate:'至今'}],
  awards:[{name:'合成奖甲',date:'2024-08',level:'全国',prize:'特等奖'},{name:'合成奖乙',date:'2023-11',level:'国家级',prize:'一等奖'}]};
const age=sourceContracts([],resume,'basics',0,{referenceDate:'2026-10-09'}).find(f=>f.contract==='derived-age');
assert.equal(age.value,'25');
const agePlan=buildObservedActionPlan([{index:'age',stableKey:'age',section:'个人信息',kind:'input',label:'年龄',value:'',operations:['TYPE_TEXT']}],resume,
  [{kind:'focus',controlStableKey:'age'}],{title:'个人信息',dataBlock:'basics',recordIndex:0});
assert.ok(agePlan.actions.some(a=>a.operation==='BIND_FIELD' && a.resumeField==='@derived:basics.age'));
assert.ok(!agePlan.actions.some(a=>a.operation==='BIND_FIELD' && a.resumeField==='basics.birthDate'),'年龄数值契约筛除完整日期');
assert.equal((await choose({actionPlan:agePlan})).decisionSource,'derived-age-contract','明确年龄契约在本机选择与执行');
const root={index:'date',stableKey:'date',section:'实习经历',kind:'feishu-date-range',label:'起止时间',value:'YYYY-MM - YYYY-MM',operations:['TYPE_TEXT']};
const history=[{kind:'focus',controlStableKey:'date'}],page={title:'实习经历',dataBlock:'internship',recordIndex:0};
let plan=buildObservedActionPlan([root],resume,history,page);
assert.equal(plan.actions.filter(a=>a.operation==='BIND_FIELD').length,1);
const binding=plan.actions.find(a=>a.operation==='BIND_FIELD');assert.equal(binding.semanticValue,'2026-07 - 至今');
for(const value of ['2026-07 - YYYY-MM','YYYY-MM - 2026-09','2026-07']) {
  assert.equal(hasCommittedValue({...root,value}),false,'日期范围以两个真实端点计算完成');
  const partial=buildObservedActionPlan([{...root,value}],resume,history,page);
  assert.ok(partial.actions.some(a=>a.operation==='BIND_FIELD' && a.resumeField.startsWith('@range:')),
    '部分已有日期继续进入补空候选');
}
assert.equal(hasCommittedValue({...root,value:'2026-07 - 至今'}),true);
{
  let clicks=0;
  const previousChrome=globalThis.chrome;
  globalThis.chrome={debugger:{attach:async()=>clicks++,sendCommand:async()=>clicks++,detach:async()=>{}}};
  const executor=createPageExecutor({sleep:async()=>{},sendToFrame:async()=>({ok:true,values:['2025-01','YYYY-MM']})});
  const result=await executor.executeField({tabId:1,frameId:0,local:'1',targetEntry:{kind:'feishu-date-range'},
    decision:{operation:'TYPE_TEXT'},execMsg:{value:'2026-07 - 至今'}});
  assert.equal(result.ok,false);
  assert.match(result.reason,/冲突/);
  assert.equal(clicks,0,'来源冲突在点击日期前退出，保留已有端点');
  globalThis.chrome=previousChrome;
}
assert.equal((await choose({actionPlan:plan})).decisionSource,'date-range-contract',
  '单一完整日期范围在本机绑定，以两个端点共同回读');
const schoolRange=buildObservedActionPlan([{...root,section:'教育经历',recordIndex:2}],
  {education:[{institution:'合成大学甲',startDate:'2025-09',endDate:'2026-11'},
    {institution:'合成大学乙',startDate:'2021-09',endDate:'2025-06'},
    {institution:'合成中学',studyType:'高中',startDate:'2018-09',endDate:'2021-06'}]},
  history,{...page,title:'教育经历',dataBlock:'education',recordIndex:2,recordScope:true});
assert.equal((await choose({actionPlan:schoolRange})).semanticValue,'2018-09 - 2021-06');
history.push({kind:'bind',controlStableKey:'date',resumeField:binding.resumeField});
plan=buildObservedActionPlan([root],resume,history,page);
const write=plan.actions.find(a=>a.operation==='TYPE_TEXT');assert.equal(write.resolvedValue,'2026-07 - 至今');
const attemptKey=interactionAttemptKey(write,[root]);history.push({attemptKey},{attemptKey});
assert.ok(!buildObservedActionPlan([root],resume,history,page).actions.some(a=>a.operation==='TYPE_TEXT'),'相同状态的失败动作有界退出');
assert.equal(observedValueMatches({...root,value:'2026-07 - 至今'},write.resolvedValue),true);
assert.equal(observedValueMatches({...root,value:'2026-07 - 2026-09'},write.resolvedValue),false);
const summaries=sourceContracts(listBlockChoiceFields(resume,'awards'),resume,'awards',0,{summaryScope:true});
const summary=summaries.find(f=>f.contract==='collection-summary');
const summaryRoot={index:'summary',stableKey:'summary',section:'自定义问答',kind:'textarea',label:'所获奖励名称及获得时间描述',operations:['TYPE_TEXT']};
const summaryPlan=buildObservedActionPlan([summaryRoot],resume,[{kind:'focus',controlStableKey:'summary'}],
  {title:'自定义问答',dataBlock:'awards',recordIndex:0,summaryScope:true});
assert.deepEqual(summaryPlan.actions.filter(action=>action.operation==='BIND_FIELD').map(action=>action.resumeField),
  ['@summary:awards','@summary:awards[0]','@summary:awards[1]'],
  '汇总契约提供全部与单条的事实组合，保留缺资料退出选项');
const scopeQuestions=buildQuestions('补齐已知内容',{decisionInstructions:'Choose a summary contract',
  actions:[{id:'summary',operation:'FILL_SUMMARY',target:'scope:summary',label:'汇总全部相关记录'}]});
assert.match(scopeQuestions.action.criteria.summary.target,/汇总全部相关记录/,
  '汇总动作提供完整含义，保持与其他编排动作同一描述协议');
assert.ok(buildQuestions('补齐已知内容',summaryPlan).action.instructions.rules.some(rule=>rule.includes('unprovided duration')),
  '多属性描述允许汇总已知事实，未提供属性保持未断言');
for(const expected of ['合成奖甲','2024-08','特等奖','合成奖乙','2023-11','一等奖']) assert.ok(summary.value.includes(expected));
assert.ok(collectionSummary([{name:'开发',items:['JavaScript','Python']}],'skills').includes('JavaScript、Python'),
  '汇总保留技能列表中的原始事实');
assert.equal(collectionSummary(['JavaScript'],'skills'),'1. JavaScript','标量列表保持完整值');
const nestedSkills=collectionSummary([{name:'编程',items:[{skill:'Python',level:''},{skill:'LangGraph',level:'了解'}]}],'skills');
assert.ok(nestedSkills.includes('技能：Python') && nestedSkills.includes('技能：LangGraph；熟练程度：了解'),
  '嵌套技能条目与明确熟练度完整进入描述汇总');
assert.ok(!nestedSkills.includes('熟练程度：；'),'缺失属性保持省略');
const photoRoot={index:'photo',stableKey:'photo',section:'个人形象',label:'个人照片',kind:'file',value:'已上传照片',operations:['UPLOAD_FILE']};
const photoSource={basics:{photo:{name:'synthetic.png',type:'image/png',dataUrl:'data:image/png;base64,AA=='}}};
const photoHistory=[{kind:'bind',controlStableKey:'photo',resumeField:'basics.photo'},
  {kind:'upload_file',controlStableKey:'photo',resumeField:'basics.photo',text:'synthetic.png',verified:true}];
const photoPage={title:'个人形象',dataBlock:'basics',recordIndex:0};
assert.equal(buildObservedActionPlan([photoRoot],photoSource,photoHistory,photoPage).summary.fieldGroups[0].status,'satisfied',
  '网站照片预览与同次上传回执共同验收，保持单次上传');
assert.notEqual(buildObservedActionPlan([{...photoRoot,value:''}],photoSource,photoHistory,photoPage).summary.fieldGroups[0].status,'satisfied',
  '照片预览被清空后重新列为待核对');
const menuRoot={index:'city',stableKey:'city',section:'个人信息',label:'所在地点',kind:'custom-select',value:'',operations:['CLICK']};
const menuOptions=Array.from({length:301},(_,i)=>({index:`option-${i}`,stableKey:`option-${i}`,label:`合成选项${i}`,
  context:'popup',popupOwnerKey:'city',kind:'option-item',operations:['CLICK']}));
const menuHistory=[{kind:'focus',controlStableKey:'city'},{kind:'bind',controlStableKey:'city',resumeField:'basics.location.city'}];
const menuPage={title:'个人信息',dataBlock:'basics',recordIndex:0};
const menuResume={basics:{location:{city:'未知合成城市'}}};
{
  const places={basics:{location:{region:{province:'合成省',city:'合成市'}}}};
  const placeOptions=['合成省','合成市'].map((label,i)=>({index:`place-${i}`,stableKey:`place-${i}`,label:label.replace(/省$|市$/,''),
    context:'popup',popupOwnerKey:'city',kind:'option-item',operations:['CLICK']}));
  // 目标已可见时直接选择；仅上级可见时沿来源字段层级导航。
  places.basics.location.region.province='甲省';places.basics.location.region.city='乙市';
  placeOptions[0].label='甲';placeOptions[1].label='乙';
  const h=[{kind:'focus',controlStableKey:'city'},{kind:'bind',controlStableKey:'city',resumeField:'basics.location.region.city'}];
  const p=buildObservedActionPlan([menuRoot,...placeOptions],places,h,menuPage);
  assert.deepEqual(p.actions.filter(a=>a.addressStep).map(a=>a.label),['乙'],'省市后缀省略时选择唯一等价城市');
  assert.deepEqual(buildObservedActionPlan([menuRoot,placeOptions[0]],places,h,menuPage).actions
    .filter(a=>a.addressStep).map(a=>a.label),['甲'],'目标尚未出现时使用明确的结构化上级事实');
  h.push({kind:'click',resumeField:'basics.location.region.city',selectedLabel:'甲'});
  const next=buildObservedActionPlan([menuRoot,...placeOptions],places,h,menuPage);
  assert.deepEqual(next.actions.filter(a=>a.addressStep).map(a=>a.label),['乙']);
}
const seen=new Set();
for(let batch=0;batch<10;batch++) {
  const batchPlan=buildObservedActionPlan([menuRoot,...menuOptions],menuResume,menuHistory,menuPage);
  assert.ok(batchPlan.actions.length<=44,'长列表保持有界候选请求');
  assert.ok(JSON.stringify(buildQuestions('填入当前字段',batchPlan)).length<15000,'字段来源值在执行阶段保持单一上下文');
  batchPlan.actions.filter(a=>a.context==='popup').forEach(a=>seen.add(a.target));
  const more=batchPlan.actions.find(a=>a.operation==='OBSERVE_OPTIONS');
  if(!more) break;
  menuHistory.push({kind:'option-window',controlStableKey:'city',optionSignature:more.optionSignature,optionOffset:more.optionOffset});
}
assert.equal(seen.size,301,'全部真实选项通过前进窗口保持可达');
assert.ok(!buildObservedActionPlan([menuRoot,...menuOptions],menuResume,menuHistory,menuPage).actions.some(a=>a.operation==='OBSERVE_OPTIONS'),
  '最后窗口终结，保持退出操作');
const scrolledOptions=menuOptions.map(option=>({...option,observed:{scrollableAncestor:{top:500}}}));
assert.ok(!buildObservedActionPlan([menuRoot,...scrolledOptions],menuResume,menuHistory,menuPage).actions.some(a=>a.operation==='OBSERVE_OPTIONS'),
  '实际选项相同的滚动保持已检查窗口进度');
assert.ok(!buildObservedActionPlan([menuRoot,...scrolledOptions.slice().reverse()],menuResume,menuHistory,menuPage).actions.some(a=>a.operation==='OBSERVE_OPTIONS'),
  '视口内外的采集顺序变化保持选项窗口进度');
const lateExact=buildObservedActionPlan([menuRoot,...menuOptions],{basics:{location:{city:'合成选项300'}}},menuHistory.slice(0,2),menuPage);
assert.ok(lateExact.actions.some(a=>a.target==='option-300'),'精确事实匹配跨窗口提供');
console.log('Custom module regression: renamed modules, help values, school search, stable records, source contracts and bounded attempts passed');
