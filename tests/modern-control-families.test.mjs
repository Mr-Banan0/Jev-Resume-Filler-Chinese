import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scripts = ['content/widget-drivers.js', 'content/platform-drivers.js', 'content/content.js'];
const {CONTENT_SCRIPT_VERSION}=await import('../lib/content-version.js');
assert.equal(readFileSync(new URL('../content/content.js',import.meta.url),'utf8')
  .match(/const CONTENT_SCRIPT_VERSION = '([^']+)'/)?.[1],CONTENT_SCRIPT_VERSION,
  '页面脚本与调度器使用相同版本，重载后能识别旧实例');
function harness(html, url) {
  const dom = new JSDOM(html, { url, runScripts:'outside-only', pretendToBeVisual:true });
  const { window } = dom;
  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
  window.HTMLElement.prototype.scrollIntoView = options => {
    assert.equal(options?.behavior,'instant','点击坐标在即时滚动完成后读取');
  };
  const listeners = [];
  window.chrome = { runtime:{ onMessage:{addListener:fn=>listeners.push(fn)},
    sendMessage:(_message,callback)=>callback?.(), lastError:null } };
  scripts.forEach(path => window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')));
  return { window, request: message => new Promise(resolve => listeners[0](message, {}, resolve)) };
}

// The Formily field caption is outside several input/selector wrappers. Bind to the
// closest field, then separate the two inputs of a range by their DOM order.
const udField = (label, control) => `<div class="ud-formily-item">
  <div class="ud-formily-item-label"><div class="ud-formily-item-label-content"><span>
    <label>${label}</label><span>*</span></span></div></div>
  <div class="ud-formily-item-control"><div class="ud-formily-item-control-content">
    <div class="ud-formily-item-control-content-component">${control}</div>
  </div></div></div>`;
const udSelect = value => `<div class="ud__select"><div class="ud__select__selector">
  <div class="ud__select__selector__content">
    ${value ? `<span class="ud__select__selector__content__value">${value}</span>` : ''}
    <div class="ud__select__selector__search"><input role="combobox" type="search" readonly></div>
  </div></div></div>`;
const udMonth = () => '<div class="ud__picker"><div class="ud__picker-dateInput"><div class="ud__picker-inputWrapper-inner"><input placeholder="YYYY-MM"></div></div></div>';
const udRangeInput = () => '<div class="throne-biz-date-range-picker-input"><div class="ud__input"><div><div><input></div></div></div></div>';
const udModule = (title, contents) => `<div class="applyFormModuleWrapper__sample">
  <div class="applyFormModuleWrapper-left"><span>${title}</span></div>
  <div class="applyFormModuleWrapper-right">${contents}</div></div>`;
const ud = harness(`<!doctype html><body>
  ${udModule('基本信息', udField('姓名', '<div><div><div><input></div></div></div>') +
    udField('性别', udSelect('')) + udField('出生日期', udMonth()) +
    udField('可搜索选择', udSelect('').replace(' readonly', '')))}
  ${udModule('教育经历', udField('学校名称', '<input>') + udField('学历', udSelect('硕士')) +
    udField('起止时间', '<div class="throne-biz-date-range-picker-wrapper">' + udRangeInput() + udRangeInput() + '</div>') + '<button>添加</button>')}
  ${udModule('候选人声明', udField('个人声明', '<input type="checkbox">') + '<button>添加</button>')}
</body>`, 'https://example.jobs.feishu.cn/resume/apply');
const udPage = await ud.request({type:'SNAPSHOT_REQUEST'});
const udEntries = udPage.elements;
assert.equal(udEntries.find(el=>el.label==='姓名')?.section, '个人信息');
assert.equal(udEntries.find(el=>el.label==='性别')?.kind, 'custom-select', 'Read-only ARIA combobox inputs expose select operations');
assert.deepEqual(Array.from(udEntries.find(el=>el.label==='性别')?.operations || []), ['CLICK']);
assert.equal(udEntries.find(el=>el.label==='可搜索选择')?.kind, 'combobox');
assert.deepEqual(Array.from(udEntries.find(el=>el.label==='可搜索选择')?.operations || []), ['TYPE_TEXT','CLICK']);
assert.equal(udEntries.find(el=>el.label==='学历')?.value, '硕士', 'Display value commits a selector independently of its empty search input');
const birthday = udEntries.find(el=>el.label==='出生日期');
assert.equal(birthday?.kind, 'date', 'Month precision is distinct from the year-only picker');
const range = udEntries.filter(el=>el.section==='教育经历' && el.kind==='date');
assert.deepEqual(Array.from(range, el=>el.label), ['起止时间 · 开始时间', '起止时间 · 结束时间']);
assert.deepEqual(Array.from(range, el=>el.recordIndex), [0,0]);
assert.ok(range.every(el=>el.datePrecision===undefined), 'A date wrapper without an explicit precision keeps the supplied full date');
assert.ok(udEntries.some(el=>el.section==='候选人声明' && /添加/.test(el.label)), 'A declaration module owns its add control');
assert.ok(!udEntries.some(el=>el.section==='教育经历' && el.kind==='checkbox'));
const typed = await ud.request({type:'EXECUTE',action:'type_text',index:birthday.index,value:'2002-03-10'});
assert.equal(typed.ok, true);
assert.equal(ud.window.document.querySelector('input[placeholder="YYYY-MM"]').value, '2002-03', 'Input precision projects a full date to its month');
assert.equal((await ud.request({type:'EXECUTE',action:'type_text',index:range[0].index,value:'2024-09-01'})).ok, true);
assert.equal(ud.window.document.querySelector('.throne-biz-date-range-picker-input input').value, '2024-09-01');
assert.deepEqual(Array.from(range[0].operations),['CLICK'],'由日历提交的受控日期输入只提供选择操作');
const lookupField=harness('<body>'+udModule('教育经历',udField('学校名称',
  '<div class="ud__select"><div class="ud__input"><input value="示例大学"></div></div>'))+
  '<div class="ud__picker-dropdown"><button>2026年</button>'+[2023,2024,2025,2026]
    .map(year=>`<span class="ud__picker-cell">${year}</span>`).join('')+'</div></body>',
  'https://example.jobs.feishu.cn/resume/apply');
const lookupEntries=(await lookupField.request({type:'SNAPSHOT_REQUEST'})).elements;
assert.equal(lookupEntries.find(el=>el.label==='学校名称')?.value,'示例大学',
  '自定义联想框没有标准展示节点时回读真实文本输入');
assert.ok(lookupEntries.some(el=>el.context==='popup' && el.label==='2025'),
  '通用日期面板中的年份候选进入快照，旧式双列范围驱动只隔离自己的组件');
const monthInput=ud.window.document.querySelector('input[placeholder="YYYY-MM"]');
let monthActivations=0;
monthInput.addEventListener('focus',()=>monthActivations++);
monthInput.addEventListener('click',()=>monthActivations++);
await ud.request({type:'EXECUTE',action:'click',index:birthday.index});
assert.equal(monthActivations,1,'受控年月选择器接收一次激活，保持面板展开');
const arrow=lookupField.window.document.createElement('button');
arrow.className='ud__picker-header-button';
arrow.innerHTML='<svg role="img" class="ud__icon" aria-label="LeftSmall"><path></path></svg>';
lookupField.window.document.querySelector('.ud__picker-dropdown').append(arrow);
assert.ok((await lookupField.request({type:'SNAPSHOT_REQUEST'})).elements.some(el=>
  el.label==='上一页' && el.context==='popup' && el.operations.includes('CLICK')),
  '无文本的年份翻页按钮保留浮层归属，进入分区局部候选');

const upload=harness('<body>'+udModule('简历',udField('简历附件',
  '<div class="ud__upload"><input type="file"><span class="upload-status"></span></div>'))+'</body>',
  'https://example.jobs.feishu.cn/resume/apply');
const uploadInput=upload.window.document.querySelector('input');
Object.defineProperty(uploadInput,'files',{value:[],writable:true});
upload.window.DataTransfer=class { constructor(){this.files=[];this.items={add:file=>this.files.push(file)};} };
upload.window.fetch=async()=>({blob:async()=>new upload.window.Blob(['test'],{type:'application/pdf'})});
uploadInput.addEventListener('change',()=>{
  upload.window.document.querySelector('.upload-status').textContent='上传中';
  upload.window.setTimeout(()=>{
    uploadInput.files=[];
    upload.window.document.querySelector('.upload-status').textContent='test-resume.pdf';
  },700);
});
const uploadEntry=(await upload.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.kind==='file');
const uploadTransaction=upload.request({type:'EXECUTE',action:'upload_file',index:uploadEntry.index,
  file:{name:'test-resume.pdf',type:'application/pdf',dataUrl:'data:application/pdf;base64,dGVzdA=='}});
await new Promise(resolve=>setTimeout(resolve,50));
assert.equal((await upload.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.kind==='file')?.value,'',
  '上传中原生文件存在时保持未完成状态');
assert.equal((await uploadTransaction).receipt,'website-filename','等待网站上传回执再结束事务');
const parser=harness('<body><h2>上传简历</h2><div><span>上传简历，我们帮你快速解析</span><input type="file"></div>'+
  '<h2>简历附件</h2>'+udField('简历附件','<input type="file">')+'</body>',
  'https://example.test/form');
const parserInputs=(await parser.request({type:'SNAPSHOT_REQUEST'})).elements.filter(el=>el.kind==='file');
assert.deepEqual(Array.from(parserInputs[0].operations),[],
  '独立简历附件可用时，自动解析入口作为辅助工具保留');
assert.deepEqual(Array.from(parserInputs[1].operations),['UPLOAD_FILE']);

const phoenixField = (label, control) => `<div class="form-item form-item--phoenix">
  <div class="form-item__label">${label}</div><div class="form-item__control">${control}</div></div>`;
const phoenixRadio = (text, selected = false) => `<div class="phoenix-radio${selected ? ' phoenix-radio--checked' : ''}">
  <div class="phoenix-radio__wrapper"><span class="phoenix-radio__radio-text">${text}</span></div></div>`;
const phoenix = harness(`<!doctype html><body>
  <h2>个人信息</h2>${phoenixField('性别', '<div class="phoenix-radio-group">' + phoenixRadio('男', true) + phoenixRadio('女') + '</div>')}
  ${phoenixField('出生日期', '<div class="phoenix-select"><input></div>')}
  <h2>教育经历</h2>${phoenixField('学校名称', '<input>')}
  ${phoenixField('学制', '<div class="phoenix-radio-group">' + phoenixRadio('2年') + phoenixRadio('4年') + '</div>')}
  <h2>论文/专著</h2>${phoenixField('论文名称', '<input>')}
  <h2>附加问题</h2>${phoenixField('身体状况', '<div class="phoenix-radio-group">' + phoenixRadio('是') + phoenixRadio('否') + '</div>')}
  <h2>公司及应聘者声明</h2>${phoenixField('声明', '<input type="checkbox">')}
</body>`, 'https://cloud.italent.cn/form');
const phoenixPage = await phoenix.request({type:'SNAPSHOT_REQUEST'});
assert.equal(phoenixPage.page.platform, 'beisen', 'Rendered Phoenix controls identify the platform across hosts');
assert.equal(phoenixPage.elements.find(el=>el.label==='出生日期')?.kind, 'beisen-date');
assert.deepEqual(Array.from(phoenixPage.elements.find(el=>el.label==='出生日期')?.operations || []), ['PICK_DATE']);
const radios = phoenixPage.elements.filter(el=>el.kind==='custom-radio');
assert.equal(radios.length, 6, 'Each painted radio appears once');
assert.deepEqual(Array.from(radios.slice(0,2), el=>[el.label,el.optionValue,el.checked]), [
  ['性别','男',true], ['性别','女',false]
]);
assert.equal(phoenixPage.elements.find(el=>el.label==='论文名称')?.section, '论文/专著');
assert.ok(radios.filter(el=>el.section==='附加问题').every(el=>el.label==='身体状况'));
assert.equal(phoenixPage.elements.find(el=>el.kind==='checkbox')?.section, '公司及应聘者声明');
const dateHost = phoenix.window.document.querySelector('.phoenix-select');
const calendar = phoenix.window.document.createElement('div');
calendar.className = 'phoenix-calendar';
calendar.style.display = 'none';
calendar.innerHTML = '<div><button>2026年</button><button>10月</button></div><table><tr><td>5</td></tr></table>';
phoenix.window.document.body.append(calendar);
dateHost.addEventListener('click', ()=>{ calendar.style.display = ''; });
calendar.querySelector('td').addEventListener('click', ()=>{
  dateHost.insertAdjacentHTML('afterbegin', '<span class="phoenix-select__singleValue">2026-10-05</span>');
  calendar.style.display = 'none';
});
const datePick = await phoenix.request({type:'EXECUTE',action:'pick_date',
  index:phoenixPage.elements.find(el=>el.label==='出生日期').index,value:'2026-10-05'});
assert.equal(datePick.ok, true, 'A Phoenix calendar commits and reads its painted selected date across hosts');
assert.equal((await phoenix.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.label==='出生日期')?.value, '2026-10-05');

const selectSurface = phoenix.window.document.createElement('div');
selectSurface.innerHTML=phoenixField('学历','<div class="phoenix-select"><input readonly><span class="phoenix-select__switchArrow"></span></div>');
phoenix.window.document.body.append(selectSurface);
const lookup = phoenix.window.document.createElement('div');
lookup.style.display='none';
lookup.innerHTML='<input placeholder="搜索"><div><span class="choice-item">本科</span><span class="choice-item">硕士研究生</span></div>';
phoenix.window.document.body.append(lookup);
const selector=selectSurface.querySelector('input');
let selectorToggles=0;
selector.addEventListener('focus',()=>{selectorToggles++;lookup.style.display='';});
selectSurface.querySelector('.phoenix-select__switchArrow').addEventListener('click',()=>{selectorToggles++;lookup.style.display=lookup.style.display==='none'?'':'none';});
const selectBefore=await phoenix.request({type:'SNAPSHOT_REQUEST'});
const selectEntry=selectBefore.elements.find(el=>el.label==='学历');
assert.equal((await phoenix.request({type:'EXECUTE',action:'click',index:selectEntry.index})).ok,true);
assert.equal(selectorToggles,1,'A Phoenix trigger receives one activation instead of focus plus click');
const openedSelect=await phoenix.request({type:'SNAPSHOT_REQUEST'});
assert.ok(openedSelect.elements.some(el=>el.context==='popup' && el.label==='硕士研究生'),
  'Rendered Phoenix lookup options are discovered independently of the hosting domain');
const outerSelector=selector.closest('.phoenix-select');
let wrapperActivations=0;
outerSelector.addEventListener('mousedown',()=>wrapperActivations++);
outerSelector.addEventListener('click',()=>wrapperActivations++);
lookup.style.display='none';
const closedSelect=await phoenix.request({type:'SNAPSHOT_REQUEST'});
await phoenix.request({type:'EXECUTE',action:'click',index:closedSelect.elements.find(el=>el.label==='学历').index});
assert.equal(wrapperActivations,1,'Phoenix 包装层也只接收一次激活');
assert.equal((await phoenix.request({type:'CLOSE_TRANSACTIONS'})).ok,true,'关闭选择器沿当前字段的箭头执行并回读');
assert.equal(lookup.style.display,'none');
const unlabelledMenu=harness('<body><h2>教育经历</h2>'+phoenixField('学习方式',
  '<div class="phoenix-select"><input readonly><div class="phoenix-select__switchArrow"></div></div>')+
  '<div class="enum-surface" style="display:none;position:absolute"><div>全日制</div><div>非全日制</div></div></body>',
  'https://example.test/form');
const enumMenu=unlabelledMenu.window.document.querySelector('.enum-surface');
unlabelledMenu.window.document.querySelector('.phoenix-select__switchArrow').addEventListener('click',()=>{
  enumMenu.style.display=enumMenu.style.display==='none'?'':'none';
  const input=unlabelledMenu.window.document.querySelector('.phoenix-select input');
  input.replaceWith(input.cloneNode(true));
});
const enumEntry=(await unlabelledMenu.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.label==='学习方式');
await unlabelledMenu.request({type:'EXECUTE',action:'click',index:enumEntry.index});
assert.ok((await unlabelledMenu.request({type:'SNAPSHOT_REQUEST'})).elements.some(el=>
  el.context==='popup' && el.label==='全日制'),'字段旁边无 ARIA、无通用弹层类名的选项列表进入当前事务');
assert.equal((await unlabelledMenu.request({type:'CLOSE_TRANSACTIONS'})).ok,true);
const portalMenu=harness('<body><h2>教育经历</h2>'+phoenixField('学习方式',
  '<div class="phoenix-select"><input readonly><div class="phoenix-select__switchArrow"></div></div>')+
  '<div class="phoenix-selectList__virtualList-holder-inner" style="display:none"><li>全日制</li><li>非全日制</li></div></body>',
  'https://example.test/form');
const portalList=portalMenu.window.document.querySelector('[class*="phoenix-selectList__virtualList-holder-inner"]');
portalMenu.window.document.querySelector('.phoenix-select__switchArrow').addEventListener('click',()=>{
  portalList.style.display=portalList.style.display==='none'?'':'none';
});
const portalEntry=(await portalMenu.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.label==='学习方式');
await portalMenu.request({type:'EXECUTE',action:'click',index:portalEntry.index});
const portalSnapshot=await portalMenu.request({type:'SNAPSHOT_REQUEST'});
assert.ok(portalSnapshot.elements.some(el=>el.context==='popup' && el.label==='全日制'),
  '虚拟列表即使没有浮动定位和 ARIA 标注，也属于当前已打开的选择器');
portalMenu.window.document.elementFromPoint=()=>portalMenu.window.document.body;
assert.ok(!(await portalMenu.request({type:'SNAPSHOT_REQUEST'})).elements.some(el=>
  el.context==='popup' && el.label==='全日制'),
  '仍挂在 DOM 但已失去实际命中区域的列表不再阻断分区遍历');
delete portalMenu.window.document.elementFromPoint;
assert.equal((await portalMenu.request({type:'CLOSE_TRANSACTIONS'})).ok,true);

const fileFixture=harness('<body><h2>简历附件</h2>'+phoenixField('简历附件',
  '<div><span>上传文件</span><input type="file" hidden></div>')+'</body>',
  'https://cloud.italent.cn/form');
assert.equal((await fileFixture.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.kind==='file')?.label,
  '简历附件','文件输入沿表单行标题识别用途');
const flatPersonal=harness('<body><h2>个人信息</h2>'+[
  ['姓名','请输入'],['英文名','请输入'],['英语等级成绩','请输入'],['高考总分','请输入']
].map(([label,placeholder])=>phoenixField(label,`<input placeholder="${placeholder}">`)).join('')+'</body>',
  'https://cloud.italent.cn/form');
assert.ok((await flatPersonal.request({type:'SNAPSHOT_REQUEST'})).elements.every(el=>el.recordIndex===undefined),
  '外观相同的单字段行保持个人信息字段，不生成重复记录索引');
const phoneGroup=harness('<body><h2>个人信息</h2>'+phoenixField('手机号码',
  '<div class="phoenix-select"><span class="phoenix-select__singleValue">+86</span><input readonly></div>'+
  '<input value="13800138000"></body>'), 'https://cloud.italent.cn/form');
const phoneEntries=(await phoneGroup.request({type:'SNAPSHOT_REQUEST'})).elements.filter(el=>el.label==='手机号码');
assert.equal(phoneEntries.length,2);
assert.notEqual(phoneEntries[0].fieldGroup,phoneEntries[1].fieldGroup,
  '区号和已填手机号独立回读，避免将 +86 误报为未完成的号码');

const monthOnly=harness('<body><h2>教育经历</h2>'+phoenixField('开始时间',
  '<div class="phoenix-select"><input></div>')+'</body>','https://cloud.italent.cn/form');
const monthHost=monthOnly.window.document.querySelector('.phoenix-select');
const monthPanel=monthOnly.window.document.createElement('div');
monthPanel.className='phoenix-calendar';
monthPanel.style.display='none';
let selectedYear=2026;
monthPanel.innerHTML='<div><button>2026年</button><button>10月</button></div><div class="month-surface">'+
  '<button class="year-prev"></button><button class="year-title">2026</button><button class="year-next"></button>'+
  '<table>'+Array.from({length:4},(_,row)=>'<tr>'+['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月']
    .slice(row*3,row*3+3).map(label=>`<td>${label}</td>`).join('')+'</tr>').join('')+'</table></div>';
monthOnly.window.document.body.append(monthPanel);
monthHost.addEventListener('click',()=>monthPanel.style.display='');
monthPanel.querySelector('.year-prev').addEventListener('click',()=>{
  selectedYear--; monthPanel.querySelector('.year-title').textContent=String(selectedYear);
  monthPanel.querySelector('button').textContent=`${selectedYear}年`;
});
monthPanel.querySelectorAll('td').forEach((cell,index)=>cell.addEventListener('click',()=>{
  const value=`${selectedYear}-${String(index+1).padStart(2,'0')}`;
  monthHost.insertAdjacentHTML('afterbegin',`<span class="phoenix-select__calcEle">${value}</span><span class="phoenix-select__singleValue">${value}</span><span class="phoenix-select__tipEle">${value}</span>`);
  monthPanel.style.display='none';
}));
const monthEntry=(await monthOnly.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.label==='开始时间');
const monthResult=await monthOnly.request({type:'EXECUTE',action:'pick_date',index:monthEntry.index,value:'2025-09-01'});
assert.equal(monthResult.ok,true,`十二个中文月份单元格构成年月选择器：${JSON.stringify(monthResult)}`);
assert.equal(monthResult.value,'2025-09');
assert.equal((await monthOnly.request({type:'SNAPSHOT_REQUEST'})).elements.find(el=>el.label==='开始时间')?.datePrecision,'month');

// A project has one identity boundary, even when both its name and description
// are present. Viewport prioritization leaves each field's identity unchanged.
const projectFixture = harness('<body><h2>项目经历</h2>' + [0,1].map(i =>
  `<div class="project-record" data-record="${i}">` +
  phoenixField('项目名称','<input>') + phoenixField('职务','<input>') +
  phoenixField('项目描述','<textarea></textarea>') + '</div>').join('') + '</body>',
  'https://cloud.italent.cn/form');
let visibleRecord = 1;
projectFixture.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const record=this.closest('.project-record')?.dataset.record;
  const top=record !== undefined && Number(record)!==visibleRecord ? 2000 : 10;
  return {top,left:10,right:210,bottom:top+30,width:200,height:30,x:10,y:top};
};
const projectBefore=(await projectFixture.request({type:'SNAPSHOT_REQUEST'})).elements;
assert.deepEqual(Array.from(projectBefore.filter(el=>el.label==='项目描述')
  .sort((a,b)=>a.domOrder-b.domOrder), el=>el.recordIndex),[0,1]);
visibleRecord=0;
const projectAfter=(await projectFixture.request({type:'SNAPSHOT_REQUEST'})).elements;
for (const field of projectBefore.filter(el=>['项目名称','职务','项目描述'].includes(el.label))) {
  assert.equal(projectAfter.find(el=>el.recordIndex===field.recordIndex && el.label===field.label)?.stableKey,
    field.stableKey,'Scrolling preserves the same record and field identity');
}
console.log('Modern control-family regressions passed.');
