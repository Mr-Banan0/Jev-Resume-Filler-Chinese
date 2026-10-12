// Stable widget-family layer shared by recruiting sites.
// Site-specific DOM signatures stop here; orchestration sees only families.
(function (root) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const FAMILY_BY_KIND = Object.freeze({
    file: 'file-upload', richtext: 'rich-text', 'custom-select': 'virtual-select',
    'layui-date': 'date-picker', 'native-select': 'native-select', checkbox: 'toggle',
    'moka-date': 'date-picker', 'beisen-date': 'date-picker', 'feishu-date-range': 'date-range',
    'custom-checkbox': 'toggle', radio: 'choice', 'custom-radio': 'choice',
    date: 'date-input', combobox: 'autocomplete', overlay: 'overlay-container',
    'option-item': 'overlay-option', 'picker-column': 'picker-column', action: 'action',
    card: 'section-entry', 'section-entry': 'section-entry', input: 'text-input'
  });

  function classify({ kind, role, tagName, editable }) {
    if (FAMILY_BY_KIND[kind]) return FAMILY_BY_KIND[kind];
    if (editable || role === 'textbox') return 'text-input';
    if (role === 'checkbox') return 'toggle';
    if (role === 'radio') return 'choice';
    if (role === 'option' || role === 'menuitem') return 'overlay-option';
    if (role === 'button' || role === 'link') return 'action';
    if (String(tagName || '').toLowerCase() === 'select') return 'native-select';
    return 'unknown';
  }

  function operations({ family, role, readonly, tagName, editable }) {
    if (family === 'file-upload') return ['UPLOAD_FILE'];
    if (family === 'overlay-container') return [];
    if (family === 'date-picker') return ['PICK_DATE'];
    if (family === 'date-range') return ['TYPE_TEXT'];
    if (family === 'virtual-select' || family === 'section-entry') return ['CLICK'];
    if (readonly && String(tagName || '').toLowerCase() !== 'select') return ['CLICK'];
    if (family === 'date-input') return ['TYPE_TEXT', 'CLICK'];
    if (family === 'autocomplete' && role === 'textbox') return ['TYPE_TEXT', 'CLICK'];
    if (family === 'text-input' || family === 'rich-text') return ['TYPE_TEXT'];
    if (family === 'native-select' || family === 'picker-column') return ['CLICK', 'SELECT'];
    if (['action', 'overlay-option', 'toggle', 'choice'].includes(family)) return ['CLICK'];
    return editable ? ['TYPE_TEXT'] : ['CLICK'];
  }

  function readValue(el, { family, hostname, tidy, editableText, isEditable, label }) {
    if (family === 'choice' && el.classList?.contains('cur')) return tidy(el.textContent || '');
    if (el.tagName === 'SELECT') return el.options?.[el.selectedIndex]?.text || '';
    // Moka 的下拉框使用可写 input 作为事件入口，但选中值渲染为该 input
    // 前方的展示节点。先读取展示值，避免把空 input 当成“尚未填写”，从而
    // 让后续的年、月或相邻字段抢走当前选择事务。
    if (/(^|\.)mokahr\.com$/i.test(hostname) && ['virtual-select', 'autocomplete'].includes(family)) {
      return readMokaSelectedValue(el, { tidy, label });
    }
    if (isEditable(el)) return editableText(el).slice(0, 200);
    if (['virtual-select','autocomplete'].includes(family) && el.closest?.('.ud__select')) {
      const host = el.closest('.ud__select');
      const content = host.querySelector('.ud__select__selector__content')?.cloneNode(true);
      content?.querySelectorAll('.ud__select__selector__placeholder,.ud__select__selector__search,input,button')
        .forEach(node=>node.remove());
      if (content) return tidy(content.textContent || '');
      // 自定义联想框用普通文本输入承载已确认学校，标准枚举选择器使用独立展示节点。
      if (el.matches?.('input,textarea')) return el.value || '';
    }
    if (['virtual-select','date-picker'].includes(family) && el.closest?.('.phoenix-select')) {
      const display = el.closest('.phoenix-select').cloneNode(true);
      display.querySelectorAll('.phoenix-select__calcEle,.phoenix-select__inputWrapper,input,.phoenix-select__switchArrow,.phoenix-select__clearIcon')
        .forEach(node=>node.remove());
      const leaves=[display,...display.querySelectorAll('*')].filter(node=>node.children.length===0);
      const text=[...new Set(leaves.map(node=>tidy(node.textContent || '')).filter(Boolean))].join(' ');
      const dates=[...new Set(text.match(/\d{4}-\d{2}(?:-\d{2})?/g) || [])];
      if (dates.length===1) return dates[0];
      return /^(?:请选择|请输入)?$/.test(text) || text === tidy(label) ? '' : text;
    }
    if (el.matches?.('input,textarea')) {
      if (el.value) return el.value;
      return '';
    }
    if (['virtual-select', 'autocomplete'].includes(family) || el.getAttribute?.('role') === 'combobox') {
      const text = tidy(el.innerText || el.textContent || '');
      if (text && normalize(text).replace(/\*/g,'') !== normalize(label).replace(/\*/g,'')) return text;
      return readAdjacentMokaDate(el, { family, hostname, tidy });
    }
    return el.value || '';
  }

  function readMokaSelectedValue(el, { tidy, label }) {
    const input = el.matches?.('input') ? el : el.querySelector?.('input');
    if (!input) return '';
    const placeholder = tidy(input.getAttribute?.('placeholder') || '');
    const clean = text => tidy(text || '')
      .replace(/必填项未填写/g, '')
      .replace(/[\ue000-\uf8ff]/g, '')
      .replace(/[×✕]/g, '')
      .trim();
    // 已选状态的展示文本是 input 的直接前置同级节点；从最近节点开始可避免
    // 误将同一表单项的标题或校验提示拼入值中。
    for (let node = input.previousElementSibling; node; node = node.previousElementSibling) {
      const value = clean(node.innerText || node.textContent || '');
      if (value && value !== placeholder && normalize(value) !== normalize(label)) return value;
    }
    const selectedDate = readAdjacentMokaDate(input, { family: 'virtual-select', hostname: 'mokahr.com', tidy });
    if (selectedDate) return selectedDate;
    if(input.value) return input.value;
    // 少数租户用同级节点的父容器承载展示值，保留为回退并剥离标题、占位和错误。
    for (let node = input.parentElement; node && node !== input.parentElement?.parentElement?.parentElement;
      node = node.parentElement) {
      if(node.querySelectorAll('input').length>1) break;
      let value = clean(node.innerText || node.textContent || '');
      value = value.replace(placeholder, '').replace(tidy(label || ''), '').trim();
      if (value && !/^(?:请选择|请输入)$/.test(value) && value.length <= 60) return value;
    }
    return '';
  }

  function readAdjacentMokaDate(el, { family, hostname, tidy }) {
    if (family !== 'virtual-select' || !/(^|\.)mokahr\.com$/i.test(hostname)) return '';
    const input = el.matches?.('input') ? el : el.querySelector?.('input[placeholder="年"],input[placeholder="月"]');
    const unit = input?.getAttribute('placeholder');
    if (!input) return '';
    if (unit !== '年' && unit !== '月') {
      for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
        if (node.querySelectorAll('input').length > 1) break;
        const direct = tidy(node.textContent || '');
        const numbers = direct.match(/\d+/g) || [];
        if (numbers.length === 1 && !/\p{L}/u.test(direct) &&
            /^\d{4}$|^(?:[1-9]|1[0-2])$/.test(numbers[0])) return numbers[0];
      }
      return '';
    }
    for (let node = input.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
      if (node.querySelectorAll('input').length > 1) break;
      const numbers = (tidy(node.textContent || '').match(/\d+/g) || []).filter(value =>
        unit === '年' ? /^\d{4}$/.test(value) : /^(?:[1-9]|1[0-2])$/.test(value));
      const unique = [...new Set(numbers)];
      if (unique.length === 1) return unique[0];
    }
    return '';
  }

  function stableKey(entry, occurrence) {
    if (entry.nodeKey) return entry.nodeKey;
    return [entry.section, entry.context, entry.widgetFamily, entry.role, normalize(entry.label), occurrence]
      .filter(value => value !== undefined && value !== '').join('|');
  }

  function freeformCommit(host) {
    const input=host?.querySelector?.('input');
    if(!input || input.disabled || input.readOnly) return null;
    for(let root=host,depth=0;root && depth<3;root=root.parentElement,depth++) {
      for(const className of root.classList || []) {
        const prefix=className.match(/^(.+-select)-combobox$/)?.[1];
        // rc-select 的显式 combobox 模式在输入变化时更新 value；标准搜索模式继续使用选项回执。
        // https://www.npmjs.com/package/rc-select （combobox / onChange）
        const contract=prefix && root.classList.contains(prefix) &&
          host.classList.contains(`${prefix}-selection`) && host.classList.contains(`${prefix}-selection--single`) &&
          input.classList.contains(`${prefix}-search__field`);
        if(!contract) continue;
        const marker=input.closest('[aria-invalid],.has-success,.has-error,.is-error');
        const accepted=marker?.getAttribute('aria-invalid')==='false' || marker?.classList.contains('has-success');
        if(accepted && !input.closest('[aria-invalid="true"],.has-error,.is-error')) {
          return {value:input.value || '',contract:'rc-select-freeform',evidence:'accepted-validation'};
        }
      }
    }
    return null;
  }

  function branchInfo(el) {
    const row=el?.closest?.('[role="treeitem"],[role="row"],[role="option"],tr,li') || el;
    if(!row) return {branch:false,target:null};
    const sameRow=node=>(node.closest('[role="treeitem"],[role="row"],[role="option"],tr,li') || row)===row;
    const indicator=Array.from(row.querySelectorAll(
      '[aria-haspopup="tree"],[aria-haspopup="menu"],[aria-label*="caret" i],[aria-label*="chevron" i],[data-icon*="caret" i],[data-icon*="chevron" i],[class*="youcejiantou"]'))
      .find(sameRow);
    let switcher=null;
    for(let node=indicator;node && node!==row;node=node.parentElement) {
      if(Array.from(node.classList || []).some(name=>/-switcher$/.test(name))) {switcher=node;break;}
    }
    const noop=Array.from(switcher?.classList || []).some(name=>/-switcher-noop$/.test(name));
    const leaf=Array.from(row.classList || []).some(name=>/-treenode-leaf$/.test(name));
    if(noop || leaf) return {branch:false,target:null,evidence:'explicit-leaf'};
    const expanded=row.getAttribute('aria-expanded');
    const explicit=expanded==='true' || expanded==='false' || indicator?.matches('[aria-haspopup="tree"],[aria-haspopup="menu"]');
    // rc-tree 的叶节点也可能渲染同一个箭头；可展开状态由组件契约提供。
    // https://github.com/react-component/tree/blob/master/src/TreeNode.tsx
    const switchable=Array.from(switcher?.classList || []).some(name=>/-switcher_(?:open|close)$/.test(name));
    const directional=indicator?.matches('[class*="youcejiantou"]');
    if(!explicit && !switchable && !directional) return {branch:false,target:null,evidence:'decorative-icon'};
    if(!indicator) return {branch:true,target:null,evidence:'expanded-state'};
    const button=indicator.closest('button,[role="button"]');
    const target=button && row.contains(button) && button!==row ? button :
      switcher && row.contains(switcher) ? switcher : indicator;
    return {branch:true,target,evidence:explicit ? 'expanded-state' : 'widget-switcher'};
  }

  function branchTarget(el) {
    return branchInfo(el).target;
  }

  function optionTarget(el, intent='select') {
    if(intent==='expand') return branchInfo(el).target;
    if(intent!=='select') return null;
    const row=el.closest('[role="treeitem"],[role="row"],[role="option"],tr,li') || el;
    const own=node=>(node.closest('[role="treeitem"],[role="row"],[role="option"],tr,li') || row)===row;
    const nodes=Array.from(row.querySelectorAll('[class*="-node-content-wrapper"],[class*="-title"]')).filter(own);
    // 同一树节点可以同时可选、可展开；选择命中本行值槽，展开命中本行开关。
    return nodes.find(node=>Array.from(node.classList).some(name=>/-node-content-wrapper(?:-(?:open|close|normal))?$/.test(name))) ||
      nodes.find(node=>Array.from(node.classList).some(name=>/-title$/.test(name))) || null;
  }

  function closeOpenTransactions(doc) {
    const init = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
    (doc.activeElement || doc).dispatchEvent(new KeyboardEvent('keydown', init));
    doc.dispatchEvent(new KeyboardEvent('keyup', init));
    doc.activeElement?.blur?.();
    for (const type of ['mousedown', 'mouseup', 'click']) {
      doc.body?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
    }
  }

  root.JevWidgetDrivers = Object.freeze({ classify, operations, readValue, stableKey, freeformCommit, branchInfo, branchTarget, optionTarget, closeOpenTransactions });
})(globalThis);
