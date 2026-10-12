// 资料组合由代码完成；Jev 选择语义用途，执行器接收可回读的确定值。
export const monthValue=value=>{
  const match=String(value ?? '').match(/^(\d{4})-(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2,'0')}` : '';
};

export function dateRangeValue(record={}) {
  const start=monthValue(record.startDate);
  const ongoing=/^(?:至今|present|current)$/i.test(String(record.endDate || ''));
  const end=ongoing ? '至今' : monthValue(record.endDate);
  return start && end ? `${start} - ${end}` : '';
}

export function dateRangeMatches(actual,desired) {
  const parts=value=>String(value || '').match(/\d{4}-\d{1,2}|至今/g)?.map(part=>part==='至今'?part:monthValue(part));
  const a=parts(actual),b=parts(desired);
  return a?.length===2 && b?.length===2 && a.every((part,index)=>part===b[index]);
}

const FACT_LABELS={name:'名称',title:'名称',institution:'学校',company:'单位',organization:'组织',
  position:'职务',date:'日期',startDate:'开始时间',endDate:'结束时间',level:'级别',grade:'等级',
  award:'奖项',rank:'名次',prize:'奖项等级',description:'内容',summary:'简介',details:'详情',
  language:'语言',certificate:'证书',score:'成绩',proficiency:'熟练程度',fluency:'熟练程度',siteFluency:'网页熟练程度',
  number:'编号',hours:'时长',serviceHours:'志愿服务时长',items:'技能内容',category:'类别',
  authorOrder:'作者顺序',coAuthorship:'署名方式',journal:'刊物',publicationDetails:'发表情况',
  type:'类型',zone:'分区',qualification:'语言资格',skill:'技能',techStack:'技术栈'};
const SKILL_FACT_LABELS={name:'技能名称',level:'熟练程度'};
const availableFact=(key,value)=>value!=null && value!=='' &&
  !/Short$|Fallback$|^id$|^isPresent$|^dataUrl$|^base64$|^blob$/.test(key);
function summaryFacts(value,labels) {
  if(Array.isArray(value)) return value.map(item=>summaryFacts(item,labels)).filter(Boolean).join('、');
  if(value && typeof value==='object') return Object.entries(value)
    .filter(([key,item])=>availableFact(key,item))
    .map(([key,item])=>{
      const text=summaryFacts(item,labels);
      return text ? `${labels[key] || key}：${text}` : '';
    }).filter(Boolean).join('；');
  return value==null ? '' : String(value);
}
export function collectionSummary(records,block) {
  const labels=/^(?:skills|computerSkills|professionalSkills)$/.test(block) ?
    {...FACT_LABELS,...SKILL_FACT_LABELS} : FACT_LABELS;
  return records.map((record,index)=>{
    if(typeof record!=='object' || record===null) return `${index+1}. ${String(record ?? '')}`;
    return `${index+1}. ${summaryFacts(record,labels)}`;
  }).join('\n');
}

export function sourceContracts(fields,resume,block,index,{summaryScope=false,referenceDate}={}) {
  const result=[...fields];
  const records=Array.isArray(resume?.[block])?resume[block]:[resume?.[block]];
  const record=records[index] || {};
  const range=dateRangeValue(record);
  if(range) result.push({path:`@range:${block}[${index}]`,value:range,label:'完整起止时间（开始年月至结束年月／至今）',
    contract:'date-range',sources:[`${block}[${index}].startDate`,`${block}[${index}].endDate`]});
  if(summaryScope && records.length) result.push({path:`@summary:${block}`,value:collectionSummary(records,block),
    label:`${block} 全部记录的已有事实汇总（未提供属性保留空白）`,contract:'collection-summary',
    sources:records.map((_,i)=>`${block}[${i}]`)});
  if(summaryScope && records.length>1) records.forEach((item,i)=>result.push({path:`@summary:${block}[${i}]`,
    value:collectionSummary([item],block),label:`${block} 第 ${i+1} 条记录的已有事实汇总`,
    contract:'record-summary',sources:[`${block}[${i}]`]}));
  if(block==='education') {
    const gpa=record.gpa,ranking=record.ranking || record.rank;
    if(gpa && ranking) result.push({path:`@academic:${block}[${index}]`,
      value:`成绩：${gpa}；排名：${ranking}`,label:'本条教育经历的成绩及排名',
      contract:'academic-results',sources:[`${block}[${index}].gpa`,`${block}[${index}].${record.ranking?'ranking':'rank'}`]});
  }
  if(block==='basics' && /^\d{4}-\d{2}-\d{2}$/.test(record.birthDate || '')) {
    const day=String(referenceDate || new Date().toISOString().slice(0,10)).slice(0,10);
    const birth=record.birthDate,age=Number(day.slice(0,4))-Number(birth.slice(0,4))-(day.slice(5)<birth.slice(5)?1:0);
    if(age>=0 && age<130) result.push({path:'@derived:basics.age',value:String(age),label:'周岁年龄（按出生日期与本次日期计算）',
      contract:'derived-age',sources:['basics.birthDate'],referenceDate:day});
  }
  return result;
}

// 同一字段、来源、动作和局部状态的重试上限；弹层导航变化会形成新的状态。
export function interactionAttemptKey(action,elements) {
  const root=elements.find(control=>(control.stableKey || control.index)===action.controlStableKey);
  const target=elements.find(control=>control.index===action.target);
  const popup=elements.filter(control=>control.context==='popup' && control.popupOwnerKey===action.controlStableKey)
    .map(control=>[control.label,control.value,control.popupSelection,control.observed?.scrollableAncestor?.top]);
  return JSON.stringify([action.controlStableKey,action.resumeField,action.operation,action.label,
    action.optionIntent,action.direction,action.resolvedValue ?? action.value,root?.value,root?.validationError,
    target?.label,popup]);
}
