import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="resume-row"><strong>获奖经历</strong><button>新增获奖经历</button></div>
  <div class="resume-row"><strong>发明专利</strong><button>新增发明专利</button></div>
  <div class="resume-row"><strong>论文</strong><button>新增论文</button></div>
</body></html>`, {runScripts:'outside-only', pretendToBeVisual:true, url:'https://careers.example.com/resume'});
const {window} = dom;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({top:10,left:10,right:210,bottom:40,width:200,height:30,x:10,y:10});
const listeners = [];
window.chrome = {runtime:{onMessage:{addListener:listener => listeners.push(listener)},sendMessage:(_message, callback) => callback?.(),lastError:null}};
for (const path of ['content/widget-drivers.js','content/platform-drivers.js','content/content.js']) {
  window.eval(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
}
const page = await new Promise(resolve => listeners[0]({type:'SNAPSHOT_REQUEST'}, {}, resolve));
const sectionFor = label => page.elements.find(item => item.label === label)?.section;
assert.equal(sectionFor('新增获奖经历'), '获奖经历');
assert.equal(sectionFor('新增发明专利'), '发明专利');
assert.equal(sectionFor('新增论文'), '论文');
console.log('repeater add buttons retain their semantic section titles');
