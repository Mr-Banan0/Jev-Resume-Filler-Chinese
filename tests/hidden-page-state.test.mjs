import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {classifyPageState} from '../lib/page-state.js';

const dom = new JSDOM(`<body><h6>教育经历</h6><input placeholder="姓名">
<div class="el-form-item is-required"><label>意向调剂城市</label><div><div><input readonly placeholder="请选择你意向调剂的城市"></div></div></div>
<div id="notice" style="display:none"><div><span>当前模块还未保存</span><button>保存并跳转</button></div></div></body>`,
  {runScripts:'outside-only',pretendToBeVisual:true,url:'https://xiaoyuan.zhaopin.com/scrd/resume2'});
const w=dom.window;
w.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,right:100,bottom:30,width:100,height:30});
const listeners=[];
w.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_m,cb)=>cb?.()}};
for(const path of ['content/widget-drivers.js','content/content.js']) w.eval(readFileSync(new URL('../'+path,import.meta.url),'utf8'));
const snapshot=()=>new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
let snap=await snapshot();
assert.equal(snap.elements.find(el=>el.placeholder==='请选择你意向调剂的城市')?.required,true);
assert.ok(!snap.page.text.includes('未保存'));
assert.notEqual(classifyPageState(snap.page,snap.elements).kind,'unsaved-confirmation');
w.document.querySelector('#notice').style.display='block';
snap=await snapshot();
assert.equal(classifyPageState(snap.page,snap.elements).kind,'unsaved-confirmation');
w.document.querySelector('#notice').style.opacity='0';
snap=await snapshot();
assert.ok(!snap.page.text.includes('未保存'));
console.log('Hidden dialog ancestors excluded; visible unsaved confirmation still blocks');
w.document.body.innerHTML='<h6>实习/工作经历</h6><div class="apply-form-date-now"><div class="apply-form-date-now__ipt"><input readonly placeholder="离职时间"></div><div class="el-date-editor"><input readonly placeholder="离职时间"></div></div>';
snap=await snapshot();
assert.equal(snap.elements.filter(el=>el.placeholder==='离职时间').length,1,'日期展示代理和日历输入合并为一个字段');
w.document.body.className='el-popup-parent--hidden';
w.document.body.innerHTML='<div>填写简历</div><div class="el-dialog"><button aria-label="Close"></button><div class="v-skill__container-main-item" style="cursor:pointer">开发编程类<i class="icon-ic_youcejiantou"></i></div><div class="v-skill__container-right-item" style="cursor:pointer">Python</div></div>';
snap=await snapshot();
assert.ok(!snap.elements.some(el=>el.label==='填写简历' && el.context==='popup'));
assert.ok(snap.elements.some(el=>el.label==='开发编程类' && el.pickerBranch));
assert.ok(snap.elements.some(el=>el.label==='Python' && el.context==='popup'));
w.document.body.innerHTML='<div class="el-dialog"><div><div class="nav-item" style="cursor:pointer">IT技能<i class="icon-ic_youcejiantou"></i></div><div class="nav-item" style="cursor:pointer">其他技能</div></div><div><div class="skill-item" style="cursor:pointer">Python</div></div></div>';
snap=await snapshot();
assert.ok(snap.elements.some(el=>el.label==='其他技能' && el.pickerBranch),'同列分类入口共享展开语义');
assert.ok(snap.elements.some(el=>el.label==='Python' && !el.pickerBranch),'技能叶子保持选择语义');
