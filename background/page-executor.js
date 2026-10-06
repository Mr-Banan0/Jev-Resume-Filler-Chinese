// 控件驱动负责输入与点击策略；调度器只提交一次当前字段事务。
export function createPageExecutor({sendToFrame, sleep}) {
const WAIT_MS_OVERLAY = 450;
// 部分招聘控件只响应浏览器派发的真实用户输入。内容脚本负责把已扫描的控件
// 转换成当前视口坐标，后台在当前标签页短暂附加 Chrome 调试通道发送一次
// 鼠标事务，并在事务结束后立即分离。该路径由快照中的 trusted-pointer 标记启用。
async function dispatchTrustedPointer(debuggee, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {ok:false,reason:'控件未返回有效点击坐标'};
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
  return {ok:true};
}

async function clickWithTrustedPointer(tabId, frameId, index) {
  if (frameId !== 0) return {ok:false,reason:'真实指针点击目前仅支持顶层表单'};
  const target = await sendToFrame(tabId, frameId, {type:'TRUSTED_CLICK_POINT',index});
  if (!target?.ok || target.clickMode !== 'trusted-pointer') {
    return target?.ok ? {ok:false,reason:'目标未声明真实指针点击策略'} : target;
  }
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
    return {ok:false,reason:'扩展尚未启用 Chrome debugger 权限，无法执行真实点击'};
  }
  const debuggee = {tabId};
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const currentTarget=await sendToFrame(tabId,frameId,{type:'TRUSTED_CLICK_POINT',index});
    if (!currentTarget?.ok) return currentTarget;
    const clicked = await dispatchTrustedPointer(debuggee, currentTarget.point);
    return clicked.ok ? {ok:true,action:'click',bridge:'trusted-pointer',label:target.label} : clicked;
  } catch (err) {
    return {ok:false,reason:`真实点击未执行：${err.message}`};
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function executePageClick(tabId, frameId, index, trustedPointer = false) {
  if (trustedPointer) return clickWithTrustedPointer(tabId, frameId, index);
  return sendToFrame(tabId, frameId, {type:'EXECUTE',action:'click',index});
}

async function closePageTransactions(tabId,frameId) {
  const closed=await sendToFrame(tabId,frameId,{type:'CLOSE_TRANSACTIONS'});
  if (closed?.ok || frameId!==0 || !chrome.debugger?.attach) return closed;
  const debuggee={tabId};
  let attached=false;
  try {
    await chrome.debugger.attach(debuggee,'1.3');
    attached=true;
    const escape={key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27};
    await chrome.debugger.sendCommand(debuggee,'Input.dispatchKeyEvent',{type:'keyDown',...escape});
    await chrome.debugger.sendCommand(debuggee,'Input.dispatchKeyEvent',{type:'keyUp',...escape});
    await sleep(100);
    let state=await sendToFrame(tabId,frameId,{type:'TRANSACTION_STATE'});
    if (state?.ok && !state.open) return {ok:true};
    const outside=await sendToFrame(tabId,frameId,{type:'TRANSACTION_OUTSIDE_POINT'});
    if (outside?.ok) {
      await dispatchTrustedPointer(debuggee,outside.point);
      await sleep(100);
      state=await sendToFrame(tabId,frameId,{type:'TRANSACTION_STATE'});
      if (state?.ok && !state.open) return {ok:true};
    }
    const point=await sendToFrame(tabId,frameId,{type:'TRANSACTION_EXIT_POINT'});
    if (!point?.ok) return point;
    await dispatchTrustedPointer(debuggee,point.point);
    await sleep(100);
    state=await sendToFrame(tabId,frameId,{type:'TRANSACTION_STATE'});
    return {ok:state?.ok && !state.open,reason:state?.open ? '选择器关闭后仍未回读' : undefined};
  } catch (err) { return {ok:false,reason:`选择器关闭失败：${err.message}`}; }
  finally { if(attached) await chrome.debugger.detach(debuggee).catch(()=>{}); }
}

async function pickDateWithTrustedPointer(tabId, frameId, index, value) {
  if (frameId !== 0) return {ok:false,reason:'Moka 日期选择器目前仅支持顶层表单'};
  const opener = await sendToFrame(tabId, frameId, {type:'TRUSTED_CLICK_POINT',index});
  if (!opener?.ok || opener.clickMode !== 'trusted-pointer') {
    return opener?.ok ? {ok:false,reason:'目标未声明 Moka 真实日期选择策略'} : opener;
  }
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
    return {ok:false,reason:'扩展尚未启用 Chrome debugger 权限，无法执行真实日期点击'};
  }
  const debuggee = {tabId};
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    const opened = await dispatchTrustedPointer(debuggee, opener.point);
    if (!opened.ok) return opened;
    for (let step = 0; step < 18; step += 1) {
      await sleep(WAIT_MS_OVERLAY);
      const next = await sendToFrame(tabId, frameId, {type:'MOKA_DATE_NEXT_POINT',index,value});
      if (!next?.ok) return next || {ok:false,reason:'Moka 日期面板未返回下一步'};
      if (next.done) return {ok:true,action:'pick_date',value:next.value,verified:true,bridge:'trusted-pointer'};
      const clicked = await dispatchTrustedPointer(debuggee, next.point);
      if (!clicked.ok) return clicked;
    }
    return {ok:false,reason:'Moka 日期选择超过最大步骤'};
  } catch (err) {
    return {ok:false,reason:`Moka 日期真实点击未执行：${err.message}`};
  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
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

// 受控文本通过页面 MAIN world 提交，使展示值、框架状态与校验保持一致。
async function commitControlledText(tabId, frameId, index, value, keepFocus = false, manualCallbacks = true) {
  const marked = await sendToFrame(tabId, frameId, {type:'MARK_TARGET', index});
  if (!marked?.ok || !marked.token) return marked || {ok:false,reason:'无法标记目标输入框'};
  try {
    const results = await chrome.scripting.executeScript({
      target:{tabId,frameIds:[frameId]},
      world:'MAIN',
      args:[marked.token,String(value),keepFocus,manualCallbacks],
      func:async (token,nextValue,keepEditorOpen,invokeManualCallbacks) => {
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

          // 通过当前节点的受控回调提交真实 DOM 值。
          let propsKey='';
          let props=null;
          const directCallbacks=invokeManualCallbacks==='direct';
          const callbackDepth=directCallbacks ? 1 : 5;
          for (let node=el,depth=0; invokeManualCallbacks && node && depth<callbackDepth && !props; node=node.parentElement,depth+=1) {
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
                for (let level=0; fiber && level<callbackDepth; fiber=fiber.return,level+=1) {
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
          // 当前节点保存的 React 回调是表单状态的提交入口。
          const alreadyCommitted=directCallbacks && Object.hasOwn(props || {},'value') &&
            String(props.value ?? '')===String(el.value || '');
          if (!alreadyCommitted && typeof props?.onChange === 'function') props.onChange(synthetic);
          if (!alreadyCommitted && typeof props?.onInput === 'function') props.onInput({...synthetic,type:'input'});
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
          const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
          const numericControl=el.type==='number' || el.inputMode==='decimal';
          const verified=actual===nextValue || numericControl && decimal.test(actual) && decimal.test(nextValue) &&
            Number.isFinite(Number(actual)) && Number(actual)===Number(nextValue);
          return {ok:verified,action:'type_text',value:actual,verified,
            bridge:inserted ? 'exec-command' : propsKey ? 'react-props' : 'native-events',
            reason:verified ? undefined : `页面主环境回读不一致：${actual || '空白'}`};
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

  return {executePageClick,closePageTransactions,executeField};

  async function executeField({tabId,frameId,local,decision,targetEntry,page,execMsg}) {
    const {operation,resumeField} = decision;
    const platform = page?.platform;
    const moka = platform === 'moka-form';
    const feishu = platform === 'feishu-jobs';
    const keepSearchOpen = feishu && operation === 'TYPE_TEXT' &&
      /^education\[\d+\]\.(institution|area)$/.test(resumeField || '') &&
      /学校|专业|请输入/.test(`${decision.label || ''} ${targetEntry?.label || ''}`);
    const beisenChoice = operation === 'CLICK' && decision.context === 'popup' &&
      targetEntry?.clickMode !== 'trusted-pointer' && platform === 'beisen' &&
      !/^(取消|清空已选)$/.test(decision.label || '');
    let result;
    if (beisenChoice) result = await clickBeisenPickerInPage(tabId,frameId,local,decision.label,decision.pickerLeaf);
    else if (operation === 'CLICK' && decision.context === 'popup' && moka) result = await clickWithTrustedPointer(tabId,frameId,local);
    else if (operation === 'TYPE_TEXT' && targetEntry?.kind === 'feishu-year') result = await selectFeishuYearFromPicker(tabId,frameId,local,execMsg.value);
    else if (operation === 'TYPE_TEXT' && targetEntry?.kind === 'feishu-date-range') result = await selectFeishuRangeFromPicker(tabId,frameId,local,execMsg.value);
    else if (operation === 'PICK_DATE' && targetEntry?.clickMode === 'trusted-pointer') result = await pickDateWithTrustedPointer(tabId,frameId,local,execMsg.value);
    else if (operation === 'TYPE_TEXT' && (targetEntry?.textCommitMode === 'page-world' || moka || keepSearchOpen)) result = await commitControlledText(tabId,frameId,local,execMsg.value,
      (moka && targetEntry?.kind === 'combobox') || keepSearchOpen,targetEntry?.textCommitMode === 'page-world' ? 'direct' : true);
    else if (operation === 'CLICK') result = await executePageClick(tabId,frameId,local,targetEntry?.clickMode === 'trusted-pointer');
    else result = await sendToFrame(tabId,frameId,execMsg);
    if (beisenChoice && !result?.ok && /找不到北森单选图标|目标不属于北森常量选择器/.test(result?.reason || '')) result = await sendToFrame(tabId,frameId,execMsg);
    return result;
  }
}
