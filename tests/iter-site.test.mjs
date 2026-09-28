import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {buildActionPlan,prepareResume} from '../lib/jev-client.js';

const dom=new JSDOM(`<body>
  <nav><a href="javascript:;">个人信息</a><a href="javascript:;">求职意向</a><a href="javascript:;">教育经历</a></nav>
  <div id="basic" class="resumeContent">个人信息 <button class="resume-btn">编辑</button></div>
  <div id="expected" class="resumeContent" style="display:none">求职意向 <button class="resume-btn">编辑</button></div>
  <div id="edu" class="resumeContent" style="display:none">教育经历 <button class="resume-btn">添加</button></div>
  <div class="layui-layer-btn" style="display:none"><a>确定</a><a>取消</a></div>
  <div class="mForm mFormRadio"><input type="hidden" name="sex"><ul><li>男</li><li>女</li></ul></div>
  <div class="mFormSelect"><input placeholder="民族" readonly><ul style="display:none"><li>汉族</li><li>满族</li></ul></div>
  <div class="mFormCity"><input type="hidden" name="nowResidence"><input type="text" placeholder="现居地址" readonly><ul style="display:none"><li>广东</li><li>深圳市</li></ul></div>
  <div class="mFormSelect"><input type="hidden" name="recSources"><input type="text" placeholder="招聘信息来源" readonly><ul style="display:none"><li>企业校招官网/微信公众号</li></ul></div>
</body>`,{url:'https://iter.stongyw.cn/web/school/resume/index.html',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, doc=w.document;
w.HTMLElement.prototype.getBoundingClientRect=function(){
  return {top:0,left:0,right:200,bottom:30,width:200,height:30};
};
const cards=['basic','expected','edu'];
let active=0;
doc.querySelectorAll('nav a').forEach((link,index)=>link.addEventListener('click',()=>{
  cards.forEach((id,i)=>doc.getElementById(id).style.display=i===index?'block':'none');
  active=index;
}));
doc.querySelectorAll('.resume-btn').forEach(button=>button.addEventListener('click',()=>{
  const frame=doc.createElement('iframe');frame.src='/web/school/resume/base_info.html';doc.body.append(frame);
  doc.querySelector('.layui-layer-btn').style.display='block';
}));
doc.querySelector('.layui-layer-btn a:last-child').addEventListener('click',()=>{
  doc.querySelector('iframe')?.remove();doc.querySelector('.layui-layer-btn').style.display='none';
});
doc.querySelector('.mFormSelect input').addEventListener('click',()=>{
  doc.querySelector('.mFormSelect ul').style.display='block';
});
let handler;
w.chrome={runtime:{onMessage:{addListener:fn=>handler=fn},sendMessage:()=>{}}};
w.eval(readFileSync(new URL('../content/content.js',import.meta.url),'utf8'));
const send=msg=>new Promise(resolve=>handler(msg,{},resolve));
let state=(await send({type:'ITER_STATE'})).state;
assert.equal(state.current,'个人信息');
assert.deepEqual(Array.from(state.sections),['个人信息','求职意向','教育经历']);
assert.equal(state.editorCount,1);
assert.equal((await send({type:'ITER_NAVIGATE',section:'求职意向'})).ok,true);
state=(await send({type:'ITER_STATE'})).state;
assert.equal(state.current,'求职意向');
assert.equal(active,1);
assert.equal((await send({type:'ITER_OPEN_EDITOR'})).ok,true);
assert.equal((await send({type:'ITER_STATE'})).state.editorOpen,true);
assert.equal((await send({type:'ITER_DIALOG_BUTTON',label:'取消'})).ok,true);
assert.equal((await send({type:'ITER_STATE'})).state.editorOpen,false);
assert.equal((await send({type:'ITER_NAVIGATE',section:'教育经历'})).ok,true);
assert.equal((await send({type:'ITER_STATE'})).state.current,'教育经历');
let snapshot=await send({type:'SNAPSHOT_FULL'});
const ethnicity=snapshot.elements.find(el=>el.label==='民族');
assert.equal(ethnicity.kind,'custom-select');
const male=snapshot.elements.find(el=>el.label==='性别 · 男');
assert.equal(male.kind,'custom-radio');
assert.ok(buildActionPlan(snapshot.elements,{basics:{gender:'男'}},[],{title:'个人信息'}).actions.some(action=>action.target===male.index));
doc.querySelector('.mFormRadio li').classList.add('cur');
snapshot=await send({type:'SNAPSHOT_FULL'});
assert.ok(!buildActionPlan(snapshot.elements,{basics:{gender:'男'}},[],{title:'个人信息'}).actions.some(action=>action.resumeField==='basics.gender'));
assert.ok(buildActionPlan(snapshot.elements,{basics:{location:{city:'深圳市',region:{province:'广东省',city:'深圳市'}}}},[],{title:'个人信息'}).actions.some(action=>action.resumeField==='basics.location.city'));
assert.ok(buildActionPlan(snapshot.elements,{basics:{}},[],{title:'个人信息'}).actions.some(action=>action.formRule==='iter-recruitment-source'));
assert.ok(buildActionPlan([{index:'1',role:'textbox',kind:'custom-select',label:'工作性质',value:'',operations:['CLICK']}],
  {internship:[{company:'测试公司'}]},[],{title:'社会实习经历',recordIndex:0}).actions.some(action=>action.formRule==='iter-internship-work-type'));
assert.ok(buildActionPlan([{index:'1',role:'option',kind:'option',label:'实习',value:'',context:'popup',operations:['CLICK']}],
  {internship:[{company:'测试公司'}]},[{kind:'click',formRule:'iter-internship-work-type'}],
  {title:'社会实习经历',recordIndex:0}).actions.some(action=>action.formRule==='iter-internship-work-type'));
assert.ok(buildActionPlan([{index:'1',role:'textbox',kind:'input',label:'项目职责',value:'',operations:['TYPE_TEXT']}],
  {projects:[{description:'完成项目设计与开发'}]},[],{title:'项目经验',recordIndex:0})
  .actions.some(action=>action.resumeField==='projects[0].description'));
const campusResume={campusPractice:[
  {position:'班长',startDate:'2022-09-01',endDate:'2025-06-01',summary:'示例大学班长'},
  {position:'志愿者',startDate:'2021-09-01',endDate:'2025-06-30',summary:'志愿服务超过200小时'}
]};
const campusControls=[
  {index:'1',kind:'input',label:'职位名称',value:'',operations:['TYPE_TEXT']},
  {index:'2',kind:'layui-date',label:'开始时间',value:'',operations:['PICK_DATE']},
  {index:'3',kind:'layui-date',label:'结束时间',value:'',operations:['PICK_DATE']},
  {index:'4',kind:'textarea',label:'工作职责',value:'',operations:['TYPE_TEXT']}
];
const campusPlan=buildActionPlan(campusControls,campusResume,[],{title:'校内实践经历',recordIndex:1});
assert.ok(campusPlan.actions.some(action=>action.resumeField==='campusPractice[1].position'));
assert.ok(campusPlan.actions.some(action=>action.resumeField==='campusPractice[1].startDate'));
assert.ok(campusPlan.actions.some(action=>action.resumeField==='campusPractice[1].endDate'));
assert.ok(campusPlan.actions.some(action=>action.resumeField==='campusPractice[1].summary'));
assert.doesNotThrow(()=>buildActionPlan(snapshot.elements,{basics:{}},[{kind:'click',formRule:'iter-recruitment-source',context:null}],{title:'个人信息'}));
assert.ok(!buildActionPlan([{index:'1',role:'textbox',kind:'custom-select',label:'婚姻状况',name:'marriage',value:'',operations:['CLICK']}],
  {basics:{birthDate:'2003-02-10'}},[],{title:'个人信息'}).actions.some(action=>action.resumeField==='basics.age'));
assert.ok(buildActionPlan([{index:'1',role:'textbox',kind:'custom-select',label:'排名',value:'',operations:['CLICK']}],
  {education:[{ranking:'TOP50%'}]},[],{title:'教育经历',recordIndex:0}).actions.some(action=>action.resumeField==='education[0].ranking'));
assert.ok(buildActionPlan([{index:'1',role:'option',kind:'option',label:'前50%',value:'',context:'popup',operations:['CLICK']}],
  {education:[{ranking:'TOP50%'}]},[{resumeField:'education[0].ranking',kind:'click'}],
  {title:'教育经历',recordIndex:0}).actions.some(action=>action.resumeField==='education[0].ranking' && action.target==='1'));
assert.ok(!buildActionPlan([{index:'1',role:'textbox',kind:'custom-select',label:'排名',value:'前50%',operations:['CLICK']}],
  {education:[{ranking:'TOP50%'}]},[],{title:'教育经历',recordIndex:0}).actions.some(action=>action.resumeField==='education[0].ranking'));
assert.ok(buildActionPlan(snapshot.elements,{basics:{ethnicity:'汉族'}},[],{title:'个人信息'}).actions.some(action=>action.resumeField==='basics.ethnicity'));
doc.querySelector('.mFormSelect input').value='汉族';
snapshot=await send({type:'SNAPSHOT_FULL'});
assert.equal(snapshot.elements.find(el=>el.label==='民族').value,'汉族');
assert.ok(!buildActionPlan(snapshot.elements,{basics:{ethnicity:'汉族'}},[],{title:'个人信息'}).actions.some(action=>action.resumeField==='basics.ethnicity'));
assert.equal((await send({type:'EXECUTE',action:'click',index:ethnicity.index})).ok,true);
snapshot=await send({type:'SNAPSHOT_FULL'});
assert.ok(snapshot.elements.some(el=>el.label==='汉族'&&el.context==='popup'));
const awardsLink=doc.createElement('a');awardsLink.href='javascript:;';awardsLink.textContent='奖励';doc.querySelector('nav').append(awardsLink);
const awardsCard=doc.createElement('div');awardsCard.className='resumeContent';awardsCard.textContent='奖学金 其他奖项';doc.body.append(awardsCard);
cards.forEach(id=>doc.getElementById(id).style.display='none');
assert.equal((await send({type:'ITER_NAVIGATE',section:'奖励'})).ok,true);
assert.equal((await send({type:'ITER_STATE'})).state.current,'奖励');
awardsCard.textContent='教育经历 '.repeat(20)+'示例大学 时间：2025-09-01 至 2026-11-30';
assert.ok((await send({type:'ITER_STATE'})).state.overviewText.includes('2026-11-30'));
const english=prepareResume({languages:[{language:'英语',fluency:'CET-6、雅思 6.5(6)'}]});
assert.deepEqual(english.englishLevels,[{level:'雅思IELTS',score:'6.5'}]);
assert.ok(buildActionPlan([{index:'1',kind:'custom-select',label:'英语等级',value:'',operations:['CLICK']}],
  english,[],{title:'英语等级',recordIndex:0}).actions.some(action=>action.resumeField==='englishLevels[0].level'));
assert.ok(buildActionPlan([{index:'2',kind:'input',label:'成绩',value:'',operations:['TYPE_TEXT']}],
  english,[],{title:'英语等级',recordIndex:0}).actions.some(action=>action.resumeField==='englishLevels[0].score'));
assert.ok(!buildActionPlan([{index:'3',kind:'textarea',label:'自我评价',value:'原文',operations:['TYPE_TEXT']}],
  {basics:{summary:'原文〔回归测试〕'}},[],{title:'自我评价'}).actions.some(action=>action.resumeField==='basics.summary'));
console.log('✓ 从基本页切分区、开关编辑弹窗、只读下拉选项识别');
