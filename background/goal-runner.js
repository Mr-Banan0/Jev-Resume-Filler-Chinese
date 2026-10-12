// 默认编排：区域 → 资料块 → 记录 → 局部字段事务。界面证据决定推进与退出。
import {choose,isRecordSaveControl,listBlockChoiceFields,safeJevValue} from '../lib/jev-client.js';
import {actionKey,actionPermission,alternativeChoiceSatisfied,choiceAlreadySelected,excludedByUser,hasCommittedValue,isEntryTarget,isValueTarget} from '../lib/action-policy.js';
import {blockPlan,closeRegion,createGoalLedger,entryPlan,fieldAudit,goalPlan,localRegion,localViewPlan,observedGateControls,
  reconcileRegions,recordBindingPlan,recordSourcePlan,recordSurfaces,recordTypeAllowed,regionPlan,sourceId,sourceRecords,exactRecordIdentity} from '../lib/goal-state.js';
import {buildObservedActionPlan} from '../lib/observed-interaction.js';
import {classifyPageState,pageRouteKey,pageBoundaryReason} from '../lib/page-state.js';
import {createRunMemory,savedRecordEvidence} from '../lib/traversal-state.js';
import {belongsToRegion,regionIdentity,regionTree} from '../lib/page-scope.js';
import {verifyObservedRecord,OPTION_VERIFICATION_THRESHOLD} from '../lib/jev-verification.js';

export async function runGoalScheduler({tabId,resume,apiKey,apiProvider='typesafe',goal,report,isCurrentRun,
  snapshot,executeClick,closeTransactions,transaction,sleep,agreementConfirmed=false}) {
  const ledger=createGoalLedger(),memory=createRunMemory(),pending=new Map(),drafts=new Map(),closedFields=new Map();
  let turns=0,writes=0,saved=0,activeRegion=null,editorOwner=null;
  const allowedRoutes=new Set();
  const progressSummary=()=>({regions:ledger.regions.size,
    regionsChecked:[...ledger.regions.values()].filter(region=>region.closed || region.status!=='ready').length,
    records:ledger.records.size,fields:ledger.fields.size,writes,saved});
  const regionFor=title=>activeRegion?.title===title ? activeRegion : ledger.regions.get(title);
  const scoped=(snap,title)=>localRegion(snap,regionFor(title) || title);
  const scopeId=title=>regionFor(title)?.id || title;
  const issueKey=(title,key)=>`${scopeId(title)}|${key}`;
  const putIssue=(title,key,issue)=>pending.set(issueKey(title,key),{section:title,regionId:scopeId(title),...issue});
  const emit=report;
  report=event=>emit({step:turns,...event});
  const observe=async({readOnly=false,editorNavigation=false}={})=>{
    if(!isCurrentRun()) throw new Error('填写任务已停止');
    if(++turns>600) throw new Error('本轮区域任务达到预算，已保留进度');
    let snap=await snapshot(tabId,'observed',editorOwner);
    const route=pageRouteKey(snap.page);
    if(!allowedRoutes.size && route) allowedRoutes.add(route);
    const outside=pageBoundaryReason(snap.page,allowedRoutes);
    if(outside) {
      const local=editorOwner ? snap.elements.filter(control=>belongsToRegion(control,editorOwner)) : [];
      const editor=editorNavigation && (snap.page.editorSurface ||
        local.filter(isValueTarget).length>=2 && local.some(control=>isRecordSaveControl(control,local)));
      if(editor) allowedRoutes.add(route);else throw new Error(outside);
    }
    for(let attempt=0;!readOnly && attempt<3;attempt++) {
      const notice=snap.elements.find(control=>control.noticeDismissal && actionPermission(control).allowed);
      if(!notice) break;
      const match=String(notice.index).match(/^f(\d+)_(.+)$/);
      report({phase:'notice',action:'关闭遮挡表单的非协议提示，随后重新扫描'});
      const result=await executeClick(tabId,Number(match?.[1] || 0),match?.[2] || notice.index,false);
      if(!result?.ok) throw new Error('提示层关闭失败，已保留填写进度');
      await sleep(250);snap=await snapshot(tabId,'observed',editorOwner);
    }
    const state=classifyPageState(snap.page,snap.elements);
    if(['auth-required','unsaved-confirmation'].includes(state.kind)) throw new Error(state.reason);
    reconcileRegions(ledger,snap);
    for(const region of ledger.regions.values()) if(excludedByUser({section:region.title},resume,snap.page.url)) {
      closeRegion(region,'excluded-user');
    }
    return snap;
  };
  const decision=async(plan,snap,title,context={})=>{
    if(title && regionFor(title)?.closed) return null;
    if(!plan.actions.length) return null;
    const elements=title ? scoped(snap,title) : [];
    const result=await choose({apiKey,apiProvider,goal,resume,history:[],actionPlan:plan,elements,
      page:{...snap.page,title,regionId:title ? regionFor(title)?.id : null,sectionScope:!!title,
        dataBlock:context.selectedBlock || null,
        sectionOutline:[...ledger.regions.values()].map(region=>region.title),
        goalContext:{...context,...(!title ? {hierarchy:regionTree(snap,null)} : {}),
          ...(plan.dataCatalogue ? {jsonCatalogue:plan.dataCatalogue} : {})}}});
    report({phase:'goal-decision',section:title,action:`${context.phase || '调度'}：${result.operation}`,
      operation:result.operation,confidence:result.confidence,recordIndex:result.recordIndex,
      ...(result.request ? {decisionTrace:{request:result.request,requestMetrics:result.requestMetrics,selected:result.id,confidence:result.confidence}} : {})});
    return result;
  };
  const click=async(action,snap)=>{
    const control=snap.elements.find(c=>c.index===action.target);
    if(!control || ledger.regions.get(regionIdentity(control))?.closed ||
      !actionPermission(control,'CLICK',{agreementConfirmed}).allowed) return false;
    const current=await observe(),target=current.elements.find(c=>actionKey(c)===actionKey(control));
    if(!target || ledger.regions.get(regionIdentity(target))?.closed || target.label!==control.label ||
      !actionPermission(target,'CLICK',{agreementConfirmed}).allowed) return false;
    const match=String(target.index).match(/^f(\d+)_(.+)$/);
    const result=await executeClick(tabId,Number(match?.[1] || 0),match?.[2] || target.index,
      target.clickMode==='trusted-pointer');
    await sleep(450);
    return result?.ok===true;
  };
  const fields=async(snap,title,block,index,controls,extra={})=>{
    if(regionFor(title)?.closed) throw new Error(`${title} 已在本轮终结`);
    if(!extra.gateScope && !extra.repairDraft) {
      const views=localViewPlan([...controls,...scoped(snap,title).filter(control=>control.localView)]);
      const view=views.actions.length===1 ? views.actions[0] : await decision(views,snap,title,{
        phase:'editor-type',selectedBlock:block,currentSourceRecord:safeJevValue(sourceRecords(resume,block)[index]),
        views:views.viewCatalogue});
      if(view?.operation==='OPEN_VIEW' && await click(view,snap)) {
        snap=await observe();
        const surfaces=recordSurfaces(scoped(snap,title),{regionId:scopeId(title)});
        const surface=surfaces.find(item=>item.controls.some(control=>controls.some(old=>actionKey(old)===actionKey(control)))) ||
          (surfaces.length===1 ? surfaces[0] : null);
        if(!surface) {
          putIssue(title,'view',{field:'编辑类型',reason:'切换后尚未确认对应编辑表面',status:'blocked'});
          return {snap,result:{ok:false},audit:[]};
        }
        controls=surface.controls;
      }
    }
    const keys=controls.map(actionKey),recordKey=issueKey(title,`${sourceId(resume,block,index)}|${extra.gateScope?'gate':keys[0]}`);
    const before=snap.elements.filter(c=>keys.includes(actionKey(c)) && hasCommittedValue(c)).length;
    const result=await transaction({goal,resume,apiKey,apiProvider,tabId,onProgress:report,isCurrentRun,
      initialRecordIndex:index,scopeSection:title,scopeRegionId:regionFor(title)?.id,
      scopeDocumentId:editorOwner?.documentId,dataBlock:block,runMemory:memory,recordKey,
      interactionPolicy:'observed',recordControlKeys:keys,deferRecordCommit:true,
      recordSurfaceKey:recordSurfaces(controls,{regionId:scopeId(title)})[0]?.key,
      ...extra});
    if(result.cancelled || result.terminal && /登录|停止|决策服务/.test(result.reason || '')) throw new Error(result.reason);
    const after=await observe(),surfaces=recordSurfaces(scoped(after,title),{regionId:scopeId(title)});
    const surface=surfaces.find(s=>s.controls.some(c=>keys.includes(actionKey(c)))) || (surfaces.length===1 ? surfaces[0] : null);
    const local=extra.gateScope || extra.fieldScope ? scoped(after,title).filter(c=>keys.includes(actionKey(c))) : surface?.controls || [];
    if(!extra.gateScope && !extra.fieldScope && surface) keys.splice(0,keys.length,...local.map(actionKey));
    const history=result.history || [],plan=buildObservedActionPlan(after.elements,resume,history,{
      ...after.page,title,regionId:regionFor(title)?.id,dataBlock:block,recordIndex:index,recordScope:true,recordControlKeys:keys,
      deferRecordCommit:true,...extra});
    const audit=fieldAudit(local,history,plan,{resume,url:after.page.url});
    if(!extra.gateScope && !extra.repairDraft) {
      const confirmed=new Set(audit.filter(item=>item.status==='verified').map(item=>item.key));
      const bindings=history.filter(item=>item.kind==='bind' && confirmed.has(item.controlStableKey));
      if(bindings.length) drafts.set(issueKey(title,sourceId(resume,block,index)),{
        title,regionId:scopeId(title),block,index,bindings});
    }
    for(const item of audit) {
      const key=issueKey(title,item.key),previous=ledger.fields.get(key);
      // 后续资料块缺少这个字段时，保留先前已经取得的执行失败证据。
      const retained=previous?.status==='blocked' && ['missing-data','uninspected'].includes(item.status) ? previous :
        {...item,section:title,regionId:scopeId(title),block};
      const control=local.find(c=>actionKey(c)===item.key);
      if(control?.kind==='file') {
        const binding=history.findLast(entry=>entry.kind==='bind' && entry.controlStableKey===item.key);
        retained.expectedFileName=listBlockChoiceFields(resume,block,index).find(source=>source.path===binding?.resumeField)?.value?.name;
      }
      ledger.fields.set(key,retained);
      if(['missing-data','blocked','uninspected'].includes(retained.status)) pending.set(key,
        {section:title,regionId:scopeId(title),field:retained.label,reason:retained.reason,status:retained.status});
      else pending.delete(key);
    }
    writes+=Math.max(0,local.filter(hasCommittedValue).length-before);
    return {snap:after,result,audit};
  };
  const commit=async(snap,title,record,allowRepair=true)=>{
    if(regionFor(title)?.closed) throw new Error(`${title} 已在本轮终结`);
    const local=scoped(snap,title),save=local.find(c=>actionPermission(c).allowed && isRecordSaveControl(c,local));
    if(!save) return {snap,blocked:false,hasSave:false};
    const before=recordSurfaces(local,{regionId:scopeId(title)}).flatMap(s=>s.controls).filter(hasCommittedValue);
    if(!await click({target:save.index},snap)) {
      putIssue(title,'save',{field:'保存回读',reason:'保存操作未完成',status:'blocked'});
      return {snap:await observe(),blocked:true,hasSave:true};
    }
    const normalize=value=>String(value ?? '').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    const readSave=snapshot=>{
      const controls=scoped(snapshot,title),remaining=recordSurfaces(controls,{regionId:scopeId(title)}).flatMap(s=>s.controls);
      const errors=controls.filter(c=>c.validationError && !excludedByUser(c,resume,snapshot.page.url));
      const summaries=controls.map(c=>normalize(c.summaryText || c.recordSummary || '')).filter(Boolean);
      const evidence=record ? savedRecordEvidence(controls,{section:title,record}) :
        before.some(c=>typeof c.value==='string' && normalize(c.value).length>=2 &&
          summaries.some(summary=>summary.includes(normalize(c.value))));
      return {controls,remaining,errors,evidence};
    };
    let after=await observe(),readback=readSave(after);
    // 保存可能异步刷新整页；以摘要回读或明确校验错误结束事务，再进入下一分区。
    for(let read=0;read<12 && !readback.errors.length && (readback.remaining.length || !readback.evidence);read++) {
      await sleep(500);after=await observe();readback=readSave(after);
    }
    const {controls,remaining,errors,evidence}=readback;
    if(allowRepair && errors.length) {
      for(const draft of drafts.values()) {
        if(draft.regionId!==scopeId(title)) continue;
        const sources=listBlockChoiceFields(resume,draft.block,draft.index),repairs=[],bindings=[];
        for(const control of errors) {
          const bound=[...draft.bindings].reverse().find(item=>item.controlStableKey===actionKey(control));
          const short=bound && sources.find(source=>source.path===`${bound.resumeField}Short`);
          if(!short || !control.maxLength || typeof short.value!=='string' || short.value.length>control.maxLength) continue;
          repairs.push(control);bindings.push({...bound,resumeField:short.path});
        }
        if(!repairs.length) continue;
        report({phase:'validation-repair',section:title,action:`${title}：按网站长度校验改用资料中的短版，随后重新保存一次`});
        draft.bindings.push(...bindings);
        const repaired=await fields(after,title,draft.block,draft.index,repairs,{repairDraft:true,
          fieldBindings:bindings,recordKey:`repair:${issueKey(title,sourceId(resume,draft.block,draft.index))}`});
        return commit(repaired.snap,title,record,false);
      }
    }
    for(const c of errors) putIssue(title,actionKey(c),{field:c.questionLabel || c.label,
      reason:c.validationError,status:'blocked'});
    if(!errors.length && !remaining.length && evidence) {
      saved++;pending.delete(issueKey(title,'save'));
      for(const [key,draft] of drafts) if(draft.regionId===scopeId(title)) drafts.delete(key);
      report({phase:'saved',section:title,action:`${title} 已在保存后的摘要中回读资料`});
      return {snap:after,blocked:false,hasSave:true};
    }
    putIssue(title,'save',{field:'保存回读',
      reason:errors.length ? '网站仍报告字段校验问题' : remaining.length ? '编辑表面仍打开，保存尚未验收' :
        '编辑表面已关闭，尚未取得对应资料的保存摘要',status:'blocked'});
    return {snap:after,blocked:true,hasSave:true};
  };
  const openOnce=async(snap,region,adding=false,sourceContext={})=>{
    const controls=localRegion(snap,region),plan=entryPlan(controls,region,{adding,...sourceContext});
    const action=await decision(plan,snap,region.title,{phase:'open',adding});
    if(!action) return {snap,opened:false,outcome:'blocked',feedback:'当前分区尚未观察到可用的编辑入口'};
    region.attemptedEntries.add(action.controlStableKey);
    const before=new Set(recordSurfaces(controls,{regionId:region.id}).map(s=>s.key));
    report({phase:'open',section:region.title,action:`${region.title}：${action.label}`});
    editorOwner={id:region.id,title:region.title,documentId:snap.page.documentId};
    if(!await click(action,snap)) return {snap,opened:false,outcome:'blocked',feedback:'编辑入口执行失败'};
    let after=await observe({editorNavigation:true}),surfaces=recordSurfaces(localRegion(after,region),{regionId:region.id});
    const oldText=new Set(String(snap.page.text || '').split(/[\n\r]+/).map(line=>line.trim()));
    const feedback=(after.page.framePages || [after.page]).flatMap(page=>page.observation?.feedback || []).find(text=>
      /请.{0,30}(完善|填写|完成)|失败|错误|尚未|先.{0,20}(保存|完成)/.test(text)) ||
      String(after.page.text || '').split(/[\n\r]+/).map(line=>line.trim()).find(line=>
        line.length<160 && !oldText.has(line) && /请.{0,30}(完善|填写|完成)|失败|错误|尚未|先.{0,20}(保存|完成)/.test(line));
    for(let read=0;read<3 && (adding ? !surfaces.some(surface=>!before.has(surface.key)) : !surfaces.length);read++) {
      await sleep(500);after=await observe();surfaces=recordSurfaces(localRegion(after,region),{regionId:region.id});
    }
    const fresh=surfaces.find(s=>!before.has(s.key));
    if(fresh && action.operation==='ADD_RECORD') region.attemptedEntries.delete(action.controlStableKey);
    const opened=adding ? !!fresh : surfaces.length>0;
    return {snap:after,opened,outcome:opened?'opened':feedback?'blocked':'unchanged',fresh,
      feedback:opened ? undefined : feedback || '入口已点击，尚未观察到归属本分区的新编辑字段'};
  };
  const open=async(snap,region,adding=false,sourceContext={})=>{
    let result;
    for(let attempt=0;attempt<4;attempt++) {
      result=await openOnce(snap,region,adding,sourceContext);
      if(result.opened || result.outcome==='blocked') return result;
      snap=result.snap;
      if(!entryPlan(localRegion(snap,region),region,{adding,...sourceContext}).actions.length) break;
    }
    return result;
  };
  const finishRegion=(snap,region)=>{
    const controls=localRegion(snap,region).filter(control=>isValueTarget(control) &&
      !region.preservedRecordFields?.has(actionKey(control)));
    closedFields.set(region.id,{region,fields:controls.map(control=>({key:actionKey(control),
      label:control.questionLabel || control.label,kind:control.kind,hadValue:hasCommittedValue(control)}))});
    const issues=[...pending.values()].filter(issue=>issue.regionId===region.id);
    closeRegion(region,issues.some(issue=>['blocked','uninspected'].includes(issue.status)) ? 'blocked' :
      issues.length ? 'pending' : 'checked');
    for(const [key,draft] of drafts) if(draft.regionId===region.id) drafts.delete(key);
    ledger.stack=[];
    report({phase:'section-closed',section:region.title,status:region.status,
      action:`${region.title} 本轮已终结；${issues.length} 项待核对，继续其他分区`});
  };
  const auditClosedRegions=snap=>{
    // 只读复核当前仍可见的字段；已关闭的编辑器通过先前保存证据记账。
    for(const {region,fields:previous} of closedFields.values()) {
      const title=region.title,controls=localRegion(snap,region).filter(isValueTarget),matched=new Set();
      for(const old of previous) {
        const sameLabel=controls.filter(control=>(control.questionLabel || control.label)===old.label && control.kind===old.kind);
        const uniqueBefore=previous.filter(item=>item.label===old.label && item.kind===old.kind).length===1;
        const control=controls.find(item=>actionKey(item)===old.key) ||
          (uniqueBefore && sameLabel.length===1 ? sameLabel[0] : null);
        if(!control) continue;
        matched.add(actionKey(control));
        const itemKey=`${region.id}|${old.key}`,entry=ledger.fields.get(itemKey);
        if(control.kind==='file' && entry?.expectedFileName && String(control.value || '').includes(entry.expectedFileName)) {
          if(entry.status!=='verified') writes++;
          entry.status='verified';entry.reason='延迟上传回执已在只读复核中确认';pending.delete(itemKey);
        }
        if(!old.hadValue || hasCommittedValue(control) || excludedByUser(control,resume,snap.page.url)) continue;
        const key=`${region.id}|${old.key}`;
        if(!pending.has(key)) pending.set(key,{section:title,regionId:region.id,field:old.label,status:'blocked',
          reason:'离开分区后回读到原字段为空；本轮只读记录，重新启动填写时复核'});
      }
      for(const control of controls) {
        if(matched.has(actionKey(control)) || hasCommittedValue(control) ||
          region.preservedRecordFields?.has(actionKey(control)) ||
          choiceAlreadySelected(control,controls) || alternativeChoiceSatisfied(control,controls) ||
          excludedByUser(control,resume,snap.page.url) || !actionPermission(control).allowed) continue;
        const key=`${region.id}|${actionKey(control)}`;
        if(!pending.has(key)) pending.set(key,{section:title,regionId:region.id,field:control.questionLabel || control.label,
          status:'uninspected',reason:'分区终结后出现新的空字段；重新启动填写时检查'});
      }
    }
  };
  try {
    let snap=await observe();
    while(isCurrentRun()) {
      const selection=await decision(regionPlan(ledger,snap),snap,null,{phase:'region-menu',
        regions:[...ledger.regions.values()].filter(r=>!r.closed && r.status==='ready')
          .map(r=>({id:r.id,title:r.title,status:r.status}))});
      if(!selection) break;
      const title=selection.section,region=ledger.regions.get(selection.regionId || title);
      if(!region || region.closed) throw new Error('所选分区已在本轮终结');
      activeRegion=region;
      editorOwner=null;
      ledger.stack=[{region:region.id,title}];
      region.status='working';
      report({phase:'section',section:title,action:`检查区域：${title}`});
      let controls=scoped(snap,title);
      // 单纯折叠区域先展开，再用实际字段判断资料块；有开关的区域先选择资料。
      if(!recordSurfaces(controls,{regionId:region.id}).length && !observedGateControls(controls).length) {
        const opened=await open(snap,region);
        snap=opened.snap;controls=scoped(snap,title);
        if(!opened.opened && opened.feedback) {
          region.status='blocked';region.dependencyFeedback=opened.feedback;
          putIssue(title,'open',{field:'编辑入口',reason:opened.feedback,status:'blocked'});
          report({phase:'blocked',section:title,action:`${title}：${opened.feedback}`});
          finishRegion(snap,region);
          await closeTransactions(tabId,0);
          continue;
        }
      }
      let anyBlock=false,hasFactDraft=false;
      while(isCurrentRun()) {
        const routePlan=blockPlan(title,controls.filter(c=>!excludedByUser(c,resume,snap.page.url)),resume,region,snap.page.url,
          {agreementConfirmed});
        if(routePlan.routingInspect) {
          const target=controls.find(control=>control.index===routePlan.routingInspect);
          region.routingInspected ||= new Set();
          region.routingInspected.add(actionKey(target));
          report({phase:'question-inspection',section:title,action:`观察当前问题的真实选项：${target.label}`});
          await closeTransactions(tabId,0);
          await click({target:target.index},snap);
          snap=await observe();controls=scoped(snap,title);
          continue;
        }
        const route=await decision(routePlan,snap,title,{phase:'block-menu',question:routePlan.routingQuestion,
          visibleOptions:routePlan.routingOptions});
        if(!route) break;
        if(route.operation==='NO_DATA_BLOCK') {
          for(const key of routePlan.routingTargets || []) {
            region.routingClosed.add(key);
            const control=controls.find(c=>actionKey(c)===key);
            if(control && !pending.has(issueKey(title,key))) putIssue(title,key,{
              field:control.label,
              reason:route.confidence>=0.75?'当前问题没有可确认的资料来源':'资料来源判断尚不确定，保留待核对',
              status:route.confidence>=0.75?'missing-data':'uninspected'});
          }
          if(routePlan.routingOptions?.length) {
            await closeTransactions(tabId,0);
            snap=await observe();controls=scoped(snap,title);
          }
          continue;
        }
        const block=route.dataBlock,records=sourceRecords(resume,block);
        for(const key of routePlan.routingTargets || []) region.routingAttempts.add(`${key}|${block}`);
        anyBlock=true;region.blocks.set(block,'working');
        ledger.stack=[{region:region.id,title},{block}];
        report({phase:'block',section:title,dataBlock:block,action:`${title} 使用 ${block}，检查 ${records.length} 条资料`});
        const gates=observedGateControls(controls);
        if(gates.length) {
          const gate=await fields(snap,title,block,0,gates,{gateScope:true});
          snap=gate.snap;controls=scoped(snap,title);
          if(observedGateControls(controls).length) {
            region.blocks.set(block,'blocked');break;
          }
        }
        let surfaces=recordSurfaces(controls,{regionId:region.id}),fresh;
        if(!surfaces.length) {
          const opened=await open(snap,region);
          snap=opened.snap;fresh=opened.fresh;controls=scoped(snap,title);surfaces=recordSurfaces(controls,{regionId:scopeId(title)});
          if(opened.feedback) region.dependencyFeedback=opened.feedback;
        }
        if(!surfaces.length) {
          putIssue(title,'open',{field:'编辑入口',reason:region.dependencyFeedback || '打开操作后尚未观察到字段',status:'blocked'});
          region.blocks.set(block,'blocked');break;
        }
        pending.delete(issueKey(title,'open'));
        const array=Array.isArray(resume[block]);
        const repeatedEditor=surfaces.length>1 || controls.some(control=>isRecordSaveControl(control,controls)) || controls.some(control=>isEntryTarget(control) &&
          /^(?:\+\s*)?(?:添加|新增|增加|add\b)/i.test(control.label || ''));
        const mode=routePlan.recordInventory ? {operation:'FILL_RECORDS'} : array ? await decision(goalPlan([
          {operation:'FILL_RECORDS',target:'scope:records',label:'区域承载整条经历记录，按经历逐条填写'},
          {operation:'FILL_FACTS',target:'scope:facts',label:'区域只需要此资料块的个别属性，如最高学历或毕业学校'},
          {operation:'FILL_SUMMARY',target:'scope:summary',label:'区域用一个长文本字段汇总全部相关记录，如奖励名称及获得时间、语言能力或社会实践'}
        ],'Choose the fill contract for the whole physical region using its title, record surfaces, add-record entry and fields. A repeated experience editor uses FILL_RECORDS even when only one attribute in one existing record remains empty; this contract also checks missing source records. FILL_FACTS applies to isolated attributes borrowed from another JSON block, such as education facts inside personal information. A descriptive field summarizing achievements, languages or activities uses FILL_SUMMARY, with the relevant whole collection or individual record facts, and creates no new webpage records.',
          {routingTargets:routePlan.routingTargets}),snap,title,
        {phase:'record-scope',selectedBlock:block,recordEditorEvidence:repeatedEditor,
          observedRecordSurfaces:surfaces.length,routedQuestion:routePlan.routingQuestion}) : {operation:'FILL_FACTS'};
        const collection=mode?.operation==='FILL_RECORDS';
        const summaryScope=mode?.operation==='FILL_SUMMARY';
        if(collection && !recordTypeAllowed(title,block,[...ledger.regions.values()].map(r=>r.title))) {
          region.blocks.set(block,'type-conflict');
          report({phase:'record-type',section:title,action:`${title}：${block} 资料归属其独立经历分区，继续核对当前问题的来源`});
          continue;
        }
        hasFactDraft ||= !collection;
        const processed=new Set(),visited=new Set();
        let recordMatched=false,unresolvedRecord=false;
        let sourceIndex=0;
        while(isCurrentRun()) {
          surfaces=recordSurfaces(scoped(snap,title).filter(control=>!region.preservedRecordFields?.has(actionKey(control))),{regionId:region.id});
          if(!collection) surfaces=surfaces.map(surface=>({...surface,controls:surface.controls.filter(control=>
            routePlan.routingTargets.includes(actionKey(control)))})).filter(surface=>surface.controls.length);
          let surface=fresh || surfaces.find(s=>!visited.has(s.key));fresh=null;
          let addedFresh=false;
          const available=records.map((_,i)=>i).filter(i=>!processed.has(i));
          if(!available.length) break;
          const occupied=surface?.controls.some(control=>hasCommittedValue(control) &&
            !/radio|checkbox/.test(`${control.kind} ${control.role}`));
          let selectedSource=null;
          if(collection && !occupied) {
            const selected=await decision(recordSourcePlan(resume,block,available),snap,title,
              {phase:'record-source',selectedBlock:block});
            if(selected?.operation!=='SELECT_SOURCE_RECORD') break;
            selectedSource=selected.recordIndex;
          }
          if(!surface && collection) {
            if(unresolvedRecord) {
              putIssue(title,`remaining:${block}`,{field:'剩余记录',
                reason:'已检查网页记录的归属仍待核对，保留剩余来源并暂停新增',status:'blocked'});
              break;
            }
            const opened=await open(snap,region,true,{records,available:selectedSource==null?available:[selectedSource]});
            snap=opened.snap;surface=opened.fresh;addedFresh=!!surface;
            if(!surface) {
              putIssue(title,`remaining:${block}`,{field:'剩余记录',
                reason:`${block} 还有 ${available.length} 条资料，当前未确认新的编辑表面`,status:'blocked'});break;
            }
          }
          if(!surface) break;
          visited.add(surface.key);
          const identityEvidence=surface.controls.some(control=>hasCommittedValue(control) &&
            !/radio|checkbox/.test(`${control.kind} ${control.role}`));
          if(array && !summaryScope && (identityEvidence || !collection) && !addedFresh) {
            const exactMatches=collection ? records.map((_,candidate)=>candidate)
              .filter(candidate=>exactRecordIdentity(surface,records,candidate)) : [];
            const exactAvailable=exactMatches.filter(candidate=>available.includes(candidate));
            report({phase:'record-identity-evidence',section:title,
              action:`页面记录 ${Number(surface.position || 0)+1}：唯一字面匹配 ${exactMatches.length} 条，可用 ${exactAvailable.length} 条`});
            let binding=exactMatches.length===1 && exactAvailable.length===1 ?
              {operation:'BIND_RECORD',recordIndex:exactAvailable[0],confidence:1,exactIdentity:true} :
              await decision(recordBindingPlan(surface,resume,block,available,{facts:!collection}),
                {...snap,elements:surface.controls},title,{phase:'record-binding',selectedBlock:block,
                  webpageRecordPosition:surface.position,webpageRecord:surface.controls.map(c=>({label:c.label,value:safeJevValue(c.value)}))});
            if(collection && (binding?.operation==='PRESERVE_UNRELATED_RECORD' ||
              binding?.operation==='BIND_RECORD' && !exactRecordIdentity(surface,records,binding.recordIndex))) {
              const verification=await verifyObservedRecord({apiKey,apiProvider,
                webpageValues:surface.controls.filter(hasCommittedValue).map(control=>({label:control.label,value:safeJevValue(control.value)})),
                record:safeJevValue(records[binding.recordIndex ?? available[0]]),availableRecords:available.map(index=>safeJevValue(records[index]))});
              report({phase:'record-verification',section:title,action:`记录身份核验：匹配 ${Math.round(verification.match*100)}%`,
                decisionTrace:{request:verification.request,match:verification.match,unrelated:verification.unrelated}});
              if(binding.operation==='PRESERVE_UNRELATED_RECORD' && verification.unrelated<OPTION_VERIFICATION_THRESHOLD) {
                binding={operation:'SKIP_RECORD'};
              } else if(binding.operation==='BIND_RECORD' && verification.match<OPTION_VERIFICATION_THRESHOLD) binding={operation:
                verification.unrelated>=OPTION_VERIFICATION_THRESHOLD ? 'PRESERVE_UNRELATED_RECORD' : 'SKIP_RECORD'};
            }
            if(binding?.operation==='PRESERVE_UNRELATED_RECORD') {
              region.preservedRecordFields ||= new Set();
              for(const control of surface.controls) {
                region.preservedRecordFields.add(actionKey(control));
                region.routingClosed.add(actionKey(control));
                pending.delete(issueKey(title,actionKey(control)));
              }
              report({phase:'record-preserved',section:title,action:'已有记录属于其他经历，保持内容并继续核对来源记录'});
              continue;
            }
            if(binding?.operation!=='BIND_RECORD') {
              unresolvedRecord=true;
              putIssue(title,`identity:${surface.key}`,{field:'记录归属',
                reason:'当前网页经历与来源记录的对应关系尚未确认',status:'blocked'});
              if(collection) continue;
              break;
            }
            sourceIndex=binding.recordIndex;
          } else sourceIndex=selectedSource ?? available[0];
          recordMatched=true;
          pending.delete(issueKey(title,`identity:${surface.key}`));
          const identity=sourceId(resume,block,sourceIndex);
          ledger.records.set(issueKey(title,surface.key),{sourceId:identity,sourceIndex,webpagePosition:surface.position,status:'working'});
          const completed=await fields(snap,title,block,sourceIndex,surface.controls,{summaryScope,fieldScope:!collection});
          snap=completed.snap;processed.add(sourceIndex);
          ledger.records.get(issueKey(title,surface.key)).status=completed.audit.some(a=>a.status==='blocked')?'blocked':
            completed.audit.some(a=>['missing-data','uninspected'].includes(a.status))?'pending':'verified';
          // 重复经历逐条提交；复合信息在资料块检查完成后统一保存。
          if(!collection) break;
          const committed=await commit(snap,title,records[sourceIndex]);snap=committed.snap;
          if(committed.blocked) break;
          // 单一表面的未保存记录承载当前源；有保存按钮时继续新增会覆盖草稿。
          if(committed.hasSave && recordSurfaces(scoped(snap,title),{regionId:scopeId(title)}).some(s=>s.key===surface.key)) break;
        }
        region.blocks.set(block,'checked');
        controls=scoped(snap,title);
        // 经历表面的字段归属当前资料记录；缺项保留待补，资料块边界随记录退出。
        if(collection && recordMatched) break;
        if(!controls.some(c=>isValueTarget(c) && !hasCommittedValue(c) && !excludedByUser(c,resume,snap.page.url))) break;
      }
      if(hasFactDraft) snap=(await commit(snap,title)).snap;
      if(!anyBlock && controls.some(c=>isValueTarget(c) && !hasCommittedValue(c) && !excludedByUser(c,resume,snap.page.url))) {
        putIssue(title,'source',{field:title,reason:'剩余字段尚无可确认的资料来源',status:'missing-data'});
      }
      const observations=(snap.page.framePages || [snap.page]).flatMap(frame=>frame.observation?.unobservedFields || []);
      for(const field of observations.filter(f=>belongsToRegion(f,region) && !excludedByUser(f,resume,snap.page.url))) putIssue(title,`unobserved:${field.id}`,
        {field:field.label,reason:field.reason,status:'uninspected'});
      finishRegion(snap,region);
      await closeTransactions(tabId,0);
      snap=await observe();
    }
    // 本轮已终结分区保持关闭；末尾扫描只补充报告。
    snap=await observe({readOnly:true});
    auditClosedRegions(snap);
    // 最终状态包含保存证据、待补事实和仍留在页面的草稿。
    const issues=[...pending.values()];
    const sections=[...ledger.regions.values()].map(region=>{
      const remaining=issues.filter(issue=>issue.regionId===region.id);
      return {id:region.id,title:region.title,closed:region.closed,status:remaining.some(issue=>['blocked','uninspected'].includes(issue.status)) ? 'blocked' :
        remaining.length ? 'pending' : region.status};
    });
    return {ok:issues.length===0,done:true,reason:`区域检查完成：补齐 ${writes} 个控件，${saved} 次保存回读，${issues.length} 项待核对`,
      pendingIssues:issues,step:turns,sections,
      goalSummary:progressSummary()};
  } catch(error) {
    if(error.decisionTrace) report({phase:'failed',action:`Jev 请求失败：${error.message}`,decisionTrace:error.decisionTrace});
    if(isCurrentRun()) putIssue(activeRegion?.title || '全局','run-error',{
      field:/决策服务|API|模型请求/.test(error.message)?'模型服务连接':'运行中断',
      reason:error.message,status:'blocked'});
    return {ok:false,cancelled:!isCurrentRun(),reason:error.message,step:turns,pendingIssues:[...pending.values()],
      goalSummary:progressSummary()};
  }
}
