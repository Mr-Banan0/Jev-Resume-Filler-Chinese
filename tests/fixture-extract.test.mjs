// 用离线自测页(tests/fixture/controls-form.html)驱动 content.js，
// 断言"视口外字段可采集""隐藏域排除""自定义下拉展开后出现浮层选项"等行为。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(`${ROOT}/tests/fixture/controls-form.html`, 'utf8');

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

// 视口高 800：把页面里"折线以下"的三个字段放到 3000px 处
const BELOW_FOLD = new Set(['f-city', 'f-degree', 'f-address']);
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.classList && (this.classList.contains('skin') || this.classList.contains('skin2'))) {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  if (BELOW_FOLD.has(this.id)) {
    return { top: 3000, left: 10, right: 410, bottom: 3034, width: 400, height: 34, x: 10, y: 3000 };
  }
  if (this.id && this.id.endsWith('-pop')) {
    // 浮层未展开时尺寸为 0
    const open = this.classList.contains('open');
    return open
      ? { top: 48, left: 10, right: 410, bottom: 148, width: 400, height: 100, x: 10, y: 48 }
      : { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  return { top: 10, left: 10, right: 410, bottom: 44, width: 400, height: 34, x: 10, y: 10 };
};
window.elementFromPoint = () => null;
Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

const listeners = [];
window.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: (_m, cb) => { if (cb) cb(); },
    lastError: null
  }
};

window.eval(readFileSync(`${ROOT}/content/content.js`, 'utf8'));
const handler = listeners[0];
const snap = (type = 'SNAPSHOT_REQUEST') =>
  new Promise((resolve) => handler({ type }, {}, resolve));

// ---------- 第 1 次快照：下拉全部收起 ----------
const before = await snap();
console.log(`展开前控件数: ${before.count}`);
for (const el of before.elements) {
  const bits = [
    el.kind,
    el.context ? `ctx=${el.context}` : '',
    el.offscreen ? 'offscreen' : '',
    el.operations.join('/')
  ].filter(Boolean);
  console.log(`  ${el.index.padStart(2)} [${el.role.padEnd(8)}] ${el.label}  <${bits.join(' ')}>`);
}
console.log('诊断:', JSON.stringify(before.diagnostics.inputBreakdown), '| DOM inputs =', before.diagnostics.inputs);

// ---------- 展开"性别"自定义下拉，再快照 ----------
doc.getElementById('f-gender').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const after = await snap();
const popupItems = after.elements.filter((e) => e.context === 'popup');
console.log('\n展开性别下拉后，浮层条目:', popupItems.map((e) => e.label).join(' / ') || '(无)');

// ---------- 模拟"选中男"后再快照 ----------
doc.querySelector('#f-gender-pop [role=option]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const chosen = await snap();
const gender = chosen.elements.find((e) => e.label.includes('请选择性别') || e.label.includes('男'));

// ---------- 隐藏的勾选框：走 EXECUTE 真的点一下代理 label ----------
const proxies = before.elements.filter((e) => e.viaProxy);
console.log('\n救回的隐藏控件:', proxies.map((e) => `${e.index} [${e.role}] ${e.label}`).join(' | ') || '(无)');

const exec = (msg) => new Promise((resolve) => handler(msg, {}, resolve));

// ---------- 页面指纹：判断"决策之后、执行之前"页面有没有变过 ----------
const fpBefore = before.fingerprint;
const nameEl = before.elements.find((e) => e.label === '请填写姓名');
await exec({ type: 'EXECUTE', action: 'type_text', index: nameEl.index, value: '示例姓名' });
const afterType = await snap();
const fpAfterType = afterType.fingerprint;
console.log('\n指纹: 填入前', fpBefore);
console.log('指纹: 填入后', fpAfterType, '| 姓名框实际值 =', doc.getElementById('f-name').value);
const maleProxy = proxies.find((e) => e.label === '男');
let clickResult = null;
if (maleProxy) {
  clickResult = await exec({ type: 'EXECUTE', action: 'click', index: maleProxy.index });
}
const maleChecked = doc.getElementById('g-m').checked;

const agreeProxy = proxies.find((e) => e.label.includes('同意'));
let agreeChecked = false;
if (agreeProxy) {
  await exec({ type: 'EXECUTE', action: 'click', index: agreeProxy.index });
  agreeChecked = doc.getElementById('f-agree').checked;
}
console.log('点击 男 →', JSON.stringify(clickResult), '| g-m.checked =', maleChecked);
console.log('点击 同意声明 → f-agree.checked =', agreeChecked);

// ---------- 分段列表页：整块没有原生控件，卡片要被采集并且真的点得动 ----------
const cards = before.elements.filter((e) => e.kind === 'card' || e.kind === 'section-entry');
const eduCard = cards.find((e) => /教育经历/.test(e.label));
let cardClick = null;
if (eduCard) cardClick = await exec({ type: 'EXECUTE', action: 'click', index: eduCard.index });
const eduEntered = doc.querySelector('.am-list-body > .resumer-common:nth-child(3)')?.dataset.clicked === '1';
console.log('\n卡片:', cards.map((e) => `${e.index} ${e.label}`).join(' | ') || '(无)');
console.log('点击 教育经历 卡片 →', JSON.stringify(cardClick), '| 进入 =', eduEntered);

const byLabel = (t) => before.elements.find((e) => e.label.includes(t));
const labels = before.elements.map((e) => e.label);
const checks = [
  ['姓名被采集', !!byLabel('请填写姓名')],
  ['年龄被采集', !!byLabel('请填写年龄')],
  ['证件号码被采集', !!byLabel('请填写证件号码')],
  ['邮箱被采集', !!byLabel('请填写个人邮箱')],
  ['手机被采集', !!byLabel('请填写移动电话')],
  ['证件类型是原生下拉', before.elements.some((e) => e.kind === 'native-select' && e.label === '证件类型')],
  ['性别判定为 custom-select', before.elements.some((e) => e.kind === 'custom-select' && e.label.includes('性别'))],
  ['自定义下拉只能点（无 TYPE_TEXT）', before.elements.filter((e) => e.kind === 'custom-select').every((e) => !e.operations.includes('TYPE_TEXT'))],
  ['下拉标签不拼接选项文本', !labels.some((l) => /19\d\d19\d\d|年19/.test(l))],
  ['出生年标签为「出生日期 · 年」', labels.includes('出生日期 · 年')],
  ['籍贯省标签为「籍贯 · 省」', labels.includes('籍贯 · 省')],
  ['籍贯市标签为「籍贯 · 市」', labels.includes('籍贯 · 市')],
  ['籍贯区标签为「籍贯 · 区/县」', labels.includes('籍贯 · 区/县')],
  ['户口市标签为「户口所在地 · 市」', labels.includes('户口所在地 · 市')],
  ['折线下的现居城市被采集', !!byLabel('请填写现居城市')],
  ['折线下的字段带 offscreen 标记', byLabel('请填写现居城市')?.offscreen === true],
  ['折线上的字段不带 offscreen 标记', byLabel('请填写姓名')?.offscreen === undefined],
  ['隐藏域未被采集', !labels.some((l) => l.includes('SECRET') || l.includes('f-hidden'))],
  ['display:none 字段未被采集', !labels.some((l) => l.includes('不可见字段'))],
  ['未展开时无浮层条目', before.elements.filter((e) => e.context === 'popup').length === 0],
  ['未展开时下拉选项不外泄', !before.elements.some((e) => e.label === '未婚' || e.label === '离异')],
  ['展开性别后出现浮层条目', popupItems.length >= 2],
  ['浮层条目含 男/女', popupItems.some((e) => e.label === '男') && popupItems.some((e) => e.label === '女')],
  ['浮层条目可点击', popupItems.every((e) => e.operations.includes('CLICK'))],
  ['浮层条目带 context=popup', popupItems.every((e) => e.context === 'popup')],
  ['选中后性别控件显示男', !!gender],
  ['诊断带回输入控件分布', typeof before.diagnostics.inputBreakdown === 'object'],
  // 隐藏的勾选框 / 单选框：皮肤在外、原生 input 藏起来
  ['隐藏控件被救回 3 个', proxies.length === 3],
  ['性别单选框被救回', proxies.some((e) => e.role === 'radio' && e.label === '男') && proxies.some((e) => e.role === 'radio' && e.label === '女')],
  ['同意声明勾选框被救回', proxies.some((e) => e.role === 'checkbox' && e.label.includes('同意'))],
  ['代理条目带 viaProxy 标记', proxies.every((e) => e.viaProxy === true)],
  ['代理条目只给 CLICK', proxies.every((e) => e.operations.length === 1 && e.operations[0] === 'CLICK')],
  ['代理条目保留单选或勾选语义', proxies.every((e) => e.kind === (e.role === 'radio' ? 'custom-radio' : 'custom-checkbox'))],
  ['代理条目带回 checked 状态', proxies.every((e) => typeof e.checked === 'boolean')],
  ['点代理 label 真的勾上了单选框', maleChecked === true],
  ['点代理 label 真的勾上了勾选框', agreeChecked === true],
  ['诊断表单控件总数正确(10 select + 9 input + 3 隐藏勾选)', before.diagnostics.inputs === 22],
  ['诊断能按 type 拆分控件', before.diagnostics.inputBreakdown.select === 10 && before.diagnostics.inputBreakdown.radio === 2],
  ['快照带过滤计数', typeof before.filters?.hidden === 'number' && typeof before.filters?.zeroSize === 'number'],
  ['过滤计数记录了隐藏域', before.filters.hidden >= 8],
  // name 属性：ATS 表单里语义信号最强的一路信息，要一并交给 Jev
  ['控件带回 name 属性', before.elements.some((e) => e.name === 'personalEmail')],
  ['name 与可见标签并存', (() => { const el = before.elements.find((e) => e.name === 'mobile'); return el && el.label === '请填写移动电话'; })()],
  ['没有 name 的控件不硬塞字段', !before.elements.some((e) => e.name === '')],
  // 页面指纹：过期决策与"点了没反应"都靠它判定
  ['快照带回页面指纹', typeof fpBefore === 'string' && fpBefore.length > 0],
  ['指纹为本地摘要', /^\d+$/.test(fpBefore)],
  ['填入内容后指纹变化', typeof fpAfterType === 'string' && fpAfterType !== fpBefore],
  ['type_text 真的写进了输入框', doc.getElementById('f-name').value === '示例姓名'],
  ['下一步按钮可点击', before.elements.some((e) => e.label.includes('下一步') && e.operations.includes('CLICK'))],
  // 分段列表页：整块没有原生控件，靠 cursor:pointer + 自身文字识别可点卡片
  ['列表页卡片被采集', cards.length >= 5],
  ['卡片 role=button 且只给 CLICK', cards.every((e) => e.role === 'button' && e.operations.length === 1 && e.operations[0] === 'CLICK')],
  ['卡片标签取自身文字', cards.some((e) => /^示例姓名 · 简历头$/.test(e.label))],
  ['未完成分段带完整文字', cards.some((e) => /教育经历 未完成/.test(e.label))],
  ['点卡片真的触发了它的点击', eduEntered === true],
  ['含原生控件的容器不当卡片', !cards.some((e) => /请填写姓名/.test(e.label))],
  ['cursor 默认的文字块不当卡片', !cards.some((e) => e.label === '证件类型' || e.label === '婚姻状况')],
  ['收起下拉的选项没被当成卡片', !cards.some((e) => e.label === '未婚' || e.label === '离异')]
];

console.log('\n=== 离线自测页断言 ===');
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(pass ? '\n✅ 离线自测页全部断言通过' : '\n❌ 离线自测页存在失败项');
if (!pass) process.exitCode = 1;
