// Recruiting-platform DOM adapters.
// They translate platform-specific structure into the shared section/record model.
(function (root) {
  const clean = value => String(value || '')
    .replace(/\s*[*＊]\s*$/, '')
    .replace(/^请(?:填写|输入|选择)/, '')
    .replace(/\s+/g, '')
    .trim();

  const BEISEN_RECORDS = Object.freeze({
    教育经历: [
      /^(?:入学|开始)时间$/, /^(?:学校|学校名称|就读学校)$/
    ],
    教育背景: [
      /^(?:入学|开始)时间$/, /^(?:学校|学校名称|就读学校)$/
    ],
    实习经历: [
      /^(?:开始|入职)时间$/, /^(?:公司|公司名称|单位|单位名称|企业名称)$/
    ],
    工作经历: [
      /^(?:开始|入职)时间$/, /^(?:公司|公司名称|单位|单位名称|企业名称)$/
    ],
    项目经历: [
      /^(?:项目)?开始时间$/, /^项目名称$/, /^项目描述$/
    ],
    项目经验: [
      /^(?:项目)?开始时间$/, /^项目名称$/, /^项目描述$/
    ],
    语言能力: [
      /^(?:语言类型|语种|语言)$/
    ],
    英语能力: [
      /^(?:语言类型|语种|语言)$/
    ],
    获奖情况: [
      /^(?:获奖|获得)时间$/, /^(?:获奖项|获奖名称|奖项名称|奖励名称)$/
    ],
    获奖经历: [
      /^(?:获奖|获得)时间$/, /^(?:获奖项|获奖名称|奖项名称|奖励名称)$/
    ],
    家庭情况: [
      /^(?:姓名|家属姓名|家庭成员姓名)$/
    ],
    家庭关系: [
      /^(?:姓名|家属姓名|家庭成员姓名)$/
    ]
  });

  const FEISHU_RECORDS = Object.freeze({
    教育经历: [/^(?:学校|学校名称)$/, /^学历$/],
    工作经历: [/^(?:公司|公司名称)$/, /^(?:职位|职位名称)$/],
    实习经历: [/^(?:公司|公司名称)$/, /^(?:职位|职位名称)$/],
    项目经历: [/^项目名称$/],
    获奖情况: [/^(?:获奖名称|奖项名称)$/],
    语言能力: [/^(?:语言|语种)$/]
  });

  const isRecordControl = entry => entry.context !== 'popup' &&
    !['card', 'action', 'section-entry', 'option-item'].includes(entry.kind);

  function chooseAnchor(items, patterns) {
    const labels = items.map(({ entry }) => clean(entry.label || entry.placeholder));
    const observed = patterns.map(pattern => ({
      pattern,
      count:labels.filter(label => pattern.test(label)).length,
      first:labels.findIndex(label => pattern.test(label))
    })).filter(item => item.first >= 0);
    const repeated = observed.filter(item => item.count > 1);
    return (repeated.length ? repeated : observed).sort((a, b) => a.first - b.first)[0]?.pattern || null;
  }

  function annotateSequentialRecords(items, section, patterns) {
    const local = items.filter(({ entry }) => entry.section === section && isRecordControl(entry));
    if (!local.length) return;
    const anchor = chooseAnchor(local, patterns);
    if (!anchor) return;
    let recordIndex = -1;
    let lastAnchorElement = null;
    for (const item of local) {
      const label = clean(item.entry.label || item.entry.placeholder);
      if (anchor.test(label)) {
        // A single visual date control can expose both its wrapper and its input.
        // Treat nodes from the same immediate field container as one anchor.
        const field = item.stateEl?.closest?.('.form-item,.el-form-item,[class*="form-item"],label') || item.stateEl;
        if (!lastAnchorElement || field !== lastAnchorElement) recordIndex += 1;
        lastAnchorElement = field;
      }
      if (recordIndex >= 0) item.entry.recordIndex = recordIndex;
    }
  }

  function nearestBeisenFieldTitle(el) {
    let node = el;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const text = clean(sibling.textContent);
        if (text && text.length <= 30 && !/^\d+\/\d+$/.test(text) && !/^请(?:输入|选择|上传)/.test(text)) return text;
        sibling = sibling.previousElementSibling;
      }
      if ((node.parentElement?.querySelectorAll?.('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')?.length || 0) > 3) break;
    }
    return '';
  }

  function beisenFileContext(el) {
    let node = el;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const fileCount = node.querySelectorAll?.('input[type="file"]')?.length || 0;
      if (fileCount > 1) break;
      const text = clean(node.textContent);
      if (fileCount === 1 && /(?:简历附件|上传简历|个人简历|resume)/i.test(text)) return text;
    }
    return '';
  }

  function normalizeBeisenSections(items) {
    for (const { entry, stateEl } of items) {
      if (entry.context === 'popup') continue;
      const label = clean(entry.label || entry.placeholder);
      const nearbyTitle = nearestBeisenFieldTitle(stateEl);
      if (entry.kind === 'file') {
        const fileContext = beisenFileContext(stateEl);
        entry.section = /(?:简历附件|上传简历|个人简历|resume)/i.test(`${label} ${nearbyTitle} ${fileContext}`) ? '简历附件' : '附件';
      } else if (/^\d+\/\d+$/.test(label) && nearbyTitle) {
        entry.label = nearbyTitle;
      }
    }
  }

  function nearestFeishuFieldTitle(el) {
    let node = el;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        const text = clean(sibling.textContent);
        if (text && text.length <= 30 && !/^(?:请输入|请选择|YYYY|MM|-)/.test(text)) return text;
        sibling = sibling.previousElementSibling;
      }
      // 飞书已选中的 combobox 会在控件自身内部渲染一个 span（例如“英语”）。
      // 该 span 是当前值；从它的父级表单行读取同级标题，才能稳定得到“语言”。
      if (depth > 0) {
        const candidates = Array.from(node.children || [])
          .filter(child => !child.contains(el))
          .map(child => clean(child.textContent))
          .filter(text => text && text.length <= 30 && !/^(?:请输入|请选择|YYYY|MM|-)/.test(text));
        if (candidates.length === 1) return candidates[0];
      }
      const inputs = node.querySelectorAll?.('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')?.length || 0;
      if (inputs > 3) break;
    }
    return '';
  }

  function isFeishuCardSelectTitle(title) {
    return /^(?:语言|语种|精通程度|掌握程度|熟练程度|学历|学位|教育形式|受教育类型)$/.test(clean(title));
  }

  function hasNativeFeishuSelect(items, entry, title) {
    const target = clean(title);
    return items.some(({ entry: other }) => other !== entry && other.context !== 'popup' &&
      other.section === entry.section && other.kind !== 'card' &&
      ['custom-select', 'combobox', 'native-select'].includes(other.kind) &&
      clean(other.label || other.placeholder) === target);
  }

  function normalizeFeishuSections(items) {
    const sectionAliases = { '基本信息':'个人信息', '基础信息':'个人信息', '附件简历':'简历附件', '获奖':'获奖情况' };
    for (const { entry, stateEl } of items) {
      if (sectionAliases[entry.section]) entry.section = sectionAliases[entry.section];
      const label = clean(entry.label || entry.placeholder);
      // Structured Formily captions and range slots are resolved by the shared
      // observer; this adapter preserves that field identity through selection.
      const title = stateEl?.closest?.('.ud-formily-item') ? entry.label : nearestFeishuFieldTitle(stateEl);
      const wasCard = entry.kind === 'card';
      // 飞书的可见交互层常是一个无 ARIA 语义的卡片，实际页面依赖完整的
      // 浏览器层面的真实指针点击来打开下拉或新增一条记录。把执行方式保留在
      // 快照元数据中，调度层仍只看到统一的点击动作。
      if (wasCard) {
        entry.clickMode = 'trusted-pointer';
        // 保留视觉卡片原始文案。规范化会将“请选择”改写为“学历／语言”，
        // 但真实指针仍应命中原来的值槽。
        entry.clickLabel = label;
      }
      // 卡片自身已经带有“精通程度”等字段名时，优先使用它；向上的祖先可能
      // 只表示整段“语言能力”，不能覆盖该卡片的具体字段语义。
      const cardTitle = wasCard && isFeishuCardSelectTitle(label) ? label : title;
      if (/^(?:请输入|请选择)学校名称$/.test(label)) entry.label = '学校名称';
      if (/^(?:请输入|请选择)专业(?:名称)?$/.test(label)) entry.label = '专业';
      if (title && (/^(?:请输入|请选择|YYYY|MM|-|\(无标签\))/.test(label) || entry.kind === 'feishu-date-range')) {
        entry.label = title;
      }
      // 飞书已选中的下拉只回显值（例如“英语”“硕士”“深圳”），字段标题
      // 仍在同一表单行。恢复标题后，重复记录可以可靠计数，值也能与 JSON
      // 字段绑定；弹层候选保持自己的文字，不会受此规则影响。
      if (title && entry.context !== 'popup' && ['custom-select', 'combobox'].includes(entry.kind)) {
        entry.label = title;
      }
      // 飞书有时会同时渲染：一个只负责状态的 ARIA 下拉，和一个承载可见值的
      // 卡片。二者属于同一表单行。把卡片上的已选值回填到状态控件，页面已经
      // 显示“硕士／英语”时即可正确判定为已完成，不会重复打开该字段。
      if (wasCard && title && isFeishuCardSelectTitle(title) && label &&
          clean(label) !== clean(title) && !/^(?:添加|新增|增加)/.test(label)) {
        const paired = items.find(({ entry: other }) => other !== entry && other.context !== 'popup' &&
          other.section === entry.section && other.kind !== 'card' &&
          ['custom-select', 'combobox', 'native-select'].includes(other.kind) &&
          clean(other.label || other.placeholder) === clean(title));
        if (paired && !clean(paired.entry.value)) paired.entry.value = label;
      }
      // 部分飞书页面把实际 ARIA combobox 放在不可见层，只留下可点击的视觉卡片。
      // 这类卡片承担真实交互：恢复表单标题、保留已选值，并按统一选择器处理。
      if (wasCard && cardTitle && isFeishuCardSelectTitle(cardTitle) &&
          !/^(?:添加|新增|增加)/.test(label) && !hasNativeFeishuSelect(items, entry, cardTitle)) {
        const visibleValue = label;
        entry.role = 'combobox';
        entry.kind = 'custom-select';
        entry.label = cardTitle;
        entry.operations = ['CLICK'];
        if (visibleValue && clean(visibleValue) !== clean(cardTitle)) entry.value = visibleValue;
      }
      if (/招聘信息/.test(`${entry.label} ${label}`)) entry.section = '申请信息';
      if (entry.context === 'popup' && entry.kind === 'option-item' && /^(?:YYYY|MM|DD|[-/])$/.test(label)) {
        // 闭合日期范围控件会保留格式占位节点；它们不代表打开的选择事务。
        entry.context = 'decorative';
        entry.operations = [];
      }
      if (entry.kind === 'card' && /^(?:学校名称|请输入学校名称|学历|硕士|专业|起止时间|公司名称|职位名称|描述|英语|精通程度)(?:\s|$)/.test(label)) {
        // 飞书的可视容器会被通用卡片扫描重复收录。字段本体已经独立采集，
        // 这些视觉卡片不参与字段绑定或新增判断。
        entry.context = 'decorative';
        entry.operations = [];
      }
      if (/^添加$/.test(label) && entry.section) entry.label = `添加${entry.section}`;
    }
  }

  const beisen = Object.freeze({
    id: 'beisen',
    matches(hostname, doc) {
      return /(^|\.)zhiye\.com$/i.test(hostname) ||
        (!!doc?.querySelector?.('.form-item--phoenix,.constant-main-selector-container') &&
          !!doc?.querySelector?.('.phoenix-select,.phoenix-radio'));
    },
    annotateRecords(items) {
      normalizeBeisenSections(items);
      for (const [section, patterns] of Object.entries(BEISEN_RECORDS)) {
        annotateSequentialRecords(items, section, patterns);
      }
    },
    closeTransactions(doc) {
      const visible = node => {
        const rect = node?.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
      };
      const layers = Array.from(doc.querySelectorAll(
        '.el-picker-panel,.el-select-dropdown,.constant-main-selector-container,.area-selector-container'
      )).filter(visible);
      for (const layer of layers.reverse()) {
        const cancel = Array.from(layer.querySelectorAll('button,[role="button"]')).find(node =>
          /^(?:取消|关闭|close|cancel)$/i.test(clean(node.getAttribute('aria-label') || node.textContent)));
        if (cancel) cancel.click();
      }
      const init = { bubbles:true, cancelable:true, key:'Escape', code:'Escape', keyCode:27, which:27 };
      (doc.activeElement || doc).dispatchEvent(new KeyboardEvent('keydown', init));
      doc.dispatchEvent(new KeyboardEvent('keydown', init));
      doc.dispatchEvent(new KeyboardEvent('keyup', init));
      doc.activeElement?.blur?.();
      doc.body?.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,clientX:1,clientY:1}));
      doc.body?.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,clientX:1,clientY:1}));
      return layers.length;
    }
  });

  const feishu = Object.freeze({
    id: 'feishu-jobs',
    matches(hostname) {
      return /(^|\.)jobs\.feishu\.cn$/i.test(hostname);
    },
    annotateRecords(items) {
      normalizeFeishuSections(items);
      for (const [section, patterns] of Object.entries(FEISHU_RECORDS)) {
        annotateSequentialRecords(items, section, patterns);
      }
    },
    closeTransactions() { return 0; }
  });

  // Moka 的选择器由 React 组件接管：页面只会响应浏览器派发的真实指针事务。
  // 将执行要求标在控件快照上，调度层继续沿用统一的 CLICK / PICK_DATE 动作。
  const moka = Object.freeze({
    id: 'moka-form',
    matches(hostname, doc) {
      return /(^|\.)mokahr\.com$/i.test(hostname) ||
        !!doc?.querySelector?.('[class*="sd-Select-container-"]');
    },
    annotateRecords(items) {
      for (const { entry } of items) {
        const canClick = (entry.operations || []).includes('CLICK');
        if (!canClick && !['moka-date'].includes(entry.kind)) continue;
        // Moka 会将弹层选项渲染成 div、button 或带 role 的普通节点。
        // 依据弹层上下文统一标注，确保每一种选项都使用浏览器指针事务。
        const selectable = entry.context === 'popup' && canClick;
        const trigger = entry.context !== 'popup' &&
          ['custom-select', 'combobox', 'moka-date'].includes(entry.kind);
        // 触发器和选项都需要浏览器层面的真实点击。内容脚本会把弹层选项的
        // 点击点收窄到最内层文字节点，保证“硕士”、年份和月份命中当前项。
        if (selectable) entry.clickMode = 'trusted-pointer';
        else if (trigger) entry.clickMode = 'trusted-pointer';
      }
    },
    closeTransactions() { return 0; }
  });

  const drivers = [beisen, feishu, moka];
  function current(hostname, doc) {
    return drivers.find(driver => driver.matches(hostname, doc)) || null;
  }

  root.JevPlatformDrivers = Object.freeze({
    current,
    platformId(hostname, doc) { return current(hostname, doc)?.id || ''; },
    annotateRecords(items, hostname, doc) { current(hostname, doc)?.annotateRecords(items); },
    closeTransactions(doc, hostname) { return current(hostname, doc)?.closeTransactions(doc) || 0; }
  });
})(globalThis);
