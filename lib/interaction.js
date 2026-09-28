// Semantic operations shared by all pages. DOM mechanics remain in the executor.
export function interactionIntent(action) {
  if (action.intent) return action.intent;
  if (action.operation === 'TYPE_TEXT') return 'FILL';
  if (action.operation === 'UPLOAD_FILE') return 'UPLOAD';
  if (['DEFER_SECTION','EXIT_SECTION_MENU','STOP_FILL'].includes(action.operation)) return 'RETURN';
  if (action.operation === 'WORK_SECTION') return 'OPEN';
  if (/^(取消|返回|关闭|cancel|back)$/i.test(action.label || '')) return 'RETURN';
  if (/^(确定|确认|保存|添加|完成|save|confirm|done)$/i.test(action.label || '') && action.context === 'popup') return 'CONFIRM';
  if (action.operation === 'SELECT' || action.context === 'popup') return 'CHOOSE';
  if (action.operation === 'PICK_DATE') return 'FILL';
  return 'OPEN';
}

const normalized = value => String(value || '').replace(/\s/g,'').toLowerCase();
const region = value => normalized(value).replace(/特别行政区|自治区|自治州|省|市|区|县/g,'');
const confirmLabel = /^(确定|确认|完成|添加|选择|ok|confirm|done)$/i;
const returnLabel = /^(取消|返回|关闭|cancel|back|close)$/i;

// Only the currently observed choices determine the next step. A region may
// expose any subset of its path, or commit directly without a confirm button.
export function planObservedPopup({elements, field, history, matchesValue}) {
  const rawOptions = elements.filter(el => el.context === 'popup' &&
    el.operations?.includes('CLICK') && !el.disabled &&
    !/删除|移除|投递|提交申请|delete/i.test(el.label || ''));
  const options = rawOptions.filter((el,i)=>rawOptions.findIndex(peer=>
    normalized(peer.label)===normalized(el.label) && peer.calendarDate===el.calendarDate)===i);
  const last = history.at(-1);
  const sameTransaction = item => (field.path ? item.resumeField === field.path : item.formRule === field.formRule) &&
    (!field.controlStableKey || !item.controlStableKey || item.controlStableKey === field.controlStableKey);
  const transaction = [];
  for (let i=history.length-1;i>=0;i--) {
    const item=history[i];
    if (!sameTransaction(item)) break;
    transaction.unshift(item);
    if (item.context !== 'popup') break;
  }
  const selected = transaction.filter(item=>item.context==='popup' && item.kind==='click');
  const confirm = options.find(el=>confirmLabel.test(el.label.trim()));
  const cancel = options.find(el=>returnLabel.test(el.label.trim()));
  const actions=[];
  const add=(el,intent,extra={})=>actions.push({operation:'CLICK',intent,target:el.index,sourceTarget:el.index,
    resumeField:field.path,fieldLabel:field.label,formRule:field.formRule,label:el.label,
    kind:el.kind,context:'popup',controlStableKey:field.controlStableKey,
    resolvedValue:field.resolvedValue,value:field.value,...extra});
  const choices=options.filter(el=>!confirmLabel.test(el.label.trim()) && !returnLabel.test(el.label.trim()));
  const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(field.value || ''));
  const dateEditor = dateValue && elements.find(el=>el.context==='popup' && el.operations?.includes('TYPE_TEXT') &&
    /日期|时间|date/i.test(`${el.label} ${el.placeholder || ''}`));
  if (dateEditor && normalized(dateEditor.value)!==normalized(field.value)) {
    actions.push({operation:'TYPE_TEXT',intent:'FILL',target:dateEditor.index,sourceTarget:dateEditor.index,
      resumeField:field.path,fieldLabel:field.label,label:dateEditor.label,kind:dateEditor.kind,
      context:'popup',controlStableKey:field.controlStableKey,resolvedValue:field.value});
  } else if (dateValue) {
    const day=choices.find(el=>el.calendarDate===field.value);
    if (day) add(day,'CHOOSE',{calendarDate:field.value});
  }
  if (!actions.length) {
  if (field.pickerPath?.length) {
    const matched=choices.map(el=>({el,step:field.pickerPath.findIndex(part=>region(part)===region(el.label))}))
      .filter(item=>item.step>=0);
    const pickedSteps=selected.map(item=>Number.isInteger(item.pickerStep) ? item.pickerStep :
      field.pickerPath.findIndex(part=>region(part)===region(item.label)));
    const lastStep=Math.max(-1,...pickedSteps);
    const next=matched.filter(item=>item.step>lastStep).sort((a,b)=>a.step-b.step)[0];
    if (next && !next.el.checked) add(next.el,'CHOOSE',{pickerStep:next.step,pickerLeaf:next.step===field.pickerPath.length-1});
    else if (confirm && selected.length) add(confirm,'CONFIRM');
  } else {
    const sourceWebsite=(field.formRule==='recruitment-source' || field.path==='application.recruitmentSource') &&
      /官网/.test(String(field.value));
    const websiteChoices=sourceWebsite ? choices.filter(el=>/官网/.test(el.label) && !/学校|高校/.test(el.label)) : [];
    const exact=choices.filter(el=>normalized(el.label)===normalized(field.value));
    if (!exact.length && websiteChoices.length===1) exact.push(websiteChoices[0]);
    const matching=exact.length ? exact : choices.filter(el=>matchesValue(el,field.value));
    const selectedMatch=selected.some(item=>matchesValue(item,field.value));
    if (confirm && (selectedMatch || matching.some(el=>el.checked))) add(confirm,'CONFIRM');
    else for (const el of matching.filter(el=>!el.checked)) add(el,'CHOOSE');
    if (!actions.length && !selectedMatch) {
      const custom=choices.find(el=>/^professionalSkills\[\d+\]\.name$/.test(field.path || '') && /^其他技能$/.test(el.label) || /^(添加|手动输入|自定义).*(全称|名称|学校|专业)$/.test(el.label) &&
        (/\.institution$/.test(field.path) ? /学校/.test(el.label) : /\.area$/.test(field.path) && /专业/.test(el.label)));
      if (custom) add(custom,'OPEN',{resolvedValue:field.value});
    }
  }
  }
  if (!actions.length) {
    const editor=elements.find(el=>el.context==='popup' && el.operations?.includes('TYPE_TEXT') &&
      /搜索|检索|search|请输入专业名称|请输入学校/i.test(`${el.label} ${el.placeholder || ''}`));
    const searchValue=/\.area$/.test(field.path || '') ? String(field.value).replace(/[（(].*$/,'').trim() : field.value;
    if (editor && normalized(editor.value)!==normalized(searchValue)) actions.push({operation:'TYPE_TEXT',intent:'FILL',
      target:editor.index,sourceTarget:editor.index,resumeField:field.path,fieldLabel:field.label,
      label:editor.label,kind:editor.kind,context:'popup',controlStableKey:field.controlStableKey,resolvedValue:searchValue});
  }
  if (!actions.length && (field.formRule==='recruitment-source' || /^(?:application\.recruitmentSource|professionalSkills\[\d+\]\.level|languages\[\d+\]\.language|education\[\d+\]\.(?:studyType|degree|ranking)|basics\.(?:ethnicity|nationality|maritalStatus|idType))$/.test(field.path || ''))) {
    for (const el of choices.slice(0,24)) add(el,'CHOOSE',{semanticFallback:true,semanticValue:field.value});
  }
  if (!actions.length) {
    for (const el of choices.filter(el=>el.pickerBranch && !selected.some(item=>item.label===el.label))) {
      add(el,'OPEN',{semanticFallback:true,semanticValue:field.value});
    }
  }
  if (cancel) add(cancel,'RETURN',{cancelField:field.path,reason:'当前选择器未完成，返回上层后记录待处理'});
  else actions.push({operation:'RETURN',intent:'RETURN',target:'popup:return',resumeField:field.path,
    fieldLabel:field.label,formRule:field.formRule,cancelField:field.path,label:'返回当前字段',context:'popup',
    reason:'当前候选未匹配，关闭选择器并保留待处理'});
  return {actions,status:actions.some(action=>action.intent!=='RETURN')?'ready':'blocked',
    pickerField:field.path,cancelTarget:cancel?.index,
    summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
}
