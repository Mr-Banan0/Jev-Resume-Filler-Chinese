import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><select id="degree"><option>本科</option><option selected>硕士</option></select>', {
  runScripts: 'outside-only', url: 'https://app-tc.mokahr.com/apply'
});
const { window } = dom;
window.eval(readFileSync(new URL('../content/widget-drivers.js', import.meta.url), 'utf8'));
const drivers = window.JevWidgetDrivers;

assert.equal(drivers.classify({ kind: 'custom-select' }), 'virtual-select');
assert.deepEqual(Array.from(drivers.operations({ family: 'virtual-select', role: 'textbox', readonly: false, tagName: 'input', editable: false })), ['CLICK']);
assert.equal(drivers.readValue(window.document.querySelector('#degree'), {
  family: 'native-select', hostname: window.location.hostname, tidy: value => value.trim(),
  editableText: el => el.textContent, isEditable: () => false
}), '硕士');
const dateWrapper = window.document.createElement('div');
dateWrapper.innerHTML = '<span>2026</span><div class="select"><input placeholder="年"></div>';
window.document.body.append(dateWrapper);
const readDate = el => drivers.readValue(el, {
  family:'virtual-select', hostname:window.location.hostname, label:'开始年份',
  tidy:value => value.trim(), editableText:el => el.textContent, isEditable:() => false
});
assert.equal(readDate(dateWrapper.querySelector('input')), '2026');
const compound = window.document.createElement('div');
compound.innerHTML='<div><span>2024</span><input placeholder="年"><span></span></div><div><input placeholder="月"><span></span></div>';
window.document.body.append(compound);
assert.equal(readDate(compound.querySelector('[placeholder=月]')), '', '空月份的箭头或相邻年份不构成已填写值');
assert.equal(readDate(compound.querySelector('[placeholder=年]')), '2024');
compound.querySelector('[placeholder=月]').insertAdjacentHTML('beforebegin','<span>8</span>');
assert.equal(readDate(compound.querySelector('[placeholder=月]')), '8');
assert.equal(readDate(dateWrapper.querySelector('.select')), '2026');
dateWrapper.querySelector('input').removeAttribute('placeholder');
assert.equal(readDate(dateWrapper.querySelector('input')), '2026');
dateWrapper.querySelector('span').textContent = '2026 ';
assert.equal(readDate(dateWrapper.querySelector('input')), '2026');
const entry = { section: '教育背景', widgetFamily: 'autocomplete', role: 'textbox', label: '专业' };
assert.notEqual(drivers.stableKey(entry, 1), drivers.stableKey(entry, 2));
assert.equal(drivers.stableKey(entry, 1), drivers.stableKey({ ...entry, index: '99' }, 1));
for(const prefix of ['rc-select','ant-select','atsx-select','renamed-select']) {
  const wrap=window.document.createElement('div');
  wrap.className='has-success';
  wrap.innerHTML=`<div class="${prefix} ${prefix}-combobox"><div role="combobox" class="${prefix}-selection ${prefix}-selection--single"><input class="${prefix}-search__field" value="合成自定义学校"></div></div>`;
  const host=wrap.querySelector('[role=combobox]');
  assert.equal(drivers.freeformCommit(host)?.value,'合成自定义学校','显式自由输入模式与成功校验共同提供值证据');
  wrap.querySelector(`.${prefix}`).classList.remove(`${prefix}-combobox`);
  assert.equal(drivers.freeformCommit(host),null,'标准搜索选择器继续要求实际选项');
  wrap.querySelector(`.${prefix}`).classList.add(`${prefix}-combobox`);wrap.className='has-error';
  assert.equal(drivers.freeformCommit(host),null,'失败校验保留未提交状态');
  wrap.className='';assert.equal(drivers.freeformCommit(host),null,'缺少验收证据时保留搜索身份');
}
const tree=window.document.createElement('div');
tree.innerHTML='<div role="row"><span role="button" aria-haspopup="tree"><svg aria-label="caret-down"></svg></span><span class="label">合成父级</span></div>';
assert.equal(drivers.branchTarget(tree.querySelector('.label')),tree.querySelector('[role=button]'));
for(const prefix of ['rc-tree','atsx-select-tree','renamed-tree']) {
  tree.innerHTML=`<li role="treeitem"><span class="${prefix}-switcher ${prefix}-switcher_close"><i class="${prefix}-switcher-icon"><svg aria-label="caret-down"></svg></i></span><span class="label">合成父级</span><ul role="group"><li role="treeitem"><span class="${prefix}-switcher ${prefix}-switcher-noop"><i class="${prefix}-switcher-icon"><svg aria-label="caret-down"></svg></i></span><span class="label ${prefix}-title">合成城市</span></li></ul></li>`;
  const labels=tree.querySelectorAll('.label');
  assert.equal(drivers.branchInfo(labels[0]).branch,true,'组件分支契约支持更换前缀');
  assert.equal(drivers.branchTarget(labels[0]),tree.querySelector('span'),'点击真实开关容器');
  assert.equal(drivers.branchInfo(labels[1]).branch,false,'叶节点装饰箭头保持可选择文字');
  assert.equal(drivers.branchTarget(labels[1]),null);
  assert.equal(drivers.optionTarget(labels[1]),labels[1],'嵌套装饰图标的叶节点命中标题');
  tree.querySelector('span').remove();
  assert.equal(drivers.branchInfo(labels[0]).branch,false,'父级候选的证据限于自身一行');
}
tree.innerHTML='<div role="row" aria-expanded="false"><span class="label">合成分支</span></div>';
assert.equal(drivers.branchInfo(tree.querySelector('.label')).branch,true,'可访问展开状态提供独立分支证据');
for(const prefix of ['rc-tree','atsx-tree','renamed-tree']) {
  tree.innerHTML=`<li role="treeitem" class="${prefix}-treenode-switcher-open"><span class="${prefix}-switcher ${prefix}-switcher_open"><i><svg aria-label="caret-down"></svg></i></span><span class="${prefix}-node-content-wrapper ${prefix}-node-content-wrapper-open"><span class="${prefix}-title">合成城市</span></span><ul role="group"><li role="treeitem"><span class="${prefix}-title">合成区县</span></li></ul></li>`;
  const label=tree.querySelector(`.${prefix}-title`),slot=label.parentElement,switcher=tree.querySelector(`.${prefix}-switcher`);
  let expanded=0,selected=0;
  switcher.addEventListener('click',()=>expanded++);slot.addEventListener('click',()=>selected++);
  assert.equal(drivers.branchInfo(label).branch,true,'城市存在下级时保留可展开身份');
  assert.equal(drivers.optionTarget(label,'select'),slot,'可选择的父节点命中自己的值槽');
  assert.equal(drivers.optionTarget(label,'expand'),switcher,'展开同一节点命中自己的开关');
  drivers.optionTarget(label,'select').click();
  assert.equal(selected,1);assert.equal(expanded,0);
  drivers.optionTarget(label,'expand').click();
  assert.equal(selected,1);assert.equal(expanded,1);
}
console.log('widget-drivers tests passed');
