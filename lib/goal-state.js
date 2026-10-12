import {actionKey,actionPermission,alternativeChoiceSatisfied,choiceAlreadySelected,excludedByUser,userCorrection,hasCommittedValue,isEntryTarget,isValueTarget} from './action-policy.js';
import {listBlockChoiceFields,safeJevValue,sectionCollection} from './jev-client.js';
import {sourceRecordId,summarySourceIndices} from './traversal-state.js';
import {belongsToRegion,regionIdentity} from './page-scope.js';

const BLOCK_NAMES={basics:'个人基本信息、联系方式与个人介绍',education:'教育经历',internship:'实习经历',
  work:'正式工作经历',projects:'项目经历',awards:'获奖与荣誉',campusPractice:'校内职务、社会实践与志愿服务',
  languages:'语言能力与语言证书',certificates:'资格证书',patents:'专利',publications:'论文与专业论著',
  family:'家庭成员',application:'招聘来源、紧急联系人与明确的申请问答',expected:'求职意向与期望',
  skills:'技能分组（类别与成员）',professionalSkills:'专业技能（逐项名称与程度）',computerSkills:'计算机技能（逐项名称与程度）',profiles:'社交账号',interests:'兴趣爱好'};
const nonempty=value=>value!=null && value!=='' && (typeof value!=='object' ||
  (Array.isArray(value)?value.length:Object.values(value).some(nonempty)));
const hasAttachment=value=>Array.isArray(value) ? value.some(hasAttachment) :
  value && typeof value==='object' && !!(value.dataUrl || value.base64 || value.blob);

export function createGoalLedger() {
  return {regions:new Map(),records:new Map(),fields:new Map(),attempts:new Map(),events:[],stack:[]};
}

export function reconcileRegions(ledger,snapshot) {
  const regions=new Map(snapshot.elements.filter(c=>c.context!=='popup' && c.section &&
    (isValueTarget(c) || isEntryTarget(c))).map(c=>[regionIdentity(c),{id:regionIdentity(c),title:c.section}]));
  for(const frame of snapshot.page?.framePages || [snapshot.page]) {
    for(const field of frame?.observation?.unobservedFields || []) if(field.section) {
      const id=regionIdentity(field);regions.set(id,{id,title:field.section});
    }
  }
  for(const [id,region] of regions) if(!ledger.regions.has(id)) ledger.regions.set(id,{
    ...region,status:'ready',closed:false,blocks:new Map(),attemptedEntries:new Set(),routingClosed:new Set(),routingAttempts:new Set(),unresolved:[]});
  return ledger.regions;
}

// 本轮分区生命周期单向推进；终结后的结果留在账本中供只读报告使用。
export function closeRegion(region,status='checked') {
  if(region.closed) return region;
  region.closed=true;
  region.status=status;
  return region;
}

export function localRegion(snapshot,scope) {
  const region=typeof scope==='object' ? scope : {id:scope,title:scope};
  return snapshot.elements.filter(control=>belongsToRegion(control,region));
}

export function observedGateControls(controls) {
  const radios=controls.filter(control=>/radio/.test(`${control.kind} ${control.role}`) &&
    /^(?:是否有|有无)/.test(control.questionLabel || control.label || '') &&
    !choiceAlreadySelected(control,controls));
  // 前置开关表面尚无记录字段。个人信息里的履历问答继续按普通字段处理。
  const recordFields=controls.filter(control=>isValueTarget(control) &&
    !/radio|checkbox|file/.test(control.kind || '') && control.operations?.length);
  return recordFields.length===0 ? radios : [];
}

export function recordSurfaces(controls,{regionId=null}={}) {
  const groups=new Map();
  const pendingGates=new Set(observedGateControls(controls).map(actionKey));
  for(const control of controls) {
    const question=String(control.questionLabel || control.label || '').replace(/\s+/g,'');
    const section=String(control.section || '').replace(/\s+/g,'');
    // 已展开的区域开关以题目包含区域名称为证据；其余履历问答归入字段表面。
    const regionGate=control.regionGate || /radio/.test(control.kind || '') && /^(?:是否有|有无)/.test(question) &&
      section.length>=2 && question.includes(section);
    if(!isValueTarget(control) || !control.operations?.length || pendingGates.has(actionKey(control)) || regionGate) continue;
    const indexedPosition=Number.isInteger(control.recordIndex) ? control.recordIndex :
      String(control.recordStableKey || '').match(/:record:(\d+)$/)?.[1];
    const logicalKey=regionId && indexedPosition!=null ?
      `${control.frameId || 0}:${regionId}:record:${indexedPosition}` : null;
    const key=logicalKey || control.recordStableKey || `${control.frameId || 0}:${control.surfaceId || ''}:row:${control.recordIndex ?? 0}`;
    if(!groups.has(key)) groups.set(key,{key,controls:[],position:control.recordIndex ?? 0});
    groups.get(key).controls.push(control);
  }
  return [...groups.values()];
}

export function sourceRecords(resume,block) {
  const source=resume[block];
  return Array.isArray(source) ? source : source==null ? [] : [source];
}

export function recordTypeAllowed(title,block,titles) {
  const kinds=new Set(['education','internship','work','projects','awards','campusPractice','languages','certificates','patents','publications','family']);
  const expected=sectionCollection(title);
  const combined=/实习.*工作|工作.*实习/.test(title);
  const dedicated=titles.some(other=>other!==title && sectionCollection(other)===block &&
    !/实习.*工作|工作.*实习/.test(other));
  return combined || !kinds.has(expected) || !kinds.has(block) || expected===block || !dedicated;
}

export function sourceId(resume,block,index) {
  const records=sourceRecords(resume,block);
  return sourceRecordId(block,records[index],index,records);
}

// 明确且唯一的主名称由字面证据确认；同名记录与别名交给语义核验。
export function exactRecordIdentity(surface,records,index) {
  const normalize=value=>String(value || '').normalize('NFKC').replace(/[\s\p{P}]/gu,'').toLowerCase();
  const observed=new Set(surface.controls.filter(hasCommittedValue).map(control=>normalize(control.value)));
  const primaryKeys=['name','title','institution','company','certificate','organization','language'];
  const matches=records.map((record,position)=>{
    const names=primaryKeys.map(key=>record?.[key]).filter(value=>typeof value==='string' && value.trim());
    const suffixes=[record?.role,record?.position].filter(value=>typeof value==='string' && value.trim());
    const variants=[...names,...names.flatMap(name=>suffixes.map(suffix=>`${name} ${suffix}`))];
    return variants.some(value=>observed.has(normalize(value))) ? position : null;
  }).filter(position=>position!=null);
  if(matches.length!==1 || matches[0]!==index) return false;
  // The exact unique name identifies the record even when a previous write left a stale date.
  // Duplicate names remain ambiguous and continue through semantic identity verification.
  return true;
}

export function goalPlan(actions,instructions,extra={}) {
  actions=actions.map((action,index)=>({...action,id:`g${index+1}`}));
  return {actions,byId:Object.fromEntries(actions.map(action=>[action.id,action])),status:actions.length?'ready':'blocked',
    decisionInstructions:instructions,...extra};
}

export function regionPlan(ledger,snapshot) {
  reconcileRegions(ledger,snapshot);
  const actions=[...ledger.regions.values()].filter(region=>!region.closed && region.status==='ready').map(region=>{
    const controls=localRegion(snapshot,region);
    return {operation:'WORK_SECTION',section:region.title,regionId:region.id,target:`region:${region.id}`,label:region.title,
      value:`${controls.length} 个观察目标；${controls.filter(isValueTarget).length} 个已展开字段；${controls.filter(isEntryTarget).length} 个打开或新增入口`};
  });
  return goalPlan(actions,'Choose a resume region to inspect next. Prefer already expanded forms with empty fields, because other editors may depend on saving them. Every observed region is eligible, including unopened regions and yes/no gates. The controller will inspect its local controls after selection.');
}

export function blockPlan(title,controls,resume,region,url,{agreementConfirmed=false}={}) {
  if(region.closed) return goalPlan([],'This region is closed for the current run. Its unresolved items remain in the report.');
  const emptyTarget=controls.find(c=>isValueTarget(c) && actionPermission(c,'CLICK',{agreementConfirmed}).allowed &&
    !region.preservedRecordFields?.has(actionKey(c)) &&
    !region.routingClosed?.has(actionKey(c)) && !alternativeChoiceSatisfied(c,controls) &&
    (userCorrection(c,resume,url) || !hasCommittedValue(c) && !choiceAlreadySelected(c,controls)));
  const addEntry=controls.find(control=>isEntryTarget(control) && actionPermission(control).allowed &&
    !region.routingClosed?.has(actionKey(control)) &&
    /^(?:\+\s*)?(?:添加|新增|增加|add\b)/i.test(control.label || ''));
  const recordInventory=!emptyTarget && !!addEntry;
  const target=emptyTarget || addEntry;
  if(!target) return goalPlan([],'All currently observed fields and record entries have been checked for this region.');
  const actions=Object.keys(resume).filter(block=>block!=='fillPolicy' && nonempty(resume[block]) &&
    (!recordInventory || Array.isArray(resume[block]) && region.blocks.get(block)!=='checked') &&
    !region.routingAttempts?.has(`${actionKey(target)}|${block}`) && (target.kind!=='file' ||
      listBlockChoiceFields(resume,block).some(field=>hasAttachment(field.value)))).map(block=>({
    operation:'SELECT_DATA_BLOCK',dataBlock:block,section:title,target:`block:${block}`,
    label:BLOCK_NAMES[block] || block,kind:'data-block',
    value:`${sourceRecords(resume,block).length} 条资料`}));
  actions.push({operation:'NO_DATA_BLOCK',intent:'RETURN',target:'block:none',section:title,
    label:`当前问题“${target.label}”没有可用资料，继续检查本区其他问题`});
  return goalPlan(actions,
    (recordInventory ? 'Choose a block with applicable missing records for this repeated editor. ' :
      'Choose one block supplying the question in remaining_fields. ') +
    'Use the section title, neighboring fields and jsonCatalogue together. Employment, internships and projects are distinct; a combined employment/internship editor accepts internships. Dates belong to the same record as its name, role and description. A yes/no gate may request records not yet visible. Individual skill-name rows use atomic skills; category rows use grouped skills. Descriptive text may summarize partial known facts, including patents/publications as research achievements. Supplied attributes remain usable when other facts are missing. Filled controls provide context. Choose NO_DATA_BLOCK when every available block lacks relevant data for this question; other questions will be checked next.',
    {recordInventory,dataCatalogue:actions.filter(action=>action.dataBlock).map(action=>({block:action.dataBlock,
      label:action.label,records:sourceRecords(resume,action.dataBlock).length,
      // 目录描述资料结构；数组里的同类字段共享一个路径，记录内容在选中后完整提供。
      fields:[...new Set(listBlockChoiceFields(resume,action.dataBlock)
        .filter(field=>target.kind!=='file' || hasAttachment(field.value)).map(field=>
        field.path.slice(action.dataBlock.length).replace(/\[\d+\]/g,'[]').replace(/^\[\]\.?|^\./,'')))]})),
      routingInspect:emptyTarget && !region.routingInspected?.has(actionKey(emptyTarget)) &&
        ['custom-select','combobox','observed-field'].includes(emptyTarget.kind) &&
        emptyTarget.operations?.includes('CLICK') ? emptyTarget.index : null,
      routingOptions:controls.filter(control=>control.context==='popup' &&
        control.popupOwnerKey===actionKey(target)).map(control=>control.label),
      routingTargets:controls.filter(control=>actionKey(control)===actionKey(target) ||
      target.choiceGroup && control.choiceGroup===target.choiceGroup).map(actionKey),routingQuestion:target.label});
}

export function recordBindingPlan(surface,resume,block,available,{facts=false}={}) {
  return goalPlan(available.map(index=>({operation:'BIND_RECORD',recordIndex:index,target:`source:${index}`,
    label:`${block} 第 ${index+1} 条`,value:safeJevValue(sourceRecords(resume,block)[index] || {})})).concat([
    ...(!facts ? [{operation:'PRESERVE_UNRELATED_RECORD',intent:'RETURN',target:'record:unrelated',
      label:'网页已有记录明确属于其他经历，保持原状并检查后续记录'}] : []),
    {operation:'SKIP_RECORD',intent:'RETURN',target:'record:unknown',label:'当前网页记录的归属待核对'}]),
    facts ? 'Choose the source record supplying the requested attributes in this composite section. Highest-education questions use the highest education record, evidenced by degree, highest-education flag and dates. Existing personal values in this section describe the applicant, not the identity of an education record. Choose SKIP_RECORD only if no source record can supply a remaining field.' :
    'Match this observed webpage record to one source record using its values, names, dates, role and description. Specific conflicting identities disqualify a match: different examinations, schools, companies or projects are different records even when they share a language, degree or role. A generic shared language, record position or role alone supplies insufficient identity evidence. The source record must belong to this editor type. A different webpage position is acceptable. Existing values are preserved. Choose PRESERVE_UNRELATED_RECORD only when a specific identity clearly distinguishes this existing record from every supplied record. Choose SKIP_RECORD when evidence is ambiguous, including a grouped category matching several supplied member records.');
}

export function recordSourcePlan(resume,block,available) {
  return goalPlan(available.map(index=>({operation:'SELECT_SOURCE_RECORD',recordIndex:index,target:`source:${index}`,
    label:`${block} 第 ${index+1} 条`,value:safeJevValue(sourceRecords(resume,block)[index] || {})})).concat([
    {operation:'END_RECORDS',intent:'RETURN',target:'records:end',label:'剩余资料不属于当前编辑类型，返回分区'}]),
    'Choose one remaining source record that belongs to this region and editor type before creating or filling a blank record. A JSON block can include multiple kinds of activities: a campus-position editor accepts leadership posts, while volunteer service belongs to a social-practice editor. Use the observed title, fields and selected local tab. Choose END_RECORDS when remaining records are inapplicable to this editor. Existing record binding is handled separately.');
}

export function localViewPlan(controls) {
  const views=controls.filter(control=>control.localView && actionPermission(control).allowed);
  if(views.length<2) return goalPlan([],'');
  const filled=controls.some(control=>/^(?:input|textarea|richtext)$/.test(control.kind || '') && hasCommittedValue(control));
  const selected=views.find(control=>control.viewSelected);
  const actions=[{operation:'KEEP_VIEW',target:'view:current',label:`使用当前编辑类型：${selected?.label || '当前表面'}`}];
  if(!filled) for(const control of views.filter(view=>!view.viewSelected)) actions.push({
    operation:'OPEN_VIEW',target:control.index,label:`切换编辑类型：${control.label}`,controlStableKey:actionKey(control)});
  return goalPlan(actions,
    'Select the editor type matching the current JSON record before filling fields. Local tabs are mutually exclusive: switching may clear the current draft. KEEP_VIEW when the selected tab matches the source, including internship records on an internship tab. Language proficiency levels and named examination certificates can have different tabs. Filled drafts retain the current view; missing fields remain pending.',
    {viewCatalogue:views.map(view=>({label:view.label,selected:!!view.viewSelected})),draftLocked:filled});
}

export function entryPlan(controls,region,{adding=false,records=[],available=[]}={}) {
  if(region.closed) return goalPlan([],'This region is closed for the current run.');
  let entries=controls.filter(control=>isEntryTarget(control) && actionPermission(control).allowed &&
    !region.attemptedEntries.has(actionKey(control)));
  const localEntries=entries.filter(control=>control.kind!=='section-entry');
  if(localEntries.length) entries=localEntries;
  if(!adding) {
    const existing=entries.filter(control=>/编辑|修改|edit/i.test(control.label || '') && control.summaryText);
    if(existing.length) entries=existing;
  }
  if(adding) {
    const edits=entries.filter(control=>/编辑|修改|edit/i.test(control.label || '') &&
      (!control.summaryText || !summarySourceIndices(control.summaryText,records).length ||
        summarySourceIndices(control.summaryText,records).some(index=>available.includes(index))));
    entries=edits.length ? edits : entries.filter(control=>/添加|新增|增加|填写|add/i.test(control.label || ''));
  }
  return goalPlan(entries.map(control=>({
      operation:adding && /添加|新增|增加|填写|add/i.test(control.label || '')?'ADD_RECORD':'OPEN_EDITOR',
      target:control.index,label:control.label,kind:control.kind,
      controlStableKey:actionKey(control),section:region.title,
      value:control.summaryText || (adding?'打开一条尚未填写的经历，执行后重新识别内联、弹窗或独立编辑页':'打开本区域的编辑表面')})),
    'Choose an observed entry that opens the required record editor. Prefer a direct local add/edit entry over section navigation. The next observation verifies that fields really appeared.');
}

export function fieldAudit(controls,history,plan,{resume,url}={}) {
  return controls.filter(isValueTarget).map(control=>{
    const key=actionKey(control),skip=[...history].reverse().find(item=>item.skipControlKey===key);
    const group=plan.summary?.fieldGroups?.find(item=>item.targets.includes(control.index));
    const selected=choiceAlreadySelected(control,controls) || alternativeChoiceSatisfied(control,controls);
    const excluded=excludedByUser(control,resume,url);
    const status=excluded?'excluded-user':control.validationError?'blocked':group?.status==='satisfied'?'verified':
      selected||hasCommittedValue(control)?'preserved':!actionPermission(control).allowed?'protected':
      skip?skip.reasonKind==='missing-data'?'missing-data':'blocked':'uninspected';
    return {key,label:control.questionLabel || control.label,required:!!control.required,status,
      reason:excluded?'用户指定跳过':control.validationError || (status==='verified'?'字段值已回读':status==='preserved'?'已有值保持原状':skip?.reason || '字段尚未完成回读')};
  });
}
