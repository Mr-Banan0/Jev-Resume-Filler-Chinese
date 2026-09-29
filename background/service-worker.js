// background/service-worker.js — 阶段3：Agent 主循环
// 接收 Popup 的 START_FILL，跑完整 Agent 循环，通过 FILL_PROGRESS/FILL_DONE 推送进度

import { buildActionPlan, buildSectionPlan, choose, classifyRecordAddition, countRenderedRecords, getResumeValue, prepareResume, sectionCollection } from "../lib/jev-client.js";
import { CONTENT_SCRIPT_VERSION } from "../lib/content-version.js";
import { classifyPageState } from "../lib/page-state.js";
import { honorSections, recordIdentity, savedAt, HONOR_OVERVIEW_PATH } from "../lib/honor-flow.js";

console.log("[Jev Resume Filler] Service Worker 启动");

const MAX_STEPS = 120;
let agreementConfirmedForRun = false;
// 页面持续变化（实时刷新元素）时，最多容忍几次"决策过期"，超过就照常执行，避免空转
const MAX_STALE_RETRY = 3;
// 连续多少次"操作了但页面没任何变化"就判定点了个不动的控件，直接停
const MAX_NO_CHANGE = 3;
// 网申表单常分成多步（荣耀是 13 步）。允许翻到下一步，但绝不点最终投递
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
let eventPersistence = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pushToPopup(message) {
  if (['FILL_PROGRESS','FILL_DONE'].includes(message.type)) {
    fillEvents.push({ ...message, at: Date.now() });
    fillEvents = fillEvents.slice(-500);
    const events = fillEvents.slice();
    eventPersistence = eventPersistence.then(() => chrome.storage.session.set({ fillEvents:events })).catch(() => {});
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

// 飞书招聘的部分卡片仅响应浏览器派发的真实用户输入。内容脚本负责把已扫描的
// 卡片转换成当前视口坐标，后台在当前标签页短暂附加 Chrome 调试通道发送一次
// 鼠标事务，并在事务结束后立即分离。该路径仅由快照中的 trusted-pointer 标记
// 启用，普通网页继续使用原有的 DOM 执行器。
async function clickWithTrustedPointer(tabId, frameId, index) {
  if (frameId !== 0) {
    return {ok:false,reason:'真实指针点击目前仅支持顶层飞书表单'};
  }
  const target = await sendToFrame(tabId, frameId, {type:'TRUSTED_CLICK_POINT',index});
  if (!target?.ok || target.clickMode !== 'trusted-pointer') {
    return target?.ok ? {ok:false,reason:'目标未声明真实指针点击策略'} : target;
  }
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
    return {ok:false,reason:'扩展尚未启用 Chrome debugger 权限，无法执行飞书真实点击'};
  }
  const debuggee = {tabId};
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const x = Number(target.point?.x);
    const y = Number(target.point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {ok:false,reason:'飞书卡片未返回有效点击坐标'};
    }
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mouseMoved',x,y,pointerType:'mouse'
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'
    });
    await sleep(35);
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'
    });
    return {ok:true,action:'click',bridge:'trusted-pointer',label:target.label};
  } catch (err) {
    return {ok:false,reason:`飞书真实点击未执行：${err.message}`};
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function executePageClick(tabId, frameId, index, trustedPointer = false) {
  if (trustedPointer) return clickWithTrustedPointer(tabId, frameId, index);
  return sendToFrame(tabId, frameId, {type:'EXECUTE',action:'click',index});
}

// 飞书的单年份框通过展开年份网格提交值。内容脚本将输入框和已展开网格中的
// 年份条目转换成坐标，后台用浏览器原生指针依次打开并选择，随后回读输入值。
async function selectFeishuYearFromPicker(tabId, frameId, index, value) {
  if (frameId !== 0) return {ok:false,reason:'飞书年份选择器目前仅支持顶层表单'};
  const target = await sendToFrame(tabId, frameId, {type:'FEISHU_YEAR_TARGET',index});
  if (!target?.ok || target.inputMode !== 'feishu-year-picker') {
    return target?.ok ? {ok:false,reason:'目标未声明飞书年份选择器策略'} : target;
  }
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
    return {ok:false,reason:'扩展尚未启用 Chrome debugger 权限，无法执行飞书年份选择'};
  }
  const x = Number(target.point?.x);
  const y = Number(target.point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {ok:false,reason:'飞书年份框未返回有效输入坐标'};
  const marked = await sendToFrame(tabId, frameId, {type:'MARK_TARGET',index});
  if (!marked?.ok) return marked;
  const selector = `[data-jev-fill-target="${marked.token}"]`;
  const readValue = `(() => document.querySelector(${JSON.stringify(selector)})?.value || '')()`;

  const debuggee = {tabId};
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'
    });
    await sleep(80);
    const choice = await sendToFrame(tabId, frameId, {
      type:'FEISHU_YEAR_CHOICE_POINT',index,year:String(value)
    });
    if (!choice?.ok || choice.selectionMode !== 'feishu-year-picker') {
      return choice?.ok ? {ok:false,reason:'飞书年份网格未提供目标年份'} : choice;
    }
    const choiceX = Number(choice.point?.x);
    const choiceY = Number(choice.point?.y);
    if (!Number.isFinite(choiceX) || !Number.isFinite(choiceY)) {
      return {ok:false,reason:'飞书年份网格未返回有效选择坐标'};
    }
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mousePressed',x:choiceX,y:choiceY,button:'left',buttons:1,clickCount:1,pointerType:'mouse'
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type:'mouseReleased',x:choiceX,y:choiceY,button:'left',buttons:0,clickCount:1,pointerType:'mouse'
    });
    await sleep(120);
    const verification = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression:readValue,returnByValue:true,awaitPromise:true
    });
    const actual = String(verification?.result?.value || '');
    if (actual !== String(value)) {
      return {ok:false,reason:`飞书年份框回读失败（期望 ${value}，实际 ${actual || '空白'}）`};
    }
    return {ok:true,action:'type_text',bridge:'feishu-year-picker',label:target.label};
  } catch (err) {
    return {ok:false,reason:`飞书年份选择未执行：${err.message}`};
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

// 飞书的月份范围由两个可见日期槽和弹出的年、月列表组成。隐藏 input 的 value
// 不代表表单已接受的日期；每一端都通过选择器提交，再从可见槽回读。
async function selectFeishuRangeFromPicker(tabId, frameId, index, value) {
  if (frameId !== 0) return {ok:false,reason:'飞书日期范围仅支持顶层表单'};
  const match = String(value || '').match(/^(\d{4}-\d{2}) - (\d{4}-\d{2}|至今)$/);
  if (!match) return {ok:false,reason:'飞书日期范围需要起止年月或“至今”'};
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
    return {ok:false,reason:'扩展尚未启用 Chrome debugger 权限，无法选择飞书日期'};
  }
  const wanted = [match[1],match[2]];
  const read = () => sendToFrame(tabId, frameId, {type:'FEISHU_RANGE_STATE',index});
  const initial = await read();
  if (!initial?.ok) return initial;
  const debuggee = {tabId};
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const clickPoint = async result => {
      if (!result?.ok) throw new Error(result?.reason || '飞书日期未返回点击目标');
      const x = Number(result.point?.x);
      const y = Number(result.point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('飞书日期坐标无效');
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type:'mouseMoved',x,y,pointerType:'mouse'
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'
      });
      await sleep(35);
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,pointerType:'mouse'
      });
      await sleep(90);
    };
    const choosePart = async (slot, axis, part) => {
      let point;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        point = await sendToFrame(tabId,frameId,{
          type:'FEISHU_RANGE_CHOICE_POINT',index,slot,axis,value:part
        });
        if (point?.ok) break;
        await sleep(150);
      }
      await clickPoint(point);
    };
    const waitForSlot = async (slot, expected) => {
      let state;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        state = await read();
        if (state?.ok && state.values?.[slot] === expected) return state;
        await sleep(120);
      }
      return state;
    };
    for (let slot = 0; slot < 2; slot += 1) {
      const state = await read();
      if (!state?.ok) throw new Error(state?.reason || '飞书日期状态无法读取');
      const current = String(state.values?.[slot] || '');
      if (current === wanted[slot]) continue;
      if (current !== 'YYYY-MM' && current !== '') {
        throw new Error(`飞书日期第 ${slot + 1} 端已有不同值 ${current}，已保留`);
      }
      await clickPoint(await sendToFrame(tabId,frameId,{type:'FEISHU_RANGE_SLOT_POINT',index,slot}));
      const [year,month] = wanted[slot] === '至今' ? ['至今',''] : wanted[slot].split('-');
      await choosePart(slot,'year',year);
      if (month) {
        let afterYear = await read();
        if (afterYear?.values?.[slot] !== wanted[slot]) {
          let monthPoint = await sendToFrame(tabId,frameId,{
            type:'FEISHU_RANGE_CHOICE_POINT',index,slot,axis:'month',value:month
          });
          if (!monthPoint?.ok) {
            await clickPoint(await sendToFrame(tabId,frameId,{type:'FEISHU_RANGE_SLOT_POINT',index,slot}));
            monthPoint = await sendToFrame(tabId,frameId,{
              type:'FEISHU_RANGE_CHOICE_POINT',index,slot,axis:'month',value:month
            });
          }
          await clickPoint(monthPoint);
        }
      }
      const updated = await waitForSlot(slot,wanted[slot]);
      if (!updated?.ok || updated.values?.[slot] !== wanted[slot]) {
        throw new Error(`飞书日期第 ${slot + 1} 端回读失败（期望 ${wanted[slot]}，实际 ${updated?.values?.[slot] || '空白'}）`);
      }
    }
    const finalState = await read();
    if (!finalState?.ok || finalState.values?.some((item,slot) => item !== wanted[slot])) {
      return {ok:false,reason:`飞书日期范围回读失败：${finalState?.values?.join(' - ') || '空白'}`};
    }
    return {ok:true,action:'type_text',bridge:'feishu-range-picker',value:wanted.join(' - ')};
  } catch (err) {
    return {ok:false,reason:`飞书日期选择未完成：${err.message}`};
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function clickBeisenPickerInPage(tabId, frameId, index, label, pickerLeaf = false) {
  const marked = await sendToFrame(tabId, frameId, {type:'MARK_TARGET',index});
  if (!marked?.ok) return marked;
  try {
    const results = await chrome.scripting.executeScript({
      target:{tabId,frameIds:[frameId]},world:'MAIN',args:[marked.token,label,pickerLeaf],
      func:async (token,wantedLabel,isLeaf) => {
        const markedElement=document.querySelector(`[data-jev-fill-target="${CSS.escape(token)}"]`);
        try {
          const area=markedElement?.closest('.area-selector-container');
          if (area) {
            const reactClick=node=>{
              for (let current=node;current && area.contains(current);current=current.parentElement) {
                const key=Object.keys(current).find(name=>name.startsWith('__reactEventHandlers$') ||
                  name.startsWith('__reactProps$'));
                const handler=key && current[key]?.onClick;
                if (typeof handler==='function') {
                  handler({target:node,currentTarget:current,stopPropagation(){},preventDefault(){}});
                  return true;
                }
              }
              node.click();
              return true;
            };
            if (/^(确定|确认)$/.test(wantedLabel)) {
              if (!/已选地区\s*1\s*\/\s*1/.test(area.innerText || area.textContent || '')) {
                return {ok:false,reason:'地区选择器尚未选中末级地区'};
              }
              const buttons=Array.from(area.querySelectorAll('.phoenix-button__wraper'));
              const confirm=buttons.find(button=>button.textContent.trim()===wantedLabel);
              if (!confirm) return {ok:false,reason:'地区选择器找不到确认按钮'};
              const closed=()=>!area.isConnected || area.getBoundingClientRect().width===0 ||
                getComputedStyle(area).visibility==='hidden' || getComputedStyle(area).display==='none';
              confirm.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
              confirm.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
              confirm.click();
              await new Promise(resolve=>setTimeout(resolve,180));
              if (closed()) return {ok:true,action:'click',label:wantedLabel,bridge:'page-world-area-confirm'};
              const reactKey=Object.keys(confirm).find(name=>name.startsWith('__reactEventHandlers$') ||
                name.startsWith('__reactProps$'));
              const handler=reactKey && confirm[reactKey]?.onClick;
              if (typeof handler==='function') {
                handler({target:confirm,currentTarget:confirm,nativeEvent:new MouseEvent('click'),
                  stopPropagation(){},preventDefault(){},isDefaultPrevented(){return false;}});
                await new Promise(resolve=>setTimeout(resolve,180));
              }
              return closed() ? {ok:true,action:'click',label:wantedLabel,bridge:'page-world-react-area-confirm'} :
                {ok:false,reason:'地区选择器确认后仍未关闭'};
            }
            const labelNode=markedElement.matches?.('.area-text-label') ? markedElement :
              markedElement.querySelector?.('.area-text-label') ||
              Array.from(area.querySelectorAll('.area-text-label')).find(node=>node.textContent.trim()===wantedLabel);
            if (!labelNode) return {ok:false,reason:'地区选择器找不到候选标签'};
            const target=isLeaf ? labelNode.closest('.area-item-name')?.querySelector('.icon-container svg') || labelNode : labelNode;
            reactClick(target);
            return {ok:true,action:'click',label:wantedLabel,bridge:isLeaf?'page-world-area-leaf':'page-world-area-branch'};
          }
          const container=markedElement?.closest('.constant-main-selector-container');
          if (!container) return {ok:false,reason:'目标不属于北森常量选择器'};
          if (/^(确定|确认)$/.test(wantedLabel)) {
            if (/已选\s*0\s*\//.test(container.innerText || container.textContent || '')) {
              return {ok:false,reason:'北森选择器尚未选中候选值'};
            }
            const candidates=[markedElement,...markedElement.querySelectorAll('*')];
            for (let node=markedElement?.parentElement; node && container.contains(node); node=node.parentElement) {
              candidates.push(node);
            }
            for (const node of candidates) {
              const key=Object.keys(node).find(name=>name.startsWith('__reactEventHandlers$') ||
                name.startsWith('__reactProps$'));
              const handler=key && node[key]?.onClick;
              if (typeof handler === 'function') {
                handler({target:node,currentTarget:node,stopPropagation(){},preventDefault(){}});
                return {ok:true,action:'click',label:wantedLabel,bridge:'page-world-react-confirm'};
              }
            }
            markedElement.click();
            return {ok:true,action:'click',label:wantedLabel,bridge:'page-world-confirm'};
          }
          const row=markedElement?.closest('.constant-main-selector-container .list-item-container') ||
            Array.from(document.querySelectorAll('.constant-main-selector-container .list-item-container'))
              .find(item=>item.textContent.trim()===wantedLabel);
          const icon=row?.querySelector('svg');
          if (!icon) return {ok:false,reason:'页面主环境找不到北森单选图标'};
          const reactKey=Object.keys(icon).find(key=>key.startsWith('__reactEventHandlers$') ||
            key.startsWith('__reactProps$'));
          const onClick=reactKey && icon[reactKey]?.onClick;
          if (typeof onClick === 'function') {
            onClick({target:icon,currentTarget:icon,stopPropagation(){},preventDefault(){}});
            return {ok:true,action:'click',label:wantedLabel,bridge:'page-world-react'};
          }
          icon.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
          return {ok:true,action:'click',label:wantedLabel,bridge:'page-world-svg'};
        } finally {
          markedElement?.removeAttribute('data-jev-fill-target');
        }
      }
    });
    return results?.[0]?.result || {ok:false,reason:'北森单选没有返回执行结果'};
  } catch (err) {
    return {ok:false,reason:`北森单选页面执行失败：${err.message}`};
  }
}

// Moka 使用 React 受控表单。content script 位于隔离世界，直接写 DOM 时虽然肉眼
// 可见，React 的 value tracker 和表单校验仍可能保留旧值。该函数在页面 MAIN
// world 中执行，让原生 setter、tracker 与 React 的 input/change 管线保持一致。
async function commitControlledText(tabId, frameId, index, value, keepFocus = false) {
  const marked = await sendToFrame(tabId, frameId, {type:'MARK_TARGET', index});
  if (!marked?.ok || !marked.token) return marked || {ok:false,reason:'无法标记目标输入框'};
  try {
    const results = await chrome.scripting.executeScript({
      target:{tabId,frameIds:[frameId]},
      world:'MAIN',
      args:[marked.token,String(value),keepFocus],
      func:async (token,nextValue,keepEditorOpen) => {
        const el=document.querySelector(`[data-jev-fill-target="${CSS.escape(token)}"]`);
        if (!el) return {ok:false,reason:'页面主环境找不到目标输入框'};
        try {
          const previous=String(el.value || '');
          el.focus();
          const key=nextValue.slice(-1) || 'Backspace';
          el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key}));
          el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:nextValue}));
          if (typeof el.select === 'function') el.select();
          let inserted=false;
          try { inserted=document.execCommand('insertText',false,nextValue); } catch (_) {}
          if (!inserted || String(el.value || '') !== nextValue) {
            const proto=el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
            if (setter) setter.call(el,nextValue); else el.value=nextValue;
            if (el._valueTracker?.setValue) el._valueTracker.setValue(previous);
          }
          const inputEvent=new InputEvent('input',{bubbles:true,inputType:'insertText',data:nextValue});
          if (!inserted) el.dispatchEvent(inputEvent);
          el.dispatchEvent(new Event('change',{bubbles:true}));

          // 某些 Moka 构建把处理器放在 React 的节点属性上，但委托监听器不会接收
          // 扩展创建的事件。直接调用当前节点的受控回调，参数仍指向真实 DOM 节点。
          let propsKey='';
          let props=null;
          for (let node=el,depth=0; node && depth<5 && !props; node=node.parentElement,depth+=1) {
            for (const name of Object.keys(node)) {
              if (name.startsWith('__reactProps$') || name.startsWith('__reactEventHandlers$')) {
                const candidate=node[name];
                if (typeof candidate?.onChange === 'function' || typeof candidate?.onInput === 'function') {
                  propsKey=name;
                  props=candidate;
                  break;
                }
              }
              if (name.startsWith('__reactFiber$') || name === '_reactInternalFiber') {
                let fiber=node[name];
                for (let level=0; fiber && level<5; fiber=fiber.return,level+=1) {
                  const candidate=fiber.memoizedProps || fiber.pendingProps;
                  if (typeof candidate?.onChange === 'function' || typeof candidate?.onInput === 'function') {
                    propsKey=name;
                    props=candidate;
                    break;
                  }
                }
              }
              if (props) break;
            }
          }
          const synthetic={
            bubbles:true,cancelable:false,currentTarget:el,defaultPrevented:false,eventPhase:3,
            isTrusted:false,nativeEvent:inputEvent,target:el,timeStamp:Date.now(),type:'change',
            preventDefault(){this.defaultPrevented=true;},stopPropagation(){},persist(){},
            isDefaultPrevented(){return this.defaultPrevented;},isPropagationStopped(){return false;}
          };
          // 部分 Moka 构建会忽略扩展触发的委托事件，即使 execCommand 已改变可见值。
          // 当前节点保存的 React 回调是表单状态的确定性入口，统一补交一次。
          if (typeof props?.onChange === 'function') props.onChange(synthetic);
          if (typeof props?.onInput === 'function') props.onInput({...synthetic,type:'input'});
          el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key}));
          // 搜索型 combobox 需要保持焦点，候选层才会留在 DOM 中供下一轮选择。
          // 普通文本框继续触发 blur，让站点完成校验与受控状态提交。
          if (!keepEditorOpen) {
            el.blur();
            el.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:null}));
            if (typeof props?.onBlur === 'function') props.onBlur({...synthetic,type:'blur'});
          }
          await new Promise(resolve=>setTimeout(resolve,80));
          const actual=String(el.value || '');
          return {ok:actual === nextValue,action:'type_text',value:actual,verified:actual === nextValue,
            bridge:inserted ? 'exec-command' : propsKey ? 'react-props' : 'native-events',
            reason:actual === nextValue ? undefined : `页面主环境回读不一致：${actual || '空白'}`};
        } finally {
          el.removeAttribute('data-jev-fill-target');
        }
      }
    });
    return results?.[0]?.result || {ok:false,reason:'页面主环境没有返回执行结果'};
  } catch (err) {
    return {ok:false,reason:`页面主环境写入失败：${err.message}`};
  }
}

// 用 executeScript(allFrames) 枚举帧，省掉 webNavigation 权限
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
      const merged = { ...el, index: `f${frameId}_${el.index}` };
      if (Array.isArray(el.options)) {
        merged.options = el.options.map((opt) => ({ ...opt, index: `f${frameId}_${opt.index}` }));
      }
      elements.push(merged);
    }
    if (frameId !== 0 && snap.page && snap.page.text) texts.push(snap.page.text);
  }

  if (!pageInfo) pageInfo = { url: "", title: "", text: "" };
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
  const ping = await sendToFrame(tabId, 0, { type: "PING" });
  if (ping && ping.ok && ping.version === CONTENT_SCRIPT_VERSION) return true;
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
  return !!(again && again.ok);
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

async function runAgent({ goal, resume, apiKey, tabId, onProgress, isCurrentRun = () => true,
  initialRecordIndex, batchRecords = true, targetFrameId = null, sectionTitle = '', scopeSection = '' }) {
  const history = [];
  let step = 0;
  let consecutiveSkips = 0;
  let consecutiveStale = 0;
  // 页面还在渲染时首轮容易取空，最多再等 MAX_EMPTY_RETRY 轮
  let emptyRetries = 0;
  const attempts = new Map();
  const pendingSearchReads = new Map();
  const pendingIssues = [];
  const deferField = async (decision, reason) => {
    if (!decision.resumeField) return false;
    const {frameId} = parseFrameTarget(decision.sourceTarget || decision.target);
    await sendToFrame(tabId,frameId,{type:'CLOSE_TRANSACTIONS'});
    history.push({kind:'cancel',cancelField:decision.resumeField,action:'DEFER_FIELD',page_changed:true});
    pendingIssues.push({field:decision.fieldLabel || decision.label || decision.resumeField,reason});
    onProgress({step,phase:'blocked',action:`${decision.fieldLabel || decision.label} 暂列待补，继续当前记录的其他字段：${reason}`});
    consecutiveSkips = 0;
    await sleep(WAIT_MS_OVERLAY);
    return true;
  };
  let recordIndex = initialRecordIndex ?? Math.max(0, Number(String(goal || '').match(/从第\s*(\d+)\s*条开始/)?.[1] || 1) - 1);
  let recordSection = '';
  let recordCollection;
  let batchNewRecords = false;
  let overviewRetries = 0;

  while (step < MAX_STEPS) {
    if (!isCurrentRun()) {
      return { ok: false, cancelled: true, reason: "已由新的填写任务替换", step, history };
    }
    step += 1;
    onProgress({ step, phase: "snapshot" });

    // 1. 取快照（汇总所有 frame）
    const snap = await snapshotAllFrames(tabId);
    const currentPageState = classifyPageState(snap.page, snap.elements);
    if (currentPageState.kind === 'auth-required' || currentPageState.kind === 'unsaved-confirmation') {
      return {ok:false,terminal:true,reason:currentPageState.reason,step,history,pendingIssues:[
        ...pendingIssues,{field:'页面状态',reason:currentPageState.reason}
      ]};
    }
    if (targetFrameId !== null) {
      snap.elements = snap.elements.filter(el=>parseFrameTarget(el.index).frameId===targetFrameId);
      snap.count = snap.elements.length;
      snap.page = {...snap.page,title:sectionTitle || snap.page.title};
    }
    if (scopeSection) {
      snap.elements = snap.elements.filter(el => el.context === 'popup' || el.section === scopeSection);
      snap.count = snap.elements.length;
      snap.page = {...snap.page, title:scopeSection, scopedSection:true, ignoreUnmapped:true};
    }
    if (step === 1) {
      recordSection = snap.page?.title || '';
      recordCollection = { '获奖经历':'awards','教育经历':'education','语言能力':'languages','项目经验':'projects',
        '专业技能':'professionalSkills','计算机能力':'computerSkills','个人专利':'patents',
        '工作经历':resume.work?.length ? 'work' : 'internship' }[recordSection];
      batchNewRecords = batchRecords && !!recordCollection && new URL(snap.page.url).searchParams.has('isFast');
    }
    const previous = history[history.length - 1];
    if (scopeSection && previous?.kind === 'click' &&
        /^(保存|添加)$/.test(String(previous.label || '').replace(/\s/g,'')) && !previous.commitSettled) {
      previous.commitSettled = true;
      await sleep(WAIT_MS_SECTION);
      continue;
    }
    if (scopeSection && previous?.kind === 'click' &&
        /^保存$/.test(String(previous.label || '').replace(/\s/g,'')) &&
        !snap.elements.some(el => el.section === scopeSection &&
          (el.operations || []).some(operation => ['TYPE_TEXT','SELECT','PICK_DATE'].includes(operation)))) {
      return {ok:true,done:false,sectionSaved:true,reason:'当前分区已保存，编辑器已关闭',pendingIssues,step,history};
    }
    if (scopeSection && previous?.kind === 'click' && /^添\s*加$/.test(previous.label || '') &&
        !snap.elements.some(el => el.section === scopeSection &&
          (el.operations || []).some(operation => ['TYPE_TEXT','SELECT','PICK_DATE'].includes(operation)))) {
      return {ok:true,done:false,sectionSaved:true,reason:'当前记录已保存，编辑器已关闭',pendingIssues,step,history};
    }
    if (previous?.kind === 'click' && previous.label === '保存' && previous.pageTitle !== snap.page?.title) {
      const records = resume[recordCollection] || [];
      if (batchNewRecords && recordIndex + 1 < records.length) {
        const next = records[recordIndex + 1];
        const identity = next.title || next.institution || next.name || next.company || next.language || next.number;
        const entry = snap.elements.find(el => el.kind === 'section-entry' && el.label === recordSection);
        if (!entry && overviewRetries < 3) {
          overviewRetries++;
          await sleep(WAIT_MS_SECTION);
          continue;
        }
        const sections = snap.elements.filter(el=>el.kind==='section-entry').sort((a,b)=>(a.domOrder||0)-(b.domOrder||0));
        const sectionPosition = sections.findIndex(el=>el.label===recordSection);
        const nextSection = sections[sectionPosition + 1]?.label;
        const sectionStart = snap.page.text.indexOf(recordSection);
        const sectionEnd = nextSection ? snap.page.text.indexOf(nextSection,sectionStart + recordSection.length) : -1;
        const sectionText = sectionStart >= 0 ? snap.page.text.slice(sectionStart,sectionEnd < 0 ? undefined : sectionEnd) : '';
        if (entry && identity && !sectionText.includes(identity)) {
          const {frameId,local} = parseFrameTarget(entry.index);
          const opened = await sendToFrame(tabId,frameId,{type:'EXECUTE',action:'click',index:local});
          if (opened?.ok) {
            overviewRetries = 0;
            recordIndex++;
            history.push({kind:'navigate',action:`新增 ${recordSection} 第 ${recordIndex + 1} 条`,page_changed:true});
            onProgress({step,phase:'execute',action:`新增 ${recordSection} 第 ${recordIndex + 1} 条`});
            await sleep(WAIT_MS_SECTION);
            continue;
          }
        }
        return {ok:false,reason:entry ? '当前条目已保存，后续条目已有同名记录，保留供核验' : '当前条目已保存，等待后仍未识别到后续条目入口',pendingIssues,step,history};
      }
      return { ok:true, done:false, sectionSaved:true, reason:'当前分区已保存', pendingIssues, step, history };
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

    // 2. 代码把控件、字段和值绑定为完整动作，再让 Jev 只负责排序。
    //    这一步同时排除最终投递，并让“没有可做动作”的结论由确定性规则给出。
    const actionPlan = buildActionPlan(snap.elements, resume, history, {...snap.page,recordIndex,allowAddRecords:!scopeSection});
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
        return { ok: pendingIssues.length === 0, done: true, pendingIssues, step, history };
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
    if (decision.intent === 'RETURN' && (decision.cancelField || operation==='RETURN')) {
      const {frameId,local}=parseFrameTarget(operation==='RETURN'?'f0_0':target);
      const returned=await sendToFrame(tabId,frameId,operation==='RETURN' ? {type:'CLOSE_TRANSACTIONS'} :
        {type:'EXECUTE',action:'click',index:local});
      if (returned?.ok) {
        pendingIssues.push({field:decision.fieldLabel || resumeField,reason:decision.reason});
        history.push({kind:'cancel',cancelField:resumeField,action:'RETURN',page_changed:true});
        await sleep(WAIT_MS_OVERLAY);
        continue;
      }
    }
    if (decision.semanticFallback && decision.intent !== 'OPEN' && decision.confidence < 0.75) {
      return {ok:false,reason:`候选含义尚未确定：${decision.fieldLabel}`,step,history,
        pendingIssues:[...pendingIssues,{field:decision.fieldLabel,reason:'语义选项匹配置信不足，保留待核对'}]};
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
          // 页面一直在变（有实时刷新元素），不再空转，按当前快照照常执行
          consecutiveStale = 0;
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
    const attemptKey = [snap.page?.url,recordSection,recordIndex,operation,controlKey,resumeField,decision.pickerStep,popupState].join("|");
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
      if (new URL(snap.page.url).hostname === 'iter.stongyw.cn' && /^(internship|projects)\[\d+\]\.(summary|description)$/.test(resumeField)) {
        if (resumeField.startsWith('projects[') && /项目职责/.test(decision.label) && /^项目背景：/.test(siteValue)) {
          const firstSentenceEnd=siteValue.indexOf('。');
          if (firstSentenceEnd >= 0) siteValue=siteValue.slice(firstSentenceEnd+1);
        }
        const limit=resumeField.startsWith('projects[') ? 250 : 500;
        if (siteValue.length > limit) {
          const complete = siteValue.slice(0,limit).match(/^.*[。！？.!?]/s)?.[0];
          siteValue = complete && complete.length >= limit/2 ? complete : siteValue.slice(0,limit);
        }
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
    const isMoka = snap.page?.platform === 'moka-form' ||
      (() => { try { return /(^|\.)mokahr\.com$/i.test(new URL(snap.page.url).hostname); } catch (_) { return false; } })();
    const isFeishu = snap.page?.platform === 'feishu-jobs' ||
      (() => { try { return /(^|\.)jobs\.feishu\.cn$/i.test(new URL(snap.page.url).hostname); } catch (_) { return false; } })();
    const keepFeishuSearchOpen = isFeishu && operation === 'TYPE_TEXT' &&
      /^education\[\d+\]\.(institution|area)$/.test(resumeField || '') &&
      /(?:学校|专业|请输入)/.test(`${decision.label || ''} ${targetEntry?.label || ''}`);
    const beisenPopupChoice = operation === 'CLICK' && decision.context === 'popup' &&
      (() => { try { return /(^|\.)zhiye\.com$/i.test(new URL(snap.page.url).hostname); } catch (_) { return false; } })() &&
      !/^(取消|清空已选)$/.test(decision.label || '');
    const feishuTrustedPointer = operation === 'CLICK' && isFeishu &&
      targetEntry?.clickMode === 'trusted-pointer';
    const feishuYearPicker = operation === 'TYPE_TEXT' && isFeishu &&
      targetEntry?.kind === 'feishu-year';
    const feishuRangePicker = operation === 'TYPE_TEXT' && isFeishu &&
      targetEntry?.kind === 'feishu-date-range';
    let execRes = beisenPopupChoice
      ? await clickBeisenPickerInPage(tabId,frameId,local,decision.label,decision.pickerLeaf)
      : feishuYearPicker
        ? await selectFeishuYearFromPicker(tabId, frameId, local, execMsg.value)
      : feishuRangePicker
        ? await selectFeishuRangeFromPicker(tabId, frameId, local, execMsg.value)
      : operation === 'TYPE_TEXT' && (isMoka || keepFeishuSearchOpen)
        ? await commitControlledText(tabId, frameId, local, execMsg.value,
          (isMoka && targetEntry?.kind === 'combobox') || keepFeishuSearchOpen)
        : operation === 'CLICK'
          ? await executePageClick(tabId, frameId, local, feishuTrustedPointer)
          : await sendToFrame(tabId, frameId, execMsg);
    if (beisenPopupChoice && !execRes?.ok && /找不到北森单选图标|目标不属于北森常量选择器/.test(execRes?.reason || '')) {
      execRes = await sendToFrame(tabId, frameId, execMsg);
    }
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
      consecutiveSkips += 1;
      if (consecutiveSkips >= 5) {
        if (await deferField(decision,'当前字段执行失败')) continue;
        return { ok: false, reason: "连续 5 次执行失败", step, history };
      }
      continue;
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
      resolvedValue: decision.resolvedValue || null,
      value: decision.value || null
      ,controlKind: clickedEl?.kind || null
      ,controlStableKey: decision.controlStableKey || clickedEl?.stableKey || null
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
        preview: snap.elements.slice(0, 120)
      });
    })();
    return true;
  }

  if (msg && msg.type === "START_FILL") {
    fillEvents = [];
    (async () => {
      try {
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

async function honorOverview(tabId, overviewUrl, isCurrentRun) {
  const current = await snapshotAllFrames(tabId);
  if (new URL(current.page.url || overviewUrl).pathname === HONOR_OVERVIEW_PATH &&
      current.elements.some(el=>el.kind==='section-entry')) return current;
  if (!isCurrentRun()) return null;
  await chrome.tabs.update(tabId, {url:overviewUrl});
  for (let attempt=0;attempt<8;attempt++) {
    await sleep(WAIT_MS_SECTION);
    if (!isCurrentRun()) return null;
    await ensureContentScript(tabId);
    const snap=await snapshotAllFrames(tabId);
    if (new URL(snap.page.url).pathname === HONOR_OVERVIEW_PATH &&
        snap.elements.some(el=>el.kind==='section-entry')) return snap;
  }
  return null;
}

async function waitForHonorAutosave(tabId, before, isCurrentRun, report) {
  for (let attempt=0;attempt<50;attempt++) {
    if (!isCurrentRun()) return false;
    const snap=await snapshotAllFrames(tabId);
    const after=savedAt(snap.page.text);
    if (after && after!==before) return true;
    if (attempt % 10===0) report({phase:'wait',action:'等待荣耀保存当前分区草稿'});
    await sleep(2000);
  }
  return false;
}

async function runHonorWholeResume({tabId,initial,overviewUrl,resume,apiKey,goal,report,isCurrentRun}) {
  const items=honorSections(resume,initial.elements);
  const sections=[];
  const pendingIssues=[];
  for (const item of items) {
    if (!isCurrentRun()) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
    if (!item.records.length) {
      if (item.name==='论文著作') pendingIssues.push({
        field:'论文著作',reason:'站点要求论文名称，简历尚未提供完整论文资料'
      });
      continue;
    }
    for (let recordIndex=0;recordIndex<item.records.length;recordIndex++) {
      const record=item.records[recordIndex];
      const snap=await honorOverview(tabId,overviewUrl,isCurrentRun);
      if (!snap) return {ok:false,reason:'无法回到荣耀简历总览',sections,pendingIssues};
      const entry=snap.elements.find(el=>el.kind==='section-entry' && el.label===item.name);
      if (!entry) return {ok:false,reason:`总览缺少「${item.name}」入口`,sections,pendingIssues};
      const identities=recordIdentity(record);
      const existing=identities.length ? await sendToFrame(tabId,0,{
        type:'MATCH_RECORD',section:item.name,identities,click:false
      }) : {ok:true,found:false,count:0};
      if (!existing?.ok || existing.count>1) return {
        ok:false,reason:`「${item.name}」现有记录无法唯一定位`,sections,pendingIssues
      };
      let opened;
      if (existing.found) {
        opened=await sendToFrame(tabId,0,{
          type:'MATCH_RECORD',section:item.name,identities,click:true
        });
        opened={ok:opened?.ok && opened.clicked};
      } else {
        const {frameId,local}=parseFrameTarget(entry.index);
        opened=await sendToFrame(tabId,frameId,{type:'EXECUTE',action:'click',index:local});
      }
      if (!opened?.ok) return {ok:false,reason:`未能打开「${item.name}」第 ${recordIndex+1} 条`,sections,pendingIssues};
      let form;
      for (let attempt=0;attempt<8;attempt++) {
        await sleep(WAIT_MS_SECTION);
        form=await snapshotAllFrames(tabId);
        if (form.page.title===item.name) break;
      }
      if (form?.page.title!==item.name) return {
        ok:false,reason:`打开「${item.name}」后未进入对应表单`,sections,pendingIssues
      };
      const before=savedAt(form.page.text);
      report({phase:'section',action:`填写「${item.name}」第 ${recordIndex+1}/${item.records.length} 条`});
      const result=await runAgent({goal,resume,apiKey,tabId,onProgress:report,isCurrentRun,
        initialRecordIndex:recordIndex,batchRecords:false});
      for (const issue of result.pendingIssues || []) pendingIssues.push(issue);
      if (result.cancelled) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
      const after=await snapshotAllFrames(tabId);
      const onOverview=new URL(after.page.url || overviewUrl).pathname===HONOR_OVERVIEW_PATH;
      let partialSaved=false;
      if (!onOverview && !result.sectionSaved) {
        const changed=result.history?.some(h=>['type_text','select','click'].includes(h.kind));
        partialSaved=changed ? await waitForHonorAutosave(tabId,before,isCurrentRun,report) : false;
        if (changed && !partialSaved) return {
          ok:false,reason:`「${item.name}」草稿尚未确认保存，已停留在当前表单`,
          sections,pendingIssues
        };
      }
      const overview=await honorOverview(tabId,overviewUrl,isCurrentRun);
      if (!overview) return {ok:false,reason:`无法回读「${item.name}」总览`,sections,pendingIssues};
      const verified=identities.length ? await sendToFrame(tabId,0,{
        type:'MATCH_RECORD',section:item.name,identities,click:false
      }) : null;
      const status=result.sectionSaved && (!identities.length || verified?.found) ?
        'saved' : partialSaved ? 'partial' : 'unverified';
      const itemResult={section:item.name,recordIndex,status,reason:result.reason || ''};
      sections.push(itemResult);
      report({phase:'section',action:`「${item.name}」第 ${recordIndex+1} 条：${status}`});
      if (status!=='saved') {
        const plan=buildActionPlan(after.elements,resume,result.history || [],{
          ...after.page,recordIndex
        });
        for (const field of plan.summary.unresolved || []) pendingIssues.push({
          field:`${item.name}#${recordIndex+1} ${field.label}`,reason:field.reason
        });
      }
    }
  }
  const incomplete=sections.some(item=>item.status!=='saved');
  return {ok:!incomplete && !pendingIssues.length,done:true,sections,pendingIssues,
    reason:incomplete || pendingIssues.length ? '已处理全部分区，仍有待补字段' : '全部分区已保存并回读'};
}

const ITER_SECTION_DATA = {
  '个人信息': resume => [{}],
  '求职意向': resume => [resume.expected || {}],
  '教育经历': resume => resume.education || [],
  '社会实习经历': resume => resume.internship || [],
  '项目经验': resume => resume.projects || [],
  '校内实践经历': resume => resume.campusPractice || [],
  '奖励': resume => resume.awards || [],
  '技能特长': resume => [
    ...(resume.englishLevels || []).map((item,index)=>({...item,_iterEditorIndex:0,_iterRecordIndex:index,_iterTitle:'英语等级'})),
    ...(resume.professionalSkills || []).map((item,index)=>({...item,_iterEditorIndex:1,_iterRecordIndex:index,_iterTitle:'IT技能'}))
  ],
  '自我评价': resume => [{}]
};

async function iterState(tabId) {
  const response=await sendToFrame(tabId,0,{type:'ITER_STATE'});
  return response?.ok ? response.state : null;
}

async function waitForIterState(tabId,predicate,isCurrentRun) {
  for (let attempt=0;attempt<8;attempt++) {
    if (!isCurrentRun()) return null;
    const state=await iterState(tabId);
    if (state && predicate(state)) return state;
    await sleep(WAIT_MS_SECTION);
  }
  return null;
}

async function closeIterEditor(tabId,isCurrentRun) {
  const close=await sendToFrame(tabId,0,{type:'ITER_DIALOG_BUTTON',label:'取消'});
  if (!close?.ok) return false;
  await sleep(WAIT_MS_OVERLAY);
  const confirm=await sendToFrame(tabId,0,{type:'ITER_DIALOG_BUTTON',label:'确定'});
  if (confirm?.ok) await sleep(WAIT_MS_OVERLAY);
  return !!(await waitForIterState(tabId,state=>!state.editorOpen,isCurrentRun));
}

async function runIterWholeResume({tabId,resume,apiKey,goal,report,isCurrentRun}) {
  const initial=await iterState(tabId);
  if (!initial?.sections?.length) return {ok:false,reason:'未识别到简历分区导航'};
  const start=Math.max(0,initial.sections.indexOf(initial.current));
  const sections=initial.sections.slice(start);
  const results=[],pendingIssues=[];
  for (const section of sections) {
    if (!isCurrentRun()) return {ok:false,cancelled:true,reason:'已停止填写',sections:results,pendingIssues};
    const navigated=await sendToFrame(tabId,0,{type:'ITER_NAVIGATE',section});
    if (!navigated?.ok || !await waitForIterState(tabId,state=>state.current===section && !state.editorOpen,isCurrentRun)) {
      return {ok:false,reason:`无法进入「${section}」分区`,sections:results,pendingIssues};
    }
    const records=ITER_SECTION_DATA[section]?.(resume) || [];
    if (!records.length) {
      report({phase:'section',action:`「${section}」暂无本地资料，检查下一个分区`});
      results.push({section,status:'no-data'});
      continue;
    }
    for (let recordIndex=0;recordIndex<records.length;recordIndex++) {
      const state=await iterState(tabId);
      const record=records[recordIndex];
      if (section==='奖励' && recordIndex>=6) {
        const reason='网站最多保存 6 条相关奖项；已按本地资料顺序保留前 6 条';
        pendingIssues.push({field:`${section}#${recordIndex+1}`,reason});
        results.push({section,recordIndex,status:'site-limit',reason});
        report({phase:'section',action:`「${section}」第 ${recordIndex+1} 条超过网站上限，继续检查下一项`});
        continue;
      }
      if (section==='求职意向' && !Object.values(record || {}).some(value=>String(value || '').trim())) {
        const reason='本地尚无期望工作性质、工作地点及期望薪酬资料';
        pendingIssues.push({field:section,reason});
        results.push({section,recordIndex,status:'data-gap',reason});
        report({phase:'section',action:`「${section}」${reason}，继续检查下一分区`});
        continue;
      }
      const identity=record?.institution || record?.company || record?.name || record?.title || record?.position ||
        (section==='自我评价' ? resume.basics?.summary : '') ||
        (record?._iterTitle==='英语等级' ? record.level : '');
      const startDate=record?.startDate?.replace(/^(\d{4}-\d{2})$/, '$1-01');
      const endDate=record?.endDate?.replace(/^(\d{4}-\d{2})$/, '$1-01');
      const overview=state?.overviewText || '';
      if (identity && overview.includes(identity) &&
          (!startDate || overview.includes(startDate)) && (!endDate || overview.includes(endDate))) {
        results.push({section,recordIndex,status:'already-saved'});
        report({phase:'section',action:`「${section}」第 ${recordIndex+1} 条已存在，继续下一条`});
        continue;
      }
      if (record?._iterTitle==='IT技能' && !['精通','熟练','良好','一般'].includes(record.level)) {
        const reason=`「${record.name}」的掌握程度为「${record.level || '未提供'}」，网站只接受精通、熟练、良好、一般`;
        pendingIssues.push({field:`技能特长#${recordIndex+1}`,reason});
        results.push({section,recordIndex,status:'data-gap',reason});
        report({phase:'section',action:`${reason}；继续检查下一项`});
        continue;
      }
      if (!state?.editorCount) {
        pendingIssues.push({field:section,reason:'当前分区没有编辑入口'});
        results.push({section,recordIndex,status:'no-editor'});
        break;
      }
      const editorIndex=record._iterEditorIndex ??
        (section==='奖励' && !/奖学金/.test(record?.title || '') ? 1 : 0);
      const opened=await sendToFrame(tabId,0,{type:'ITER_OPEN_EDITOR',editorIndex});
      if (!opened?.ok || !await waitForIterState(tabId,s=>s.editorOpen,isCurrentRun)) {
        return {ok:false,reason:`无法打开「${section}」编辑表单`,sections:results,pendingIssues};
      }
      let form;
      for (let attempt=0;attempt<8;attempt++) {
        form=await snapshotAllFrames(tabId);
        if (form.elements.some(el=>parseFrameTarget(el.index).frameId!==0)) break;
        await sleep(WAIT_MS_SECTION);
      }
      const firstField=form?.elements.find(el=>parseFrameTarget(el.index).frameId!==0);
      if (!firstField) return {ok:false,reason:`「${section}」弹窗内未发现可填写控件`,sections:results,pendingIssues};
      const dateGaps=[];
      for (const [key,hint] of [['startDate',/开始|入学/],['endDate',/结束|毕业/]]) {
        const value=records[recordIndex]?.[key];
        if (value && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value) &&
            form.elements.some(el=>el.kind==='layui-date' && hint.test(el.label || ''))) {
          dateGaps.push(`${key}=${value}`);
        }
      }
      if (section==='奖励' && form.elements.some(el=>el.kind==='layui-date' && /获奖时间/.test(el.label || '')) &&
          !/^\d{4}-\d{2}(?:-\d{2})?$/.test(record?.date || '')) {
        dateGaps.push(`date=${record?.date || '空'}`);
      }
      if (dateGaps.length) {
        if (!await closeIterEditor(tabId,isCurrentRun)) return {ok:false,reason:`「${section}」日期资料不足，无法返回总览`,sections:results,pendingIssues};
        const field=`${section}#${recordIndex+1}`;
        const reason=`网站要求完整年月日；本地资料为 ${dateGaps.join('、')}`;
        pendingIssues.push({field,reason});
        results.push({section,recordIndex,status:'data-gap',reason});
        report({phase:'section',action:`「${field}」待补准确日期，继续检查下一条`});
        continue;
      }
      const frameId=parseFrameTarget(firstField.index).frameId;
      report({phase:'section',action:`填写「${section}」第 ${recordIndex+1}/${records.length} 条`});
      const filled=await runAgent({goal,resume,apiKey,tabId,onProgress:report,isCurrentRun,
        initialRecordIndex:record._iterRecordIndex ?? recordIndex,batchRecords:false,
        targetFrameId:frameId,sectionTitle:record._iterTitle || section});
      if (filled.cancelled) return {ok:false,cancelled:true,reason:'已停止填写',sections:results,pendingIssues};
      const changed=filled.history?.some(item=>['type_text','select','pick_date','click'].includes(item.kind));
      if (!changed) {
        if (!await closeIterEditor(tabId,isCurrentRun)) return {ok:false,reason:`「${section}」无可填项，无法返回总览`,sections:results,pendingIssues};
        results.push({section,recordIndex,status:'no-match'});
        pendingIssues.push({field:`${section}#${recordIndex+1}`,reason:'页面字段与现有简历资料尚未匹配'});
        break;
      }
      const partial= !filled.done && /^当前页面没有可执行的已映射动作/.test(filled.reason || '');
      if (!filled.done && !partial) {
        return {ok:false,reason:`「${section}」已有未保存的填写内容：${filled.reason || '需要核验'}`,
          sections:results,pendingIssues};
      }
      const saved=await sendToFrame(tabId,0,{type:'ITER_DIALOG_BUTTON',label:'确定'});
      if (!saved?.ok || !await waitForIterState(tabId,state=>!state.editorOpen,isCurrentRun)) {
        const reason=`「${section}」第 ${recordIndex+1} 条内容已填入，但网站未确认保存`;
        if (!await closeIterEditor(tabId,isCurrentRun)) return {ok:false,reason:`${reason}；表单保留在页面上`,sections:results,pendingIssues};
        pendingIssues.push({field:`${section}#${recordIndex+1}`,reason:'网站未确认保存，原表单已关闭以继续检查其他分区'});
        results.push({section,recordIndex,status:'save-failed'});
        report({phase:'section',action:`${reason}，继续检查下一条`});
        continue;
      }
      if (partial) pendingIssues.push({field:`${section}#${recordIndex+1}`,reason:'已保存可填写内容，仍有缺少资料或未映射的字段'});
      results.push({section,recordIndex,status:partial?'partial':'saved'});
      report({phase:'section',action:`「${section}」第 ${recordIndex+1} 条已保存${partial?'（部分字段待补）':''}，继续下一条`});
    }
  }
  return {ok:pendingIssues.length===0,done:true,sections:results,pendingIssues,
    reason:pendingIssues.length ? '已检查全部分区，仍有待补资料或未匹配字段' : '全部可填写分区已处理'};
}

// 通用单页/卡片式 ATS 调度器。它先把页面收集为 section 清单，让 Jev 在有限的
// section 动作中选择；选中后才把该 section 的控件交给 runAgent。这样不同 section
// 的重复字段（例如多个“年”“学校名称”）永远不会出现在同一次字段决策里。
async function runSectionScheduler({tabId,resume,apiKey,goal,report,isCurrentRun}) {
  const ledger = {};
  const sections = [];
  const pendingIssues = [];
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
    for (const el of current.elements) {
      if (el.context === 'popup') continue;
      if (el.validationError) {
        addPendingIssue(`${el.section || '页面'} ${el.label || '未命名字段'}`,
          `网站校验未通过：${el.validationError}`);
        continue;
      }
      if (!el.required) continue;
      const value = String(el.value || '').trim();
      const empty = !value || /^(请选择|请填写|必填项未填写|上传|年|月)$/.test(value);
      if (!empty || el.checked === true) continue;
      const localPlan = buildActionPlan([el], resume, [], {
        ...current.page, title:el.section || '', allowAddRecords:false, scopedSection:true
      });
      if (localPlan.summary?.mappedControls > 0) {
        addPendingIssue(`${el.section || '页面'} ${el.label || '未命名必填项'}`, '网站必填字段尚未填写');
      }
    }
  };
  const finish = async (reason) => {
    await auditRequiredFields();
    return {ok:pendingIssues.length===0,done:true,sections,pendingIssues,reason};
  };
  let menuExits = 0;
  for (let turn = 1; turn <= 160; turn += 1) {
    if (!isCurrentRun()) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
    const snap = await snapshotAllFrames(tabId);
    const currentPageState = classifyPageState(snap.page, snap.elements);
    if (currentPageState.kind === 'auth-required' || currentPageState.kind === 'unsaved-confirmation') {
      addPendingIssue('页面状态',currentPageState.reason);
      return {ok:false,terminal:true,reason:currentPageState.reason,sections,pendingIssues};
    }
    const plan = buildSectionPlan(snap.elements, resume, ledger, snap.page);
    const activeTitle=snap.page.activeSection;
    const activeEditor=snap.elements.some(el=>el.section===activeTitle && el.context!=='popup' &&
      /^(保存|添加|取消)$/.test(String(el.label || '').replace(/\s/g,'')) && el.kind!=='card');
    if (activeTitle && !activeEditor && !snap.elements.some(el=>el.context==='popup') &&
        !plan.actions.some(action=>action.section===activeTitle)) {
      const sectionKey=`${activeTitle}|*`;
      ledger[sectionKey]={...ledger[sectionKey],focusBlocked:true};
      const source=resume[sectionCollection(activeTitle)];
      const remaining=Array.isArray(source) && source.some((_,i)=>!ledger[`${activeTitle}|${i}`]?.completed && !ledger[`${activeTitle}|${i}`]?.skipped);
      if (remaining) addPendingIssue(activeTitle,'已检查现有记录；页面未提供继续填写剩余资料的新增或编辑入口');
    }
    const meaningful = plan.actions.filter(action => !['EXIT_SECTION_MENU','STOP_FILL'].includes(action.operation));
    if (!meaningful.length && snap.elements.some(el=>el.context==='popup') && menuExits < 3) {
      menuExits += 1;
      await sendToFrame(tabId,0,{type:'CLOSE_TRANSACTIONS'});
      await sleep(WAIT_MS_SECTION);
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
    if (decision.operation === 'STOP_FILL') {
      return finish('Jev 已结束本次填写');
    }
    if (decision.operation === 'EXIT_SECTION_MENU') {
      menuExits += 1;
      if (menuExits < 2) {
        report({step:turn,phase:'section',action:'退出当前 section，重新扫描可填写清单'});
        await sleep(WAIT_MS_SECTION);
        continue;
      }
      return finish('已退出分区清单');
    }
    if (decision.operation === 'DEFER_SECTION') {
      await auditRequiredFields();
      const {frameId,local} = parseFrameTarget(decision.target);
      const targetEntry = snap.elements.find(element => String(element.index) === String(decision.target));
      const executed = await executePageClick(tabId,frameId,local,
        snap.page?.platform === 'feishu-jobs' && targetEntry?.clickMode === 'trusted-pointer');
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
        ledger[`${decision.section}|${decision.recordIndex}`]={...ledger[`${decision.section}|${decision.recordIndex}`],skipped:true};
        ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],workBlocked:false,editorPending:false};
      } else ledger[`${decision.section}|*`] = {...ledger[`${decision.section}|*`],deferred:true,editorPending:false};
      addPendingIssue(decision.deferRecord ? `${decision.section} 第 ${decision.recordIndex+1} 条` : decision.section,
        '本轮跳过；未保存的编辑内容需待资料补齐后重填');
      sections.push({section:decision.section,recordIndex:decision.recordIndex,status:'deferred',
        reason:decision.deferRecord ? '继续检查本分区其余记录' : '继续其他可填写分区'});
      menuExits = 0;
      report({step:turn,phase:'section',action:`已退出「${decision.section}」，记录待补并继续${decision.deferRecord?'检查其余记录':'其他分区'}`});
      continue;
    }
    if (decision.operation === 'FOCUS_SECTION' || decision.operation === 'ADD_RECORD') {
      const beforeControls = snap.elements.filter(el => el.section === decision.section && el.context !== 'popup');
      const beforeRendered = countRenderedRecords(decision.section, beforeControls);
      const {frameId,local} = parseFrameTarget(decision.target);
      const targetEntry = snap.elements.find(element => String(element.index) === String(decision.target));
      const executed = await executePageClick(tabId,frameId,local,
        snap.page?.platform === 'feishu-jobs' && targetEntry?.clickMode === 'trusted-pointer');
      if (!executed?.ok) {
        const current = await snapshotAllFrames(tabId);
        const currentControls = current.elements.filter(el => el.section === decision.section && el.context !== 'popup');
        const rendered = countRenderedRecords(decision.section, currentControls);
        const key = `${decision.section}|${rendered}`;
        ledger[key] = decision.operation === 'ADD_RECORD' ?
          {addBlocked:true,status:'新增入口执行失败'} : {focusBlocked:true,status:'入口执行失败'};
        addPendingIssue(decision.section || decision.label, executed?.reason || '无法执行分区入口');
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
          ledger[`${decision.section}|*`] = {focusBlocked:true,status:'进入分区后页面未变化'};
          addPendingIssue(decision.section, '点击分区入口后页面未变化');
        }
        if (decision.operation === 'ADD_RECORD') {
          const addition = classifyRecordAddition({section:decision.section,before:snap,after:current});
          if (!addition.verified) {
            const key = `${decision.section}|${beforeRendered}`;
            ledger[key] = {addBlocked:true,status:addition.reason};
            ledger[`${decision.section}|*`] = {addBlocked:true,status:addition.reason};
            addPendingIssue(decision.section, addition.reason);
            report({step:turn,phase:'section',action:`「${decision.section}」新增未获页面确认，已停止重复点击`});
          } else if (addition.mode === 'editor' || addition.mode === 'route') {
            const sectionKey=`${decision.section}|*`;
            ledger[sectionKey]={...ledger[sectionKey],editorPending:true,editorRecordIndex:decision.recordIndex || 0,
              recordMode:addition.mode,savedCount:Math.max(ledger[sectionKey]?.savedCount || 0,decision.recordIndex || 0)};
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
    const scopedControls = before.elements.filter(el => el.context === 'popup' || el.section === decision.section);
    const planBefore = buildActionPlan(scopedControls,resume,[],{...before.page,title:decision.section,allowAddRecords:false});
    const anchorCount = countRenderedRecords(decision.section, scopedControls);
    const key = decision.ledgerKey || `${decision.section}|${decision.recordIndex ?? anchorCount}`;
    report({step:turn,phase:'section',action:`专注填写「${decision.section}」；已隔离 ${scopedControls.length} 个控件`});
    const result = await runAgent({goal,resume,apiKey,tabId,onProgress:report,isCurrentRun,scopeSection:decision.section,
      initialRecordIndex:decision.recordIndex ?? 0,batchRecords:false});
    if (result.cancelled) return {ok:false,cancelled:true,reason:'已停止填写',sections,pendingIssues};
    // 局部事务结束后关闭选择器，下一分区只看到自己的控件和浮层。
    if (!result.ok) {
      await sendToFrame(tabId,0,{type:'CLOSE_TRANSACTIONS'});
      await sleep(WAIT_MS_OVERLAY);
    }
    const afterWork = await snapshotAllFrames(tabId);
    const savedRecord = result.sectionSaved && (() => {
      const collection = sectionCollection(decision.section);
      const records = decision.section === '实习/工作经历' ?
        [...(resume.internship || []), ...(resume.work || [])] : resume[collection] || [];
      const record = records[decision.recordIndex || 0];
      const identity = record?.institution || record?.company || record?.title || record?.name || record?.position || record?.language;
      return !!identity && String(afterWork.page.text || '').includes(identity);
    })();
    const inlineComplete = result.ok && result.done && !scopedControls.some(el =>
      /^(保存|添加)$/.test(String(el.label || '').replace(/\s/g,'')) && el.kind !== 'card' &&
      el.operations?.includes('CLICK'));
    if (savedRecord || inlineComplete) {
      const sectionKey = `${decision.section}|*`;
      ledger[sectionKey] = {...ledger[sectionKey],editorPending:false,savedCount:Math.max(ledger[sectionKey]?.savedCount || 0,
        (decision.recordIndex || 0) + 1)};
    }
    const savedSingleton = result.sectionSaved &&
      !Array.isArray(resume[sectionCollection(decision.section)]);
    const previousAttempts = ledger[key]?.workAttempts || 0;
    const noProgress = !result.ok && afterWork.fingerprint === before.fingerprint;
    const noAvailableAction = !result.ok &&
      /^当前页面没有可执行的已映射动作/.test(result.reason || '');
    const noLocalMapping = noAvailableAction && planBefore.summary?.mappedControls === 0 &&
      !(planBefore.summary?.unresolvedMapped || []).length;
    const status = noLocalMapping ? 'no-data' :
      result.ok && (inlineComplete || savedRecord || savedSingleton) ? 'verified' : 'blocked';
    if (status === 'verified') {
      const source=resume[sectionCollection(decision.section)];
      const total=decision.section==='实习/工作经历' ? (resume.internship?.length || 0)+(resume.work?.length || 0) : Array.isArray(source) ? source.length : 1;
      if ((decision.recordIndex || 0)+1>=total) {
        const sectionKey=`${decision.section}|*`;
        ledger[sectionKey]={...ledger[sectionKey],focusBlocked:true,workBlocked:true};
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
    ledger[key] = status === 'verified' ? {completed:true,status:'已回读'} : status === 'no-data' ?
      {completed:true,status:'无本地映射字段'} :
      {workAttempts:result.terminal || noProgress ? 3 : previousAttempts + 1,
        status:result.terminal ? '网站未确认上传' : noProgress ? '页面没有产生变化' : '待处理（等待复查）'};
    if (status === 'verified') {
      for (let i=pendingIssues.length-1;i>=0;i-=1) {
        if (pendingIssues[i].field === decision.section || pendingIssues[i].field.startsWith(`${decision.section} `)) {
          pendingIssues.splice(i,1);
        }
      }
    }
    if (decision.section === '上传') {
      const needsResume = scopedControls.some(el => el.context !== 'popup' && el.kind === 'file' && /上传简历|简历附件/.test(String(el.label || '')));
      const resumeFile = resume.basics?.resumeFile || resume.resumeFile || resume.attachment;
      if (needsResume && !resumeFile?.dataUrl) {
        addPendingIssue('上传 上传简历', '本地资料中缺少简历附件文件；头像已正常上传');
      }
    }
    sections.push({section:decision.section,recordIndex:decision.recordIndex ?? Math.max(0,anchorCount-1),status,reason:result.reason || ''});
    const exhausted = status === 'blocked' && (result.terminal || noProgress || noAvailableAction || previousAttempts + 1 >= 3);
    if (exhausted) {
      for (const issue of result.pendingIssues || []) {
        addPendingIssue(`${decision.section} ${issue.field || ''}`.trim(), issue.reason);
      }
      addPendingIssue(decision.section, result.reason || '当前分区未完成');
    }
    report({step:turn,phase:'section',action:`「${decision.section}」${status === 'verified' ? '已回读，返回分区清单' : status === 'no-data' ? '没有本地映射字段，继续其他分区' : '保留待处理，继续其他分区'}`});
    // 被 runAgent 填完后，网页可能多出记录或必填提示；每次都重新快照生成清单。
    if (!planBefore.actions.length && status === 'verified') ledger[key] = {completed:true,status:'无本地映射字段'};
  }
  await auditRequiredFields();
  return {ok:false,reason:'分区调度超过 80 轮，已停止避免循环',sections,pendingIssues};
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
  const url=new URL(first.page.url);
  const result=url.hostname==='career.honor.com' && url.pathname===HONOR_OVERVIEW_PATH ?
    await runHonorWholeResume({tabId:tab.id,initial:first,overviewUrl:first.page.url,resume,apiKey,
      goal,report,isCurrentRun}) :
    url.hostname==='iter.stongyw.cn' && url.pathname==='/web/school/resume/index.html' ?
    await runIterWholeResume({tabId:tab.id,resume,apiKey,goal,report,isCurrentRun}) :
    first.elements.some(el => el.section && el.context !== 'popup') ?
    await runSectionScheduler({tabId:tab.id,resume,apiKey,goal,report,isCurrentRun}) :
    await runAgent({goal,resume,apiKey,tabId:tab.id,
      onProgress:report,isCurrentRun});

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
