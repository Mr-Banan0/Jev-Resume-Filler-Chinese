// background/service-worker.js — 阶段3：Agent 主循环
// 接收 Popup 的 START_FILL，跑完整 Agent 循环，通过 FILL_PROGRESS/FILL_DONE 推送进度

import { buildActionPlan, buildDataBlockPlan, buildRecordBindingPlan, buildSectionPlan, buildTodoList, choose, classifyRecordAddition, countRenderedRecords, fieldBindingThreshold, getResumeValue, hasSelectedRadioPeer, isProtectedControl, isRecordSaveControl, prepareResume, sectionCollection } from "../lib/jev-client.js";
import { CONTENT_SCRIPT_VERSION, SNAPSHOT_PROTOCOL_VERSION } from "../lib/content-version.js";
import { classifyPageState } from "../lib/page-state.js";
import { createPageExecutor } from './page-executor.js';
import { addedRecordEvidence, createRunMemory, dateDependencyCandidates, observeDateDefaults, frameOf, recordLedgerKey, recordOutcome, savedRecordEvidence, scopeControls } from '../lib/traversal-state.js';

console.log("[Jev Resume Filler] Service Worker 启动");

const MAX_STEPS = 120;
let agreementConfirmedForRun = false;
// 过期决策重新观察；持续重排的字段进入待处理清单。
const MAX_STALE_RETRY = 3;
// 连续多少次"操作了但页面没任何变化"就判定点了个不动的控件，直接停
const MAX_NO_CHANGE = 3;
// 多步骤网申逐段填写，最终投递由用户操作。
const DEFAULT_GOAL =
  "Fill the current section of the job application resume form with the user's resume data. " +
  "When the current section is filled, click the next-section button (下一步 / 保存并下一步 / 保存并继续 / 下一页 / Save and continue) to move on. " +
  "The controller keeps final submission controls outside the available actions. " +
  "Stop when the resume sections are filled or no further section can be reached.";
const WAIT_MS_DEFAULT = 80;
// 点击后需要等 UI 反应的场景
const WAIT_MS_CLICK = 200;
const WAIT_MS_OVERLAY = 450;   // 自定义下拉/日历展开
const WAIT_MS_SUGGEST = 1400;  // 搜索防抖和异步结果渲染
const WAIT_MS_SECTION = 900;   // 切换表单分区/加载下一段
const WAIT_MS_FOR_RENDER = 1200; // SPA 首屏渲染
// 取不到控件时最多再等几轮（每轮 WAIT_MS_FOR_RENDER），超过就认定这一页没有可填的东西
const MAX_EMPTY_RETRY = 2;
// 分区导航按钮：点了之后要等新字段渲染出来
const SECTION_BUTTON_RE = /(下一步|上一步|保存|下一页|上一页|继续|next|continue|save)/i;
let activeFillRunId = 0;
let fillEvents = [];
let eventPersistence = Promise.resolve().then(async () => {
  const saved=await chrome.storage?.session?.get?.(['fillEvents']);
  fillEvents=saved?.fillEvents || [];
}).catch(() => {});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pushToPopup(message) {
  if (['FILL_PROGRESS','FILL_DONE'].includes(message.type)) {
    const event={...message,at:Date.now()};
    eventPersistence = eventPersistence.then(() => {
      fillEvents=[...fillEvents,event].slice(-1500);
      return chrome.storage.session.set({fillEvents:fillEvents.slice()});
    }).catch(() => {});
  }
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Popup 可能没打开，忽略
      }
    });
  } catch (_) {}
}

// 元素索引带 frame 前缀：f<frameId>_<frame 内索引>，例如 f12_3
const FRAME_TARGET_RE = /^f(\d+)_(.+)$/;

function parseFrameTarget(target) {
  const m = String(target).match(FRAME_TARGET_RE);
  if (!m) return { frameId: 0, local: String(target) };
  return { frameId: parseInt(m[1], 10), local: m[2] };
}

function sendToFrame(tabId, frameId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

const {executePageClick,closePageTransactions,executeField} = createPageExecutor({sendToFrame,sleep});
async function listFrameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true
    });
    const ids = results.map((r) => r.frameId);
    return ids.length ? ids : [0];
  } catch (err) {
    console.warn("[Jev Resume Filler] 枚举 frame 失败，退回主帧:", err.message);
    return [0];
  }
}

// 汇总所有 frame 的可交互控件；元素索引加 frame 前缀，执行时按前缀路由回对应 frame
async function snapshotAllFrames(tabId) {
  const frameIds = await listFrameIds(tabId);
  const elements = [];
  const texts = [];
  const framePages = [];
  let pageInfo = null;
  let topDiagnostics = null;
  let framesWithElements = 0;
  const frameFingerprints = [];
  // 各帧的过滤计数累加后再报给弹窗，否则"明明 DOM 里有却采集不到"没法定位
  const filters = { hidden: 0, zeroSize: 0, popupItems: 0 };
  // 有几个 frame 真正回话了：全部没回话说明 content script 没生效，
  // 回话了但都是空说明是采集/过滤把控件挡掉了，两者的排查方向完全不同
  let respondedFrames = 0;

  for (const frameId of frameIds) {
    const snap = await sendToFrame(tabId, frameId, { type: "SNAPSHOT_FULL" });
    frameFingerprints.push([frameId, snap?.ok ? snap.fingerprint || 'missing' : 'missing']);
    if (!snap || !snap.ok || !Array.isArray(snap.elements)) continue;
    respondedFrames += 1;
    framePages.push({frameId,...snap.page});
    if (frameId === 0) {
      topDiagnostics = snap.diagnostics || null;
      if (snap.page) pageInfo = snap.page;
    }
    if (snap.elements.length) framesWithElements += 1;
    if (snap.filters) {
      filters.hidden += snap.filters.hidden || 0;
      filters.zeroSize += snap.filters.zeroSize || 0;
      filters.popupItems += snap.filters.popupItems || 0;
    }
    for (const el of snap.elements) {
      const merged = { ...el, frameId, index: `f${frameId}_${el.index}`,
        ...(el.surfaceId ? {surfaceId:`f${frameId}:${el.surfaceId}`} : {}),
        stableKey:`f${frameId}:${el.stableKey || `${snap.page?.documentId || 'observed'}:${el.index}`}`,
        ...(el.popupOwnerKey ? {popupOwnerKey:`f${frameId}:${el.popupOwnerKey}`} : {}),
        ...(el.recordStableKey ? {recordStableKey:`f${frameId}:${el.recordStableKey}`} : {})};
      if (Array.isArray(el.options)) {
        merged.options = el.options.map((opt) => ({ ...opt, index: `f${frameId}_${opt.index}` }));
      }
      elements.push(merged);
    }
    if (frameId !== 0 && snap.page && snap.page.text) texts.push(snap.page.text);
  }

  if (!pageInfo) pageInfo = { url: "", title: "", text: "" };
  const editorFrames=framePages.filter(frame=>frame.frameId!==0 &&
    (pageInfo.editorFrameUrls || []).includes(frame.url)).map(frame=>frame.frameId);
  pageInfo={...pageInfo,framePages,editorFrames,
    editorSurfaceId:pageInfo.editorSurfaceId ? `f0:${pageInfo.editorSurfaceId}` : '',
    editorSurface:!!pageInfo.editorSurface || editorFrames.length>0};
  for (const el of elements) {
    if (editorFrames.includes(el.frameId) && pageInfo.activeSection) el.section=pageInfo.activeSection;
  }
  if (!elements.some(el=>el.section && el.context!=='popup')) {
    pageInfo={...pageInfo,activeSection:'当前表单'};
    for (const el of elements) if (el.context!=='popup') el.section='当前表单';
  }
  if (texts.length) {
    pageInfo = { ...pageInfo, text: `${pageInfo.text} ${texts.join(" ")}`.trim() };
  }

  // 诊断：DOM 里有几个 iframe、我们实际进了几个，差多少
  const domIframes = topDiagnostics ? topDiagnostics.iframes.length : 0;
  const reachedSubFrames = Math.max(0, frameIds.length - 1);

  return {
    count: elements.length,
    elements,
    page: pageInfo,
    frames: frameIds.length,
    framesWithElements,
    respondedFrames,
    diagnostics: topDiagnostics,
    fingerprint: frameFingerprints.sort((a,b)=>a[0]-b[0]).map(([id,value])=>`${id}:${value}`).join('|'),
    unreachedFrames: Math.max(0, domIframes - reachedSubFrames),
    offscreenCount: elements.filter((el) => el.offscreen).length,
    filters: {
      ...filters,
      offscreen: elements.filter((el) => el.offscreen).length
    },
    proxyCount: elements.filter((el) => el.viaProxy).length,
    hiddenControls: elements.filter((el) => el.viaProxy).map((el) => ({ index: el.index, label: el.label }))
  };
}

// 每一帧的指纹参与变化判断；招聘网站经常把实际表单放在 iframe 内。
async function pageFingerprint(tabId) {
  try {
    const frameIds = await listFrameIds(tabId);
    const values = await Promise.all(frameIds.map(async frameId => {
      const res = await sendToFrame(tabId, frameId, { type: "FINGERPRINT" });
      return [frameId, res?.ok ? res.fingerprint || 'missing' : 'missing'];
    }));
    return values.sort((a,b)=>a[0]-b[0]).map(([id,value])=>`${id}:${value}`).join('|');
  } catch (_) {
    return null;
  }
}

// 确保 content script 已在该标签页所有 frame；扩展重新加载后旧页面不会自动注入，这里补一次
async function ensureContentScript(tabId) {
  const frameIds = await listFrameIds(tabId);
  const pings = await Promise.all(frameIds.map(frameId => sendToFrame(tabId, frameId, { type: "PING" })));
  if (pings.every(ping => ping?.ok && ping.version === CONTENT_SCRIPT_VERSION)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/widget-drivers.js", "content/platform-drivers.js", "content/content.js"]
    });
  } catch (err) {
    console.warn("[Jev Resume Filler] 注入 content script 失败:", err.message);
    return false;
  }
  // 注入完再确认一次。注入本身不报错不代表脚本真的活了，
  // 否则只会看到"没有可交互控件"，掩盖掉真正的原因。
  const again = await sendToFrame(tabId, 0, { type: "PING" });
  return !!(again?.ok && again.version === CONTENT_SCRIPT_VERSION);
}

// 把完整动作的概率分布压成一行，用于在弹窗中复盘 Jev 的排序。
function topProbabilities(probs, n) {
  if (!probs || typeof probs !== "object") return [];
  return Object.entries(probs)
    .filter(([, v]) => typeof v === "number" && isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`);
}

// 一个控件都没取到时，把现场摊开：frame 有没有回话、DOM 里到底有没有表单控件、
// 是被"不可见"还是"零尺寸"挡掉的。没有这些就只能看到一句"没有可交互控件"，无从下手。
function describeEmpty(snap) {
  const d = snap.diagnostics || {};
  const f = snap.filters || {};
  const page = snap.page || {};
  const bits = [
    `页面「${page.title || '无标题'}」`,
    `readyState=${d.readyState || '?'}`,
    `正文 ${(page.text || '').length} 字`,
    `frame ${snap.frames} 个（回话 ${snap.respondedFrames} 个，含控件 ${snap.framesWithElements} 个）`,
    `DOM 内表单控件 ${d.inputs === undefined ? '未知' : d.inputs} 个`,
    `宽松口径 ${d.looseControls || 0} 个`,
    `过滤掉 不可见 ${f.hidden || 0} + 零尺寸 ${f.zeroSize || 0}`
  ];
  if (d.shadowInputs) bits.push(`Shadow DOM 内 ${d.shadowInputs} 个原生控件`);
  return bits.join(' / ');
}

async function runRecordTransaction({ goal, resume, apiKey, tabId, onProgress, isCurrentRun = () => true,
  initialRecordIndex = 0, scopeSection, dataBlock, fieldBindings = [], recordBindings = {}, recordEditor = false,
  runMemory, recordKey }) {
  const history = [...(runMemory.historyByRecord.get(recordKey) || []),...fieldBindings.map(binding=>({...binding,kind:'bind'}))];
  if (recordKey) runMemory.historyByRecord.set(recordKey, history);
  let step = 0;
  let consecutiveSkips = 0;
  let consecutiveStale = 0;
  // 页面还在渲染时首轮容易取空，最多再等 MAX_EMPTY_RETRY 轮
  let emptyRetries = 0;
  const attempts = runMemory.attempts;
  const pendingSearchReads = new Map();
  let pendingDateDependencies=[];
  const pendingIssues = [];
  const deferField = async (decision, reason) => {
    const deferredKey = decision.resumeField || (decision.formRule && `rule:${decision.formRule}`);
    if (!deferredKey) return false;
    const {frameId} = parseFrameTarget(decision.sourceTarget || decision.target);
    await closePageTransactions(tabId,frameId);
    history.push({kind:'cancel',cancelField:deferredKey,skipControlKey:decision.controlStableKey,
      recordIndex:initialRecordIndex,reason,action:'DEFER_FIELD',page_changed:true});
    pendingIssues.push({field:decision.fieldLabel || decision.label || decision.resumeField,reason});
    onProgress({step,phase:'blocked',action:`${decision.fieldLabel || decision.label} 暂列待补，继续当前记录的其他字段：${reason}`});
    consecutiveSkips = 0;
    await sleep(WAIT_MS_OVERLAY);
    return true;
  };
  const recordIndex = initialRecordIndex;
  const recordSection = scopeSection;

  while (step < MAX_STEPS) {
    if (!isCurrentRun()) {
      return { ok: false, cancelled: true, reason: "已由新的填写任务替换", step, history };
    }
    step += 1;
    onProgress({ step, phase: "snapshot" });

    // 1. 取快照（汇总所有 frame）
    const snap = await snapshotAllFrames(tabId);
    if(pendingDateDependencies.length) {
      history.push(...observeDateDefaults(pendingDateDependencies,snap.elements));
      pendingDateDependencies=[];
    }
    const currentPageState = classifyPageState(snap.page, snap.elements);
    if (currentPageState.kind === 'auth-required' || currentPageState.kind === 'unsaved-confirmation') {
      return {ok:false,terminal:true,reason:currentPageState.reason,step,history,pendingIssues:[
        ...pendingIssues,{field:'页面状态',reason:currentPageState.reason}
      ]};
    }
    if (scopeSection) {
      const owner = [...history].reverse().find(item => item.kind !== 'cancel' && item.controlStableKey &&
        ['click','inspect','type_text','select'].includes(item.kind));
      snap.elements = scopeControls(snap.elements,{section:scopeSection,
        ownerKey:owner?.controlStableKey,editorFrames:snap.page.editorFrames,editorSurfaceId:snap.page.editorSurfaceId});
      snap.count = snap.elements.length;
      snap.page = {...snap.page, title:scopeSection, sectionScope:true, dataBlock,
        recordIndex,recordScope:true,recordEditor,recordBindings,scopedSection:true, ignoreUnmapped:true};
    }
    const previous = history[history.length - 1];
    if (scopeSection && previous?.kind === 'click' && previous.recordCommit && !previous.commitSettled) {
      previous.commitSettled = true;
      await sleep(WAIT_MS_SECTION);
      continue;
    }
    if (scopeSection && previous?.kind === 'click' && previous.recordCommit &&
        !snap.elements.some(el => el.section === scopeSection &&
          (el.operations || []).some(operation => ['TYPE_TEXT','SELECT','PICK_DATE'].includes(operation)))) {
      return {ok:true,done:false,sectionSaved:true,reason:'保存动作后编辑器已关闭，等待记录回读',pendingIssues,step,history};
    }
    if (!snap.count) {
      // 刚切完分区或 SPA 首屏还在渲染时，首轮很容易取空。
      // 最多再等两轮（每轮 1.2 秒），仍取不到才放弃。
      if (emptyRetries < MAX_EMPTY_RETRY) {
        emptyRetries += 1;
        onProgress({
          step,
          phase: "empty",
          action: `第 ${emptyRetries} 次没取到控件（${describeEmpty(snap)}），等待页面渲染后重试`
        });
        await sleep(WAIT_MS_FOR_RENDER);
        continue;
      }
      onProgress({ step, phase: "empty", action: `仍然没有可交互控件（${describeEmpty(snap)}）` });
      return { ok: false, reason: "页面没有可交互控件", step, history };
    }
    // 索引 → 元素，用于判断点的是不是下拉/日期/联想控件
    const byIndex = new Map(snap.elements.map((el) => [el.index, el]));

    // 原始控件操作数保留给进度提示；真正交给 Jev 的候选由 actionPlan 生成。
    const candidates = { CLICK: 0, TYPE_TEXT: 0, SELECT: 0, PICK_DATE: 0 };
    for (const el of snap.elements) {
      for (const op of el.operations || []) {
        if (candidates[op] !== undefined) candidates[op] += 1;
      }
    }

    onProgress({
      step,
      phase: "jev",
      count: snap.count,
      candidates,
      frames: snap.frames,
      framesWithElements: snap.framesWithElements
    });

    // 2. 在选定资料块内生成字段绑定与执行候选，逐次回读当前记录。
    const actionPlan = buildActionPlan(snap.elements, resume, history, {...snap.page,recordIndex,allowAddRecords:false});
    if(actionPlan.summary?.recordConflict) return {ok:false,terminal:true,recordConflict:true,
      reason:actionPlan.summary.recordConflict,history,pendingIssues:[...pendingIssues,
        {field:'记录身份',reason:actionPlan.summary.recordConflict}]};
    if (actionPlan.pickerField) onProgress({step,phase:'picker',pickerField:actionPlan.pickerField,
      options:snap.elements.filter(el=>el.context==='popup').slice(0,30).map(el=>({label:el.label,kind:el.kind})),
      candidates:actionPlan.actions.slice(0,8).map(action=>({operation:action.operation,label:action.label,
        value:action.value,resolvedValue:action.resolvedValue}))});
    if (actionPlan.actions.length && actionPlan.pickerField) pendingSearchReads.delete(actionPlan.pickerField);
    if (actionPlan.actions.length === 0) {
      const last = history[history.length - 1];
      if (actionPlan.pickerField && last?.context === 'popup') {
        const reads = pendingSearchReads.get(actionPlan.pickerField) || 0;
        if (reads < 2) {
          pendingSearchReads.set(actionPlan.pickerField, reads + 1);
          onProgress({step,phase:'wait',action:'等待分级选择器的下一层候选渲染'});
          await sleep(WAIT_MS_FOR_RENDER);
          continue;
        }
      }
      if (last?.kind === "type_text" && last.context === "popup" && actionPlan.status !== "done") {
        const reads = pendingSearchReads.get(last.resumeField) || 0;
        if (reads < 2) {
          pendingSearchReads.set(last.resumeField, reads + 1);
          onProgress({step,phase:"wait",action:"等待搜索结果渲染后重新读取"});
          await sleep(WAIT_MS_FOR_RENDER);
          continue;
        }
      }
      if (actionPlan.pickerField && actionPlan.cancelTarget) {
        const { frameId, local } = parseFrameTarget(actionPlan.cancelTarget);
        const cancelled = await sendToFrame(tabId, frameId, {type:"EXECUTE",action:"click",index:local});
        if (cancelled?.ok) {
          pendingIssues.push({field:actionPlan.pickerField,reason:actionPlan.dataGap || '选择器尚未匹配，需继续核验控件适配'});
          history.push({kind:"cancel",cancelField:actionPlan.pickerField,action:"cancel-unmatched-picker",page_changed:true});
          onProgress({step,phase:"blocked",action:`${actionPlan.dataGap || "选择器尚未匹配"}：${actionPlan.pickerField}，保留为待处理项，继续检查其他字段`});
          await sleep(WAIT_MS_OVERLAY);
          continue;
        }
      }
      const { mappedControls, satisfiedControls } = actionPlan.summary;
      if (actionPlan.status === "done") {
        onProgress({
          step,
          phase: "done",
          action: `当前分区已满足 ${satisfiedControls} 个已映射字段；没有可继续的分区动作`
        });
        history.push({ action: "DONE", kind: "done", text: "mapped fields satisfied", page_changed: false });
        return { ok: pendingIssues.length === 0, done: true, mappedControls, pendingIssues, step, history };
      }
      const conflicts=actionPlan.summary.preservedConflicts || [];
      if (conflicts.length && !(actionPlan.summary.unresolvedMapped || []).length &&
          !(actionPlan.summary.validationErrors || []).length) {
        for (const item of conflicts) pendingIssues.push({field:item.label,reason:item.reason});
        const reason=conflicts.map(item=>`${item.label}：${item.reason}`).join('；');
        onProgress({step,phase:'blocked',action:`当前记录已检查，保留已有值供核对：${reason}`});
        return {ok:false,terminal:true,recordConflict:true,reason,step,history,pendingIssues};
      }
      onProgress({
        step,
        phase: "blocked",
        action: `当前页面没有可执行的已映射动作（已映射 ${mappedControls} 个控件，已满足 ${satisfiedControls} 个）。待处理：${(actionPlan.summary.unresolved || []).map(item => `${item.label}（${item.reason}）`).join("、") || "当前选择器事务未完成"}。浮层候选：${snap.elements.filter(el => el.context === "popup").map(el => `[${el.kind}]${el.label}`).slice(0,15).join(" / ")}`
      });
      return { ok: false, reason: `当前页面没有可执行的已映射动作（已映射 ${mappedControls} / 已满足 ${satisfiedControls} / 未完成 ${JSON.stringify(actionPlan.summary.unresolvedMapped || [])}）；浮层候选：${snap.elements.filter(el => el.context === "popup").map(el => `[${el.kind}]${el.label}`).slice(0,15).join(" / ") || "无"}；焦点 ${snap.diagnostics?.focusedTag} / 搜索层 ${snap.diagnostics?.editorLayerClass} / 结构 ${JSON.stringify(snap.diagnostics?.editorStructure || [])}`, step, history, pendingIssues };
    }

    // 3. 调 Jev
    let decision;
    try {
      decision = await choose({
        apiKey,
        goal,
        page: snap.page,
        elements: snap.elements,
        history,
        resume,
        actionPlan
      });
    } catch (err) {
      onProgress({step,phase:'failed',action:`Jev 决策失败：${err.message}`});
      return { ok: false, reason: `Jev 调用失败: ${err.message}`, step, history };
    }
    if (!isCurrentRun()) {
      return { ok: false, cancelled: true, reason: "已由新的填写任务替换", step, history };
    }

    onProgress({
      step,
      phase: "decided",
      operation: decision.operation,
      target: decision.target,
      resumeField: decision.resumeField,
      confidence: decision.confidence,
      candidates,
      topActions: topProbabilities(decision.actionProbabilities, 3),
      counted: snap.count
    });

    const { operation, target, resumeField } = decision;
    if (operation === 'BIND_FIELD' || operation === 'SKIP_FIELD') {
      const key=decision.controlStableKey || target;
      const bindingControl=snap.elements.find(el=>(el.stableKey || el.index)===key);
      const observed=history.some(item=>item.kind==='inspect' && item.controlStableKey===key);
      const bindingThreshold=fieldBindingThreshold(decision);
      const genericSelectorLabel=/^(?:请选择|请填写|点击选择|选择|搜索|下拉|选项|未命名|无标签)(?:\s|$)/
        .test(String(decision.label || bindingControl?.label || '').trim());
      if (decision.confidence<bindingThreshold && !observed &&
          (operation==='BIND_FIELD' || genericSelectorLabel) &&
          bindingControl?.kind==='custom-select' && bindingControl.operations?.includes('CLICK') &&
          !snap.elements.some(el=>el.context==='popup')) {
        const {frameId,local}=parseFrameTarget(bindingControl.index);
        const inspection=await executePageClick(tabId,frameId,local,bindingControl.clickMode==='trusted-pointer');
        history.push({kind:'inspect',controlStableKey:key,label:decision.label,
          sourceControl:{...bindingControl},page_changed:!!inspection?.ok});
        if (inspection?.ok) {
          onProgress({step,phase:'inspect',action:`${decision.label} 展开实际选项后重新判断字段`});
          await sleep(WAIT_MS_OVERLAY);
          continue;
        }
      }
      if (operation === 'BIND_FIELD' && decision.confidence >= bindingThreshold) {
        history.push({kind:'bind',resumeField,controlStableKey:decision.controlStableKey,
          label:decision.label,fieldLabel:decision.fieldLabel,recordIndex:decision.recordIndex,
          page_changed:false});
        onProgress({step,phase:'bound',action:`${decision.label} 已绑定 ${resumeField}，重新观察后执行`});
      } else {
        if (observed && snap.elements.some(el=>el.context==='popup')) {
          const closed=await closePageTransactions(tabId,frameOf(bindingControl));
          if (!closed?.ok) onProgress({step,phase:'failed',action:`${decision.label} 退出选择器失败：${closed?.reason || '未回读'}`});
        }
        history.push({kind:'skip',skipControlKey:decision.controlStableKey || target,label:decision.label,
          reason:operation==='BIND_FIELD' ? '字段绑定置信不足，保留待核对' : '当前资料块无对应字段，保留待核对',page_changed:false});
        if(recordEditor || operation==='BIND_FIELD' || bindingControl?.required) pendingIssues.push({field:decision.label,
          reason:operation==='BIND_FIELD' ? '字段绑定置信不足，保留待核对' : '当前记录无匹配字段，需核对或补充资料'});
        onProgress({step,phase:'skip',action:`${decision.label} 在当前资料块中暂未匹配，继续检查其余字段`});
      }
      continue;
    }
    if (operation === 'RETURN_SECTION') {
      await closePageTransactions(tabId,frameOf(snap.elements.find(el=>el.context==='popup')));
      return {ok:false,returned:true,reason:'Jev 返回当前 section 的资料块清单',step,history,pendingIssues};
    }
    if (decision.intent === 'RETURN' && (decision.cancelField || operation==='RETURN')) {
      const {frameId,local}=parseFrameTarget(operation==='RETURN' ? decision.sourceTarget || history.at(-1)?.sourceTarget || target : target);
      const returned=operation==='RETURN' ? await closePageTransactions(tabId,frameId) :
        await sendToFrame(tabId,frameId,{type:'EXECUTE',action:'click',index:local});
      if (returned?.ok) {
        pendingIssues.push({field:decision.fieldLabel || resumeField,reason:decision.reason});
        history.push({kind:'cancel',cancelField:resumeField,action:'RETURN',page_changed:true});
        await sleep(WAIT_MS_OVERLAY);
        continue;
      }
    }
    if (decision.formRule === 'agreement' && !agreementConfirmedForRun) {
      pendingIssues.push({field:decision.label || '招聘协议',reason:'协议需在插件面板审阅后确认'});
      return {ok:false,terminal:true,reason:'招聘协议待确认，其他字段保持已填写状态',step,history,pendingIssues};
    }

    // 3. 执行前先确认页面还是快照时的那张。
    // Jev 返回决策期间页面可能已重渲染（React 更新、动画结束、浮层自动收起），
    // 拿过期索引去点会点错元素，所以这一轮不执行、重新观察再决策。
    if (snap.fingerprint) {
      const nowFingerprint = await pageFingerprint(tabId);
      if (nowFingerprint && nowFingerprint !== snap.fingerprint) {
        consecutiveStale += 1;
        if (consecutiveStale > MAX_STALE_RETRY) {
          return {ok:false,reason:'页面持续重排，当前事务待重新观察',step,history,pendingIssues};
        } else {
          onProgress({ step, phase: "stale", action: "页面已变化，重新决策" });
          continue;
        }
      } else {
        consecutiveStale = 0;
      }
    }

    // 4. 分发操作
    if (!isCurrentRun()) return {ok:false,cancelled:true,reason:"已停止填写",step,history};
    if (decision.label === '保存') {
      for (const item of actionPlan.summary.unresolved || []) {
        const field = `${recordSection}#${recordIndex + 1} ${item.label}`;
        if (!pendingIssues.some(issue=>issue.field===field)) pendingIssues.push({field,reason:item.reason});
      }
    }
    // 同一简历字段可能依次经过“打开选择器 → 搜索框 → 自定义确认项”，页面重排后
    // 标签也常都叫“专业”。目标控件必须进入重试键，避免把正常多步事务误判为死循环。
    const targetEntry = (snap.elements || []).find(entry => String(entry.index) === String(target));
    const controlKey = targetEntry?.stableKey || target;
    const recentClicks = history.slice(-6);
    if (operation === 'CLICK' && resumeField && recentClicks.length === 6 &&
        recentClicks.every(item => item.kind === 'click' && item.resumeField === resumeField && !item.page_changed)) {
      if (await deferField(decision,'同一字段连续点击后未回读成功')) continue;
      return {ok:false,reason:`同一字段连续点击 6 次仍未回读成功：${decision.fieldLabel || decision.label}；已停止当前分区`,step,history};
    }
    const popupState = decision.context === 'popup' ? snap.elements.filter(el=>el.context==='popup')
      .map(el=>[el.label,el.value,el.calendarDate,el.checked].join(':')).join(';') : '';
    const fieldKey = [recordKey || recordSection,frameOf(targetEntry),resumeField || decision.formRule || decision.label].join('|');
    const fieldState = runMemory.fields.get(fieldKey) || {attempts:0,status:'pending'};
    fieldState.attempts += 1;
    runMemory.fields.set(fieldKey,fieldState);
    if (fieldState.attempts > 24) {
      if (await deferField(decision,'字段事务达到本轮操作预算，保留待处理')) continue;
      return {ok:false,reason:'当前字段事务达到操作预算',step,history,pendingIssues};
    }
    const attemptKey = [fieldKey,operation,targetEntry?.kind,targetEntry?.label,decision.pickerStep,popupState].join("|");
    const attemptCount = (attempts.get(attemptKey) || 0) + 1;
    attempts.set(attemptKey, attemptCount);
    if (attemptCount > 3) {
      if (await deferField(decision,'同一字段动作重试三次后仍未完成')) continue;
      const failures=history.filter(item=>item.kind==='failed').slice(-3).map(item=>item.text).filter(Boolean);
      return {ok:false,reason:`同一字段动作已尝试 3 次：${decision.fieldLabel || decision.label}；已停止重复执行${failures.length ? `；最近失败：${failures.join(' / ')}` : ''}`,step,history};
    }
    // CLICK / TYPE_TEXT / SELECT —— 按 target 的 frame 前缀路由到对应 frame
    const { frameId, local } = parseFrameTarget(target);
    let execMsg;
    let actionLabel;
    if (operation === "CLICK") {
      execMsg = { type: "EXECUTE", action: "click", index: local };
      actionLabel = `click[${target}]${decision.context === 'popup' ? `(${decision.label || '未命名选项'})` : ''}`;
    } else if (operation === "TYPE_TEXT") {
      const value = decision.resolvedValue ?? getResumeValue(resume, resumeField);
      if (value == null || value === "") {
        // 简历里没有这个字段，跳过让 Jev 下一轮处理
        history.push({
          action: `TYPE_TEXT[skip:${resumeField}]`,
          kind: "skip",
          text: `resume field ${resumeField} is empty`,
          page_changed: false
        });
        consecutiveSkips += 1;
        if (consecutiveSkips >= 5) {
          return { ok: false, reason: "连续 5 次简历字段为空", step, history };
        }
        continue;
      }
      let siteValue = String(value);
      if (/^education\[\d+\]\.gpa$/.test(resumeField) && /平均成绩/.test(decision.label || '') &&
          /^\d+(?:\.\d+)?\s*\/\s*100$/.test(siteValue)) {
        siteValue = siteValue.split('/')[0].trim();
      }
      if (targetEntry?.maxLength && siteValue.length > targetEntry.maxLength) {
        if (await deferField(decision,`原文 ${siteValue.length} 字，网站上限 ${targetEntry.maxLength} 字，需提供短版`)) continue;
      }
      execMsg = { type: "EXECUTE", action: "type_text", index: local, value: siteValue };
      actionLabel = `type_text[${target}]<=${resumeField}`;
    } else if (operation === "SELECT") {
      execMsg = { type: "EXECUTE", action: "select", target: local };
      actionLabel = `select[${target}]`;
    } else if (operation === "PICK_DATE") {
      const value = getResumeValue(resume, resumeField);
      const dateValue = /^\d{4}-\d{2}$/.test(String(value || '')) ? `${value}-01` : String(value || '');
      execMsg = {type:"EXECUTE",action:"pick_date",index:local,value:dateValue};
      actionLabel = `pick_date[${target}]<=${resumeField}`;
    } else if (operation === "UPLOAD_FILE") {
      const file = getResumeValue(resume, resumeField);
      if (!file?.dataUrl || !file?.name) {
        history.push({action:`UPLOAD_FILE[skip:${resumeField}]`,kind:'skip',text:'file is empty',page_changed:false});
        continue;
      }
      execMsg = {type:'EXECUTE',action:'upload_file',index:local,file};
      actionLabel = `upload_file[${target}]<=${resumeField}`;
    } else {
      history.push({ action: operation, kind: "unknown", text: "", page_changed: false });
      continue;
    }

    onProgress({ step, phase: "execute", action: actionLabel });
    const execRes = await executeField({tabId,frameId,local,decision,targetEntry,page:snap.page,execMsg});
    if (execRes?.bridge) onProgress({step,phase:'execute',action:`${actionLabel} · ${execRes.bridge}`});
    if (!execRes || !execRes.ok) {
      onProgress({step,phase:'failed',action:`${actionLabel} 失败：${execRes?.reason || 'exec failed'}`});
      history.push({
        action: actionLabel,
        kind: "failed",
        resumeField,formRule:decision.formRule,controlKind:targetEntry?.kind,
        controlStableKey:decision.controlStableKey || targetEntry?.stableKey,
        label:decision.label,context:decision.context,
        text: (execRes && execRes.reason) || "exec failed",
        page_changed: false
      });
      if (operation === 'UPLOAD_FILE') {
        pendingIssues.push({field:decision.fieldLabel || decision.label || '上传文件',
          reason:execRes?.reason || '网站未确认文件上传'});
        return {ok:false,terminal:true,reason:execRes?.reason || '网站未确认文件上传',step,history,pendingIssues};
      }
      // 日期执行器已经完成有界导航；将失败记入账本并关闭弹层，继续当前记录。
      if (operation === 'PICK_DATE' && await deferField(decision,execRes?.reason || '日期未被网站接受')) continue;
      consecutiveSkips += 1;
      if (consecutiveSkips >= 5) {
        if (await deferField(decision,'当前字段执行失败')) continue;
        return { ok: false, reason: "连续 5 次执行失败", step, history };
      }
      continue;
    }
    if(['SELECT','TYPE_TEXT'].includes(operation) || operation==='CLICK' && decision.context==='popup') {
      pendingDateDependencies=dateDependencyCandidates(snap.elements,resumeField,history);
    }
    if (execRes.reactClearHandled) {
      onProgress({step,phase:'execute',action:`${actionLabel} · React 清除器已触发`});
    }

    // 按控件种类决定等待：自定义下拉/日历要等浮层渲染，输入联想要等列表出现
    const clickedEl = byIndex.get(decision.sourceTarget || target);
    let waitMs = WAIT_MS_DEFAULT;
    if (operation === "CLICK") {
      waitMs = WAIT_MS_CLICK;
      if (decision.context === 'popup') waitMs = WAIT_MS_OVERLAY;
      if (decision.context === "popup" && /^(确定|确认|完成)$/.test(decision.label || "")) waitMs = WAIT_MS_OVERLAY;
      const kind = clickedEl && clickedEl.kind;
      if (kind === "custom-select" || kind === "combobox" || kind === "date") {
        waitMs = WAIT_MS_OVERLAY;
      }
      // 分区导航按钮：等下一段字段渲染出来，并锁定当前分区名用于日志
      const label = (clickedEl && clickedEl.label) || "";
      if (SECTION_BUTTON_RE.test(label)) {
        waitMs = WAIT_MS_SECTION;
      }
    } else if (operation === "TYPE_TEXT") {
      const kind = clickedEl && clickedEl.kind;
      if (kind === "combobox" || kind === "date" || decision.context === "popup") {
        waitMs = WAIT_MS_SUGGEST;
      }
    }

    await sleep(waitMs);

    // 真的比对指纹来判定"这一步有没有效果"，而不是想当然地填 true。
    // 滚动不改变 DOM，单独算作已生效。
    let pageChanged = true;
    if (snap.fingerprint) {
      const afterFingerprint = await pageFingerprint(tabId);
      pageChanged = !afterFingerprint || afterFingerprint !== snap.fingerprint;
    }
    history.push({
      action: actionLabel,
      kind: operation.toLowerCase(),
      label: decision.label,
      pageTitle: snap.page?.title,
      context: decision.context || null,
      text: execRes.value || execRes.label || execRes.note || "",
      page_changed: pageChanged,
      resumeField: resumeField || null,
      formRule: decision.formRule || null,
      sourceTarget:decision.sourceTarget || target,
      recordCommit:decision.recordCommit === true,
      resolvedValue: decision.resolvedValue || null,
      value: decision.value || null
      ,controlKind: clickedEl?.kind || null
      ,controlStableKey: decision.controlStableKey || clickedEl?.stableKey || null
      ,verified: execRes.verified === true
      ,pickerStep: decision.pickerStep,
      pickerLeaf: decision.pickerLeaf
    });
    consecutiveSkips = 0;

    // 连着几步都"操作了但页面纹丝不动"→ 大概是点了个不动的控件，别再空转 120 步
    const recent = history.slice(-MAX_NO_CHANGE);
    if (
      recent.length === MAX_NO_CHANGE &&
      recent.every((h) => h.page_changed === false && !["wait", "skip", "done", "failed"].includes(h.kind))
    ) {
      const detail=recent.map(item=>`${item.kind}:${item.label || item.action}${item.resumeField ? `<=${item.resumeField}` : ''}`).join(' / ');
      if (await deferField(decision,`操作后页面无变化：${detail}`)) continue;
      return { ok: false, reason: `连续 ${MAX_NO_CHANGE} 次操作后页面无变化：${detail}`, step, history };
    }
  }

  return { ok: false, reason: `达到最大步数 ${MAX_STEPS}`, step, history };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "STOP_FILL") {
    activeFillRunId += 1;
    pushToPopup({type:"FILL_DONE",ok:false,cancelled:true,reason:"已停止填写"});
    sendResponse({ok:true});
    return true;
  }
  if (msg && msg.type === "CONTENT_LOADED") {
    sendResponse({ ok: true });
    return true;
  }

  // Popup 的「测试快照」：由 SW 汇总所有 frame，与自动填写走同一条链路
  if (msg && msg.type === "SNAPSHOT_TAB") {
    (async () => {
      const tab = await getActiveTab();
      if (!tab) {
        sendResponse({ ok: false, reason: "未找到活动标签页" });
        return;
      }
      const injected = await ensureContentScript(tab.id);
      if (!injected) {
        sendResponse({ ok: false, reason: "无法注入 content script，请确认当前标签页是普通网页" });
        return;
      }
      const snap = await snapshotAllFrames(tab.id);
      const resume = msg.resume ? prepareResume(msg.resume) : null;
      const sectionPlan = resume ? buildSectionPlan(snap.elements, resume, {}, snap.page) : null;
      const todo = resume ? buildTodoList(snap.elements, resume, {}, snap.page) : null;
      const pageState = classifyPageState(snap.page, snap.elements);
      sendResponse({
        ok: true,
        count: snap.count,
        frames: snap.frames,
        framesWithElements: snap.framesWithElements,
        diagnostics: snap.diagnostics,
        unreachedFrames: snap.unreachedFrames,
        offscreenCount: snap.offscreenCount,
        filters: snap.filters,
        proxyCount: snap.proxyCount,
        hiddenControls: snap.hiddenControls,
        page: snap.page,
        pageState: pageState.kind,
        pageStateReason: pageState.reason,
        sectionPlan: sectionPlan?.actions.map(action => ({section:action.section || '',operation:action.operation})),
        todo,
        preview: snap.elements.slice(0, 120)
      });
    })();
    return true;
  }

  if (msg && msg.type === 'RUNTIME_STATUS') {
    sendResponse({ok:true,version:CONTENT_SCRIPT_VERSION,protocolVersion:SNAPSHOT_PROTOCOL_VERSION});
    return true;
  }
  if (msg && msg.type === "START_FILL") {
    if (msg.runtimeVersion !== CONTENT_SCRIPT_VERSION) {
      sendResponse({ok:false,started:false,reason:'插件版本未同步，请在扩展管理页重载插件后再次开始'});
      return true;
    }
    eventPersistence=eventPersistence.then(() => {
      fillEvents=[];
      return chrome.storage.session.set({fillEvents:[]});
    }).catch(() => {});
    (async () => {
      try {
        await eventPersistence;
        await runFill(msg);
      } catch (err) {
        // 兜底：任何没接住的异常都要报出来，否则界面上就是"启动了然后没反应"
        console.error("[Jev Resume Filler] 填写循环异常:", err);
        pushToPopup({
          type: "FILL_DONE",
          ok: false,
          reason: `填写循环异常: ${err && err.message ? err.message : String(err)}`
        });
      }
    })();
    sendResponse({ ok: true, started: true });
    return true;
  }
});


// section 动作中选择；选中后才把该 section 的控件交给记录事务。这样不同 section
// 的重复字段（例如多个“年”“学校名称”）永远不会出现在同一次字段决策里。
async function runSectionScheduler({tabId,resume,apiKey,goal,report,isCurrentRun}) {
  const ledger = {};
  const runMemory = createRunMemory();
  const sections = [];
  const pendingIssues = [];
  let focusSection = '';
  const isEmptyRequiredField = el => {
    if (el.context === 'popup' || !el.required) return false;
    if (!['input','textarea','richtext','custom-select','combobox','date','beisen-date','moka-date',
      'layui-date','feishu-year','feishu-date-range','native-select','file','checkbox','radio',
      'custom-checkbox','custom-radio'].includes(el.kind)) return false;
    if (['checkbox','radio','custom-checkbox'].includes(el.kind)) return el.checked !== true;
    if (el.checked === true) return false;
    const value = String(el.value || '').trim();
    return el.valueCommitted === false || !value ||
      /^(?:请选择|请填写|必填项未填写|上传|年|月)$/.test(value);
  };
  const addPendingIssue = (field, reason) => {
    const item = {
      field:String(field || '').trim(),
      reason:String(reason || '当前分区未完成').trim()
    };
    if (!pendingIssues.some(existing => existing.field === item.field && existing.reason === item.reason)) {
      pendingIssues.push(item);
    }
  };
  const auditRequiredFields = async () => {
    const current = await snapshotAllFrames(tabId);
    const plansBySection = new Map();
    const planForSection = section => {
      const key = section || '';
      if (!plansBySection.has(key)) {
        const controls = current.elements.filter(item => item.context !== 'popup' && (item.section || '') === key);
        const state=ledger[`${key}|*`] || {};
        // 验收沿 Jev 实际选定的资料块与持久绑定回读，保持分区边界。
        const blocks=[...new Set([state.activeBlock,...(state.completedBlocks || []),
          ...(state.blockedBlocks || []),...Object.keys(state.bindingsByBlock || {})].filter(Boolean))];
        const plans=blocks.map(dataBlock=>buildActionPlan(controls,resume,[],{
          ...current.page,title:key,dataBlock,fieldBindings:state.bindingsByBlock?.[dataBlock] || [],
          recordBindings:state.recordBindingsByBlock?.[dataBlock] || {},
          allowAddRecords:false,scopedSection:true,ignoreUnmapped:true
        }));
        plansBySection.set(key,{summary:{fieldGroups:plans.flatMap(plan=>plan.summary?.fieldGroups || [])}});
      }
      return plansBySection.get(key);
    };
    for (const el of current.elements) {
      if (el.context === 'popup' || isProtectedControl(el)) continue;
      if (hasSelectedRadioPeer(el,current.elements)) continue;
      if (el.validationError) {
        addPendingIssue(`${el.section || '页面'} ${el.label || '未命名字段'}`,
          `网站校验未通过：${el.validationError}`);
        continue;
      }
      const localPlan = planForSection(el.section);
      const groups=localPlan.summary?.fieldGroups?.filter(group=>group.targets.includes(el.index)) || [];
      const fieldGroup=groups.find(group=>['ready','pending-readback','conflict'].includes(group.status)) || groups[0];
      const state=ledger[`${el.section}|*`] || {};
      const skipped=Object.values(state.skipsByBlock || {}).flat().find(item=>
        item.skipControlKey===(el.stableKey || el.index));
      const emptySkipped=skipped && !String(el.value || '').trim() && el.checked!==true;
      if (!isEmptyRequiredField(el) && !['ready','pending-readback','conflict'].includes(fieldGroup?.status) && !emptySkipped) continue;
      const reason = emptySkipped ? skipped.reason : fieldGroup?.status==='conflict' ? fieldGroup.reason || '页面已有值与本地资料不同，已保留网页内容' :
        fieldGroup?.status === 'missing-data' ? '本地资料缺少此必填项' :
        fieldGroup && ['ready','pending-readback','conflict'].includes(fieldGroup.status) ?
          `${el.required ? '网站必填字段' : '已映射字段'}尚未回读完成` : '本地资料尚未映射到此必填项';
      addPendingIssue(`${el.section || '页面'} ${el.label || '未命名必填项'}`, reason);
    }
  };
  const finish = async (reason) => {
    await auditRequiredFields();
    const latest=new Map(sections.map(item=>[recordLedgerKey(item.section,item.dataBlock,resume,item.recordIndex || 0),item]));
    for(const item of latest.values()) {
      if(!['filled','saved'].includes(item.status)) addPendingIssue(`${item.section} ${item.dataBlock || ''} #${Number(item.recordIndex || 0)+1}`.trim(),
        item.reason || `当前记录状态：${item.status}`);
    }
    return {ok:pendingIssues.length===0,done:true,sections,pendingIssues,reason};
  };
  const routeDataBlock = async (section, snap) => {
    const sectionKey=`${section}|*`;
    const state=ledger[sectionKey] || {};
    if (state.activeBlock) return state.activeBlock;
    const controls=scopeControls(snap.elements,{section,editorFrames:snap.page.editorFrames,editorSurfaceId:snap.page.editorSurfaceId});
    const sectionOutline=[...new Set(snap.elements.filter(el=>el.context!=='popup')
      .map(el=>el.section).filter(Boolean))];
    const routingPage={...snap.page,sectionOutline,claimedControlKeys:
      Object.values(state.bindingsByBlock || {}).flat().map(binding=>binding.controlStableKey)};
    const blockPlan=buildDataBlockPlan(section,controls,resume,
      [...(state.completedBlocks || []),...(state.blockedBlocks || [])],routingPage);
    if (!blockPlan.actions.some(action=>action.operation==='SELECT_DATA_BLOCK')) {
      ledger[sectionKey]={...state,deferred:true};
      return null;
    }
    const choice=await choose({apiKey,
      goal:`${goal}\nSelect the JSON block corresponding to this section and its visible fields. Work on one block at a time.`,
      page:{...routingPage,title:section,sectionScope:true},elements:controls,history:[],resume,
      actionPlan:blockPlan});
    // 有明确剩余字段提示时开放局部检查，实际写入通过字段绑定和事务回读验收。
    // 缺少字段证据的低置信路由保留待核对，避免进入不相关的经历资料块。
    const continuedRouting=(state.completedBlocks || []).length+(state.blockedBlocks || []).length>0;
    if (choice.operation==='NO_DATA_BLOCK' || continuedRouting && choice.confidence<0.75 && !choice.matched) {
      ledger[sectionKey]={...state,deferred:true};
      if (!(state.completedBlocks || []).length && !(state.blockedBlocks || []).length &&
          controls.some(el=>el.context!=='popup' &&
            ['input','textarea','richtext','custom-select','combobox','date','native-select','file'].includes(el.kind) &&
            !String(el.value || '').trim())) {
        addPendingIssue(section,'Jev 未找到与当前空字段对应的资料块，保留待核对');
      }
      report({phase:'section',action:`「${section}」剩余字段无可靠资料块，返回分区清单`});
      return null;
    }
    // 路由开放局部检查；新增记录还需身份字段与该资料块对应的独立证据。
    ledger[sectionKey]={...state,activeBlock:choice.dataBlock,workBlocked:false};
    report({phase:'section',action:`「${section}」选定资料块 ${choice.dataBlock}，开始局部填写`,
      confidence:choice.confidence});
    return choice.dataBlock;
  };
  let menuExits = 0;
  let staleDecisions = 0;
  for (let turn = 1; turn <= 160; turn += 1) {
    if (!isCurrentRun()) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
    const snap = await snapshotAllFrames(tabId);
    const currentPageState = classifyPageState(snap.page, snap.elements);
    if (currentPageState.kind === 'auth-required' || currentPageState.kind === 'unsaved-confirmation') {
      addPendingIssue('页面状态',currentPageState.reason);
      return {ok:false,terminal:true,reason:currentPageState.reason,sections,pendingIssues};
    }
    if (focusSection && ledger[`${focusSection}|*`]?.deferred) focusSection='';
    const focusedState=ledger[`${focusSection}|*`];
    if (focusSection && focusedState?.activeBlock && !snap.page.editorSurface) {
      const dataBlock=focusedState.activeBlock;
      const confirmed=focusedState.recordBindingsByBlock?.[dataBlock] || {};
      const controls=scopeControls(snap.elements,{section:focusSection});
      const bindingPlan=buildRecordBindingPlan(controls,resume,dataBlock,confirmed);
      if (bindingPlan) {
        const choice=await choose({apiKey,goal:'Match this existing page record to one source record using its name, dates, role and description. Preserve ambiguous records.',
          page:{...snap.page,title:focusSection,dataBlock,sectionScope:true},
          elements:bindingPlan.observed,history:[],resume,actionPlan:bindingPlan});
        if (snap.fingerprint && (await pageFingerprint(tabId)) !== snap.fingerprint) continue;
        const sourceIndex=choice.operation==='BIND_RECORD' && choice.confidence>=0.9 ? choice.recordIndex : null;
        ledger[`${focusSection}|*`]={...focusedState,recordBindingsByBlock:{...focusedState.recordBindingsByBlock,
          [dataBlock]:{...confirmed,[choice.recordKey]:sourceIndex}}};
        report({phase:'record-binding',action:sourceIndex==null ? `「${focusSection}」已有记录保留待核对` :
          `「${focusSection}」已有记录对应 ${dataBlock} 第 ${sourceIndex+1} 条`,confidence:choice.confidence});
        if (sourceIndex==null) addPendingIssue(focusSection,'已有记录与资料的对应关系证据不足，已保留');
        continue;
      }
    }
    const plan = buildSectionPlan(snap.elements, resume, ledger, {...snap.page,focusSection});
    const activeTitle=snap.page.activeSection;
    const activeEditor=snap.elements.some(el=>el.section===activeTitle && el.context!=='popup' &&
      /^(保存|添加|取消)$/.test(String(el.label || '').replace(/\s/g,'')) && el.kind!=='card');
    if (activeTitle && !activeEditor && !snap.elements.some(el=>el.context==='popup') &&
        !plan.actions.some(action=>action.section===activeTitle)) {
      const sectionKey=`${activeTitle}|*`;
      ledger[sectionKey]={...ledger[sectionKey],focusBlocked:true};
      const source=resume[sectionCollection(activeTitle)];
      const remaining=Array.isArray(source) && source.some((_,i)=>{
        const state=ledger[recordLedgerKey(activeTitle,sectionCollection(activeTitle),resume,i)];
        return !state?.completed && !state?.skipped;
      });
      if (remaining) addPendingIssue(activeTitle,'已检查现有记录；页面未提供继续填写剩余资料的新增或编辑入口');
    }
    const meaningful = plan.actions.filter(action => !['EXIT_SECTION_MENU','STOP_FILL'].includes(action.operation));
    if (!meaningful.length && snap.elements.some(el=>el.context==='popup') && menuExits < 3) {
      menuExits += 1;
      for(const frameId of new Set(snap.elements.filter(el=>el.context==='popup').map(frameOf))) {
        await closePageTransactions(tabId,frameId);
      }
      await sleep(WAIT_MS_SECTION);
      continue;
    }
    if (!meaningful.length && focusSection) {
      const state=ledger[`${focusSection}|*`] || {};
      if (state.activeBlock) addPendingIssue(`${focusSection} ${state.activeBlock}`,
        '当前记录已检查；页面未提供继续填写剩余资料的新增或编辑入口');
      ledger[`${focusSection}|*`]={...state,deferred:true};
      focusSection='';
      continue;
    }
    if (!meaningful.length) return finish('已检查可识别分区');
    let decision;
    try {
      decision = await choose({apiKey, goal: `${goal}\nChoose the next section-level action. Select one section to work on, add a required record, or exit. Do not select final submission.`,
        page:snap.page,elements:snap.elements,history:[],resume,actionPlan:plan});
    } catch (err) {
      return {ok:false,reason:`Jev 分区决策失败: ${err.message}`,sections,pendingIssues};
    }
    report({step:turn,phase:'section-decided',operation:decision.operation,section:decision.section,
      action:`分区决策：${decision.label}（${decision.operation}）`,confidence:decision.confidence,
      topActions:topProbabilities(decision.actionProbabilities,3)});
    if(['FOCUS_SECTION','ADD_RECORD','DEFER_SECTION','NEXT_SECTION_PAGE'].includes(decision.operation) && snap.fingerprint) {
      const fresh=await pageFingerprint(tabId);
      if(fresh && fresh!==snap.fingerprint) {
        staleDecisions++;
        if(staleDecisions>MAX_STALE_RETRY) {
          addPendingIssue('页面状态','分区目标持续重排，保留现场待重新观察');
          return finish('分区决策持续过期，已停止执行');
        }
        continue;
      }
      staleDecisions=0;
    }
    if (decision.operation === 'STOP_FILL') {
      return finish('Jev 已结束本次填写');
    }
    if (decision.operation === 'NEXT_SECTION_PAGE') {
      await auditRequiredFields();
      const {frameId,local}=parseFrameTarget(decision.target);
      const targetEntry=snap.elements.find(el=>el.index===decision.target);
      const moved=await executePageClick(tabId,frameId,local,targetEntry?.clickMode==='trusted-pointer');
      await sleep(WAIT_MS_SECTION);
      const after=await snapshotAllFrames(tabId);
      if (!moved?.ok || after.fingerprint===snap.fingerprint || after.elements.some(el=>el.validationError)) {
        addPendingIssue('页面导航','下一页未获页面变化或校验确认');
        return finish('当前页面保留待处理，已停止页面导航');
      }
      // 新一页可以沿用分区标题；新控件重新参与同一调度流程。
      for(const key of Object.keys(ledger)) delete ledger[key];
      runMemory.historyByRecord.clear();
      focusSection='';
      continue;
    }
    if (decision.operation === 'EXIT_SECTION_MENU') {
      if (focusSection) {
        ledger[`${focusSection}|*`]={...ledger[`${focusSection}|*`],deferred:true};
        focusSection='';
        menuExits=0;
        continue;
      }
      menuExits += 1;
      if (menuExits < 2) {
        report({step:turn,phase:'section',action:'退出当前 section，重新扫描可填写清单'});
        await sleep(WAIT_MS_SECTION);
        continue;
      }
      return finish('已退出分区清单');
    }
    if (decision.operation === 'DEFER_SECTION') {
      const {frameId,local} = parseFrameTarget(decision.target);
      const targetEntry = snap.elements.find(element => String(element.index) === String(decision.target));
      const executed = await executePageClick(tabId,frameId,local,
        targetEntry?.clickMode === 'trusted-pointer');
      await sleep(WAIT_MS_SECTION);
      const after = await snapshotAllFrames(tabId);
      const editorRemains = after.page.activeSection === decision.section && after.elements.some(el =>
        el.section === decision.section && el.context !== 'popup' &&
        /^(取消|返回)$/.test(String(el.label || '').replace(/\s/g,'')) && el.operations?.includes('CLICK'));
      if (!executed?.ok || editorRemains || classifyPageState(after.page,after.elements).kind === 'unsaved-confirmation') {
        addPendingIssue(decision.section,'退出编辑器未获确认，保留现场');
        return {ok:false,sections,pendingIssues,reason:'当前编辑器无法安全退出'};
      }
      if (decision.deferRecord) {
        const block=ledger[`${decision.section}|*`]?.activeBlock;
        const key=recordLedgerKey(decision.section,block,resume,decision.recordIndex);
        ledger[key]={...ledger[key],skipped:true};
        ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],workBlocked:false,editorPending:false};
      } else ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],deferred:true,editorPending:false};
      addPendingIssue(decision.deferRecord ? `${decision.section} 第 ${decision.recordIndex+1} 条` : decision.section,
        '本轮跳过；未保存的编辑内容需待资料补齐后重填');
      sections.push({section:decision.section,recordIndex:decision.recordIndex,status:'deferred',
        reason:decision.deferRecord ? '继续检查本分区其余记录' : '继续其他可填写分区'});
      menuExits = 0;
      if (!decision.deferRecord) focusSection='';
      report({step:turn,phase:'section',action:`已退出「${decision.section}」，记录待补并继续${decision.deferRecord?'检查其余记录':'其他分区'}`});
      continue;
    }
    if (['ADD_RECORD','WORK_SECTION'].includes(decision.operation) && decision.section &&
        !ledger[`${decision.section}|*`]?.activeBlock) {
      focusSection=decision.section;
      try {
        await routeDataBlock(decision.section,snap);
      } catch (err) {
        addPendingIssue(decision.section,`资料块选择失败：${err.message}`);
        return {ok:false,reason:`Jev 资料块选择失败：${err.message}`,sections,pendingIssues};
      }
      // 资料块已确定；重新观察页面和记录索引，再构造当前块的操作。
      continue;
    }
    if (decision.operation === 'FOCUS_SECTION' || decision.operation === 'ADD_RECORD') {
      focusSection=decision.section;
      const dataBlock=ledger[`${decision.section}|*`]?.activeBlock || '';
      const {frameId,local} = parseFrameTarget(decision.target);
      const targetEntry = snap.elements.find(element => String(element.index) === String(decision.target));
      const executed = await executePageClick(tabId,frameId,local,
        targetEntry?.clickMode === 'trusted-pointer');
      if (!executed?.ok) {
        const key = recordLedgerKey(decision.section,dataBlock,resume,decision.recordIndex || 0);
        ledger[key] = decision.operation === 'ADD_RECORD' ?
          {addBlocked:true,status:'新增入口执行失败'} : {focusBlocked:true,status:'入口执行失败'};
        addPendingIssue(decision.section || decision.label, executed?.reason || '无法执行分区入口');
        ledger[`${decision.section}|*`]={...ledger[`${decision.section}|*`],
          ...(decision.operation==='ADD_RECORD' ? {addBlocked:true} : {focusBlocked:true})};
      } else {
        if (decision.operation === 'FOCUS_SECTION' && Number.isInteger(decision.recordIndex)) {
          const sectionKey=`${decision.section}|*`;
          ledger[sectionKey]={...ledger[sectionKey],editorRecordIndex:decision.recordIndex};
        }
        report({step:turn,phase:'execute',action:`${decision.operation === 'ADD_RECORD' ? '新增' : '进入'}「${decision.section || decision.label}」`});
        await sleep(WAIT_MS_SECTION);
        const current = await snapshotAllFrames(tabId);
        if (decision.operation === 'FOCUS_SECTION' &&
            current.page?.activeSection !== decision.section && current.fingerprint === snap.fingerprint) {
          ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],focusBlocked:true,status:'进入分区后页面未变化'};
          addPendingIssue(decision.section, '点击分区入口后页面未变化');
        }
        if (decision.operation === 'ADD_RECORD') {
          const addition = classifyRecordAddition({section:decision.section,dataBlock,before:snap,after:current});
          if(addition.verified) {
            const evidence=addedRecordEvidence(scopeControls(current.elements,{section:decision.section,
              editorFrames:current.page.editorFrames,editorSurfaceId:current.page.editorSurfaceId}),
              {section:decision.section,...addition,beforeElements:snap.elements});
            const key=recordLedgerKey(decision.section,dataBlock,resume,decision.recordIndex || 0);
            runMemory.historyByRecord.set(key,[...(runMemory.historyByRecord.get(key) || []),...evidence.defaults]);
            if(evidence.recordKey) {
              const sectionKey=`${decision.section}|*`,state=ledger[sectionKey] || {};
              ledger[sectionKey]={...state,recordBindingsByBlock:{...state.recordBindingsByBlock,
                [dataBlock]:{...state.recordBindingsByBlock?.[dataBlock],[evidence.recordKey]:decision.recordIndex || 0}}};
            }
          }
          if (!addition.verified) {
            const key = recordLedgerKey(decision.section,dataBlock,resume,decision.recordIndex || 0);
            ledger[key] = {addBlocked:true,status:addition.reason};
            ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],addBlocked:true,status:addition.reason};
            addPendingIssue(decision.section, addition.reason);
            report({step:turn,phase:'section',action:`「${decision.section}」新增未获页面确认，已停止重复点击`});
          } else if (addition.mode === 'editor' || addition.mode === 'route') {
            const sectionKey=`${decision.section}|*`;
            ledger[sectionKey]={...ledger[sectionKey],editorPending:true,editorRecordIndex:decision.recordIndex || 0,
              recordMode:addition.mode};
            report({step:turn,phase:'section',action:`「${decision.section}」${addition.reason}，开始填写第 ${Number(decision.recordIndex || 0)+1} 条`});
          } else {
            const sectionKey=`${decision.section}|*`;
            ledger[sectionKey]={...ledger[sectionKey],editorPending:false,workBlocked:false,recordMode:'inline'};
            report({step:turn,phase:'section',action:`「${decision.section}」已新增第 ${addition.afterRendered} 条，继续填写新记录`});
          }
        }
      }
      continue;
    }
    if (decision.operation !== 'WORK_SECTION' || !decision.section) continue;
    const before = await snapshotAllFrames(tabId);
    const scopedControls = scopeControls(before.elements,{section:decision.section,editorFrames:before.page.editorFrames,
      editorSurfaceId:before.page.editorSurfaceId});
    const activeBlock=ledger[`${decision.section}|*`]?.activeBlock;
    focusSection=decision.section;
    const fieldBindings=ledger[`${decision.section}|*`]?.bindingsByBlock?.[activeBlock] || [];
    const recordBindings=ledger[`${decision.section}|*`]?.recordBindingsByBlock?.[activeBlock] || {};
    const recordEditor=ledger[`${decision.section}|*`]?.editorPending || !!before.page.editorSurface;
    const planBefore = buildActionPlan(scopedControls,resume,[],{
      ...before.page,title:decision.section,dataBlock:activeBlock,allowAddRecords:false,
      scopedSection:true,ignoreUnmapped:true,recordScope:true,recordEditor,recordIndex:decision.recordIndex || 0,fieldBindings,recordBindings
    });
    const anchorCount = countRenderedRecords(decision.section, scopedControls,activeBlock);
    const key = recordLedgerKey(decision.section,activeBlock,resume,decision.recordIndex || 0);
    report({step:turn,phase:'section',action:`专注填写「${decision.section}」；已隔离 ${scopedControls.length} 个控件`});
    const result = await runRecordTransaction({goal,resume,apiKey,tabId,onProgress:report,isCurrentRun,scopeSection:decision.section,
      dataBlock:activeBlock,fieldBindings,recordBindings,recordEditor,initialRecordIndex:decision.recordIndex ?? 0,runMemory,recordKey:key});
    if (result.cancelled) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
    const sectionKey=`${decision.section}|*`;
    const sectionState=ledger[sectionKey] || {};
    ledger[sectionKey]={...sectionState,bindingsByBlock:{...sectionState.bindingsByBlock,
      [activeBlock]:[...(sectionState.bindingsByBlock?.[activeBlock] || []),
        ...(result.history || []).filter(item=>item.kind==='bind')]},
      skipsByBlock:{...sectionState.skipsByBlock,[activeBlock]:[
        ...(sectionState.skipsByBlock?.[activeBlock] || []),
        ...(result.history || []).filter(item=>item.skipControlKey)]}};
    // 局部事务结束后关闭选择器，下一分区只看到自己的控件和浮层。
    if (!result.ok) {
      for (const frameId of new Set(scopedControls.map(frameOf))) await closePageTransactions(tabId,frameId);
      await sleep(WAIT_MS_OVERLAY);
    }
    const afterWork = await snapshotAllFrames(tabId);
    const source=resume[activeBlock];
    const record=Array.isArray(source) ? source[decision.recordIndex || 0] : source;
    const savedRecord = result.sectionSaved && savedRecordEvidence(afterWork.elements,
      {section:decision.section,record,recordIndex:decision.recordIndex});
    const inlineComplete = result.ok && result.done && !scopedControls.some(el =>
      isRecordSaveControl(el, scopedControls));
    const previousAttempts = ledger[key]?.workAttempts || 0;
    const noProgress = !result.ok && afterWork.fingerprint === before.fingerprint;
    const noAvailableAction = !result.ok &&
      /^当前页面没有可执行的已映射动作/.test(result.reason || '');
    const noLocalMapping = result.mappedControls === 0 || (noAvailableAction && planBefore.summary?.mappedControls === 0 &&
      !(planBefore.summary?.unresolvedMapped || []).length);
    const afterControls=scopeControls(afterWork.elements,{section:decision.section,editorFrames:afterWork.page.editorFrames,
      editorSurfaceId:afterWork.page.editorSurfaceId});
    const afterPlan=buildActionPlan(afterControls,resume,result.history || [],{
      ...afterWork.page,title:decision.section,dataBlock:activeBlock,recordIndex:decision.recordIndex || 0,
      scopedSection:true,ignoreUnmapped:true,recordScope:true,recordBindings,recordEditor:!!afterWork.page.editorSurface,allowAddRecords:false
    });
    const mappedMissing=new Set((afterPlan.summary?.unresolvedMapped || []).map(item=>item.target));
    const missingRequired = afterWork.elements.some(el =>
      el.section === decision.section && mappedMissing.has(el.index) && isEmptyRequiredField(el));
    const outcome=recordOutcome({hasData:activeBlock==='siteRules' || !!record,
      recognized:!noLocalMapping || (result.history || []).some(item=>item.kind==='bind'),
      filled:result.ok && inlineComplete,editorClosed:!afterWork.page.editorSurface,
      saveRequested:result.sectionSaved || (result.history || []).some(item=>item.recordCommit),saveEvidence:savedRecord,
      conflicts:result.recordConflict ? [result.reason] : [],
      errors:afterControls.filter(el=>el.validationError).concat(missingRequired ? [{label:'必填字段'}] : []),
      pendingFields:result.pendingIssues || [],decisionUnavailable:/^Jev 调用失败/.test(result.reason || '')});
    const status=outcome.status;
    const issuePrefix=`${decision.section} ${activeBlock} #${Number(decision.recordIndex || 0)+1} `;
    for(const issue of result.pendingIssues || []) addPendingIssue(`${issuePrefix}${issue.field || ''}`.trim(),issue.reason);
    ledger[key]={...ledger[key],completed:outcome.completed,status,workAttempts:outcome.completed ? 0 : previousAttempts+1};
    if (outcome.completed) {
      const records=Array.isArray(source) ? source : [source];
      ledger[sectionKey]={...ledger[sectionKey],editorPending:false,
        savedCount:records.filter((_,index)=>ledger[recordLedgerKey(decision.section,activeBlock,resume,index)]?.completed).length};
      if (records.every((_,index)=>ledger[recordLedgerKey(decision.section,activeBlock,resume,index)]?.completed)) {
        const sectionKey=`${decision.section}|*`;
        const state=ledger[sectionKey] || {};
        ledger[sectionKey]={...state,activeBlock:null,focusBlocked:false,workBlocked:false,
          savedCount:0,completedBlocks:[...new Set([...(state.completedBlocks || []),activeBlock])]};
      }
    }
    if (noAvailableAction) {
      const sectionKey = `${decision.section}|*`;
      // 当前记录结束本轮尝试；调度器基于下一张快照决定是否存在可安全新增的下一条记录。
      // 新增失败由 ADD_RECORD 的独立验收状态处理，避免一次局部映射缺口封锁整个分区。
      ledger[sectionKey] = {...ledger[sectionKey],workBlocked:true,
        status:'当前分区无可执行的已映射动作'};
    }
    // 动态字段可能在一次选择后才挂载（例如“其他”来源的补充输入框）。保留最多
    // 三次 section 复查机会，每次都基于新快照生成动作；第三次仍无进展才封锁。
    if (!outcome.completed && (result.terminal || noProgress)) ledger[key].workAttempts=3;
    if (outcome.completed) {
      for (let i=pendingIssues.length-1;i>=0;i-=1) {
        if (pendingIssues[i].field.startsWith(issuePrefix)) {
          pendingIssues.splice(i,1);
        }
      }
    }
    if (decision.section === '上传') {
      const needsResume = scopedControls.some(el => el.context !== 'popup' && el.kind === 'file' && /上传简历|简历附件/.test(String(el.label || '')));
      const resumeFile = resume.basics?.resumeFile || resume.resumeFile || resume.attachment;
      if (needsResume && !resumeFile?.dataUrl) {
        addPendingIssue('上传 上传简历', '本地资料中缺少简历附件文件');
      }
    }
    sections.push({section:decision.section,dataBlock:activeBlock,
      recordIndex:decision.recordIndex ?? Math.max(0,anchorCount-1),status,reason:result.reason || ''});
    const exhausted = !outcome.completed && (result.returned || result.terminal || noProgress || noAvailableAction || status==='save-unverified' || previousAttempts + 1 >= 3);
    if (exhausted) {
      addPendingIssue(`${decision.section} ${activeBlock}`, status==='recognition-gap' ? '已有本地资料，当前控件尚未完成识别' :
        status==='save-unverified' ? '编辑器关闭后缺少当前记录的保存回读证据' : result.reason || '当前资料块未完成');
    }
    if (exhausted && status!=='save-unverified' && Array.isArray(source) && source.some((_,index)=>index!==Number(decision.recordIndex || 0) &&
        !ledger[recordLedgerKey(decision.section,activeBlock,resume,index)]?.completed &&
        !ledger[recordLedgerKey(decision.section,activeBlock,resume,index)]?.skipped)) {
      ledger[key]={...ledger[key],skipped:true};
      ledger[sectionKey]={...ledger[sectionKey],workBlocked:false,focusBlocked:false,
        editorPending:!!afterWork.page.editorSurface};
    } else if (status === 'data-gap' || exhausted) {
      const sectionKey=`${decision.section}|*`;
      const state=ledger[sectionKey] || {};
      ledger[sectionKey]={...state,activeBlock:null,workBlocked:false,focusBlocked:false,
        blockedBlocks:[...new Set([...(state.blockedBlocks || []),activeBlock])],savedCount:0};
    }
    report({step:turn,phase:'section',action:`「${decision.section}」${outcome.completed ? `${status==='saved'?'已保存回读':'已填写回读'}，返回分区清单` : '保留待处理，继续其他分区'}`});
    // 记录事务结束后，网页可能多出记录或必填提示；每次都重新快照生成清单。
  }
  await auditRequiredFields();
  return {ok:false,reason:'分区调度超过 160 轮，已停止避免循环',sections,pendingIssues};
}

async function runFill(msg) {
  const { resume:sourceResume, apiKey } = msg;
  agreementConfirmedForRun = msg.agreementConfirmed === true;
  const goal = DEFAULT_GOAL;
  const resume = prepareResume(sourceResume);
  if (!apiKey) {
    pushToPopup({ type: "FILL_DONE", ok: false, reason: "未填写 TypeSafe API Key" });
    return;
  }
  if (!resume) {
    pushToPopup({ type: "FILL_DONE", ok: false, reason: "未录入简历数据" });
    return;
  }

  // 同一时刻只保留最新一次用户发起的填写任务。新任务会让旧任务在快照或 API 返回后安全退出。
  const runId = ++activeFillRunId;
  const isCurrentRun = () => runId === activeFillRunId;
  const report = (p) => {
    if (!isCurrentRun()) return;
    console.log("[Jev Resume Filler] progress:", p);
    pushToPopup({ type: "FILL_PROGRESS", ...p });
  };

  const tab = await getActiveTab();
  if (!isCurrentRun()) return;
  if (!tab) {
    pushToPopup({ type: "FILL_DONE", ok: false, reason: "未找到活动标签页" });
    return;
  }

  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused:true });
    await chrome.tabs.update(tab.id, { active:true });
    await sleep(250);
  }

  const injected = await ensureContentScript(tab.id);
  if (!isCurrentRun()) return;
  if (!injected) {
    pushToPopup({
      type: "FILL_DONE",
      ok: false,
      reason: "无法注入 content script，请确认当前标签页是普通网页（非 chrome:// 页面）"
    });
    return;
  }

  // 先报一步，界面上立刻有动静，不用等到第一轮 Jev 返回
  // 带上标题和 URL：一眼看出接管的是不是你想填的那个页面
  report({
    step: 0,
    phase: "start",
    runtimeVersion: CONTENT_SCRIPT_VERSION,
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    action: `已接管页面「${tab.title || '无标题'}」${tab.url ? ' ' + tab.url : ''}，开始读取控件`
  });

  const first=await snapshotAllFrames(tab.id);
  const pageState = classifyPageState(first.page, first.elements);
  if (pageState.kind === 'auth-required' || pageState.kind === 'job-detail') {
    pushToPopup({type:'FILL_DONE',ok:false,reason:pageState.reason,pendingIssues:[
      {field:'页面状态',reason:pageState.reason}
    ]});
    return;
  }
  const result=await runSectionScheduler({tabId:tab.id,resume,apiKey,goal,report,isCurrentRun});

  if (isCurrentRun()) pushToPopup({ type: "FILL_DONE", ...result });
}

// Popup 打开的长连接。它本身不传数据，作用是让 Service Worker 在填写期间不被挂起
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fill-keepalive") return;
  console.log("[Jev Resume Filler] 保活连接已建立");
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    console.log("[Jev Resume Filler] 保活连接已断开");
  });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log("[Jev Resume Filler] onInstalled:", reason);
});
