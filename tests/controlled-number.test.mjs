import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageExecutor} from '../background/page-executor.js';

for (const [type,inputMode,source,actual,expected] of [
  ['number','','65','65.0',true],
  ['text','decimal','65','65.0',true],
  ['number','','65','66.0',false],
  ['text','','001','1',false],
  ['text','numeric','001','1',false]
]) {
  const {window:w}=new JSDOM(`<input type="${type}" inputmode="${inputMode}">`,{runScripts:'outside-only'});
  w.CSS={escape:value=>value};
  const input=w.document.querySelector('input');
  input.addEventListener('focusout',()=>input.value=actual);
  globalThis.chrome={scripting:{executeScript:async spec=>[
    {result:await w.eval(`(${spec.func.toString()})`)(...spec.args)}
  ]}};
  const executor=createPageExecutor({sleep:async()=>{},sendToFrame:async()=>{
    input.setAttribute('data-jev-fill-target','number-test');
    return {ok:true,token:'number-test'};
  }});
  const result=await executor.executeField({tabId:1,frameId:0,local:'1',
    decision:{operation:'TYPE_TEXT',resumeField:'basics.weightKg'},
    targetEntry:{kind:'input',textCommitMode:'page-world'},page:{},execMsg:{value:source}});
  assert.equal(result.verified,expected,`${type}/${inputMode}: ${source} → ${actual}`);
  assert.equal(input.hasAttribute('data-jev-fill-target'),false);
  w.close();
}
{
  const {window:w}=new JSDOM('<div><textarea></textarea></div>',{runScripts:'outside-only'});
  w.CSS={escape:value=>value};
  const input=w.document.querySelector('textarea');
  let saved='',callbacks=0,ancestorCalls=0;
  input.__reactProps$test={value:'',onChange:event=>{saved=event.target.value;callbacks++;}};
  input.parentElement.__reactProps$outer={onChange:()=>ancestorCalls++};
  globalThis.chrome={scripting:{executeScript:async spec=>[
    {result:await w.eval(`(${spec.func.toString()})`)(...spec.args)}
  ]}};
  const executor=createPageExecutor({sleep:async()=>{},sendToFrame:async()=>{
    input.setAttribute('data-jev-fill-target','textarea-test');return {ok:true,token:'textarea-test'};
  }});
  const args={tabId:1,frameId:0,local:'1',decision:{operation:'TYPE_TEXT',resumeField:'projects[0].outcomes'},
    targetEntry:{kind:'textarea',textCommitMode:'page-world'},page:{},execMsg:{value:'明确成果\n原文证据'}};
  assert.equal((await executor.executeField(args)).verified,true);
  input.value=saved;
  assert.equal(saved,args.execMsg.value,'刷新表单使用组件提交的值');
  assert.equal(callbacks,1);
  assert.equal(ancestorCalls,0,'直接输入控件的事件回调保持与父层业务回调隔离');
  input.__reactProps$test.value=saved;
  await executor.executeField(args);
  assert.equal(callbacks,1,'原生事件已提交的相同值保持单次提交');
  w.close();
}
delete globalThis.chrome;
console.log('✓ 受控数字、文本标识精确匹配及多行文本组件提交通过');
