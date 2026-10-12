// 权限判断使用动作目标的自身语义；字段提示和校验文案属于观察内容。
export const actionKey = control => control?.stableKey || control?.index;
const compact = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const questionKey=value=>compact(value).replace(/[?？]+$/,'');
const FINAL_ACTION = /^(?:(?:保存|确认|立即|预览)(?:并|后|并且)?)?(?:提交(?:简历|申请|投递)?|投递(?:简历|职位)?|申请职位|立即申请|确认申请|确认投递|submit(?:application|resume)?|apply(?:now)?|sendapplication)$/i;
const DESTRUCTIVE_ACTION = /^(?:确认)?(?:删除.*|移除.*|清空.*|重置.*|撤回.*|注销.*|退出登录|delete.*|remove.*|reset.*|withdraw.*|logout)$/i;
const AGREEMENT = /同意.*(?:协议|隐私|政策|条款|声明)|(?:协议|隐私政策|真实性声明|背景调查授权)|terms of|privacy policy/i;

export function excludedByUser(control,resume,url) {
  let host='';try {host=new URL(url).hostname;} catch {}
  return (resume?.fillPolicy?.sitePolicies || []).some(policy=>(!policy.host || policy.host===host) &&
    ((policy.excludedSections || []).some(section=>compact(section)===compact(control.section)) ||
      (policy.excludedQuestions || []).some(question=>questionKey(question)===questionKey(control.questionLabel || control.label))));
}

export function userCorrection(control,resume,url) {
  let host='';try {host=new URL(url).hostname;} catch {}
  return (resume?.fillPolicy?.sitePolicies || []).filter(policy=>!policy.host || policy.host===host)
    .flatMap(policy=>policy.corrections || []).find(rule=>
      questionKey(rule.question)===questionKey(control.questionLabel || control.label));
}

export function actionPermission(control, operation = 'CLICK', {agreementConfirmed = false} = {}) {
  const label = compact(control?.actionLabel || control?.label);
  if (/内推码|推荐码|referralcode|referral_code/i.test([control?.label,control?.name].join(' '))) {
    return {allowed:false,reason:'内推码保持原状'};
  }
  if (control?.disabled || control?.observed?.disabled) return {allowed:false,reason:'目标已禁用'};
  const field = control?.observed?.field === true || control?.questionLabel ||
    ['textbox','combobox','radio','checkbox'].includes(control?.role) ||
    /input|textarea|select|date|radio|checkbox|file|richtext|observed-field/.test(control?.kind || '');
  if (!field && FINAL_ACTION.test(label)) return {allowed:false,reason:'最终投递由用户完成'};
  if (!field && DESTRUCTIVE_ACTION.test(label)) return {allowed:false,reason:'自动填写保留已有记录'};
  if (field && AGREEMENT.test([control?.section,control?.questionLabel || control?.label].join(' ')) && !agreementConfirmed) {
    return {allowed:false,reason:'协议需要本次明确授权',permissionRequired:true};
  }
  return {allowed:true};
}

export function hasCommittedValue(control) {
  if (control?.valueCommitted === false) return false;
  if (/radio|checkbox/.test(`${control?.kind} ${control?.role}`)) return control.checked === true;
  const value = String(control?.value ?? '').trim();
  // 日期范围以两个端点共同完成；已选端点继续作为记录归属和执行保护证据。
  if (control?.fieldProtocol==='date-range' || control?.kind==='feishu-date-range') {
    return /^\d{4}-\d{1,2}\s*-\s*(?:\d{4}-\d{1,2}|至今)$/.test(value);
  }
  return !!value && value !== control.placeholder &&
    !(value==='分' && /成绩|分数|得分/.test(control?.label || control?.questionLabel || '')) &&
    !(control?.observed?.readonly && compact(value)===compact(control.questionLabel || control.label)) &&
    // 旧式表单把提示写进 value；仅匹配短促的字段提示，描述正文继续保留。
    !(/^输入.{1,16}$/.test(value) && /号码|名称|姓名|邮箱|电话|学校|院校|地址|内容/.test(value)) &&
    !/^(?:字数(?:控制|限制)?(?:在|为)?|限|最多|不超过)\s*\d+\s*(?:个)?(?:汉字|字|字符)(?:以内|内)?$/.test(value) &&
    !/^(?:附件|文件).{0,12}(?:只支持|支持|大小|格式)|^.{0,20}请(?:从|填写|输入|选择).{0,80}(?:描述|以内|内容|信息)/.test(value) &&
    !/^(?:请选择|请输入|请填写|未选择|未填写|上传|年$|月$|日$|YYYY|MM$|DD$|--|—)/i.test(value);
}

export function choiceGroup(control) {
  return control?.choiceGroup || control?.name || control?.fieldGroup || control?.questionLabel || actionKey(control);
}

export function choiceAlreadySelected(control, controls) {
  if (!/radio/.test(`${control?.kind} ${control?.role}`)) return false;
  return controls.some(peer => /radio/.test(`${peer.kind} ${peer.role}`) && peer.checked === true &&
    peer.section === control.section && choiceGroup(peer) === choiceGroup(control));
}

export function alternativeChoiceSatisfied(control, controls) {
  if (!/checkbox/.test(`${control?.kind} ${control?.role}`) || control.checked === true ||
      !/^(?:其他|其它|other)$/i.test(compact(control.optionLabel || control.observed?.option))) return false;
  const question=control.questionLabel || control.label;
  return controls.some(peer=>peer!==control && peer.section===control.section &&
    (peer.questionLabel || peer.label)===question &&
    (peer.recordStableKey || peer.recordIndex)===(control.recordStableKey || control.recordIndex) &&
    /^(?:input|textarea|richtext|combobox|custom-select|native-select|observed-field)$/.test(peer.kind || '') &&
    hasCommittedValue(peer));
}

export function isValueTarget(control) {
  return control?.observed?.field === true ||
    ['textbox','combobox','checkbox','radio'].includes(control?.role) ||
    /^(?:input|textarea|richtext|combobox|custom-select|native-select|.*date.*|feishu-year|file|.*radio|.*checkbox|observed-field)$/.test(control?.kind || '');
}

export function isEntryTarget(control) {
  return !isValueTarget(control) && (control?.kind === 'section-entry' ||
    /^(?:\+\s*)?(?:填写|新增|添加|增加|编辑|修改|完善|展开|打开)|^(?:add|edit|open)\b/i.test(String(control?.label || '').trim()));
}
