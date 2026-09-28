// 验证 Service Worker → Popup 的进度回传链路。
// 曾经 Popup 没监听 runtime.onMessage，SW 推的 FILL_PROGRESS/FILL_DONE 全被静默丢弃，
// 界面上只剩"Agent 已启动"一行，看不出 Agent 到底跑没跑。
const pushed = [];
let messageHandler = null;
let connectHandler = null;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { messageHandler = fn; } },
    onInstalled: { addListener: () => {} },
    onConnect: { addListener: (fn) => { connectHandler = fn; } },
    sendMessage: (msg) => { pushed.push(msg); },
    lastError: null,
    getURL: (p) => p
  },
  tabs: { query: async () => [{ id: 7, url: 'https://example.com/form' }] },
  scripting: { executeScript: async () => [] },
  storage: { local: { get: async () => ({}), set: async () => {} } }
};

const ROOT = new URL('..', import.meta.url).pathname;
await import(`${ROOT}/background/service-worker.js`);

// 走一遍真实的消息入口：handler 返回 true 表示"会异步回执"
const ask = (msg) =>
  new Promise((resolve) => {
    const keep = messageHandler(msg, {}, resolve);
    if (!keep) resolve(undefined);
  });

const checks = [];
const run = async (name, fn) => {
  try {
    const ok = await fn();
    checks.push([name, !!ok]);
  } catch (err) {
    console.log(`  异常: ${err.message}`);
    checks.push([name, false]);
  }
};

await run('START_FILL 立即回执 started=true', async () => {
  pushed.length = 0;
  const resp = await ask({ type: 'START_FILL', goal: '', resume: null, apiKey: '' });
  return resp && resp.started === true;
});

await run('缺 API Key 时也要推 FILL_DONE，不能无声无息', async () => {
  pushed.length = 0;
  await ask({ type: 'START_FILL', goal: '', resume: { basics: {} }, apiKey: '' });
  await new Promise((r) => setTimeout(r, 10));
  const done = pushed.find((m) => m.type === 'FILL_DONE');
  return done && done.ok === false && /API Key/.test(done.reason || '');
});

await run('缺简历时推 FILL_DONE', async () => {
  pushed.length = 0;
  await ask({ type: 'START_FILL', goal: '', resume: null, apiKey: 'k' });
  await new Promise((r) => setTimeout(r, 10));
  const done = pushed.find((m) => m.type === 'FILL_DONE');
  return done && /简历/.test(done.reason || '');
});

await run('保活连接被接住（防止 SW 中途被挂起）', async () => {
  if (typeof connectHandler !== 'function') return false;
  const listeners = [];
  connectHandler({ name: 'fill-keepalive', onMessage: { addListener: (f) => listeners.push(f) }, onDisconnect: { addListener: () => {} } });
  return true;
});

await run('未知消息类型不抢答', async () => {
  let answered = false;
  messageHandler({ type: 'NOT_MINE' }, {}, () => { answered = true; });
  return answered === false;
});

console.log('\n=== 进度回传链路断言 ===');
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(pass ? '\n✅ 进度回传链路全部断言通过' : '\n❌ 进度回传链路存在失败项');
if (!pass) process.exitCode = 1;
