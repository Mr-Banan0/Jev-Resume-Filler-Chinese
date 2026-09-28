// lib/jev-client.js — TypeSafe Jev API 客户端
// 代码构造完整的表单动作，Jev 在受限候选中选择下一步。

import { interactionIntent, planObservedPopup } from './interaction.js';

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const TRANSIENT_RETRY_STATUSES = new Set([429, 502, 503, 529]);
let jevUnavailableUntil = 0;

function retryDelay(attempt) {
  return new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
}

export function prepareResume(resume) {
  if (!resume) return resume;
  const skillItems=(resume.skills || []).flatMap(group=>(group.items || []).map(item=>({name:item.skill,level:item.level || '',category:group.name})));
  const englishLevels=(resume.languages || []).flatMap(language=>{
    const score=String(language.fluency || '').match(/雅思\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
    return score ? [{level:'雅思IELTS',score}] : [];
  });
  const patentNumbers=(resume.awards || []).flatMap(a=>{
    const number=a.title?.match(/专利号[：:]\s*([^）)]+)/)?.[1]?.trim();
    return number ? [{number}] : [];
  });
  const education=(resume.education || []).map(edu=>({
    ...edu,
    majorType:edu.majorType || (/计算机|测绘|地理|工程|科学|技术|建筑/i.test(`${edu.area || ''} ${edu.primaryDiscipline || ''} ${edu.degree || ''}`) ? '理工类' : '')
  }));
  const expected={...(resume.expected || {})};
  if (!expected.city && resume.basics?.location?.city) expected.city=resume.basics.location.city;
  const application={...(resume.application || {})};
  delete application.referralCode;
  if (!application.interviewSite && expected.city) application.interviewSite=expected.city;
  if (application.recruitmentSource && !application.recruitmentSourceDetail) {
    application.recruitmentSourceDetail=application.recruitmentSource;
  }
  const languages=(resume.languages || []).map(language=>{
    const raw=String(language.fluency || '');
    const ielts=Number(raw.match(/雅思\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] || 0);
    const siteFluency=language.siteFluency || (ielts >= 7 ? '熟练' : ielts >= 6 ? '良好' : /CET-6|六级/i.test(raw) ? '熟练' : raw);
    return {...language,siteFluency};
  });
  return { ...resume, application, expected, languages, basics:{ ...resume.basics,
    graduationDate:resume.basics?.graduationDate || education[0]?.endDate || '',
    achievements:resume.basics?.achievements || (resume.awards || []).map(a=>a.title).filter(Boolean).join('\n') },
    education,
    professionalSkills:resume.professionalSkills || skillItems,
    englishLevels:resume.englishLevels || englishLevels,
    computerSkills:resume.computerSkills || skillItems.filter(item=>/编程语言/.test(item.category)),
    patents:resume.patents?.length ? resume.patents : patentNumbers,
    awards:(resume.awards || []).filter(a=>!/(专利号|发明专利)/.test(a.title || '')).map(a=>({
      ...a, type:a.type || (/(大赛|竞赛|挑战赛|比赛)/.test(a.title || '')?'竞赛比赛':''),
      grade:a.grade || a.title?.match(/特等奖|一等奖|二等奖|三等奖|优秀奖/)?.[0] || '',
      details:a.details || a.title
    }))
  };
}

const NEXT_ACTION = `Choose one observed interaction in the current section or open popup.
OPEN enters a section, record, or field. FILL writes a bound local JSON field. CHOOSE selects an observed option.
CONFIRM commits the current editor. RETURN leaves a completed or blocked area. UPLOAD attaches the bound local file.
Keep the current record and field binding. Complete the open popup before working on another field.
Prefer a useful forward action; choose RETURN when the current area has no applicable forward action.
Judge only the provided options. The executor observes the page again after each action.`;

const SECTION_COLLECTIONS = {
  '申请信息':'application', '上传':'basics', '个人信息':'basics', '求职意向':'expected',
  '教育背景':'education', '教育经历':'education', '实习经历':'internship', '工作经历':'work',
  '实习/工作经历':'internship',
  '社会实习经历':'internship', '校内实践经历':'campusPractice', '项目经验':'projects', '项目经历':'projects',
  '语言能力':'languages', '获奖经历':'awards', '奖励':'awards', '技能特长':'skills',
  '专业技能':'professionalSkills', '计算机能力':'computerSkills', '英语等级':'englishLevels',
  '个人专利':'patents', '论文著作':'publications', '专业资格认证':'certificates',
  '培训经历':'training', '自我描述':'basics', '自我评价':'basics', '其他':'application',
  '校园活动经历':'campusPractice', '奖励荣誉':'awards', '附件':'basics',
  '其他信息':'application', '投递意向':'expected',
  '个人基本信息':'basics', '奖励活动':'awards', '社会实践经历':'campusPractice',
  '所获证书':'certificates', '证书':'certificates', '家庭关系':'family', '家庭情况':'family',
  '校内职务':'campusPractice', '英语能力':'languages', '附加信息':'application', '获奖情况':'awards'
};

const SECTION_RECORD_ANCHORS = {
  education:/^(学校|学校名称|学校全称|就读学校)$/,
  internship:/^(公司名称|单位名称|企业名称)$/,
  work:/^(公司名称|单位名称|企业名称)$/,
  projects:/^(项目描述|项目名称)$/,
  languages:/^(语言类型|语种)$/,
  awards:/^(奖项名称|奖励名称)$/,
  campusPractice:/^(实践内容|职务|组织名称)$/,
  family:/^(姓名|家属姓名|家庭成员姓名)$/
};

// 同一网页会给“教育背景”“教育经历”等同义标题；字段范围仍需保留现有的组合映射。
const SECTION_FIELD_PREFIXES = {
  '申请信息':['application','expected'],
  '其他信息':['application','basics'],
  '个人信息':['basics','education'],
  '工作经历':['work'], '实习/工作经历':['internship','work'],
  '技能特长':['skills','languages','professionalSkills','computerSkills','englishLevels']
};

export function sectionCollection(title) {
  return SECTION_COLLECTIONS[String(title || '').trim()] || '';
}

export function countRenderedRecords(title, controls) {
  const indexed = controls.filter(el => el.context !== 'popup' && Number.isInteger(el.recordIndex));
  if (indexed.length) return Math.max(...indexed.map(el => el.recordIndex)) + 1;
  const collection = sectionCollection(title);
  const anchor = SECTION_RECORD_ANCHORS[collection];
  const anchorCount = anchor ? controls.filter(el =>
    anchor.test(String(el.label || '').replace(/\s*\*\s*$/, '').replace(/^请(?:填写|输入|选择)/,'').trim()) ||
    anchor.test(String(el.placeholder || '').replace(/\s*\*\s*$/, '').replace(/^请(?:填写|输入|选择)/,'').trim())).length : 0;
  const yearControls = controls.filter(el => el.context !== 'popup' &&
    (String(el.placeholder || '').trim() === '年' || /^(?:入学|毕业|开始|结束|项目开始|项目结束|获奖)年份$/.test(String(el.label || '').trim()))).length;
  const dateCount = collection === 'awards' ? yearControls :
    ['education','internship','work','projects'].includes(collection) ? Math.floor(yearControls / 2) : 0;
  const editorPresent=collection && controls.some(el=>el.context!=='popup' &&
    el.operations?.some(op=>['TYPE_TEXT','PICK_DATE','SELECT'].includes(op)));
  return Math.max(anchorCount, dateCount, editorPresent ? 1 : 0);
}

// “添加一条”是一次需要验收的事务，而不是一次普通点击。网站可能直接追加一行、
// 打开弹窗、跳到独立编辑页，或根本没有响应。只有从页面证据确认模式后，调度器才
// 允许开始填写目标记录。
export function classifyRecordAddition({section, before, after}) {
  const controlsFor = snapshot => (snapshot?.elements || []).filter(el =>
    el.section === section && el.context !== 'popup');
  const editableCount = controls => controls.filter(el =>
    (el.operations || []).some(operation => ['TYPE_TEXT','SELECT','PICK_DATE','UPLOAD_FILE'].includes(operation))).length;
  const beforeControls = controlsFor(before);
  const afterControls = controlsFor(after);
  const beforeRendered = countRenderedRecords(section, beforeControls);
  const afterRendered = countRenderedRecords(section, afterControls);
  const beforeEditable = editableCount(beforeControls);
  const afterEditable = editableCount(afterControls);
  const urlChanged = String(before?.page?.url || '') !== String(after?.page?.url || '');
  const hasEditorCommands = afterControls.some(el => /^(保存|提交|确定|取消|返回)$/
    .test(String(el.label || '').replace(/\s/g,'')) && (el.operations || []).includes('CLICK'));
  const editorOpened = !!after?.page?.editorSurface ||
    (after?.page?.activeSection === section && hasEditorCommands && afterEditable > beforeEditable);

  if (afterRendered > beforeRendered) {
    return {mode:'inline', verified:true, beforeRendered, afterRendered, reason:'页面已追加新记录'};
  }
  if (urlChanged && afterEditable > 0) {
    return {mode:'route', verified:true, beforeRendered, afterRendered, reason:'已进入独立记录编辑页'};
  }
  if (editorOpened) {
    return {mode:'editor', verified:true, beforeRendered, afterRendered, reason:'已打开记录编辑器'};
  }
  return {mode:'failed', verified:false, beforeRendered, afterRendered,
    reason:'点击后未观察到新增记录、编辑器或独立编辑页'};
}

// 外层候选只描述当前页面可进入或可扩展的简历区域。它不携带任何其他 section 的字段，
// 由调用方在 Jev 选中后再建立局部字段计划。
export function buildSectionPlan(elements, resume, ledger = {}, page = {}) {
  const normal = [...(elements || [])]
    .filter(el => el.context !== 'popup' && el.section)
    .sort((a, b) => (a.domOrder ?? 0) - (b.domOrder ?? 0));
  const groups = new Map();
  for (const el of normal) {
    const title = String(el.section || '').trim();
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(el);
  }
  const activeControls = groups.get(page.activeSection) || [];
  const openRecordEditor = !!page.activeSection &&
    activeControls.some(el => el.kind === 'section-entry') &&
    activeControls.some(el => ['input','textarea','richtext','custom-select','combobox','date','native-select','file'].includes(el.kind) ||
      (el.operations || []).some(operation => ['TYPE_TEXT','SELECT','PICK_DATE'].includes(operation))) &&
    activeControls.some(el => /^(?:添加|保存)$/.test(String(el.label || '').replace(/\s/g, '')) &&
      (el.operations || []).includes('CLICK'));
  const actions = [];
  const add = action => actions.push({ ...action, id: `s${actions.length + 1}` });
  for (const [title, controls] of groups) {
    if (openRecordEditor && title !== page.activeSection) continue;
    const collection = sectionCollection(title);
    const source = collection ? resume?.[collection] : null;
    const records = title === '实习/工作经历' ?
      [...(resume?.internship || []), ...(resume?.work || [])] :
      Array.isArray(source) ? source : [];
    const hasSingletonData = !!source && !Array.isArray(source) &&
      Object.values(source).some(value => value !== '' && value != null && (!Array.isArray(value) || value.length));
    const localPlan = buildActionPlan(controls, resume, [], {title, allowAddRecords:false,scopedSection:true});
    const hasMappableControls = localPlan.actions.some(action => action.resumeField || action.formRule ||
      (openRecordEditor && page.activeSection === title && action.operation === 'CLICK' &&
        /^(保存|添加)$/.test(String(action.label || '').replace(/\s/g,'')) && action.kind !== 'card'));
    const sectionState = ledger[`${title}|*`] || {};
    if (sectionState.deferred) continue;
    const summaryOnly = page.activeSection === title && !controls.some(el=>
      el.operations?.some(op=>['TYPE_TEXT','SELECT','PICK_DATE'].includes(op))) &&
      !elements.some(el=>el.context==='popup');
    const summaryRecords = summaryOnly ? records.filter(record=>{
      const identity=record.institution || record.company || record.title || record.name || record.position || record.language;
      return identity && String(page.text || '').includes(identity);
    }).length : 0;
    const rendered = Math.max(countRenderedRecords(title, controls), sectionState.savedCount || 0, summaryRecords);
    const nextUnchecked=records.findIndex((_,i)=>!ledger[`${title}|${i}`]?.completed && !ledger[`${title}|${i}`]?.skipped);
    if (records.length && nextUnchecked < 0 && !openRecordEditor) continue;
    const activeRecordIndex = hasSingletonData ? 0 : openRecordEditor && Number.isInteger(sectionState.editorRecordIndex) ? sectionState.editorRecordIndex : openRecordEditor && page.activeSection === title ?
      Math.max(sectionState.savedCount || 0, rendered - 1) : nextUnchecked >= 0 && controls.some(el=>el.kind==='section-entry') ? nextUnchecked : rendered;
    const key = `${title}|${activeRecordIndex}`;
    const state = ledger[key] || {};
    const entry = controls.find(el => el.kind === 'section-entry' && (el.operations || []).includes('CLICK'));
    const addButton = controls.find(el => {
      const label = String(el.label || '').replace(/\s/g, '');
      return /^(?:\+|新增|添加|增加)/.test(label) && (el.operations || []).includes('CLICK');
    });
    const editButtons = controls.filter(el =>
      /(?:编辑|修改|完善)$/.test(String(el.label || '').replace(/\s/g, '')) &&
      (el.operations || []).includes('CLICK'));
    const summaryText=String(page.text || '').replace(/C\/C\+\+/g,'C++');
    const summarySources=summaryOnly ? records.map((record,index)=>({index,position:summaryText.indexOf(
      record.institution || record.company || record.title || record.name || record.position || record.language || '\u0000')}))
      .filter(item=>item.position>=0).sort((a,b)=>a.position-b.position) : [];
    const editBindings=summarySources.length===editButtons.length ? summarySources.map(item=>item.index) : [];
    if (summaryOnly && collection==='professionalSkills' && !editBindings.length) {
      const segments=summaryText.split('编辑').slice(0,editButtons.length);
      if (segments.length===editButtons.length) {
        const identities=records.map(record=>record.name);
        const known=segments.map(segment=>identities.findIndex(name=>name && segment.includes(name)));
        const used=new Set(known.filter(index=>index>=0));
        segments.forEach((segment,i)=>{
          let index=known[i];
          if(index<0 && /其他技能/.test(segment) && /--/.test(segment)) {
            index=records.findIndex((_,j)=>!used.has(j));
            if(index>=0) used.add(index);
          }
          editBindings[i]=index>=0 ? index : i;
        });
      }
    }
    const editSourceIndex=i=>editBindings.length===editButtons.length ? editBindings[i] : i;
    const editButton = editButtons.find((el,i)=>!ledger[`${title}|${editSourceIndex(i)}`]?.completed && !ledger[`${title}|${editSourceIndex(i)}`]?.skipped);
    const localLabels = controls.map(el => String(el.label || '').trim()).filter(Boolean).slice(0, 8).join('、');
    const localCount = records.length || (hasSingletonData ? 1 : 0);
    const summary = `${title}：网页 ${rendered || (controls.length ? 1 : 0)} 条，本地 ${localCount} 条，字段：${localLabels || '待读取'}，${state.status || '待处理'}`;
    const workAvailable = hasMappableControls && !state.completed && !state.workBlocked &&
      !sectionState.workBlocked && (state.workAttempts || 0) < 3;
    if (openRecordEditor && title === page.activeSection && !workAvailable) {
      const exit = controls.find(el => /^(取消|返回)$/.test(String(el.label || '').replace(/\s/g,'')) &&
        el.operations?.includes('CLICK'));
      if (exit) add({operation:'DEFER_SECTION',target:exit.index,section:title,recordIndex:activeRecordIndex,
        deferRecord:records.length > 1,
        label:`暂存待补清单并退出${title}`,kind:exit.kind,
        value:records.length > 1 ? '当前记录已无可填写动作；退出编辑器，将本条列为待补，继续检查其余记录' :
          '当前已无可填写动作；退出未完成编辑器，继续其他分区，本轮跳过此分区'});
      continue;
    }
    if (entry && !hasMappableControls && page.activeSection !== title) {
      if (!state.completed && !state.focusBlocked && !sectionState.focusBlocked) add({ operation:'FOCUS_SECTION', target:entry.index, sourceTarget:entry.index, label:title,
        section:title, collection, kind:entry.kind, value:summary, offscreen:!!entry.offscreen });
      continue;
    }
    if (page.activeSection === title && editButton && !hasMappableControls &&
        !state.focusBlocked && !sectionState.focusBlocked && !state.completed) {
      add({operation:'FOCUS_SECTION',target:editButton.index,sourceTarget:editButton.index,
        label:`编辑${title}`,section:title,collection,recordIndex:editSourceIndex(editButtons.indexOf(editButton)),kind:editButton.kind,value:summary,
        offscreen:!!editButton.offscreen});
      continue;
    }
    const nextMissing = !entry ? (records.length > rendered ? rendered : -1) : summaryOnly && (summarySources.length > 0 || rendered === 0) && summarySources.length === editButtons.length ? records.findIndex((_,i)=>
      !summarySources.some(item=>item.index===i) && !ledger[`${title}|${i}`]?.completed && !ledger[`${title}|${i}`]?.skipped) :
      records.findIndex((_,i)=>i>=rendered && !ledger[`${title}|${i}`]?.completed && !ledger[`${title}|${i}`]?.skipped);
    const needsMoreRecords = !!(collection && !state.addBlocked && !sectionState.addBlocked && !sectionState.editorPending &&
      nextMissing >= 0 && addButton && (!hasMappableControls || (!entry && (sectionState.workBlocked || state.workBlocked))));
    // 当前编辑器先完成填写和回读，下一次观察再决定是否新增记录。
    if ((hasMappableControls || (!entry && localCount)) && !state.completed && !state.workBlocked && !sectionState.workBlocked &&
        (state.workAttempts || 0) < 3 && !needsMoreRecords) add({ operation:'WORK_SECTION', target:`section:${title}`,
      label:title, section:title, collection, ledgerKey:key, recordIndex:entry ? activeRecordIndex : 0, kind:'section', value:summary });
    if (needsMoreRecords) add({ operation:'ADD_RECORD', target:addButton.index,
      sourceTarget:addButton.index, label:`添加${title}`, section:title, collection, recordIndex:nextMissing, kind:addButton.kind,
      value:`${summary}；填写资料中的第 ${nextMissing + 1} 条`, offscreen:!!addButton.offscreen });
  }
  if (!actions.some(action => action.operation === 'DEFER_SECTION')) {
    add({ operation:'EXIT_SECTION_MENU', target:'section:exit', label:'退出当前 section，重新扫描页面', kind:'virtual', value:'保留当前进度并重新读取可填写清单' });
  }
  add({ operation:'STOP_FILL', target:'section:stop', label:'结束本次填写', kind:'virtual', value:'不再执行页面操作' });
  return { actions, byId:Object.fromEntries(actions.map(action => [action.id, action])), status:actions.length ? 'ready' : 'done' };
}

// 由出生日期推算周岁：网申表单常直接问"年龄"，而简历里只有出生日期
function deriveAge(birthDate) {
  const m = String(birthDate || "").match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) return "";
  const year = parseInt(m[1], 10);
  const month = m[2] ? parseInt(m[2], 10) : 1;
  const day = m[3] ? parseInt(m[3], 10) : 1;
  const now = new Date();
  let age = now.getFullYear() - year;
  const beforeBirthday =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day);
  if (beforeBirthday) age -= 1;
  if (age < 0 || age > 120) return "";
  return String(age);
}

// 为日期字段派生 年/月/日 子字段：网申常用"年 + 月 + 日"三个独立控件
//   "2003-02"    → basics.birthDate.year = 2003, basics.birthDate.month = 2
//   "至今"        → xxx.endDate.isPresent = 是（对应"至今"勾选项）
function addDateFields(out, path, label, value) {
  const v = String(value || "").trim();
  if (!v) return;
  if (v === "至今") {
    out[`${path}.isPresent`] = `${label}-至今 (是)`;
    return;
  }
  const m = v.match(/^(\d{4})(?:[-./](\d{1,2}))?(?:[-./](\d{1,2}))?$/);
  if (!m) return;
  out[`${path}.year`] = `${label}-年 (${m[1]})`;
  if (m[2]) out[`${path}.month`] = `${label}-月 (${parseInt(m[2], 10)})`;
  if (m[3]) out[`${path}.day`] = `${label}-日 (${parseInt(m[3], 10)})`;
}

// 扁平化本地简历字段，供完整动作候选生成器枚举可映射路径。
export function flattenResumeFields(resume) {
  const out = { none: "No matching resume field" };
  if (!resume) return out;

  const b = resume.basics || {};
  out["basics.name"] = `姓名 (${b.name || "空"})`;
  if (b.photo?.dataUrl && b.photo?.name) out["basics.photo"] = `简历照片 (${b.photo.name})`;
  (b.lifePhotos || []).forEach((photo,i)=>{
    if (photo.dataUrl && photo.name) out[`basics.lifePhotos[${i}]`] = `生活照 ${i+1}`;
  });
  if (b.resumeFile?.dataUrl && b.resumeFile?.name) out["basics.resumeFile"] = `简历附件 (${b.resumeFile.name})`;
  out["basics.gender"] = `性别 (${b.gender || "空"})`;
  out["basics.birthDate"] = `出生日期 (${b.birthDate || "空"})`;
  addDateFields(out, "basics.birthDate", "出生日期", b.birthDate);
  const age = deriveAge(b.birthDate);
  if (age) out["basics.age"] = `年龄 (${age})`;
  out["basics.phone"] = `手机 (${b.phone || "空"})`;
  out["basics.email"] = `邮箱 (${b.email || "空"})`;
  out["basics.location.city"] = `现居城市 (${(b.location && b.location.city) || "空"})`;
  out["basics.location.address"] = `现居详细地址 (${(b.location && b.location.address) || "空"})`;
  out["basics.location.region.province"] = `现居省 (${(b.location && b.location.region && b.location.region.province) || "空"})`;
  out["basics.location.region.city"] = `现居市 (${(b.location && b.location.region && b.location.region.city) || "空"})`;
  out["basics.location.region.district"] = `现居区县 (${(b.location && b.location.region && b.location.region.district) || "空"})`;
  out["basics.hukou"] = `户口所在地 (${b.hukou || "空"})`;
  out["basics.nativePlace"] = `籍贯 (${b.nativePlace || "空"})`;
  out["basics.nativePlaceDetail.province"] = `籍贯省 (${(b.nativePlaceDetail && b.nativePlaceDetail.province) || "空"})`;
  out["basics.nativePlaceDetail.city"] = `籍贯市 (${(b.nativePlaceDetail && b.nativePlaceDetail.city) || "空"})`;
  out["basics.nativePlaceDetail.district"] = `籍贯区县 (${(b.nativePlaceDetail && b.nativePlaceDetail.district) || "空"})`;
  out["basics.hukouDetail.province"] = `户口省 (${(b.hukouDetail && b.hukouDetail.province) || "空"})`;
  out["basics.hukouDetail.city"] = `户口市 (${(b.hukouDetail && b.hukouDetail.city) || "空"})`;
  out["basics.hukouDetail.district"] = `户口区县 (${(b.hukouDetail && b.hukouDetail.district) || "空"})`;
  out["basics.ethnicity"] = `民族 (${b.ethnicity || "空"})`;
  out["basics.nationality"] = `国籍/地区 (${b.nationality || "空"})`;
  out["basics.maritalStatus"] = `婚姻状态 (${b.maritalStatus || "空"})`;
  out["basics.politicalStatus"] = `政治面貌 (${b.politicalStatus || "空"})`;
  out["basics.idType"] = `证件类型 (${b.idType || "空"})`;
  out["basics.idNumber"] = `证件号码 (${b.idNumber ? "已填写" : "空"})`;
  out["basics.highestDegree"] = `最高学历 (${b.highestDegree || "空"})`;
  out["basics.graduationDate"] = `毕业时间 (${b.graduationDate || "空"})`;
  out["basics.label"] = `求职意向 (${b.label || "空"})`;
  out["basics.summary"] = "自我介绍";
  out["basics.achievements"] = "个人成就（简历已提供的获奖及成果）";
  for (const key of ['heightCm','weightKg','homeAddress','mailingAddress']) out[`basics.${key}`] = key;

  for (const key of ['emergencyContactName','emergencyContactPhone']) {
    if (resume.application?.[key]) out[`application.${key}`] = key === 'emergencyContactName' ? '紧急联系人姓名' : '紧急联系电话';
  }
  if (resume.application?.recruitmentSource) {
    out["application.recruitmentSource"] = "招聘信息来源（用户提供）";
  }
  if (resume.application?.interviewSite) {
    out["application.interviewSite"] = `校招面试站点 (${resume.application.interviewSite})`;
  }

  const e = resume.expected || {};
  if (e.salary || e.city || e.startDate || e.acceptRelocation) {
    out["expected.salary"] = `期望薪资 (${e.salary || "空"})`;
    out["expected.city"] = `期望城市 (${e.city || "空"})`;
    out["expected.startDate"] = `到岗时间 (${e.startDate || "空"})`;
    out["expected.acceptRelocation"] = `是否接受异地 (${e.acceptRelocation || "空"})`;
  }

  (resume.education || []).forEach((edu, i) => {
    out[`education[${i}].institution`] = `教育#${i + 1} 学校 (${edu.institution || "空"})`;
    out[`education[${i}].country`] = `教育#${i + 1} 院校所在国家/地区`;
    out[`education[${i}].department`] = `教育#${i + 1} 就读院系`;
    out[`education[${i}].area`] = `教育#${i + 1} 专业 (${edu.area || "空"})`;
    out[`education[${i}].majorType`] = `教育#${i + 1} 专业类型 (${edu.majorType || "空"})`;
    out[`education[${i}].studyType`] = `教育#${i + 1} 学历 (${edu.studyType || "空"})`;
    out[`education[${i}].studyMode`] = `教育#${i + 1} 教育形式`;
    out[`education[${i}].degree`] = `教育#${i + 1} 学位 (${edu.degree || "空"})`;
    out[`education[${i}].primaryDiscipline`] = `教育#${i + 1} 一级学科分类 (${edu.primaryDiscipline || "空"})`;
    out[`education[${i}].startDate`] = `教育#${i + 1} 开始 (${edu.startDate || "空"})`;
    out[`education[${i}].endDate`] = `教育#${i + 1} 结束 (${edu.endDate || "空"})`;
    addDateFields(out, `education[${i}].startDate`, `教育#${i + 1} 开始`, edu.startDate);
    addDateFields(out, `education[${i}].endDate`, `教育#${i + 1} 结束`, edu.endDate);
    out[`education[${i}].gpa`] = `教育#${i + 1} GPA (${edu.gpa || "空"})`;
    out[`education[${i}].ranking`] = `教育#${i + 1} 学习成绩排名 (${edu.ranking || "空"})`;
    out[`education[${i}].studentCadre`] = `教育#${i + 1} 是否为学生干部 (${edu.studentCadre || "空"})`;
    out[`education[${i}].schoolExperience`] = `教育#${i + 1} 在校经历`;
    out[`education[${i}].scholarships`] = `教育#${i + 1} 奖学金 (${edu.scholarships || "空"})`;
    out[`education[${i}].lab`] = `教育#${i + 1} 实验室 (${edu.lab || "空"})`;
    out[`education[${i}].advisor`] = `教育#${i + 1} 导师 (${edu.advisor || "空"})`;
    out[`education[${i}].thesis`] = `教育#${i + 1} 毕设方向 (${edu.thesis || "空"})`;
  });

  (resume.internship || []).forEach((w, i) => {
    out[`internship[${i}].company`] = `实习#${i + 1} 公司 (${w.company || "空"})`;
    out[`internship[${i}].department`] = `实习#${i + 1} 部门 (${w.department || "空"})`;
    out[`internship[${i}].position`] = `实习#${i + 1} 职位 (${w.position || "空"})`;
    out[`internship[${i}].startDate`] = `实习#${i + 1} 开始 (${w.startDate || "空"})`;
    out[`internship[${i}].endDate`] = `实习#${i + 1} 结束 (${w.endDate || "空"})`;
    addDateFields(out, `internship[${i}].startDate`, `实习#${i + 1} 开始`, w.startDate);
    addDateFields(out, `internship[${i}].endDate`, `实习#${i + 1} 结束`, w.endDate);
    if (w.isPresent) out[`internship[${i}].endDate.isPresent`] = `实习#${i + 1} 结束-至今 (是)`;
    out[`internship[${i}].summary`] = `实习#${i + 1} 描述`;
    out[`internship[${i}].leaveReason`] = `实习#${i + 1} 结束原因 (${w.leaveReason || "空"})`;
    out[`internship[${i}].currentSalary`] = `实习#${i + 1} 补贴 (${w.currentSalary || "空"})`;
  });

  (resume.work || []).forEach((w, i) => {
    out[`work[${i}].company`] = `工作#${i + 1} 公司 (${w.company || "空"})`;
    out[`work[${i}].department`] = `工作#${i + 1} 部门 (${w.department || "空"})`;
    out[`work[${i}].position`] = `工作#${i + 1} 职位 (${w.position || "空"})`;
    out[`work[${i}].startDate`] = `工作#${i + 1} 开始 (${w.startDate || "空"})`;
    out[`work[${i}].endDate`] = `工作#${i + 1} 结束 (${w.endDate || "空"})`;
    addDateFields(out, `work[${i}].startDate`, `工作#${i + 1} 开始`, w.startDate);
    addDateFields(out, `work[${i}].endDate`, `工作#${i + 1} 结束`, w.endDate);
    out[`work[${i}].summary`] = `工作#${i + 1} 描述`;
    out[`work[${i}].leaveReason`] = `工作#${i + 1} 离职原因 (${w.leaveReason || "空"})`;
    out[`work[${i}].currentSalary`] = `工作#${i + 1} 目前年薪 (${w.currentSalary || "空"})`;
  });

  (resume.projects || []).forEach((p, i) => {
    out[`projects[${i}].name`] = `项目#${i + 1} 名称 (${p.name || "空"})`;
    out[`projects[${i}].role`] = `项目#${i + 1} 角色 (${p.role || "空"})`;
    out[`projects[${i}].startDate`] = `项目#${i + 1} 开始 (${p.startDate || "空"})`;
    out[`projects[${i}].endDate`] = `项目#${i + 1} 结束 (${p.endDate || "空"})`;
    addDateFields(out, `projects[${i}].startDate`, `项目#${i + 1} 开始`, p.startDate);
    addDateFields(out, `projects[${i}].endDate`, `项目#${i + 1} 结束`, p.endDate);
    out[`projects[${i}].description`] = `项目#${i + 1} 描述`;
    out[`projects[${i}].techStack`] = `项目#${i + 1} 技术栈 (${(p.techStack || []).join(", ")})`;
  });

  (resume.campusPractice || []).forEach((item, i) => {
    out[`campusPractice[${i}].position`] = `校内实践#${i + 1} 职位 (${item.position || "空"})`;
    out[`campusPractice[${i}].startDate`] = `校内实践#${i + 1} 开始 (${item.startDate || "空"})`;
    out[`campusPractice[${i}].endDate`] = `校内实践#${i + 1} 结束 (${item.endDate || "空"})`;
    addDateFields(out, `campusPractice[${i}].startDate`, `校内实践#${i + 1} 开始`, item.startDate);
    addDateFields(out, `campusPractice[${i}].endDate`, `校内实践#${i + 1} 结束`, item.endDate);
    out[`campusPractice[${i}].summary`] = `校内实践#${i + 1} 工作职责`;
  });

  (resume.skills || []).forEach((s, i) => {
    const items = (s.items || []).map(it => `${it.skill}${it.level ? ' ' + it.level : ''}`).join('、');
    out[`skills[${i}].items`] = `技能 ${s.name || ""} (${items})`;
  });

  if (resume.skills && resume.skills.length) {
    const skillsText = resume.skills.map(cat => {
      const items = (cat.items || []).map(it => `${it.skill}${it.level ? ' ' + it.level : ''}`).join('、');
      return `${cat.name}：${items}`;
    }).join('；');
    out["skills"] = `技能整体 (${skillsText})`;
  }

  (resume.languages || []).forEach((l, i) => {
    out[`languages[${i}].language`] = `语言#${i + 1} 语种 (${l.language || "空"})`;
    out[`languages[${i}].fluency`] = `语言#${i + 1} 水平 (${l.fluency || "空"})`;
    out[`languages[${i}].siteFluency`] = `语言#${i + 1} 掌握程度 (${l.siteFluency || "空"})`;
    out[`languages[${i}].certificate`] = `语言#${i + 1} 考试证书 (${l.certificate || "空"})`;
    out[`languages[${i}].score`] = `语言#${i + 1} 成绩 (${l.score || "空"})`;
  });
  (resume.englishLevels || []).forEach((item,i)=>{
    out[`englishLevels[${i}].level`]=`英语等级#${i+1} (${item.level || '空'})`;
    out[`englishLevels[${i}].score`]=`英语成绩#${i+1} (${item.score || '空'})`;
  });

  (resume.certificates || []).forEach((c, i) => {
    out[`certificates[${i}].name`] = `证书#${i + 1} (${c.name || "空"})`;
    for (const key of ['type','number','date','summary']) out[`certificates[${i}].${key}`] = `证书#${i+1} ${key}`;
  });
  (resume.family || []).forEach((member,i)=>{
    for (const key of ['name','relationship','birthDate','company','position','politicalStatus','education','remarks']) {
      out[`family[${i}].${key}`] = `家庭成员#${i+1} ${key}`;
    }
  });

  (resume.awards || []).forEach((a, i) => {
    out[`awards[${i}].title`] = `获奖#${i + 1} (${a.title || "空"})`;
    for (const key of ['type','date','grade','level','details']) out[`awards[${i}].${key}`] = `获奖#${i + 1} ${key}`;
    addDateFields(out, `awards[${i}].date`, `获奖#${i + 1} 时间`, a.date);
  });
  (resume.publications || []).forEach((paper,i) => {
    for (const key of ['title','type','level','zone','journal','date','authorOrder','details']) {
      out[`publications[${i}].${key}`] = `论文#${i + 1} ${key}`;
    }
    addDateFields(out, `publications[${i}].date`, `论文#${i + 1} 发表`, paper.date);
  });
  for (const collection of ['professionalSkills','computerSkills','patents']) {
    (resume[collection] || []).forEach((record,i)=>{
      for (const key of Object.keys(record)) out[`${collection}[${i}].${key}`]=`${collection}#${i + 1} ${key}`;
    });
  }

  if (resume.interests && resume.interests.length) {
    out["interests"] = `兴趣 (${resume.interests.join(", ")})`;
  }

  return out;
}

// 从 path 取值（支持 "basics.name" 和 "education[0].institution" 两种语法）
// 数组/对象值转成可填入输入框的文本：
//   [{skill, level}] → "JavaScript 熟练、TypeScript 熟悉"
//   ["a", "b"] → "a, b"
// 日期派生子字段：xxx.birthDate.year / .month / .day / .isPresent（对应"年-月-日"三段式控件与"至今"勾选）
const DATE_PART_RE = /^(.*)\.(year|month|day|isPresent)$/;

export function getResumeValue(resume, path) {
  if (!path || path === "none") return undefined;
  if (path === "basics.achievements") return resume.basics?.achievements || (resume?.awards || []).map(a => a.title).filter(Boolean).join("\n") || undefined;
  if (path === "basics.photo") return resume.basics?.photo;
  if (path === "basics.resumeFile") return resume.basics?.resumeFile;
  const lifePhoto=path.match(/^basics\.lifePhotos\[(\d+)\]$/);
  if (lifePhoto) return resume.basics?.lifePhotos?.[Number(lifePhoto[1])];

  // 派生字段：年龄由出生日期推算
  if (path === "basics.age") {
    const b = resume && resume.basics;
    const age = deriveAge(b && b.birthDate);
    return age || undefined;
  }

  const datePart = String(path).match(DATE_PART_RE);
  if (datePart) {
    if (datePart[2] === 'isPresent') {
      const recordPath = datePart[1].match(/^internship\[(\d+)\]\.endDate$/);
      if (recordPath && resume?.internship?.[Number(recordPath[1])]?.isPresent) return '是';
    }
    const base = getResumeValue(resume, datePart[1]);
    const part = datePart[2];
    if (typeof base === "string") {
      if (base === "至今") return part === "isPresent" ? "是" : undefined;
      const dm = base.match(/^(\d{4})(?:[-./](\d{1,2}))?(?:[-./](\d{1,2}))?$/);
      if (dm) {
        if (part === "year") return dm[1];
        if (part === "month") return dm[2] ? String(parseInt(dm[2], 10)) : undefined;
        if (part === "day") return dm[3] ? String(parseInt(dm[3], 10)) : undefined;
        return undefined;
      }
    }
    return undefined;
  }

  const tokens = path.match(/[^\.\[\]]+/g);
  let cur = resume;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  if (Array.isArray(cur)) {
    if (cur.length === 0) return undefined;
    return cur.map(item => {
      if (item == null) return "";
      if (typeof item === "object") {
        if ("skill" in item) return `${item.skill || ""}${item.level ? " " + item.level : ""}`;
        if (Array.isArray(item.items)) {
          return (item.items || []).map(it =>
            typeof it === "object" ? `${it.skill || ""}${it.level ? " " + it.level : ""}` : String(it)
          ).filter(s => s.trim()).join("、");
        }
        const first = Object.values(item).find(v => typeof v === "string" && v);
        return first || "";
      }
      return String(item);
    }).filter(Boolean).join("、");
  }
  if (typeof cur === "object" && cur !== null) return undefined;
  return cur;
}

// 页面标签和本地简历字段的同义词。这个表覆盖荣耀、字节和 Moka 系表单中实测到的
// 基础信息、教育经历和重复经历字段；Jev 负责在多个完整动作之间理解当前页面优先级。
const FIELD_RULES = [
  [/^basics\.lifePhotos\[\d+\]$/, "生活照", ["生活照", "全身照"]],
  [/^application\.emergencyContactName$/, "紧急联系人姓名", ["紧急联系人姓名", "紧急联系人"]],
  [/^application\.emergencyContactPhone$/, "紧急联系电话", ["紧急联系电话", "紧急联系方式", "紧急联系人电话"]],
  [/^application\.recruitmentSource$/, "招聘信息来源", ["招聘信息来源", "获取招聘信息来源"]],
  [/^application\.recruitmentSourceDetail$/, "招聘信息具体来源", ["具体来源", "请填写具体来源"]],
  [/^application\.interviewSite$/, "校招面试站点", ["校招面试站点", "面试站点", "面试城市"]],
  [/^basics\.name$/, "姓名", ["姓名", "name"]],
  [/^basics\.photo$/, "简历照片", ["上传照片", "简历照片", "证件照", "头像", "photo"]],
  [/^basics\.resumeFile$/, "简历附件", ["上传简历", "简历附件", "附件简历", "简历文件"]],
  [/^basics\.age$/, "年龄", ["年龄", "age"]],
  [/^basics\.phone$/, "手机", ["手机", "移动电话", "手机号码", "手机号", "phone", "telephone"]],
  [/^basics\.email$/, "邮箱", ["邮箱", "电子邮箱", "email", "e-mail"]],
  [/^basics\.gender$/, "性别", ["性别", "gender"]],
  [/^basics\.idType$/, "证件类型", ["证件类型", "证件号码类型", "身份类型"]],
  [/^basics\.idNumber$/, "证件号码", ["证件号码", "身份证号", "证件号", "id number"]],
  [/^basics\.birthDate$/, "出生日期", ["出生日期", "生日", "birth date"]],
  [/^basics\.birthDate\.year$/, "出生年份", ["出生年份", "出生年", "birth year"]],
  [/^basics\.birthDate\.month$/, "出生月份", ["出生月份", "出生月", "birth month"]],
  [/^basics\.birthDate\.day$/, "出生日期-日", ["出生日", "birth day"]],
  [/^basics\.nativePlace$/, "籍贯", ["籍贯", "native place"]],
  [/^basics\.nativePlaceDetail\.province$/, "籍贯省", ["籍贯省", "籍贯省份"]],
  [/^basics\.nativePlaceDetail\.city$/, "籍贯市", ["籍贯市"]],
  [/^basics\.nativePlaceDetail\.district$/, "籍贯区县", ["籍贯区", "籍贯县", "籍贯区县"]],
  [/^basics\.hukou$/, "户口所在地", ["户口", "户籍"]],
  [/^basics\.hukouDetail\.province$/, "户口省", ["户口省", "户籍省"]],
  [/^basics\.hukouDetail\.city$/, "户口市", ["户口市", "户籍市"]],
  [/^basics\.hukouDetail\.district$/, "户口区县", ["户口区", "户口县", "户籍区", "户籍县"]],
  [/^basics\.ethnicity$/, "民族", ["民族", "ethnicity"]],
  [/^basics\.nationality$/, "国籍/地区", ["国籍", "国家地区", "国籍地区", "nationality"]],
  [/^basics\.maritalStatus$/, "婚姻状况", ["婚姻", "marital"]],
  [/^basics\.politicalStatus$/, "政治面貌", ["政治面貌", "政治"]],
  [/^basics\.location\.city$/, "现居城市", ["现居城市", "现居住地", "现居地址", "居住地", "所在城市"]],
  [/^basics\.location\.address$/, "现居详细地址", ["详细地址", "地址", "address"]],
  [/^basics\.location\.region\.province$/, "现居省", ["现居省", "居住省", "居住地省"]],
  [/^basics\.location\.region\.city$/, "现居市", ["现居市", "居住市", "居住地市"]],
  [/^basics\.location\.region\.district$/, "现居区县", ["现居区", "现居县", "居住区", "居住县"]],
  [/^basics\.highestDegree$/, "最高学历", ["最高学历", "学历"]],
  [/^basics\.graduationDate$/, "毕业时间", ["毕业时间", "毕业日期"]],
  [/^basics\.label$/, "求职意向", ["求职意向", "意向岗位"]],
  [/^basics\.summary$/, "自我介绍", ["自我介绍", "自我评价", "自我描述", "个人总结", "个人陈述"]],
  [/^basics\.achievements$/, "个人成就", ["个人成就", "主要成就"]],
  [/^basics\.heightCm$/, "身高", ["身高"]],
  [/^basics\.weightKg$/, "体重", ["体重"]],
  [/^basics\.homeAddress$/, "家庭地址", ["家庭地址"]],
  [/^basics\.mailingAddress$/, "通信地址", ["通信地址", "通讯地址"]],
  [/^family\[\d+\]\.name$/, "家庭成员姓名", ["父亲姓名", "母亲姓名", "姓名"]],
  [/^family\[\d+\]\.relationship$/, "关系", ["与本人关系", "关系"]],
  [/^family\[\d+\]\.birthDate$/, "出生日期", ["出生日期", "出生年月"]],
  [/^family\[\d+\]\.company$/, "工作单位", ["工作单位"]],
  [/^family\[\d+\]\.position$/, "职务", ["职务", "职位"]],
  [/^family\[\d+\]\.politicalStatus$/, "政治面貌", ["政治面貌"]],
  [/^family\[\d+\]\.education$/, "教育程度", ["教育程度"]],
  [/^family\[\d+\]\.remarks$/, "备注", ["备注"]],
  [/^certificates\[\d+\]\.name$/, "证书名称", ["证书名称"]],
  [/^certificates\[\d+\]\.number$/, "证书编号", ["证书编号", "证书号码"]],
  [/^certificates\[\d+\]\.type$/, "证书类型", ["证书类型"]],
  [/^certificates\[\d+\]\.date$/, "获得时间", ["获得时间", "取得时间"]],
  [/^certificates\[\d+\]\.summary$/, "证书说明", ["说明"]],
  [/^expected\.salary$/, "期望薪资", ["期望薪资", "薪资", "薪酬"]],
  [/^expected\.city$/, "期望城市", ["期望城市", "意向工作城市", "期望工作地点"]],
  [/^expected\.startDate$/, "到岗时间", ["到岗", "入职时间"]],
  [/^expected\.acceptRelocation$/, "接受异地", ["接受异地", "工作地点变更"]],
  [/^education\[\d+\]\.institution$/, "学校名称", ["学校名称", "毕业院校", "就读学校", "学校"]],
  [/^education\[\d+\]\.country$/, "院校所在国家/地区", ["院校所在国家", "院校所在地区", "学校所在国家", "国家地区"]],
  [/^education\[\d+\]\.department$/, "就读院系", ["就读院/系", "就读院系", "院系", "学院"]],
  [/^education\[\d+\]\.area$/, "专业", ["专业名称", "专业"]],
  [/^education\[\d+\]\.majorType$/, "专业类型", ["专业类型"]],
  [/^education\[\d+\]\.studyType$/, "学历", ["学历类型", "学历", "阶段"]],
  [/^education\[\d+\]\.studyMode$/, "教育形式", ["教育形式", "受教育类型", "学习形式", "学习方式"]],
  [/^education\[\d+\]\.degree$/, "学位", ["学位"]],
  [/^education\[\d+\]\.primaryDiscipline$/, "一级学科分类", ["一级学科", "学科分类", "学科"]],
  [/^education\[\d+\]\.startDate$/, "入学时间", ["入学时间", "入学日期", "开始时间", "开始日期"]],
  [/^education\[\d+\]\.startDate\.year$/, "入学年份", ["入学年份", "开始年份", "入学年", "开始年"]],
  [/^education\[\d+\]\.startDate\.month$/, "入学月份", ["入学月份", "开始月份", "入学月", "开始月"]],
  [/^education\[\d+\]\.startDate\.day$/, "入学日期", ["入学日期", "开始日期", "入学日", "开始日"]],
  [/^education\[\d+\]\.endDate$/, "毕业时间", ["毕业时间", "毕业日期", "结束时间", "结束日期"]],
  [/^education\[\d+\]\.endDate\.year$/, "毕业年份", ["毕业年份", "结束年份", "毕业年", "结束年"]],
  [/^education\[\d+\]\.endDate\.month$/, "毕业月份", ["毕业月份", "结束月份", "毕业月", "结束月"]],
  [/^education\[\d+\]\.endDate\.day$/, "毕业日期", ["毕业日期", "结束日期", "毕业日", "结束日"]],
  [/^education\[\d+\]\.gpa$/, "GPA", ["历年平均成绩", "平均成绩", "gpa", "绩点"]],
  [/^education\[\d+\]\.ranking$/, "学习成绩排名", ["gpa排名", "学习成绩排名", "成绩排名", "专业排名", "班级排名", "排名"]],
  [/^education\[\d+\]\.studentCadre$/, "是否为学生干部", ["是否为学生干部", "学生干部"]],
  [/^education\[\d+\]\.lab$/, "实验室", ["实验室"]],
  [/^education\[\d+\]\.advisor$/, "导师", ["导师"]],
  [/^education\[\d+\]\.thesis$/, "研究方向", ["研究方向", "领域方向", "毕设"]],
  [/^(?:internship|work)\[\d+\]\.company$/, "公司名称", ["公司名称", "企业名称", "公司", "单位"]],
  [/^(?:internship|work)\[\d+\]\.department$/, "部门", ["所在部门", "实习部门", "工作部门", "部门"]],
  [/^(?:internship|work)\[\d+\]\.position$/, "职位名称", ["职位名称", "职位", "职务", "岗位"]],
  [/^(?:internship|work)\[\d+\]\.startDate$/, "开始时间", ["开始时间", "开始日期", "入职时间", "任职开始"]],
  [/^(?:internship|work)\[\d+\]\.startDate\.year$/, "开始年份", ["开始年份", "入职年份", "开始年", "入职年"]],
  [/^(?:internship|work)\[\d+\]\.startDate\.month$/, "开始月份", ["开始月份", "入职月份", "开始月", "入职月"]],
  [/^(?:internship|work)\[\d+\]\.startDate\.day$/, "开始日期", ["开始日期", "入职日期", "开始日", "入职日"]],
  [/^(?:internship|work)\[\d+\]\.endDate$/, "结束时间", ["结束时间", "结束日期", "离职时间", "离职日期"]],
  [/^(?:internship|work)\[\d+\]\.endDate\.year$/, "结束年份", ["结束年份", "离职年份", "结束年", "离职年"]],
  [/^(?:internship|work)\[\d+\]\.endDate\.month$/, "结束月份", ["结束月份", "离职月份", "结束月", "离职月"]],
  [/^(?:internship|work)\[\d+\]\.endDate\.day$/, "结束日期", ["结束日期", "离职日期", "结束日", "离职日"]],
  [/^(?:internship|work)\[\d+\]\.summary$/, "经历描述", ["描述", "工作内容", "实习内容", "职责"]],
  [/^projects\[\d+\]\.name$/, "项目名称", ["项目名称"]],
  [/^projects\[\d+\]\.role$/, "项目角色", ["项目角色", "项目职务", "项目职责", "角色"]],
  [/^projects\[\d+\]\.startDate$/, "项目开始时间", ["项目开始时间", "项目开始日期", "开始时间", "开始日期"]],
  [/^projects\[\d+\]\.startDate\.year$/, "项目开始年份", ["项目开始年份", "开始年份", "开始年"]],
  [/^projects\[\d+\]\.startDate\.month$/, "项目开始月份", ["项目开始月份", "开始月份", "开始月"]],
  [/^projects\[\d+\]\.startDate\.day$/, "项目开始日期", ["项目开始日期", "开始日期", "开始日"]],
  [/^projects\[\d+\]\.endDate$/, "项目结束时间", ["项目结束时间", "项目结束日期", "结束时间", "结束日期"]],
  [/^projects\[\d+\]\.endDate\.year$/, "项目结束年份", ["项目结束年份", "结束年份", "结束年"]],
  [/^projects\[\d+\]\.endDate\.month$/, "项目结束月份", ["项目结束月份", "结束月份", "结束月"]],
  [/^projects\[\d+\]\.endDate\.day$/, "项目结束日期", ["项目结束日期", "结束日期", "结束日"]],
  [/^projects\[\d+\]\.description$/, "项目描述", ["项目描述", "描述"]],
  [/^campusPractice\[\d+\]\.position$/, "校内实践职位", ["职位名称", "职位", "职务"]],
  [/^campusPractice\[\d+\]\.startDate$/, "校内实践开始时间", ["开始时间", "开始日期", "工作开始时间"]],
  [/^campusPractice\[\d+\]\.endDate$/, "校内实践结束时间", ["结束时间", "结束日期", "工作结束时间"]],
  [/^campusPractice\[\d+\]\.summary$/, "校内实践工作职责", ["工作职责", "职责", "工作内容", "社会实践经历"]],
  [/^skills(?:\[\d+\]\.items)?$/, "技能", ["技能", "技术栈", "专业技能"]],
  [/^professionalSkills\[\d+\]\.name$/, "技能名称", ["技能名称", "技能类型", "其他技能"]],
  [/^professionalSkills\[\d+\]\.level$/, "技能水平", ["技能水平", "掌握程度"]],
  [/^computerSkills\[\d+\]\.name$/, "编程语言", ["编程语言"]],
  [/^computerSkills\[\d+\]\.level$/, "掌握程度", ["掌握程度"]],
  [/^patents\[\d+\]\.number$/, "专利编号", ["专利编号", "专利号"]],
  [/^patents\[\d+\]\.name$/, "专利名称", ["专利名称"]],
  [/^patents\[\d+\]\.date$/, "专利发布时间", ["发布时间"]],
  [/^patents\[\d+\]\.value$/, "专业价值", ["专业价值"]],
  [/^publications\[\d+\]\.title$/, "论文名称", ["论文名称", "论文题目", "著作名称"]],
  [/^publications\[\d+\]\.type$/, "论文类型", ["论文类型", "论文类别", "收录类型"]],
  [/^publications\[\d+\]\.level$/, "论文级别", ["论文级别", "论文等级", "收录级别"]],
  [/^publications\[\d+\]\.zone$/, "期刊分区", ["期刊分区", "SCI分区", "中科院分区"]],
  [/^publications\[\d+\]\.journal$/, "发表期刊", ["发表期刊", "发表刊物", "期刊名称", "刊物名称", "期刊/会议"]],
  [/^publications\[\d+\]\.date$/, "发表时间", ["发表时间", "发表日期", "出版时间", "出版日期"]],
  [/^publications\[\d+\]\.date\.year$/, "发表年份", ["发表年份", "出版年份", "发表年"]],
  [/^publications\[\d+\]\.date\.month$/, "发表月份", ["发表月份", "出版月份", "发表月"]],
  [/^publications\[\d+\]\.authorOrder$/, "作者顺序", ["作者顺序", "作者排名", "作者位次", "第几作者"]],
  [/^publications\[\d+\]\.details$/, "论文详情", ["论文详情", "论文描述", "论文简介", "研究内容"]],
  [/^languages\[\d+\]\.language$/, "语言", ["语言", "语种"]],
  [/^languages\[\d+\]\.siteFluency$/, "语言掌握程度", ["精通程度", "掌握程度", "熟练程度", "听说能力", "读写能力"]],
  [/^languages\[\d+\]\.fluency$/, "语言水平", ["语言水平"]],
  [/^languages\[\d+\]\.certificate$/, "语言证书", ["证书", "考试名称"]],
  [/^languages\[\d+\]\.score$/, "语言成绩", ["分数", "成绩", "得分"]],
  [/^englishLevels\[\d+\]\.level$/, "英语等级", ["英语等级"]],
  [/^englishLevels\[\d+\]\.score$/, "英语成绩", ["成绩"]],
  [/^awards\[\d+\]\.type$/, "获奖类型", ["获奖类型"]],
  [/^awards\[\d+\]\.title$/, "获奖名称", ["获奖名称", "奖项名称", "奖励名称"]],
  [/^awards\[\d+\]\.date$/, "获奖时间", ["获奖时间", "获奖日期", "获得时间"]],
  [/^awards\[\d+\]\.date\.year$/, "获奖年份", ["获奖年份", "获奖年"]],
  [/^awards\[\d+\]\.date\.month$/, "获奖月份", ["获奖月份", "获奖月"]],
  [/^awards\[\d+\]\.grade$/, "获奖等级", ["获奖等级"]],
  [/^awards\[\d+\]\.level$/, "获奖级别", ["获奖级别"]],
  [/^awards\[\d+\]\.details$/, "获奖情况", ["获奖情况", "获奖原因"]]
];

const FINAL_SUBMIT_RE = /(提交简历|预览并提交|立即申请|确认投递|确认信息.*投递|投递简历|submit application|submit resume)/i;
const SECTION_NAV_RE = /^(下一步|保存并下一步|保存并继续|下一页|继续|保存|save|save and continue|next|continue)$/i;
const CARD_ENTRY_RE = /(不完整|未完成|去完善|去填写|去补充|编辑)/;
const PICKER_CONFIRM_RE = /^(确定|确认|完成|ok|done)$/i;
const HIERARCHICAL_PICKER_RE = /(籍贯|户口|居住地|工作地|地址|国家|地区|院校|学校)/;
const AGREEMENT_RE = /(同意|接受|已阅读|已阅知).{0,36}(协议|隐私|条款|政策|声明)|(协议|隐私|条款|政策|声明).{0,36}(同意|接受|已阅读|已阅知)/i;
const RELATIVE_EMPLOYMENT_RE = /(亲属|亲戚|直系亲属|家庭成员).{0,48}(本公司|公司|单位|任职|工作)|(本公司|公司|单位).{0,48}(亲属|亲戚|直系亲属|家庭成员)/i;
const NO_CHOICE_RE = /^(否|没有|无|不存在|no|false|0)$/i;
const MAX_ACTION_CANDIDATES = 120;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\-_/()（）【】\[\]{}:：,.，。'"`]+/g, "")
    .trim();
}

function normalizeComparableDate(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{4})\D+(\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!m) return "";
  return `${m[1]}${m[2].padStart(2, "0")}${m[3] ? m[3].padStart(2, "0") : ""}`;
}

function normalizeRegion(value) {
  return normalizeText(value).replace(/特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市|区|县/g, "").replace(/^中国(?=香港|澳门|台湾)/, "");
}

function elementText(el) {
  return normalizeText(`${el.label || ""} ${el.name || ""}`);
}

function matchesTerm(el, term) {
  if (/^[a-z]+$/i.test(term)) {
    const raw = `${el.label || ''} ${el.name || ''}`.toLowerCase();
    return new RegExp(`(^|[^a-z])${term.toLowerCase()}([^a-z]|$)`).test(raw);
  }
  return elementText(el).includes(normalizeText(term));
}

function resolveFieldRule(path) {
  return FIELD_RULES.find(([pattern]) => pattern.test(path)) || null;
}

function isNonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function hasExistingPageValue(el) {
  if (['checkbox','radio','custom-checkbox','custom-radio'].includes(el.kind) ||
      ['checkbox','radio'].includes(el.role)) return el.checked === true;
  if (!['input','textarea','richtext','custom-select','combobox','date','moka-date',
    'layui-date','native-select','file'].includes(el.kind)) return false;
  const raw = String(el.value || '').trim();
  if (!raw || /^(?:请选择|请填写|请输入|上传|上传中|必填项未填写|年|月|日|-)$/i.test(raw)) return false;
  if (/^(?:请选择|请填写|请输入)/.test(raw)) return false;
  if (el.placeholder && normalizeText(raw) === normalizeText(el.placeholder)) return false;
  return true;
}

function matchesField(el, field) {
  if (!Array.isArray(field.terms)) return false;
  const text = elementText(el);
  if (/紧急联系/.test(text) && /^basics\.(name|phone|email)$/.test(field.path)) return false;
  if (field.path === 'application.emergencyContactName' && /电话|手机|联系方式/.test(text)) return false;
  if (/^family\[/.test(field.path)) {
    if (!/家庭关系|家庭情况/.test(el.section || el.bindingSection || '')) return false;
    const namedRelation = String(el.label || '').match(/(父亲|母亲)姓名/)?.[1];
    if (namedRelation && field.relationship !== namedRelation) return false;
  }
  if (/^certificates\[/.test(field.path) && !/证书|资格认证/.test(el.section || el.bindingSection || '')) return false;
  if (field.path==='basics.photo' && /生活照|全身照/.test(text)) return false;
  const lifePhoto=field.path.match(/^basics\.lifePhotos\[(\d+)\]$/);
  if (lifePhoto) return el.kind==='file' && el.lifePhotoIndex===Number(lifePhoto[1]);
  if (field.path === 'basics.age' && /出生日期|生日/.test(text)) return false;
  if (field.path === 'basics.highestDegree' && /时间|日期|开始|结束/.test(text)) return false;
  if (/^教育|^个人/.test(String(el.section || '')) && /辅修专业/.test(text) &&
      /^education\[\d+\]\.area$/.test(field.path)) return false;
  if (field.path === 'basics.idNumber' && !['input','textarea'].includes(el.kind)) return false;
  if (/^education\[\d+\]\.gpa$/.test(field.path) && /排名/.test(text)) return false;
  if (/^education\[\d+\]\.area$/.test(field.path) && /课程|排名|研究方向|专业类型/.test(text)) return false;
  if (/^education\[\d+\]\.ranking$/.test(field.path) && /绩点/.test(text) && !/排名/.test(text)) return false;
  // 区号选择器和手机号输入框处在同一表单项。即使站点把父级
  // “手机号码”带进了标签，也始终保留区号，不用本地手机号覆盖。
  if ((/国家区号|电话区号|countrycode/.test(text) || /^\+\d{1,4}$/.test(String(el.value || '').trim())) &&
      field.path === "basics.phone") return false;
  if (/意向|应聘|申请/.test(text) && /^(internship|work|projects)\[/.test(field.path)) return false;
  if (/\.(year|month|day)$/.test(field.path) && /日期|时间/.test(text)) return false;
  if (/所在国家|所在地区/.test(text) && !field.path.endsWith(".country")) return false;
  if (/证件类型/.test(text) && field.path !== "basics.idType") return false;
  return field.terms.some((term) => matchesTerm(el, term));
}

function currentValueSatisfies(el, value) {
  const expected = normalizeText(value);
  if (!expected) return false;
  if (/^top\d+%$/i.test(expected) && normalizeText(el.value) === expected.replace(/^top/i, '前')) return true;
  if (el.checked === true) {
    const label = normalizeText(el.label);
    return normalizeText(el.optionValue) === expected || popupMatchesValue(el, value) || (expected === "是" && /(至今|目前|当前)/.test(label));
  }
  const actual = normalizeText(el.value);
  if (!actual) return false;
  const expectedDate = normalizeComparableDate(value);
  const actualDate = normalizeComparableDate(el.value);
  if (expectedDate && actualDate && expectedDate === actualDate) return true;
  if (expectedDate.length === 8 && actualDate.length === 6 && expectedDate.startsWith(actualDate) &&
      /出生日期|出生年月|毕业时间|入学时间|开始时间|结束时间/.test(String(el.label || ''))) return true;
  return actual === expected || (expected.length >= 2 && actual.includes(expected)) || (actual.length >= 2 && expected.includes(actual));
}

function popupMatchesValue(el, value) {
  const option = normalizeText(el.label);
  const expected = normalizeText(value);
  if (!option || !expected) return false;
  const awardLevelAliases = {
    全国: ['国家级'], 国家级: ['全国'], 校级: ['院校级'], 院校级: ['校级'],
    省级: ['省区级'], 省区级: ['省级'], 市级: ['县市级'], 县市级: ['市级']
  };
  if (awardLevelAliases[expected]?.includes(option)) return true;
  const expectedDate = normalizeComparableDate(value);
  if (expectedDate.length === 8) return normalizeComparableDate(el.label) === expectedDate;
  const rank = expected.match(/^top(\d+)%$/i);
  if (rank && option === `前${rank[1]}%`) return true;
  return option === expected || (option.length >= 2 && expected.includes(option)) || (expected.length >= 2 && option.includes(expected));
}

function hasCompleteDay(value) {
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(value || "").trim());
}

// 级联地点、学校检索与三列日期 picker 不能安全地靠一段扁平文本逐项猜测。
// 这些控件在获得结构化数据和专用选择流程前保留给用户；简单枚举选择器继续自动完成。
function canOfferFieldForControl(el, field) {
  if (/^education\[\d+\]\.ranking$/.test(field.path) && /本人班级排名|班级名次/.test(elementText(el)) &&
      !/^\d+$/.test(String(field.value))) return false;
  if (/^education\[\d+\]\.gpa$/.test(field.path) && /平均成绩/.test(elementText(el)) &&
      !/^\d+(?:\.\d+)?\s*\/\s*100$/.test(String(field.value))) return false;
  if (el.kind === 'custom-radio' && normalizeText(el.optionValue) !== normalizeText(field.value)) return false;
  if (field.path === "basics.birthDate" && !hasCompleteDay(field.value)) return false;
  if (el.kind === 'layui-date' && (/\.(year|month|day|isPresent)$/.test(field.path) || !/^\d{4}-\d{1,2}(?:-\d{1,2})?$/.test(field.value))) return false;
  if (el.kind === "custom-select" && /(籍贯|户口|居住地)/.test(String(el.label || "")) && !field.pickerPath) return false;
  return true;
}

function listResumeFields(resume) {
  const labels = flattenResumeFields(resume);
  return Object.keys(labels)
    .filter((path) => path !== "none")
    .map((path) => {
      const rule = resolveFieldRule(path);
      const value = getResumeValue(resume, path);
      const dateValue = path !== 'basics.birthDate' && /(?:Date|\.date)$/.test(path) && /^\d{4}-\d{1,2}$/.test(String(value || ''))
        ? `${value}-01` : value;
      return rule && isNonEmpty(value)
        ? { path, value: String(dateValue), label: rule[1], terms: rule[2], pickerPath: regionPath(resume, path),
            relationship: /^family\[/.test(path) ? resume.family?.[Number(path.match(/\[(\d+)\]/)[1])]?.relationship : undefined }
        : null;
    })
    .filter(Boolean);
}

function regionPath(resume, path) {
  const key = {
    "basics.nativePlace": "nativePlaceDetail",
    "basics.hukou": "hukouDetail",
    "basics.location.city": "location",
    "application.interviewSite": "location"
  }[path];
  const region = key === "location" ? resume.basics?.location?.region : resume.basics?.[key];
  const parts = region?.province && region?.city ? [region.province, region.city, region.district].filter(Boolean) : undefined;
  // 面试站点是省/市两级选择，现居地保留省/市/区三级。
  return path === "application.interviewSite" ? parts?.slice(0, 2) : parts;
}

function academicDegreeLevel(resume, path) {
  if (!/^education\[\d+\]\.degree$/.test(path)) return undefined;
  const studyType = getResumeValue(resume, path.replace(/degree$/, "studyType"));
  return { "本科": "学士", "硕士": "硕士", "硕士研究生": "硕士", "博士": "博士", "博士研究生": "博士" }[studyType];
}

function repeatedFieldGroup(path) {
  return /\[\d+\]/.test(path) ? path.replace(/\[\d+\]/, "[]") : null;
}

// 重复经历按 DOM 出现顺序绑定到简历中的第 n 条同类记录，避免同一个“学校”或“公司”
// 同时成为所有经历的候选。每个候选依然只指向一个确定的 resumeField。
const ELEMENT_SECTION_PREFIXES = {
  '申请信息':['expected','application'], '上传':['basics'], '个人信息':['basics'],
  '教育背景':['education'], '教育经历':['education'], '实习经历':['internship'], '工作经历':['work'],
  '实习/工作经历':['internship','work'],
  '项目经验':['projects'], '项目经历':['projects'], '语言能力':['languages','englishLevels'],
  '获奖经历':['awards'], '获奖情况':['awards'], '投递意向':['expected','application'],
  '家庭情况':['family'], '家庭关系':['family'], '附件':['basics'], '陈述情况':['basics','application'],
  '自我描述':['basics'], '其他':['application'], '信息确认':[], '更新说明':[]
};

function fieldsForElement(el, fields, occurrenceByGroup, recordIndex = 0, recordBindings = {}) {
  const prefixes = ELEMENT_SECTION_PREFIXES[el.section];
  let candidates = fields.filter((field) => (!prefixes || prefixes.includes(field.path.split(/[.\[]/)[0])) && matchesField(el, field));
  let matchedByValue = false;
  if (!candidates.length && String(el.value || '').trim() && !/^\d{1,4}$/.test(String(el.value).trim())) {
    candidates = fields.filter(field => (!prefixes || prefixes.includes(field.path.split(/[.\[]/)[0])) &&
      currentValueSatisfies(el, field.value));
    matchedByValue = candidates.length > 0;
  }
  const score = field => Math.max(...field.terms.filter(term => matchesTerm(el, term)).map(term => normalizeText(term).length));
  const best = Math.max(0, ...candidates.map(score));
  const matched = matchedByValue ? candidates : candidates.filter(field => score(field) === best);
  const direct = [];
  const repeated = new Map();

  for (const field of matched) {
    const namedFamily = /^family\[\d+\]\.name$/.test(field.path) && /(父亲|母亲)姓名/.test(el.label || '');
    const group = namedFamily || /^basics\.lifePhotos\[\d+\]$/.test(field.path) ? null : repeatedFieldGroup(field.path);
    if (group) {
      if (!repeated.has(group)) repeated.set(group, []);
      repeated.get(group).push(field);
    } else {
      direct.push(field);
    }
  }

  for (const [group, groupFields] of repeated) {
    const occurrenceKey = `${group}|${normalizeText(el.label)}`;
    const hasStableRecord = Number.isInteger(el.recordIndex);
    const position = hasStableRecord ? el.recordIndex : (occurrenceByGroup.get(occurrenceKey) ?? recordIndex);
    const collection = group.split('[')[0];
    const bindings = recordBindings[collection];
    const sourcePosition = bindings && Object.hasOwn(bindings,position) ? bindings[position] : position;
    const bound = sourcePosition === null ? null : groupFields.find(field => Number(field.path.match(/\[(\d+)\]/)?.[1]) === sourcePosition);
    if (bound) direct.push(bound);
    if (!hasStableRecord) occurrenceByGroup.set(occurrenceKey, position + 1);
  }
  return direct;
}

function actionSummary(action) {
  const intent = interactionIntent(action);
  if (['WORK_SECTION','FOCUS_SECTION','ADD_RECORD','DEFER_SECTION','EXIT_SECTION_MENU','STOP_FILL'].includes(action.operation)) {
    return {
      operation: intent,
      section: action.section || null,
      target: `[${action.target}] ${action.label}`,
      current_state: action.value || ''
    };
  }
  if (action.formRule) {
    return {
      operation: intent,
      target: `[${action.target}] ${action.label}`,
      form_rule: action.formRule,
      selected_value: action.value,
      source: action.context === "popup" ? "open picker option" : "site-specific form rule"
    };
  }
  if (action.operation === "CLICK" && !action.resumeField) return `Open section [${action.target}] ${action.label}.`;
  return {
    operation: intent,
    target: `[${action.target}] ${action.fieldLabel || action.kind}`,
    resume_field: action.resumeField,
    field_label: action.fieldLabel,
    option_label: action.context === 'popup' ? action.label : undefined,
    source_meaning: action.semanticFallback ? action.semanticValue : undefined,
    source: action.context === "popup" ? "open picker option" : "mapped form field"
  };
}

function formSemanticText(el) {
  return `${el.label || ""} ${el.name || ""}`;
}

function hasFormRuleSignal(el, signal) {
  return Array.isArray(el.formRuleSignals) && el.formRuleSignals.includes(signal);
}

function isAgreementControl(el) {
  const semantic = formSemanticText(el);
  return ["checkbox", "custom-checkbox"].includes(el.kind) &&
    (hasFormRuleSignal(el, "agreement") || AGREEMENT_RE.test(semantic) || /上述.*知悉.*确认/.test(semantic));
}

function isRelativeEmploymentControl(el) {
  if (!['radio','custom-radio','custom-select','combobox','native-select'].includes(el.kind)) return false;
  const semantic = formSemanticText(el);
  if (!hasFormRuleSignal(el, "relative-employment") && !RELATIVE_EMPLOYMENT_RE.test(semantic)) return false;
  // radio 的“是/否”会分成两个 DOM 元素；只有“否”代表需要的目标状态。
  return el.role !== "radio" || isNoChoice(el);
}

function relativeEmploymentIsSatisfied(el) {
  if (el.role === "radio") return el.checked === true && isNoChoice(el);
  return isNoChoice({ value: el.value, label: el.value });
}

function isNoChoice(el) {
  const value = String(el.optionValue || el.value || "").trim();
  const label = String(el.label || "").trim();
  return NO_CHOICE_RE.test(value) || NO_CHOICE_RE.test(label);
}

function isYesChoice(el) {
  const value = String(el.optionValue || el.value || "").trim();
  const label = String(el.label || "").trim();
  return /^(是|有|接受|同意|服从)$/.test(value) || /^(是|有|接受|同意|服从)$/.test(label);
}

function isJobAdjustmentControl(el) {
  if (!['radio','custom-radio','custom-select','combobox','native-select'].includes(el.kind)) return false;
  const semantic = formSemanticText(el);
  if (!hasFormRuleSignal(el, "job-adjustment") && !/(岗位|职位|接受|服从).{0,8}调剂/.test(semantic)) return false;
  return el.role !== "radio" || isYesChoice(el);
}

function jobAdjustmentIsSatisfied(el) {
  if (el.role === "radio") return el.checked === true && isYesChoice(el);
  // Moka 会把已选值与旧校验提示一起投影到同一容器（如“是必填项未填写”）。
  // 选择值以开头的精确词元为准，防止规划器反复打开已经选好的下拉框。
  return /^(是|接受|同意|服从)/.test(normalizeText(el.value));
}

function jobAdjustmentRule(el) {
  if (!isJobAdjustmentControl(el) || jobAdjustmentIsSatisfied(el)) return null;
  const operations = el.operations || [];
  if (el.role === "radio") {
    return isYesChoice(el) && operations.includes("CLICK")
      ? { formRule: "job-adjustment-yes", value: "是" }
      : null;
  }
  if ((el.kind === "native-select" || el.role === "combobox") && Array.isArray(el.options)) {
    const option = el.options.find(isYesChoice);
    return option && operations.includes("SELECT")
      ? { formRule: "job-adjustment-yes", value: "是", option }
      : null;
  }
  if (["custom-select", "combobox"].includes(el.kind) && operations.includes("CLICK")) {
    return { formRule: "job-adjustment-yes", value: "是" };
  }
  return null;
}

function relativeEmploymentRule(el) {
  if (!isRelativeEmploymentControl(el) || relativeEmploymentIsSatisfied(el)) return null;
  const operations = el.operations || [];
  if (el.role === "radio") {
    return isNoChoice(el) && el.checked !== true && operations.includes("CLICK")
      ? { formRule: "relative-employment-no", value: "否" }
      : null;
  }
  if ((el.kind === "native-select" || el.role === "combobox") && Array.isArray(el.options)) {
    if (isNoChoice({ value: el.value, label: el.value })) return null;
    const option = el.options.find(isNoChoice);
    return option && operations.includes("SELECT")
      ? { formRule: "relative-employment-no", value: "否", option }
      : null;
  }
  if (["custom-select", "combobox"].includes(el.kind) && operations.includes("CLICK")) {
    if (isNoChoice({ value: el.value, label: el.value })) return null;
    return { formRule: "relative-employment-no", value: "否" };
  }
  return null;
}

function agreementRule(el) {
  if (!isAgreementControl(el) || el.checked === true) return null;
  if (!(el.operations || []).includes("CLICK")) return null;
  return { formRule: "agreement", value: "同意" };
}

function activePickerFromHistory(lastAction, fieldsByPath) {
  if (!lastAction || !["click", "select", "type_text", "failed"].includes(lastAction.kind)) return null;
  if (!['click','failed'].includes(lastAction.kind) && lastAction.context !== "popup" && lastAction.controlKind !== 'combobox') return null;
  if (lastAction.formRule === "relative-employment-no") {
    return { formRule: lastAction.formRule, value: "否", label: "亲属在本公司工作" };
  }
  if (lastAction.formRule === "job-adjustment-yes") {
    return { formRule: lastAction.formRule, value: "是", label: "是否接受岗位调剂" };
  }
  if (lastAction.formRule === 'iter-recruitment-source') {
    return { formRule: lastAction.formRule, value: '企业校招官网/微信公众号', label: '招聘信息来源' };
  }
  if (lastAction.formRule === 'recruitment-source') {
    return {
      formRule:lastAction.formRule,
      value:'校园招聘官网',
      resolvedValue:lastAction.resolvedValue || undefined,
      label:'招聘信息来源'
    };
  }
  if (lastAction.formRule === 'iter-internship-work-type') {
    return { formRule: lastAction.formRule, value: '实习', label: '工作性质' };
  }
  const field = fieldsByPath.get(lastAction.resumeField);
  return field ? { ...field, controlStableKey:lastAction.controlStableKey } : null;
}

// 代码负责精确映射、去重、排除最终投递；Jev 仅在完整动作间选择顺序。
export function buildActionPlan(elements, resume, history = [], page = {}) {
  elements = [...(elements || [])].sort((a,b) => (a.domOrder ?? 0) - (b.domOrder ?? 0));
  let lifePhotoOrder=0;
  elements=elements.map(el=>{
    if (el.kind!=='file' || !/生活照|全身照/.test(elementText(el))) return el;
    const numbered=elementText(el).match(/(?:生活照|全身照)\s*([12一二])/);
    const ordinal=numbered ? ({'1':0,'2':1,'一':0,'二':1}[numbered[1]]) : lifePhotoOrder;
    lifePhotoOrder++;
    return {...el,lifePhotoIndex:ordinal};
  });
  const title = String(page.title || '').trim();
  const collection = sectionCollection(title);
  const combinedExperience = title === '实习/工作经历';
  const internshipCount = resume?.internship?.length || 0;
  const selectedExperience = combinedExperience ?
    (Number(page.recordIndex || 0) < internshipCount ? 'internship' : 'work') : '';
  const logicalRecordIndex = combinedExperience && selectedExperience === 'work' ?
    Math.max(0, Number(page.recordIndex || 0) - internshipCount) : Number(page.recordIndex || 0);
  const sectionPrefixes = combinedExperience ? [selectedExperience] :
    SECTION_FIELD_PREFIXES[title] || (collection ? [collection] : undefined);
  const fields = listResumeFields(resume).filter(field => !sectionPrefixes || sectionPrefixes.includes(field.path.split(/[.\[]/)[0]));
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  // Existing records bind by their observed identity before any blank child field is filled.
  // An unknown existing record remains user-owned and receives no ordinal fallback.
  const recordBindings = {};
  const identityKeys = {education:'institution',internship:'company',work:'company',projects:'name',
    awards:'title',certificates:'name'};
  for (const [recordCollection,identityKey] of Object.entries(identityKeys)) {
    if (sectionCollection(title) !== recordCollection) continue;
    const sources = resume[recordCollection] || [];
    const rule = resolveFieldRule(`${recordCollection}[0].${identityKey}`);
    if (!rule) continue;
    const anchors = elements.filter(el=>el.context!=='popup' && rule[2].some(term=>matchesTerm(el,term)) &&
      ['input','combobox','custom-select'].includes(el.kind));
    if (!anchors.length || !anchors.some(hasExistingPageValue)) continue;
    recordBindings[recordCollection] = {};
    anchors.forEach((anchor,ordinal)=>{
      const position = Number.isInteger(anchor.recordIndex) ? anchor.recordIndex : ordinal;
      const sourceIndex = hasExistingPageValue(anchor) ? sources.findIndex(record=>
        normalizeText(record[identityKey])===normalizeText(anchor.value)) : position;
      recordBindings[recordCollection][position] = sourceIndex < 0 ? null : sourceIndex;
    });
  }
  const lastAction = history[history.length - 1];
  let activePicker = activePickerFromHistory(lastAction, fieldsByPath);
  const deferredFields = new Set(history.filter(h => h.cancelField).map(h => h.cancelField));
  const actions = [];
  const seen = new Set();
  const matchedControls = new Set();
  const satisfiedControls = new Set();
  const preservedConflicts = new Map();
  const occurrenceByGroup = new Map();
  let mokaPage = false;
  try { mokaPage = page.platform === 'moka-form' || /(^|\.)mokahr\.com$/i.test(new URL(page.url || 'https://invalid.local').hostname); } catch (_) {}
  const add = (action) => {
    if (activePicker?.controlStableKey && action.resumeField === activePicker.path && !action.controlStableKey) {
      action.controlStableKey = activePicker.controlStableKey;
    }
    const key = `${action.operation}|${action.target}|${action.resumeField || ""}|${action.formRule || ""}`;
    if (seen.has(key) || actions.length >= MAX_ACTION_CANDIDATES) return;
    seen.add(key);
    actions.push({ ...action, id: `a${actions.length + 1}` });
  };

  const mokaAddRecordAction = () => {
    if (!mokaPage) return null;
    const specs = [
      {section:'教育背景',collection:'education',anchor:/^学校名称$/},
      {section:'实习经历',collection:'internship',anchor:/^实习职责$/},
      {section:'项目经验',collection:'projects',anchor:/^项目描述$/},
      {section:'语言能力',collection:'languages',anchor:/^语言类型$/},
      {section:'获奖经历',collection:'awards',anchor:/^奖项名称$/}
    ];
    for (const spec of specs) {
      const wanted = Array.isArray(resume?.[spec.collection]) ? resume[spec.collection].length : 0;
      if (!wanted) continue;
      const rendered = elements.filter(el => el.section === spec.section &&
        spec.anchor.test(String(el.label || '').replace(/\s*\*\s*$/, '').trim()) && el.context !== 'popup').length;
      if (rendered >= wanted) continue;
      const button = elements.find(el => {
        const compact = String(el.label || '').replace(/\s/g,'');
        return el.section === spec.section && compact.endsWith('添加') && compact.length <= 6 && (el.operations || []).includes('CLICK');
      });
      if (button) return {operation:'CLICK',target:button.index,sourceTarget:button.index,formRule:'moka-add-record',
        value:`${spec.section} ${rendered + 1}/${wanted}`,label:`添加${spec.section}`,kind:button.kind,offscreen:!!button.offscreen};
    }
    return null;
  };

  // 选择器弹层是一段必须连续完成的操作。荣耀的 picker 需要“选值 → 确定”，
  // 所以当刚刚打开或操作过一个弹层时，只提供该弹层的下一步，避免页面重排后
  // 把另一个字段或另一个弹层插进来。
  const popupItems = (elements || []).filter((el) => el.context === "popup" &&
    !/^(?:删除|移除|delete)$/i.test(String(el.label || '').trim()) &&
    (el.operations || []).includes("CLICK"));
  if (activePicker?.formRule === 'job-adjustment-yes' && popupItems.length) {
    const target=popupItems.find(isYesChoice);
    if (target) {
      add({operation:'CLICK',target:target.index,sourceTarget:target.index,formRule:activePicker.formRule,
        value:'是',label:target.label,kind:target.kind,context:'popup'});
      return {actions,byId:Object.fromEntries(actions.map(action=>[action.id,action])),status:'ready',
        summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
    }
  }
  const awaitingCustomName = activePicker && /^education\[\d+\]\.(institution|area)$/.test(activePicker.path) &&
    /^添加(?:学校|专业)全称$/.test(String(lastAction?.label || '').trim());
  const customNameEditor = activePicker && /^education\[\d+\]\.(institution|area)$/.test(activePicker.path) &&
    elements.find(el => (el.operations || []).includes('TYPE_TEXT') &&
      new RegExp(activePicker.path.endsWith('.institution') ? '学校.*全称' : '专业.*全称')
        .test(`${String(el.label || '')} ${String(el.placeholder || '')}`));
  // 选择联想结果后，主表单控件已回读到目标值，该事务已完成。
  // 页面上其他常驻浮层（如面试站点）不应继续锁住上一个选择器。
  if (activePicker && lastAction?.context === 'popup') {
    // Moka 点“添加专业全称”后，主输入框仍保留刚才的搜索词。它只是搜索缓存，
    // 二级编辑器完成“再次输入 → 添加”前还没有真正选中，不能据此提前结束事务。
    const needsCommittedSelection = mokaPage && /^education\[\d+\]\.(institution|area)$/.test(activePicker.path);
    const committed = !awaitingCustomName && !customNameEditor && elements.some(el =>
      el.context !== 'popup' &&
      (activePicker.controlStableKey ? el.stableKey === activePicker.controlStableKey : matchesField(el, activePicker)) &&
      (activePicker.pickerPath
        ? activePicker.pickerPath.every(part => normalizeRegion(el.value).includes(normalizeRegion(part)))
        : currentValueSatisfies(el, activePicker.value)) &&
      (!needsCommittedSelection || el.valueCommitted === true));
    // 只以主表单的目标值回读作为事务完成信号。弹层在搜索过程中可能短暂
    // 消失，若据此推断完成，下一字段会继续写入上一个搜索编辑器。
    if (committed) activePicker = null;
  }
  if (activePicker && /^computerSkills\[\d+\]\.name$/.test(activePicker.path) &&
      !popupItems.some(el=>normalizeText(el.label)===normalizeText(activePicker.value)) &&
      popupItems.some(el=>el.label==='其他')) {
    activePicker.value='其他';
    activePicker.resolvedValue='其他';
  }
  if (/^education\[\d+\]\.ranking$/.test(activePicker?.path || '') &&
      /^TOP\s*50%$/i.test(activePicker.value) &&
      !popupItems.some(el => popupMatchesValue(el, activePicker.value)) &&
      popupItems.some(el => normalizeText(el.label) === '其他')) {
    activePicker.value = '其他';
    activePicker.resolvedValue = '其他';
  }
  const degreeLevel = activePicker && academicDegreeLevel(resume, activePicker.path);
  if (degreeLevel && !popupItems.some(el => normalizeText(el.label) === normalizeText(activePicker.value)) &&
      popupItems.some(el => normalizeText(el.label) === normalizeText(degreeLevel))) activePicker.value = degreeLevel;
  const studyModeIndex=String(activePicker?.path || '').match(/^education\[(\d+)\]\.studyMode$/)?.[1];
  if (studyModeIndex !== undefined && /香港|澳门|澳門|台湾|臺灣/.test(String(resume?.education?.[Number(studyModeIndex)]?.country || ''))) {
    const overseas=popupItems.filter(el=>/^(海外留学生|境外留学生|港澳台留学生)$/.test(String(el.label || '').trim()));
    if (overseas.length) {
      activePicker.value=overseas[0].label;
      activePicker.resolvedValue=overseas[0].label;
    }
  }
  // 自定义技能选择已结束，新增的正文输入框作为当前记录字段继续规划。
  if (activePicker && /^professionalSkills\[\d+\]\.name$/.test(activePicker.path || '') &&
      !popupItems.length && elements.some(el=>el.context!=='popup' && el.operations?.includes('TYPE_TEXT') &&
        /^其他技能$/.test(String(el.label || '').trim()))) activePicker=null;
  const activeEditor = customNameEditor || activePicker && elements.find(el => (el.operations || []).includes("TYPE_TEXT") &&
    el.context !== 'popup' && matchesField(el, activePicker));
  if (activeEditor && (customNameEditor || !popupItems.length) && !currentValueSatisfies(activeEditor, activePicker.value)) {
    add({operation:"TYPE_TEXT",target:activeEditor.index,sourceTarget:activeEditor.index,resumeField:activePicker.path,
      fieldLabel:activePicker.label,label:activeEditor.label,kind:activeEditor.kind,context:"popup",
      resolvedValue:activePicker.resolvedValue || activePicker.value});
    return {actions,byId:Object.fromEntries(actions.map(a=>[a.id,a])),status:"ready",summary:{mappedControls:1,satisfiedControls:0,actionCount:1}};
  }
  if (activePicker && customNameEditor && currentValueSatisfies(customNameEditor, activePicker.value)) {
    const commitCustomName = elements.find(el => /^添加$/.test(String(el.label || '').trim()) &&
      (el.context === 'popup' || awaitingCustomName));
    if (commitCustomName) {
      add({operation:'CLICK',target:commitCustomName.index,sourceTarget:commitCustomName.index,
        resumeField:activePicker.path,fieldLabel:activePicker.label,value:activePicker.value,
        label:commitCustomName.label,kind:commitCustomName.kind,context:'popup'});
      return {actions,byId:Object.fromEntries(actions.map(a=>[a.id,a])),status:'ready',
        summary:{mappedControls:1,satisfiedControls:0,actionCount:1}};
    }
  }
  const pickerColumns = (elements || []).filter(el => el.kind === "picker-column");
  if (activePicker && pickerColumns.length) {
    const dateParts = String(activePicker.value).match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    const values = dateParts ? dateParts.slice(1).filter(Boolean).map(Number).map(String) : [activePicker.value];
    if (activePicker.value === '至今') {
      return {actions:[],byId:{},status:'blocked',pickerField:activePicker.path,
        cancelTarget:popupItems.find(el=>/^(取消|cancel)$/i.test(el.label))?.index,
        dataGap:'页面日期字段未提供“至今”选项，结束时间留空',summary:{mappedControls:1,satisfiedControls:0,actionCount:0}};
    }
    if (dateParts && values.length !== pickerColumns.length) {
      return { actions: [], byId: {}, status: "blocked", pickerField: activePicker.path,
        cancelTarget: popupItems.find(el => /^(取消|cancel)$/i.test(el.label))?.index,
        dataGap: "日期精度不足：页面要求完整年月日", summary: { mappedControls: 1, satisfiedControls: 0, actionCount: 0 } };
    }
    let allSelected = values.length === pickerColumns.length;
    for (let i = 0; i < values.length && i < pickerColumns.length; i++) {
      const el = pickerColumns[i];
      const same = v => dateParts ? String(parseInt(v, 10)) === values[i] : normalizeText(v) === normalizeText(values[i]);
      if (same(el.value)) continue;
      allSelected = false;
      const option = el.options.find(opt => same(opt.label));
      if (option) add({ operation: "SELECT", target: option.index, sourceTarget: el.index,
        resumeField: activePicker.path, fieldLabel: activePicker.label, formRule: activePicker.formRule,
        value: activePicker.value, label: el.label, kind: el.kind, context: "popup" });
      break;
    }
    if (allSelected) {
      const confirm = popupItems.find(el => PICKER_CONFIRM_RE.test(el.label.trim()));
      if (confirm) add({ operation: "CLICK", target: confirm.index, sourceTarget: confirm.index,
        resumeField: activePicker.path, fieldLabel: activePicker.label, formRule: activePicker.formRule,
        value: activePicker.value, label: confirm.label, kind: confirm.kind, context: "popup" });
    }
    return { actions, byId: Object.fromEntries(actions.map(a => [a.id,a])), status: actions.length ? "ready" : "blocked",
      pickerField: activePicker.path, cancelTarget: popupItems.find(el => /^(取消|cancel)$/i.test(el.label))?.index,
      summary: { mappedControls: 1, satisfiedControls: 0, actionCount: actions.length } };
  }
  if (activePicker && /^\d{4}-\d{2}(?:-\d{2})?$/.test(activePicker.value)) {
    const presentRecord = String(activePicker.path || '').match(/^internship\[(\d+)\]\.endDate$/);
    const presentOption = presentRecord && resume?.internship?.[Number(presentRecord[1])]?.isPresent &&
      elements.find(el => /^至今$/.test(String(el.label || '').trim()) && (el.operations || []).includes('CLICK'));
    if (presentOption) {
      add({operation:'CLICK',target:presentOption.index,sourceTarget:presentOption.index,
        resumeField:activePicker.path,fieldLabel:activePicker.label,value:'至今',
        label:presentOption.label,kind:presentOption.kind,context:'popup',resolvedValue:'至今'});
      return {actions,byId:Object.fromEntries(actions.map(action=>[action.id,action])),status:'ready',
        pickerField:activePicker.path,summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
    }
    const yearControl = elements.find(el => /^\d{4}\s*年?$/.test(String(el.label || '').trim()) &&
      (el.operations || []).includes('CLICK'));
    const monthControl = elements.find(el => /^\d{1,2}\s*月$/.test(String(el.label || '').trim()) &&
      (el.operations || []).includes('CLICK'));
    const calendarDays = popupItems.filter(el => el.calendarDate);
    const monthNames=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    const monthNumber=label=>{
      const text=String(label || '').trim();
      const numeric=text.match(/^(\d{1,2})月$/);
      return numeric ? Number(numeric[1]) : monthNames.indexOf(text)+1;
    };
    const monthChoices=popupItems.filter(el=>monthNumber(el.label)>0);
    const wantedYear=Number(activePicker.value.slice(0,4));
    const rangeHeader=elements.find(el=>/^(\d{4})\s*-\s*(\d{4})$/.test(String(el.label || '').trim()) &&
      el.operations?.includes('CLICK'));
    const rangeParts=String(rangeHeader?.label || '').match(/^(\d{4})\s*-\s*(\d{4})$/);
    if (rangeParts && !monthChoices.length) {
      const rangeStart=Number(rangeParts[1]);
      const rangeEnd=Number(rangeParts[2]);
      const centuryView=rangeEnd-rangeStart>=90;
      const choices=popupItems.filter(el=>el.kind==='option-item' &&
        (centuryView ? /^\d{4}\s*-\s*\d{4}$/.test(el.label) : /^\d{4}$/.test(el.label)));
      let target=centuryView ? choices.find(el=>{
        const parts=el.label.match(/^(\d{4})\s*-\s*(\d{4})$/);
        return parts && wantedYear>=Number(parts[1]) && wantedYear<=Number(parts[2]);
      }) : choices.find(el=>Number(el.label)===wantedYear);
      if (!target && centuryView) target=elements.find(el=>el.label===(wantedYear<rangeStart?'上一页':'下一页') &&
        el.operations?.includes('CLICK'));
      if (!target && !centuryView) target=rangeHeader;
      if (target) add({operation:'CLICK',target:target.index,sourceTarget:target.index,
        resumeField:activePicker.path,fieldLabel:activePicker.label,value:activePicker.value,
        label:target.label,kind:target.kind,context:'popup'});
      return {actions,byId:Object.fromEntries(actions.map(action=>[action.id,action])),
        status:actions.length?'ready':'blocked',pickerField:activePicker.path,
        summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
    }
    if (yearControl && monthChoices.length >= 6 && !calendarDays.length) {
      const [wantedYear,wantedMonth]=activePicker.value.split('-').map(Number);
      const currentYear=Number(yearControl.label.match(/\d{4}/)[0]);
      const target=currentYear===wantedYear ? monthChoices.find(el=>monthNumber(el.label)===wantedMonth) :
        elements.find(el=>String(el.label).trim()===String(currentYear) && el.kind!=='option-item' && el.operations?.includes('CLICK')) ||
        yearControl ||
        elements.find(el=>el.label===(currentYear>wantedYear?'前一年':'后一年') && el.operations?.includes('CLICK'));
      if(target) add({operation:'CLICK',target:target.index,sourceTarget:target.index,resumeField:activePicker.path,
        fieldLabel:activePicker.label,value:activePicker.value,label:target.label,kind:target.kind,context:'popup'});
      return {actions,byId:Object.fromEntries(actions.map(a=>[a.id,a])),status:actions.length?'ready':'blocked',
        pickerField:activePicker.path,summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
    }
    const editableDate = elements.some(el=>el.context==='popup' && el.operations?.includes('TYPE_TEXT') &&
      /日期|时间|date/i.test(`${el.label} ${el.placeholder || ''}`));
    if (!editableDate && yearControl && monthControl && calendarDays.length) {
      const currentYear = Number(String(yearControl.label).match(/\d{4}/)[0]);
      const currentMonth = Number(String(monthControl.label).match(/\d{1,2}/)[0]);
      const [wantedYear,wantedMonth] = activePicker.value.split('-').map(Number);
      const navLabel = currentYear > wantedYear ? '前一年' : currentYear < wantedYear ? '后一年' :
        currentMonth > wantedMonth ? '上个月' : currentMonth < wantedMonth ? '下个月' : '';
      const target = navLabel ? elements.find(el => String(el.label || '').trim() === navLabel &&
        (el.operations || []).includes('CLICK')) :
        calendarDays.find(el => el.calendarDate === activePicker.value);
      if (target) add({operation:'CLICK',target:target.index,sourceTarget:target.index,
        resumeField:activePicker.path,fieldLabel:activePicker.label,value:activePicker.value,
        label:target.label,kind:target.kind,context:'popup',calendarStep:navLabel || 'day'});
      return {actions,byId:Object.fromEntries(actions.map(action=>[action.id,action])),
        status:actions.length ? 'ready' : 'blocked',pickerField:activePicker.path,
        summary:{mappedControls:1,satisfiedControls:0,actionCount:actions.length}};
    }
  }
  if (activePicker && (popupItems.length || elements.some(el=>el.context==='popup' && el.operations?.includes('TYPE_TEXT')))) {
    const observed = planObservedPopup({elements, field:activePicker, history, matchesValue:popupMatchesValue});
    for (const action of observed.actions) add(action);
    if (!actions.some(action=>action.intent!=='RETURN') && lastAction?.context === 'popup' && !awaitingCustomName) {
      const opener=elements.find(el=>el.context!=='popup' && el.operations?.includes('CLICK') &&
        (activePicker.controlStableKey ? el.stableKey===activePicker.controlStableKey : matchesField(el,activePicker)));
      if (opener) add({operation:'CLICK',intent:'OPEN',target:opener.index,sourceTarget:opener.index,
        resumeField:activePicker.path,fieldLabel:activePicker.label,label:opener.label,kind:opener.kind,
        controlStableKey:activePicker.controlStableKey});
    }
    actions.sort((a,b)=>Number(a.intent==='RETURN')-Number(b.intent==='RETURN'));
    return {...observed,actions,byId:Object.fromEntries(actions.map(action=>[action.id,action]))};
  }

  for (const el of elements || []) {
    const label = String(el.label || "");
    if (FINAL_SUBMIT_RE.test(label)) continue;
    const scopedElement = sectionPrefixes ? {...el, bindingSection:el.section || title, section:undefined} : el;
    const boundFields = el.context === 'popup' ? [] :
      fieldsForElement(scopedElement, fields, occurrenceByGroup, logicalRecordIndex, recordBindings);

    // 已有页面值由网站和用户共同维护。一次填写只补空项；不同于本地资料的
    // 已有值同样保留，后续可由用户单独核对。
    const selectedRadioPeer = el.role === 'radio' && (elements || []).some(peer =>
      peer !== el && peer.role === 'radio' && peer.checked === true &&
      (el.name ? peer.name === el.name : peer.label === el.label));
    if (el.context !== 'popup' && (hasExistingPageValue(el) || selectedRadioPeer)) {
      matchedControls.add(el.index);
      const identity=boundFields.find(field=>
        /^(?:education\[\d+\]\.institution|(?:internship|work)\[\d+\]\.company|family\[\d+\]\.name|awards\[\d+\]\.title)$/.test(field.path));
      if (identity && !currentValueSatisfies(el,identity.value)) {
        preservedConflicts.set(el.index,`页面已有值与 ${identity.path} 不同，按保留已填写内容规则未覆盖`);
      } else satisfiedControls.add(el.index);
      continue;
    }

    // Moka 的“意向工作城市”依赖“校招面试站点”先完成；站点为空时城市
    // 数据源只返回“暂无选项”。先收敛上游字段，下一轮再开放城市动作。
    if (mokaPage && /意向工作城市/.test(label)) {
      const interviewSite = elements.find(item => item.context !== 'popup' && /校招面试站点/.test(String(item.label || '')));
      if (interviewSite && !normalizeText(interviewSite.value)) continue;
    }

    if (el.context === "popup" && (el.operations || []).includes("CLICK")) {
      // 浮层的文字通常只有“男”“本科”“2024”这类值，本身无法指向某个重复经历。
      // 绑定到上一轮刚打开的选择器，才能确保点到的是那个字段需要的值。
      if (activePicker && popupMatchesValue(el, activePicker.value) && el.checked !== true) {
        add({ operation: "CLICK", target: el.index, sourceTarget: el.index, resumeField: activePicker.path, fieldLabel: activePicker.label, formRule: activePicker.formRule, value: activePicker.value, label, kind: el.kind, context: "popup", offscreen: !!el.offscreen });
      }
      continue;
    }

    if (isAgreementControl(el)) {
      matchedControls.add(el.index);
      if (el.checked === true) {
        satisfiedControls.add(el.index);
        continue;
      }
      const agreement = agreementRule(el);
      if (!agreement) continue;
      add({
        operation: "CLICK",
        target: el.index,
        sourceTarget: el.index,
        formRule: agreement.formRule,
        value: agreement.value,
        label,
        kind: el.kind,
        offscreen: !!el.offscreen
      });
      continue;
    }

    if (isRelativeEmploymentControl(el)) {
      matchedControls.add(el.index);
      if (relativeEmploymentIsSatisfied(el)) {
        satisfiedControls.add(el.index);
        continue;
      }
      const relativeEmployment = relativeEmploymentRule(el);
      if (!relativeEmployment) continue;
      if (relativeEmployment.option) {
        add({
          operation: "SELECT",
          target: relativeEmployment.option.index,
          sourceTarget: el.index,
          formRule: relativeEmployment.formRule,
          value: relativeEmployment.value,
          label,
          kind: el.kind,
          offscreen: !!el.offscreen
        });
      } else {
        add({
          operation: "CLICK",
          target: el.index,
          sourceTarget: el.index,
          formRule: relativeEmployment.formRule,
          value: relativeEmployment.value,
          label,
          kind: el.kind,
          offscreen: !!el.offscreen
        });
      }
      continue;
    }

    if (isJobAdjustmentControl(el)) {
      matchedControls.add(el.index);
      if (jobAdjustmentIsSatisfied(el)) {
        satisfiedControls.add(el.index);
        continue;
      }
      const adjustment = jobAdjustmentRule(el);
      if (!adjustment) continue;
      if (adjustment.option) {
        add({
          operation: "SELECT",
          target: adjustment.option.index,
          sourceTarget: el.index,
          formRule: adjustment.formRule,
          value: adjustment.value,
          label,
          kind: el.kind,
          offscreen: !!el.offscreen
        });
      } else {
        add({
          operation: "CLICK",
          target: el.index,
          sourceTarget: el.index,
          formRule: adjustment.formRule,
          value: adjustment.value,
          label,
          kind: el.kind,
          offscreen: !!el.offscreen
        });
      }
      continue;
    }

    if (mokaPage && /具体来源/.test(`${label} ${String(el.placeholder || '')}`) &&
        (el.operations || []).includes('TYPE_TEXT')) {
      const sourceDetail=fieldsByPath.get('application.recruitmentSourceDetail') ||
        {path:'application.recruitmentSourceDetail',value:'校园招聘官网',label:'招聘信息具体来源'};
      matchedControls.add(el.index);
      if (currentValueSatisfies(el,sourceDetail.value)) satisfiedControls.add(el.index);
      else add({operation:'TYPE_TEXT',target:el.index,sourceTarget:el.index,resumeField:sourceDetail.path,
        resolvedValue:sourceDetail.value,fieldLabel:sourceDetail.label,label,kind:el.kind,offscreen:!!el.offscreen});
      continue;
    }

    if (el.name === 'recSources' && el.kind === 'custom-select') {
      matchedControls.add(el.index);
      const source = '企业校招官网/微信公众号';
      if (currentValueSatisfies(el, source)) satisfiedControls.add(el.index);
      else add({operation:'CLICK',target:el.index,sourceTarget:el.index,
        formRule:'iter-recruitment-source',value:source,label,kind:el.kind,offscreen:!!el.offscreen});
      continue;
    }
    if (/招聘信息来源/.test(label) && ['custom-select','combobox'].includes(el.kind) && !el.operations?.includes('TYPE_TEXT')) {
      matchedControls.add(el.index);
      const source='校园招聘官网';
      const resolvedOther = mokaPage && normalizeText(el.value) === '其他';
      if (currentValueSatisfies(el,source) || resolvedOther) satisfiedControls.add(el.index);
      else add({operation:'CLICK',target:el.index,sourceTarget:el.index,formRule:'recruitment-source',
        value:source,label,kind:el.kind,offscreen:!!el.offscreen});
      continue;
    }
    if ((page.title === '社会实习经历' ||
        (page.title === '实习/工作经历' && selectedExperience === 'internship')) &&
        /工作(?:性质|类型)/.test(label) && el.kind === 'custom-select') {
      matchedControls.add(el.index);
      if (currentValueSatisfies(el, '实习')) satisfiedControls.add(el.index);
      else add({operation:'CLICK',target:el.index,sourceTarget:el.index,
        formRule:'iter-internship-work-type',value:'实习',label,kind:el.kind,offscreen:!!el.offscreen});
      continue;
    }
    if (/^项目(?:经验|经历)$/.test(page.title) && /项目职责/.test(label) && (el.operations || []).includes('TYPE_TEXT')) {
      const key = 'projects[]|项目职责';
      const hasStableRecord = Number.isInteger(el.recordIndex);
      const position = hasStableRecord ? el.recordIndex : (occurrenceByGroup.get(key) ?? (page.recordIndex || 0));
      if (!hasStableRecord) occurrenceByGroup.set(key, position + 1);
      const field = fieldsByPath.get(`projects[${position}].role`) || fieldsByPath.get(`projects[${position}].description`);
      if (field) {
        matchedControls.add(el.index);
        if (currentValueSatisfies(el,field.value)) satisfiedControls.add(el.index);
        else add({operation:'TYPE_TEXT',target:el.index,sourceTarget:el.index,resumeField:field.path,
          fieldLabel:'项目职责',label,kind:el.kind,offscreen:!!el.offscreen});
      }
      continue;
    }
    for (const field of boundFields) {
      if (!matchesField(el, field)) continue;
      if (!canOfferFieldForControl(el, field)) continue;
      // 选择器无匹配时保留待补记录；可选属性允许留空保存，记录身份仍需填写。
      if (deferredFields.has(field.path) && !el.required &&
          !/\.(name|title|company|institution|language|position)$/.test(field.path)) continue;
      matchedControls.add(el.index);
      const regionSatisfied = field.pickerPath && field.pickerPath.every(part => normalizeRegion(el.value).includes(normalizeRegion(part)));
      const degreeSatisfied = academicDegreeLevel(resume, field.path) && normalizeText(el.value) === normalizeText(academicDegreeLevel(resume, field.path));
      const alternativeSatisfied = history.some(h=>h.resumeField===field.path && (
        h.kind === 'upload_file' || h.resolvedValue && normalizeText(h.resolvedValue)===normalizeText(el.value)
      ));
      const exactReview=page.title==='自我评价' && field.path==='basics.summary';
      const filePath = ['basics.photo','basics.resumeFile'].includes(field.path) || /^basics\.lifePhotos\[\d+\]$/.test(field.path);
      const savedFile = el.kind === 'file' && filePath &&
        normalizeText(el.value) === normalizeText(getResumeValue(resume,field.path)?.name);
      const needsCommittedSelection = mokaPage && /^education\[\d+\]\.(institution|area)$/.test(field.path) && el.kind === 'combobox';
      const valueSatisfied=exactReview ? normalizeText(el.value)===normalizeText(field.value) :
        currentValueSatisfies(el, field.value) && (!needsCommittedSelection || el.valueCommitted === true);
      if (regionSatisfied || degreeSatisfied || alternativeSatisfied || valueSatisfied || savedFile) {
        satisfiedControls.add(el.index);
        continue;
      }
      if (deferredFields.has(field.path)) continue;

      const operations = el.operations || [];
      if (operations.includes("PICK_DATE")) {
        add({operation:"PICK_DATE",target:el.index,sourceTarget:el.index,resumeField:field.path,
          fieldLabel:field.label,label,kind:el.kind,offscreen:!!el.offscreen});
      }
      if (operations.includes("UPLOAD_FILE") && filePath) {
        add({ operation:'UPLOAD_FILE', target:el.index, sourceTarget:el.index, resumeField:field.path,
          fieldLabel:field.label, label, kind:el.kind, offscreen:!!el.offscreen });
      }
      if (operations.includes("TYPE_TEXT")) {
        add({ operation: "TYPE_TEXT", target: el.index, sourceTarget: el.index, resumeField: field.path, fieldLabel: field.label, label, kind: el.kind, offscreen: !!el.offscreen });
      }
      if (operations.includes("SELECT") && Array.isArray(el.options)) {
        const option = el.options.find((item) => popupMatchesValue({ label: item.label || item.text || item.value }, field.value));
        if (option) {
          add({ operation: "SELECT", target: option.index, sourceTarget: el.index, resumeField: field.path, fieldLabel: field.label, label, kind: el.kind, offscreen: !!el.offscreen });
        }
      }
      if (operations.includes("CLICK") && ["custom-select", "custom-radio", "combobox", "date", "custom-checkbox"].includes(el.kind) &&
          !(el.kind === 'combobox' && operations.includes('TYPE_TEXT'))) {
        add({ operation: "CLICK", target: el.index, sourceTarget: el.index, resumeField: field.path, fieldLabel: field.label, label, kind: el.kind, offscreen: !!el.offscreen });
      }
    }
  }

  const mappedFieldActions = actions.length;
  // Moka 单页表单初始只渲染每类经历的第一条。当当前可见记录已无可填
  // 动作时，按本地简历条数逐条新增，下一轮快照再用 DOM 顺序绑定对应记录。
  if (actions.length === 0) {
    if (page.allowAddRecords !== false) {
      const addRecord = mokaAddRecordAction();
      if (addRecord) add(addRecord);
    }
  }
  if (mappedFieldActions === 0 && !page.scopedSection) {
    for (const el of elements || []) {
      const label = String(el.label || "");
      if (el.kind === "card" && CARD_ENTRY_RE.test(label) && (el.operations || []).includes("CLICK")) {
        add({ operation: "CLICK", target: el.index, sourceTarget: el.index, label, kind: "card", offscreen: !!el.offscreen });
      }
    }
  }

  if (actions.length === 0 && matchedControls.size > 0) {
    const requiredMissing = elements.some(el => el.required && el.context !== 'popup' &&
      ['input','textarea','richtext','custom-select','combobox','date','native-select','file'].includes(el.kind) &&
      (!String(el.value || '').trim() || /^(请选择|请填写|需要和)/.test(String(el.value))));
    const mappedMissing = matchedControls.size > satisfiedControls.size;
    for (const el of elements || []) {
      const label = String(el.label || "").trim();
      const compactLabel = label.replace(/\s/g, '');
      const recordSave = page.scopedSection && /^添\s*加$/.test(label) && el.kind !== 'card';
      if (!requiredMissing && !mappedMissing && !FINAL_SUBMIT_RE.test(label) &&
          (SECTION_NAV_RE.test(compactLabel) || recordSave) && (el.operations || []).includes("CLICK")) {
        add({ operation: "CLICK", target: el.index, sourceTarget: el.index, label, kind: el.kind || "action", offscreen: !!el.offscreen });
      }
    }
  }

  const unresolved = (elements || []).filter(el => el.context !== "popup" && !FINAL_SUBMIT_RE.test(el.label || "") &&
    ["input", "textarea", "richtext", "custom-select", "combobox", "date", "native-select", "file"].includes(el.kind) && !satisfiedControls.has(el.index))
    .map(el => {
      const ruleExists=FIELD_RULES.some(([, , terms])=>terms.some(term=>elementText(el).includes(normalizeText(term))));
      const reason=preservedConflicts.get(el.index) || (matchedControls.has(el.index) ? '执行未完成' :
        ruleExists ? '缺少对应数据或控件适配' : '字段尚未映射');
      return {target:el.index,label:el.label,reason};
    });
  const pendingEditor = elements.some(el => el.context === "popup" && (el.operations || []).length > 0);
  const unresolvedMapped = unresolved.filter(item => item.reason === '执行未完成');
  // section 调度器已把上下文隔离到一个页面区域。在该模式下，可选空字段与尚未
  // 建模的控件交给独立的数据缺口规则；完成判定只阻塞已映射但尚未回读的字段。
  const blockingUnresolved = page.ignoreUnmapped ?
    unresolved.filter(item => unresolvedMapped.includes(item) ||
      elements.some(el => el.index === item.target && el.required)) : unresolved;
  const status = actions.length > 0 ? "ready" :
    !pendingEditor && matchedControls.size > 0 && blockingUnresolved.length === 0 ? "done" : "blocked";
  const byId = Object.fromEntries(actions.map((action) => [action.id, action]));
  return {
    actions,
    byId,
    status,
    summary: {
      mappedControls: matchedControls.size,
      satisfiedControls: satisfiedControls.size,
      actionCount: actions.length
      ,unresolved
      ,unresolvedMapped
    }
  };
}

export function buildQuestions(goal, actionPlan) {
  const criteria = {};
  for (const action of actionPlan.actions) criteria[action.id] = actionSummary(action);
  return {
    action: {
      type: "choice",
      criteria,
      instructions: { goal, rules: NEXT_ACTION }
    }
  };
}

// 主调用
export async function choose({ apiKey, goal, page, elements, history, resume, actionPlan }) {
  const plan = actionPlan || buildActionPlan(elements, resume, history);
  // 大型分区按页面顺序提供小批候选；每次回读后再开放后续字段。
  const sectionLevel = plan.actions.some(action =>
    ['WORK_SECTION','FOCUS_SECTION','ADD_RECORD','DEFER_SECTION','EXIT_SECTION_MENU','STOP_FILL'].includes(action.operation));
  const returnActions=plan.actions.filter(action=>interactionIntent(action)==='RETURN');
  const forwardActions=plan.actions.filter(action=>interactionIntent(action)!=='RETURN');
  const limitedActions=[...forwardActions.slice(0,plan.actions.some(action=>action.semanticFallback)?24:8),...returnActions.slice(0,1)];
  const offered = sectionLevel ? plan : {
    ...plan,
    actions: limitedActions,
    byId: Object.fromEntries(limitedActions.map(action => [action.id,action]))
  };
  if (plan.actions.length === 0) throw new Error(`没有可供 Jev 选择的动作（${plan.status}）`);
  // 决策服务不可用时保留页面原状。候选顺序只用于展示，不能代替语义判断。
  if (Date.now() < jevUnavailableUntil) throw new Error('TypeSafe API 暂时不可用，请稍后继续');
  const questions = buildQuestions(goal, offered);

  const body = {
    model: JEV_MODEL,
    state: {
      // 简历值、正文、完整 URL 与执行结果留在本地。候选已经绑定所需字段。
      controls: offered.actions.map(action => ({
        target: action.target,
        kind: action.kind,
        offscreen: !!action.offscreen,
        context: action.context || "form"
      })),
      recent_actions: (history || []).slice(-10).map((h) => ({
        kind: h.kind,
        page_changed: h.page_changed
      }))
    },
    questions
  };

  let res;
  let networkError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      res = await fetch(JEV_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      networkError = null;
    } catch (err) {
      networkError = err;
      if (attempt < 1) {
        await retryDelay(attempt);
        continue;
      }
      break;
    }
    if (res.ok || !TRANSIENT_RETRY_STATUSES.has(res.status) || attempt === 1) break;
    await res.text();
    await retryDelay(attempt);
  }

  if (!res && networkError) {
    jevUnavailableUntil = Date.now() + 5 * 60 * 1000;
    throw new Error(`TypeSafe API 网络请求失败（已重试 2 次）：${networkError.message}`);
  }
  if (!res?.ok) {
    const text = await res?.text();
    if (TRANSIENT_RETRY_STATUSES.has(res?.status)) {
      jevUnavailableUntil = Date.now() + 5 * 60 * 1000;
      throw new Error(`TypeSafe API HTTP ${res.status}`);
    }
    throw new Error(`TypeSafe API HTTP ${res?.status}: ${String(text || '').slice(0, 500)}`);
  }

  const result = await res.json();
  const decision = parseAnswer(result, offered);
  decision.offeredActions = offered.actions.map((action) => ({
    id: action.id,
    operation: action.operation,
    target: action.target,
    resumeField: action.resumeField || null
  }));
  decision.request = body;
  return decision;
}

function parseAnswer(result, actionPlan) {
  const answer = result.answers && result.answers.action;
  if (!answer) throw new Error("响应缺少 action answer");
  const action = actionPlan.byId[answer.choice];
  if (!action) throw new Error(`响应选择了未提供的动作 ${answer.choice}`);
  return {
    ...action,
    confidence: answer.confidence,
    actionProbabilities: answer.probabilities,
    model: result.model,
    usage: result.usage
  };
}
