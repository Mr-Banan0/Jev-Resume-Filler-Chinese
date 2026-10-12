import {jevProvider} from './jev-api.js';

export async function loadJevSettings(storage) {
  const stored=await storage.get(['jevProvider','jevApiKeys','jevApiKey']);
  const provider=stored.jevProvider || 'typesafe';
  jevProvider(provider);
  const keys={};
  for(const name of ['typesafe','quickrouter']) {
    if(typeof stored.jevApiKeys?.[name]==='string') keys[name]=stored.jevApiKeys[name];
  }
  // 已安装版本的官方 Key 一次迁入按服务隔离的存储，后续统一读取 keys。
  if(typeof stored.jevApiKey==='string' && stored.jevApiKey) {
    if(!keys.typesafe) keys.typesafe=stored.jevApiKey;
    await storage.set({jevApiKeys:keys});
    await storage.remove('jevApiKey');
  }
  return {provider,keys};
}

export async function saveJevSettings(storage,{provider,key}) {
  jevProvider(provider);
  if(typeof key!=='string' || !key.trim()) throw new Error('请填写当前服务的 API Key');
  const settings=await loadJevSettings(storage);
  const keys={...settings.keys,[provider]:key.trim()};
  await storage.set({jevProvider:provider,jevApiKeys:keys});
  return {provider,keys};
}
