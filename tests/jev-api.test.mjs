import assert from 'node:assert/strict';
import {jevProvider,requestJev,testJevConnection} from '../lib/jev-api.js';
import {choose} from '../lib/jev-client.js';

const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout};
const calls=[];
const valid={model:'jev-1.13.0',answers:{connection:{type:'choice',choice:'software',confidence:1,
  probabilities:{software:1,accounting:0,none:0}}}};
globalThis.setTimeout=(fn,ms)=>ms<6000 ? (queueMicrotask(fn),0) : original.setTimeout(fn,ms);
globalThis.fetch=async(url,args)=>{
  calls.push({url,...args,body:JSON.parse(args.body)});
  return {ok:true,json:async()=>valid};
};
try {
  assert.equal(jevProvider('quickrouter').url,'https://api.quickrouter.ai/v1/systemone');
  assert.throws(()=>jevProvider('untrusted'),/有效/);
  await assert.rejects(requestJev({apiKey:'synthetic',apiProvider:'untrusted',body:{}}),/有效/);
  assert.equal(calls.length,0);
  await assert.rejects(requestJev({apiKey:'',apiProvider:'quickrouter',body:{}}),/API Key/);
  await testJevConnection({apiKey:'synthetic-quickrouter',apiProvider:'quickrouter'});
  assert.equal(calls[0].url,'https://api.quickrouter.ai/v1/systemone');
  assert.equal(calls[0].body.model,'jev-1.13.0');
  assert.equal(calls[0].redirect,'error','拒绝跨域重定向，保持密钥接收方明确');
  assert.equal(calls[0].headers.Authorization,'Bearer synthetic-quickrouter');
  assert.equal(JSON.stringify(calls[0].body).includes('synthetic-quickrouter'),false);
  assert.deepEqual(Object.keys(calls[0].body),['state','questions','model']);
  await requestJev({apiKey:'synthetic-official',apiProvider:'typesafe',body:{model:'other',state:'synthetic',questions:{}}});
  assert.equal(calls[1].url,'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[1].body.model,'jev-latest');

  for(const invalid of [
    {...valid,model:'other-model'},
    {...valid,answers:{}},
    {...valid,answers:{connection:{...valid.answers.connection,choice:'unknown'}}},
    {...valid,answers:{connection:{...valid.answers.connection,confidence:undefined}}},
    {...valid,answers:{connection:{...valid.answers.connection,probabilities:{software:1}}}},
    {...valid,answers:{connection:{...valid.answers.connection,probabilities:{software:0.9,accounting:0.9,none:0}}}}
  ]) {
    globalThis.fetch=async()=>({ok:true,json:async()=>invalid});
    await assert.rejects(testJevConnection({apiKey:'synthetic',apiProvider:'quickrouter'}),/契约验证/);
  }
  let errors=0;
  for(const status of [400,401,402,451]) {
    globalThis.fetch=async()=>{errors++;return {ok:false,status,text:async()=>JSON.stringify({error:'synthetic-secret'})};};
    await assert.rejects(requestJev({apiKey:'synthetic-secret',apiProvider:'quickrouter',body:{}}),
      error=>error.message.includes(`HTTP ${status}`) && !error.message.includes('synthetic-secret'));
  }
  assert.equal(errors,4,'鉴权、额度和政策拒绝均只请求一次，保持明确失败');
  globalThis.fetch=async()=>({ok:true,json:async()=>{throw Error('raw invalid response');}});
  await assert.rejects(requestJev({apiKey:'synthetic',apiProvider:'quickrouter',body:{}}),/有效 JSON/);

  let bodyReads=0;
  globalThis.setTimeout=(fn,ms)=>{
    if(ms<6000) queueMicrotask(fn);
    else queueMicrotask(()=>queueMicrotask(fn));
    return 0;
  };
  globalThis.fetch=async(_url,args)=>({ok:true,json:()=>{
    bodyReads++;
    return new Promise((_resolve,reject)=>{
      if(args.signal.aborted) reject(args.signal.reason);
      else args.signal.addEventListener('abort',()=>reject(args.signal.reason),{once:true});
    });
  }});
  await assert.rejects(requestJev({apiKey:'synthetic-body-timeout',apiProvider:'quickrouter',body:{}}),/暂不可用/);
  assert.equal(bodyReads,2,'响应头已到达时，正文读取仍保持同一等待预算');
  globalThis.setTimeout=(fn,ms)=>ms<6000 ? (queueMicrotask(fn),0) : original.setTimeout(fn,ms);

  let outages=0;
  globalThis.fetch=async()=>{outages++;throw Error('synthetic outage');};
  await assert.rejects(requestJev({apiKey:'synthetic-outage',apiProvider:'typesafe',body:{}}),/暂不可用/);
  assert.equal(outages,2);
  await assert.rejects(requestJev({apiKey:'synthetic-outage',apiProvider:'typesafe',body:{}}),/待恢复/);
  assert.equal(outages,2,'相同连接进入冷却');
  globalThis.fetch=async(url,args)=>{
    calls.push({url,body:JSON.parse(args.body)});
    const choice=Object.keys(JSON.parse(args.body).questions.action.criteria)[0];
    return {ok:true,json:async()=>({model:'jev-1.13.0',answers:{action:{type:'choice',choice,confidence:0.97}}})};
  };
  const action={id:'a1',operation:'CLICK',target:'f0_1',label:'打开分区',kind:'section-entry'};
  const result=await choose({apiKey:'synthetic-outage',apiProvider:'quickrouter',goal:'fill',
    page:{},elements:[],history:[],resume:{},actionPlan:{actions:[action],byId:{a1:action}}});
  assert.equal(result.id,'a1');
  assert.equal(result.confidence,0.97);
  assert.equal(result.request.model,'jev-1.13.0');
  assert.equal(calls.at(-1).url,'https://api.quickrouter.ai/v1/systemone','官方服务冷却独立于 QuickRouter');
  assert.equal(JSON.stringify(result).includes('synthetic-outage'),false);
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;}
console.log('Jev providers share one native protocol; synthetic checks, credential isolation, errors and cooldowns pass');
