// API 服务配置集中管理；各服务共享 Jev 原生结构化判断协议。
export const JEV_PROVIDERS=Object.freeze({
  typesafe:Object.freeze({label:'TypeSafe',url:'https://api.typesafe.ai/v1/systemone',model:'jev-latest'}),
  quickrouter:Object.freeze({label:'QuickRouter',url:'https://api.quickrouter.ai/v1/systemone',model:'jev-1.13.0'})
});

export function jevProvider(provider='typesafe') {
  if(!Object.hasOwn(JEV_PROVIDERS,provider)) throw new Error('请选择有效的 Jev API 服务');
  return JEV_PROVIDERS[provider];
}

const retryStatuses=new Set([429,502,503,529]);
const unavailableUntil=new Map();
const retryDelay=attempt=>new Promise(resolve=>setTimeout(resolve,750*(attempt+1)));

export async function requestJev({apiKey,apiProvider='typesafe',body}) {
  const provider=jevProvider(apiProvider);
  if(typeof apiKey!=='string' || !apiKey.trim()) throw new Error('请填写当前服务的 API Key');
  const payload=JSON.stringify({...body,model:provider.model});
  const requestMetrics={provider:apiProvider,phase:body.state?.goal_context?.phase || body.state?.interaction?.phase || 'connection',
    characters:payload.length,bytes:new TextEncoder().encode(payload).length,
    stateCharacters:JSON.stringify(body.state ?? null).length,questionCharacters:JSON.stringify(body.questions ?? {}).length};
  const failure=message=>Object.assign(new Error(message),{requestMetrics});
  const connectionKey=`${apiProvider}:${apiKey}`;
  if(Date.now()<(unavailableUntil.get(connectionKey) || 0)) {
    throw failure(`${provider.label} API 暂时不可用，决策待恢复`);
  }
  let res,networkError,parsed,parsedReady,errorText;
  for(let attempt=0;attempt<2;attempt++) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new Error('模型请求等待超过 20 秒')),20000);
    res=undefined;parsedReady=false;
    try {
      res=await fetch(provider.url,{
        method:'POST',redirect:'error',
        headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:payload,signal:controller.signal
      });
      if(res.ok) {
        try {parsed=await res.json();parsedReady=true;}
        catch(error) {
          if(controller.signal.aborted) throw error;
          throw new SyntaxError(`${provider.label} API 响应需要有效 JSON`);
        }
      } else errorText=await res.text();
      networkError=null;
    } catch(error) {
      if(error instanceof SyntaxError) throw error;
      networkError=error;
      res=undefined;
    } finally {clearTimeout(timeout);}
    if(parsedReady) return {...parsed,requestMetrics:{...requestMetrics,inputTokens:parsed.usage?.input_tokens}};
    if(res?.ok || res && !retryStatuses.has(res.status) || attempt===1) break;
    await retryDelay(attempt);
  }
  if(!res || !res.ok && retryStatuses.has(res.status)) {
    unavailableUntil.set(connectionKey,Date.now()+5*60*1000);
    const detail=res ? `HTTP ${res.status}` : String(networkError?.message || '网络连接失败').replaceAll(apiKey,'[redacted]');
    throw failure(`决策服务暂不可用：${detail}`);
  }
  if(!res.ok) {
    const detail=String(errorText).replaceAll(apiKey,'[redacted]').slice(0,500);
    throw failure(`${provider.label} API HTTP ${res.status}: ${detail}（阶段 ${requestMetrics.phase}，${requestMetrics.characters} 字符）`);
  }
}

// 连接检查使用固定合成资料，并验证原生 Choice 契约。
export async function testJevConnection({apiKey,apiProvider}) {
  let result;
  try {result=await requestJev({apiKey,apiProvider,body:{
    state:{task:'Write JavaScript software.'},
    questions:{connection:{type:'choice',instructions:'Select the work matching state.task.',
      criteria:{software:'Writing software',accounting:'Preparing financial accounts',none:'Neither category fits'}}}
  }});} catch(error) {
    if(apiProvider!=='quickrouter' || !/暂不可用|待恢复/.test(error.message)) throw error;
    // 仅诊断用户配置服务的 OpenAI 兼容入口；合成探测保持填写判断契约独立。
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    let diagnostic;
    try {
      const res=await fetch('https://api.quickrouter.ai/v1/chat/completions',{
        method:'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:jevProvider(apiProvider).model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:8})});
      const body=await res.json();
      diagnostic=res.ok && Array.isArray(body.choices) ? 'Chat 入口能响应；原生判断入口仍未通过' :
        `Chat 入口 HTTP ${res.status}`;
    } catch {diagnostic='Chat 入口也未在等待预算内返回有效响应';}
    finally {clearTimeout(timer);}
    throw new Error(`${error.message}；${diagnostic}`);
  }
  const answer=result.answers?.connection,keys=['software','accounting','none'];
  const expectedModel=jevProvider(apiProvider).model;
  const validModel=typeof result.model==='string' && /^jev-/.test(result.model) &&
    (expectedModel==='jev-latest' || result.model===expectedModel);
  const probabilities=answer?.probabilities;
  const distribution=probabilities && Object.keys(probabilities).length===keys.length &&
    keys.every(key=>typeof probabilities[key]==='number' && Number.isFinite(probabilities[key]) && probabilities[key]>=0 && probabilities[key]<=1) &&
    Math.abs(keys.reduce((sum,key)=>sum+probabilities[key],0)-1)<0.001;
  if(!validModel || answer?.type!=='choice' || answer.choice!=='software' ||
    typeof answer.confidence!=='number' || !Number.isFinite(answer.confidence) ||
    answer.confidence<0 || answer.confidence>1 || !distribution ||
    probabilities.software<Math.max(probabilities.accounting,probabilities.none)) {
    throw new Error('连接检查未通过 Jev Choice 契约验证');
  }
  return {ok:true,provider:jevProvider(apiProvider).label,model:result.model,confidence:answer.confidence};
}
