import assert from 'node:assert/strict';
import { classifyPageState } from '../lib/page-state.js';

assert.equal(classifyPageState({url:'https://wecruit.hotjob.cn/resumeOperation.html',
  text:'您尚未登录或登录时间过长，请重新登录!'}, [{operations:['TYPE_TEXT']}]).kind, 'auth-required');
assert.equal(classifyPageState({url:'https://wecruit.hotjob.cn/resumeOperation.html',
  text:'已截断的表单正文',authRequired:true}, [{operations:['TYPE_TEXT']}]).kind, 'auth-required');
assert.equal(classifyPageState({url:'https://wecruit.hotjob.cn/resumeOperation.html',
  text:'您尚未登录或登录时间过长，请重新登录!'}, [
  {operations:['TYPE_TEXT'],value:'示例姓名'},
  {operations:['TYPE_TEXT'],value:'sample@example.com'}]).kind, 'form');
assert.equal(classifyPageState({url:'https://wecruit.hotjob.cn/posDetail',
  text:'立即投递'}, [{operations:['CLICK']}]).kind, 'job-detail');
assert.equal(classifyPageState({url:'https://dongguanbank1.zhiye.com/form',
  text:'姓名'}, [{operations:['TYPE_TEXT']}]).kind, 'form');
assert.equal(classifyPageState({url:'https://xiaoyuan.zhaopin.com/scrd/resume2',
  text:'当前模块还未保存，是否要保存当前模块信息？ 保存并跳转'}, []).kind, 'unsaved-confirmation');
console.log('page-state tests passed');
