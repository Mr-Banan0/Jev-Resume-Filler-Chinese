// content/content.js — 阶段3：DOM 快照 + 执行 click/type/select
// 维护一个 elementRegistry 把 Jev 的 index 映射回真实 DOM 节点

(function () {
  // Popup 在扩展重载后用此版本识别遗留页面中的旧 content script，并主动替换。
  const CONTENT_SCRIPT_VERSION = '2026-10-05.37';
  const previousContentVersion = globalThis.__jevResumeFillerContentVersion;
  if (previousContentVersion && previousContentVersion !== CONTENT_SCRIPT_VERSION) {
    // Chrome 重载扩展时会保留页面隔离世界。释放旧实例的注册标记，让新代码
    // 重新安装监听器；旧监听器通过下方版本校验自动静默。
    window.__jevResumeFillerInjected = false;
  }
  globalThis.__jevResumeFillerContentVersion = CONTENT_SCRIPT_VERSION;
  const TAG = "[Jev Resume Filler content]";

  // manifest 声明式注入 + scripting.executeScript 兜底注入可能同时发生，
  // 用页面级标记保证监听器只注册一次。
  if (window.__jevResumeFillerInjected) {
    console.log(`${TAG} 已存在，跳过重复注入`, location.href);
    return;
  }
  window.__jevResumeFillerInjected = true;
  console.log(`${TAG} 已注入`, location.href);

  const widgetDrivers = globalThis.JevWidgetDrivers || {
    classify: ({ kind }) => kind,
    operations: null,
    readValue: null,
    stableKey: (entry, occurrence) => entry.nodeKey || [entry.section, entry.context, entry.kind, entry.role, entry.label, occurrence].filter(Boolean).join('|'),
    closeOpenTransactions: null
  };
  const platformDrivers = globalThis.JevPlatformDrivers || {
    platformId: () => '',
    annotateRecords: () => {},
    closeTransactions: () => 0
  };

  // 全局索引 → 元素映射（每次快照重建）
  // elementRegistry 存"被点击的节点"，elementStateRegistry 存"读状态的节点"；
  // 代理场景（隐藏 checkbox + 可见 label）下二者不同。
  let elementRegistry = [];
  let elementStateRegistry = [];
  // 快照记录少量执行策略，例如飞书可视卡片需要完整指针序列。该元数据只在
  // 当前快照到下一次执行之间有效，页面重扫后会随注册表一起刷新。
  let elementMetaRegistry = [];
  const observedMonthControls = new WeakSet();
  let transactionTrigger = null;
  let activeLayer = null;
  let sectionMarkers = [];
  const documentId = globalThis.crypto?.randomUUID?.() || `doc-${Date.now()}-${Math.random()}`;
  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  let selectedSection = '';
  const nodeId = node => {
    if (!node) return '';
    if (!nodeIds.has(node)) nodeIds.set(node,`${documentId}:n${++nextNodeId}`);
    return nodeIds.get(node);
  };

  const FORM_SECTION_TITLES = new Set([
    '申请信息', '上传', '个人信息', '教育背景', '教育经历', '实习经历', '工作经历',
    '项目经验', '项目经历', '实习/工作经历', '语言能力', '获奖经历', '自我描述', '其他', '信息确认', '更新说明',
    '求职意向', '家庭情况', '投递意向', '校园活动经历', '校内实践经历', '奖励荣誉',
    '专业技能', '其他信息', '开放性问题', '附件', '简历附件', '陈述情况',
    '个人基本信息', '奖励活动', '社会实践经历', '所获证书', '附加信息', '家庭关系', '获奖情况',
    '英语能力', '其他外语能力', '计算机技能', '证书', '校内职务', '培训经历',
    '个人专利', '发明专利', '专利', '论文著作', '论文', '发表论文',
    '其他家庭成员关系', '自我评价', '个人承诺', '基本信息', '基础信息', '附件简历', '获奖', '作品', '社交账号',
    '论文/专著', '附加问题', '公司及应聘者声明', '候选人声明', '社会实习经历', '奖励', '技能特长'
  ]);

  // 同一控件族会部署在企业自有域名；以渲染后的表单结构识别，域名仅作早期兜底。
  function isMokaFormPage() {
    return /(^|\.)mokahr\.com$|^careers\.ey\.com\.cn$/i.test(location.hostname) ||
      !!document.querySelector('[class*="sd-Select-container-"]');
  }

  function isFeishuJobsPage() {
    return /(^|\.)jobs\.feishu\.cn$/i.test(location.hostname);
  }

  function isBeisenFormPage() {
    return platformDrivers.platformId(location.hostname, document) === 'beisen';
  }

  function feishuDateRangeContainer(el) {
    if (!isFeishuJobsPage() || !el?.matches?.('input')) return false;
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
      const inputs = node.querySelectorAll('input:not([type="hidden"])').length;
      if (node.querySelectorAll('.atsx-date-picker-period-month-label').length === 2 && inputs <= 2) return node;
      const text = String(node.innerText || node.textContent || '');
      // 飞书在教育和实习记录中使用了两种包裹层：教育字段把“起止时间”
      // 放在范围输入的直接祖先，实习字段则把它放在外层记录容器。年月占位
      // 是两者共有的稳定结构；以它和最多两个真实输入框定位当前日期字段。
      if (inputs <= 2 && (/起止时间/.test(text) || /YYYY\s*-\s*MM/.test(text))) return node;
      if (inputs > 6) break;
    }
    return null;
  }

  function feishuComboboxHost(el) {
    if (!isFeishuJobsPage() || !el?.matches?.('input,textarea')) return null;
    const host = el.closest?.('[role="combobox"]');
    return host && host !== el ? host : null;
  }

  function isFeishuDateRange(el) {
    return !!feishuDateRangeContainer(el);
  }

  function feishuDateRangeLabel(el) {
    const container = feishuDateRangeContainer(el);
    const text = tidyLabel(container?.innerText || container?.textContent || '');
    return /起止时间/.test(text) ? '起止时间' : nearestFieldCaption(el) || '起止时间';
  }

  function feishuDateRangeParts(el) {
    const container = feishuDateRangeContainer(el);
    const labels = Array.from(container?.querySelectorAll('.atsx-date-picker-period-month-label') || []);
    if (labels.length !== 2) return null;
    const values = labels.map(label => tidyLabel(label.textContent || ''));
    return {container, labels, values};
  }

  function currentFeishuDateRangeElement(index) {
    const previous = elementRegistry[parseInt(index, 10) - 1];
    if (!previous) return null;
    if (previous.isConnected && feishuDateRangeParts(previous)) return previous;
    // 飞书选中年份或月份后可能重建整个字段；沿快照中的 data-cy 定位新节点。
    const key = previous.closest?.('[data-cy]')?.getAttribute('data-cy');
    const current = key && Array.from(document.querySelectorAll('[data-cy]'))
      .find(node => node.getAttribute('data-cy') === key)
      ?.querySelector('input.atsx-date-picker-period-hidden-input');
    return current && feishuDateRangeParts(current) ? current : null;
  }

  function feishuDateRangeDisplay(el) {
    const parts = feishuDateRangeParts(el);
    if (!parts) return '';
    return parts.values.every(value => value === 'YYYY-MM') ? '' : parts.values.join(' - ');
  }

  function isFieldCaption(text) {
    const value = tidyLabel(text);
    return !!value && value.length <= 80 && !FORM_SECTION_TITLES.has(value) &&
      !/^(?:必填项未填写|请选择|上传|上传中|添加|删除|请输入|暂无选项|错误|格式错误)(?:[：:].*)?$/.test(value) &&
      !/^(?:如果您|如有多个|如大学|如中国|支持文档|（附免冠照片）)/.test(value) &&
      !/^(?:\d{4}年?|\d{1,2}月?|\d+\s*\/\s*\d+)$/.test(value);
  }

  function nearestFieldCaption(el) {
    let node = el;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const controls = node.querySelectorAll?.('input,select,textarea,[contenteditable="true"]')?.length || 0;
      if (controls > 4) break;
      for (const child of Array.from(node.children || [])) {
        if (child === el || child.contains?.(el) || child.querySelector?.('input,select,textarea')) continue;
        const value = tidyLabel(child.innerText || child.textContent || '');
        if (isFieldCaption(value)) return value.replace(/\s*\*\s*$/, '').trim();
      }
    }
    return '';
  }

  function structuredFieldCaption(el) {
    const formilyRow = el.closest('.ud-formily-item');
    if (formilyRow) {
      const caption = Array.from(formilyRow.querySelectorAll('.ud-formily-item-label')).find(node =>
        node.closest('.ud-formily-item') === formilyRow);
      const text = tidyLabel(caption?.textContent || '').replace(/\s*[*＊]\s*$/, '').trim();
      if (text) {
        const inputs = Array.from(formilyRow.querySelectorAll('input')).filter(input =>
          input.closest('.ud-formily-item') === formilyRow &&
          input.closest('.ud__picker,.throne-biz-date-range-picker-input'));
        const slot = inputs.indexOf(el);
        return inputs.length === 2 && slot >= 0 ? `${text} · ${slot === 0 ? '开始时间' : '结束时间'}` : text;
      }
    }
    const row = el.closest('.form-item');
    if (!row || (row.querySelectorAll('input,select,textarea').length || 0) > 2) return '';
    for (const child of Array.from(row.children)) {
      if (child.contains(el) || child.querySelector('input,select,textarea')) continue;
      const caption = tidyLabel(child.innerText || child.textContent || '');
      if (isFieldCaption(caption) || FORM_SECTION_TITLES.has(caption)) return caption.replace(/\s*\*\s*$/, '').trim();
    }
    return '';
  }

  function fileFieldLabel(el) {
    const structured=structuredFieldCaption(el);
    if (structured) return structured;
    const explicit = labelFor(el)?.textContent || el.closest('label')?.textContent || '';
    if (isFieldCaption(explicit)) return tidyLabel(explicit);
    let node = el.parentElement;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const files = node.querySelectorAll?.('input[type="file"]')?.length || 0;
      if (files > 1) break;
      const preceding = precedingText(node);
      if (isFieldCaption(preceding)) return preceding;
      for (const child of Array.from(node.children || [])) {
        if (child === el || child.contains?.(el) || child.querySelector?.('input[type="file"]')) continue;
        const value = tidyLabel(child.innerText || child.textContent || '');
        if (isFieldCaption(value)) return value;
      }
    }
    return nearestFieldCaption(el) || '上传文件';
  }

  function fileUploadArea(el) {
    const row = el.closest('.ud-formily-item,.form-item,.el-form-item,.ant-form-item');
    if (row && row.querySelectorAll('input[type="file"]').length === 1) return row;
    return el.closest('[class*="upload" i]')?.parentElement || el.parentElement;
  }

  function fileUploadPending(el) {
    if (/上传中|uploading|正在上传|正在解析/i.test(fileUploadArea(el)?.textContent || '')) return true;
    return Array.from(document.querySelectorAll('[role="dialog"],[class*="modal" i],[class*="message" i]'))
      .some(node => isVisible(node) && /上传中|uploading|正在上传|正在解析/i.test(node.textContent || ''));
  }

  function isOptionalResumeParser(el) {
    let node=el.parentElement;
    for (let depth=0; node && depth<7; depth++,node=node.parentElement) {
      if (node.querySelectorAll('input[type="file"]').length>1) break;
      if (/解析/.test(node.textContent || '') && /简历/.test(node.textContent || '')) {
        return Array.from(document.querySelectorAll('input[type="file"]')).some(peer=>
          peer!==el && /简历附件/.test(fileFieldLabel(peer)));
      }
    }
    return false;
  }

  function fileFieldValue(el) {
    if (fileUploadPending(el)) return '';
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if ((node.querySelectorAll?.('input[type="file"]')?.length || 0) > 1) break;
      const text = String(node.innerText || node.textContent || '');
      if (/上传中|uploading/i.test(text)) return '';
      const match = text.match(/[\w\u4e00-\u9fff()（）.-]+\.(?:pdf|docx?|pptx?|wps|jpe?g|png|txt)\b/i);
      if (match) return match[0];
    }
    if (fileUploadArea(el)?.querySelector('.uploader-img img[src],[class*="upload" i] img[src]')) return '已上传照片';
    const asynchronous = !!el.closest('.ud-formily-item,[class*="upload" i]') || isMokaFormPage();
    return asynchronous ? '' : el.files?.[0]?.name || '';
  }

  function buildSectionMarkers() {
    const isFieldChoice = el => !!el.closest('select,option,[role="option"],[role="listbox"],[role="menu"],.el-select,.el-select-dropdown,.ant-select,.ant-select-dropdown,.ant-cascader-menus');
    const known = Array.from(document.querySelectorAll('body *')).filter(el => {
      if (!isVisible(el) || isFieldChoice(el)) return false;
      const fieldContainer = el.closest('.form-item,.el-form-item,.ant-form-item,[class*="field" i]');
      if (fieldContainer?.querySelector('input:not([type="hidden"]),textarea,select,[role="combobox"]')) return false;
      const text = tidyLabel(el.textContent || '');
      if (!FORM_SECTION_TITLES.has(text)) return false;
      return !Array.from(el.children).some(child => tidyLabel(child.textContent || '') === text);
    });
    // 已知标题与动态标题一起采集；同一页面常混合通用分区和 ATS 自定义分区。
    const dynamic = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[role="heading"],[class*="title" i],[class*="header" i]')).filter(el => {
      if (!isVisible(el) || isFieldChoice(el)) return false;
      const fieldContainer = el.closest('.form-item,.el-form-item,.ant-form-item,[class*="field" i]');
      if (fieldContainer?.querySelector('input:not([type="hidden"]),textarea,select,[role="combobox"]')) return false;
      const text = tidyLabel(el.textContent || '');
      if (text.length < 2 || text.length > 14) return false;
      if (/^(?:\+?\s*)?(?:新增|添加|增加|编辑|删除)/.test(text)) return false;
      if (!/(信息|经历|背景|经验|能力|技能|证书|奖项|成果|项目|实践|作品|上传|确认|意向|声明|教育|工作|实习|培训|语言|资格|家庭|校园|开放|附件|专利|论文|著作)/.test(text)) return false;
      return !Array.from(el.children).some(child => tidyLabel(child.textContent || '') === text);
    });
    sectionMarkers = [...new Set([...known, ...dynamic])]
      .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .map(el => {
        const raw = tidyLabel(el.textContent || '');
        const title = raw.replace(/\s*必填\s*$/, '').trim();
        return { el, title: FORM_SECTION_TITLES.has(title) ? title : raw };
      });
  }

  function sectionForElement(el) {
    const editor=el.closest?.('[role="dialog"],.el-dialog,.ant-modal,[class*="drawer"]');
    if (editor && isRecordEditorSurface(editor) && selectedSection) return selectedSection;
    const nav = el.closest?.('nav,aside,[role="navigation"]');
    const navTitle = tidyLabel(el.textContent || '');
    if (nav && FORM_SECTION_TITLES.has(navTitle)) return navTitle;
    const summaryCard = el.closest?.('.resumeContent');
    if (summaryCard) return selectedSection || [...FORM_SECTION_TITLES].find(title=>
      tidyLabel(summaryCard.textContent || '').startsWith(title)) || '';
    if (el.closest?.('.layui-layer-btn')) return activeSectionTitle();
    const formilyModule = el.closest?.('[class*="applyFormModuleWrapper__"]');
    const formilyTitle = formilyModule?.querySelector('.applyFormModuleWrapper-left');
    if (formilyTitle) return tidyLabel(formilyTitle.textContent).replace(/\s*必填\s*$/, '').trim();
    const module = el.closest?.('.apply-module__body');
    const moduleTitle = module?.querySelector('.form-content--title-box h6,.form-content--title-box h2');
    if (moduleTitle) return tidyLabel(moduleTitle.textContent).replace(/\s*必填\s*$/, '').trim();
    let found = '';
    for (const marker of sectionMarkers) {
      const relation = marker.el.compareDocumentPosition(el);
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING || marker.el.contains(el)) found = marker.title;
      else if (found) break;
    }
    return found;
  }

  // 新增入口的文字本身常携带分区名称，例如“新增发明专利”。这类页面把多个
  // 空分区并排渲染时，入口自身是最稳定的归属证据，优先于相邻标题的位置关系。
  function repeaterSectionFromLabel(label) {
    const compact = tidyLabel(label || '').replace(/\s/g, '');
    if (!/^(?:\+)?(?:新增|添加|增加)/.test(compact)) return '';
    const aliases = [
      ['发明专利', '发明专利'], ['个人专利', '个人专利'], ['论文著作', '论文著作'], ['论文', '论文'],
      ['获奖经历', '获奖经历'], ['获奖情况', '获奖情况'], ['教育经历', '教育经历'], ['教育背景', '教育背景'],
      ['实习经历', '实习经历'], ['工作经历', '工作经历'], ['项目经验', '项目经验'], ['项目经历', '项目经历'],
      ['语言能力', '语言能力'], ['英语能力', '英语能力'], ['社会实践经历', '社会实践经历'],
      ['校内实践经历', '校内实践经历'], ['培训经历', '培训经历'], ['证书', '证书']
    ];
    return aliases.find(([alias]) => compact.includes(alias))?.[1] || '';
  }

  function activeSectionTitle() {
    const editor=recordEditorSurface();
    if(editor) {
      const title=selectedSection || tidyLabel(editor.querySelector('h1,h2,h3,[role="heading"]')?.textContent || '').replace(/^(?:新增|添加|编辑)\s*/, '');
      if(title) return title;
    }
    const selected = Array.from(document.querySelectorAll('nav .cur,aside .cur,[aria-current="page"]'))
      .map(el=>tidyLabel(el.textContent || '')).find(title=>FORM_SECTION_TITLES.has(title));
    const summary = Array.from(document.querySelectorAll('.resumeContent')).find(isVisible);
    if (summary) return selected || selectedSection || [...FORM_SECTION_TITLES].find(title=>
      tidyLabel(summary.textContent || '').startsWith(title)) || '';
    if (location.hostname === 'xiaoyuan.zhaopin.com') {
      const titleBox = Array.from(document.querySelectorAll('.form-content--title-box'))
        .find(isVisible);
      const title = tidyLabel(titleBox?.querySelector('h6,h2')?.textContent || titleBox?.textContent || '').replace(/\s*必填\s*$/, '').trim();
      if (FORM_SECTION_TITLES.has(title)) return title;
    }
    const heading = sectionMarkers.find(marker =>
      /^H[1-6]$/.test(marker.el.tagName) &&
      !marker.el.closest('nav,aside,[role="navigation"],ul,ol'));
    return heading?.title || '';
  }

  // 记录新增后，ATS 常把新表单放进 dialog / drawer / iframe。把这个观察值回传给
  // 调度器，用于区分“同页追加一行”和“已经进入独立编辑器”。
  function isRecordEditorSurface(surface) {
    if(surface.tagName==='IFRAME') return true;
    const editable=surface.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]').length;
    const commands=Array.from(surface.querySelectorAll('button,a,[role="button"]')).map(el=>tidyLabel(el.textContent || ''));
    const save=commands.some(label=>/^(保存|添加|保存经历|save)$/i.test(label));
    return editable>0 && save && (editable>1 || /编辑|添加|新增/.test(surface.querySelector('h1,h2,h3,[role="heading"]')?.textContent || ''));
  }

  function hasEditorSurface() {
    const surfaces = Array.from(document.querySelectorAll(
      '[role="dialog"],.el-dialog,.ant-modal,[class*="drawer"],iframe[src*="resume"]'
    )).filter(isVisible);
    return surfaces.some(isRecordEditorSurface);
  }

  function recordEditorSurface() {
    return Array.from(document.querySelectorAll('[role="dialog"],.el-dialog,.ant-modal,[class*="drawer"]'))
      .filter(el=>isVisible(el) && isRecordEditorSurface(el)).at(-1) || null;
  }

  function focusedEditorLayer() {
    // 飞书招聘的年月范围选择器也会以固定定位的单输入层渲染。它不是独立
    // 编辑器；将其作为 active layer 会把整张简历表单裁成一串年份和月份。
    // 飞书的学校/专业检索层通过 popup 容器识别即可，无需依赖该全局裁剪。
    if (isFeishuJobsPage()) return null;
    const triggerHost=transactionTrigger?.isConnected && transactionTrigger.closest('.phoenix-select');
    if (triggerHost) {
      const anchor=triggerHost.getBoundingClientRect();
      const phoenixLists=Array.from(document.querySelectorAll('[class*="phoenix-selectList__virtualList-holder-inner"]'))
        .filter(list=>{
          if (!isVisible(list)) return false;
          const box=list.getBoundingClientRect();
          const options=Array.from(list.querySelectorAll('li,[role="option"],[class*="selectList__item"]'))
            .filter(item=>isVisible(item) && tidyLabel(item.textContent || ''));
          return options.length>=2 && box.width>0 && box.height>0 && notOccluded(list,box) &&
            box.width<=anchor.width*1.6 && box.height<window.innerHeight*.9 &&
            Math.min(box.right,anchor.right)>Math.max(box.left,anchor.left) &&
            Math.min(Math.abs(box.top-anchor.bottom),Math.abs(box.bottom-anchor.top))<320;
        });
      if (phoenixLists.length) return phoenixLists.sort((left,right)=>{
        const a=left.getBoundingClientRect(),b=right.getBoundingClientRect();
        return Math.min(Math.abs(a.top-anchor.bottom),Math.abs(a.bottom-anchor.top))-
          Math.min(Math.abs(b.top-anchor.bottom),Math.abs(b.bottom-anchor.top));
      })[0];
      const choices=Array.from(document.querySelectorAll('ul,div')).filter(list=>{
        if (!isVisible(list) || list.closest('nav,header,[role="navigation"]')) return false;
        let floating=false;
        for (let node=list,depth=0;node && node!==document.body && depth<4;node=node.parentElement,depth++) {
          if (['absolute','fixed'].includes(window.getComputedStyle(node).position)) { floating=true; break; }
        }
        if (!floating) return false;
        const rows=Array.from(list.children).filter(row=>isVisible(row) &&
          !row.querySelector('input,textarea,select') && tidyLabel(row.textContent || '').length>0 &&
          tidyLabel(row.textContent || '').length<=60);
        if (new Set(rows.map(row=>tidyLabel(row.textContent || ''))).size<2) return false;
        const box=list.getBoundingClientRect();
        return box.width>0 && box.height>0 && notOccluded(list,box) &&
          box.width<=anchor.width*1.5 && box.height<window.innerHeight*.9 &&
          Math.min(box.right,anchor.right)>Math.max(box.left,anchor.left) &&
          Math.min(Math.abs(box.top-anchor.bottom),Math.abs(box.bottom-anchor.top))<240;
      });
      if (choices.length) return choices.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-
        b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0];
    }
    if (isBeisenFormPage()) {
      const searches=Array.from(document.querySelectorAll('input[placeholder="搜索"]')).filter(isVisible);
      for (const search of searches) {
        for (let parent=search.parentElement,depth=0;parent && parent!==document.body && depth<7;
            parent=parent.parentElement,depth++) {
          const choices=Array.from(parent.querySelectorAll('li,[role="option"],div,span')).filter(node=>
            isVisible(node) && !node.querySelector('li,[role="option"],div,span') &&
            tidyLabel(node.textContent || '').length>=2);
          const rect=parent.getBoundingClientRect();
          if (choices.length>=2 && rect.width>0 && rect.width<window.innerWidth*.7 &&
              rect.height>0 && rect.height<window.innerHeight*.9) return parent;
        }
      }
    }
    const editorLayers = Array.from(document.querySelectorAll('.searchInputComponent,[role="dialog"],.ant-modal,.el-dialog')).filter(el => {
      const r = el.getBoundingClientRect();
      const search=el.querySelector('input[placeholder*="专业名称"],input[placeholder*="学校"],input[placeholder*="搜索"]');
      const lookup=el.matches('.searchInputComponent') || (el.matches('.el-dialog') &&
        !el.querySelector('textarea,select,input:not([type="hidden"])') && el.querySelector('[class*="item"]')) || (search &&
        el.querySelectorAll('input:not([type="hidden"]),textarea,select').length === 1 &&
        /选择|搜索|检索/.test(el.textContent || ''));
      return lookup && isVisible(el) && r.width > 0 && r.height > 0;
    });
    if (editorLayers.length) return editorLayers[editorLayers.length - 1];
    let el = document.activeElement;
    if (!el || !el.matches("input,textarea,[contenteditable=true]")) return null;
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const r = parent.getBoundingClientRect();
      if (["fixed", "absolute"].includes(style.position) && r.width >= window.innerWidth * .6 && r.height >= window.innerHeight * .5 &&
          parent.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"]').length === 1) return parent;
    }
    return null;
  }

  function inViewport(r, vw, vh) {
    return !(
      r.bottom < 0 ||
      r.top > vh ||
      r.right < 0 ||
      r.left > vw ||
      r.width === 0 ||
      r.height === 0
    );
  }

  // 过滤计数：快照时统计被"不可见"和"零尺寸"挡掉多少候选控件，
  // 这样一旦过滤过头（真实意图是隐藏整块但又需要填的少数站点），能立刻从数字上看出来。
  let hiddenFiltered = 0;
  let zeroSizeFiltered = 0;
  let visibilityCache = new Map();

  // 祖先链上的 display:none / visibility:hidden / opacity:0 会连带隐藏子元素。
  // 关闭状态的自定义下拉普遍这样做，只查元素自身会让里面的"男/女"变成幽灵可点控件。
  function isVisible(el) {
    if (el.hidden) return false;
    // 飞书关闭日期面板后仍把“至今”等选项留在 DOM 中。面板已经零尺寸，
    // 这些选项不属于当前打开的选择器，也不能作为未完成的浮层候选。
    if (isFeishuJobsPage()) {
      const monthPanel = el.closest?.('.atsx-date-picker-period-month-panel');
      if (monthPanel) {
        const panelRect = monthPanel.getBoundingClientRect();
        if (panelRect.width === 0 || panelRect.height === 0) return false;
      }
    }
    const cached = visibilityCache.get(el);
    if (cached !== undefined) return cached;

    let result = true;
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 30) {
      const hit = visibilityCache.get(node);
      if (hit !== undefined) {
        result = hit;
        break;
      }
      if (node.hidden) {
        result = false;
        break;
      }
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        result = false;
        break;
      }
      node = node.parentElement;
      depth += 1;
    }
    visibilityCache.set(el, result);
    return result;
  }

  // 检查元素中心点是否被其他元素遮挡
  function notOccluded(el, r) {
    if (typeof document.elementFromPoint !== "function") return true;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (!top) return true;
    return top === el || el.contains(top);
  }

  function tidyLabel(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^[\s*＊·•:：]+/, "")
      .replace(/[\s:：]+$/, "")
      .trim()
      .slice(0, 80);
  }

  function normalizeTextForDom(value) {
    return String(value || '').toLowerCase().replace(/[\s\-_/()（）【】\[\]{}:：,.，。'"`]+/g, '').trim();
  }

  // 中文表单常见排布：<div class="label">籍贯</div><select>，标签就是左侧同级元素
  // 浮层容器会截断"向左找标签"的路径：
  // 否则下拉里第一个选项会把"展开它的那个输入框"当成自己的标签。
  const LABEL_BARRIER_SELECTOR = '[role="listbox"],[role="menu"],[role="tree"],[role="dialog"],[role="grid"]';

  function precedingText(el) {
    let node = el;
    for (let up = 0; up < 5 && node; up += 1) {
      if (node !== el && node.matches && node.matches(LABEL_BARRIER_SELECTOR)) break;
      let sib = node.previousElementSibling;
      for (let hop = 0; sib && hop < 3; hop += 1) {
        // 同级里只要出现表单控件，说明已经越过了标签区；
        // 必须连"兄弟本身是控件"一起判，否则会一路向左走到别的字段上去
        const sibTag = sib.tagName.toLowerCase();
        if (sibTag === "input" || sibTag === "select" || sibTag === "textarea" || sibTag === "button" || sibTag === "a") break;
        if (sib.querySelector("input,select,textarea,button,a[href]")) break;
        const t = tidyLabel(sib.innerText || sib.textContent || "");
        if (t && t.length <= 20) return t;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  // 找 label[for=id]。刻意不用 CSS.escape：部分环境（含 jsdom）没有 CSS 对象，
  // 一旦抛错就会被 catch 吞掉，变成"标签永远找不到"的静默失败。
  // 改为快照内一次性建好 id → label 的映射，顺带避开逐次 querySelector。
  let labelForCache = null;

  function labelFor(el) {
    const id = el.id;
    if (!id) return null;
    if (!labelForCache) {
      labelForCache = new Map();
      try {
        document.querySelectorAll("label[for]").forEach((lbl) => {
          const f = lbl.getAttribute("for");
          if (f && !labelForCache.has(f)) labelForCache.set(f, lbl);
        });
      } catch (_) {}
    }
    return labelForCache.get(id) || null;
  }

  // 关联标签：label[for] / 祖先 label / aria-labelledby / 左侧同级文本
  function associatedLabelText(el) {
    const lbl = labelFor(el);
    if (lbl && lbl.textContent && lbl.textContent.trim()) return tidyLabel(lbl.textContent);
    const parentLabel = el.closest("label");
    if (parentLabel && parentLabel.textContent && parentLabel.textContent.trim()) {
      return tidyLabel(parentLabel.textContent);
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const lbl = document.getElementById(labelledby);
      if (lbl && lbl.textContent && lbl.textContent.trim()) return tidyLabel(lbl.textContent);
    }
    const preceding = precedingText(el);
    if (isFieldCaption(preceding)) return preceding;
    // Moka 常把标题和控件包在同一层的两个子节点中；标题既没有 for，
    // 也不一定是控件祖先的前一个兄弟。逐层读取“不包含当前控件”的短文本子节点，
    // 可以稳定取回“当前最高学历 / 学校名称 / 专业类型”等字段身份。
    if (isMokaFormPage()) {
      let node = el;
      for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
        const containerText = tidyLabel(node.innerText || node.textContent || '');
        const controlCount = node.querySelectorAll?.('input,select,textarea,[contenteditable="true"]')?.length || 0;
        if (containerText.length > 240 || controlCount > 4) continue;
        for (const child of Array.from(node.children || [])) {
          if (child === el || child.contains?.(el) || child.querySelector?.('input,select,textarea,button,a[href]')) continue;
          const text = tidyLabel(child.innerText || child.textContent || '');
          if (isFieldCaption(text)) return text.replace(/\s*\*\s*$/, '').trim();
        }
      }
    }
    return "";
  }

  // 级联下拉（省/市/区、年/月/日）里，占位项文案是唯一能区分同级控件的信息
  const SELECT_UNIT_RE = /^(年|月|日|时|分|秒|省|市|区|区\/县|县|州|国家|国家\/地区)$/;

  // 原生下拉的标签：绝不能用"拼接起来的全部选项文本"，
  // 那会得到"年199019911992…"这种对语义匹配毫无用处的字符串。
  function selectLabel(el) {
    // name 属性常比占位文案更能表达字段含义（如 name="gender"）
    const base = associatedLabelText(el) || tidyLabel(el.getAttribute("name") || "");
    let placeholder = "";
    if (el.options && el.options.length) {
      for (const opt of Array.from(el.options)) {
        if (!opt.value) {
          placeholder = tidyLabel(opt.text);
          break;
        }
      }
    }
    if (base && SELECT_UNIT_RE.test(placeholder)) return `${base} · ${placeholder}`;
    if (base) return base;
    const selected = el.options && el.options[el.selectedIndex] ? tidyLabel(el.options[el.selectedIndex].text) : "";
    if (selected && selected.length <= 20) return selected;
    if (placeholder && placeholder.length <= 20) return placeholder;
    return "";
  }

  // Ant Mobile 的 List.Item 下拉没有原生 select、ARIA role 或 pointer 光标。
  // 这类控件的标题位于 my-list-item 内的 header-title，点击区域是 am-list-extra。
  // 按 DOM 结构识别选择器，同时采集它的字段标题。
  const AM_LIST_SELECT_SELECTOR = ".am-list-extra.select-am-list-extra, .datePicker-list-item-wrap .am-list-extra, .my-list-item .am-input-control:not(:has(input)):not(:has(textarea))";

  function isAmListSelect(el) {
    try {
      return el.matches(AM_LIST_SELECT_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  function amListSelectLabel(el) {
    if (!isAmListSelect(el) && !el.matches("input:not([type=radio]):not([type=checkbox]),textarea")) return "";
    try {
      const row = el.closest(".my-list-item");
      const title = row && row.querySelector(".header-title");
      const text = tidyLabel(title && (title.innerText || title.textContent || ""));
      if (text) return text;
    } catch (_) {}
    return "";
  }

  function deriveLabel(el) {
    if (el.matches('.set-wrap')) return tidyLabel(el.querySelector('.txt-title')?.textContent || el.textContent);
    if (el.matches('.mFormRadio li')) return `性别 · ${tidyLabel(el.textContent || '')}`;
    if (el.matches('.phoenix-radio')) return structuredFieldCaption(el) || nearestFieldCaption(el);
    if (el.matches('button,[role="button"]') && el.closest('.ud__picker-dropdown')) {
      const signals = [el,...el.querySelectorAll('*')].map(node => [
        String(node.className?.baseVal || node.className || ''),node.getAttribute('aria-label'),
        node.getAttribute('data-icon'),node.getAttribute('data-name')].filter(Boolean).join(' ')).join(' ');
      if (/prev|previous|left|backward/i.test(signals)) return '上一页';
      if (/next|right|forward/i.test(signals)) return '下一页';
    }
    if (/(^|\.)zhiye\.com$/i.test(location.hostname) && el.closest('.el-picker-panel') && el.matches('button')) {
      const className=String(el.className || '');
      if (/el-date-picker__prev-btn/.test(className)) return '上一页';
      if (/el-date-picker__next-btn/.test(className)) return '下一页';
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return tidyLabel(ariaLabel);
    const amLabel = amListSelectLabel(el);
    if (amLabel) return amLabel;
    if (el.matches('input,textarea,[role="combobox"]')) {
      const structured = structuredFieldCaption(el);
      if (structured) return structured;
    }
    // 下拉选项、菜单项的语义就是它自己的文字
    const role = el.getAttribute("role");
    if (role === 'combobox' && !el.matches('input,select,textarea')) {
      const own = tidyLabel(el.getAttribute('data-placeholder') || el.innerText || el.textContent || '');
      if (/^请选择[^\s]+$/.test(own)) return own.replace(/^请选择/, '');
    }
    if (role === 'button' && isMokaFormPage() && el.querySelector?.('input')) {
      const fieldLabel = precedingText(el);
      if (fieldLabel) return fieldLabel;
    }
    if (role === "option" || role === "menuitem" || role === 'button' || el.matches('button,a,.my-button')) {
      const own = tidyLabel(el.innerText || el.textContent || "");
      if (own) return own;
    }
    if (el.tagName === "SELECT") {
      const s = selectLabel(el);
      if (s) return s;
    }
    const placeholder = el.getAttribute("placeholder");
    if (el.matches('input,textarea') && el.closest('.el-form-item')) {
      const caption=el.closest('.el-form-item').querySelector('.el-form-item__label');
      if (caption) return tidyLabel(caption.textContent);
    }
    // Moka 会把动态出现的补充文本框放在包含多个字段的同一张卡片里。
    // 这类具名 placeholder 比祖先卡片中的任一标题都更精确。
    if (isMokaFormPage() &&
        /^请填写具体来源$/.test(String(placeholder || '').trim())) {
      return '请填写具体来源';
    }
    if (isMokaFormPage() && el.matches('input') &&
        /^\+\d{1,4}$/.test(String(el.value || '').trim())) {
      return '国家区号';
    }
    if (isMokaFormPage() && el.matches('input') &&
        (el.readOnly || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') ||
         el.closest('[class*="Select"],[class*="select"]'))) {
      let phoneGroup = el.parentElement;
      for (let depth = 0; phoneGroup && depth < 5; depth += 1, phoneGroup = phoneGroup.parentElement) {
        const phoneInputs = Array.from(phoneGroup.querySelectorAll?.('input') || []);
        const hasPhoneInput = phoneInputs.some(input => input !== el &&
          /(请输入手机号|请输入手机号码|联系电话)/.test(String(input.getAttribute('placeholder') || '')));
        if (phoneInputs.length >= 2 && phoneInputs.length <= 3 && hasPhoneInput &&
            !/(请输入手机号|请输入手机号码|联系电话)/.test(String(placeholder || ''))) {
          return '国家区号';
        }
      }
    }
    // Moka 的自定义下拉在选中后会清空 placeholder，并把选中值直接写进 input。
    // 此时仍应从字段容器读取稳定标题，保证“2025 / 示例大学 / 硕士”继续分别
    // 识别为就读时间、学校名称和学历，而不是退化成普通文本值。
    if (isMokaFormPage() && el.matches('input,textarea')) {
      let fieldNode = el.parentElement?.parentElement;
      for (let depth = 0; fieldNode && depth < 5; depth += 1, fieldNode = fieldNode.parentElement) {
        const controls = fieldNode.querySelectorAll('input,textarea,select').length;
        if (controls > 2) break;
        const caption = Array.from(fieldNode.children).find(child =>
          !child.contains(el) && !child.querySelector('input,textarea,select') &&
          isFieldCaption(child.textContent || '') &&
          tidyLabel(child.textContent || '') !== tidyLabel(el.value || ''));
        if (caption) return tidyLabel(caption.textContent || '').replace(/\s*\*\s*$/, '').trim();
      }
      if (/^请输入(?:国家|国籍)\/地区$/.test(String(placeholder || ''))) return '国家/地区';
      const knownLabels = [
        '校招面试站点','意向工作城市','姓名','手机号码','邮箱','性别','毕业时间',
        '当前最高学历','籍贯','政治面貌','当前所在城市','就读时间','学校名称',
        '专业名称','学历','专业类型','起止时间','实习职责','项目描述','项目职责',
        '语言类型','掌握程度','获奖时间','奖项名称','自我描述','是否有亲属在本公司',
        '获取招聘信息来源','是否接受岗位调剂','信息确认'
      ];
      let node = el.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        const controlCount = node.querySelectorAll?.('input,select,textarea,[contenteditable="true"]')?.length || 0;
        const text = tidyLabel(node.innerText || node.textContent || '');
        if (controlCount > 8 || text.length > 400) continue;
        const found = knownLabels.find(label => text.includes(label));
        if (found) return found;
      }
    }
    if (el.matches('input') &&
        (el.readOnly || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') ||
         el.closest('[class*="Select"],[class*="select"]'))) {
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const inputs = Array.from(node.querySelectorAll?.('input') || []);
        const hasPhoneInput = inputs.some(input => input !== el && /(请输入手机号|请输入手机号码|联系电话)/.test(String(input.getAttribute('placeholder') || '')));
        if (inputs.length >= 2 && inputs.length <= 3 && hasPhoneInput &&
            !/(请输入手机号|请输入手机号码|联系电话)/.test(String(placeholder || ''))) return '国家区号';
      }
    }
    if (/^(?:请选择|选择意向工作城市|请输入籍贯|请选择省市区)$/.test(String(placeholder || ''))) {
      // Moka 的手机号国家区号是一个可输入 combobox。下拉收起后
      // "+86" 可能在控件 value 中，也可能由同组的独立 span 渲染。同组还会
      // 并列真正的“请输入手机号”输入框，这些都是稳定的结构特征。
      if (/^\+\d{1,4}$/.test(String(el.value || '').trim())) return '国家区号';
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const text = String(node.textContent || '');
        const inputs = Array.from(node.querySelectorAll?.('input') || []);
        const hasPhoneInput = inputs.some(input =>
          input !== el && /(手机号|手机号码|联系电话)/.test(String(input.getAttribute('placeholder') || ''))
        );
        if (inputs.length >= 2 && inputs.length <= 3 && (text.includes('+86') || hasPhoneInput)) return '国家区号';
      }
      // Moka 选中后会在 input 前插入“硕士/男/否”等展示节点。
      // 从选择器容器的前一个兄弟读取字段标题，避免标签从“学历”漂移成已选值。
      if (isMokaFormPage()) {
        let node = el.parentElement;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const fieldLabel = precedingText(node);
          if (isFieldCaption(fieldLabel) && fieldLabel !== tidyLabel(el.value || '') &&
              !/^(?:\+?\d+|\d{4}|\d{1,2}|请选择|年|月|-)$/.test(fieldLabel)) return fieldLabel;
        }
      }
    }
    const associated = associatedLabelText(el);
    if (associated && el.matches('input[type="radio"],input[type="checkbox"]')) return associated;
    if (associated && /^(请选择|内容|简介|年|月|日|必填项未填写)|日期|年月日/.test(tidyLabel(placeholder || ''))) return associated;
    if (!isFieldCaption(placeholder)) {
      const caption = nearestFieldCaption(el);
      if (caption) return caption;
    }
    if (placeholder) return tidyLabel(placeholder);
    if (associated) return associated;
    // 富文本编辑器常用 data-placeholder / aria-placeholder 承载占位提示
    const dataPlaceholder = el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder");
    if (dataPlaceholder) return tidyLabel(dataPlaceholder);
    const title = el.getAttribute("title");
    if (title) return tidyLabel(title);
    const nameAttr = el.getAttribute("name");
    if (nameAttr) return tidyLabel(nameAttr);
    // 元素自身文字（按钮/链接/自定义控件常靠这个识别），innerText 取不到时退回 textContent
    const ownText = tidyLabel(el.innerText || el.textContent || "");
    if (ownText) return ownText;
    return "(无标签)";
  }

  // Moka 把一段起止时间拆为连续的「年、月、年、月」四个无 name 输入框。
  // 实际站点会在每个输入外包多层校验和动画节点，不能依赖某个固定父容器。
  // 直接使用页面中可见年月输入的 DOM 序列：教育、实习、项目均以完整四栏组出现，
  // 因而索引除以四后的余数就是稳定的局部字段身份。
  function localDateSlot(el) {
    if (!isMokaFormPage() || !el) return null;
    const input = el.matches?.('input') ? el : el.querySelector?.('input[placeholder="年"],input[placeholder="月"]');
    if (!input) return null;
    const placeholder = tidyLabel(input.getAttribute('placeholder') || '');
    if (placeholder !== '年' && placeholder !== '月') return null;
    const dateInputs = node => Array.from(node.querySelectorAll('input')).filter(input => {
      const unit = tidyLabel(input.getAttribute('placeholder') || '');
      return (unit === '年' || unit === '月') && isVisible(input);
    });
    // 首选包含完整起止日期的最近容器，既保留 DOM 顺序，也与其他教育/实习记录隔离。
    let group = null;
    for (let parent = input.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const inputs = dateInputs(parent);
      if (inputs.length >= 4) { group = inputs; break; }
    }
    const controls = group || dateInputs(document);
    const index = controls.indexOf(input);
    return index >= 0 ? index % 4 : null;
  }

  // Moka 的重复记录在选值后会清掉 placeholder，不能再依赖“年/月”或字段文案
  // 判断它属于第几条经历。这里在完整 DOM 顺序上一次性标注 recordIndex：
  // 日期型记录以每条的起止年月为边界，语言型记录以语言名称为边界。
  function annotateMokaRecordMetadata(items) {
    if (!isMokaFormPage()) return;
    // Moka 经常把“硕士／本科”资料直接放在「个人信息」中，而不是另起教育
    // 分区。页面中的年、月输入没有 name 或标题，按照这两组表单的 DOM 顺序
    // 恢复教育记录后，每一个选择器都能绑定到唯一的 JSON 字段。
    // 选择最高学历后，Moka 会在原表单的不同 DOM 容器中异步插入“硕士／本科”
    // 字段。插入容器未必继承“个人信息”标题，所以用字段前缀作为教育记录的
    // 稳定边界；这样扫描时无论页面如何拆分区域，都能恢复两条教育经历。
    const isPersonalDegreeControl = entry => /^(本科|硕士|博士)(?:学校|专业|学历|开始时间|结束时间)/
      .test(tidyLabel(entry.label || entry.placeholder || ''));
    const personalEducation = items.filter(item => item.entry.context !== 'popup' &&
      (item.entry.section === '个人信息' || isPersonalDegreeControl(item.entry)));
    const recordByDegree = new Map();
    let activePersonalRecord = null;
    for (const {entry} of personalEducation) {
      const label = tidyLabel(entry.label || entry.placeholder || '');
      const degree = label.match(/^(本科|硕士|博士)(?:学校|专业|学历|开始时间|结束时间)/)?.[1];
      if (degree) {
        if (!recordByDegree.has(degree)) recordByDegree.set(degree, recordByDegree.size);
        activePersonalRecord = recordByDegree.get(degree);
        entry.mokaDegree = degree;
      }
      if (Number.isInteger(activePersonalRecord)) entry.recordIndex = activePersonalRecord;
      if (/^(本科|硕士|博士)学校(?:[（(]?全称[）)]?)?$/.test(label)) entry.label = '学校名称';
      if (/^(本科|硕士|博士)专业(?:[（(]?全称[）)]?)?$/.test(label)) entry.label = '专业名称';
      if (/^(本科|硕士|博士)学历性质$/.test(label)) {
        entry.mokaDateAnchor = true;
        entry.label = '学习方式';
      }
    }
    const personalDateLabels = ['入学年份','入学月份','毕业年份','毕业月份'];
    let pendingDateRecord = null;
    let pendingDateSlot = 0;
    for (const {stateEl, entry} of personalEducation) {
      const originalLabel = tidyLabel(entry.label || entry.placeholder || '');
      const degree = entry.mokaDegree;
      if (degree) activePersonalRecord = recordByDegree.get(degree);
      if (entry.mokaDateAnchor || originalLabel === '学习方式') {
        // 每段学历的“学历性质”后在同一容器里固定出现起始年、月、结束年、月。
        // Moka 选中后会移除 input 的“年／月”占位，因此以这个顺序保持稳定身份。
        pendingDateRecord = activePersonalRecord;
        pendingDateSlot = 0;
        continue;
      }
      if (!Number.isInteger(pendingDateRecord) || pendingDateSlot >= personalDateLabels.length) continue;
      const input = stateEl?.matches?.('input[placeholder="年"],input[placeholder="月"]') ? stateEl :
        stateEl?.querySelector?.('input[placeholder="年"],input[placeholder="月"]');
      const unit = tidyLabel(input?.getAttribute?.('placeholder') || entry.placeholder || '');
      const selectedNumber = entry.kind === 'custom-select' && /^\d{1,4}$/.test(String(entry.value || originalLabel));
      if (unit !== '年' && unit !== '月' && !selectedNumber) continue;
      entry.recordIndex = pendingDateRecord;
      entry.dateSlot = pendingDateSlot;
      entry.label = personalDateLabels[pendingDateSlot];
      pendingDateSlot += 1;
      if (pendingDateSlot === personalDateLabels.length) pendingDateRecord = null;
    }
    const dateGroupSize = new Map([
      ['教育背景', 4], ['教育经历', 4], ['实习经历', 4], ['工作经历', 4],
      ['项目经验', 4], ['项目经历', 4], ['获奖经历', 2]
    ]);
    for (const [section, size] of dateGroupSize) {
      const local = items.filter(item => item.entry.context !== 'popup' && item.entry.section === section);
      let dateOrdinal = 0;
      let currentRecord = -1;
      for (const item of local) {
        const {stateEl, entry} = item;
        const input = stateEl?.matches?.('input') ? stateEl : stateEl?.querySelector?.('input');
        const placeholder = tidyLabel(input?.getAttribute?.('placeholder') || entry.placeholder || '');
        const shown = String(entry.value || entry.label || '').trim();
        const numericSelected = entry.kind === 'custom-select' && /^\d{1,4}$/.test(shown);
        const isDatePart = placeholder === '年' || placeholder === '月' || numericSelected;
        if (isDatePart) {
          currentRecord = Math.floor(dateOrdinal / size);
          entry.recordIndex = currentRecord;
          entry.dateSlot = dateOrdinal % size;
          dateOrdinal += 1;
        } else if (currentRecord >= 0 && !/^(?:\+\s*)?添加$/.test(String(entry.label || '').replace(/\s/g, ''))) {
          entry.recordIndex = currentRecord;
        }
      }
    }

    const anchors = new Map([['语言能力', /^(?:语言类型|语种)$/]]);
    for (const [section, anchor] of anchors) {
      let currentRecord = -1;
      for (const item of items.filter(item => item.entry.context !== 'popup' && item.entry.section === section)) {
        const {entry} = item;
        if (anchor.test(String(entry.label || '').trim()) || anchor.test(String(entry.placeholder || '').trim())) currentRecord += 1;
        if (currentRecord >= 0 && !/^(?:\+\s*)?添加$/.test(String(entry.label || '').replace(/\s/g, ''))) entry.recordIndex = currentRecord;
      }
    }
  }

  function annotateRepeatedContainers(items) {
    const signature=node=>Array.from(node.querySelectorAll('input:not([type=hidden]),textarea,select'))
      .slice(0,4).map(el=>`${deriveLabel(el)}:${el.getAttribute('placeholder') || el.type}`).join('|');
    const metadata=new Map();
    for (const {stateEl,entry} of items) {
      if (entry.context==='popup' || Number.isInteger(entry.recordIndex) || !stateEl) continue;
      for (let node=stateEl.parentElement,depth=0;node && depth<9;node=node.parentElement,depth++) {
        if (!metadata.has(node)) {
          const controls=node.querySelectorAll('input:not([type=hidden]),textarea,select');
          const peers=controls.length>=2 ? Array.from(node.parentElement?.children || []).filter(peer=>
            peer.tagName===node.tagName && peer.className===node.className &&
            signature(peer)===signature(node) && peer.querySelectorAll('input:not([type=hidden]),textarea,select').length>=2) : [];
          metadata.set(node,peers.length>1 ? peers.indexOf(node) : null);
        }
        if (metadata.get(node)!==null) { entry.recordIndex=metadata.get(node); break; }
      }
    }
  }

  // 记录卡片的 DOM 外观各站不同，但字段锚点在校园招聘表单中相对稳定。
  // 这层只补充还没有平台或容器证据的 recordIndex，已有标注始终优先保留。
  function annotateSemanticRecords(items) {
    const anchors = new Map([
      ['教育背景', /^(?:学校|学校名称|学校全称|就读学校|毕业院校)$/],
      ['教育经历', /^(?:学校|学校名称|学校全称|就读学校|毕业院校)$/],
      ['实习经历', /^(?:公司|公司名称|单位|单位名称|企业名称)$/],
      ['工作经历', /^(?:公司|公司名称|单位|单位名称|企业名称)$/],
      ['实习/工作经历', /^(?:公司|公司名称|单位|单位名称|企业名称)$/],
      ['项目经验', /^(?:项目名称|项目名)$/],
      ['项目经历', /^(?:项目名称|项目名)$/],
      ['语言能力', /^(?:语言|语种|语言类型|外语类型)$/],
      ['获奖经历', /^(?:获奖项|获奖名称|奖项名称|奖励名称|奖项)$/],
      ['获奖情况', /^(?:获奖项|获奖名称|奖项名称|奖励名称|奖项)$/],
      ['校内实践经历', /^(?:组织名称|实践内容|职位名称|职务)$/],
      ['家庭关系', /^(?:姓名|家属姓名|家庭成员姓名)$/]
    ]);
    for (const [section, anchor] of anchors) {
      let activeRecord = -1;
      let previousWasAnchor = false;
      for (const {entry} of items.filter(item => item.entry.context !== 'popup' && item.entry.section === section)) {
        const label = tidyLabel(entry.label || entry.placeholder || '').replace(/^请(?:输入|填写|选择)/, '').replace(/\s*[*＊]\s*$/, '');
        const isAnchor = anchor.test(label);
        if (isAnchor && !previousWasAnchor) activeRecord += 1;
        previousWasAnchor = isAnchor;
        if (activeRecord >= 0 && !Number.isInteger(entry.recordIndex) &&
            !/^(?:\+\s*)?(?:添加|新增|增加)/.test(String(entry.label || '').replace(/\s/g, ''))) {
          entry.recordIndex = activeRecord;
        }
      }
    }
  }

  function fieldProtocol(entry) {
    const operations = entry.operations || [];
    if (operations.includes('UPLOAD_FILE') || entry.kind === 'file') return 'upload';
    if (entry.kind === 'section-entry' || /^(?:\+\s*)?(?:添加|新增|增加)/.test(String(entry.label || '').replace(/\s/g, ''))) return 'repeater';
    if (entry.kind === 'feishu-date-range') return 'date-range';
    if (operations.includes('PICK_DATE') || /(?:date|时间|日期|年月)/i.test(`${entry.kind || ''} ${entry.label || ''}`) &&
        ['date','beisen-date','moka-date','layui-date','feishu-year'].includes(entry.kind)) return 'date';
    if (['checkbox','radio','custom-checkbox','custom-radio'].includes(entry.kind)) return 'choice';
    if (entry.kind === 'combobox' && operations.includes('TYPE_TEXT')) return 'search-select';
    if (['custom-select','native-select','combobox'].includes(entry.kind) || operations.includes('SELECT')) return 'select';
    if (operations.includes('TYPE_TEXT') || ['input','textarea','richtext'].includes(entry.kind)) return 'direct-text';
    return operations.includes('CLICK') ? 'navigation' : 'read-only';
  }

  function compoundGroupLabel(item, items) {
    const label = tidyLabel(item.entry.label || item.entry.placeholder || '').replace(/^请(?:输入|填写|选择)/, '').replace(/\s*[*＊]\s*$/, '');
    if (!/^(?:请选择|请输入|未选择|未填写)?$/.test(label)) return label || '(无标签)';
    const nearby = items.filter(other => other !== item && other.entry.context !== 'popup' &&
      other.entry.section === item.entry.section && Math.abs((other.entry.domOrder || 0) - (item.entry.domOrder || 0)) <= 2);
    // 证件类型下拉与号码输入在许多网站共用一个表单项，其中下拉常只有“请选择”。
    // 使用同一项内的明确证件标题建立复合事务，国家区号等其他“请选择”控件保持独立。
    const certificate = nearby.find(other => /证件(?:类型|号码|号)/.test(
      tidyLabel(other.entry.label || other.entry.placeholder || '').replace(/^请(?:输入|填写|选择)/, '')
    ));
    return certificate ? '证件号码' : label || '(无标签)';
  }

  // FieldGroup 把一个用户可见字段的多个 DOM 元素收敛为单一事务。例如“证件号码”
  // 的类型下拉和号码输入框共用一个组；记录索引把每段教育／项目经历隔离开。
  function annotateFieldGroups(items) {
    const slots = new Map();
    for (const item of items) {
      const {entry} = item;
      if (entry.context === 'popup') continue;
      let label = compoundGroupLabel(item, items);
      if (/手机号码|联系电话/.test(label) && entry.kind === 'custom-select' &&
          /^\+\d{1,4}$/.test(String(entry.value || '').trim())) label += '区号';
      const section = tidyLabel(entry.section || '页面');
      const record = Number.isInteger(entry.recordIndex) ? `record-${entry.recordIndex + 1}` : 'single';
      const normalized = label.toLowerCase().replace(/[\s\-_/()（）【】\[\]{}:：,.，。'"`]+/g, '') || 'unlabeled';
      const group = `${section}|${record}|${normalized}`;
      entry.fieldGroup = group;
      entry.fieldProtocol = fieldProtocol(entry);
      entry.fieldSlot = slots.get(group) || 0;
      slots.set(group, entry.fieldSlot + 1);
    }
  }

  function deriveRole(el) {
    if (el.matches('.my-button,.set-wrap')) return 'button';
    if (el.matches('.mFormRadio li,.phoenix-radio')) return 'radio';
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    if (role === 'radio' || role === 'checkbox') return role;
    if (isAmListSelect(el)) return "combobox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      if (role === 'combobox' && el.hasAttribute('readonly')) return 'combobox';
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (role === "button") return "button";
    if (role === "combobox") return "combobox";
    if (role === "listbox") return "listbox";
    if (role === "option") return "option";
    if (role === "textbox") return "textbox";
    if (role === "checkbox") return "checkbox";
    if (role === "radio") return "radio";
    if (role === "menuitem") return "menuitem";
    if (role === "link") return "link";
    // tab / treeitem / switch / menuitemcheckbox / menuitemradio 都是"点一下就完成"的语义，
    // 统一按可点动作报给 Jev
    if (["tab", "treeitem", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) return "button";
    if (isEditableEl(el)) return "textbox";
    return tag;
  }

  // jsdom 不实现 isContentEditable，属性判断一起用，保证富文本识别稳定
  function isEditableEl(el) {
    return el.isContentEditable === true || el.getAttribute("contenteditable") === "true";
  }

  // 控件种类：告诉 Jev 这是普通输入框、原生下拉，还是需要多步操作的自定义控件
  const DATE_HINT_RE = /(日期|时间|年月|生日|出生日期|\bdate\b|\btime\b)/i;

  function deriveKind(el, role) {
    if (el.matches('nav a,aside a,[role="navigation"] a') && FORM_SECTION_TITLES.has(tidyLabel(el.textContent))) return 'section-entry';
    if (el.matches('.set-wrap')) return 'section-entry';
    if (el.matches('.mFormRadio li,.phoenix-radio')) return 'custom-radio';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const hasPopup = el.getAttribute("aria-haspopup");
    const isReadonly = el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true";
    const labelText = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""}`;
    const fieldText = tidyLabel(el.closest('.form-item,.el-form-item,[class*="form-item"]')?.innerText ||
      el.closest('.form-item,.el-form-item,[class*="form-item"]')?.textContent || '');
    const mokaSearch = /(请输入就读学校|请输入专业名称|请输入学校|请输入专业)/.test(labelText);
    const mokaHost = isMokaFormPage();
    const mokaPlaceholder = tidyLabel(el.getAttribute("placeholder") || "");
    const mokaFullDate = mokaHost && tag === "input" && isReadonly &&
      /日期（年月日）|日期\(年月日\)/.test(mokaPlaceholder);
    // Moka 的出生日期没有稳定 placeholder，仍然是只读日期投影，必须通过
    // 年份 → 月份 → 日期的面板事务提交；把它识别为普通 date 会误把面板标题
    // 当作可选值。
    const mokaDateInput = mokaHost && tag === 'input' &&
      // Moka 的出生日期在不同租户中有两种实现：有的 input 为 readonly，
      // 有的交由 React 接管、没有 readonly 属性。两者都通过年月面板完成选择，
      // 因此以字段标题作为稳定证据。
      DATE_HINT_RE.test(`${labelText} ${fieldText} ${nearestFieldCaption(el)}`) &&
      !/^(?:年|月)$/.test(mokaPlaceholder);
    // Moka 的选择器使用普通、可写 input 承载当前值，没有 readonly、role 或
    // aria-haspopup。年/月和“请选择”类字段只能从弹层选择；把它们当文本框时，
    // input 事件会短暂出现但组件不会提交值。
    const mokaSelectInput = mokaHost && tag === "input" && !mokaSearch &&
      (/^(?:请选择|年|月|选择意向工作城市|请输入籍贯|请输入国家\/地区|请输入国籍\/地区|请选择省市区)$/.test(mokaPlaceholder) ||
       !!el.closest('.sd-Select-container-1Eq4x,[class*="sd-Select-container-"]')) &&
      !/^\+\d{1,4}$/.test(String(el.value || "").trim());

    if (type === "file") return "file";
    if (isEditableEl(el)) return "richtext";
    // 飞书招聘将一组“起止时间”封装为一个可编辑范围输入。使用单一事务写入
    // 起始与结束月份，避免把同一输入框分别绑定为两个独立日期字段。
    if (isFeishuDateRange(el)) return 'feishu-date-range';
    // 飞书的获奖日期有时只提供一个年份输入框（placeholder=YYYY），右侧带日历
    // 图标。它和起止时间范围输入不同，按页面精度直接写年份，不打开无候选的日历层。
    if (isFeishuJobsPage() && tag === 'input' && mokaPlaceholder === 'YYYY') return 'feishu-year';
    if (tag === 'input' && el.closest('.ud__picker,.throne-biz-date-range-picker-input')) return 'date';
    // 北森（zhiye.com）使用 Element UI 的只读 input 承载日期；值只能由日历提交。
    if (isBeisenFormPage() && tag === 'input' &&
        (el.closest('.el-date-editor') || DATE_HINT_RE.test(fieldText))) return 'beisen-date';
    if (tag==='input' && /^请选择/.test(tidyLabel(el.getAttribute('placeholder') || '')) && !DATE_HINT_RE.test(labelText))
      return 'custom-select';
    if (el.closest('.phoenix-select')) return 'custom-select';
    if (tag === 'input' && el.closest('.el-select')) {
      if (!isReadonly && /学校全称|学校名称|专业名称/.test(el.getAttribute('placeholder') || ''))
        return 'combobox';
      return 'custom-select';
    }
    if (tag === 'input' && /^请选择.*(?:户口|户籍|居住|籍贯|城市|地区)/.test(tidyLabel(el.getAttribute('placeholder') || '')))
      return 'custom-select';
    if (mokaFullDate || mokaDateInput) return "moka-date";
    if (isAmListSelect(el)) return "custom-select";
    if (mokaSelectInput) return "custom-select";
    if (tag === 'input' && !isReadonly && el.closest('.el-autocomplete')) return 'combobox';
    if (isReadonly && (el.closest('.mFormTime') ||
        location.hostname === 'iter.stongyw.cn' && DATE_HINT_RE.test(labelText))) return "layui-date";
    if (isReadonly && el.closest('.mFormSelect,.mFormCity')) return "custom-select";
    if (tag === "select") return "native-select";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "date" || type === "month" || type === "datetime-local") return "date";
    if (mokaSearch && (tag === 'input' || tag === 'textarea')) return 'combobox';
    if (role === "listbox") return "overlay";
    if (role === "combobox" || el.getAttribute('role') === 'combobox' ||
        hasPopup === "listbox" || hasPopup === "menu" || hasPopup === "tree") {
      // 只有原生输入框才谈得上"打字联想"；div 类自定义下拉只能点开再选
      const typeable = (tag === "input" || tag === "textarea") && !isReadonly;
      return typeable ? "combobox" : "custom-select";
    }
    if (isReadonly && DATE_HINT_RE.test(labelText)) return "date";
    if (role === "textbox" && DATE_HINT_RE.test(labelText)) return "date";
    if (role === "option" || role === "menuitem") return "option-item";
    if (role === "button" || role === "link") return "action";
    return "input";
  }

  function deriveOperations(role, el, kind) {
    const isReadonly = el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true";
    const tag = el.tagName.toLowerCase();

    const family = widgetDrivers.classify({ kind, role, tagName: tag, editable: isEditableEl(el) });
    if (widgetDrivers.operations) {
      return widgetDrivers.operations({ family, role, readonly: isReadonly, tagName: tag, editable: isEditableEl(el) });
    }

    if (kind === "file") return ["UPLOAD_FILE"];
    if (kind === 'feishu-year') return ['TYPE_TEXT'];
    // 浮层容器本身不可点，条目才可点
    if (kind === "overlay") return [];
    if (kind === "layui-date" || kind === "moka-date") return ["PICK_DATE"];

    // 自定义下拉写不进值，只能点开浮层再选条目
    if (kind === "custom-select") return ["CLICK"];

    // 只读控件写不进去，只能点开再选
    if (isReadonly && tag !== "select") return ["CLICK"];

    // 日期框和现代浏览器原生日期控件都支持直接输入，也允许点开日历
    if (kind === "date") return ["TYPE_TEXT", "CLICK"];

    // 输入联想：先打字，再从联想列表里选
    if (kind === "combobox" && role === "textbox") return ["TYPE_TEXT", "CLICK"];

    switch (role) {
      case "textbox":
        return ["TYPE_TEXT"];
      case "combobox":
        return ["CLICK", "SELECT"];
      case "button":
      case "link":
      case "menuitem":
      case "option":
      case "checkbox":
      case "radio":
        return ["CLICK"];
      default:
        return isEditableEl(el) ? ["TYPE_TEXT"] : ["CLICK"];
    }
  }

  function editableText(el) {
    return (el.innerText || el.textContent || "");
  }

  function getValue(el, kind) {
    // 飞书的零尺寸 input 可保留旧值，而用户可见的两个日期槽仍是 YYYY-MM。
    // 以可见槽作为表单状态，避免把未提交的隐藏值误判为已填写。
    if (kind === 'feishu-date-range') return feishuDateRangeDisplay(el);
    const family = widgetDrivers.classify({ kind, role: deriveRole(el), tagName: el.tagName, editable: isEditableEl(el) });
    if (widgetDrivers.readValue) {
      return widgetDrivers.readValue(el, {
        family, hostname: location.hostname, tidy: tidyLabel, editableText, isEditable: isEditableEl,
        label: deriveLabel(el)
      });
    }
    if (kind === 'custom-radio') return el.classList.contains('cur') ? tidyLabel(el.textContent || '') : '';
    if (el.tagName === "SELECT") {
      return el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "";
    }
    if (isEditableEl(el)) return editableText(el).slice(0, 200);
    if (el.matches('input,textarea')) {
      if (el.value) return el.value;
      // Moka 的自定义下拉把已选值绘制在 input 的同级节点，input.value 仍为空。
      // 读取最近的选择器容器，才能在点选后确认事务已完成。
      if (isMokaFormPage() && (kind === 'custom-select' || kind === 'combobox')) {
        let node = el.parentElement;
        for (let depth = 0; node && depth < 2; depth += 1, node = node.parentElement) {
          const text = tidyLabel(node.innerText || node.textContent || '');
          if (text && text !== tidyLabel(el.getAttribute('placeholder') || '') &&
              normalizeTextForDom(text.replace(/\*/g,'')) !== normalizeTextForDom(deriveLabel(el)) &&
              text.length <= 60) return text;
        }
      }
      return "";
    }
    // div 型选择器没有 value 属性。读取其可见文本，才能在选择并确认后把该字段
    // 判定为已满足，避免再次打开同一弹层。
    if (kind === "custom-select" || el.getAttribute("role") === "combobox") {
      const text = tidyLabel(el.innerText || el.textContent || "");
      return normalizeTextForDom(text.replace(/\*/g,'')) === normalizeTextForDom(deriveLabel(el)) ? '' : text;
    }
    return el.value || "";
  }

  // 收集 document 及所有开放 shadow root，覆盖 Web Components 封装的自定义控件
  function collectRoots(root, acc, depth) {
    if (!root || depth > 8) return acc;
    acc.push(root);
    let all;
    try {
      all = root.querySelectorAll("*");
    } catch (_) {
      return acc;
    }
    all.forEach((el) => {
      if (el.shadowRoot) collectRoots(el.shadowRoot, acc, depth + 1);
    });
    return acc;
  }

  // 打开的下拉/菜单/日历/联想列表：内部条目常常没有 role，单独采集一遍
  const OVERLAY_SELECTOR = [
    '[role="listbox"]',
    '[role="menu"]',
    '[role="dialog"]',
    '[role="tree"]',
    '[class*="dropdown"]',
    '[class*="select-dropdown"]',
    '[class*="popover"]',
    '[class*="popup"]',
    '[class*="popper"]',
    '[class*="calendar"]',
    '[class*="datepicker"]',
    '[class*="date-picker"]',
    '[class*="picker-panel"]',
    '[class*="autocomplete-list"]',
    '[class*="suggestion-list"]'
    ,'[class*="phoenix-selectList__virtualList-holder-inner"]'
    ,'.constant-main-selector-container'
    ,'.area-selector-container'
    ,'.mFormSelect ul'
    ,'.mFormCity ul'
  ].join(",");

  const OVERLAY_ITEM_SELECTOR = [
    "li",
    "td",
    "button",
    ".my-button",
    "a",
    "[role]",
    '[class*="option"]',
    '[class*="item"]',
    '[class*="cell"]',
    '[class*="day"]',
    '[class*="date"]',
    '[class*="suggest"]'
  ].join(",");

  function isFeishuMonthRangeOverlay(overlay) {
    return isFeishuJobsPage() && !!overlay?.matches?.('.atsx-date-picker-period-month-panel');
  }

  // 飞书招聘站点的顶栏会常驻一个 role=menu 的“社招内推／校招内推”导航。
  // 它不是某个表单控件打开的候选层。把这类导航从选择器事务中排除，分区
  // 填写时就只会等待刚刚打开的真实下拉、联想或日期面板。
  function isFeishuNavigationLayer(node) {
    if (!isFeishuJobsPage() || !node) return false;
    if (node.closest?.('header,nav,[role="navigation"]')) return true;
    const navText = /^(?:社招内推|校招内推|社会招聘|校园招聘|职位搜索|首页)+$/;
    for (let current = node, depth = 0; current && depth < 6; current = current.parentElement, depth += 1) {
      const text = tidyLabel(current.innerText || current.textContent || '').replace(/\s+/g, '');
      const hasFormControl = !!current.querySelector?.('input,textarea,select,[contenteditable="true"]');
      if (!hasFormControl && navText.test(text)) return true;
    }
    return false;
  }

  function isInsideFeishuMonthRangePicker(node) {
    if (!isFeishuJobsPage()) return false;
    for (let parent = node; parent && parent !== document.body && parent !== document.documentElement;
         parent = parent.parentElement) {
      if (isFeishuMonthRangeOverlay(parent)) return true;
    }
    return false;
  }

  function collectOverlayItems(seen) {
    const items = [];
    const numericLabels = new Set();
    let overlays;
    try {
      overlays = [...document.querySelectorAll(OVERLAY_SELECTOR), ...(activeLayer ? [activeLayer] : [])];
    } catch (_) {
      return items;
    }
    // 部分 Moka 下拉直接在当前输入框旁边展开，不带 popup/listbox 类名。
    // 聚焦控件附近出现至少两个独立、可见的短选项时，将这个局部容器作为
    // 候选层采集；距离限制避免把整张表单当成下拉菜单。
    if (isMokaFormPage()) {
      for (const input of document.querySelectorAll('input[placeholder="请选择"]')) {
        for (let parent = input.parentElement, depth = 0; parent && depth < 4;
             parent = parent.parentElement, depth += 1) {
          const choices = [...parent.querySelectorAll('div,span,li')].filter(node =>
            node !== parent && isVisible(node) && !node.querySelector('div,span,li,input') &&
            /^(?:是|否|有|无|接受|不接受)$/.test(tidyLabel(node.textContent || '')));
          if (choices.length >= 2) { overlays.push(parent); break; }
        }
      }
    }

    overlays.forEach((overlay) => {
      if (overlay === document.body || overlay === document.documentElement) return;
      if (activeLayer && overlay !== activeLayer && !activeLayer.contains(overlay)) return;
      if (isFeishuNavigationLayer(overlay)) return;
      if (!isVisible(overlay)) return;
      const r = overlay.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (overlay.matches('[class*="phoenix-selectList"]') && !notOccluded(overlay,r)) return;
      if (isFeishuMonthRangeOverlay(overlay)) return;

      let candidates;
      try {
        candidates = overlay.querySelectorAll(`${OVERLAY_ITEM_SELECTOR},div,span,p`);
      } catch (_) {
        return;
      }

      let taken = 0;
      candidates.forEach((el) => {
      // Moka 的年份下拉一次会把约 200 个年份都挂进 DOM。前 40 项通常是
      // 未来年份，截断后会让 2021/2025 等真实目标永远不可见。
      if (taken >= 250) return;
        if (el.closest(".am-picker-col")) return;
        if (seen.has(el)) return;
        const calendarCell = el.closest('td');
        if (calendarCell && el !== calendarCell) return;
        if (isInsideFeishuMonthRangePicker(el)) return;
        // 已选的“至今”显示在日期输入框内部；它是字段值，不是打开的候选项。
        if (isFeishuJobsPage() && el.closest('.atsx-date-picker-period-month-label')) return;
        // 只取最内层可点条目：自身不再包含其它候选条目
        if (!calendarCell && !el.matches('button,[role="button"]') && el.querySelector(OVERLAY_ITEM_SELECTOR)) return;
        if (!isVisible(el)) return;
        const ownText = ((el.innerText || el.textContent || "").trim() ||
          (el.matches('button,[role="button"]') ? deriveLabel(el) : '')).replace(/\s+/g, " ");
        if (!ownText || ownText.length > 60) return;
        // 同一个虚拟下拉可能同时保留两份渲染列表。年份/月数字项按文本去重，
        // 让目标年份能在单次快照的元素预算内出现。
        if (/^\d{1,4}$/.test(ownText) && !el.closest('td')) {
          if (numericLabels.has(ownText)) return;
          numericLabels.add(ownText);
        }
        const er = el.getBoundingClientRect();
        if (er.width === 0 || er.height === 0) return;
        seen.add(el);
        taken += 1;
        const item = { el, label: ownText, disabled: el.getAttribute("aria-disabled") === "true" ||
          !!calendarCell?.classList.contains('disabled') };
        const cell = calendarCell;
        const titledDate = cell?.getAttribute('title')?.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
        if (titledDate) item.calendarDate = `${titledDate[1]}-${titledDate[2].padStart(2,'0')}-${titledDate[3].padStart(2,'0')}`;
        if (cell && /^\d{1,2}$/.test(ownText)) {
          const table = cell.closest('table');
          const panel = table?.parentElement?.parentElement?.parentElement;
          const header = Array.from(panel?.querySelectorAll('button,.el-date-picker__header-label') || [])
            .map(button => tidyLabel(button.textContent || button.getAttribute('aria-label') || ''));
          const year = header.map(label => label.match(/^(\d{4})\s*年$/)).find(Boolean)?.[1];
          const month = header.map(label => label.match(/^(\d{1,2})\s*月$/)).find(Boolean)?.[1];
          if (year && month && table) {
            const cells = Array.from(table.querySelectorAll('td')).filter(node => /^\d{1,2}$/.test(tidyLabel(node.textContent || '')));
            const firstDay = cells.findIndex(node => tidyLabel(node.textContent || '') === '1');
            const position = cells.indexOf(cell);
            const day = Number(ownText);
            const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
            if (firstDay >= 0 && position >= firstDay && position < firstDay + daysInMonth &&
                !cell.classList.contains('prev-month') && !cell.classList.contains('next-month') &&
                day >= 1 && day <= daysInMonth) {
              item.calendarDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
          }
        }
        items.push(item);
      });
    });

    return items;
  }

  // 单次快照的最大控件数：防止长表单把请求撑爆
  // Moka 的年份浮层约有 200 个候选，同时页面本身可能有上百个重复经历控件。
  // 快照只在本地用于绑定动作，发送给 Jev 的仍是裁剪后的动作候选，因此这里保留
  // 足够的主表单结构，避免打开年份下拉后把记录锚点挤出快照并误触“添加”。
  const MAX_ELEMENTS = 360;

  // 原生可交互元素。采集与"页面结构体检"共用同一份定义，避免两处判定不一致。
  const INTERACTIVE_SELECTOR = [
    '.layui-layer-btn a',
    '.set-wrap',
    '.mFormRadio li',
    '.phoenix-radio',
    '.my-button',
    'input:not([type="hidden"])',
    "textarea",
    "select",
    "button",
    '[role="button"]',
    '[role="combobox"]',
    AM_LIST_SELECT_SELECTOR,
    '[role="listbox"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="treeitem"]',
    '[role="switch"]',
    "a[href]",
    '[contenteditable="true"]'
  ].join(",");

  // 只认真正承载"选项列表"的容器。刻意不含 [role=dialog]：
  // 简历表单本身就可能整个渲染在弹窗里，把整页标成浮层会误导决策。
  const POPUP_CONTAINER_SELECTOR = [
    '.mc-select-popup',
    '.am-picker-popup',
    '.searchInputComponent',
    '.el-dialog',
    '.constant-main-selector-container',
    '.area-selector-container',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="tree"]',
    '[role="grid"]',
    '[role="treegrid"]'
    ,'[class*="dropdown"]'
    ,'.searchInputComponent'
    ,'.el-picker-panel'
    ,'.ant-calendar'
    ,'.ant-picker-dropdown'
    ,'.mFormSelect ul'
    ,'.mFormCity ul'
  ].join(",");

  function inPopupContainer(el) {
    try {
      if (isFeishuNavigationLayer(el)) return false;
      const surface=el.closest(POPUP_CONTAINER_SELECTOR);
      return !!surface && !(surface.matches('.el-dialog') && isRecordEditorSurface(surface));
    } catch (_) {
      return false;
    }
  }

  // 勾选框/单选框常做成"原生 input 被藏起来 + 可见的 label 当皮肤"。
  // 这种控件如果直接略过，页面上明明有"男/女"可选，扩展却永远填不上。
  // 办法是找到那个可见的 label 当点击代理：点 label 原生就会转发到 input。
  const PROXY_ROLES = new Set(["checkbox", "radio"]);

  function visibleRect(el) {
    if (!isVisible(el)) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return r;
  }

  function resolveVisibleProxy(el) {
    if (!PROXY_ROLES.has(deriveRole(el))) return null;
    const candidates = [labelFor(el), el.closest("label")];
    // 有些组件把皮肤做成 [role=checkbox] 的容器，label 反而是它的兄弟
    candidates.push(el.closest('[role="checkbox"],[role="radio"]'));

    for (const cand of candidates) {
      if (!cand || cand === el) continue;
      // 容器里如果还嵌着"别的"控件，点它容易误触；
      // 只允许它包含当前这一个控件（包裹式 label 的常见结构）。
      let hasOther = false;
      for (const other of cand.querySelectorAll("input,select,textarea")) {
        if (other !== el) {
          hasOther = true;
          break;
        }
      }
      if (hasOther) continue;
      const r = visibleRect(cand);
      if (r) return { proxy: cand, rect: r };
    }
    return null;
  }

  // 单选按钮的可见标签通常只有“是/否”，真正的问题写在同一题目的父容器里。
  // 这里在本地把题意压缩成固定规则标记；快照不会携带父容器原文，避免把无关表单文本
  // 发送给决策模型。
  const AGREEMENT_CONTEXT_RE = /(同意|接受|已阅读|已阅知).{0,36}(协议|隐私|条款|政策|声明)|(协议|隐私|条款|政策|声明).{0,36}(同意|接受|已阅读|已阅知)/;
  const RELATIVE_EMPLOYMENT_CONTEXT_RE = /(亲属|亲戚|直系亲属|家庭成员).{0,48}(本公司|公司|单位|任职|工作)|(本公司|公司|单位).{0,48}(亲属|亲戚|直系亲属|家庭成员)/;
  const JOB_ADJUSTMENT_CONTEXT_RE = /(是否|能否|可否)?.{0,12}(接受|服从|同意).{0,12}(岗位|职位)?.{0,8}调剂|(岗位|职位).{0,8}调剂/;

  function formRuleSignals(el) {
    let node = el;
    let agreement = false;
    let relativeEmployment = false;
    let jobAdjustment = false;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const raw = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 240) continue;
      agreement = agreement || AGREEMENT_CONTEXT_RE.test(raw);
      relativeEmployment = relativeEmployment || RELATIVE_EMPLOYMENT_CONTEXT_RE.test(raw);
      jobAdjustment = jobAdjustment || JOB_ADJUSTMENT_CONTEXT_RE.test(raw);
      if (agreement && relativeEmployment && jobAdjustment) break;
    }
    const signals = [];
    if (agreement) signals.push("agreement");
    if (relativeEmployment) signals.push("relative-employment");
    if (jobAdjustment) signals.push("job-adjustment");
    return signals;
  }

  // 卡片式可点容器的识别口径：鼠标变手型 + 有可见文字 + 尺寸像个按钮/行 +
  // 内部没有原生可交互元素（有的话我们已经在采集那些子元素，父容器只是重复项）。
  // 纯函数便于单测：真实布局算不出来的环境（jsdom）里也能直接验证判定逻辑。
  const CARD_TAG_SELECTOR = "div,li,section,article,td,label,p";
  const MAX_CARDS = 20;

  function looksLikeCard(info) {
    if (info.hidden) return false;
    if (!info.text) return false;
    if (info.width < 40 || info.height < 20) return false;
    if (info.hasInteractiveDescendant) return false;
    // 可点证据二选一：
    //   强 —— 手型光标或自带 onclick
    //   弱 —— 像一行的文本块。移动端框架（Ant Design Mobile 这类）常不设 cursor，
    //        光看样式会把整页判成不可点，所以这一档也得收。
    return info.clickSignal || info.rowSignal;
  }

  // allowWeak=false 时只收强信号（手型光标 / onclick）；
  // 只有在整页一个可交互元素都没采到的情况下才打开弱信号，
  // 否则表单页里的标签、说明文字会被整片当成卡片灌进元素表。
  function collectClickableCards(roots, seen, interactiveSelector, allowWeak) {
    const candidates = [];
    for (const root of roots) {
      let all;
      try {
        all = root.querySelectorAll(CARD_TAG_SELECTOR);
      } catch (_) {
        continue;
      }
      for (const el of all) {
        if (seen.has(el)) continue;
        if (el.closest('.el-picker-panel td')) continue;
        if (el.closest('.phoenix-radio,.ud__select,.ud__picker,.throne-biz-date-range-picker-input')) continue;
        // 飞书的选择控件把可见的“请选择／当前值”包在 role=combobox 内。
        // 它已经由控件采集器提供统一的 custom-select 条目；不再把内部展示层
        // 额外收为卡片，后续的“添加语言／项目／获奖”入口就不会被这些重复项挤出预算。
        if (isFeishuJobsPage() && el.closest('[role="combobox"]')) continue;
        const feishuFormItem = isFeishuJobsPage() && el.closest('.atsx-form-item');
        if (feishuFormItem && !/^(?:\+\s*)?(?:添加|新增)(?:新的)?$/.test((el.innerText || el.textContent || '').trim()) &&
            feishuFormItem.querySelector('input,textarea,[role="combobox"]')) continue;
        const r = el.getBoundingClientRect();
        let cs;
        try {
          cs = window.getComputedStyle(el);
        } catch (_) {
          continue;
        }
        const text = (el.innerText || el.textContent || "").trim();
        const ok = looksLikeCard({
          clickSignal: cs.cursor === "pointer" || !!el.getAttribute("onclick"),
          // 弱信号只在"整页一个控件都没采到"时打开，且必须命中入口关键字，
          // 否则会把普通文字块（标签、说明）整片当成可点卡片灌进元素表。
          // 命中"未完成/去完善/编辑/添加/必填"这类文案的，才像真正的入口行。
          rowSignal: text.length <= 40 && r.height <= 120 && r.width >= 100 &&
            (allowWeak && ENTRY_KEYWORD_RE.test(text) ||
              /(?:教育|工作|实习|项目|校园|语言|技能|奖励|荣誉|附件|个人信息|求职意向).{0,16}(?:添加|新增|编辑|完善|填写|未完成)/.test(text) ||
              /^(?:\+\s*)?(?:添加|新增)(?:新的)?$/.test(text) &&
                /(?:教育|工作|实习|项目|语言|奖励|荣誉|获奖|家庭|自我评价|自我描述)/.test(el.parentElement?.textContent || '')),
          hidden: !isVisible(el),
          text,
          width: r.width,
          height: r.height,
          hasInteractiveDescendant: !!el.querySelector(interactiveSelector)
        });
        if (!ok) continue;
        candidates.push({el,text});
      }
    }
    const priority = ({text}) => /^(?:\+\s*)?(?:添加|新增)(?:新的)?(?:教育|实习|工作|项目|语言|奖励|获奖|家庭|自我评价|自我描述)/.test(text) ? 3 :
      /(?:教育|工作|实习|项目|校园|语言|技能|奖励|荣誉|获奖|附件|个人信息|求职意向|自我评价|自我描述).{0,16}(?:添加|新增|编辑|完善|填写|未完成)/.test(text) ? 2 : 1;
    candidates.sort((left,right) => priority(right)-priority(left));
    const chosen = [];
    for (const {el} of candidates) {
      if (chosen.length >= MAX_CARDS) break;
      if (chosen.some(card => card.contains(el) || el.contains(card))) continue;
      chosen.push(el);
    }
    return chosen;
  }

  function buildElementTable() {
    const interactiveSelector = INTERACTIVE_SELECTOR;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inView = [];
    const offView = [];
    let domOrder = 0;
    elementRegistry = [];
    elementStateRegistry = [];
    elementMetaRegistry = [];
    const seen = new Set();
    const feishuRangeContainers = new Set();
    hiddenFiltered = 0;
    zeroSizeFiltered = 0;
    visibilityCache = new Map();
    labelForCache = null;
    activeLayer = focusedEditorLayer();
    buildSectionMarkers();
    const roots = collectRoots(document, [], 0);

    // stateEl：读取状态（checked / selected / options / aria-expanded）的节点
    // opts.targetEl：真正被点击的节点。代理场景下二者不同（如隐藏的原生 checkbox + 可见的 label）
    function pushEntry(stateEl, opts) {
      // “日期或至今”控件的展示输入与真实日历输入共享一个字段。
      // 保留日历输入作为唯一操作目标，展示代理不占用记录序号。
      if (stateEl?.closest?.('.apply-form-date-now__ipt') &&
          Array.from(stateEl.closest('.apply-form-date-now')?.querySelectorAll('.el-date-editor input') || []).some(isVisible)) return;
      const role = opts.role;
      const kind = opts.kind;
      const targetEl = opts.targetEl || stateEl;
      const entry = {
        index: "0",
        domOrder: domOrder++,
        role,
        kind,
        label: opts.label,
        value: stateEl?.closest?.('.apply-form-date-now')?.querySelector('.apply-form-date-now__ipt input')?.value === '至今' ? '至今' : opts.value,
        operations: opts.operations
      };
      const dateInput = stateEl?.matches?.('input') ? stateEl : stateEl?.querySelector?.('input');
      const datePlaceholder = tidyLabel(dateInput?.getAttribute?.('placeholder') || '');
      if (kind === 'date' && (String(dateInput?.getAttribute?.('type') || '').toLowerCase() === 'month' ||
          /^(?:开始月|结束月|入学月|毕业月|年月|YYYY-MM)$/.test(datePlaceholder))) {
        entry.datePrecision = 'month';
      }
      if (observedMonthControls.has(stateEl) || (dateInput && observedMonthControls.has(dateInput))) entry.datePrecision='month';
      entry.pickerBranch = opts.context === 'popup' && !!(stateEl?.hasAttribute?.('aria-expanded') ||
        stateEl?.querySelector?.('[class*="youcejiantou"]') ||
        Array.from(stateEl?.parentElement?.children || []).some(peer=>peer!==stateEl && peer.querySelector?.('[class*="youcejiantou"]'))) &&
        String(opts.label || '').length < 24;
      entry.widgetFamily = widgetDrivers.classify({
        kind, role, tagName: stateEl?.tagName, editable: stateEl ? isEditableEl(stateEl) : false
      });
      if (['input','textarea','combobox'].includes(kind) && stateEl?.matches?.('input,textarea') &&
          stateEl.closest('.form-item--phoenix')) entry.textCommitMode='page-world';
      const repeaterSection = repeaterSectionFromLabel(opts.label);
      const section = opts.section || repeaterSection || sectionForElement(targetEl || stateEl);
      if (section) entry.section = section;
      // 飞书的自我评价 textarea 常只有通用占位“请输入”，字段标题位于分区头部。
      // 该分区仅承载这一项文本，因此使用分区标题恢复稳定字段语义。
      if (isFeishuJobsPage() && /^(?:请输入|请填写)$/.test(String(entry.label || '').trim()) &&
          /^(?:自我评价|自我描述)$/.test(section || '')) entry.label = section;
      const dateSlot = localDateSlot(stateEl);
      if (dateSlot !== null) entry.dateSlot = dateSlot;
      let mokaRequired = false;
      if (isMokaFormPage() && stateEl) {
        let node = stateEl.parentElement;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const controls = node.querySelectorAll('input,textarea,select').length;
          const caption = Array.from(node.children).find(child => !child.contains(stateEl) &&
            (/\*/.test(String(child.innerText || child.textContent || '').slice(0, 120)) ||
              !!child.querySelector?.('[class*="required"]')));
          if (controls <= 3 && caption) { mokaRequired = true; break; }
          if (controls > 3) break;
        }
      }
      let localRequired = !!stateEl?.closest?.('.el-form-item.is-required,.ant-form-item-required,[aria-required="true"]');
      const formilyRow = stateEl?.closest?.('.ud-formily-item');
      const formilyCaption = formilyRow && Array.from(formilyRow.querySelectorAll('.ud-formily-item-label')).find(node =>
        node.closest('.ud-formily-item') === formilyRow);
      if (formilyCaption && /[*＊]/.test(formilyCaption.textContent || '')) localRequired = true;
      if (stateEl?.matches?.('input,textarea,select')) {
        for (let node = stateEl.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
          if (node.querySelectorAll('input:not([type="hidden"]),textarea,select').length > 3) break;
          const captions = Array.from(node.children).filter(child => !child.contains(stateEl));
          if (captions.some(child => /(?:^\s*[*＊]|[*＊]\s*$)/.test(String(child.innerText || child.textContent || '')) ||
              /^(?:\*|＊)$/.test(tidyLabel(child.textContent || '')) ||
              child.matches('.is-required,[class*="required"],[class*="bitian"]') ||
              child.querySelector('.ant-form-item-required,.is-required,[aria-required="true"],[class*="required"]'))) {
            localRequired = true;
            break;
          }
        }
      }
      if (stateEl.required || stateEl.getAttribute('aria-required') === 'true' ||
          stateEl.closest('.my-list-item')?.querySelector('.header-title .icon-bitian') ||
          mokaRequired || localRequired) entry.required = true;
      if (isBeisenFormPage() && stateEl) {
        const error=stateEl.closest('.form-item')?.querySelector('.form-item__error');
        if (error && isVisible(error) && tidyLabel(error.textContent || '')) {
          entry.validationError=tidyLabel(error.textContent || '').slice(0,100);
        }
      }
      if (opts.context) entry.context = opts.context;
      if ((kind === 'date' && stateEl?.closest?.('.ud__picker')) ||
          opts.context === 'popup' && stateEl?.closest?.('.ud__picker-dropdown')) {
        entry.clickMode = 'trusted-pointer';
      }
      if (opts.calendarDate) entry.calendarDate = opts.calendarDate;
      if (kind==='custom-select' && stateEl?.closest?.('.phoenix-select') ||
          opts.context==='popup' && activeLayer && transactionTrigger?.closest?.('.phoenix-select') &&
          !stateEl.closest('.constant-main-selector-container,.area-selector-container')) {
        entry.clickMode='trusted-pointer';
      }
      if (opts.formRuleSignals && opts.formRuleSignals.length) entry.formRuleSignals = opts.formRuleSignals;
      if (opts.offscreen) entry.offscreen = true;
      if (opts.viaProxy) entry.viaProxy = true;
      // name 属性是 ATS 表单里语义信号最强的一路信息（name="nativePlace" / name="email"），
      // 页面上可见的文案未必写全，把它一起交给 Jev 能明显提高匹配准确率
      if (stateEl && stateEl.getAttribute) {
        const nm = stateEl.getAttribute("name");
        if (nm && nm.trim()) entry.name = nm.trim().slice(0, 60);
        else if (stateEl.matches('input[type="text"]')) {
          const hiddenName = stateEl.closest('.mFormSelect,.mFormCity')?.querySelector('input[type="hidden"][name]')?.name;
          if (hiddenName) entry.name = hiddenName.slice(0, 60);
        }
        const placeholder = stateEl.getAttribute("placeholder");
        if (placeholder && placeholder.trim()) entry.placeholder = tidyLabel(placeholder);
        // Moka 的学校/专业联想框在搜索时会把关键词写进 input.value，
        // 真正选中后才会在控件容器里渲染独立的展示文本。两种状态必须分开。
        if (isMokaFormPage() && kind === 'combobox' &&
            /(?:就读学校|学校|专业)/.test(String(placeholder || ''))) {
          // 搜索时 input.value 本身就是关键词，祖先文本也会包含它，不能据此认定已选中。
          // Moka 只有提交选项后才会在 input 同级渲染一个独立的展示节点。
          const displayNodes = [];
          for (let node = stateEl.previousElementSibling; node; node = node.previousElementSibling) {
            if (!/icon/i.test(String(node.className || ''))) displayNodes.push(node);
          }
          entry.valueCommitted = !!entry.value && displayNodes.some(node => {
            const text = normalizeTextForDom(tidyLabel(node.innerText || node.textContent || ''));
            const value = normalizeTextForDom(entry.value);
            return text === value || (value.length >= 2 && text.includes(value));
          });
        }
      }
      if (stateEl && (role === "checkbox" || role === "radio")) {
        entry.checked = stateEl.getAttribute('aria-checked') === 'true' || stateEl.checked === true;
        if (role === 'radio') {
          const group=stateEl.closest('[role="radiogroup"],.ud__radio-group,.phoenix-radio-group,.ud-formily-item,fieldset');
          if (group) entry.choiceGroup=`radio-group-${Array.from(document.querySelectorAll(
            '[role="radiogroup"],.ud__radio-group,.phoenix-radio-group,.ud-formily-item,fieldset')).indexOf(group)}`;
        }
      }
      if (kind === 'custom-radio') {
        entry.checked = entry.checked === true || stateEl.classList.contains('cur') || stateEl.classList.contains('phoenix-radio--checked') ||
          stateEl.getAttribute('aria-checked') === 'true';
        entry.optionValue = tidyLabel(stateEl.textContent || '');
      }
      if (stateEl?.matches('input[type="radio"]')) {
        entry.optionValue = String(stateEl.value || "").slice(0, 40);
      }
      if (stateEl && role === "option" && stateEl.selected !== undefined) {
        entry.selected = stateEl.selected;
      }
      if (targetEl) {
        const expanded = targetEl.getAttribute("aria-expanded");
        if (expanded) entry.expanded = expanded === "true";
        if (targetEl.disabled || targetEl.getAttribute("aria-disabled") === "true") entry.disabled = true;
      }
      if (stateEl && stateEl.disabled === true) entry.disabled = true;
      if (opts.disabled) entry.disabled = true;
      if (stateEl?.closest?.('.layui-layer-btn') && /^(确定|保存)$/.test(tidyLabel(stateEl.textContent))) entry.recordCommit = true;

      if (stateEl && role === "combobox" && stateEl.tagName === "SELECT") {
        entry.options = Array.from(stateEl.options).slice(0, 30).map((opt, i) => ({
          index: `${entry.index}:${i + 1}`,
          label: opt.text,
          value: opt.value
        }));
      }
      (opts.offscreen ? offView : inView).push({ stateEl, targetEl, entry });
    }

    // 本体不可见时，试着改用一个可见的点击代理（隐藏 checkbox/radio + 可见 label）
    function pushProxyEntry(el, why) {
      const resolved = resolveVisibleProxy(el);
      if (!resolved) {
        if (why === "hidden") hiddenFiltered += 1;
        else zeroSizeFiltered += 1;
        return false;
      }
      seen.add(el);
      seen.add(resolved.proxy);
      const role = deriveRole(el);
      const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
      const signals = formRuleSignals(el);
      const ownOption = tidyLabel(resolved.proxy.textContent || '').replace(/^[*\s]+/, '');
      const label = signals.includes("agreement") ? "同意招聘协议" :
        role === 'radio' && ownOption && ownOption.length <= 20 ? ownOption : deriveLabel(resolved.proxy);
      pushEntry(el, {
        role,
        kind: role === 'radio' ? 'custom-radio' : 'custom-checkbox',
        label,
        value: "",
        operations: disabled ? [] : ["CLICK"],
        formRuleSignals: signals,
        disabled: disabled || undefined,
        targetEl: resolved.proxy,
        viaProxy: true,
        context: inPopupContainer(el) ? "popup" : undefined,
        offscreen: !inViewport(resolved.rect, vw, vh)
      });
      return true;
    }

    roots.forEach((root) => {
      root.querySelectorAll(interactiveSelector).forEach((el) => {
        if (activeLayer && !activeLayer.contains(el)) return;
        if (seen.has(el)) return;
        // Element UI 联想框的外层 div 带 combobox 语义，内部 input 才是真正
        // 可输入的控件。只采集 input，保留 TYPE_TEXT → 候选选择事务。
        if (el.matches?.('.el-autocomplete[role="combobox"]') &&
            el.querySelector('input')) {
          seen.add(el);
          return;
        }
        // 飞书的学校检索器把真正可写的 input 套在 role=combobox 容器里。
        // 采集内层输入框即可形成“填写关键词 → 选择结果”的单一事务。
        if (isFeishuJobsPage() && el.matches?.('[role="combobox"]')) {
          // 飞书经常在 combobox 中保留一个零尺寸的 React 状态 input；它并不是
          // 用户可操作的输入框。只有内层确实可见且有尺寸时，才由内层输入承接
          // 扫描；否则保留 combobox 本身，作为学历、语言等选择器的点击目标。
          const visibleEditor = Array.from(el.querySelectorAll('input:not([type="hidden"]),textarea'))
            .find(node => {
              if (!isVisible(node)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          if (visibleEditor) {
            seen.add(el);
            return;
          }
        }
        if (el.matches('input[type="file"]')) {
          seen.add(el);
          const label = fileFieldLabel(el);
          pushEntry(el, {
            role: 'button', kind: 'file', targetEl: el, label, value: fileFieldValue(el),
            operations: isOptionalResumeParser(el) ? [] : ['UPLOAD_FILE'], offscreen: false
          });
          return;
        }
        // 飞书招聘的月份范围输入本身尺寸为 0，却仍由 React 表单承载真实值和
        // 事件。保留该 input 作为执行目标，页面显示的年/月节点仅作视觉层。
        const feishuRange = feishuDateRangeContainer(el);
        if (feishuRange) {
          seen.add(el);
          if (feishuRangeContainers.has(feishuRange)) return;
          feishuRangeContainers.add(feishuRange);
          const rangeRect = feishuRange.getBoundingClientRect();
          pushEntry(el, {
            role:'textbox', kind:'feishu-date-range', targetEl:el,
            label:feishuDateRangeLabel(el), value:getValue(el, 'feishu-date-range'),
            operations:['TYPE_TEXT'],
            offscreen:!inViewport(rangeRect, vw, vh)
          });
          return;
        }
        if (!isVisible(el)) {
          // 藏起来的勾选框往往是"皮肤在外、input 在内"，先看能不能找到可见代理
          pushProxyEntry(el, "hidden");
          seen.add(el);
          return;
        }
        const r = el.getBoundingClientRect();
        // 尺寸为 0 是真不可见；在视口外但可见的字段照样要采集，填表时常需要滚动
        if (r.width === 0 || r.height === 0) {
          pushProxyEntry(el, "zeroSize");
          seen.add(el);
          return;
        }
        seen.add(el);
        const offscreen = !inViewport(r, vw, vh);

        const role = deriveRole(el);
        let kind = deriveKind(el, role);
        const feishuHost = feishuComboboxHost(el);
        const label = feishuHost ? deriveLabel(feishuHost) || deriveLabel(el) : deriveLabel(el);
        // 学校名称通常是“输入关键词 → 选择联想结果”的控件。部分 ATS 没有
        // aria-autocomplete 或专用容器，外观会退化成普通 text input；根据字段
        // 语义将其归入 autocomplete 协议，保证输入后仍会等待候选项确认。
        const schoolLookup = /^(?:学校名称|学校全称|就读学校|毕业院校|院校名称|学校)$/;
        if (kind === 'input' && role === 'textbox' && !el.hasAttribute('readonly') && schoolLookup.test(tidyLabel(label))) {
          kind = 'combobox';
        }
        // 360/北森的年月控件与普通下拉共享 DOM 外形，字段标题才是稳定语义。
        if (isBeisenFormPage() && kind === 'custom-select' &&
            DATE_HINT_RE.test(label)) kind = 'beisen-date';
        const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
        // 浮层里的选项无论走哪条采集路径，都要带上 popup 标记：
        // 它对 Jev 是"点了就消失，要立刻做决定"的信号。
        const isPopupItem = !el.closest('.layui-layer-btn') && !isFeishuNavigationLayer(el) && ["option", "menuitem", "radio", "checkbox", "textbox", "button"].includes(role) &&
          (inPopupContainer(el) || !!activeLayer?.contains(el));
        pushEntry(el, {
          role,
          kind,
          targetEl:kind === 'section-entry' ? el.querySelector('.add-btn') || el : el,
          label,
          value: getValue(el, kind),
          // 禁用的控件不给出任何操作，避免 Jev 选到一个点不动的目标
          operations: disabled ? [] : kind==='date' && el.closest('.ud__picker,.throne-biz-date-range-picker-input') ?
            ['CLICK'] : deriveOperations(role, el, kind),
          context: isPopupItem ? "popup" : undefined,
          formRuleSignals: formRuleSignals(el),
          disabled: disabled || undefined,
          offscreen
        });
      });
    });

    // 卡片式可点容器：部分分段列表页整页只有卡片入口，
    // 每个分段是一张可点的 div，只认原生控件会得到 0 个元素，Jev 无从下手。
    collectClickableCards(roots, seen, interactiveSelector, inView.length + offView.length === 0).forEach((el) => {
      if (activeLayer && !activeLayer.contains(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const label = tidyLabel(el.innerText || el.textContent || '').slice(0, 80);
      const entryMatch = label.match(/^(.{2,24}?)\s*(?:未完成|已完成|去完善|待填写|待完善)$/);
      const entrySection = el.matches('.resume-menu-item') ?
        tidyLabel(el.querySelector('h6')?.textContent || label).replace(/^\*\s*/,'').replace(/\s*(未完成|已完成)$/,'').trim() : entryMatch?.[1]?.trim();
      const sectionEntry = !!entrySection && FORM_SECTION_TITLES.has(entrySection);
      pushEntry(el, {
        role: "button",
        kind: sectionEntry ? "section-entry" : "card",
        label,
        section: sectionEntry ? entrySection : undefined,
        value: "",
        operations: ["CLICK"],
        context: activeLayer?.contains(el) || inPopupContainer(el) ? "popup" : undefined,
        offscreen: !inViewport(r, vw, vh)
      });
    });

    // 滚轮按列采集。全部选项留在本地，避免长年份列表截断目标年。
    Array.from(document.querySelectorAll(".am-picker-col")).filter(isVisible).forEach((el, column) => {
      const selected = el.querySelector(".am-picker-col-item-selected");
      pushEntry(el, { role: "combobox", kind: "picker-column", label: `选择器第${column + 1}列`,
        value: selected?.textContent?.trim() || "", operations: ["SELECT"], context: "popup" });
      const entry = inView[inView.length - 1].entry;
      entry.pickerColumn = column;
      entry.options = Array.from(el.querySelectorAll(".am-picker-col-item")).map((opt, i) => ({
        index: `${entry.index}:${i + 1}`, label: opt.textContent.trim(), value: opt.textContent.trim()
      }));
    });

    // 已打开的浮层条目（下拉选项、日历格子、联想项）
    collectOverlayItems(seen).forEach(({ el, label, disabled, calendarDate }) => {
      pushEntry(el, {
        role: "option",
        kind: "option-item",
        label,
        value: "",
        operations: disabled ? [] : ["CLICK"],
        context: "popup",
        disabled,
        calendarDate
      });
    });

    // Moka 的已选自定义下拉会同时命中外层选择器和内层 input。
    // 二者指向同一个字段，同时保留会让记录计数翻倍，也会让同一值参与两次字段绑定。
    // 对“包含同一 input 的 custom-select + input”只保留外层选择器；
    // 学校/专业的可输入联想框没有 custom-select 外层，仍完整保留。
    const collectedEntries = [...inView, ...offView];
    const duplicateInputs = new Set();
    for (const outer of collectedEntries) {
      if (outer.entry.kind !== 'custom-select' || !outer.stateEl?.querySelector) continue;
      const input = outer.stateEl.querySelector('input:not([type="hidden"])');
      if (input) duplicateInputs.add(input);
    }
    if (duplicateInputs.size) {
      for (const bucket of [inView, offView]) {
        for (let i = bucket.length - 1; i >= 0; i -= 1) {
          const item = bucket[i];
          if (duplicateInputs.has(item.stateEl)) bucket.splice(i, 1);
        }
      }
    }

    // 日期子控件的语义由 DOM 顺序决定。先在完整 DOM 顺序上标注，再做视口优先排序；
    // 这样执行器滚动某个年份控件后，它不会因为变成“视口内第一项”而从毕业年份漂移成入学年份。
    const allEntriesInDomOrder = [...inView, ...offView].sort((a, b) =>
      (a.entry.domOrder ?? 0) - (b.entry.domOrder ?? 0));
    annotateMokaRecordMetadata(allEntriesInDomOrder);
    platformDrivers.annotateRecords(allEntriesInDomOrder, location.hostname, document);
    annotateSemanticRecords(allEntriesInDomOrder);
    annotateRepeatedContainers(allEntriesInDomOrder);
    const dateLabels = {
      '教育背景':['入学年份','入学月份','毕业年份','毕业月份'],
      '教育经历':['入学年份','入学月份','毕业年份','毕业月份'],
      '实习经历':['开始年份','开始月份','结束年份','结束月份'],
      '工作经历':['开始年份','开始月份','结束年份','结束月份'],
      '项目经验':['项目开始年份','项目开始月份','项目结束年份','项目结束月份'],
      '项目经历':['项目开始年份','项目开始月份','项目结束年份','项目结束月份'],
      '获奖经历':['获奖年份','获奖月份']
    };
    const dateEntriesBySection = new Map();
    for (const item of allEntriesInDomOrder) {
      const { stateEl, entry } = item;
      const dateInput = stateEl?.matches?.('input') ? stateEl : stateEl?.querySelector?.('input[placeholder="年"],input[placeholder="月"]');
      const unit = tidyLabel(dateInput?.getAttribute?.('placeholder') || entry.placeholder || '');
      const selectedNumber = entry.context !== 'popup' && entry.kind === 'custom-select' && /^\d{1,4}$/.test(String(entry.value || entry.label || '').trim());
      if (!dateLabels[entry.section] || (unit !== '年' && unit !== '月' && entry.dateSlot === undefined && !selectedNumber)) continue;
      if (!dateEntriesBySection.has(entry.section)) dateEntriesBySection.set(entry.section, []);
      dateEntriesBySection.get(entry.section).push(item);
    }
    for (const [section, items] of dateEntriesBySection) {
      const labels = dateLabels[section];
      items.forEach(({entry}, position) => {
        const slot = Number.isInteger(entry.dateSlot) ? entry.dateSlot : position % labels.length;
        entry.label = labels[slot];
      });
    }
    annotateFieldGroups(allEntriesInDomOrder);

    // 控件身份沿完整 DOM 顺序生成，滚动和浮层预算只改变展示顺序。
    for (const {entry,stateEl,targetEl} of allEntriesInDomOrder) {
      entry.documentId = documentId;
      const editor=stateEl?.closest?.('[role="dialog"],.el-dialog,.ant-modal,[class*="drawer"]');
      entry.surfaceId = nodeId(editor && isRecordEditorSurface(editor) ? editor : stateEl?.closest?.('form') || document.documentElement);
      entry.nodeKey = nodeId(entry.kind === 'custom-select' ? stateEl?.closest?.('.phoenix-select') || stateEl || targetEl : stateEl || targetEl);
      entry.stableKey = widgetDrivers.stableKey(entry,entry.nodeKey);
      if (entry.context === 'popup' && transactionTrigger?.isConnected) entry.popupOwnerKey = nodeId(transactionTrigger);
      let record = stateEl?.closest?.('[data-record-id],[data-record-key],.resumeContent,.record-item,.experience-item');
      if (!record && /^(编辑|修改)$/.test(tidyLabel(entry.label))) {
        for (let node=stateEl?.parentElement,depth=0;node && depth<7 && node!==document.body;node=node.parentElement,depth++) {
          const commands=Array.from(node.querySelectorAll('button,a,[role="button"],.resume-btn')).filter(command=>
            /^(编辑|修改)$/.test(tidyLabel(command.textContent || '')));
          if(commands.length>1) break;
          if(commands.length===1 && tidyLabel(node.textContent).length>10) {record=node;break;}
        }
      }
      if (record) entry.recordStableKey = nodeId(record);
      if (/编辑|修改/.test(entry.label || '') && record) entry.summaryText = tidyLabel(record.textContent).slice(0,12000);
      if (stateEl?.maxLength > 0) entry.maxLength = stateEl.maxLength;
    }

    // 视口内的排在前面，超量时优先保留视口内的字段
    const allEntries = [...inView, ...offView];
    const popupEntries = allEntries.filter(({ entry }) => entry.context === "popup");
    const normalEntries = allEntries.filter(({ entry }) => entry.context !== "popup");
    // 打开长下拉时优先保留浮层条目，否则页面前面的普通字段会挤掉目标年份。
    // 浮层优先，但始终给主表单留出结构预算。外层分区调度依赖这些记录锚点，
    // 日期浮层不能让网页已有记录“消失”。
    const popupBudget = Math.min(260, popupEntries.length);
    const normalBudget = Math.max(100, MAX_ELEMENTS - popupBudget);
    const ordered = popupEntries.length
      ? [...popupEntries.slice(0, popupBudget), ...normalEntries.slice(0, normalBudget)].slice(0, MAX_ELEMENTS)
      : allEntries.slice(0, MAX_ELEMENTS);
    const out = [];
    for (const { stateEl, targetEl, entry } of ordered) {
      entry.index = String(out.length + 1);
      if (entry.options) {
        entry.options = entry.options.map((opt, i) => ({ ...opt, index: `${entry.index}:${i + 1}` }));
      }
      out.push(entry);
      // 注册的是"点击目标"：代理场景下是那个可见的 label，点它原生就会转发给隐藏的 input
      elementRegistry.push(targetEl);
      elementStateRegistry.push(stateEl);
      elementMetaRegistry.push(entry);
    }

    return out;
  }

  // 模板壳和兼容性提示会落在 body.innerText 里，但它们不属于当前表单语义。
  // 例如许多 React 站点会在 <noscript> 放入 "You need to enable JavaScript…"。
  // Jev 只接收已经渲染、面向求职者的页面文本，避免把这类静态兜底内容当成现场状态。
  const PAGE_TEXT_SKIP_SELECTOR = "noscript,script,style,template,#ietips,[data-jev-ignore='true']";

  function getPageText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest(PAGE_TEXT_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(p)) {
          return NodeFilter.FILTER_REJECT;
        }
        const t = node.textContent.trim();
        if (t.length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const chunks = [];
    let node;
    while ((node = walker.nextNode()) && chunks.join(" ").length < 8000) {
      chunks.push(node.textContent.trim());
    }
    return chunks.join(" ").slice(0, 8000);
  }

  // 页面指纹：判断"决策之后、执行之前"页面有没有变过。
  // React/Vue 重渲染、动画结束、浮层自动收起都会让元素表失效，
  // 拿过期的索引去点就会点错元素。只做轻量统计，不建完整元素表。
  function computeFingerprint() {
    let payload = location.href;
    try {
      document
        .querySelectorAll('input,select,textarea,button,[role="button"],[role="option"],[role="combobox"]')
        .forEach((el) => {
          payload += `|${String(el.value || "")}:${el.checked ? 1 : 0}`;
        });
    } catch (_) {}
    payload += document.body ? (document.body.innerText || document.body.textContent || "") : "";
    document.querySelectorAll('.am-picker-col-item-selected,[aria-selected="true"]').forEach(el => {
      payload += `|selected:${el.textContent}`;
    });
    let hash = 2166136261;
    for (let i = 0; i < payload.length; i++) hash = Math.imul(hash ^ payload.charCodeAt(i), 16777619);
    return String(hash >>> 0);
  }

  // 诊断信息：判断"控件找不到"是页面没加载对、还是有进不去的 iframe / 关不掉的 shadow root
  function collectDiagnostics() {
    const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => ({
      src: (f.getAttribute("src") || "").slice(0, 120),
      id: f.id || "",
      title: f.getAttribute("title") || "",
      sameOrigin: (() => {
        try {
          return !!f.contentDocument;
        } catch (_) {
          return false;
        }
      })()
    }));

    let openShadowRoots = 0;
    let shadowInputs = 0;
    const suspectedClosed = [];
    let customElements = 0;
    try {
      document.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) {
          openShadowRoots += 1;
          try {
            shadowInputs += el.shadowRoot.querySelectorAll("input,select,textarea").length;
          } catch (_) {}
        }
        const tag = el.tagName.toLowerCase();
        if (tag.includes("-") && tag !== "xmp") {
          customElements += 1;
          if (!el.shadowRoot && el.childElementCount === 0) {
            suspectedClosed.push(tag);
          }
        }
      });
    } catch (_) {
      // 诊断失败不影响主流程
    }

    const inputBreakdown = {};
    try {
      document.querySelectorAll("input,select,textarea").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const type = tag === "input" ? (el.getAttribute("type") || "text") : tag;
        inputBreakdown[type] = (inputBreakdown[type] || 0) + 1;
      });
    } catch (_) {}

    // 只数 input/select/textarea 会漏掉两类页面：
    // 一是 SPA 还没渲染完（DOM 里确实什么都没有），二是表单用 div + role 伪装（压根没有原生控件）。
    // 诊断时把宽松口径一起报出来，才能分清是"页面没加载"还是"控件类型没认出来"。
    let looseControls = 0;
    const looseBreakdown = {};
    try {
      document
        .querySelectorAll(
          '[contenteditable="true"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="listbox"],[role="spinbutton"]'
        )
        .forEach((el) => {
          looseControls += 1;
          const role = el.getAttribute("role") || "contenteditable";
          looseBreakdown[role] = (looseBreakdown[role] || 0) + 1;
        });
    } catch (_) {}

    const pageText = getPageText();
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      documentFocused: document.hasFocus(),
      editorStructure: activeLayer ? Array.from(activeLayer.querySelectorAll('*')).slice(-8).map(el =>
        `${el.tagName}.${String(el.className)}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}:${isVisible(el)}`
      ) : [],
      isTopFrame: window.top === window,
      iframes,
      openShadowRoots,
      shadowInputs,
      customElements,
      suspectedClosedShadowHosts: [...new Set(suspectedClosed)].slice(0, 10),
      inputs: document.querySelectorAll("input,select,textarea").length,
      inputBreakdown,
      looseControls,
      looseBreakdown,
      bodyTextLength: pageText.length,
      bodyTextHead: pageText.replace(/\s+/g, " ").trim().slice(0, 200)
    };
  }

  // 部分环境（含测试用的 jsdom）没有 scrollIntoView，缺了不该让点击失败
  function safeScrollIntoView(el) {
    if (typeof el.scrollIntoView !== "function") return;
    try {
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    } catch (_) {
      try {
        el.scrollIntoView();
      } catch (_) {}
    }
  }

  // 飞书的“卡片”快照可能覆盖一整条记录，而真实处理器只绑定在字段右侧的
  // combobox 或“添加”文字上。按字段标题收敛到最小可交互后代，才能把浏览器
  // 层的真实指针点击落在用户实际会点击的位置。
  function feishuCardPointerTarget(el, rawLabel = '', fieldLabel = '') {
    if (!el) return null;
    const raw = tidyLabel(rawLabel);
    const normalizedLabel = tidyLabel(fieldLabel || rawLabel).replace(/^添加(?:新的)?/, '');
    const visibleNodes = Array.from(el.querySelectorAll?.('*') || []).filter(isVisible);
    const ownText = node => tidyLabel(Array.from(node.childNodes || [])
      .filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(' '));
    const narrowest = nodes => nodes.sort((left, right) =>
      left.querySelectorAll('*').length - right.querySelectorAll('*').length)[0] || null;
    if (/^(?:添加|新增)/.test(raw || normalizedLabel)) {
      const action = narrowest(visibleNodes.filter(node => /^(?:添加|新增)$/.test(ownText(node)) ||
        /^(?:添加|新增)$/.test(tidyLabel(node.innerText || node.textContent || ''))));
      if (action) return action;
    }
    // 可视选择卡片通常只显示“请选择”。平台层会把它的快照标签恢复成
    // “学历／语言”等字段名；真实指针必须命中这个值槽，而不是左侧标题。
    const unselected = narrowest([el, ...visibleNodes].filter(node =>
      /^(?:请选择|请输入|未填|请选择.+)$/.test(tidyLabel(node.innerText || node.textContent || ''))));
    if (unselected) return unselected;
    const rawText = narrowest([el, ...visibleNodes].filter(node =>
      raw && (ownText(node) === raw || tidyLabel(node.innerText || node.textContent || '') === raw)));
    if (rawText) return rawText;
    const captions = [el, ...visibleNodes].filter(node =>
      tidyLabel(node.innerText || node.textContent || '') === normalizedLabel);
    for (const caption of captions) {
      for (let field = caption.parentElement, depth = 0;
        field && depth < 4 && (field === el || el.contains(field)); field = field.parentElement, depth += 1) {
        const controls = Array.from(field.querySelectorAll(
          '[role="combobox"],input:not([type="hidden"]),textarea,select,button,[tabindex]:not([tabindex="-1"])'
        )).filter(node => node !== caption && isVisible(node) && node.getBoundingClientRect().width > 0);
        if (controls.length) {
          const captionRect = caption.getBoundingClientRect();
          return controls.sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            const leftDistance = Math.abs(leftRect.top - captionRect.bottom) + Math.abs(leftRect.left - captionRect.left) / 8;
            const rightDistance = Math.abs(rightRect.top - captionRect.bottom) + Math.abs(rightRect.left - captionRect.left) / 8;
            return leftDistance - rightDistance;
          })[0];
        }
      }
    }
    if (el.matches?.('[role="combobox"],input,textarea,select,button,[tabindex]:not([tabindex="-1"])')) return el;
    if (!document.elementFromPoint) return el;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return el;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit && (el.contains(hit) || hit.contains(el)) ? hit : el;
  }

  function mokaPopupOptionTarget(el, label) {
    const expected = tidyLabel(label || el?.innerText || el?.textContent || '');
    const candidates = [el, ...Array.from(el?.querySelectorAll?.('*') || [])].filter(node => {
      if (!isVisible(node) || tidyLabel(node.innerText || node.textContent || '') !== expected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    });
    return candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftArea = leftRect.width * leftRect.height;
      const rightArea = rightRect.width * rightRect.height;
      return leftArea - rightArea || left.querySelectorAll('*').length - right.querySelectorAll('*').length;
    })[0] || el;
  }

  function trustedClickPoint(index) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    const meta = elementMetaRegistry[pos] || {};
    if (!el) return {ok:false,reason:`元素 ${index} 不在注册表`};
    if (meta.clickMode !== 'trusted-pointer') {
      return {ok:false,reason:'当前控件不需要真实指针点击'};
    }
    safeScrollIntoView(el);
    const stateEl=elementStateRegistry[pos] || el;
    const phoenixHost=meta.kind==='custom-select' && stateEl.closest?.('.phoenix-select');
    if (meta.context !== 'popup') transactionTrigger=stateEl.closest?.('.phoenix-select') || stateEl;
    const phoenixArrow=phoenixHost && Array.from(phoenixHost.querySelectorAll('.phoenix-select__switchArrow')).find(isVisible);
    const clickTarget = phoenixArrow || (isFeishuJobsPage()
      ? feishuCardPointerTarget(el, meta.clickLabel || meta.label, meta.label)
      : isMokaFormPage() && meta.context === 'popup'
        ? mokaPopupOptionTarget(el, meta.label)
      : el);
    safeScrollIntoView(clickTarget);
    const rect = clickTarget?.getBoundingClientRect?.();
    if (!rect.width || !rect.height || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      return {ok:false,reason:'控件未处于可点击布局'};
    }
    return {
      ok:true,
      clickMode:'trusted-pointer',
      point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2},
      label:meta.label || tidyLabel(clickTarget?.textContent || '')
    };
  }

  function mokaDateNextPoint(index, value) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    const match = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!el || !match) return {ok:false,reason:'Moka 日期目标或日期值无效'};
    if (!isMokaFormPage() || deriveKind(el, deriveRole(el)) !== 'moka-date') {
      return {ok:false,reason:'当前控件不属于 Moka 日期选择器'};
    }
    const expectedMonth = `${match[1]}-${match[2].padStart(2,'0')}`;
    const actual = String(el.value || '').trim();
    if (actual.startsWith(expectedMonth)) return {ok:true,done:true,value:actual};

    // 日期面板由 portal 渲染，并且每一次点击都会替换节点；每一轮都重新读取
    // 可见文本，向后台交出一个需要真实指针点击的单一步骤。
    visibilityCache = new Map();
    const visibleExact = text => Array.from(document.querySelectorAll('body *')).filter(node => {
      if (!isVisible(node) || tidyLabel(node.innerText || node.textContent || '') !== text) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).sort((left,right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length);
    const pointFor = (node,label) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {ok:true,done:false,label,point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}};
    };
    const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    const all = Array.from(document.querySelectorAll('body *')).filter(node => {
      if (!isVisible(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const labels = all.map(node => tidyLabel(node.innerText || node.textContent || ''));
    const header = labels.find(text => /^\d{4}\s*-\s*\d{4}$/.test(text)) ||
      labels.find(text => /^\d{4}\s*年$/.test(text));
    if (!header) return {ok:false,reason:'Moka 日期面板未显示年份标题'};
    const headerNode = visibleExact(header)[0];
    if (/^\d{4}\s*年$/.test(header) && months.filter(month => labels.includes(month)).length >= 3) {
      const shownYear = Number(header.match(/\d{4}/)?.[0]);
      if (shownYear === Number(match[1])) {
        const targetMonth = months[Number(match[2]) - 1];
        return pointFor(visibleExact(targetMonth)[0],targetMonth) ||
          {ok:false,reason:`Moka 日期月份没有可点击坐标：${targetMonth}`};
      }
      return pointFor(headerNode,header) || {ok:false,reason:'Moka 日期年份标题没有可点击坐标'};
    }

    const yearNodes = all.filter(node => /^\d{4}$/.test(tidyLabel(node.innerText || node.textContent || '')))
      .sort((left,right) => left.querySelectorAll('*').length - right.querySelectorAll('*').length);
    const targetYear = String(match[1]);
    const target = yearNodes.find(node => tidyLabel(node.innerText || node.textContent || '') === targetYear);
    if (target) return pointFor(target,targetYear) || {ok:false,reason:'Moka 目标年份没有可点击坐标'};
    if (!/^\d{4}\s*-\s*\d{4}$/.test(header)) {
      return {ok:false,reason:'Moka 年份面板未显示可选年份'};
    }

    const headerRect = headerNode?.getBoundingClientRect();
    let arrows = ['','','',''].flatMap(glyph => visibleExact(glyph))
      .filter((node,pos,nodes) => nodes.indexOf(node) === pos)
      .sort((left,right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftDistance = headerRect ? Math.abs(leftRect.top - headerRect.top) : 0;
        const rightDistance = headerRect ? Math.abs(rightRect.top - headerRect.top) : 0;
        return leftDistance - rightDistance || leftRect.left - rightRect.left;
      });
    if (arrows.length < 2 && headerNode && headerRect) {
      // 有些 Moka 版本把箭头画在 ::before / ::after 中，可访问树有名称而
      // textContent 为空。标题与年份格共同确定弹层后，标题同一行两侧的小
      // 元素就是翻页入口，使用面板内的几何位置可稳定定位它们。
      let panel = headerNode.parentElement;
      while (panel && panel !== document.body) {
        const rect = panel.getBoundingClientRect();
        const panelYears = Array.from(panel.querySelectorAll('*')).filter(node =>
          /^\d{4}$/.test(tidyLabel(node.innerText || node.textContent || ''))).length;
        if (rect.width >= 180 && rect.width <= 520 && rect.height >= 90 && rect.height <= 680 && panelYears >= 4) break;
        panel = panel.parentElement;
      }
      if (panel && panel !== document.body) {
        const panelRect = panel.getBoundingClientRect();
        const headerCenter = headerRect.left + headerRect.width / 2;
        arrows = Array.from(panel.querySelectorAll('*')).filter(node => {
          if (!isVisible(node) || node === headerNode || node.contains(headerNode)) return false;
          const rect = node.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          const centerX = rect.left + rect.width / 2;
          if (rect.width < 6 || rect.height < 6 || rect.width > 96 || rect.height > 72) return false;
          if (Math.abs(centerY - (headerRect.top + headerRect.height / 2)) > 42) return false;
          return centerX < headerCenter - 22 || centerX > headerCenter + 22;
        }).filter((node,pos,nodes) => !nodes.some((other,i) => i < pos && other.contains(node)))
          .sort((left,right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
        // 面板边界检查避免标题同一行其他字段的装饰元素混入。
        arrows = arrows.filter(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1;
        });
      }
    }
    if (arrows.length < 2) return {ok:false,reason:'Moka 日期年份层缺少翻页按钮'};
    const [from,to] = header.match(/\d{4}/g).map(Number);
    const direction = Number(targetYear) < from ? -1 : Number(targetYear) > to ? 1 : 0;
    if (!direction) return {ok:false,reason:'Moka 年份面板没有目标年份'};
    const ordered = arrows.slice(0,2).sort((left,right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
    return pointFor(direction < 0 ? ordered[0] : ordered[ordered.length - 1], direction < 0 ? '上一组年份' : '下一组年份') ||
      {ok:false,reason:'Moka 日期翻页按钮没有可点击坐标'};
  }

  function feishuYearTarget(index) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    if (!el) return {ok:false,reason:`元素 ${index} 不在注册表`};
    if (!isFeishuJobsPage() || deriveKind(el, deriveRole(el)) !== 'feishu-year') {
      return {ok:false,reason:'当前控件不需要飞书年份选择器'};
    }
    safeScrollIntoView(el);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      return {ok:false,reason:'飞书年份框未处于可选择布局'};
    }
    return {
      ok:true,
      inputMode:'feishu-year-picker',
      point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2},
      label:deriveLabel(el)
    };
  }

  function feishuYearChoicePoint(index, year) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    const expected = String(year || '').trim();
    if (!el) return {ok:false,reason:`元素 ${index} 不在注册表`};
    if (!isFeishuJobsPage() || deriveKind(el, deriveRole(el)) !== 'feishu-year' || !/^\d{4}$/.test(expected)) {
      return {ok:false,reason:'当前控件不支持飞书年份网格选择'};
    }
    // 年份面板通过 portal 在输入框点击后才由 hidden 切换到可见。快照阶段会缓存
    // 关闭态的可见性，选择阶段必须重新计算，才能识别刚展开的网格条目。
    visibilityCache = new Map();
    const candidates = Array.from(document.querySelectorAll('body *')).filter(node => {
      if (!isVisible(node) || tidyLabel(node.innerText || node.textContent || '') !== expected) return false;
      if (node === el || node.contains(el) || el.contains(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const choice = candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftChildren = left.querySelectorAll('*').length;
      const rightChildren = right.querySelectorAll('*').length;
      if (leftChildren !== rightChildren) return leftChildren - rightChildren;
      return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
    })[0];
    const rect = choice?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return {ok:false,reason:`飞书年份网格中未找到 ${expected}`};
    return {
      ok:true,
      selectionMode:'feishu-year-picker',
      point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2},
      label:expected
    };
  }

  function feishuRangeState(index) {
    const el = currentFeishuDateRangeElement(index);
    const parts = el && feishuDateRangeParts(el);
    if (!parts) return {ok:false,reason:'飞书日期范围的可见起止槽未找到'};
    return {ok:true,values:parts.values};
  }

  function feishuRangeSlotPoint(index, slot) {
    const el = currentFeishuDateRangeElement(index);
    const parts = el && feishuDateRangeParts(el);
    const target = parts?.labels?.[Number(slot)];
    if (!target || ![0,1].includes(Number(slot))) {
      return {ok:false,reason:'飞书日期范围的目标槽未找到'};
    }
    safeScrollIntoView(target);
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return {ok:false,reason:'飞书日期槽没有可点击尺寸'};
    return {ok:true,point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}};
  }

  function feishuRangeChoicePoint(index, slot, axis, value) {
    const el = currentFeishuDateRangeElement(index);
    const parts = el && feishuDateRangeParts(el);
    if (!parts) return {ok:false,reason:'飞书日期范围目标已变化'};
    if (!['year','month'].includes(axis)) return {ok:false,reason:'飞书日期选择列无效'};
    visibilityCache = new Map();
    const panels = Array.from(document.querySelectorAll('.atsx-date-picker-period-month-panel'))
      .filter(panel => isVisible(panel) && panel.getBoundingClientRect().width > 0 && panel.getBoundingClientRect().height > 0);
    const wanted = String(value).trim();
    const slotRect = parts.labels[Number(slot)]?.getBoundingClientRect();
    const rankedPanels = panels.map(panel => {
      const rect = panel.getBoundingClientRect();
      return {panel,distance:slotRect ? Math.abs(rect.left + rect.width / 2 - (slotRect.left + slotRect.width / 2)) +
        Math.abs(rect.top + rect.height / 2 - (slotRect.top + slotRect.height / 2)) : 0};
    }).sort((a,b) => a.distance - b.distance);
    let choice = null;
    let diagnostics = '';
    for (const {panel} of rankedPanels) {
      const lists = Array.from(panel.querySelectorAll('.atsx-date-picker-period-month-panel-list'));
      const list = lists[axis === 'year' ? 0 : 1];
      const options = Array.from(list?.querySelectorAll('.atsx-date-picker-period-month-panel-list-item') || []);
      diagnostics += `${lists.length}列:${options.slice(0,8).map(node => tidyLabel(node.textContent || '')).join('/') || '空'};`;
      choice = options.find(node => tidyLabel(node.textContent || '') === wanted &&
        !/disabled/.test(String(node.className || '')) && node.getAttribute('aria-disabled') !== 'true');
      if (choice) break;
    }
    if (!choice) return {ok:false,reason:`飞书日期选择器中未找到 ${wanted}（面板 ${panels.length}，${diagnostics || '无候选'}）`};
    safeScrollIntoView(choice);
    const rect = choice.getBoundingClientRect();
    if (!rect.width || !rect.height) return {ok:false,reason:`飞书日期选项 ${wanted} 没有可点击尺寸`};
    return {ok:true,point:{x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}};
  }

  // === 执行 click ===
  async function executeClick(index) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    if (!el) return { ok: false, reason: `元素 ${index} 不在注册表` };
    // 代理场景：点的是可见 label，状态藏在隐藏的 input 里
    const stateEl = elementStateRegistry[pos] || el;
    const meta = elementMetaRegistry[pos] || {};
    const wasChecked = stateEl.checked;
    if (meta.context !== 'popup') transactionTrigger=stateEl.closest?.('.phoenix-select') || stateEl;
    if (meta.kind === 'section-entry' || /^(编辑|修改|新增|添加|增加)/.test(tidyLabel(meta.label))) selectedSection=meta.section || tidyLabel(meta.label);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false, reason: `元素 ${index} 已禁用` };
    }
    // Moka 的弹层选项经常把真正的 React 点击监听器挂在最内层文字节点的
    // 元素上；注册表收录的外层容器调用 click() 时不会触发该监听器。
    // 在浮层内优先点击同文案的最深可见后代，仍保留外层元素作为状态回读锚点。
    const registeredLabel = tidyLabel(el.innerText || el.textContent || '');
    const leafTarget = activeLayer?.contains(el) && !el.matches('input,textarea')
      ? Array.from(el.querySelectorAll('*')).filter(node => isVisible(node) &&
          tidyLabel(node.innerText || node.textContent || '') === registeredLabel &&
          !node.querySelector('input,textarea'))
        .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
      : null;
    // Moka 已选中的学校/专业输入框本身不会响应点击；右侧的清除图标会先撤销
    // 旧选择，使同一个控件恢复为可输入的搜索框。错误继承到新增记录时必须先走
    // 这一步，下一轮才能输入并提交该记录自己的学校/专业。
    let mokaClearTarget = null;
    let mokaControl = null;
    let mokaClickPoint = null;
    let mokaInitialControl = null;
    let mokaEditable = stateEl?.matches?.('input,textarea') ? stateEl :
      el.querySelector?.('input[placeholder*="学校"],input[placeholder*="专业"]') ||
      el.parentElement?.querySelector?.('input[placeholder*="学校"],input[placeholder*="专业"]');
    const mokaSelectionValue = input => {
      if (!input) return '';
      if (input.value) return input.value;
      for (let node = input.previousElementSibling; node; node = node.previousElementSibling) {
        const value = tidyLabel(node.innerText || node.textContent || '');
        if (value && !/^[\ue000-\uf8ff\s]+$/.test(value) && !/必填项未填写/.test(value)) return value;
      }
      return '';
    };
    const mokaSemantic = `${deriveLabel(el)} ${tidyLabel(mokaEditable?.getAttribute?.('placeholder') || '')}`;
    if (isMokaFormPage() && /学校名称|专业名称|就读学校|请输入专业/.test(mokaSemantic)) {
      if (mokaEditable && mokaSelectionValue(mokaEditable)) {
        const initialControl = mokaEditable.closest?.('.sd-Select-container-1Eq4x,[class*="sd-Select-container-"]') ||
          mokaEditable.parentElement || mokaEditable;
        mokaInitialControl = initialControl;
        // 选中态右侧首先是下拉箭头；进入搜索态后同一位置才变成清除按钮。
        // 先打开搜索态，再重新命中右侧操作区，整个过程作为一个原子事务执行。
        safeScrollIntoView(mokaEditable);
        const initialRect = initialControl.getBoundingClientRect();
        mokaEditable.focus();
        mokaEditable.dispatchEvent(new MouseEvent('mousedown', {bubbles:true,cancelable:true,view:window}));
        mokaEditable.click();
        await sleep(80);
        // 专业控件进入搜索态时会重建 input。重新绑定当前焦点节点，后续按键、
        // 清除命中与回读都使用新节点，避免在已脱离 DOM 的旧引用上空转。
        const focused = document.activeElement;
        if (focused?.matches?.('input,textarea')) {
          const focusedRect = focused.getBoundingClientRect();
          const overlaps = focusedRect.right >= initialRect.left && focusedRect.left <= initialRect.right &&
            focusedRect.bottom >= initialRect.top && focusedRect.top <= initialRect.bottom;
          if (overlaps) mokaEditable = focused;
        }
        const backspace = {bubbles:true,cancelable:true,key:'Backspace',code:'Backspace',keyCode:8,which:8};
        mokaEditable.dispatchEvent(new KeyboardEvent('keydown', backspace));
        mokaEditable.dispatchEvent(new KeyboardEvent('keyup', backspace));
        await sleep(80);
        if (!mokaSelectionValue(mokaEditable)) {
          return {ok:true,action:'click',index,label:'',clearedSelection:true,reactClearHandled:false};
        }
        const liveControl = mokaEditable.closest?.('.sd-Select-container-1Eq4x,[class*="sd-Select-container-"]') ||
          mokaEditable.parentElement;
        const controlCandidates = [initialControl,liveControl,mokaEditable.parentElement?.parentElement]
          .filter(node => {
            if (!node?.isConnected || !node.contains(mokaEditable)) return false;
            const candidateRect = node.getBoundingClientRect();
            return candidateRect.width <= initialRect.width * 1.35 &&
              Math.abs(candidateRect.left - initialRect.left) < 24;
          });
        mokaControl = controlCandidates.sort((a,b) =>
          b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || initialControl;
        const rect = mokaControl?.getBoundingClientRect?.() || initialRect;
        mokaClickPoint = {
          x: Math.max(rect.left + 1, rect.right - Math.min(16, rect.width / 4)),
          y: rect.top + rect.height / 2
        };
        const clearIcons = Array.from(mokaControl?.querySelectorAll?.('span,i,svg,[role="button"]') || [])
          .filter(node => isVisible(node) && (/[×✕]/.test(node.textContent || '') ||
            /clear|close/i.test(String(node.className?.baseVal || node.className || ''))));
        const hit = document.elementFromPoint(mokaClickPoint.x, mokaClickPoint.y);
        mokaClearTarget = clearIcons.find(node => node === hit) ||
          clearIcons.filter(node => node.contains(hit)).sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] ||
          (hit && !hit.matches?.('input,textarea') &&
            (mokaControl?.contains(hit) || initialControl?.contains(hit)) ? hit : null);
      }
    }
    // 北森常量选择器的文字与单选圆圈是兄弟节点；文字本身不响应选择。
    // 在同一候选行内命中左侧圆圈，仍以原条目作为快照和回读锚点。
    let beisenChoiceTarget = null;
    if (el.closest?.('.constant-main-selector-container') &&
        !/^(确定|取消|清空已选)$/.test(registeredLabel) && document.elementFromPoint) {
      const exactRow = Array.from(document.querySelectorAll(
        '.constant-main-selector-container .list-item-container')).find(node =>
        isVisible(node) && tidyLabel(node.innerText || node.textContent || '') === registeredLabel);
      // 北森把状态处理器绑定在单选 SVG 上。选择快照可能指向同一行里的
      // 文字 span，因此从行文本重新定位 SVG，触发组件实际的 onClick。
      beisenChoiceTarget = exactRow?.querySelector('svg') || null;
      let row = el;
      while (row.parentElement &&
          tidyLabel(row.parentElement.innerText || row.parentElement.textContent || '') === registeredLabel &&
          !row.parentElement.matches('.constant-main-selector-container')) row = row.parentElement;
      const rowLabel = tidyLabel(row?.innerText || row?.textContent || '');
      const rowRect = row?.getBoundingClientRect?.();
      if (!beisenChoiceTarget && row && rowLabel === registeredLabel && rowRect?.width > 30 && rowRect.width < 300) {
        const hit = document.elementFromPoint(rowRect.left + 8, rowRect.top + rowRect.height / 2);
        if (hit && row.contains(hit) && hit !== el) beisenChoiceTarget = hit;
      }
    }
    // 飞书卡片在真实指针通道不可用时仍保留一个普通 DOM 回退目标，以便页面
    // 本身允许程序化 click 的构建可以继续完成填写。
    const feishuHitTarget = isFeishuJobsPage() && meta.clickMode === 'trusted-pointer'
      ? feishuCardPointerTarget(el, meta.clickLabel || meta.label, meta.label) : null;
    const phoenixArrow = meta.kind === 'custom-select'
      ? Array.from(stateEl?.closest?.('.phoenix-select')?.querySelectorAll('.phoenix-select__switchArrow') || [])
        .find(isVisible) : null;
    if (meta.context !== 'popup' && !activeLayer?.contains(stateEl)) transactionTrigger=stateEl.closest?.('.phoenix-select') || stateEl;
    const clickTarget = mokaClearTarget || beisenChoiceTarget || phoenixArrow || leafTarget || feishuHitTarget || el;
    const r = clickTarget.getBoundingClientRect();
    if (!notOccluded(clickTarget, r)) {
      // 不强制失败，因为元素可能合法地被父级覆盖；记录但继续
      console.warn(`${TAG} click 目标可能被遮挡`, index);
    }
    if (!mokaClearTarget) safeScrollIntoView(clickTarget);
    const singleActivation = (stateEl?.closest?.('.phoenix-select') &&
      meta.kind === 'custom-select') || stateEl?.closest?.('.ud__picker');
    if (!mokaClearTarget && !singleActivation && typeof clickTarget.focus === "function") {
      let focusDelivered = false;
      const observeFocus = () => { focusDelivered = true; };
      clickTarget.addEventListener('focus', observeFocus, {once:true});
      try {
        clickTarget.focus({ preventScroll: true });
      } catch (_) {
        clickTarget.focus();
      }
      clickTarget.removeEventListener('focus', observeFocus);
      // 扩展弹窗持有窗口焦点时，focus() 可能只更新 activeElement。
      // 给可编辑控件补齐本次缺失的焦点通知，支持依赖 focus 展开的选择器。
      if (!focusDelivered && clickTarget.matches?.('input,textarea,[contenteditable="true"]')) {
        clickTarget.dispatchEvent(new FocusEvent('focus', {bubbles:false}));
        clickTarget.dispatchEvent(new FocusEvent('focusin', {bubbles:true}));
      }
    }
    // 自定义下拉/日历常只监听 mousedown，补完整指针事件序列
    const box = clickTarget.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: mokaClickPoint?.x ?? box.left + box.width / 2,
      clientY: mokaClickPoint?.y ?? box.top + box.height / 2
    };
    // 北森的单选行由 click 事件切换；额外的 down/up 会让同一次选择
    // 被组件处理两次，最终回到未选状态。
    // 飞书下拉由一次原生 click 打开；真实指针通道由后台执行，普通回退点击
    // 保持单击，避免把选择层刚打开又关闭。
    const feishuSingleClick = isFeishuJobsPage();
    if (!mokaClearTarget && !beisenChoiceTarget &&
        !feishuSingleClick && !singleActivation && !clickTarget.matches?.('.phoenix-select input')) {
      try {
        clickTarget.dispatchEvent(new PointerEvent("pointerdown", opts));
        clickTarget.dispatchEvent(new MouseEvent("mousedown", opts));
        clickTarget.dispatchEvent(new PointerEvent("pointerup", opts));
        clickTarget.dispatchEvent(new MouseEvent("mouseup", opts));
      } catch (_) {
        clickTarget.dispatchEvent(new MouseEvent("mousedown", opts));
        clickTarget.dispatchEvent(new MouseEvent("mouseup", opts));
      }
    }
    if (typeof clickTarget.click === 'function') clickTarget.click();
    else clickTarget.dispatchEvent(new MouseEvent('click', opts));
    let reactClearHandled = false;
    if (mokaClearTarget) {
      await sleep(80);
      const readMokaSelection = () => {
        const liveControl = [mokaControl,mokaInitialControl].find(node => node?.isConnected);
        const liveInput = liveControl?.querySelector?.('input') ||
          (mokaEditable?.isConnected ? mokaEditable : null);
        return mokaSelectionValue(liveInput);
      };
      let remaining = readMokaSelection();
      // 精确节点的标准点击是主路径。少数组件只把处理器保存在 React props
      // 上时，再从命中节点向上寻找第一个清除处理器，避免调用同容器里“打开
      // 下拉”等无关 onClick 后误判成功。
      if (remaining) {
        const candidates = [];
        for (let node = mokaClearTarget; node && mokaControl?.contains(node); node = node.parentElement) {
          const reactKey = Object.keys(node).find(key => /^__(?:reactProps|reactEventHandlers)\$/.test(key));
          const fiberKey = Object.keys(node).find(key => /^__reactFiber\$/.test(key));
          const fiber = fiberKey && node[fiberKey];
          const handler = (reactKey && node[reactKey]?.onClick) ||
            fiber?.memoizedProps?.onClick || fiber?.pendingProps?.onClick;
          if (typeof handler === 'function') candidates.push({node,handler});
        }
        for (const {node,handler} of candidates) {
          const event = {
            type:'click', target:mokaClearTarget, currentTarget:node,
            preventDefault(){}, stopPropagation(){}, persist(){},
            nativeEvent:{target:mokaClearTarget}
          };
          try {
            handler(event);
            reactClearHandled = true;
            await sleep(80);
            remaining = readMokaSelection();
            if (!remaining) break;
          } catch (_) {}
        }
      }
      if (remaining) {
        return {
          ok:false,
          reason:`Moka 选择值未被清除：${remaining}`,
          clearedSelection:true,
          reactClearHandled
        };
      }
    }
    // Moka 的“添加学校/专业全称”会在点击后立即打开下一层编辑器。
    // 此时保持原搜索框焦点，交给新编辑器接管；手动 blur 会让框架把刚打开的二级编辑器一并卸载。
    const clickLabel = tidyLabel(el.innerText || el.textContent || '');
    const opensCustomNameEditor = /^添加(?:学校|专业)全称$/.test(clickLabel);
    if (activeLayer?.contains(el) && !opensCustomNameEditor && !el.matches('input,textarea') && !el.querySelector('input,textarea')) {
      const editor = activeLayer.querySelector('input,textarea');
      if (editor) {
        editor.blur();
        editor.dispatchEvent(new FocusEvent('blur', { bubbles:true }));
        editor.dispatchEvent(new FocusEvent('focusout', { bubbles:true }));
      }
    }
    // 代理兜底：点 label 后状态没变（有些组件把原生转发拦掉了），直接点它背后的 input。
    // 已在勾选状态的单选框本来就不该再变，所以不会造成重复切换。
    if (stateEl !== el && stateEl.matches?.('input[type="checkbox"],input[type="radio"]') &&
        typeof stateEl.click === "function" && stateEl.checked === wasChecked) {
      stateEl.click();
    }
    return {
      ok: true,
      action: "click",
      index,
      checked: stateEl === el ? undefined : stateEl.checked,
      label: (el.innerText || el.textContent || "").trim().slice(0, 40),
      clearedSelection: !!mokaClearTarget,
      reactClearHandled
    };
  }

  async function executeMokaDate(el, index, value) {
    const match = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return {ok:false,dataGap:true,reason:'该日期控件需要完整年月日'};
    const normalized = `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
    const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];

    // 该 input 是 React 只读投影；点击日历日期才能更新表单状态与校验器。
    // 按年月头和周一开头的日期网格定位，避免依赖构建后会变化的 CSS 类名。
    safeScrollIntoView(el);
    const calendarAlreadyOpen = () => {
      const dayGrid = Array.from(document.querySelectorAll('table')).filter(isVisible)
        .some(candidate => Array.from(candidate.querySelectorAll('th')).map(node => tidyLabel(node.textContent || ''))
          .slice(0, 7).join('') === '一二三四五六日');
      if (dayGrid) return true;
      const labels = Array.from(document.querySelectorAll('body *')).filter(node =>
        isVisible(node) && node.children.length === 0).map(node => tidyLabel(node.textContent || ''));
      return labels.some(label => /^\d{4}(?:年)?$/.test(label) || /^\d{4}\s*-\s*\d{4}$/.test(label)) &&
        labels.filter(label => monthNames.includes(label)).length >= 3;
    };
    // 后台真实指针事务已经展开日历时，直接沿用当前面板。这样日期事务始终只
    // 打开一次，避免第二个 click 把 Moka 的开关式日历收起。
    if (!calendarAlreadyOpen()) {
      try { el.focus({preventScroll:true}); } catch (_) { el.focus?.(); }
      const openerBox = el.getBoundingClientRect();
      const openerOpts = {bubbles:true,cancelable:true,view:window,
        clientX:openerBox.left + openerBox.width / 2,clientY:openerBox.top + openerBox.height / 2};
      try {
        el.dispatchEvent(new PointerEvent('pointerdown',openerOpts));
        el.dispatchEvent(new MouseEvent('mousedown',openerOpts));
        el.dispatchEvent(new PointerEvent('pointerup',openerOpts));
        el.dispatchEvent(new MouseEvent('mouseup',openerOpts));
      } catch (_) {
        el.dispatchEvent(new MouseEvent('mousedown',openerOpts));
        el.dispatchEvent(new MouseEvent('mouseup',openerOpts));
      }
      el.click();
      await sleep(100);
    }
    // Moka 每次切换月份都会重建日历 DOM。所有读取都从当前可见面板重新定位，
    // 避免继续操作已经脱离 document 的旧节点。
    const currentCalendar = () => {
      const table = Array.from(document.querySelectorAll('table')).filter(isVisible).find(candidate => {
        const heads = Array.from(candidate.querySelectorAll('th')).map(node => tidyLabel(node.textContent || ''));
        return heads.length >= 7 && heads.slice(0, 7).join('') === '一二三四五六日';
      });
      if (!table) return null;
      let calendar = table.parentElement;
      for (let depth = 0; calendar?.parentElement && depth < 7 &&
           !/\d{4}\s*年/.test(calendar.textContent || ''); depth += 1) {
        calendar = calendar.parentElement;
      }
      return calendar ? {table, calendar} : null;
    };
    const targetYear = Number(match[1]);
    const targetMonth = Number(match[2]);
    const expectedMonth = `${match[1]}-${match[2].padStart(2,'0')}`;

    // Moka 日期器先展示月份，再经年份标题进入十年页。它没有日期 table 时，
    // 通用浮层扫描会把“1990 年”误当成最终日期选项。这里先完成年份和月份选择，
    // 随后复用下方日期网格的验证逻辑。
    const visibleLeaves = () => Array.from(document.querySelectorAll('body *')).filter(node => {
      // Moka 近期的日期控件将图标包进了额外 span；文字或图标节点本身不再
      // 一定是 DOM 叶子。只采用自身聚合文本很短的可见节点，同时用精确匹配
      // 约束后续选择，既能找到翻页图标，也不会把整个日期面板当作候选。
      if (!isVisible(node)) return false;
      const text = tidyLabel(node.innerText || node.textContent || '');
      return !!text && text.length <= 24;
    });
    const clickLabel = async label => {
      const node = visibleLeaves().filter(candidate =>
        tidyLabel(candidate.innerText || candidate.textContent || '') === label)
        .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
          a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      if (!node) return false;
      node.click();
      await sleep(55);
      return true;
    };
    const pickerLabels = () => visibleLeaves().map(node => tidyLabel(node.innerText || node.textContent || ''));
    const pickerYearHeader = () => pickerLabels().find(label => /^\d{4}(?:年)?$/.test(label) || /^\d{4}\s*-\s*\d{4}$/.test(label));
    const navigateYearGrid = async direction => {
      // Moka 的年份翻页图标会随构建版本改变字体 glyph，不能把具体字符当作
      // 协议。年份格本身是稳定证据：在年份格上方、左右两端的两个小控件就是
      // 前后翻页。由几何关系找到它们，可覆盖图标字体和无障碍文本的差异。
      const glyphArrows = visibleLeaves().filter(node => /^(?:|||)$/.test(tidyLabel(node.textContent || '')))
        .sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (glyphArrows.length >= 2) {
        (direction < 0 ? glyphArrows[0] : glyphArrows[glyphArrows.length - 1]).click();
        await sleep(55);
        return true;
      }

      const years = visibleLeaves().filter(node => /^\d{4}$/.test(tidyLabel(node.textContent || '')));
      if (years.length < 4) return false;
      const boxes = years.map(node => node.getBoundingClientRect()).filter(box => box.width && box.height);
      const minX = Math.min(...boxes.map(box => box.left));
      const maxX = Math.max(...boxes.map(box => box.right));
      const minY = Math.min(...boxes.map(box => box.top));
      const firstYear = years[0];
      let root = firstYear.parentElement;
      while (root && root !== document.body) {
        const ownYears = Array.from(root.querySelectorAll('*')).filter(node =>
          isVisible(node) && node.children.length === 0 && /^\d{4}$/.test(tidyLabel(node.textContent || '')));
        if (ownYears.length >= 4) break;
        root = root.parentElement;
      }
      if (!root) return false;
      const candidates = Array.from(root.querySelectorAll('*')).filter(node => {
        if (!isVisible(node)) return false;
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height || box.width > 100 || box.height > 80) return false;
        // 年份网格第一行上方、靠近网格左右边界的按钮。
        return box.bottom <= minY + 12 && box.bottom >= minY - 90 &&
          (box.right <= minX + 48 || box.left >= maxX - 48);
      }).map(node => {
        const clickable = node.closest('button,[role="button"],a,[tabindex]') || node;
        return clickable;
      }).filter((node, pos, all) => all.indexOf(node) === pos)
        .sort((a,b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (candidates.length < 2) return false;
      (direction < 0 ? candidates[0] : candidates[candidates.length - 1]).click();
      await sleep(55);
      return true;
    };
    if (!currentCalendar()) {
      let header = pickerYearHeader();
      if (header && !/^\d{4}\s*-\s*\d{4}$/.test(header)) {
        if (!await clickLabel(header)) return {ok:false,reason:'Moka 日期年份标题不可点击'};
      }
      for (let tries = 0; tries < 30 && !currentCalendar(); tries += 1) {
        const years = pickerLabels().filter(label => /^\d{4}$/.test(label)).map(Number);
        if (years.includes(targetYear)) {
          if (!await clickLabel(String(targetYear))) return {ok:false,reason:'Moka 日期年份项不可点击'};
          break;
        }
        if (!years.length) return {ok:false,reason:'Moka 日期年份层未显示可选年份'};
        if (!await navigateYearGrid(targetYear < Math.min(...years) ? -1 : 1)) {
          return {ok:false,reason:'Moka 日期年份层缺少翻页按钮'};
        }
      }
      if (!currentCalendar()) {
        const monthLabel = monthNames[targetMonth - 1];
        if (!await clickLabel(monthLabel)) return {ok:false,reason:`Moka 日期月份项不可点击：${monthLabel}`};
        await sleep(55);
      }
    }
    // Moka 的“出生日期（年龄）”控件精度仅到月份。选择月份后面板会直接关闭，
    // 输入框投影为 YYYY-MM（并附带年龄），此时页面已经接受了该字段。
    if (!currentCalendar()) {
      const actual = String(el.value || '').trim();
      return actual.startsWith(expectedMonth)
        ? {ok:true,action:'pick_date',index,value:actual,verified:true}
        : {ok:false,reason:`Moka 日期月份未被表单接受：${actual || '空白'}`,expected:expectedMonth};
    }
    const readMonth = () => {
      const state = currentCalendar();
      if (!state) return {year:0,month:0};
      const {calendar} = state;
      const text = tidyLabel(calendar.textContent || '');
      const monthName = [...monthNames].sort((a,b) => b.length - a.length).find(name => text.includes(name));
      return {
        year:Number(text.match(/(\d{4})\s*年/)?.[1]),
        month:monthName ? monthNames.indexOf(monthName) + 1 : 0
      };
    };
    const clickableHeader = () => {
      const state = currentCalendar();
      if (!state) return [];
      const {calendar,table} = state;
      return Array.from(calendar.querySelectorAll('button,[role="button"],i,svg,span')).filter(node => {
      if (!isVisible(node) || table.contains(node)) return false;
      const style = window.getComputedStyle(node);
      const text = tidyLabel(node.textContent || '');
      if (/\d{4}\s*年/.test(text) || monthNames.includes(text)) return false;
      return node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' || style.cursor === 'pointer';
      }).filter((node,pos,all) => !all.some((other,i) => i < pos && other.contains(node)));
    };
    const glyphNavigation = () => {
      const state = currentCalendar();
      if (!state) return [];
      const {calendar,table} = state;
      return ['','','',''].map(glyph =>
      Array.from(calendar.querySelectorAll('*')).filter(node => !table.contains(node) && isVisible(node) &&
        tidyLabel(node.textContent || '') === glyph)
        .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
      );
    };

    for (let tries = 0; tries < 36; tries += 1) {
      const current = readMonth();
      if (current.year === targetYear && current.month === targetMonth) break;
      const glyphs = glyphNavigation();
      const nav = glyphs.every(Boolean) ? glyphs : clickableHeader();
      if (nav.length < 4 || !current.year || !current.month) {
        return {ok:false,reason:`Moka 日期导航无法识别（${current.year || '?'}-${current.month || '?'}，按钮 ${nav.length}）`};
      }
      const monthDelta = (targetYear - current.year) * 12 + targetMonth - current.month;
      // 头部顺序为：上一年、上一月、下一月、下一年。
      nav[monthDelta < -11 ? 0 : monthDelta < 0 ? 1 : monthDelta > 11 ? 3 : 2].click();
      await sleep(35);
    }
    const current = readMonth();
    if (current.year !== targetYear || current.month !== targetMonth) {
      return {ok:false,reason:`Moka 日期未导航到目标月份：${current.year}-${current.month}`,expected:normalized};
    }
    const finalCalendar = currentCalendar();
    if (!finalCalendar) return {ok:false,reason:'Moka 日期面板在选择日期前关闭'};
    const cells = Array.from(finalCalendar.table.querySelectorAll('tbody tr')).flatMap(row => Array.from(row.querySelectorAll('td')));
    const mondayFirst = (new Date(targetYear, targetMonth - 1, 1).getDay() + 6) % 7;
    const cell = cells[mondayFirst + Number(match[3]) - 1];
    if (!cell || Number(tidyLabel(cell.textContent || '')) !== Number(match[3])) {
      return {ok:false,reason:'Moka 日期网格无法定位目标日',expected:normalized};
    }
    const dayLabel = String(Number(match[3]));
    const dayTarget = Array.from(cell.querySelectorAll('*')).filter(node => isVisible(node) &&
      tidyLabel(node.innerText || node.textContent || '') === dayLabel)
      .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0] || cell;
    dayTarget.click();
    await sleep(100);
    const hasValidationError = !!el.closest('label')?.querySelector('[class*="error"]');
    return String(el.value || '') === normalized && !hasValidationError
      ? {ok:true,action:'pick_date',index,value:normalized,verified:true}
      : {ok:false,reason:`Moka 日期未被表单接受：${el.value || '空白'}`,expected:normalized};
  }

  async function executeBeisenDate(el, index, value) {
    const match = String(value).match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!match) return {ok:false,dataGap:true,reason:'日期需要年月或年月日'};
    const [, rawYear, rawMonth, rawDay] = match;
    const targetYear = Number(rawYear);
    const targetMonth = Number(rawMonth);
    const targetDay = rawDay ? Number(rawDay) : 1;
    const expectedPrefix = `${rawYear}-${String(targetMonth).padStart(2, '0')}`;
    const panel = () => {
      visibilityCache = new Map();
      // 北森当前页面的日历没有 Element UI 类名，但可见面板始终同时含有
      // “YYYY年”按钮、“M月”按钮与日期表格。先用这三个结构特征锁定最小公共容器。
      const visibleTables = Array.from(document.querySelectorAll('table')).filter(isVisible);
      const headerButtons = Array.from(document.querySelectorAll('button')).filter(isVisible);
      // 有些北森主题用 CSS 伪元素绘制“年／月”，DOM 仅保留数字。
      const isYearHeader = text => /^\d{4}(?:年)?$/.test(text);
      const isMonthHeader = text => /^(?:[1-9]|1[0-2])(?:月)?$/.test(text);
      const yearButton = headerButtons.find(button => isYearHeader(tidyLabel(button.innerText || button.textContent || '')));
      const monthButton = headerButtons.find(button => isMonthHeader(tidyLabel(button.innerText || button.textContent || '')));
      if (yearButton && monthButton) {
        for (let node = yearButton.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
          if (isVisible(node) && node.contains(monthButton) && visibleTables.some(table => node.contains(table))) return node;
        }
      }
      const named = Array.from(document.querySelectorAll(
        '.el-date-picker,.el-picker-panel,.ant-calendar,.ant-picker-dropdown,[class*="calendar" i],[class*="date-picker" i]'
      )).find(node => isVisible(node) && node.querySelector('table'));
      if (named) return named;
      // 北森旧页面的日历没有稳定类名。以可见表格为锚点，向上找到同时包含
      // 年、月导航的最小容器，避免把整页 body 误当作日历。
      for (const table of Array.from(document.querySelectorAll('table')).filter(isVisible)) {
        for (let node = table.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth += 1) {
          if (!isVisible(node)) continue;
          const labels = Array.from(node.querySelectorAll('button,a,span')).map(item => tidyLabel(item.innerText || item.textContent || ''));
          if (labels.some(text => /^\d{4}(?:年)?$/.test(text)) &&
              labels.some(text => /^(?:[1-9]|1[0-2])(?:月)?$/.test(text))) return node;
        }
      }
      return null;
    };
    // Element UI 的日期输入框是开关式触发器。一次用户点击会打开面板；此前对
    // input 和包装层连续派发多次 click，会把刚打开的面板再次关闭。
    const trigger = el.closest('.el-date-editor,.el-input,[class*="date"]') || el.parentElement || el;
    const open = async node => {
      node?.focus?.({preventScroll:true});
      node?.click?.();
      await sleep(100);
      return panel();
    };
    let picker = await open(el);
    if (!picker && trigger !== el) picker = await open(trigger);
    if (!picker) return {ok:false,reason:'北森日期面板未打开'};
    const readMonth = () => {
      const labels = Array.from(picker.querySelectorAll('.el-date-picker__header-label,button,span'))
        .filter(isVisible)
        .map(node => tidyLabel(node.innerText || node.textContent || ''));
      let year = labels.map(text => text.match(/(\d{4})/)).find(Boolean)?.[1];
      let month = labels.map(text => text.match(/^(\d{1,2})(?:\s*月)?$/)).find(Boolean)?.[1];
      const combinedHeader = labels.map(text => text.match(/(\d{4})\s*年?\s*(\d{1,2})\s*月?/)).find(Boolean);
      if (combinedHeader) {
        year ||= combinedHeader[1];
        month ||= combinedHeader[2];
      }
      // 主题层级可能把标题按钮放在 picker 的兄弟节点；全局可见标题是同一时刻
      // 唯一的四位年份和 1–12 月份，作为可靠的结构回读。
      if (!year || !month) {
        const globalLabels = Array.from(document.querySelectorAll('button')).filter(isVisible)
          .map(node => tidyLabel(node.innerText || node.textContent || ''));
        year ||= globalLabels.map(text => text.match(/(\d{4})/)).find(Boolean)?.[1];
        month ||= globalLabels.map(text => text.match(/^(?:[1-9]|1[0-2])(?:\s*月)?$/)).find(Boolean)?.[1];
        const globalCombined = globalLabels.map(text => text.match(/(\d{4})\s*年?\s*(\d{1,2})\s*月?/)).find(Boolean);
        if (globalCombined) {
          year ||= globalCombined[1];
          month ||= globalCombined[2];
        }
      }
      return {year:Number(year), month:Number(month), labels};
    };
    const navigation = direction => {
      const icon = direction < 0 ? 'el-icon-arrow-left' : 'el-icon-arrow-right';
      const byClass = direction < 0 ? /(?:prev|previous|left)/i : /(?:next|right)/i;
      const semanticText = direction < 0 ? /(?:上一|上个|previous|prev|left)/i : /(?:下一|下个|next|right)/i;
      const clickables = Array.from(picker.querySelectorAll('button,a,[role="button"]')).filter(isVisible);
      const iconNode = Array.from(picker.querySelectorAll(`.${icon}`)).find(isVisible);
      return iconNode?.closest?.('button,a,[role="button"]') ||
        clickables.find(button =>
        button.classList.contains(icon) && isVisible(button)) ||
        Array.from(picker.querySelectorAll(direction < 0 ? '.el-date-picker__prev-btn' : '.el-date-picker__next-btn'))
          .find(button => !/d-arrow/.test(String(button.className || ''))) ||
        clickables.find(button =>
          isVisible(button) && byClass.test(String(button.className || '')) &&
          !/(?:year|double|d-arrow)/i.test(String(button.className || ''))) ||
        clickables.find(button => semanticText.test([
          button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-action'),
          button.innerText, button.textContent
        ].filter(Boolean).join(' ')));
    };
    const monthNames=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
    const semanticMonthCells=()=>Array.from(picker.querySelectorAll('table td')).filter(cell=>
      isVisible(cell) && monthNames.includes(tidyLabel(cell.textContent || '')));
    if (semanticMonthCells().length>=10) {
      for (let tries=0; tries<120 && readMonth().year!==targetYear; tries++) {
        const cells=semanticMonthCells();
        let yearSurface=cells[0]?.parentElement;
        while (yearSurface && !Array.from(yearSurface.querySelectorAll('button')).some(button=>
          isVisible(button) && /^\d{4}(?:年)?$/.test(tidyLabel(button.textContent || '')))) yearSurface=yearSurface.parentElement;
        const buttons=Array.from(yearSurface?.querySelectorAll('button') || []).filter(isVisible);
        const arrows=buttons.filter(button=>!/^\d{4}(?:年)?$/.test(tidyLabel(button.textContent || '')));
        const direction=targetYear<readMonth().year ? -1 : 1;
        const nav=arrows.length===2 ? arrows[direction<0 ? 0 : 1] : navigation(direction);
        if (!nav) return {ok:false,reason:'年月面板的年份导航不可用'};
        nav.click();
        await sleep(25);
        picker=panel();
        if (!picker) return {ok:false,reason:'年月面板在年份导航时关闭'};
      }
      if (readMonth().year!==targetYear) return {ok:false,reason:'年月面板未到达目标年份'};
      const cell=semanticMonthCells().find(node=>monthNames.indexOf(tidyLabel(node.textContent || ''))+1===targetMonth);
      if (!cell) return {ok:false,reason:'目标月份不可选'};
      cell.click();
      await sleep(80);
      const actual=String(getValue(el,'beisen-date') || '').trim();
      if (actual!==expectedPrefix) return {ok:false,reason:`年月回读不一致：${actual || '空白'}`,expected:expectedPrefix};
      observedMonthControls.add(el);
      const monthInput=el.matches?.('input') ? el : el.querySelector?.('input');
      if (monthInput) observedMonthControls.add(monthInput);
      return {ok:true,action:'pick_date',index,value:actual,verified:true,precision:'month'};
    }
    for (let tries = 0; tries < 180; tries += 1) {
      const current = readMonth();
      if (current.year === targetYear && current.month === targetMonth) break;
      if (!current.year || !current.month) {
        return {ok:false,reason:`北森日期面板月份无法读取（${current.labels.filter(Boolean).slice(0,12).join(' / ') || '无标题'}）`};
      }
      const delta = (targetYear - current.year) * 12 + targetMonth - current.month;
      const nav = navigation(delta < 0 ? -1 : 1);
      if (!nav) return {ok:false,reason:'北森日期月份导航不可用'};
      nav.click();
      await sleep(25);
      picker = panel();
      if (!picker) return {ok:false,reason:'北森日期面板在导航时关闭'};
    }
    const current = readMonth();
    if (current.year !== targetYear || current.month !== targetMonth) {
      return {ok:false,reason:`北森日期未导航到目标月份：${current.year || '?'}-${current.month || '?'}`,expected:expectedPrefix};
    }
    const monthCells = Array.from(picker.querySelectorAll('.el-month-table td,.ant-calendar-month-panel-cell,[class*="month-table" i] td'));
    const dayCells = Array.from(picker.querySelectorAll('.el-date-table td,.ant-calendar-table td,table td'));
    const targetCells = monthCells.length ? monthCells : dayCells;
    const targetNumber = monthCells.length ? targetMonth : targetDay;
    const dateCell = targetCells.find(cell =>
      !/(?:prev|last|next)[-_ ]?month|disabled/i.test(String(cell.className || '')) &&
      Number(tidyLabel(cell.textContent || '')) === targetNumber);
    if (!dateCell) return {ok:false,reason:monthCells.length ? '北森月份网格无法定位目标月' : '北森日期网格无法定位目标日',expected:expectedPrefix};
    dateCell.click();
    await sleep(80);
    const actual = String(getValue(el, 'beisen-date') || '').trim();
    return actual.startsWith(expectedPrefix) ? {ok:true,action:'pick_date',index,value:actual,verified:true} :
      {ok:false,reason:`北森日期回读不一致：${actual || '空白'}`,expected:expectedPrefix};
  }

  async function executeDatePicker(index, value) {
    const el = elementRegistry[parseInt(index, 10) - 1];
    if (!el || !el.matches('input')) return {ok:false,reason:'日期控件已变化'};
    if (isBeisenFormPage() &&
        (el.closest('.el-date-editor') || DATE_HINT_RE.test(deriveLabel(el)) ||
          DATE_HINT_RE.test(tidyLabel(el.closest('.form-item,.el-form-item,[class*="form-item"]')?.innerText || '')))) {
      return executeBeisenDate(el,index,value);
    }
    if (!el.matches('input[readonly]')) return {ok:false,reason:'日期控件已变化'};
    if (isMokaFormPage() && deriveKind(el, deriveRole(el)) === 'moka-date') {
      return executeMokaDate(el,index,value);
    }
    const match = String(value).match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!match) return {ok:false,dataGap:true,reason:'日期需要年月或年月日'};
    const [,year,month,day] = match;
    const dateContainer = el.closest('.mFormTime,.mLeft,.mRight') || el.parentElement;
    let calendar = Array.from(dateContainer.querySelectorAll('.layui-laydate')).find(isVisible);
    if (!calendar) {
      el.click();
      await sleep(100);
      visibilityCache = new Map();
      calendar = Array.from(dateContainer.querySelectorAll('.layui-laydate')).find(isVisible) ||
        Array.from(document.querySelectorAll('.layui-laydate')).find(isVisible);
    }
    if (!calendar) return {ok:false,reason:'日期面板未打开'};
    const yearList = () => calendar.querySelector('.laydate-year-list');
    if (!yearList()) {
      calendar.querySelector('.laydate-set-ym span')?.click();
      await sleep(50);
    }
    let yearChoice = null;
    for (let tries = 0; tries < 20; tries++) {
      const list = yearList();
      if (!list) return {ok:false,reason:'年份列表未显示'};
      yearChoice = Array.from(list.querySelectorAll('li')).find(item => parseInt(item.textContent,10) === Number(year));
      if (yearChoice) break;
      const years = Array.from(list.querySelectorAll('li')).map(item=>parseInt(item.textContent,10)).filter(Number.isFinite);
      const arrow = calendar.querySelector(Number(year) < Math.min(...years) ? '.laydate-prev-y' : '.laydate-next-y');
      if (!arrow || !years.length) return {ok:false,reason:'年份导航不可用'};
      arrow.click();
      await sleep(30);
    }
    if (!yearChoice) return {ok:false,reason:'目标年份不在可选范围'};
    yearChoice.click();
    await sleep(50);
    const monthHeader = calendar.querySelectorAll('.laydate-set-ym span')[1];
    if (monthHeader && !calendar.querySelector('.laydate-month-list')) {
      monthHeader.click();
      await sleep(50);
    }
    const monthChoices = Array.from(calendar.querySelectorAll('.laydate-month-list li'));
    const monthChoice = monthChoices[Number(month) - 1];
    if (!monthChoice) return {ok:false,reason:'目标月份不可选'};
    monthChoice.click();
    await sleep(50);
    if (day) {
      const dayChoice = Array.from(calendar.querySelectorAll('.layui-laydate-content td')).find(item =>
        !item.classList.contains('laydate-day-prev') && !item.classList.contains('laydate-day-next') &&
        !item.classList.contains('layui-disabled') && parseInt(item.textContent,10) === Number(day));
      if (!dayChoice) return {ok:false,reason:'目标日期不可选'};
      dayChoice.click();
      await sleep(50);
    }
    const actual = String(el.value || '');
    const expected = day ? `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}` : `${year}-${month.padStart(2,'0')}`;
    return actual.startsWith(expected) ? {ok:true,action:'pick_date',index,value:actual,verified:true} :
      {ok:false,reason:`日期回读不一致：${actual || '空白'}`,expected};
  }

  // === 执行 type_text (带回读验证 + 失败重试) ===
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function setValueWithEvents(el, value) {
    if (isEditableEl(el)) {
      // 富文本：先选中已有内容再插入，保证走编辑器的输入管线（React/Vue 才能感知）
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, value);
      } catch (_) {
        inserted = false;
      }
      if (!inserted || editableText(el).trim() !== value.trim()) {
        el.innerText = value;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const previousValue = String(el.value || '');
    const key = String(value).slice(-1) || 'Backspace';
    // 统一走原生 setter + React value tracker。execCommand 先触发浏览器输入管线，
    // 随后的 tracker 事件确保 Moka 的表单状态和校验器同步。
    if (typeof el.select === 'function') el.select();
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, String(value));
    } catch (_) {
      inserted = false;
    }
    // execCommand 产生浏览器原生输入事件，React 会直接接收。成功后保留这条
    // 单一路径；再写一次 setter 会把 React 的 value tracker 拉回旧状态。
    if (inserted && String(el.value || '') === String(value)) {
      el.dispatchEvent(new Event('change', { bubbles:true }));
      el.blur();
      return;
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key }));
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, inputType:'insertText', data:String(value) }));
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    // React 用 value tracker 判断 input 事件是否真正改变了值。恢复事件前的跟踪值，
    // 使 Moka 的受控输入框把这次填写提交给表单状态和校验器。
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      el._valueTracker.setValue(previousValue);
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType:'insertText', data:String(value) }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key }));
    el.blur();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles:true, relatedTarget:null }));
  }

  async function setFeishuYearValue(el, value) {
    const target = String(value).trim();
    // 飞书的年份输入框由受控组件维护。浏览器原生插入命令会经过其完整的编辑
    // 管线，因此先选中旧值并用这一条路径提交年份。
    if (typeof el.select === 'function') el.select();
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, target);
    } catch (_) {
      inserted = false;
    }
    if ((inserted || String(el.value || '') === target) && String(el.value || '') === target) {
      el.dispatchEvent(new Event('change', { bubbles:true }));
      el.blur?.();
      el.dispatchEvent(new FocusEvent('focusout', { bubbles:true, relatedTarget:null }));
      return;
    }

    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    let typed = '';

    // 飞书的单年份框在 React 状态更新时按字符处理输入。逐位提交可以让它完成
    // 自己的格式校验并保留受控状态，不会把整段年份视为一次无效的批量写入。
    for (const char of target) {
      typed += char;
      const previousValue = String(el.value || '');
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:char }));
      el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles:true, cancelable:true, inputType:'insertText', data:char
      }));
      if (setter) setter.call(el, typed);
      else el.value = typed;
      if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
        el._valueTracker.setValue(previousValue);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:char }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:char }));
      await sleep(80);
    }
    el.dispatchEvent(new Event('change', { bubbles:true }));
    el.blur?.();
    el.dispatchEvent(new FocusEvent('focusout', { bubbles:true, relatedTarget:null }));
  }

  function getCurrentValue(el) {
    if (isEditableEl(el)) return editableText(el);
    return el.value;
  }

  // 原生日期控件对格式挑剔：date 要 YYYY-MM-DD，month 要 YYYY-MM，week 要 YYYY-Www
  function normalizeForInputType(el, value) {
    if (el.tagName !== "INPUT") return { value, note: "" };
    const type = (el.getAttribute("type") || "").toLowerCase();
    const v = String(value).trim();
    const ym = v.match(/^(\d{4})-(\d{1,2})$/);
    const ymd = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

    if (type === "month" || el.closest('.ud__picker') && el.getAttribute('placeholder') === 'YYYY-MM') {
      if (ymd) return { value: `${ymd[1]}-${ymd[2].padStart(2, "0")}`, note: "按控件精度填写年月" };
      if (ym) return { value: `${ym[1]}-${ym[2].padStart(2, "0")}`, note: "" };
      if (/^\d{4}$/.test(v)) return { error: "日期缺少月份，保留空白等待补充" };
      return { value, note: "" };
    }
    if (type === "date") {
      if (ymd) return { value: `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`, note: "" };
      if (ym || /^\d{4}$/.test(v)) return { error: "日期缺少完整年月日，保留空白等待补充" };
      return { value, note: "" };
    }
    return { value, note: "" };
  }

  async function executeTypeText(index, value) {
    const el = elementRegistry[parseInt(index, 10) - 1];
    if (!el) return { ok: false, reason: `元素 ${index} 不在注册表` };
    if (el.disabled) return { ok: false, reason: "元素已禁用" };
    safeScrollIntoView(el);
    if (typeof el.focus === "function") el.focus();
    if (!document.hasFocus()) {
      el.dispatchEvent(new FocusEvent('focus', { bubbles:false }));
      el.dispatchEvent(new FocusEvent('focusin', { bubbles:true }));
    }

    const norm = normalizeForInputType(el, value);
    if (norm.error) return { ok: false, dataGap: true, reason: norm.error };
    const target = norm.value;
    const isFeishuYear = deriveKind(el, deriveRole(el)) === 'feishu-year';
    const settleMs = isFeishuYear ? 350 : 50;
    const write = () => isFeishuYear ? setFeishuYearValue(el, target) : setValueWithEvents(el, target);

    // 第一次尝试
    await write();
    await sleep(settleMs);
    const actual1 = getCurrentValue(el);
    if (actual1 === target) {
      el.blur?.();
      el.dispatchEvent(new FocusEvent('focusout', { bubbles:true }));
      return { ok: true, action: "type_text", index, value: target, verified: true, note: norm.note };
    }

    // 第一次失败，重试：清空 + 补键盘事件再设值
    console.warn(`${TAG} type_text 回读不一致，重试 (期望=${target}, 实际=${actual1})`);
    try {
      if (typeof el.select === "function") el.select();
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", ctrlKey: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a", ctrlKey: true }));
      await write();
      await sleep(settleMs);
      const actual2 = getCurrentValue(el);
      if (actual2 === target) {
        el.blur?.();
        el.dispatchEvent(new FocusEvent('focusout', { bubbles:true }));
        return { ok: true, action: "type_text", index, value: target, verified: true, retried: true, note: norm.note };
      }
      return { ok: false, reason: `回读验证失败（期望 ${target}，实际 ${actual2 || '空白'}）`, expected: target, actual: actual2, note: norm.note };
    } catch (err) {
      return { ok: false, reason: `重试异常: ${err.message}`, expected: target };
    }
  }

  async function executeUploadFile(index, fileData) {
    const el = elementRegistry[parseInt(index, 10) - 1];
    if (!el || !el.matches?.('input[type="file"]')) return { ok:false, reason:`元素 ${index} 不是文件输入框` };
    if (!fileData?.dataUrl || !fileData?.name) return { ok:false, dataGap:true, reason:'插件中尚未选择文件' };
    const fileLabel = fileFieldLabel(el);
    const previousImages = new Set(Array.from(fileUploadArea(el)?.querySelectorAll('img[src]') || [], image => image.src));
    const response = await fetch(fileData.dataUrl);
    const blob = await response.blob();
    const file = new File([blob], fileData.name, { type:fileData.type || blob.type || 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    el.files = transfer.files;
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    // 上传期间由本事务持有执行权；网站回执出现后再交回调度器。
    for (let elapsed=0; elapsed<60000; elapsed+=500) {
      await sleep(500);
      const input = el.isConnected ? el : Array.from(document.querySelectorAll('input[type="file"]'))
        .find(node => fileFieldLabel(node) === fileLabel);
      if (!input) continue;
      if (fileUploadPending(input)) continue;
      const area = fileUploadArea(input);
      const status = String(area?.textContent || '');
      if (/上传失败|上传出错|upload failed|文件过大|超过.{0,8}(?:限制|大小)/i.test(status)) {
        return {ok:false,reason:'网站报告附件上传失败，请核对文件限制或网站服务状态'};
      }
      const receipt = fileFieldValue(input);
      if (receipt === fileData.name) return {ok:true,action:'upload_file',index,value:fileData.name,
        verified:true,receipt:status.includes(fileData.name) ? 'website-filename' : 'native-file'};
      const photo = /\.(?:jpe?g|png|gif|webp)$/i.test(fileData.name) &&
        Array.from(area?.querySelectorAll('img[src]') || []).some(image => !previousImages.has(image.src));
      if (photo) return {ok:true,action:'upload_file',index,value:fileData.name,verified:true,receipt:'photo-preview'};
    }
    return {ok:false,reason:'上传事务超时：网站尚未显示附件文件名或照片回执'};
  }

  async function closeResumeTransactions() {
    visibilityCache = new Map();
    const layer = focusedEditorLayer();
    if (layer && transactionTrigger?.isConnected) {
      const arrow=Array.from(transactionTrigger.closest('.phoenix-select')?.querySelectorAll('.phoenix-select__switchArrow') || [])
        .find(isVisible);
      if (arrow) {
        arrow.click();
        await sleep(80);
        visibilityCache = new Map();
        if (!focusedEditorLayer()) { transactionTrigger=null; return {ok:true}; }
      }
    }
    const close = layer && Array.from(layer.querySelectorAll('button,[role="button"],a,div,span')).find(el =>
      isVisible(el) && (el.matches('.el-dialog__headerbtn') || /^(close|关闭|取消)$/i.test(tidyLabel(el.getAttribute('aria-label') || el.textContent || ''))));
    if (close) close.click();
    else if (platformDrivers.closeTransactions(document, location.hostname)) { /* 平台已处理关闭事件 */ }
    else if (widgetDrivers.closeOpenTransactions) widgetDrivers.closeOpenTransactions(document);
    else {
      const escape = new KeyboardEvent('keydown', { bubbles:true, cancelable:true, key:'Escape', code:'Escape', keyCode:27, which:27 });
      (document.activeElement || document).dispatchEvent(escape);
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:'Escape', code:'Escape', keyCode:27, which:27 }));
      document.activeElement?.blur?.();
      document.body?.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, clientX:1, clientY:1 }));
    }
    await sleep(80);
    visibilityCache = new Map();
    const remaining=focusedEditorLayer();
    const retryTarget=close || transactionTrigger?.closest?.('.form-item')?.querySelector('.form-item__label') ||
      transactionTrigger?.closest?.('.phoenix-select')?.querySelector('.phoenix-select__switchArrow');
    const box=remaining && retryTarget?.getBoundingClientRect();
    return {ok:!remaining,reason:remaining ? '选择器仍展开，关闭事务尚未回读' : undefined,
      retryPoint:box?.width && box?.height ? {x:box.left+box.width/2,y:box.top+box.height/2} : undefined};
  }

  // 页面结构体检：一个控件都采不到时，靠它看清"页面上到底有什么、哪些看着像能点"。
  // 面向移动端框架尤其重要 —— 它们常不设 cursor:pointer，光看样式会以为整页都不可点。
  const DUMP_TAG_SELECTOR = "div,span,li,a,button,section,article,p,h1,h2,h3,h4,td,label,i,em,strong";
  // 列表行/卡片上常出现的文案，用来快速定位"入口在哪"
  const ENTRY_KEYWORD_RE = /(不完整|未完成|已完整|去完善|去填写|去补充|必填|编辑|添加|新增|请选择|点击|完善)/;

  function dumpStructure() {
    visibilityCache = new Map();
    buildSectionMarkers();
    const tagCount = {};
    try {
      document.querySelectorAll("*").forEach((el) => {
        const t = el.tagName.toLowerCase();
        tagCount[t] = (tagCount[t] || 0) + 1;
      });
    } catch (_) {}

    const pointerLike = [];
    const entryLike = [];
    const rowLike = [];

    let all;
    try {
      all = Array.from(document.querySelectorAll(DUMP_TAG_SELECTOR));
    } catch (_) {
      return { tagCount, pointerLike, entryLike, rowLike };
    }

    for (const el of all) {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      let cursor = "";
      try {
        cursor = window.getComputedStyle(el).cursor || "";
      } catch (_) {}
      const info = {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 60),
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: Math.round(r.top),
        cursor,
        onclick: !!el.getAttribute("onclick"),
        role: el.getAttribute("role") || "",
        text: text.slice(0, 50)
      };
      if (cursor === "pointer" || info.onclick) {
        if (pointerLike.length < 40) pointerLike.push(info);
      }
      if (text && text.length < 60 && ENTRY_KEYWORD_RE.test(text)) {
        if (entryLike.length < 30) entryLike.push(info);
      }
      // 像一行的文本块：有文字、宽度够、高度像一行、内部没有原生控件
      if (
        text &&
        r.width >= 100 &&
        r.height >= 20 &&
        r.height <= 120 &&
        text.length <= 40 &&
        !el.querySelector(INTERACTIVE_SELECTOR)
      ) {
        if (rowLike.length < 40) rowLike.push(info);
      }
    }

    const snapshotEntries = buildElementTable().filter(entry => entry.context !== 'popup').map(entry => ({
          index:entry.index, section:entry.section, recordIndex:entry.recordIndex,
          dateSlot:entry.dateSlot, label:entry.label, placeholder:entry.placeholder,
          kind:entry.kind, domOrder:entry.domOrder, required:!!entry.required,
          operations:entry.operations, hasValue:!!String(entry.value || '').trim()
        }));

    return {
      url: location.href,
      title: document.title,
      tagCount,
      pointerLike,
      entryLike,
      rowLike,
      addControls:Array.from(document.querySelectorAll('div,span,button,a'))
        .filter(el => /添加|新增/.test(tidyLabel(el.textContent || el.getAttribute('aria-label') || '')) &&
          tidyLabel(el.textContent || '').length < 80 && isVisible(el))
        .slice(0,50).map(el => ({tag:el.tagName,cls:String(el.className || '').slice(0,80),
          text:tidyLabel(el.textContent || '').slice(0,70),
          parentClass:String(el.parentElement?.className || '').slice(0,80),
          parentText:tidyLabel(el.parentElement?.textContent || '').slice(0,70),
          width:Math.round(el.getBoundingClientRect().width),height:Math.round(el.getBoundingClientRect().height),
          cursor:window.getComputedStyle(el).cursor})),
      fieldAncestors: Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea,[role="combobox"]'))
        .filter(isVisible).slice(0,120).map(el => ({
          tag:el.tagName, type:el.getAttribute('type'), placeholder:el.getAttribute('placeholder'),
          derivedLabel:deriveLabel(el),
          ancestors:Array.from((function* () { for (let node=el.parentElement,i=0; node && node!==document.body && i<10; node=node.parentElement,i++) yield node; })())
            .map(node => ({cls:String(node.className || '').slice(0,80),
              controlCount:node.querySelectorAll('input,textarea,select').length,
              captions:Array.from(node.children).filter(child => !child.contains(el) &&
                !child.querySelector('input,textarea,select')).map(child => tidyLabel(child.textContent || ''))
                .filter(value => value.length > 0 && value.length < 36).slice(0,4)}))
        })),
      controlStructure: Array.from(document.querySelectorAll('.ud__select,.ud__picker,.phoenix-radio,.phoenix-select'))
        .filter(isVisible).slice(0,80).map(el=>({
          label:deriveLabel(el.querySelector('input') || el),
          children:[el,...el.querySelectorAll('*')].slice(0,45).map(node=>({
            tag:node.tagName,cls:String(node.className || ''),role:node.getAttribute('role'),
            placeholder:node.getAttribute('placeholder'),type:node.getAttribute('type'),
            checked:node.getAttribute('aria-checked')
          }))
        })),
      fieldStructure: Array.from(document.querySelectorAll('.my-list-item')).map(row => ({
        label: row.querySelector('.header-title')?.textContent?.trim(),
        classes: Array.from(row.querySelectorAll('*')).map(el => ({tag:el.tagName,cls:String(el.className)}))
      })),
      sectionStructure: Array.from(document.querySelectorAll('.set-wrap')).map(row => ({
        label:row.querySelector('.txt-title')?.textContent,
        children:Array.from(row.querySelectorAll('*')).map(el=>({tag:el.tagName,cls:String(el.className)}))
      })),
      iterFormStructure: Array.from(document.querySelectorAll('.mForm')).filter(el =>
        /性别|户籍地址|现居地址|招聘信息来源/.test(el.parentElement?.textContent || '')
      ).slice(0, 20).map(row => ({
        parentText: tidyLabel(row.parentElement?.textContent || '').slice(0, 60),
        children: [row, ...Array.from(row.querySelectorAll('*'))].slice(0, 80).map(el => ({
          tag: el.tagName, cls: String(el.className || ''),
          text: el.matches('input,textarea') ? '' : tidyLabel(el.textContent || '').slice(0, 30),
          name: el.getAttribute('name'), type: el.getAttribute('type'),
          parentClass: String(el.parentElement?.className || '')
        }))
      })),
      // DUMP_STRUCTURE 仅响应弹窗的本地 JSON 下载；SNAPSHOT 与 Jev 请求均不读取此属性。
      // 只导出浮层 DOM 类名和层级，字段内容保留在页面。
      calendarStructure: Array.from(document.querySelectorAll('.el-picker-panel')).filter(isVisible).map(panel => ({
        header:Array.from(panel.querySelectorAll('.el-date-picker__header-label')).map(el => tidyLabel(el.textContent || '')),
        cells:Array.from(panel.querySelectorAll('table td')).map(el => ({
          text:tidyLabel(el.textContent || ''),className:String(el.className || '')
        }))
      })),
      popupStructure: Array.from(document.querySelectorAll(`${OVERLAY_SELECTOR},.searchInputComponent,.layui-laydate`)).filter(isVisible).slice(-12).map(el => ({
        tag: el.tagName, cls: String(el.className),
        children: Array.from(el.querySelectorAll("*")).slice(0,450).map(child => ({
          tag: child.tagName, cls: String(child.className), parentClass: String(child.parentElement?.className || ""),
          style: child.getAttribute("style"), selected: child.getAttribute("aria-selected")
        }))
      })),
      dateControls: Array.from(document.querySelectorAll('input[readonly]')).map(el=>({
        cls:String(el.className),placeholder:el.getAttribute('placeholder'),type:el.getAttribute('type'),
        parentClass:String(el.parentElement?.className || ''),outer:el.outerHTML.replace(/value="[^"]*"/g,'value="[redacted]"').slice(0,500)
      })),
      snapshotEntries,
      mokaFormControls: isMokaFormPage() ?
        Array.from(document.querySelectorAll('input,textarea,button,[role="combobox"]')).filter(isVisible).map(el => ({
          tag:el.tagName, cls:String(el.className || '').slice(0,120), type:el.getAttribute('type'),
          placeholder:el.getAttribute('placeholder'), role:el.getAttribute('role'),
          label:deriveLabel(el), section:sectionForElement(el), dateSlot:localDateSlot(el),
          parentClass:String(el.parentElement?.className || '').slice(0,120),
          grandClass:String(el.parentElement?.parentElement?.className || '').slice(0,120)
        })) : [],
      mokaDeleteControls: isMokaFormPage() ?
        Array.from(document.querySelectorAll('button,[role="button"],div,span')).filter(el =>
          tidyLabel(el.textContent || '') === '删除本条'
        ).map(el => ({
          tag:el.tagName, cls:String(el.className || '').slice(0,160), visible:isVisible(el),
          section:sectionForElement(el), parentClass:String(el.parentElement?.className || '').slice(0,160),
          grandClass:String(el.parentElement?.parentElement?.className || '').slice(0,160)
        })) : []
    };
  }


  // === 执行 select ===
  async function executeSelect(target) {
    const parts = String(target).split(":");
    const elIdx = parts[0];
    const optIdx = parts[1];
    const el = elementRegistry[parseInt(elIdx, 10) - 1];
    if (!el) return { ok: false, reason: `元素 ${elIdx} 不在注册表` };

    if (el.tagName === "SELECT") {
      const opt = el.options[parseInt(optIdx, 10) - 1];
      if (!opt) return { ok: false, reason: `选项 ${optIdx} 不存在` };
      el.value = opt.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, action: "select", target, value: opt.text };
    }

    const optionEls = el.querySelectorAll('.am-picker-col-item,[role="option"], option');
    const optEl = optionEls[parseInt(optIdx, 10) - 1];
    if (!optEl) return { ok: false, reason: `选项 ${optIdx} 不存在` };
    if (el.matches('.am-picker-col')) {
      const selected = el.querySelector('.am-picker-col-item-selected');
      const currentIndex = Array.from(optionEls).indexOf(selected);
      const desiredIndex = parseInt(optIdx, 10) - 1;
      if (currentIndex < 0) return { ok: false, reason: '滚轮缺少当前选中项' };
      if (currentIndex === desiredIndex) return { ok: true, action: 'select', target, verified: true };
      const height = (el.querySelector('.am-picker-col-indicator') || optEl).getBoundingClientRect().height;
      const rect = el.getBoundingClientRect();
      const startY = rect.top + rect.height / 2;
      const endY = startY - (desiredIndex - currentIndex) * height - .25;
      const mouse = (type,y) => el.dispatchEvent(new MouseEvent(type, {
        bubbles:true, cancelable:true, view:window, clientX:rect.left + rect.width / 2, clientY:y, buttons:type==='mouseup'?0:1
      }));
      mouse('mousedown',startY);
      mouse('mousemove',endY);
      await sleep(120);
      mouse('mousemove',endY);
      mouse('mouseup',endY);
      await sleep(400);
      const verified = optEl.classList.contains('am-picker-col-item-selected');
      return { ok:verified, action:'select', target, verified, reason:verified?undefined:'滚轮选值回读不一致' };
    }
    optEl.click();
    return { ok: true, action: "select", target };
  }

  // === 消息处理 ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // executeScript 热替换后，旧监听器留在同一隔离世界中；仅最新版本响应消息。
    if (globalThis.__jevResumeFillerContentVersion !== CONTENT_SCRIPT_VERSION) return false;
    if (!msg || !msg.type) {
      sendResponse({ ok: false, reason: "no_type" });
      return true;
    }

    try {
      switch (msg.type) {
        case "PING":
          sendResponse({ ok: true, url: location.href, version: CONTENT_SCRIPT_VERSION, message: "content script 收到 PING" });
          return true;

        // 只回指纹，不建元素表：给 Service Worker 做"页面是否还是原来那张"的廉价检查
        case "FINGERPRINT":
          sendResponse({ ok: true, url: location.href, fingerprint: computeFingerprint() });
          return true;

        case "SNAPSHOT_REQUEST":
        case "SNAPSHOT_FULL": {
          const table = buildElementTable();
          sendResponse({
            ok: true,
            count: table.length,
            elements: table,
            preview: table.slice(0, 5),
            filters: {
              hidden: hiddenFiltered,
              zeroSize: zeroSizeFiltered,
              popupItems: table.filter((e) => e.context === "popup").length,
              offscreen: table.filter((e) => e.offscreen).length
            },
            page: {
              url: location.href,
              documentId,
              title: document.title,
              activeSection: activeSectionTitle(),
              editorSurface: hasEditorSurface(),
              editorSurfaceId: recordEditorSurface() ? nodeId(recordEditorSurface()) : '',
              editorFrameUrls: Array.from(document.querySelectorAll('iframe')).filter(isVisible).map(el=>el.src),
              platform: platformDrivers.platformId(location.hostname, document) || (isMokaFormPage() ? 'moka-form' : ''),
              text: getPageText(),
              authRequired: /尚未登录|登录时间过长|登录已过期|登录失效|请重新登录|扫码登录/.test(
                document.body?.innerText || document.body?.textContent || '')
            },
            fingerprint: computeFingerprint(),
            diagnostics: { ...collectDiagnostics(), focusedTag: document.activeElement?.tagName,
              editorLayerClass: activeLayer ? String(activeLayer.className) : "none" }
          });
          return true;
        }

        case "CLOSE_TRANSACTIONS": {
          closeResumeTransactions().then(sendResponse);
          return true;
        }
        case "TRANSACTION_STATE": {
          visibilityCache = new Map();
          sendResponse({ok:true,open:!!focusedEditorLayer()});
          return true;
        }
        case "TRANSACTION_OUTSIDE_POINT": {
          const anchor=transactionTrigger?.getBoundingClientRect();
          const y=Math.min(window.innerHeight-140,Math.max(140,(anchor?.top || 140)+120));
          const choices=[[8,y],[window.innerWidth-8,y],
            [Math.max(8,(anchor?.left || 80)-80),Math.min(window.innerHeight-140,y+140)]];
          const point=choices.find(([x,py])=>{
            const hit=document.elementFromPoint?.(x,py);
            return hit && !hit.closest('button,a,input,select,textarea,label,[role="button"]') &&
              !hit.closest('.phoenix-selectList,[role="dialog"],.ant-modal,.el-dialog');
          });
          sendResponse(point ? {ok:true,point:{x:point[0],y:point[1]}} :
            {ok:false,reason:'页面当前没有安全的选择器外点击位置'});
          return true;
        }
        case "TRANSACTION_EXIT_POINT": {
          const target=Array.from(transactionTrigger?.closest?.('.phoenix-select')?.querySelectorAll('.phoenix-select__switchArrow') || [])
            .find(isVisible) || transactionTrigger?.closest?.('.form-item')?.querySelector('.form-item__label');
          const box=target?.getBoundingClientRect();
          sendResponse(box?.width && box?.height ? {ok:true,point:{x:box.left+box.width/2,y:box.top+box.height/2}} :
            {ok:false,reason:'当前选择器没有可定位的退出区域'});
          return true;
        }


        case "MARK_TARGET": {
          const el = elementRegistry[parseInt(msg.index, 10) - 1];
          if (!el) {
            sendResponse({ok:false,reason:`元素 ${msg.index} 不在注册表`});
            return true;
          }
          document.querySelectorAll('[data-jev-fill-target]').forEach(node => node.removeAttribute('data-jev-fill-target'));
          const token = `jev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          el.setAttribute('data-jev-fill-target', token);
          sendResponse({ok:true,token});
          return true;
        }

        case "TRUSTED_CLICK_POINT": {
          sendResponse(trustedClickPoint(msg.index));
          return true;
        }

        case "MOKA_DATE_NEXT_POINT": {
          sendResponse(mokaDateNextPoint(msg.index, msg.value));
          return true;
        }

        case "FEISHU_YEAR_TARGET": {
          sendResponse(feishuYearTarget(msg.index));
          return true;
        }

        case "FEISHU_YEAR_CHOICE_POINT": {
          sendResponse(feishuYearChoicePoint(msg.index, msg.year));
          return true;
        }

        case "FEISHU_RANGE_STATE": {
          sendResponse(feishuRangeState(msg.index));
          return true;
        }

        case "FEISHU_RANGE_SLOT_POINT": {
          sendResponse(feishuRangeSlotPoint(msg.index, msg.slot));
          return true;
        }

        case "FEISHU_RANGE_CHOICE_POINT": {
          sendResponse(feishuRangeChoicePoint(msg.index, msg.slot, msg.axis, msg.value));
          return true;
        }

        case "EXECUTE": {
          const { action, index, value, target } = msg;
          (async () => {
            try {
              let res;
              if (action === "click") res = await executeClick(index);
              else if (action === "pick_date") res = await executeDatePicker(index, msg.value);
              else if (action === "type_text") res = await executeTypeText(index, value);
              else if (action === "upload_file") res = await executeUploadFile(index, msg.file);
              else if (action === "select") res = await executeSelect(target);
              else res = { ok: false, reason: `unknown action ${action}` };
              sendResponse(res);
            } catch (err) {
              sendResponse({ ok: false, reason: err.message });
            }
          })();
          return true;
        }

        case "DUMP_STRUCTURE":
          sendResponse({ ok: true, structure: dumpStructure() });
          return true;

        default:
          return false;
      }
    } catch (err) {
      sendResponse({ok:false,reason:err.message});
      return true;
    }
  });

  try {
    chrome.runtime.sendMessage({type:'CONTENT_LOADED',url:location.href},()=>{ void chrome.runtime.lastError; });
  } catch (_) {}
})();
