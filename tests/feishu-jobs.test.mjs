import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildActionPlan, buildSectionPlan } from '../lib/jev-client.js';

const field = (label, control) => `<div class="field"><div class="caption">${label} *</div>${control}</div>`;
const dom = new JSDOM(`<!doctype html><html><body>
  <div role="menu"><span>社招内推</span><span>校招内推</span></div>
  <h2>基础信息</h2>
  ${field('姓名', '<input placeholder="请输入">')}
  <h2>教育经历</h2>
  ${field('学校名称', '<div role="combobox"><input placeholder="请输入"></div>')}
  ${field('学历', '<div role="combobox"></div>')}
  ${field('专业', '<input placeholder="请输入">')}
  ${field('起止时间', '<div data-cy="education[0].period"><div class="atsx-date-picker-period-month-label"><span>YYYY</span>-<span>MM</span></div><div class="atsx-date-picker-period-month-label"><span>YYYY</span>-<span>MM</span></div><input class="atsx-date-picker-period-hidden-input" style="width:0;height:0" value="2025-09 - 2026-11"></div>')}
  <div class="field"><div class="caption">学历 *</div><div style="cursor:pointer">硕士</div></div>
  <div style="cursor:pointer">添加</div>
  <h2>实习经历</h2>
  <div style="cursor:pointer">添加</div>
  <h2>语言能力</h2>
  ${field('语言', '<div role="combobox" style="opacity:0"><span>英语</span></div>')}
  ${field('精通程度', '<div role="combobox" style="opacity:0"></div>')}
  <h2>语言能力</h2>
  <div class="field"><div class="caption">语言 *</div><div style="cursor:pointer">英语</div></div>
  <div class="field"><div class="caption">精通程度 *</div><div style="cursor:pointer">精通程度</div></div>
  <div style="cursor:pointer">添加</div>
  <h2>获奖</h2>
  ${field('奖项名称', '<input placeholder="请输入">')}
  ${field('获奖时间', '<input placeholder="YYYY">')}
  ${field('描述', '<textarea placeholder="请输入"></textarea>')}
  <div>添加</div>
  <h2>自我评价</h2>
  ${field('自我评价', '<textarea placeholder="请输入"></textarea>')}
  <div>添加</div>
  <div class="date-popup" style="display:none"><span>2036</span><span>2035</span><span>2034</span><span>2033</span><span>2032</span><span>2031</span><span>2030</span><span>2029</span><span>2028</span><span>2027</span><span>2026</span><span>2025</span></div>
  <div class="date-popup" style="display:none"><span>01</span><span>02</span><span>03</span><span>04</span><span>05</span><span>06</span><span>07</span><span>08</span><span>09</span><span>10</span><span>11</span><span>12</span></div>
  <div class="picker-popup"><div class="atsx-date-picker-period-month-panel"><div role="option">至今</div></div></div>
  <div class="atsx-date-picker-period-month"><div class="atsx-date-picker-period-month-label"><span class="atsx-date-picker-period-month-label-toToday">至今</span></div></div>
</body></html>`, {runScripts:'outside-only', pretendToBeVisual:true,
  url:'https://bambulab.jobs.feishu.cn/campus/resume/example/apply'});
const {window} = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
Object.defineProperty(window.document.querySelector('.atsx-date-picker-period-month-panel'), 'getBoundingClientRect', {
  value: () => ({top:10,left:10,right:10,bottom:10,width:0,height:0,x:10,y:10})
});
const degreeStateInput = window.document.querySelectorAll('[role="combobox"]')[1].appendChild(window.document.createElement('input'));
Object.defineProperty(degreeStateInput, 'getBoundingClientRect', {
  value: () => ({top:10,left:10,right:10,bottom:10,width:0,height:0,x:10,y:10})
});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_message,callback)=>callback?.(),lastError:null}};
for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
  window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}
const snapshot = () => new Promise(resolve => listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const trustedClickPoint = index => new Promise(resolve => listeners[0]({type:'TRUSTED_CLICK_POINT',index},{},resolve));
const feishuYearTarget = index => new Promise(resolve => listeners[0]({type:'FEISHU_YEAR_TARGET',index},{},resolve));
const feishuYearChoicePoint = (index, year) => new Promise(resolve => listeners[0]({type:'FEISHU_YEAR_CHOICE_POINT',index,year},{},resolve));
const feishuRangeState = index => new Promise(resolve => listeners[0]({type:'FEISHU_RANGE_STATE',index},{},resolve));
const page = await snapshot();

assert.equal(page.page.platform, 'feishu-jobs', '飞书招聘页面应启用平台驱动');
assert.equal(page.elements.find(el => el.label === '姓名')?.section, '个人信息', '基础信息应进入个人信息资料集合');
const education = page.elements.filter(el => el.section === '教育经历');
assert.ok(education.some(el => el.label === '学校名称'), '学校检索框应保留字段标题');
assert.ok(education.some(el => el.label === '起止时间' && el.kind === 'feishu-date-range'),
  '飞书起止时间应作为一个范围控件采集');
const educationRange = education.find(el => el.kind === 'feishu-date-range');
assert.equal(educationRange?.value, '', '飞书隐藏 input 的旧日期不能代替两个空白的可见日期槽');
assert.equal((await feishuRangeState(educationRange.index))?.values?.join(' | '), 'YYYY-MM | YYYY-MM',
  '飞书日期状态从可见起止槽读取');
assert.ok(!page.elements.some(el => el.context === 'popup' && /^(?:YYYY|MM|-)$/u.test(el.label)),
  '闭合范围控件的格式占位不应阻塞当前分区');
assert.ok(!page.elements.some(el => el.context === 'popup' && el.label === '至今'),
  '关闭的月份面板和日期字段的可见“至今”值都不应成为浮层候选');
assert.ok(!page.elements.some(el => /^(?:202[5-8]|0[1-9]|1[0-2])$/.test(el.label) && el.context === 'popup'),
  '打开的飞书年月范围面板不应挤占主表单快照或变成通用下拉候选');
assert.ok(!page.elements.some(el => el.context === 'popup' && /^(?:社招内推|校招内推)$/.test(el.label)),
  '飞书常驻招聘导航不应被当成字段下拉候选');
assert.ok(page.elements.some(el => el.section === '实习经历' && el.label === '添加实习经历'),
  '无记录分区的添加入口应保留所属 section');
assert.equal(page.elements.find(el => el.section === '语言能力' && el.label === '语言')?.recordIndex, 0,
  '飞书已选语言应恢复字段标题并绑定到第一条语言记录');
const cardLanguage = page.elements.find(el => el.section === '语言能力' && el.label === '语言' && el.kind === 'custom-select');
assert.equal(cardLanguage?.value, '英语', '飞书可点击的语言展示卡片应保留已选值');
assert.ok(page.elements.some(el => el.section === '语言能力' && el.label === '精通程度' && el.kind === 'custom-select'),
  '飞书可点击的熟练度展示卡片应作为统一选择控件参与填写');
assert.ok(page.elements.some(el => el.section === '语言能力' && el.label === '添加语言能力' && el.kind === 'card'),
  '飞书分区的添加入口保持新增语义，不与下拉选择控件混合');
assert.ok(page.elements.some(el => el.section === '获奖情况' && /添加/.test(el.label) && el.kind === 'card'),
  '飞书的获奖新增入口即使没有指针样式也应被采集');
assert.ok(page.elements.some(el => el.section === '自我评价' && /添加/.test(el.label) && el.kind === 'card'),
  '飞书的自我评价新增入口即使没有指针样式也应被采集');
assert.equal(page.elements.find(el => el.section === '自我评价' && el.kind === 'input')?.label, '自我评价',
  '飞书自我评价的通用占位文本应回收为分区字段标题');
assert.equal(page.elements.find(el => el.section === '获奖情况' && el.label === '获奖时间')?.kind, 'feishu-year',
  '飞书单年份获奖时间应识别为专用年份控件，避免打开无候选日历层');
const awardYearElement = page.elements.find(el => el.section === '获奖情况' && el.label === '获奖时间');
const awardYearInput = window.document.querySelector('input[placeholder="YYYY"]');
let awardYearInputEvents = 0;
awardYearInput.addEventListener('input', () => { awardYearInputEvents += 1; });
const awardYearResult = await new Promise(resolve => listeners[0]({
  type:'EXECUTE', action:'type_text', index:awardYearElement.index, value:'2024'
}, {}, resolve));
assert.equal(awardYearResult.ok, true, '飞书年份框应在逐位输入后稳定回读');
assert.equal(awardYearInput.value, '2024', '飞书年份框保留完整年份');
assert.equal(awardYearInputEvents, 4, '飞书年份框逐位提交四次输入事件');
const yearTarget = await feishuYearTarget(awardYearElement.index);
assert.equal(yearTarget?.inputMode, 'feishu-year-picker', '飞书年份框应声明网格选择事务');
for (const popup of window.document.querySelectorAll('.date-popup')) popup.style.display = '';
const yearChoice = await feishuYearChoicePoint(awardYearElement.index, '2025');
assert.equal(yearChoice?.selectionMode, 'feishu-year-picker', `飞书年份网格应返回目标年份的选择坐标：${JSON.stringify(yearChoice)}`);
assert.equal(page.elements.find(el => el.section === '教育经历' && el.label === '学历' && el.kind === 'custom-select')?.value, '硕士',
  '飞书把已选学历放在视觉卡片时，应回填同一行的状态下拉值');
assert.ok(page.elements.some(el => el.section === '教育经历' && el.label === '学历' && el.kind === 'custom-select'),
  '飞书零尺寸状态 input 应由外层 combobox 承接，避免遗漏学历和语言选择器');
assert.ok(page.elements.some(el => el.section === '教育经历' && el.label === '学历' && el.kind === 'custom-select' && !el.clickMode),
  '外层 combobox 应直接进入共享选择器流程，展示卡片只作为补充回读');
assert.equal(cardLanguage?.clickMode, 'trusted-pointer',
  '飞书可见选择卡片应声明浏览器层真实指针点击策略');
assert.equal(cardLanguage?.clickLabel, '英语',
  '飞书卡片保留原始可见值，真实点击可命中值槽而不是字段标题');
assert.equal(page.elements.find(el => el.section === '实习经历' && el.label === '添加实习经历')?.clickMode, 'trusted-pointer',
  '飞书新增记录卡片应使用同一真实指针点击策略');
const languageClickPoint = await trustedClickPoint(cardLanguage.index);
assert.equal(languageClickPoint?.ok, true,
  '飞书卡片应提供浏览器层真实点击坐标');
assert.equal(languageClickPoint?.clickMode, 'trusted-pointer',
  '飞书坐标请求应保留真实指针执行标记');
assert.deepEqual({...languageClickPoint?.point}, {x:110,y:25},
  '飞书卡片应提供浏览器层指针点击所需的稳定视口坐标');

const resume = {
  basics:{name:'示例姓名'},
  education:[{institution:'示例大学 A',studyType:'硕士',area:'计算机科学与技术',startDate:'2025-09-01',endDate:'2026-11-30'}],
  internship:[{company:'示例公司',position:'实习生',startDate:'2026-07-01',endDate:'2026-11-30'}]
};
const educationPlan = buildActionPlan(education, resume, [], {title:'教育经历',platform:'feishu-jobs'});
const rangeAction = educationPlan.actions.find(action => action.kind === 'feishu-date-range');
assert.deepEqual({field:rangeAction?.resumeField, value:rangeAction?.resolvedValue}, {
  field:'education[0].startDate', value:'2025-09 - 2026-11'
}, '飞书范围输入应在一次操作中携带完整起止月份');
const partialRangePlan = buildActionPlan([
  {...educationRange,value:'2025-09 - YYYY-MM',recordIndex:0}
],resume,[],{title:'教育经历',platform:'feishu-jobs'});
assert.equal(partialRangePlan.actions.find(action=>action.kind==='feishu-date-range')?.resolvedValue,
  '2025-09 - 2026-11','飞书日期只填一端时应继续选择空白端');
const sectionPlan = buildSectionPlan(page.elements, resume, {}, page.page);
assert.ok(sectionPlan.actions.some(action => action.operation === 'ADD_RECORD' && action.section === '实习经历'),
  '空的飞书实习分区应新增第一条，而不是错误从第二条开始');

const schoolSearchPlan = buildActionPlan([
  {index:'school', section:'教育经历', label:'学校名称', kind:'combobox', operations:['CLICK'], value:''},
  {index:'search', section:'教育经历', label:'请输入', kind:'input', context:'popup', operations:['TYPE_TEXT'], value:''}
], resume, [{kind:'click', resumeField:'education[0].institution', label:'学校名称', controlKind:'combobox'}],
{title:'教育经历', platform:'feishu-jobs'});
assert.deepEqual(schoolSearchPlan.actions.map(action => ({target:action.target, field:action.resumeField, value:action.resolvedValue})), [{
  target:'search', field:'education[0].institution', value:'示例大学 A'
}], '飞书通用搜索框应保持学校字段的选择器事务');

const schoolChoicePlan = buildActionPlan([
  {index:'school', section:'教育经历', label:'学校名称', kind:'input', fieldProtocol:'search-select', valueCommitted:false, operations:['TYPE_TEXT'], value:'示例大学 A'},
  {index:'choice', section:'教育经历', label:'示例大学 A', kind:'option-item', context:'popup', operations:['CLICK'], value:''}
], resume, [{kind:'type_text', context:'popup', resumeField:'education[0].institution', label:'学校名称'}],
{title:'教育经历', platform:'feishu-jobs'});
assert.equal(schoolChoicePlan.actions[0]?.target, 'choice', '飞书学校搜索出现候选时先提交匹配选项');

const languageResume = {...resume, languages:[{language:'英语', fluency:'雅思 7.0', siteFluency:'良好'}]};
const awardResume = {...resume, basics:{...resume.basics,summary:'可验证的自我评价'}, awards:[{
  title:'示例全国数据应用大赛', date:'2024-08-01', details:'全国，特等奖'
}]};
const awardPlan = buildActionPlan(page.elements.filter(el => el.section === '获奖情况'), awardResume, [],
  {title:'获奖情况', platform:'feishu-jobs', scopedSection:true});
assert.deepEqual(awardPlan.actions.filter(action => action.operation === 'TYPE_TEXT').map(action => [action.resumeField, action.resolvedValue]), [
  ['awards[0].title', undefined], ['awards[0].date', undefined], ['awards[0].details', undefined]
], '飞书获奖记录应填入名称、年份与描述三个页面字段');
assert.equal(awardPlan.actions.find(action => action.resumeField === 'awards[0].date')?.value, undefined,
  '动作值由字段绑定在执行时读取，避免在计划里复制敏感简历内容');

const repeatedAwards = Array.from({length:8}, (_, index) => `
  <div class="award-record">
    ${field('奖项名称', `<input value="奖项${index + 1}" placeholder="请输入">`)}
    ${field('获奖时间', '<input placeholder="YYYY">')}
    ${field('描述', '<textarea placeholder="请输入"></textarea>')}
  </div>`).join('');
const replacedEducationRange = window.document.querySelector('[data-cy="education[0].period"]');
replacedEducationRange.parentElement.outerHTML = '<div><div data-cy="education[0].period"><div class="atsx-date-picker-period-month-label"><span>2025</span>-<span>09</span></div><div class="atsx-date-picker-period-month-label"><span>2026</span>-<span>11</span></div><input class="atsx-date-picker-period-hidden-input"></div></div>';
assert.deepEqual(Array.from((await feishuRangeState(educationRange.index)).values), ['2025-09','2026-11'],
  '飞书重建并填满日期字段后，原快照索引应通过范围结构重新定位可见日期槽');
window.document.body.innerHTML = `<h2>获奖</h2>${repeatedAwards}<div>添加</div>`;
const repeatedAwardPage = await snapshot();
const repeatedAwardYears = repeatedAwardPage.elements.filter(el =>
  el.section === '获奖情况' && el.label === '获奖时间');
assert.deepEqual(Array.from(repeatedAwardYears, el => el.recordIndex), [0,1,2,3,4,5,6,7],
  '飞书八条奖项的年份框应逐条继承对应记录索引');
const eightAwardResume = {
  basics:{name:'示例姓名'},
  awards:Array.from({length:8}, (_, index) => ({
    title:`奖项${index + 1}`, date:`202${index % 5}-01-01`, details:`奖项${index + 1}描述`
  }))
};
const repeatedAwardPlan = buildActionPlan(repeatedAwardPage.elements, eightAwardResume, [],
  {title:'获奖情况', platform:'feishu-jobs', scopedSection:true});
assert.deepEqual(repeatedAwardPlan.actions.filter(action => action.resumeField?.endsWith('.date')).map(action => action.resumeField),
  Array.from({length:8}, (_, index) => `awards[${index}].date`),
  '飞书八条奖项年份应绑定各自 JSON 记录，不能复用最后一条');
const correctedAwardElements = repeatedAwardPage.elements.map(entry =>
  entry.label === '获奖时间' && entry.recordIndex === 0 ? {...entry, value:'2025'} : entry);
const correctedAwardPlan = buildActionPlan(correctedAwardElements, eightAwardResume, [],
  {title:'获奖情况', platform:'feishu-jobs', scopedSection:true});
assert.equal(correctedAwardPlan.actions.find(action => action.resumeField === 'awards[0].date')?.operation, 'TYPE_TEXT',
  '飞书已绑定奖项的年份与本地资料不一致时，应校正这一条而不影响相邻记录');
const deferredAwardPlan = buildActionPlan(correctedAwardElements, eightAwardResume, [{
  kind:'cancel', cancelField:'awards[0].date', action:'DEFER_FIELD'
}], {title:'获奖情况', platform:'feishu-jobs', scopedSection:true});
assert.ok(!deferredAwardPlan.actions.some(action => action.resumeField === 'awards[0].date'),
  '年份回读失败后将该字段列入当前轮待补，后续步骤继续处理其他记录');
const selfEvaluationPlan = buildActionPlan(page.elements.filter(el => el.section === '自我评价'), awardResume, [],
  {title:'自我评价', platform:'feishu-jobs', scopedSection:true});
assert.equal(selfEvaluationPlan.actions.find(action => action.resumeField === 'basics.summary')?.operation, 'TYPE_TEXT',
  '飞书自我评价文本框应绑定本地自我介绍字段');
const blankDegreePlan = buildActionPlan([{
  index:'degree', section:'教育经历', recordIndex:0, label:'学历', kind:'custom-select', operations:['CLICK'], value:'请选择'
}], resume, [], {title:'教育经历', platform:'feishu-jobs', scopedSection:true, ignoreUnmapped:true});
assert.equal(blankDegreePlan.actions[0]?.resumeField, 'education[0].studyType',
  '飞书空白学历选择框应直接绑定当前教育记录的学历字段');

const mismatchedEducationPlan = buildActionPlan([
  {index:'school', section:'教育经历', recordIndex:0, label:'学校', kind:'input', operations:['TYPE_TEXT'], value:'香港中文大学'},
  {index:'degree', section:'教育经历', recordIndex:0, label:'学历', kind:'custom-select', operations:['CLICK'], value:'请选择'}
], resume, [], {title:'教育经历', platform:'feishu-jobs', scopedSection:true, ignoreUnmapped:true});
assert.equal(mismatchedEducationPlan.status, 'blocked',
  '网页已有另一所学校时，不得把同一条的空学历误验收为已完成');
assert.ok(mismatchedEducationPlan.summary.unresolved.some(item =>
  item.reason === '当前记录的身份字段与本地资料不同，已保留网页内容'),
  '记录冲突应作为待处理项回传，而非静默跳过');

const languagePlan = buildActionPlan([{
  index:'fluency', section:'语言能力', label:'精通程度', kind:'custom-select', operations:['CLICK'], value:''
}], languageResume, [],
{title:'语言能力', platform:'feishu-jobs'});
const languageChoicePlan = buildActionPlan([
  {index:'fluency', section:'语言能力', label:'精通程度', kind:'custom-select', operations:['CLICK'], value:''},
  {index:'business', section:'语言能力', label:'商务会话', kind:'option-item', context:'popup', operations:['CLICK'], value:''}
], languageResume, [{kind:'click', resumeField:languagePlan.actions[0]?.resumeField, label:'精通程度'}],
{title:'语言能力', platform:'feishu-jobs'});
assert.equal(languageChoicePlan.actions[0]?.label, '商务会话', '飞书语言熟练度应映射为页面展示的沟通场景');

const cityAdjustmentPlan = buildActionPlan([{
  index:'adjustment', section:'申请信息', label:'接受调剂到其他城市', kind:'custom-checkbox',
  operations:['CLICK'], checked:false, formRuleSignals:['job-adjustment']
}], resume, [], {title:'申请信息', platform:'feishu-jobs'});
assert.ok(cityAdjustmentPlan.actions.some(action => action.formRule === 'job-adjustment-yes'),
  '飞书城市调剂复选框应按用户规则勾选接受');

console.log('feishu jobs platform tests passed');
