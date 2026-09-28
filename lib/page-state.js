// 页面状态由可观察证据确定。登录/职位页先交还用户，避免把导航误当表单字段。
export function classifyPageState(page = {}, elements = []) {
  const text = String(page.text || '');
  const url = String(page.url || '');
  const authNotice = page.authRequired || /尚未登录|登录时间过长|登录已过期|登录失效|请重新登录|扫码登录/.test(text);
  const editableForm = elements.filter(el => el.context !== 'popup' &&
    (el.operations || []).some(op => ['TYPE_TEXT','SELECT','UPLOAD_FILE','PICK_DATE'].includes(op)));
  const restoredValues = editableForm.filter(el => String(el.value || '').trim()).length;
  // 招聘页可能把旧的登录提示留在已恢复的表单底部。允许继续填写并在网站
  // “保存”时核验会话；空白页或真正的登录页仍要求用户先登录。
  if (authNotice && restoredValues < 2) {
    return {kind:'auth-required', reason:'招聘网站要求重新登录或扫码登录'};
  }
  if (/当前模块还未保存|是否要保存当前模块信息|保存并跳转/.test(text)) {
    return {kind:'unsaved-confirmation', reason:'当前分区出现未保存跳转提示，已停止跨分区操作'};
  }
  const editable = editableForm;
  if (!editable.length && /posDetail|jobDetail|job-detail/i.test(url) &&
      /立即投递|申请职位|投递简历/.test(text)) {
    return {kind:'job-detail', reason:'当前是职位详情页，尚未进入简历编辑页'};
  }
  return {kind:editable.length ? 'form' : 'navigation', reason:''};
}
