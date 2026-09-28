import assert from 'node:assert/strict';
import {buildActionPlan,buildQuestions} from '../lib/jev-client.js';
const options=['英文','日语','德语'].map((label,i)=>({index:String(i),label,context:'popup',
  kind:'option-item',operations:['CLICK']}));
const plan=buildActionPlan(options,{languages:[{language:'英语'}]},[
  {kind:'click',resumeField:'languages[0].language',controlStableKey:'language'}]);
assert.ok(plan.actions.some(a=>a.semanticFallback && a.label==='英文'));
assert.ok(plan.actions.some(a=>a.intent==='RETURN'));
const question=buildQuestions('fill',plan);
assert.ok(Object.values(question.action.criteria).some(c=>c.source_meaning==='英语' && c.option_label==='英文'));
const empty=buildActionPlan(options,{basics:{idNumber:'PRIVATE-TEST-ID'}},[
  {kind:'click',resumeField:'basics.idNumber'}]);
assert.ok(!JSON.stringify(buildQuestions('fill',empty)).includes('PRIVATE-TEST-ID'));
console.log('semantic option and privacy tests passed');
const major=buildActionPlan([{index:'s',label:'请输入专业名称',kind:'input',context:'popup',
  operations:['TYPE_TEXT'],value:''}],{education:[{area:'示例交叉学科专业（城市数据方向）'}]},[
  {kind:'click',resumeField:'education[0].area'}]);
assert.equal(major.actions.find(a=>a.operation==='TYPE_TEXT')?.resolvedValue,'计算机科学与技术');
