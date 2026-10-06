// 调度、字段执行和回读共享同一组身份与状态规则。
const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const identityText = value => clean(value).replace(/[—–−\-_:：,，。()（）]/g,'');
const hash = value => {
  let a = 2166136261, b = 5381;
  for (const ch of value) { a = Math.imul(a ^ ch.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ ch.codePointAt(0); }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
};

export function sourceRecordId(block, record = {}, index = 0, records = []) {
  const identity = item => JSON.stringify(['institution','company','name','title','language','relationship',
    'number','position','organization','degree','certificate','level','birthDate','startDate','endDate','date'].map(key => clean(item?.[key])));
  const signature = identity(record);
  const duplicate = records.slice(0, index).filter(item => identity(item) === signature).length;
  return `${block}:${hash(signature)}:${duplicate}`;
}

export function recordLedgerKey(section, block, resume, index = 0) {
  const source = resume?.[block];
  const records = Array.isArray(source) ? source : [source || {}];
  return `${section}|${sourceRecordId(block, records[index] || {}, index, records)}`;
}

export function frameOf(control) {
  return control?.frameId ?? Number(String(control?.index || '').match(/^f(\d+)[:_]/)?.[1] || 0);
}

export function renderedRecordKey(control, position = control?.recordIndex ?? 0) {
  return [frameOf(control),control?.surfaceId || '',control?.recordStableKey || '',position].join(':');
}

export function bindRecordsByScope(anchors, elements, sources, identityKey, confirmed = {}) {
  const groups=new Map();
  for(const anchor of anchors) {
    const key=`${frameOf(anchor)}:${anchor.surfaceId || ''}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(anchor);
  }
  const bindings={};
  for(const local of groups.values()) {
    const localConfirmed={};
    local.forEach((anchor,ordinal)=>{
      const position=Number.isInteger(anchor.recordIndex)?anchor.recordIndex:ordinal;
      const key=renderedRecordKey(anchor,position);
      if(Object.hasOwn(confirmed,key)) localConfirmed[position]=confirmed[key];
    });
    const matches=matchRecordSources(local,elements,sources,identityKey,localConfirmed);
    local.forEach((anchor,ordinal)=>{
      const position=Number.isInteger(anchor.recordIndex)?anchor.recordIndex:ordinal;
      const key=renderedRecordKey(anchor,position);
      bindings[key]=Object.hasOwn(confirmed,key) ? confirmed[key] : matches[position];
    });
  }
  return bindings;
}

export function scopeControls(elements, {section, frameId, ownerKey, editorFrames=[], editorSurfaceId} = {}) {
  return (elements || []).filter(el => {
    if (frameId != null && frameOf(el) !== frameId) return false;
    if (el.context !== 'popup') return (!section || el.section === section) &&
      (!editorSurfaceId || el.surfaceId === editorSurfaceId || el.kind==='section-entry' || el.recordCommit) &&
      (!editorFrames.length || editorFrames.includes(frameOf(el)) ||
        el.recordCommit || /^(保存|取消|返回)$/.test(String(el.label || '').replace(/\s/g,'')) || el.kind==='section-entry');
    // 带归属的弹层严格绑定到打开它的字段；旧快照仅允许当前帧的选项。
    if (!ownerKey) return false;
    if (el.popupOwnerKey) return el.popupOwnerKey === ownerKey;
    const owner = (elements || []).find(item => item.stableKey === ownerKey || item.index === ownerKey);
    return owner ? frameOf(owner) === frameOf(el) && (!section || owner.section === section) :
      /^f\d+[:_]/.test(ownerKey) && frameOf({index:ownerKey}) === frameOf(el) && (!el.section || !section || el.section===section);
  });
}

export function matchRecordSources(anchors, elements, sources, identityKey, confirmed = {}) {
  const result = {};
  const blanks=[];
  const reserved=new Set(Object.values(confirmed).filter(Number.isInteger));
  for (const [ordinal, anchor] of anchors.entries()) {
    const position = Number.isInteger(anchor.recordIndex) ? anchor.recordIndex : ordinal;
    if(Object.hasOwn(confirmed,position)) { result[position]=confirmed[position]; continue; }
    const observed = clean(anchor.value);
    const peers = elements.filter(el => el.context !== 'popup' && el.section===anchor.section && frameOf(el) === frameOf(anchor) &&
      (anchor.recordStableKey ? el.recordStableKey === anchor.recordStableKey &&
        (!Number.isInteger(el.recordIndex) || el.recordIndex===position) : el.recordIndex === position));
    const description=peers.filter(el=>/描述|内容|职责|简介|description|summary/i.test(el.label || ''))
      .map(el=>identityText(el.value)).join('\n');
    const descriptions=peers.filter(el=>/描述|内容|职责|简介|description|summary/i.test(el.label || ''))
      .map(el=>identityText(el.value)).filter(value=>value.length>=40);
    if (!observed && !descriptions.length) { blanks.push(position); continue; }
    let candidates = sources.map((record, index) => ({record, index}))
      .filter(({record,index}) => !reserved.has(index) && (identityText(record[identityKey])===identityText(anchor.value) ||
        identityText(record[identityKey]).length>=12 && description.includes(identityText(record[identityKey])) ||
        (!observed && descriptions.some(value=>['description','summary','details'].some(key=>{
          const source=identityText(record[key]);
          return source.length>=40 && (source.includes(value) || value.includes(source));
        })))));
    for (const [key, label] of [['startDate', /开始|起始|入学|入职|start/i], ['endDate', /结束|毕业|离职|end/i],
      ['position', /职位|职务|position|job title/i]]) {
      const parts=peers.filter(el=>label.test(el.label || '') && clean(el.value) && !el.generatedDateDefault &&
        (!key.endsWith('Date') || /^(?:\d{4}|\d{1,2}(?:月)?$|至今|present)/i.test(evidenceText(el.value))));
      const year=parts.find(el=>/年份|year/i.test(el.label || ''))?.value;
      const month=parts.find(el=>/月份|month/i.test(el.label || ''))?.value;
      const value=key.endsWith('Date') && year && month ? `${year}-${String(month).padStart(2,'0')}` :
        parts.find(el=>!/(月份|month)/i.test(el.label || ''))?.value;
      if (!value) continue;
      const exact = candidates.filter(({record}) => {
        const source=key==='position' ? record.position || record.role : record[key];
        if (!key.endsWith('Date')) return clean(source)===clean(value);
        const expected=evidenceText(source),actual=evidenceText(value);
        return expected && actual && (expected.startsWith(actual) || actual.startsWith(expected));
      });
      if (exact.length) candidates = exact;
      else candidates = [];
    }
    // 同名经历以日期、职位消歧；证据不足的记录保留为冲突。
    result[position] = candidates.length === 1 ? candidates[0].index : null;
    for(const {index} of candidates) reserved.add(index);
  }
  for(const position of blanks) {
    const index=!reserved.has(position) && sources[position] ? position : sources.findIndex((_,i)=>!reserved.has(i));
    result[position]=index<0 ? null : index;
    if(index>=0) reserved.add(index);
  }
  return result;
}

export function recordPeers(anchor, elements) {
  return elements.filter(el=>el.context!=='popup' && el.section===anchor.section && frameOf(el)===frameOf(anchor) &&
    (anchor.recordStableKey ? el.recordStableKey===anchor.recordStableKey : el.recordIndex===anchor.recordIndex));
}

// 年份提交前记录同一日期组的空月份，后续回读识别网站生成的默认值。
export function dateDependencyCandidates(elements, resumeField, bindings = []) {
  if(!/\.year$/.test(resumeField || '')) return [];
  const binding=bindings.findLast(item=>item.kind==='bind' && item.resumeField===resumeField);
  const year=binding && elements.find(el=>el.context!=='popup' && el.datePart==='year' &&
    (el.stableKey || el.index)===binding.controlStableKey);
  if(!year || !Number.isInteger(year.dateSlot)) return [];
  return recordPeers(year,elements).filter(el=>el.datePart==='month' && el.dateSlot===year.dateSlot+1 && !clean(el.value))
    .map(el=>({controlStableKey:el.stableKey || el.index,resumeField:resumeField.replace(/\.year$/,'.month'),fromField:resumeField}));
}

export function observeDateDefaults(candidates, elements) {
  return candidates.flatMap(candidate=>{
    const control=elements.find(el=>el.context!=='popup' && (el.stableKey || el.index)===candidate.controlStableKey);
    return control && clean(control.value) ? [{...candidate,kind:'dependent-default',ownedValue:String(control.value)}] : [];
  });
}

export function addedRecordEvidence(elements, {section, mode, beforeElements=[]}) {
  const physicalKey=el=>el.recordStableKey ? `${frameOf(el)}:${el.surfaceId || ''}:${el.recordStableKey}` : null;
  const previous=new Set(beforeElements.filter(el=>el.section===section).map(physicalKey).filter(Boolean));
  let controls=elements.filter(el=>el.context!=='popup' && el.section===section &&
    (mode==='inline' ? physicalKey(el) && !previous.has(physicalKey(el)) : !['action','card','section-entry'].includes(el.kind)));
  if(mode==='inline' && new Set(controls.map(physicalKey)).size!==1) controls=[];
  const anchor=controls.find(el=>el.recordStableKey && ['input','textarea','custom-select','combobox'].includes(el.kind));
  return {recordKey:mode==='inline' && anchor ? renderedRecordKey(anchor) : null,
    defaults:controls.filter(el=>el.datePart && clean(el.value)).map(el=>({kind:'dependent-default',
      controlStableKey:el.stableKey || el.index,ownedValue:String(el.value),fromField:'ADD_RECORD'}))};
}

export function createRunMemory() {
  return {attempts:new Map(), fields:new Map(), historyByRecord:new Map()};
}

export function recordOutcome({hasData, recognized, filled, editorClosed, saveRequested, saveEvidence, errors = [], conflicts = [], pendingFields = [], decisionUnavailable = false}) {
  if (!hasData) return {status:'data-gap', completed:false};
  if (decisionUnavailable) return {status:'decision-pending', completed:false};
  if (conflicts.length) return {status:'record-conflict',completed:false};
  if (errors.length) return {status:'validation-failed', completed:false};
  if (pendingFields.length) return {status:'field-pending', completed:false};
  if (!recognized) return {status:'recognition-gap', completed:false};
  if (saveRequested) return saveEvidence && editorClosed ?
    {status:'saved', completed:true} : {status:'save-unverified', completed:false};
  return filled ? {status:'filled', completed:true} : {status:'pending', completed:false};
}

const normalizeDate = (_,year,month,day) => `${year}-${month.padStart(2,'0')}${day?`-${day.padStart(2,'0')}`:''}`;
const evidenceText = text => clean(text)
  .replace(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/g,normalizeDate)
  .replace(/(\d{4})[/\.\-](\d{1,2})(?:[/\.\-](\d{1,2}))?/g,normalizeDate);

export function recordEditorConflict(elements, record, identityKey, anchorPattern, history = []) {
  if(!record || !identityKey || !anchorPattern) return '';
  const normal=(elements || []).filter(el=>el.context!=='popup');
  const identity=normal.find(el=>anchorPattern.test(String(el.label || '').replace(/\s*[*＊]\s*$/, '').trim()) && clean(el.value));
  if(identity && record[identityKey] && clean(identity.value)!==clean(record[identityKey])) return '编辑器中的记录身份与当前资料不同';
  for(const [key,pattern] of [['startDate',/开始|起始|入学|入职|start/i],['endDate',/结束|毕业|离职|end/i]]) {
    if(!record[key] || history.some(item=>String(item.resumeField || '').endsWith(`.${key}`))) continue;
    const date=normal.find(el=>pattern.test(el.label || '') && /^\d{4}[-/.年]\d{1,2}[-/.月]?/.test(String(el.value || '')));
    if(date && !evidenceText(record[key]).startsWith(evidenceText(date.value))) return '编辑器中的日期与当前资料不同';
  }
  return '';
}

export function summarySourceIndices(text, records) {
  const observed=evidenceText(text);
  return records.flatMap((record,index)=>{
    const identity=record?.institution || record?.company || record?.title || record?.name || record?.language || record?.position;
    if(!identity || !observed.includes(clean(identity))) return [];
    const valid=['startDate','endDate','date'].every(key=>{
      if(!record[key]) return true;
      const wanted=evidenceText(record[key]);
      if(!/^\d{4}-\d{2}/.test(wanted)) return observed.includes(wanted);
      const dates=observed.match(/\d{4}-\d{2}(?:-\d{2})?/g) || [];
      return dates.some(date=>wanted===date || /^\d{4}-\d{2}$/.test(date) && wanted.startsWith(date));
    });
    return valid ? [index] : [];
  });
}

export function savedRecordEvidence(elements, {section, record, recordIndex, frameId} = {}) {
  if (!record) return false;
  const summaries = (elements || []).filter(el => el.section === section && el.context !== 'popup' &&
    (frameId == null || frameOf(el) === frameId) &&
    (el.summaryText || el.recordSummary || el.recordStableKey));
  return summaries.some(el => summarySourceIndices(el.summaryText || el.recordSummary || el.value,[record]).length===1);
}
