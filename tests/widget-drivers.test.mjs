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
console.log('widget-drivers tests passed');
