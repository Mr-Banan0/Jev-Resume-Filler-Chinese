import assert from 'node:assert/strict';
import {choose} from '../lib/jev-client.js';
const original={fetch:globalThis.fetch,setTimeout:globalThis.setTimeout};
globalThis.setTimeout=(fn,ms)=>{if(ms<6000) queueMicrotask(fn);return 0;};
globalThis.fetch=async()=>{throw Error('synthetic outage');};
const action={id:'a1',operation:'CLICK',target:'f0_1',label:'打开分区',kind:'section-entry'};
try {
  await assert.rejects(choose({apiKey:'synthetic',goal:'fill',page:{},elements:[],history:[],resume:{},
    actionPlan:{actions:[action],byId:{a1:action}}}),/决策服务暂不可用/);
} finally {globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;}
console.log('An API outage reports a pending decision without fabricating a choice or confidence');
