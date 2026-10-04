// popup.js — 阶段1：简历录入 + 多段经历 + JSON 导入导出 + Key 持久化
import { CONTENT_SCRIPT_VERSION } from '../lib/content-version.js';

const DEFAULT_RESUME_URL = chrome.runtime.getURL('data/resume-default.json');

const state = {
  resume: null,
  apiKey: '',
  todo: null
};

function withoutReferralCode(resume) {
  if (!resume?.application || !Object.hasOwn(resume.application, 'referralCode')) return resume;
  const { referralCode, ...application } = resume.application;
  return { ...resume, application };
}

const logEl = document.getElementById('log');
let replayLogAt = null;

function appendLog(text, kind = 'info') {
  const empty = logEl.querySelector('.log-empty');
  if (empty) empty.remove();
  const line = document.createElement('p');
  line.className = `log-line ${kind}`;
  line.textContent = `[${new Date(replayLogAt ?? Date.now()).toLocaleTimeString()}] ${text}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function getDefaultResume() {
  const res = await fetch(DEFAULT_RESUME_URL);
  return await res.json();
}

// chrome:// / edge:// / 扩展页 / Web Store 等不允许注入 content script
const BLOCKED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'];

function isInjectableUrl(url) {
  if (!url) return false;
  return !BLOCKED_SCHEMES.some(scheme => url.startsWith(scheme));
}

// 取当前活动标签页；不可注入时抛错并带上可读原因
async function getActivePageTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('未找到活动标签页');
  if (!isInjectableUrl(tab.url)) {
    throw new Error(`当前页面是浏览器内部页（${tab.url}），请在普通网页上使用`);
  }
  return tab;
}

// 确保 content script 已在标签页的所有 frame；扩展重载后的旧脚本也会被替换。
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong && pong.ok && pong.version === CONTENT_SCRIPT_VERSION) return true;
  } catch (_) {
    // 未注入，走下面的兜底注入
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/widget-drivers.js', 'content/platform-drivers.js', 'content/content.js']
    });
    return true;
  } catch (err) {
    throw new Error(`注入 content script 失败：${err.message}`);
  }
}

async function snapshotCurrentPage() {
  const tab = await getActivePageTab();
  await ensureContentScript(tab.id);
  const result = await chrome.runtime.sendMessage({ type: 'SNAPSHOT_TAB', resume: state.resume });
  if (!result?.ok) throw new Error(result?.reason || '页面快照未返回结果');
  return result;
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function renderForm() {
  document.querySelectorAll('[data-bind]').forEach(el => {
    const path = el.dataset.bind;
    if (path === 'skillsKeywords') {
      const items = (state.resume.skills && state.resume.skills[0] && state.resume.skills[0].items) || [];
      el.value = items.map(it => `${it.skill || ''}${it.level ? '|' + it.level : ''}`).join('\n');
      return;
    }
    if (path === 'certificatesText') {
      const certs = state.resume.certificates || [];
      el.value = certs.map(c => `${c.name || ''}|${c.issuer || ''}|${c.date || ''}`).join('\n');
      return;
    }
    if (path === 'interestsText') {
      const ints = state.resume.interests || [];
      el.value = ints.join(', ');
      return;
    }
    el.value = getPath(state.resume, path) ?? '';
  });
  const photoStatus = document.getElementById('resume-photo-status');
  const lifePhotoStatus=document.getElementById('life-photo-status');
  if (lifePhotoStatus) {
    const count=(state.resume?.basics?.lifePhotos || []).filter(photo=>photo.dataUrl).length;
    lifePhotoStatus.textContent=count ? `生活照：已保存 ${count} 张` : '';
  }
  if (photoStatus) {
    const photoName = state.resume?.basics?.photo?.name;
    photoStatus.textContent = photoName ? `已保存：${photoName}` : '尚未保存照片';
    photoStatus.className = `status-value ${photoName ? 'ok' : 'warn'}`;
    photoStatus.title = photoName || '';
  }
  const attachmentStatus = document.getElementById('resume-attachment-status');
  if (attachmentStatus) {
    const attachmentName = state.resume?.basics?.resumeFile?.name;
    attachmentStatus.textContent = attachmentName ? `已保存：${attachmentName}` : '尚未保存简历附件';
    attachmentStatus.className = `status-value ${attachmentName ? 'ok' : 'warn'}`;
    attachmentStatus.title = attachmentName || '';
  }
}

function collectForm() {
  document.querySelectorAll('[data-bind]').forEach(el => {
    const path = el.dataset.bind;
    const val = el.value;
    if (path === 'skillsKeywords') {
      if (!state.resume.skills) state.resume.skills = [];
      if (!state.resume.skills[0]) state.resume.skills[0] = { name: '技能', items: [] };
      state.resume.skills[0].items = val.split('\n').map(line => {
        const [skill, level] = line.split('|').map(s => (s || '').trim());
        return { skill, level: level || '' };
      }).filter(it => it.skill);
      return;
    }
    if (path === 'certificatesText') {
      state.resume.certificates = val.split('\n').map(line => {
        const [name, issuer, date] = line.split('|').map(s => (s || '').trim());
        return { name, issuer, date };
      }).filter(c => c.name);
      return;
    }
    if (path === 'interestsText') {
      state.resume.interests = val.split(',').map(s => s.trim()).filter(Boolean);
      return;
    }
    setPath(state.resume, path, val);
  });
}

const EDU_TEMPLATE = {
  institution: '', country: '', area: '', department: '', studyType: '', studyMode: '', degree: '', primaryDiscipline: '', startDate: '', endDate: '', gpa: '',
  ranking: '', studentCadre: '', courses: [], schoolExperience: '', scholarships: '', lab: '', advisor: '', thesis: ''
};
const WORK_TEMPLATE = {
  company: '', department: '', position: '', startDate: '', endDate: '', summary: '', highlights: []
};
const INTERNSHIP_TEMPLATE = {
  company: '', department: '', position: '', startDate: '', endDate: '', summary: '', highlights: []
};
const PUBLICATION_TEMPLATE = {
  title: '', type: '', level: '', zone: '', journal: '', date: '', authorOrder: '', details: ''
};

function renderEduList() {
  const listEl = document.getElementById('edu-list');
  listEl.innerHTML = '';
  const items = state.resume.education || [];
  items.forEach((edu, idx) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="item-header">
        <span class="item-title">教育 #${idx + 1}</span>
        <button class="btn ghost small item-remove" data-list="education" data-idx="${idx}">删除</button>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">学校</span>
          <input type="text" data-list-bind="education.institution" data-idx="${idx}" value="${escapeAttr(edu.institution)}" /></label>
        <label class="field">院校所在国家/地区
          <input type="text" data-list-bind="education.country" data-idx="${idx}" value="${escapeAttr(edu.country)}" /></label>
        <label class="field"><span class="field-label">学历</span>
          <select data-list-bind="education.studyType" data-idx="${idx}">
            ${['', '大专', '本科', '硕士', '博士'].map(o => `<option value="${o}" ${edu.studyType === o ? 'selected' : ''}>${o || '未选'}</option>`).join('')}
          </select></label>
        <label class="field"><span class="field-label">学习方式</span>
          <select data-list-bind="education.studyMode" data-idx="${idx}">
            ${['', '全日制', '非全日制', '在职', '海外留学生', '港澳台留学生'].map(o => `<option value="${o}" ${edu.studyMode === o ? 'selected' : ''}>${o || '未选'}</option>`).join('')}
          </select></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">专业</span>
          <input type="text" data-list-bind="education.area" data-idx="${idx}" value="${escapeAttr(edu.area)}" /></label>
        <label class="field"><span class="field-label">就读院/系</span>
          <input type="text" data-list-bind="education.department" data-idx="${idx}" value="${escapeAttr(edu.department)}" /></label>
        <label class="field"><span class="field-label">GPA</span>
          <input type="text" data-list-bind="education.gpa" data-idx="${idx}" value="${escapeAttr(edu.gpa)}" /></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">学习成绩排名</span>
          <input type="text" data-list-bind="education.ranking" data-idx="${idx}" value="${escapeAttr(edu.ranking)}" /></label>
        <label class="field"><span class="field-label">是否为学生干部</span>
          <select data-list-bind="education.studentCadre" data-idx="${idx}">
            ${['', '是', '否'].map(o => `<option value="${o}" ${edu.studentCadre === o ? 'selected' : ''}>${o || '未选'}</option>`).join('')}
          </select></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">学位</span>
          <input type="text" data-list-bind="education.degree" data-idx="${idx}" value="${escapeAttr(edu.degree)}" placeholder="工学" /></label>
        <label class="field"><span class="field-label">一级学科分类</span>
          <input type="text" data-list-bind="education.primaryDiscipline" data-idx="${idx}" value="${escapeAttr(edu.primaryDiscipline)}" placeholder="计算机科学与技术" /></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">开始 (YYYY-MM-DD，或已有年月)</span>
          <input type="text" data-list-bind="education.startDate" data-idx="${idx}" value="${escapeAttr(edu.startDate)}" /></label>
        <label class="field"><span class="field-label">结束 (YYYY-MM-DD，已有年月或至今)</span>
          <input type="text" data-list-bind="education.endDate" data-idx="${idx}" value="${escapeAttr(edu.endDate)}" /></label>
      </div>
      <label class="field"><span class="field-label">实验室 / 课题组</span>
        <input type="text" data-list-bind="education.lab" data-idx="${idx}" value="${escapeAttr(edu.lab)}" /></label>
      <div class="form-row">
        <label class="field"><span class="field-label">导师</span>
          <input type="text" data-list-bind="education.advisor" data-idx="${idx}" value="${escapeAttr(edu.advisor)}" /></label>
        <label class="field"><span class="field-label">毕设 / 论文方向</span>
          <input type="text" data-list-bind="education.thesis" data-idx="${idx}" value="${escapeAttr(edu.thesis)}" /></label>
      </div>
    `;
    listEl.appendChild(item);
  });
}

function renderExperienceList(listElId, listKey, titlePrefix) {
  const listEl = document.getElementById(listElId);
  if (!listEl) return;
  listEl.innerHTML = '';
  const items = state.resume[listKey] || [];
  items.forEach((w, idx) => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div class="item-header">
        <span class="item-title">${titlePrefix} #${idx + 1}</span>
        <button class="btn ghost small item-remove" data-list="${listKey}" data-idx="${idx}">删除</button>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">公司</span>
          <input type="text" data-list-bind="${listKey}.company" data-idx="${idx}" value="${escapeAttr(w.company)}" /></label>
        <label class="field"><span class="field-label">职位</span>
          <input type="text" data-list-bind="${listKey}.position" data-idx="${idx}" value="${escapeAttr(w.position)}" /></label>
      </div>
      <label class="field"><span class="field-label">部门</span>
        <input type="text" data-list-bind="${listKey}.department" data-idx="${idx}" value="${escapeAttr(w.department)}" /></label>
      <div class="form-row">
        <label class="field"><span class="field-label">开始 (YYYY-MM)</span>
          <input type="text" data-list-bind="${listKey}.startDate" data-idx="${idx}" value="${escapeAttr(w.startDate)}" /></label>
        <label class="field"><span class="field-label">结束 (YYYY-MM 或 至今)</span>
          <input type="text" data-list-bind="${listKey}.endDate" data-idx="${idx}" value="${escapeAttr(w.endDate)}" /></label>
      </div>
      <label class="field"><span class="field-label">描述</span>
        <textarea data-list-bind="${listKey}.summary" data-idx="${idx}" rows="3">${escapeHtml(w.summary)}</textarea></label>
    `;
    listEl.appendChild(item);
  });
}

function renderWorkList() {
  renderExperienceList('internship-list', 'internship', '实习');
  renderExperienceList('work-list', 'work', '工作');
}

function renderPublicationList() {
  const listEl=document.getElementById('publication-list');
  listEl.innerHTML='';
  (state.resume.publications || []).forEach((paper,idx)=>{
    const item=document.createElement('div');
    item.className='item';
    item.innerHTML=`
      <div class="item-header"><span class="item-title">论文 #${idx+1}</span>
        <button class="btn ghost small item-remove" data-list="publications" data-idx="${idx}">删除</button></div>
      <label class="field"><span class="field-label">论文名称</span>
        <input type="text" data-list-bind="publications.title" data-idx="${idx}" value="${escapeAttr(paper.title)}" /></label>
      <div class="form-row">
        <label class="field"><span class="field-label">发表期刊</span>
          <input type="text" data-list-bind="publications.journal" data-idx="${idx}" value="${escapeAttr(paper.journal)}" /></label>
        <label class="field"><span class="field-label">发表时间（YYYY-MM）</span>
          <input type="text" data-list-bind="publications.date" data-idx="${idx}" value="${escapeAttr(paper.date)}" /></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">论文类型</span>
          <input type="text" data-list-bind="publications.type" data-idx="${idx}" value="${escapeAttr(paper.type)}" /></label>
        <label class="field"><span class="field-label">论文级别</span>
          <input type="text" data-list-bind="publications.level" data-idx="${idx}" value="${escapeAttr(paper.level)}" /></label>
      </div>
      <div class="form-row">
        <label class="field"><span class="field-label">期刊分区</span>
          <input type="text" data-list-bind="publications.zone" data-idx="${idx}" value="${escapeAttr(paper.zone)}" /></label>
        <label class="field"><span class="field-label">作者顺序</span>
          <input type="text" data-list-bind="publications.authorOrder" data-idx="${idx}" value="${escapeAttr(paper.authorOrder)}" /></label>
      </div>
      <label class="field"><span class="field-label">论文详情</span>
        <textarea data-list-bind="publications.details" data-idx="${idx}" rows="4">${escapeHtml(paper.details)}</textarea></label>`;
    listEl.appendChild(item);
  });
}

const TODO_STATUS = {
  'ready-add': ['需新增', 'ready'],
  'ready-open': ['可打开', 'ready'],
  'ready-fill': ['可填写', 'ready'],
  'completed': ['已回读', 'done'],
  'no-local-data': ['缺本地资料', 'missing'],
  'missing-data': ['字段待补', 'missing'],
  'conflict': ['保留网页值', 'conflict'],
  'blocked': ['等待返回', 'blocked'],
  'unmapped-section': ['待识别分区', 'blocked'],
  'needs-inspection': ['等待检查', 'blocked']
};

const FIELD_STATUS = {
  completed: '已回读',
  ready: '可填写',
  'pending-readback': '等待回读',
  'missing-data': '缺资料',
  conflict: '保留网页值',
  unmapped: '待映射'
};

function appendText(parent, tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function renderTodo(todo) {
  const summary = document.getElementById('todo-summary');
  const list = document.getElementById('todo-list');
  if (!summary || !list) return;
  list.replaceChildren();
  const items = todo?.items || [];
  if (!items.length) {
    summary.textContent = '当前页面没有识别到可填写分区。';
    appendText(list, 'li', '页面可能仍在加载，或当前区域尚未展开。', 'todo-empty');
    return;
  }
  const counts = todo.counts || {};
  const ready = (counts['ready-add'] || 0) + (counts['ready-open'] || 0) + (counts['ready-fill'] || 0);
  const waiting = (counts['no-local-data'] || 0) + (counts['missing-data'] || 0) +
    (counts.conflict || 0) + (counts['unmapped-section'] || 0) + (counts.blocked || 0);
  summary.textContent = `发现 ${items.length} 个分区：可处理 ${ready} 个，待核对 ${waiting} 个。`;
  for (const item of items) {
    const card = document.createElement('li');
    card.className = `todo-card ${TODO_STATUS[item.status]?.[1] || 'blocked'}`;
    const top = document.createElement('div');
    top.className = 'todo-card-top';
    appendText(top, 'strong', item.section || '未命名分区', 'todo-section');
    appendText(top, 'span', TODO_STATUS[item.status]?.[0] || item.status, 'todo-badge');
    card.appendChild(top);
    const sourceSummary=item.blockSelection==='selected' ? `已关联 ${item.collection}：${item.localRecords} 条` :
      `资料块待 Jev 关联（标题提示 ${item.localRecords} 条）`;
    appendText(card, 'p', `网页 ${item.renderedRecords} 条 · ${sourceSummary} · 字段组 ${item.fieldCounts?.total || 0} 个`, 'todo-meta');
    appendText(card, 'p', `下一项：${item.nextAction || '读取当前字段状态'}`, 'todo-next');
    appendText(card, 'p', item.reason || '页面正在等待检查', 'todo-reason');
    const attention = (item.fields || []).filter(field => field.status !== 'completed');
    if (attention.length) {
      const fields = document.createElement('ul');
      fields.className = 'todo-fields';
      for (const field of attention.slice(0, 6)) {
        const row = document.createElement('li');
        const record = Number.isInteger(field.recordIndex) ? `第 ${field.recordIndex + 1} 条 · ` : '';
        appendText(row, 'span', `${record}${field.label}`, 'todo-field-name');
        appendText(row, 'span', FIELD_STATUS[field.status] || field.status, 'todo-field-status');
        fields.appendChild(row);
      }
      if (attention.length > 6) appendText(fields, 'li', `另有 ${attention.length - 6} 个待处理字段组`, 'todo-field-more');
      card.appendChild(fields);
    }
    list.appendChild(card);
  }
}

async function refreshTodo({logResult = true} = {}) {
  try {
    const result = await snapshotCurrentPage();
    state.todo = result.todo || null;
    renderTodo(state.todo);
    if (logResult) appendLog(`填写清单已更新：${state.todo?.items?.length || 0} 个分区`, 'ok');
    return result;
  } catch (err) {
    renderTodo(null);
    if (logResult) appendLog(`填写清单读取失败: ${err.message}`, 'err');
    throw err;
  }
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.listBind) {
    const [list, field] = t.dataset.listBind.split('.');
    const idx = parseInt(t.dataset.idx, 10);
    if (state.resume[list] && state.resume[list][idx]) {
      state.resume[list][idx][field] = t.value;
    }
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.classList && t.classList.contains('tab')) {
    const tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === t));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
    if (tab === 'settings') refreshStatus();
    if (tab === 'todo') refreshTodo().catch(() => {});
    return;
  }
  if (t.classList && t.classList.contains('item-remove')) {
    const list = t.dataset.list;
    const idx = parseInt(t.dataset.idx, 10);
    state.resume[list].splice(idx, 1);
    if (list === 'education') renderEduList();
    else if (list === 'publications') renderPublicationList();
    else renderWorkList();
    return;
  }
  if (t.id === 'edu-add') {
    if (!state.resume.education) state.resume.education = [];
    state.resume.education.push({ ...EDU_TEMPLATE });
    renderEduList();
    return;
  }
  if (t.id === 'internship-add') {
    if (!state.resume.internship) state.resume.internship = [];
    state.resume.internship.push({ ...INTERNSHIP_TEMPLATE });
    renderWorkList();
    return;
  }
  if (t.id === 'work-add') {
    if (!state.resume.work) state.resume.work = [];
    state.resume.work.push({ ...WORK_TEMPLATE });
    renderWorkList();
    return;
  }
  if (t.id === 'publication-add') {
    if (!state.resume.publications) state.resume.publications=[];
    state.resume.publications.push({...PUBLICATION_TEMPLATE});
    renderPublicationList();
    return;
  }
  if (t.id === 'btn-save') {
    collectForm();
    await chrome.storage.local.set({ resume: state.resume });
    appendLog('简历已保存', 'ok');
    refreshStatus();
    return;
  }
  if (t.id === 'btn-save-key') {
    const key = document.getElementById('jev-api-key').value.trim();
    if (!key) { appendLog('请填写 Key', 'err'); return; }
    await chrome.storage.local.set({ jevApiKey: key });
    state.apiKey = key;
    appendLog('Key 已保存', 'ok');
    refreshStatus();
    return;
  }
  if (t.id === 'btn-export') {
    collectForm();
    const blob = new Blob([JSON.stringify(state.resume, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resume-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog('JSON 已导出', 'ok');
    return;
  }
  if (t.id === 'btn-stop-fill') {
    chrome.runtime.sendMessage({type:'STOP_FILL'});
    setFillRunning(false);
    return;
  }
  if (t.id === 'btn-start-fill') {
    if (fillRunning) {
      appendLog('当前填写任务正在运行', 'warn');
      return;
    }
    setFillRunning(true);
    collectForm();
    await chrome.storage.local.set({ resume: state.resume });
    const { jevApiKey } = await chrome.storage.local.get(['jevApiKey']);
    if (!jevApiKey) { appendLog('请先在"设置"页填写 TypeSafe API Key', 'err'); setFillRunning(false); return; }
    if (!state.resume || !state.resume.basics || !state.resume.basics.name) {
      appendLog('简历未填写姓名，请先在"基本"页填好', 'err'); setFillRunning(false); return;
    }
    const progressEl = document.getElementById('fill-progress');
    if (progressEl) { progressEl.textContent = '启动中…'; progressEl.className = 'fill-progress active'; }
    try {
      const tab = await getActivePageTab();
      await ensureContentScript(tab.id);
    } catch (err) {
      if (progressEl) { progressEl.textContent = '启动失败'; progressEl.className = 'fill-progress'; }
      appendLog(`启动失败: ${err.message}`, 'err');
      setFillRunning(false);
      return;
    }
    appendLog('开始自动填写整份简历', 'info');
    // 清掉上一段记录
    try { await chrome.storage.session.set({ fillEvents: [] }); } catch (_) {}
    // 保活：MV3 的 Service Worker 空闲 30 秒会被挂起。
    // 一条长连接能让它撑到填写结束，否则跑到一半 Agent 就没了。
    try {
      if (fillPort) fillPort.disconnect();
      fillPort = chrome.runtime.connect({ name: 'fill-keepalive' });
      fillPort.postMessage({ type: 'START' });
    } catch (_) {}
    chrome.runtime.sendMessage({ type: 'START_FILL', resume: state.resume, apiKey: jevApiKey,
      agreementConfirmed: document.getElementById('confirm-agreements')?.checked === true }, (resp) => {
      if (chrome.runtime.lastError) {
        appendLog(`启动失败: ${chrome.runtime.lastError.message}`, 'err');
        setFillRunning(false);
      } else if (resp && resp.started) {
        appendLog('Agent 已启动', 'ok');
        window.close();
      } else {
        appendLog(`启动异常: ${JSON.stringify(resp)}`, 'err');
        setFillRunning(false);
      }
    });
    return;
  }
  if (t.id === 'btn-test-snapshot') {
    try {
      // 走 SW 汇总所有 frame，和自动填写用同一条链路。
      const res = await snapshotCurrentPage();
      renderTodo(res.todo || null);
      if (res) {
        appendLog(
          `快照成功: ${res.count} 个可交互控件（${res.frames} 个 frame，其中 ${res.framesWithElements} 个含控件）`,
          'ok'
        );
        logDiagnostics(res);
        appendLog(`页面状态: ${res.pageState || '未知'}${res.pageStateReason ? ` · ${res.pageStateReason}` : ''}；当前分区: ${res.page?.activeSection || '未识别'}`, 'info');
        if (res.sectionPlan?.length) appendLog(`分区计划: ${res.sectionPlan.map(item => `${item.section || '页面'}:${item.operation}`).join(' / ')}`, 'info');
        // 控件不多时全部列出，方便核对每个字段的种类判断
        const preview = res.preview || [];
        preview.forEach(el => {
          const flags = [el.kind || '?', el.section ? `分区=${el.section}` : '', el.context, el.calendarDate || '', el.offscreen ? '视口外' : '', el.disabled ? '禁用' : '']
            .filter(Boolean).join(' ');
          appendLog(`  ${el.index} ${el.role} ${el.label}  <${flags}>`, 'info');
        });
        if (res.count > preview.length) {
          appendLog(`  …还有 ${res.count - preview.length} 个未列出`, 'info');
        }
      } else {
        appendLog(`快照失败: ${(res && res.reason) || '未知原因'}`, 'err');
      }
    } catch (err) {
      appendLog(`快照失败: ${err.message}`, 'err');
    }
    return;
  }
  if (t.id === 'btn-refresh-todo') {
    await refreshTodo();
    return;
  }
  if (t.id === 'btn-dump-struct') {
    await dumpPageStructure();
    return;
  }
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    state.resume = withoutReferralCode(data);
    await chrome.storage.local.set({ resume: state.resume });
    renderForm();
    renderEduList();
    renderWorkList();
    renderPublicationList();
    appendLog(`已导入简历: ${data.basics && data.basics.name || '(无姓名)'}`, 'ok');
    refreshStatus();
  } catch (err) {
    appendLog(`导入失败: ${err.message}`, 'err');
  }
  e.target.value = '';
});

document.getElementById('resume-photo').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!/^image\/(?:jpeg|png)$/.test(file.type)) {
    appendLog('照片格式需为 JPG、JPEG 或 PNG', 'err');
    e.target.value = '';
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    appendLog('照片不能超过 2MB', 'err');
    e.target.value = '';
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('照片读取失败'));
    reader.readAsDataURL(file);
  });
  if (!state.resume.basics) state.resume.basics = {};
  state.resume.basics.photo = {name:file.name,type:file.type,size:file.size,dataUrl};
  await chrome.storage.local.set({resume:state.resume});
  renderForm();
  appendLog(`照片已保存到插件：${file.name}`, 'ok');
  e.target.value = '';
});

document.getElementById('resume-attachment').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    if (!/\.(pdf|doc|docx|ppt|pptx|wps|jpe?g|png|txt)$/i.test(file.name)) {
      throw new Error('简历附件格式需为 PDF、Word、PPT、WPS、图片或 TXT');
    }
    if (file.size > 10 * 1024 * 1024) throw new Error('简历附件不能超过 10MB');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('简历附件读取失败'));
      reader.readAsDataURL(file);
    });
    if (!state.resume.basics) state.resume.basics = {};
    state.resume.basics.resumeFile = {name:file.name,type:file.type,size:file.size,dataUrl};
    await chrome.storage.local.set({resume:state.resume});
    renderForm();
    appendLog(`简历附件已保存到插件：${file.name}`, 'ok');
  } catch (err) {
    appendLog(err.message, 'err');
  } finally {
    e.target.value = '';
  }
});

// 快照诊断：定位"控件数偏少"到底是页面不对、还是有进不去的地方
function logDiagnostics(res) {
  const d = res.diagnostics;
  const page = res.page || {};
  appendLog(`页面: ${page.title || '(无标题)'} — ${page.url || '(无 URL)'}`, 'info');
  if (!d) return;

  appendLog(
    `DOM 内表单控件 ${d.inputs} 个 / 快照可达 ${res.count} 个（视口外 ${res.offscreenCount || 0} 个）`,
    'info'
  );
  // 过滤计数：可达数远小于 DOM 数时，一眼看出是被"不可见"还是"零尺寸"挡掉的
  if (res.filters) {
    const f = res.filters;
    const dropped = (f.hidden || 0) + (f.zeroSize || 0);
    appendLog(
      `  过滤: 不可见 ${f.hidden || 0} 个, 零尺寸 ${f.zeroSize || 0} 个` +
        `${dropped ? `（合计挡掉 ${dropped} 个）` : ''} / 浮层条目 ${f.popupItems || 0} 个`,
      dropped > (res.count || 0) ? 'warn' : 'info'
    );
  }
  // 被隐藏、但通过可见 label 救回来的勾选框/单选框
  if (res.proxyCount) {
    const names = (res.hiddenControls || []).map((c) => c.label).filter(Boolean);
    appendLog(
      `隐藏控件已救回 ${res.proxyCount} 个（点它的 label 即可）: ${names.join(' / ') || '(未取到名称)'}`,
      'info'
    );
  }
  if (d.inputBreakdown) {
    const parts = Object.entries(d.inputBreakdown).map(([k, v]) => `${k}×${v}`);
    appendLog(`  类型分布: ${parts.join(', ')}`, 'info');
  }
  if (d.iframes.length) {
    appendLog(`iframe ${d.iframes.length} 个，未抵达 ${res.unreachedFrames} 个`, res.unreachedFrames > 0 ? 'warn' : 'info');
  }

  // 一个控件都没取到：把"这页到底有没有东西"摊开。
  // 区分三种情况：页面没渲染完 / 表单是 div 伪装的 / 控件藏在 Shadow DOM 里
  if (!res.count) {
    appendLog(`页面状态: readyState=${d.readyState || '?'} / 正文 ${d.bodyTextLength || 0} 字`, 'warn');
    if (d.bodyTextHead) {
      appendLog(`可见文本开头: ${d.bodyTextHead}`, 'warn');
    } else {
      appendLog('可见文本为空 —— 页面大概率还在渲染，或内容全在 iframe / Shadow DOM 里', 'warn');
    }
    const loose = d.looseBreakdown ? Object.entries(d.looseBreakdown).map(([k, v]) => `${k}×${v}`).join(', ') : '';
    appendLog(`宽松口径控件 ${d.looseControls || 0} 个${loose ? `（${loose}）` : ''}`, d.looseControls ? 'warn' : 'info');
    if (d.shadowInputs) {
      appendLog(`Shadow DOM 内还有 ${d.shadowInputs} 个原生控件（主文档数不到）`, 'warn');
    }
  }
  if (d.openShadowRoots || d.suspectedClosedShadowHosts.length) {
    appendLog(
      `Shadow DOM：开放 ${d.openShadowRoots} 个，疑似封闭 ${d.suspectedClosedShadowHosts.length} 个${d.suspectedClosedShadowHosts.length ? '（' + d.suspectedClosedShadowHosts.join(', ') + '）' : ''}`,
      d.suspectedClosedShadowHosts.length ? 'warn' : 'info'
    );
  }
  if (d.iframes.length) {
    d.iframes.slice(0, 5).forEach(f => {
      appendLog(`  iframe ${f.id || '(无 id)'} ${f.sameOrigin ? '[同源]' : '[跨源]'} ${f.src || '(无 src)'}`, 'info');
    });
  }
}

// === Agent 进度回传 ===
// Service Worker 用 chrome.runtime.sendMessage 推 FILL_PROGRESS / FILL_DONE。
// 没有这个监听器的话，消息会被静默丢弃，界面上就只剩"Agent 已启动"一行。
let fillPort = null;
let fillRunning = false;

function setFillRunning(running) {
  fillRunning = running;
  const button = document.getElementById('btn-start-fill');
  if (button) button.disabled = running;
}

function candidateText(c) {
  if (!c) return '';
  return `可点 ${c.CLICK || 0} / 可输入 ${c.TYPE_TEXT || 0} / 可选 ${c.SELECT || 0} / 可上传 ${c.UPLOAD_FILE || 0}`;
}

function describeProgress(p) {
  if (p.phase === 'start') return p.action || '开始';
  if (p.phase === 'snapshot') return `第 ${p.step} 步 · 读取页面`;
  if (p.phase === 'jev') {
    return `第 ${p.step} 步 · 读取到 ${p.count || 0} 个控件（${candidateText(p.candidates)}）`;
  }
  if (p.phase === 'decided') {
    const bits = [p.operation];
    if (p.target) bits.push(`目标 ${p.target}`);
    if (p.resumeField) bits.push(`取值 ${p.resumeField}`);
    if (typeof p.confidence === 'number') bits.push(`置信 ${(p.confidence * 100).toFixed(0)}%`);
    let line = `第 ${p.step} 步 · 决策 ${bits.join(' / ')}`;
    if (p.topActions && p.topActions.length) line += `（候选排序: ${p.topActions.join(', ')}）`;
    return line;
  }
  if (p.phase === 'section-decided') {
    const confidence = typeof p.confidence === 'number' ? ` / 置信 ${(p.confidence * 100).toFixed(0)}%` : '';
    return `第 ${p.step} 轮 · ${p.action || `分区决策 ${p.operation || ''}`}${confidence}`;
  }
  if (p.phase === 'done') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'blocked') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'scroll') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'execute') return `第 ${p.step} 步 · 执行 ${p.action}`;
  if (p.phase === 'failed') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'stale') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'empty') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'wait') return `第 ${p.step} 步 · ${p.action}`;
  if (p.phase === 'section') return p.action;
  return `第 ${p.step} 步 · ${p.phase}`;
}

function handleFillProgress(p) {
  const text = describeProgress(p);
  const progressEl = document.getElementById('fill-progress');
  if (progressEl) {
    progressEl.textContent = text;
    progressEl.className = 'fill-progress active';
  }
  // 每步都打“读取页面”太吵，只更新状态条；首轮控件数量保留在日志中。
  const kind = p.phase === 'blocked' || p.phase === 'empty' ? 'warn' : 'info';
  if (p.phase !== 'snapshot' && (p.phase !== 'jev' || p.step === 1)) {
    appendLog(text, kind);
  }
}

// 取不到控件时，把页面结构 dump 出来：哪些元素有手型光标、哪些文字像入口、哪些像列表行。
// 移动端框架常不设 cursor:pointer，光看"有没有原生控件"判断不出入口在哪。
async function dumpPageStructure() {
  try {
    const tab = await getActivePageTab();
    await ensureContentScript(tab.id);
    const frameIds = (await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:()=>true})).map(frame=>frame.frameId);
    const frames = [];
    for (const frameId of frameIds) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id,{type:'DUMP_STRUCTURE'},{frameId});
        if (res?.ok && res.structure) frames.push({frameId,structure:res.structure});
      } catch (_) {}
    }
    if (!frames.length) {
      appendLog('结构导出失败: 所有页面 frame 均无响应', 'err');
      return;
    }
    const s = frames.find(frame=>frame.frameId===0)?.structure || frames[0].structure;
    const blob = new Blob([JSON.stringify({frames}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `page-structure-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog(`页面结构已导出：${frames.length} 个 frame；主页面手型/可点 ${s.pointerLike.length} 个，疑似入口 ${s.entryLike.length} 个，列表行 ${s.rowLike.length} 个`, 'ok');
    if (s.pointerLike.length) {
      appendLog('  手型光标 / onclick 的元素:', 'info');
      for (const e of s.pointerLike.slice(0, 8)) {
        appendLog(`    <${e.tag} class="${e.cls}"> ${e.w}×${e.h} cursor=${e.cursor || '-'} 「${e.text}」`, 'info');
      }
    }
    if (s.entryLike.length) {
      appendLog('  文案像入口的元素:', 'info');
      for (const e of s.entryLike.slice(0, 8)) {
        appendLog(`    <${e.tag} class="${e.cls}"> ${e.w}×${e.h} cursor=${e.cursor || '-'} 「${e.text}」`, 'info');
      }
    }
  } catch (err) {
    appendLog(`结构导出失败: ${err.message}`, 'err');
  }
}

function handleFillDone(r) {
  setFillRunning(false);
  const progressEl = document.getElementById('fill-progress');
  const reason = r.reason || '';
  if (Array.isArray(r.sections)) {
    const saved=r.sections.filter(item=>item.status==='saved').length;
    const existing=r.sections.filter(item=>item.status==='already-saved').length;
    const total=r.sections.filter(item=>item.status!=='no-data').length;
    const pending=(r.pendingIssues || []);
    const pendingDetail=pending.slice(0,10).map(issue=>`${issue.field}：${issue.reason}`).join('；');
    const summary=`${r.done ? (pending.length ? '本轮检查结束，仍有未完成项' : '本轮可识别字段检查结束（请核对整表）') : '填写已中断'}：本次保存 ${saved} 条，原有 ${existing} 条，已检查 ${total} 条，待补 ${pending.length} 项${pendingDetail ? `｜${pendingDetail}` : ''}`;
    if (progressEl) {
      progressEl.textContent=summary;
      progressEl.className='fill-progress '+(r.ok?'ok':'err');
    }
    appendLog(summary,r.ok?'ok':'warn');
    for (const item of r.sections) appendLog(`${item.section}${Number.isInteger(item.recordIndex) ? ` 第 ${item.recordIndex+1} 条` : ''}：${item.status}${item.reason ? ` · ${item.reason}` : ''}`,
      ['saved','already-saved','no-data'].includes(item.status)?'ok':'warn');
    for (const issue of r.pendingIssues || []) appendLog(`保留待补：${issue.field} · ${issue.reason}`,'warn');
    if (reason) appendLog(reason,r.ok?'ok':'warn');
    if (fillPort) {
      fillPort.disconnect();
      fillPort = null;
    }
    return;
  }
  if (progressEl) {
    progressEl.textContent = r.ok ? (r.sectionSaved ? '当前分区已保存' : r.done ? '当前分区已填写' : '已结束') : `待处理: ${reason}`;
    progressEl.className = 'fill-progress ' + (r.ok ? 'ok' : 'err');
  }
  const summary = r.ok
    ? `${r.sectionSaved ? '当前分区已保存' : '当前分区已填写'}，共 ${r.step} 步`
    : `结束: ${reason || '未完成'}（第 ${r.step} 步）`;
  appendLog(summary, r.ok ? 'ok' : 'err');
  for (const issue of r.pendingIssues || []) appendLog(`保留待补：${issue.field} · ${issue.reason}`,'warn');

  // 把最后几步打出来，卡在哪一目了然
  const tail = (r.history || []).slice(-12);
  if (tail.length) {
    appendLog('最近的操作:', 'info');
    for (const h of tail) {
      const mark = h.page_changed === false ? '·无变化' : '';
      appendLog(`  ${h.action || h.kind}${h.text ? ' → ' + h.text : ''} ${mark}`.trim(), 'info');
    }
  }
  if (fillPort) {
    fillPort.disconnect();
    fillPort = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'FILL_PROGRESS') handleFillProgress(msg);
  else if (msg.type === 'FILL_DONE') handleFillDone(msg);
  return false;
});

// 关掉 Popup 时若还在跑，断开保活连接让 SW 能正常休眠
window.addEventListener('pagehide', () => {
  if (fillPort) {
    fillPort.disconnect();
    fillPort = null;
  }
});

// 重新打开 Popup 时把上一段记录接回来（只接 10 分钟内的）
async function restoreFillLog() {
  try {
    const { fillEvents } = await chrome.storage.session.get(['fillEvents']);
    if (!fillEvents || !fillEvents.length) return;
    const newest = fillEvents[fillEvents.length - 1];
    if (Date.now() - (newest.at || 0) > 10 * 60 * 1000) return;
    appendLog(`— 接回上一段填写记录 —`, 'info');
    for (const item of fillEvents) {
      replayLogAt=item.at || null;
      if (item.type === 'FILL_PROGRESS') handleFillProgress(item);
      else if (item.type === 'FILL_DONE') handleFillDone(item);
    }
    replayLogAt=null;
    setFillRunning(newest.type !== 'FILL_DONE');
  } catch (_) { replayLogAt=null; }
}

async function refreshStatus() {
  const stored = await chrome.storage.local.get(['resume', 'jevApiKey']);
  const resumeStatusEl = document.getElementById('resume-status');
  const keyStatusEl = document.getElementById('key-status');
  if (resumeStatusEl) {
    resumeStatusEl.textContent = stored.resume ? '已录入' : '未录入';
    resumeStatusEl.className = 'status-value ' + (stored.resume ? 'ok' : 'warn');
  }
  if (keyStatusEl) {
    keyStatusEl.textContent = stored.jevApiKey ? '已填写' : '未填写';
    keyStatusEl.className = 'status-value ' + (stored.jevApiKey ? 'ok' : 'warn');
  }
  const previewEl = document.getElementById('json-preview');
  if (previewEl && state.resume) previewEl.textContent = JSON.stringify(state.resume, null, 2);
}

document.addEventListener('DOMContentLoaded', async () => {
  appendLog('Popup 已加载', 'info');
  try {
    const stored = await chrome.storage.local.get(['resume', 'jevApiKey']);
    if (stored.resume) {
      state.resume = stored.resume;
    } else {
      state.resume = await getDefaultResume();
    }
    const sanitizedResume = withoutReferralCode(state.resume);
    if (sanitizedResume !== state.resume) {
      state.resume = sanitizedResume;
      await chrome.storage.local.set({resume:state.resume});
    }
    state.apiKey = stored.jevApiKey || '';
    document.getElementById('jev-api-key').value = state.apiKey;
    renderForm();
    renderEduList();
    renderWorkList();
    renderPublicationList();
    refreshStatus();
    restoreFillLog();
  } catch (err) {
    appendLog(`初始化失败: ${err.message}`, 'err');
  }
});
