// 弱信号卡片识别：整页一个原生控件都没有时，才打开"行块"弱信号，
// 且必须命中入口关键字（未完成/去完善/编辑/必填…），否则标签、说明文字会被整片当卡片灌进元素表。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(`${ROOT}/tests/fixture/card-weak-signal.html`, 'utf8');

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

window.HTMLElement.prototype.getBoundingClientRect = function () {
  // 默认给一个"行块"尺寸：宽度够、高度像一行
  if (this.classList && this.classList.contains('long')) {
    return { top: 10, left: 10, right: 410, bottom: 40, width: 400, height: 30, x: 10, y: 10 };
  }
  return { top: 10, left: 10, right: 410, bottom: 50, width: 400, height: 40, x: 10, y: 10 };
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
const snap = () => new Promise((resolve) => handler({ type: 'SNAPSHOT_REQUEST' }, {}, resolve));

const res = await snap();
const cards = res.elements.filter((e) => e.kind === 'card' || e.kind === 'section-entry');
console.log('控件总数:', res.count, '| 卡片:', cards.map((e) => `${e.index} ${e.label}`).join(' | ') || '(无)');

const checks = [
  // 整页零原生控件 → allowWeak 打开
  ['整页零原生控件', res.elements.every((e) => ['card','section-entry'].includes(e.kind)) && res.count >= 1],
  // 命中入口关键字的行块 → 收为卡片
  ['"教育经历 未完成"收为卡片', cards.some((e) => /教育经历 未完成/.test(e.label))],
  ['"工作经历 去完善"收为卡片', cards.some((e) => /工作经历 去完善/.test(e.label))],
  // 纯说明文字（无关键字）→ 不当卡片
  ['普通说明文字不当卡片', !cards.some((e) => e.label.includes('填写说明'))],
  // 超长文字块 → 不当卡片
  ['超长文字块不当卡片', !cards.some((e) => e.label.includes('本段为一段很长的描述性文字'))],
  // 手型光标（强信号）即使无关键字也收为卡片
  ['cursor:pointer 的"查看详情"收为卡片', cards.some((e) => e.label === '查看详情')],
  // 卡片只给 CLICK
  ['卡片只给 CLICK', cards.every((e) => e.operations.length === 1 && e.operations[0] === 'CLICK')]
];

console.log('\n=== 弱信号卡片识别断言 ===');
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(pass ? '\n✅ 弱信号卡片识别全部断言通过' : '\n❌ 弱信号卡片识别存在失败项');
if (!pass) process.exitCode = 1;
