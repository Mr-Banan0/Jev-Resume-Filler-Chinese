import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const dom=new JSDOM(`<!doctype html><body>
  <div class="set-wrap"><span class="txt-title">语言能力</span></div>
  <div class="resumer-item-list-item">英语　熟练</div>
  <div class="set-wrap"><span class="txt-title">教育经历</span></div>
  <div class="resumer-item-list-item" id="school-a">示例大学 A　示例院系</div>
  <div class="resumer-item-list-item" id="school-b">示例大学 B　示例学院</div>
</body>`,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://career.honor.com/mc/deliver/resumerDetail'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=function(){
  return {top:10,left:10,right:110,bottom:40,width:100,height:30,x:10,y:10};
};
window.HTMLElement.prototype.scrollIntoView=function(){};
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_message,reply)=>reply?.(),lastError:null}};
window.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const send=message=>new Promise(resolve=>listeners[0](message,{},resolve));
const count=await send({type:'MATCH_RECORD',section:'教育经历',identities:['示例大学 A'],click:false});
assert.deepEqual(JSON.parse(JSON.stringify(count)),{ok:true,found:true,count:1,clicked:false});
assert.equal(JSON.stringify(count).includes('示例大学 A'),false,'匹配接口只返回状态，不导出行正文');
let clicked=false;
window.document.getElementById('school-a').addEventListener('click',()=>clicked=true);
assert.equal((await send({type:'MATCH_RECORD',section:'教育经历',identities:['示例大学 A'],click:true})).clicked,true);
assert.equal(clicked,true);
assert.equal((await send({type:'MATCH_RECORD',section:'语言能力',identities:['示例大学 A'],click:false})).found,false);
assert.equal((await send({type:'MATCH_RECORD',section:'教育经历',identities:['大学'],click:false})).count,2);
console.log('✓ 荣耀总览记录按分区本地定位，歧义停止，正文不出页面');
