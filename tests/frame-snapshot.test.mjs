// 用 mock 的 chrome API 验证 SW 的多 frame 快照汇总与执行路由逻辑
const listeners = [];

// 三个 frame：主帧 1 个控件，表单 iframe 3 个控件（含 1 个带 options 的 select），空 iframe 0 个
const FRAME_DATA = {
  0: {
    ok: true,
    count: 1,
    elements: [{ index: '1', role: 'button', label: '下一步', value: '', operations: ['CLICK'] }],
    page: { url: 'https://career.honor.com/...', title: '创建简历', text: '个人基本信息 填写进度 1/13' }
  },
  7: {
    ok: true,
    count: 3,
    elements: [
      { index: '1', role: 'textbox', label: '姓名', value: '', operations: ['TYPE_TEXT'] },
      { index: '2', role: 'textbox', label: '移动电话', value: '', operations: ['TYPE_TEXT'] },
      {
        index: '3',
        role: 'combobox',
        label: '性别',
        value: '',
        operations: ['CLICK', 'SELECT'],
        options: [
          { index: '3:1', label: '男', value: 'M' },
          { index: '3:2', label: '女', value: 'F' }
        ]
      }
    ],
    page: { url: 'https://wecruit.hotjob.cn/form.html', title: '表单', text: '姓名 年龄 证件类型 证件号码 电子邮箱 性别 移动电话 出生日期 籍贯' }
  },
  9: { ok: true, count: 0, elements: [], page: { url: 'about:blank', title: '', text: '' } }
};

const execCalls = [];

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    sendMessage: (msg, cb) => { if (cb) cb({ ok: true }); },
    lastError: null
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://career.honor.com/x' }],
    sendMessage: (tabId, msg, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const frameId = (opts && opts.frameId) || 0;
      if (msg.type === 'PING') return cb({ ok: true });
      if (msg.type === 'SNAPSHOT_FULL') return cb(FRAME_DATA[frameId] || { ok: false, reason: 'no frame' });
      if (msg.type === 'EXECUTE' || msg.type === 'SCROLL') {
        execCalls.push({ frameId, msg: JSON.stringify(msg) });
        return cb({ ok: true, value: msg.value || '' });
      }
      return cb({ ok: true });
    }
  },
  scripting: {
    executeScript: async (opts) => {
      if (opts.func) return [{ frameId: 0 }, { frameId: 7 }, { frameId: 9 }];
      return [{ frameId: 0 }];
    }
  },
  storage: { local: { get: async () => ({}), set: async () => {} } }
};

await import(new URL('../background/service-worker.js', import.meta.url));

const swListener = listeners[0];
const res = await new Promise((resolve) => swListener({ type: 'SNAPSHOT_TAB' }, {}, resolve));

console.log('=== SNAPSHOT_TAB 结果 ===');
console.log('ok:', res.ok);
console.log('控件总数:', res.count);
console.log('frame 数:', res.frames, '| 含控件的 frame 数:', res.framesWithElements);
console.log('合并后索引:', res.preview.map((e) => e.index).join(', '));
const sel = res.preview.find((e) => e.role === 'combobox');
console.log('select 的 options 索引:', sel ? sel.options.map((o) => o.index).join(', ') : '无');

// 断言
const expect = {
  count: 4,
  frames: 3,
  framesWithElements: 2,
  indexes: 'f0_1,f7_1,f7_2,f7_3',
  optionIndexes: 'f7_3:1,f7_3:2'
};
const gotIndexes = res.preview.map((e) => e.index).join(',');
const gotOptions = sel ? sel.options.map((o) => o.index).join(',') : '';
let pass = true;
if (res.count !== expect.count) { console.log('✗ count 期望', expect.count, '实际', res.count); pass = false; }
if (res.frames !== expect.frames) { console.log('✗ frames 期望', expect.frames, '实际', res.frames); pass = false; }
if (res.framesWithElements !== expect.framesWithElements) { console.log('✗ framesWithElements 期望', expect.framesWithElements, '实际', res.framesWithElements); pass = false; }
if (gotIndexes !== expect.indexes) { console.log('✗ 索引期望', expect.indexes, '实际', gotIndexes); pass = false; }
if (gotOptions !== expect.optionIndexes) { console.log('✗ options 索引期望', expect.optionIndexes, '实际', gotOptions); pass = false; }
console.log(pass ? '\n✅ 多 frame 快照汇总全部断言通过' : '\n❌ 存在断言失败');

// 顺带验证 target 前缀解析（与 SW 内正则一致）
const RE = /^f(\d+)_(.+)$/;
const cases = [['f7_3', 7, '3'], ['f0_1', 0, '1'], ['f12_3:2', 12, '3:2']];
console.log('\n=== target 前缀解析 ===');
for (const [input, wantFrame, wantLocal] of cases) {
  const m = String(input).match(RE);
  const frameId = m ? parseInt(m[1], 10) : 0;
  const local = m ? m[2] : String(input);
  const ok = frameId === wantFrame && local === wantLocal;
  console.log(`${ok ? '✓' : '✗'} ${input} → frame ${frameId}, local ${local}`);
}
