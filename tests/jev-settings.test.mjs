import assert from 'node:assert/strict';
import {loadJevSettings,saveJevSettings} from '../lib/jev-settings.js';
const data={resume:{basics:{name:'合成姓名'}},jevApiKey:'synthetic-original'};
let writes=0;
const storage={
  get:async keys=>Object.fromEntries(keys.filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]])),
  set:async values=>{writes++;Object.assign(data,values);},
  remove:async key=>{delete data[key];}
};
assert.deepEqual(await loadJevSettings(storage),{provider:'typesafe',keys:{typesafe:'synthetic-original'}});
assert.equal(Object.hasOwn(data,'jevApiKey'),false,'旧 Key 一次迁移后统一使用当前存储');
assert.equal(writes,1);
await loadJevSettings(storage);
assert.equal(writes,1,'迁移只执行一次');
await saveJevSettings(storage,{provider:'quickrouter',key:' synthetic-router '});
assert.deepEqual(await loadJevSettings(storage),{provider:'quickrouter',keys:{typesafe:'synthetic-original',quickrouter:'synthetic-router'}});
assert.deepEqual(data.resume,{basics:{name:'合成姓名'}},'配置 API 保留简历和附件存储');
await saveJevSettings(storage,{provider:'typesafe',key:'synthetic-original'});
assert.equal(data.jevApiKeys.quickrouter,'synthetic-router','切换服务保留各自 Key');
const before=structuredClone(data);
await assert.rejects(saveJevSettings(storage,{provider:'unknown',key:'synthetic'}),/有效/);
await assert.rejects(saveJevSettings(storage,{provider:'quickrouter',key:' '}),/API Key/);
assert.deepEqual(data,before,'无效配置保留原存储');
console.log('Provider credentials migrate once, remain isolated, and preserve local resume data');
