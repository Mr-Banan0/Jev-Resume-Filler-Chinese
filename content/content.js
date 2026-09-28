// content/content.js — 阶段3：DOM 快照 + 执行 click/type/select
// 维护一个 elementRegistry 把 Jev 的 index 映射回真实 DOM 节点

(function () {
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
    stableKey: (entry, occurrence) => [entry.section, entry.context, entry.kind, entry.role, entry.label, occurrence].filter(Boolean).join('|'),
    closeOpenTransactions: null
  };

  // 全局索引 → 元素映射（每次快照重建）
  // elementRegistry 存"被点击的节点"，elementStateRegistry 存"读状态的节点"；
  // 代理场景（隐藏 checkbox + 可见 label）下二者不同。
  let elementRegistry = [];
  let elementStateRegistry = [];
  let activeLayer = null;
  let sectionMarkers = [];

  const FORM_SECTION_TITLES = new Set([
    '申请信息', '上传', '个人信息', '教育背景', '教育经历', '实习经历', '工作经历',
    '项目经验', '项目经历', '实习/工作经历', '语言能力', '获奖经历', '自我描述', '其他', '信息确认', '更新说明',
    '求职意向', '家庭情况', '投递意向', '校园活动经历', '校内实践经历', '奖励荣誉',
    '专业技能', '其他信息', '开放性问题', '附件', '陈述情况',
    '个人基本信息', '奖励活动', '社会实践经历', '所获证书', '附加信息', '家庭关系', '获奖情况',
    '英语能力', '其他外语能力', '计算机技能', '证书', '校内职务', '培训经历',
    '其他家庭成员关系', '自我评价', '个人承诺'
  ]);

  // 同一控件族会部署在企业自有域名；以渲染后的表单结构识别，域名仅作早期兜底。
  function isMokaFormPage() {
    return /(^|\.)mokahr\.com$|^careers\.ey\.com\.cn$/i.test(location.hostname) ||
      !!document.querySelector('[class*="sd-Select-container-"]');
  }

  function isFieldCaption(text) {
    const value = tidyLabel(text);
    return !!value && value.length <= 80 && !FORM_SECTION_TITLES.has(value) &&
      !/^(?:必填项未填写|请选择|上传|上传中|添加|删除|请输入|暂无选项|错误|格式错误)(?:[：:].*)?$/.test(value) &&
      !/^(?:如果您|如有多个|如大学|如中国|支持文档|（附免冠照片）)/.test(value) &&
      !/^(?:\d{4}年?|\d{1,2}月?)$/.test(value);
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
    const row = el.closest('.form-item');
    if (!row || (row.querySelectorAll('input,select,textarea').length || 0) > 2) return '';
    for (const child of Array.from(row.children)) {
      if (child.contains(el) || child.querySelector('input,select,textarea')) continue;
      const caption = tidyLabel(child.innerText || child.textContent || '');
      if (isFieldCaption(caption)) return caption.replace(/\s*\*\s*$/, '').trim();
    }
    return '';
  }

  function fileFieldLabel(el) {
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

  function fileFieldValue(el) {
    if (el.files?.[0]?.name) return el.files[0].name;
    if (location.hostname === 'xiaoyuan.zhaopin.com' &&
        el.parentElement?.querySelector('.uploader-img img[src]')) return '已上传照片';
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if ((node.querySelectorAll?.('input[type="file"]')?.length || 0) > 1) break;
      const text = String(node.innerText || node.textContent || '');
      if (/上传中|uploading/i.test(text)) return '';
      const match = text.match(/[\w\u4e00-\u9fff()（）.-]+\.(?:pdf|docx?|pptx?|wps|jpe?g|png|txt)\b/i);
      if (match) return match[0];
    }
    return '';
  }

  function buildSectionMarkers() {
    const isFieldChoice = el => !!el.closest('select,option,[role="option"],[role="listbox"],[role="menu"],.el-select,.el-select-dropdown,.ant-select,.ant-select-dropdown,.ant-cascader-menus');
    const known = Array.from(document.querySelectorAll('body *')).filter(el => {
      if (!isVisible(el) || isFieldChoice(el)) return false;
      const text = tidyLabel(el.textContent || '');
      if (!FORM_SECTION_TITLES.has(text)) return false;
      return !Array.from(el.children).some(child => tidyLabel(child.textContent || '') === text);
    });
    // 已知标题与动态标题一起采集；同一页面常混合通用分区和 ATS 自定义分区。
    const dynamic = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,[role="heading"],[class*="title" i],[class*="header" i]')).filter(el => {
      if (!isVisible(el) || isFieldChoice(el)) return false;
      const text = tidyLabel(el.textContent || '');
      if (text.length < 2 || text.length > 14) return false;
      if (!/(信息|经历|背景|经验|能力|技能|证书|奖项|成果|项目|实践|作品|上传|确认|意向|声明|教育|工作|实习|培训|语言|资格|家庭|校园|开放|附件)/.test(text)) return false;
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

  function activeSectionTitle() {
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
  function hasEditorSurface() {
    const surfaces = Array.from(document.querySelectorAll(
      '[role="dialog"],.el-dialog,.ant-modal,[class*="drawer"],iframe[src*="resume"]'
    )).filter(isVisible);
    return surfaces.some(surface => {
      const editable = surface.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]').length;
      const commands = tidyLabel(surface.textContent || '');
      return editable > 0 && /(?:保存|提交|确定|取消|返回)/.test(commands);
    });
  }

  function focusedEditorLayer() {
    if (/(^|\.)zhiye\.com$/i.test(location.hostname)) {
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
  // 荣耀把字段标题放在同一张 my-list-item 卡片的 header-title 中，真正响应点击的
  // 是 am-list-extra。把这一组 DOM 结构识别为选择器，避免只采到文本输入框。
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
      .slice(0,3).map(el=>el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.type).join('|');
    const metadata=new Map();
    for (const {stateEl,entry} of items) {
      if (entry.context==='popup' || Number.isInteger(entry.recordIndex) || !stateEl) continue;
      for (let node=stateEl.parentElement,depth=0;node && depth<9;node=node.parentElement,depth++) {
        if (!metadata.has(node)) {
          const controls=node.querySelectorAll('input:not([type=hidden]),textarea,select');
          const peers=controls.length>=1 && !/^(?:text|radio|checkbox|textarea|select-one)(?:\|(?:text|radio|checkbox|textarea|select-one))*$/.test(signature(node)) ? Array.from(node.parentElement?.children || []).filter(peer=>
            peer.tagName===node.tagName && peer.className===node.className &&
            signature(peer)===signature(node) && peer.querySelectorAll('input:not([type=hidden]),textarea,select').length>=1) : [];
          metadata.set(node,peers.length>1 ? peers.indexOf(node) : null);
        }
        if (metadata.get(node)!==null) { entry.recordIndex=metadata.get(node); break; }
      }
    }
  }

  function annotateBeisenRecordMetadata(items) {
    if (!/(^|\.)zhiye\.com$/i.test(location.hostname)) return;
    const anchors = new Map([
      ['教育经历', /^(学校|学校名称)$/],
      ['实习经历', /^单位名称$/],
      ['工作经历', /^公司名称$/],
      ['家庭情况', /^姓名$/],
      ['获奖情况', /^奖励名称$/]
    ]);
    for (const [section,anchor] of anchors) {
      let recordIndex=-1;
      for (const {entry} of items.filter(item=>item.entry.section===section && item.entry.context!=='popup')) {
        if (anchor.test(String(entry.label || '').replace(/\s*\*\s*$/,'').trim()) &&
            ['input','combobox'].includes(entry.kind)) recordIndex+=1;
        if (recordIndex>=0 && !['card','action','section-entry'].includes(entry.kind)) entry.recordIndex=recordIndex;
      }
    }
  }

  function deriveRole(el) {
    if (el.matches('.my-button,.set-wrap')) return 'button';
    if (el.matches('.mFormRadio li')) return 'radio';
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = el.getAttribute("type");
    if (isAmListSelect(el)) return "combobox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
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
    if (el.matches('.set-wrap')) return 'section-entry';
    if (el.matches('.mFormRadio li')) return 'custom-radio';
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const hasPopup = el.getAttribute("aria-haspopup");
    const isReadonly = el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true";
    const labelText = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("name") || ""}`;
    const mokaSearch = /(请输入就读学校|请输入专业名称|请输入学校|请输入专业)/.test(labelText);
    const mokaHost = isMokaFormPage();
    const mokaPlaceholder = tidyLabel(el.getAttribute("placeholder") || "");
    const mokaFullDate = mokaHost && tag === "input" && isReadonly &&
      /日期（年月日）|日期\(年月日\)/.test(mokaPlaceholder);
    // Moka 的选择器使用普通、可写 input 承载当前值，没有 readonly、role 或
    // aria-haspopup。年/月和“请选择”类字段只能从弹层选择；把它们当文本框时，
    // input 事件会短暂出现但组件不会提交值。
    const mokaSelectInput = mokaHost && tag === "input" && !mokaSearch &&
      (/^(?:请选择|年|月|选择意向工作城市|请输入籍贯|请输入国家\/地区|请输入国籍\/地区|请选择省市区)$/.test(mokaPlaceholder) ||
       !!el.closest('.sd-Select-container-1Eq4x,[class*="sd-Select-container-"]')) &&
      !/^\+\d{1,4}$/.test(String(el.value || "").trim());

    if (type === "file") return "file";
    if (isEditableEl(el)) return "richtext";
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
    if (mokaFullDate) return "moka-date";
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
    if (role === "combobox" || hasPopup === "listbox" || hasPopup === "menu" || hasPopup === "tree") {
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

  function collectOverlayItems(seen) {
    const items = [];
    const numericLabels = new Set();
    let overlays;
    try {
      overlays = [...document.querySelectorAll(OVERLAY_SELECTOR), ...(activeLayer ? [activeLayer] : [])];
    } catch (_) {
      return items;
    }

    overlays.forEach((overlay) => {
      if (overlay === document.body || overlay === document.documentElement) return;
      if (activeLayer && overlay !== activeLayer && !activeLayer.contains(overlay)) return;
      if (!isVisible(overlay)) return;
      const r = overlay.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;

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
        // 只取最内层可点条目：自身不再包含其它候选条目
        if (!calendarCell && el.querySelector(OVERLAY_ITEM_SELECTOR)) return;
        if (!isVisible(el)) return;
        const ownText = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
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
    '.set-wrap',
    '.mFormRadio li',
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
    ,'.el-picker-panel'
    ,'.ant-calendar'
    ,'.ant-picker-dropdown'
    ,'.mFormSelect ul'
    ,'.mFormCity ul'
  ].join(",");

  function inPopupContainer(el) {
    try {
      return !!el.closest(POPUP_CONTAINER_SELECTOR);
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
                /(?:教育|工作|实习|项目|语言|奖励|荣誉|家庭)/.test(el.parentElement?.textContent || '')),
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
    const priority = ({text}) => /^(?:\+\s*)?(?:添加|新增)(?:新的)?(?:教育|实习|工作|项目|语言|奖励|获奖|家庭)/.test(text) ? 3 :
      /(?:教育|工作|实习|项目|校园|语言|技能|奖励|荣誉|附件|个人信息|求职意向).{0,16}(?:添加|新增|编辑|完善|填写|未完成)/.test(text) ? 2 : 1;
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
    const seen = new Set();
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
      entry.pickerBranch = opts.context === 'popup' && !!(stateEl?.hasAttribute?.('aria-expanded') ||
        stateEl?.querySelector?.('[class*="youcejiantou"]') ||
        Array.from(stateEl?.parentElement?.children || []).some(peer=>peer!==stateEl && peer.querySelector?.('[class*="youcejiantou"]'))) &&
        String(opts.label || '').length < 24;
      entry.widgetFamily = widgetDrivers.classify({
        kind, role, tagName: stateEl?.tagName, editable: stateEl ? isEditableEl(stateEl) : false
      });
      const section = opts.section || sectionForElement(targetEl || stateEl);
      if (section) entry.section = section;
      const dateSlot = localDateSlot(stateEl);
      if (dateSlot !== null) entry.dateSlot = dateSlot;
      let mokaRequired = false;
      if (isMokaFormPage() && stateEl) {
        let node = stateEl.parentElement;
        for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
          const controls = node.querySelectorAll('input,textarea,select').length;
          const caption = Array.from(node.children).find(child => !child.contains(stateEl) &&
            /\*/.test(String(child.innerText || child.textContent || '').slice(0, 120)));
          if (controls <= 3 && caption) { mokaRequired = true; break; }
          if (controls > 3) break;
        }
      }
      let localRequired = !!stateEl?.closest?.('.el-form-item.is-required,.ant-form-item-required,[aria-required="true"]');
      if (stateEl?.matches?.('input,textarea,select')) {
        for (let node = stateEl.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
          if (node.querySelectorAll('input:not([type="hidden"]),textarea,select').length > 3) break;
          const captions = Array.from(node.children).filter(child => !child.contains(stateEl));
          if (captions.some(child => /^(?:\*|＊)$/.test(tidyLabel(child.textContent || '')) ||
              child.matches('.is-required,[class*="required"],[class*="bitian"]') ||
              child.querySelector('.ant-form-item-required,.is-required,[aria-required="true"]'))) {
            localRequired = true;
            break;
          }
        }
      }
      if (stateEl.required || stateEl.getAttribute('aria-required') === 'true' ||
          stateEl.closest('.my-list-item')?.querySelector('.header-title .icon-bitian') ||
          mokaRequired || localRequired) entry.required = true;
      if (/(^|\.)zhiye\.com$/i.test(location.hostname) && stateEl) {
        const error=stateEl.closest('.form-item')?.querySelector('.form-item__error');
        if (error && isVisible(error) && tidyLabel(error.textContent || '')) {
          entry.validationError=tidyLabel(error.textContent || '').slice(0,100);
        }
      }
      if (opts.context) entry.context = opts.context;
      if (opts.calendarDate) entry.calendarDate = opts.calendarDate;
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
      if (stateEl && stateEl.checked !== undefined && (role === "checkbox" || role === "radio")) {
        entry.checked = stateEl.checked;
      }
      if (kind === 'custom-radio') {
        entry.checked = stateEl.classList.contains('cur');
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
        kind: "custom-checkbox",
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
        if (el.matches('input[type="file"]')) {
          seen.add(el);
          const label = fileFieldLabel(el);
          pushEntry(el, {
            role: 'button', kind: 'file', targetEl: el, label, value: fileFieldValue(el),
            operations: ['UPLOAD_FILE'], offscreen: false
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
        const kind = deriveKind(el, role);
        const phoenixTarget = kind === 'custom-select' ? el.closest('.phoenix-select') : null;
        const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
        // 浮层里的选项无论走哪条采集路径，都要带上 popup 标记：
        // 它对 Jev 是"点了就消失，要立刻做决定"的信号。
        const isPopupItem = (["option", "menuitem", "radio", "checkbox", "textbox"].includes(role) ||
          role === 'button' && (!!el.closest('.el-picker-panel') || !!activeLayer?.contains(el))) &&
          (inPopupContainer(el) || !!activeLayer?.contains(el));
        pushEntry(el, {
          role,
          kind,
          targetEl:phoenixTarget || (kind === 'section-entry' ? el.querySelector('.add-btn') || el : el),
          label: deriveLabel(el),
          value: getValue(el, kind),
          // 禁用的控件不给出任何操作，避免 Jev 选到一个点不动的目标
          operations: disabled ? [] : deriveOperations(role, el, kind),
          context: isPopupItem ? "popup" : undefined,
          formRuleSignals: formRuleSignals(el),
          disabled: disabled || undefined,
          offscreen
        });
      });
    });

    // 卡片式可点容器：有些网申站（如荣耀的分段列表页）整页没有一个原生控件，
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
    annotateRepeatedContainers(allEntriesInDomOrder);
    annotateBeisenRecordMetadata(allEntriesInDomOrder);
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
    const stableOccurrences = new Map();
    const out = [];
    for (const { stateEl, targetEl, entry } of ordered) {
      const stableBase = [entry.section, entry.context, entry.widgetFamily, entry.role, tidyLabel(entry.label)].filter(Boolean).join('|');
      const occurrence = (stableOccurrences.get(stableBase) || 0) + 1;
      stableOccurrences.set(stableBase, occurrence);
      entry.stableKey = widgetDrivers.stableKey(entry, occurrence);
      entry.index = String(out.length + 1);
      if (entry.options) {
        entry.options = entry.options.map((opt, i) => ({ ...opt, index: `${entry.index}:${i + 1}` }));
      }
      out.push(entry);
      // 注册的是"点击目标"：代理场景下是那个可见的 label，点它原生就会转发给隐藏的 input
      elementRegistry.push(targetEl);
      elementStateRegistry.push(stateEl);
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
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {
      try {
        el.scrollIntoView();
      } catch (_) {}
    }
  }

  // === 执行 click ===
  async function executeClick(index) {
    const pos = parseInt(index, 10) - 1;
    const el = elementRegistry[pos];
    if (!el) return { ok: false, reason: `元素 ${index} 不在注册表` };
    // 代理场景：点的是可见 label，状态藏在隐藏的 input 里
    const stateEl = elementStateRegistry[pos] || el;
    const wasChecked = stateEl.checked;
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
    const clickTarget = mokaClearTarget || beisenChoiceTarget || leafTarget || el;
    const r = clickTarget.getBoundingClientRect();
    if (!notOccluded(clickTarget, r)) {
      // 不强制失败，因为元素可能合法地被父级覆盖；记录但继续
      console.warn(`${TAG} click 目标可能被遮挡`, index);
    }
    if (!mokaClearTarget) safeScrollIntoView(clickTarget);
    if (!mokaClearTarget && typeof clickTarget.focus === "function") {
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
    if (!mokaClearTarget && !beisenChoiceTarget && !clickTarget.matches?.('.phoenix-select input')) {
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

    // 该 input 是 React 只读投影；点击日历日期才能更新表单状态与校验器。
    // 按年月头和周一开头的日期网格定位，避免依赖构建后会变化的 CSS 类名。
    safeScrollIntoView(el);
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
    if (!currentCalendar()) return {ok:false,reason:'Moka 日期面板未打开'};

    const monthNames = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
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

    const targetYear = Number(match[1]);
    const targetMonth = Number(match[2]);
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

  async function executeDatePicker(index, value) {
    const el = elementRegistry[parseInt(index, 10) - 1];
    if (!el || !el.matches('input[readonly]')) return {ok:false,reason:'日期控件已变化'};
    if (isMokaFormPage() &&
        /日期（年月日）|日期\(年月日\)/.test(String(el.getAttribute('placeholder') || ''))) {
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

    if (type === "month") {
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

    // 第一次尝试
    await setValueWithEvents(el, target);
    await sleep(50);
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
      await setValueWithEvents(el, target);
      await sleep(50);
      const actual2 = getCurrentValue(el);
      if (actual2 === target) {
        el.blur?.();
        el.dispatchEvent(new FocusEvent('focusout', { bubbles:true }));
        return { ok: true, action: "type_text", index, value: target, verified: true, retried: true, note: norm.note };
      }
      return { ok: false, reason: "回读验证失败", expected: target, actual: actual2, note: norm.note };
    } catch (err) {
      return { ok: false, reason: `重试异常: ${err.message}`, expected: target };
    }
  }

  async function executeUploadFile(index, fileData) {
    const el = elementRegistry[parseInt(index, 10) - 1];
    if (!el || !el.matches?.('input[type="file"]')) return { ok:false, reason:`元素 ${index} 不是文件输入框` };
    if (!fileData?.dataUrl || !fileData?.name) return { ok:false, dataGap:true, reason:'插件中尚未选择文件' };
    const previousPhotoSrc = el.parentElement?.querySelector('.uploader-img img[src]')?.src || '';
    const photoUploaded = () => location.hostname === 'xiaoyuan.zhaopin.com' &&
      /\.(?:jpe?g|png|gif|webp)$/i.test(fileData.name) &&
      !!el.parentElement?.querySelector('.uploader-img img[src]')?.src &&
      el.parentElement.querySelector('.uploader-img img[src]').src !== previousPhotoSrc;
    const response = await fetch(fileData.dataUrl);
    const blob = await response.blob();
    const file = new File([blob], fileData.name, { type:fileData.type || blob.type || 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    el.files = transfer.files;
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    await sleep(400);
    const actual = el.files?.[0]?.name || '';
    if (actual !== fileData.name) {
      // 招聘站点上传成功后常重置原生 file input；改读网站生成的文件名回执。
      for (let attempt=0; attempt<8; attempt++) {
        if (photoUploaded()) return {ok:true,action:'upload_file',index,value:fileData.name,
          verified:true,receipt:'photo-preview'};
        const pageText = String(document.body?.innerText || document.body?.textContent || '');
        if (pageText.includes(fileData.name) && !/上传中|uploading/i.test(pageText.slice(
          Math.max(0,pageText.indexOf(fileData.name)-30),pageText.indexOf(fileData.name)+fileData.name.length+30))) {
          return {ok:true,action:'upload_file',index,value:fileData.name,verified:true,receipt:'page-filename'};
        }
        await sleep(500);
      }
      return {ok:false,reason:'文件选择和网站文件名均未回读成功'};
    }
    const isMokaResume = isMokaFormPage() && /\.(?:pdf|docx?|pptx?|wps|txt)$/i.test(fileData.name);
    if (isMokaResume) {
      const fileLabel = fileFieldLabel(el);
      const uploadArea = el.closest('[class*="upload"],[class*="Upload"]') || el.parentElement;
      const visualArea = uploadArea?.parentElement?.parentElement || uploadArea;
      const statusText = () => String(visualArea?.textContent || '');
      const uploadedFileVisible = () => Array.from(document.querySelectorAll('input[type="file"]'))
        .some(input => {
          if (fileFieldLabel(input) !== fileLabel) return false;
          let node = input.parentElement;
          for (let depth=0; node && depth<6; depth+=1, node=node.parentElement) {
            if (node.querySelectorAll('input[type="file"]').length > 1) break;
            const text = String(node.innerText || node.textContent || '');
            if (text.includes(fileData.name) && !/上传中|uploading/i.test(text)) return true;
          }
          return false;
        });
      let sawUploadProgress = false;
      for (let elapsed=0; elapsed<90000; elapsed+=1000) {
        if (uploadedFileVisible()) return {ok:true,action:'upload_file',index,value:fileData.name,verified:true};
        const status = statusText();
        if (/上传中|uploading/i.test(status)) sawUploadProgress = true;
        if (sawUploadProgress && !/上传中|uploading/i.test(status)) {
          await sleep(1500);
          if (uploadedFileVisible()) {
            return {ok:true,action:'upload_file',index,value:fileData.name,verified:true};
          }
          return {ok:false,reason:'网站处理上传后未保留简历附件；请核对附件格式或网站服务状态'};
        }
        await sleep(1000);
      }
      return uploadedFileVisible() ? {ok:true,action:'upload_file',index,value:fileData.name,verified:true} :
        {ok:false,reason:'网站处理上传后未显示简历文件名；请核对附件格式或网站服务状态'};
    }
    return {ok:true,action:'upload_file',index,value:actual,verified:true};
  }

  function closeResumeTransactions() {
    const layer = focusedEditorLayer();
    const close = layer && Array.from(layer.querySelectorAll('button,[role="button"]')).find(el =>
      isVisible(el) && (el.matches('.el-dialog__headerbtn') || /^(close|关闭|取消)$/i.test(tidyLabel(el.getAttribute('aria-label') || el.textContent || ''))));
    if (close) { close.click(); return; }
    if (widgetDrivers.closeOpenTransactions) widgetDrivers.closeOpenTransactions(document);
    else {
      const escape = new KeyboardEvent('keydown', { bubbles:true, cancelable:true, key:'Escape', code:'Escape', keyCode:27, which:27 });
      (document.activeElement || document).dispatchEvent(escape);
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:'Escape', code:'Escape', keyCode:27, which:27 }));
      document.activeElement?.blur?.();
      document.body?.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, clientX:1, clientY:1 }));
    }
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
          ancestors:Array.from((function* () { for (let node=el.parentElement,i=0; node && i<4; node=node.parentElement,i++) yield node; })())
            .map(node => ({cls:String(node.className || '').slice(0,80),
              controlCount:node.querySelectorAll('input,textarea,select').length,
              captions:Array.from(node.children).filter(child => !child.contains(el) &&
                !child.querySelector('input,textarea,select')).map(child => tidyLabel(child.textContent || ''))
                .filter(value => value.length > 0 && value.length < 36).slice(0,4)}))
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

  const ITER_SECTIONS = ['个人信息','求职意向','教育经历','社会实习经历','项目经验','校内实践经历','奖励','技能特长','自我评价'];
  let iterLastNavigatedSection='';

  function iterState() {
    if (location.hostname !== 'iter.stongyw.cn' || location.pathname !== '/web/school/resume/index.html') return null;
    visibilityCache = new Map();
    const cards = Array.from(document.querySelectorAll('.resumeContent')).filter(el=>{
      const rect=el.getBoundingClientRect();
      return isVisible(el) && rect.width>0 && rect.height>0;
    });
    const activeLink=Array.from(document.querySelectorAll('a[href="javascript:;"]')).find(el=>
      isVisible(el) && (el.classList.contains('cur') || el.parentElement?.classList.contains('cur') || el.closest('li')?.classList.contains('cur')) &&
      ITER_SECTIONS.some(name=>tidyLabel(el.textContent).includes(name)));
    const current = cards.map(card=>ITER_SECTIONS.find(name=>tidyLabel(card.textContent).includes(name))).find(Boolean) ||
      ITER_SECTIONS.find(name=>tidyLabel(activeLink?.textContent || '').includes(name)) || iterLastNavigatedSection;
    const sections = Array.from(document.querySelectorAll('a[href="javascript:;"]'))
      .filter(el=>isVisible(el) && el.getBoundingClientRect().width>0)
      .map(el=>ITER_SECTIONS.find(name=>tidyLabel(el.textContent).includes(name))).filter(Boolean);
    const editorOpen = Array.from(document.querySelectorAll('iframe[src*="/web/school/resume/"]')).some(el=>isVisible(el));
    const editorButtons=Array.from(document.querySelectorAll('.resume-btn')).filter(el=>{
      const rect=el.getBoundingClientRect();
      return isVisible(el) && rect.width>0 && rect.height>0 && /(编辑|添加)/.test(el.textContent);
    });
    return {current,sections:[...new Set(sections)],editorOpen,editorCount:editorButtons.length,
      overviewText:cards.map(card=>String(card.textContent || '').replace(/\s+/g,' ').trim()).join(' ').slice(0,12000)};
  }

  function iterNavigate(section) {
    const state=iterState();
    if (!state || state.editorOpen || !ITER_SECTIONS.includes(section)) return {ok:false,reason:'分区导航不可用'};
    const link=Array.from(document.querySelectorAll('a[href="javascript:;"]'))
      .find(el=>isVisible(el) && tidyLabel(el.textContent).includes(section));
    if (!link) return {ok:false,reason:`没有找到「${section}」入口`};
    link.click();
    iterLastNavigatedSection=section;
    return {ok:true,section};
  }

  function iterOpenEditor(editorIndex=0) {
    const state=iterState();
    if (!state || state.editorOpen) return {ok:false,reason:'当前无法打开编辑弹窗'};
    visibilityCache = new Map();
    const buttons=Array.from(document.querySelectorAll('.resume-btn')).filter(el=>{
      const r=el.getBoundingClientRect();
      return isVisible(el) && r.width>0 && r.height>0 && /(编辑|添加)/.test(el.textContent);
    });
    if (!buttons[editorIndex]) return {ok:false,reason:`当前分区没有第 ${editorIndex+1} 个编辑入口`};
    buttons[editorIndex].click();
    return {ok:true,section:state.current};
  }

  function iterClickDialogButton(label) {
    if (!iterState()) return {ok:false,reason:'当前不是受支持的简历总览'};
    visibilityCache = new Map();
    const buttons=Array.from(document.querySelectorAll('.layui-layer-btn a')).filter(el=>{
      const r=el.getBoundingClientRect();
      return isVisible(el) && r.width>0 && r.height>0 && tidyLabel(el.textContent)===label;
    });
    if (!buttons.length) return {ok:false,reason:`没有找到弹窗「${label}」按钮`};
    if (label === '确定') {
      for (const frame of document.querySelectorAll('iframe[src*="/web/school/resume/"]')) {
        try {
          const focused=frame.contentDocument?.activeElement;
          if (focused?.matches('input,textarea')) {
            focused.blur();
            focused.dispatchEvent(new Event('change',{bubbles:true}));
          }
        } catch (_) {}
      }
    }
    const button=buttons[buttons.length-1];
    button.focus();
    button.click();
    return {ok:true};
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
    if (!msg || !msg.type) {
      sendResponse({ ok: false, reason: "no_type" });
      return true;
    }

    try {
      switch (msg.type) {
        case "PING":
          sendResponse({ ok: true, url: location.href, message: "content script 收到 PING" });
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
              title: document.title,
              activeSection: activeSectionTitle(),
              editorSurface: hasEditorSurface(),
              platform: isMokaFormPage() ? 'moka-form' : '',
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
          closeResumeTransactions();
          sendResponse({ok:true});
          return true;
        }

        case "MATCH_RECORD": {
          const identities = (Array.isArray(msg.identities) ? msg.identities : [])
            .map(value => String(value || '').trim()).filter(value => value.length >= 2);
          let section = '';
          const matches = Array.from(document.querySelectorAll('.set-wrap,.resumer-item-list-item'))
            .filter(row => {
              if (row.matches('.set-wrap')) {
                section = tidyLabel(row.querySelector('.txt-title')?.textContent || '');
                return false;
              }
              return section === msg.section && isVisible(row) &&
                identities.some(identity => row.textContent.includes(identity));
            });
          if (msg.click && matches.length === 1) {
            safeScrollIntoView(matches[0]);
            matches[0].click();
          }
          sendResponse({ok:true, found:matches.length === 1, count:matches.length,
            clicked:!!msg.click && matches.length === 1});
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

        case "ITER_STATE":
          sendResponse({ok:true,state:iterState()});
          return true;
        case "ITER_NAVIGATE":
          sendResponse(iterNavigate(msg.section));
          return true;
        case "ITER_OPEN_EDITOR":
          sendResponse(iterOpenEditor(msg.editorIndex || 0));
          return true;
        case "ITER_DIALOG_BUTTON":
          sendResponse(iterClickDialogButton(msg.label));
          return true;

        default:
          // 不认识的消息交给其他监听者处理，避免抢答 Popup 发给 SW 的消息
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, reason: err.message });
      return true;
    }
  });

  // 上报 SW 自己已加载
  try {
    chrome.runtime.sendMessage({ type: "CONTENT_LOADED", url: location.href }, () => {
      if (chrome.runtime.lastError) {
        // 扩展刚加载属正常
      }
    });
  } catch (_) {}
})();
