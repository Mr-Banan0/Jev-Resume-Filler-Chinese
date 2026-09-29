// 在 jsdom 里加载 content.js，验证控件分类、浮层采集、Shadow DOM
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const mokaYears = Array.from({ length: 201 }, (_, i) => 2126 - i)
  .flatMap((year) => [`<li class="option-item">${year}</li>`, `<li class="option-item">${year}</li>`])
  .join('');
const html = `<!DOCTYPE html><html><body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="top"><button id="next">下一步</button><a href="https://x.com/help">帮助</a></div>
  <form id="resume-form">
    <label for="name">姓名</label><input id="name" type="text" placeholder="请输入姓名" />
    <input id="birth" type="text" placeholder="出生日期" readonly aria-haspopup="dialog" />
    <div>毕业时间</div><input id="moka-full-date" type="text" placeholder="日期（年月日）" readonly />
    <input id="email" type="text" placeholder="电子邮箱" />
    <select id="gender"><option value="">请选择</option><option value="M">男</option><option value="F">女</option></select>
    <div role="combobox" aria-label="籍贯" aria-expanded="true">浙江</div>
    <input id="company" type="text" placeholder="公司名称" aria-haspopup="listbox" />
    <div><span>计算机科学与技术</span><input id="moka-major" type="text" placeholder="请输入专业名称" /></div>
    <div><input id="moka-school-search" type="text" placeholder="请输入就读学校" value="示例大学" /><span id="moka-school-clear"></span><div class="school-suggestions">示例大学继续教育学院</div></div>
    <input id="moka-year" type="text" placeholder="年" />
    <div class="moka-field"><span>学历</span><div><span>硕士</span><input id="moka-select" type="text" placeholder="请选择" /></div></div>
    <div><input id="moka-code" type="text" value="+86" /><input id="moka-phone" type="text" placeholder="请输入手机号" /></div>
    <div>教育背景</div>
    <div class="mFormTime">
      <label role="combobox"><span>2021</span><input id="edu-start-year" type="text" placeholder="年" value="2021" readonly /></label>
      <label role="combobox"><span>9</span><input id="edu-start-month" type="text" placeholder="月" value="9" readonly /></label>
      <label role="combobox"><span>2025</span><input id="edu-end-year" type="text" placeholder="年" value="2025" readonly /></label>
      <label role="combobox"><span>6</span><input id="edu-end-month" type="text" placeholder="月" value="6" readonly /></label>
    </div>
    <div id="editor" contenteditable="true" data-placeholder="自我介绍"></div>
    <input id="far-away" type="text" placeholder="视口外的详细地址" />
    <label><input id="agreement" type="checkbox" />我已阅读并同意招聘服务用户协议和隐私政策</label>
    <fieldset><legend>是否有亲属在本公司工作（包含曾经）</legend>
      <label><input id="relative-yes" name="relativeEmployment" type="radio" value="是" />是</label>
      <label><input id="relative-no" name="relativeEmployment" type="radio" value="否" />否</label>
    </fieldset>
    <div class="my-list-item"><div class="header-title">政治面貌</div><div class="am-list-item"><div class="am-list-extra select-am-list-extra">请选择政治面貌</div></div></div>
    <div class="my-list-item"><div class="header-title">出生日期</div><div class="datePicker-list-item-wrap"><div class="am-list-extra">请选择出生日期</div></div></div>
    <input type="hidden" id="csrf" value="xxx" />
  </form>
  <my-widget></my-widget>
  <div class="select-dropdown" role="listbox">
    <ul>
      <li class="option-item">男</li>
      <li class="option-item">女</li>
      <li class="option-item" aria-disabled="true">保密</li>
    </ul>
  </div>
  <div id="year-dropdown" class="year-dropdown" role="listbox" style="display:none"><ul>${mokaYears}</ul></div>
  <div id="shadow-host"></div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'https://app-tc.mokahr.com/campus-recruitment/example'
});
const { window } = dom;

window.HTMLElement.prototype.getBoundingClientRect = function () {
  // 模拟一个在视口下方 3000px 的字段
  if (this.id === 'far-away' || ['edu-start-year','edu-start-month','edu-end-month'].includes(this.id)) {
    return { top: 3000, left: 10, right: 210, bottom: 3030, width: 200, height: 30, x: 10, y: 3000 };
  }
  return { top: 10, left: 10, right: 210, bottom: 40, width: 200, height: 30, x: 10, y: 10 };
};
window.document.elementFromPoint = () => window.document.getElementById('moka-school-clear');

const host = window.document.getElementById('shadow-host');
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<input id="native-place" placeholder="籍贯" />`;

const listeners = [];
window.chrome = {
  runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, sendMessage: (_m, cb) => { if (cb) cb(); }, lastError: null }
};

window.eval(readFileSync(new URL('../content/widget-drivers.js', import.meta.url), 'utf8'));
window.eval(readFileSync(new URL('../content/platform-drivers.js', import.meta.url), 'utf8'));
window.eval(readFileSync(new URL('../content/content.js', import.meta.url), 'utf8'));

const handler = listeners[0];
const res = await new Promise((resolve) => handler({ type: 'SNAPSHOT_REQUEST' }, {}, resolve));
let schoolSelectionCleared = false;
window.document.getElementById('moka-school-clear')['__reactProps$test'] = {
  onClick: () => {
    schoolSelectionCleared = true;
    window.document.getElementById('moka-school-search').value = '';
  }
};
const schoolEntry = res.elements.find((e) => e.placeholder === '请输入就读学校');
await new Promise((resolve) => handler({ type:'EXECUTE', action:'click', index:schoolEntry.index }, {}, resolve));
window.document.getElementById('year-dropdown').style.display = 'block';
window.document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.document.getElementById('year-dropdown').style.display = 'none';
});
const longYearRes = await new Promise((resolve) => handler({ type: 'SNAPSHOT_REQUEST' }, {}, resolve));
window.document.getElementById('name').value = '已有姓名';
await new Promise((resolve) => handler({ type: 'CLOSE_TRANSACTIONS' }, {}, resolve));
const afterCloseRes = await new Promise((resolve) => handler({ type: 'SNAPSHOT_REQUEST' }, {}, resolve));


console.log('识别到控件数:', res.count);
for (const el of res.elements) {
  const bits = [el.kind, el.context ? `ctx=${el.context}` : '', el.disabled ? 'disabled' : '', el.operations.join('/')].filter(Boolean);
  console.log(`  ${el.index} [${el.role}] ${el.label}  <${bits.join(' ')}>`);
}

const byLabel = (t) => res.elements.find((e) => e.label.includes(t));
const checks = [
  ['姓名 是普通 input', byLabel('请输入姓名')?.kind === 'input'],
  ['出生日期 判定为 date', byLabel('出生日期')?.kind === 'date'],
  ['只读日期框只能 CLICK', JSON.stringify(byLabel('出生日期')?.operations) === '["CLICK"]'],
  ['Moka 完整日期使用确定性日期执行器', res.elements.some((e) => e.label === '毕业时间' && e.kind === 'moka-date' && JSON.stringify(e.operations) === '["PICK_DATE"]')],
  ['电子邮箱 可输入', (byLabel('电子邮箱')?.operations || []).includes('TYPE_TEXT')],
  ['原生下拉 kind=native-select', res.elements.some(e => e.kind === 'native-select')],
  ['原生下拉带 options', res.elements.some(e => e.kind === 'native-select' && e.options?.length === 3)],
  ['原生下拉标签不拼接全部选项文本', !res.elements.some((e) => (e.label || '').includes('请选择男女'))],
  ['公司输入框判定为联想 combobox', byLabel('公司名称')?.kind === 'combobox'],
  ['联想框同时支持输入与点击', JSON.stringify(byLabel('公司名称')?.operations) === '["TYPE_TEXT","CLICK"]'],
  ['Moka 专业输入框识别为联想控件', byLabel('请输入专业名称')?.kind === 'combobox'],
  ['Moka 联想框从同级节点回读已选值', byLabel('请输入专业名称')?.value === '计算机科学与技术'],
  ['Moka 搜索关键词不会误判为已提交选项', res.elements.find((e) => e.placeholder === '请输入就读学校')?.valueCommitted === false],
  ['Moka 已选学校点击时优先触发清除图标', schoolSelectionCleared],
  ['Moka 年份输入框识别为自定义选择器', byLabel('年')?.kind === 'custom-select'],
  ['Moka 日期标签按 DOM 顺序稳定，不随视口排序漂移',
    res.elements.some((e) => e.label === '入学年份' && e.value === '2021') &&
    res.elements.some((e) => e.label === '入学月份' && e.value === '9') &&
    res.elements.some((e) => e.label === '毕业年份' && e.value === '2025') &&
    res.elements.some((e) => e.label === '毕业月份' && e.value === '6')],
  ['Moka 日期外层选择器与内层 input 只保留一份',
    res.elements.filter((e) => ['入学年份','入学月份','毕业年份','毕业月份'].includes(e.label)).length === 4],
  ['Moka 日期型重复记录附带稳定索引',
    res.elements.filter((e) => ['入学年份','入学月份','毕业年份','毕业月份'].includes(e.label)).every(e => e.recordIndex === 0)],
  ['Moka “请选择”输入框识别为自定义选择器', res.elements.some((e) => e.label === '学历' && e.kind === 'custom-select')],
  ['Moka 自定义选择器从同级节点回读已选值', res.elements.some((e) => e.label === '学历' && e.value === '硕士')],
  ['Moka 无 placeholder 的国家区号根据同组手机框识别', res.elements.some((e) => e.label === '国家区号' && e.value === '+86')],
  ['富文本判定为 richtext', byLabel('自我介绍')?.kind === 'richtext'],
  ['Ant Mobile 下拉识别为自定义选择器', byLabel('政治面貌')?.kind === 'custom-select'],
  ['Ant Mobile 下拉继承同一行字段标题', byLabel('政治面貌')?.label === '政治面貌'],
  ['Ant Mobile 日期选择器识别为自定义选择器', res.elements.some((e) => e.label === '出生日期' && e.kind === 'custom-select')],
  ['浮层选项被采集（男）', res.elements.some((e) => e.context === 'popup' && e.label === '男')],
  ['浮层选项标记 context=popup', res.elements.some((e) => e.context === 'popup')],
  ['Moka 长年份下拉不会截断目标年份', longYearRes.elements.some((e) => e.context === 'popup' && e.label === '2025')],
  ['Moka 重复年份在浮层快照中去重', longYearRes.elements.filter((e) => e.context === 'popup' && e.label === '2025').length === 1],
  ['关闭选择浮层后保留已有字段', !afterCloseRes.elements.some((e) => e.context === 'popup' && e.label === '2025') &&
    window.document.getElementById('name').value === '已有姓名'],
  ['禁用选项 operations 为空', (res.elements.find((e) => e.label === '保密')?.operations || []).length === 0],
  ['Shadow DOM 内籍贯被采集', res.elements.some((e) => e.label.includes('籍贯') && e.kind === 'input')],
  ['视口外字段仍被采集', res.elements.some((e) => e.label === '视口外的详细地址')],
  ['视口外字段带 offscreen 标记', byLabel('视口外的详细地址')?.offscreen === true],
  ['视口内字段不带 offscreen 标记', byLabel('电子邮箱')?.offscreen === undefined],
  ['诊断：DOM 内输入控件计数正确', res.diagnostics?.inputs === 21],
  ['诊断：识别到疑似封闭 Shadow Host', (res.diagnostics?.suspectedClosedShadowHosts || []).includes('my-widget')],
  ['诊断：带回当前页面 URL', /about:blank|^file|^http/.test(res.diagnostics?.url || '')],
  ['模板 noscript 文案未进入 Jev 页面文本', !res.page?.text.includes('You need to enable JavaScript to run this app.')],
  ['模板 noscript 文案未进入诊断正文开头', !res.diagnostics?.bodyTextHead?.includes('You need to enable JavaScript to run this app.')],
  ['隐藏域未收录', !res.elements.some((e) => e.label === 'csrf')]
  ,['协议勾选框带 agreement 规则标记', res.elements.some((e) => e.kind === 'checkbox' && e.formRuleSignals?.includes('agreement'))]
  ,['亲属单选题带 relative-employment 规则标记', res.elements.some((e) => e.role === 'radio' && e.formRuleSignals?.includes('relative-employment'))]
  ,['亲属“否”单选项带原始取值', res.elements.some((e) => e.role === 'radio' && e.optionValue === '否')]
];

console.log('\n=== 断言 ===');
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(pass ? '\n✅ 全部通过' : '\n❌ 存在失败项');
if (!pass) process.exitCode = 1;
