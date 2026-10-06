import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildDataBlockPlan, countRenderedRecords, classifyRecordAddition } from '../lib/jev-client.js';

const field=(title,body='<input placeholder="请输入">')=>`<div class="form-item form-item--phoenix"><div class="form-item__title">${title}</div><div class="form-item__control">${body}</div></div>`;
const record=fields=>`<div class="record-theme"><div class="ux-standard-form"><div class="form"><div class="form-part"><div class="form-part-body">${fields}</div></div></div></div></div>`;
const module=(title,fields)=>`<section class="theme-module"><div class="anonymous-heading"><span>${title}</span><p>请按照简历模板认真详细填写您的应聘信息</p></div><div class="theme-records">${fields}<div style="cursor:pointer"><span>添加${title}</span></div></div></section>`;
const degree=()=>field('学历','<div class="phoenix-select"><input readonly></div>')+field('学校名称')+field('开始时间')+field('结束时间');
const dom=new JSDOM(`<body>
${module('个人信息',record(field('姓名')+field('个人照片','<input type="file">')))}
${Array.from({length:35},()=>'<div class="phoenix-select"><span style="cursor:pointer">请选择</span></div>').join('')}
${module('教育经历',record(degree())+record(degree()))}
${module('获奖情况',record(field('获奖描述','<textarea placeholder="请输入"></textarea>')+field('获奖时间')))}
${module('论文/专著',record(field('名称')+field('发布时间')+field('所属期刊')))}
${module('课题项目经验',record(field('项目名称')+field('职务')+field('开始时间')+field('项目描述','<textarea placeholder="请输入"></textarea>')))}
${module('在校实践',record(field('开始时间')+field('结束时间')+field('实践名称')+field('实践描述','<textarea></textarea>')))}
${module('技能',record(field('技能名称')+field('掌握程度')))}
</body>`,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://sample.zhiye.com/form'});
const {window}=dom;
window.HTMLElement.prototype.getBoundingClientRect=()=>({top:10,left:10,right:210,bottom:40,width:200,height:30});
const listeners=[];
window.chrome={runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:(_m,cb)=>cb?.(),lastError:null}};
for(const file of ['widget-drivers','platform-drivers','content']) window.eval(readFileSync(new URL(`../content/${file}.js`,import.meta.url),'utf8'));
const snapshot=()=>new Promise(resolve=>listeners[0]({type:'SNAPSHOT_REQUEST'},{},resolve));
const before=await snapshot();
const fields=before.elements.filter(el=>el.context!=='popup' && !['card','action'].includes(el.kind));
assert.deepEqual(Array.from(fields.filter(el=>el.label==='学历'),el=>el.recordIndex),[0,1]);
for(const [label,section] of [['名称','论文/专著'],['项目名称','课题项目经验'],['实践名称','在校实践'],['技能名称','技能'],['个人照片','个人信息']]) {
  assert.equal(fields.find(el=>el.label===label)?.section,section,`${label} retains its observed module`);
}
assert.equal(fields.find(el=>el.label==='项目描述')?.kind,'textarea');
assert.equal(before.elements.find(el=>el.label==='添加论文/专著')?.section,'论文/专著');
assert.equal(before.elements.find(el=>el.label==='添加课题项目经验')?.section,'课题项目经验');
for(const section of ['论文/专著','课题项目经验','在校实践','技能']) {
  assert.ok(before.elements.some(el=>el.label===`添加${section}` && el.section===section),
    `${section} keeps its add entry when many select displays precede it`);
}
assert.ok(!before.elements.some(el=>el.section?.startsWith('请按照')),'module instructions remain context rather than section boundaries');
assert.equal(countRenderedRecords('获奖情况',fields.filter(el=>el.section==='获奖情况')),1);
const awardModule=[...window.document.querySelectorAll('section')].find(el=>el.textContent.startsWith('获奖情况'));
awardModule.querySelector('.theme-records').insertAdjacentHTML('afterbegin',record(field('获奖描述','<textarea></textarea>')+field('获奖时间')));
const after=await snapshot();
assert.equal(classifyRecordAddition({section:'获奖情况',dataBlock:'awards',before,after}).mode,'inline');
assert.deepEqual(Array.from(after.elements.filter(el=>el.section==='获奖情况' && el.label==='获奖描述'),el=>el.recordIndex),[0,1]);
const route=buildDataBlockPlan('个人信息',[
  {index:'contact',section:'个人信息',label:'紧急联系电话',kind:'input',operations:['TYPE_TEXT'],value:''}
],{basics:{phone:'10000000000'},application:{emergencyContactPhone:'10000000001'}},['basics']);
assert.ok(route.actions.some(a=>a.dataBlock==='application'));
console.log('beisen themed form tests passed');
