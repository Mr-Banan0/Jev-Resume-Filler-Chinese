// 页面身份由节点确定；标题作为展示及语义判断的属性。
export const regionIdentity=control=>control.regionId || control.section;

export function frameObservation(observation,frameId) {
  if(!observation) return observation;
  const prefix=id=>id ? `f${frameId}:${id}` : id;
  return {...observation,
    regions:(observation.regions || []).map(region=>({...region,id:prefix(region.id),parentId:prefix(region.parentId),
      targets:region.targets?.map(prefix)})),
    unobservedFields:(observation.unobservedFields || []).map(field=>({...field,id:prefix(field.id),regionId:prefix(field.regionId)})),
    ...(observation.interactionTree ? {interactionTree:{...observation.interactionTree,
      roots:observation.interactionTree.roots.map(prefix),
      nodes:observation.interactionTree.nodes.map(node=>({...node,id:prefix(node.id),parentId:prefix(node.parentId),
        ...(node.children ? {children:node.children.map(prefix)} : {})}))}} : {})};
}

export function belongsToRegion(control,{id,title}={}) {
  return control.context!=='popup' &&
    (id && control.regionId ? control.regionId===id : control.section===title);
}

export function regionTree(snapshot,regionId) {
  const observed=(snapshot.page?.framePages || [snapshot.page]).flatMap(frame=>
    frame?.observation?.interactionTree?.nodes || []);
  const nodesById=new Map(observed.map(node=>[node.id,node]));
  // 弹窗、iframe 和独立页由打开入口的事务提供父层，保留字段自身的物理身份。
  for(const control of snapshot.elements || []) {
    if(control.regionEvidence!=='entry-transition' || control.context==='popup') continue;
    if(!nodesById.has(control.regionId)) nodesById.set(control.regionId,{
      id:control.regionId,parentId:null,kind:'region',title:control.section,evidence:'entry-transition'});
    const parent=control.recordStableKey || control.regionId;
    if(control.recordStableKey) nodesById.set(parent,{...nodesById.get(parent),
      id:parent,parentId:control.regionId,kind:'record',position:control.recordIndex ?? 0,evidence:'entry-transition'});
    nodesById.set(control.stableKey,{...nodesById.get(control.stableKey),id:control.stableKey,parentId:parent,
      kind:control.observed?.field ? 'field' : 'entry',label:control.label,operations:control.operations || []});
  }
  const nodes=[...nodesById.values()];
  const ids=new Set(regionId ? [regionId] : []);
  let changed=true;
  while(changed) {
    changed=false;
    for(const node of nodes) if(ids.has(node.parentId) && !ids.has(node.id)) {
      ids.add(node.id);changed=true;
    }
  }
  return nodes.filter(node=>regionId ? ids.has(node.id) : node.kind==='region');
}
