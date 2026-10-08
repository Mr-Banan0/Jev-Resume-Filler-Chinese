import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<form><h2>教育经历</h2><label for="date">结束时间</label><input id="date" readonly aria-haspopup="dialog" aria-controls="calendar">'+
  '<button id="add">补充一段经历</button><div id="calendar" role="listbox"><button role="option">2026</button></div>'+
  Array.from({length:400},(_,i)=>`<input aria-label="扩展字段 ${i}">`).join('')+'</form>',
  {runScripts:'outside-only',pretendToBeVisual:true,url:'https://unseen.example.test/resume'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=()=>({left:10,top:10,right:110,bottom:40,width:100,height:30});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_msg,cb)=>cb?.()}};
for(const path of ['widget-drivers.js','platform-drivers.js','content.js']) {
  window.eval(readFileSync(new URL(`../content/${path}`,import.meta.url),'utf8'));
}
const snapshot=await new Promise(resolve=>listeners[0]({type:'SNAPSHOT_FULL'},{},resolve));
const date=snapshot.elements.find(control=>control.label==='结束时间');
assert.equal(date.observed.readonly,true);
assert.equal(date.observed.controls,'calendar');
assert.ok(date.observed.capabilities.includes('CLICK'));
assert.ok(!date.observed.capabilities.includes('TYPE_TEXT'));
assert.ok(snapshot.elements.some(control=>control.label==='补充一段经历'));
assert.equal(snapshot.observationCoverage.complete,false);
assert.ok(Object.values(snapshot.observationCoverage.omittedBySection).reduce((a,b)=>a+b,0)>0);
assert.ok(snapshot.elements.every(control=>control.observed && control.stableKey));
dom.window.close();
console.log('Observed DOM: readonly capability, ARIA relationship, unfamiliar button and truncation evidence passed');
