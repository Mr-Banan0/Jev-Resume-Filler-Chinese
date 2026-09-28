import assert from 'node:assert/strict';
import {buildActionPlan,getResumeValue,buildQuestions} from '../lib/jev-client.js';
const resume={basics:{photo:{name:'portrait.jpg',dataUrl:'data:image/jpeg;base64,PORTRAIT'},lifePhotos:[
  {name:'sample-image-a.jpg',dataUrl:'data:image/jpeg;base64,PRIVATE1'},
  {name:'sample-image-b.jpg',dataUrl:'data:image/jpeg;base64,PRIVATE2'}]}};
const inputs=[2,1].map(n=>({index:`file${n}`,label:`个人近期单人全身生活照${n}，请确保照片人像清晰`,
  kind:'file',operations:['UPLOAD_FILE']}));
const plan=buildActionPlan(inputs,resume);
assert.deepEqual(plan.actions.map(a=>a.resumeField),['basics.lifePhotos[1]','basics.lifePhotos[0]']);
assert.ok(!plan.actions.some(a=>a.resumeField==='basics.photo'));
assert.equal(getResumeValue(resume,'basics.lifePhotos[1]').name,'sample-image-b.jpg');
assert.ok(!JSON.stringify(buildQuestions('upload',plan)).includes('PRIVATE'));
const filled=buildActionPlan(inputs.map((el,i)=>({...el,value:`life-photo-${i ? 1 : 2}.jpg`})),resume);
assert.equal(filled.actions.length,0);
const generic=buildActionPlan(inputs.map(el=>({...el,label:'生活照'})),resume);
assert.deepEqual(generic.actions.map(a=>a.resumeField),['basics.lifePhotos[0]','basics.lifePhotos[1]']);
console.log('life-photo binding, existing-file preservation and private bytes isolation passed');
