// 验证“完整动作候选”构造：代码负责字段绑定和安全边界，Jev 只在候选间排序。
const { buildActionPlan, buildSectionPlan, buildQuestions, prepareResume } = await import(
  new URL('../lib/jev-client.js', import.meta.url)
);

const resume = {
  basics: {
    name: '测试姓名',
    gender: '女',
    birthDate: '2001-09-08',
    phone: '13800138000',
    email: 'test@example.com',
    nativePlace: '浙江省南京市',
    highestDegree: '本科'
  },
  education: [
    { institution: '第一学校', area: '软件工程', studyType: '本科', startDate: '2019-09', endDate: '2023-06' },
    { institution: '第二学校', area: '计算机科学', studyType: '硕士', startDate: '2023-09', endDate: '2026-06' }
  ]
};

const GOAL = 'Fill the current section of the job application resume form with local resume data.';
const actionFor = (plan, target, field) => plan.actions.find((a) => a.target === target && a.resumeField === field);
const preparedLocation = prepareResume({
  basics:{location:{city:'南京'}},
  expected:{city:'南京'},
  application:{interviewSite:'南京'}
});
const applicationPlan = buildActionPlan([
  {index:'site',section:'申请信息',kind:'custom-select',label:'校招面试站点',value:'',operations:['CLICK']},
  {index:'city',section:'申请信息',kind:'custom-select',label:'选择意向工作城市',value:'',operations:['CLICK']}
], preparedLocation, [], {title:'申请信息'});

// 荣耀：文本输入 + 自定义下拉；最终投递控件始终不进入候选。
const honorElements = [
  { index: 'f0_1', role: 'textbox', kind: 'input', label: '请填写姓名', value: '', operations: ['TYPE_TEXT'] },
  { index: 'f0_2', role: 'textbox', kind: 'input', label: '请填写个人邮箱', value: '', operations: ['TYPE_TEXT'] },
  { index: 'f0_3', role: 'combobox', kind: 'custom-select', label: '性别', value: '', operations: ['CLICK'] },
  { index: 'f0_4', role: 'button', kind: 'action', label: '提交简历', value: '', operations: ['CLICK'] },
  { index: 'f0_5', role: 'textbox', kind: 'richtext', label: '个人成就', value: '', operations: ['TYPE_TEXT'], offscreen: true }
];
const honorPlan = buildActionPlan(honorElements, resume);
const honorQuestions = buildQuestions(GOAL, honorPlan);

// 字节：单页原生控件已经填好时，计划应报告完成；“提交简历”不参与判断。
const byteElements = [
  { index: 'f0_1', role: 'textbox', kind: 'input', label: '姓名', value: '测试姓名', operations: ['TYPE_TEXT'] },
  { index: 'f0_2', role: 'textbox', kind: 'input', label: '邮箱', value: 'test@example.com', operations: ['TYPE_TEXT'] },
  { index: 'f0_3', role: 'combobox', kind: 'native-select', label: '学历', value: '本科', operations: ['SELECT'], options: [{ index: 'f0_3:1', label: '本科', value: 'undergraduate' }] },
  { index: 'f0_4', role: 'button', kind: 'action', label: '提交简历', value: '', operations: ['CLICK'] }
];
const bytePlan = buildActionPlan(byteElements, resume);

// 虎牙 Moka：级联选择入口和两段教育经历的同名字段。
const huyaElements = [
  { index: 'f0_1', role: 'combobox', kind: 'custom-select', label: '性别', value: '', operations: ['CLICK'] },
  { index: 'f0_2', role: 'combobox', kind: 'combobox', label: '籍贯', value: '', operations: ['CLICK'] },
  { index: 'f0_3', role: 'textbox', kind: 'input', label: '学校名称', value: '', operations: ['TYPE_TEXT'] },
  { index: 'f0_4', role: 'textbox', kind: 'input', label: '学校名称', value: '', operations: ['TYPE_TEXT'] },
  { index: 'f0_5', role: 'combobox', kind: 'native-select', label: '入学年份', value: '', operations: ['SELECT'], options: [{ index: 'f0_5:1', label: '2019', value: '2019' }] },
  { index: 'f0_6', role: 'button', kind: 'action', label: '预览并提交', value: '', operations: ['CLICK'] }
];
const huyaPlan = buildActionPlan(huyaElements, resume);

// 不完整出生日期和扁平地址不能驱动三列日期/级联地址 picker。
const incompletePickerResume = {
  basics: { birthDate: '2001-09', nativePlace: '浙江省南京市' }
};
const unsafePickerPlan = buildActionPlan([
  { index: 'f0_1', role: 'combobox', kind: 'custom-select', label: '出生日期', value: '', operations: ['CLICK'] },
  { index: 'f0_2', role: 'combobox', kind: 'custom-select', label: '籍贯', value: '', operations: ['CLICK'] }
], incompletePickerResume);

// 视口外字段保留在计划中；执行层会对目标调用 scrollIntoView 后再写入。
const offscreenPlan = buildActionPlan([
  { index: 'f0_1', role: 'textbox', kind: 'input', label: '邮箱', value: '', operations: ['TYPE_TEXT'], offscreen: true }
], resume);

// 当前分区满足后，只生成向前的分区动作。
const sectionPlan = buildActionPlan([
  { index: 'f0_1', role: 'textbox', kind: 'input', label: '姓名', value: '测试姓名', operations: ['TYPE_TEXT'] },
  { index: 'f0_2', role: 'button', kind: 'action', label: '上一步', value: '', operations: ['CLICK'] },
  { index: 'f0_3', role: 'button', kind: 'action', label: '下一步', value: '', operations: ['CLICK'] }
], resume);

// 选择器打开后，浮层选项绑定到刚刚打开的字段，避免“本科 / 2024”一类值跨经历串位。
const popupPlan = buildActionPlan([
  { index: 'f0_9', role: 'option', kind: 'option-item', context: 'popup', label: '女', value: '', operations: ['CLICK'] }
], resume, [{ kind: 'click', resumeField: 'basics.gender' }]);

// 荣耀 picker 需要先选值再点“确定”。弹层存在时，候选必须锁定在这段事务内。
const pickerValuePlan = buildActionPlan([
  { index: 'f0_16', role: 'option', kind: 'option-item', context: 'popup', label: '女', value: '', operations: ['CLICK'] },
  { index: 'f0_17', role: 'option', kind: 'option-item', context: 'popup', label: '男', value: '', operations: ['CLICK'] },
  { index: 'f0_18', role: 'option', kind: 'option-item', context: 'popup', label: '确定', value: '', operations: ['CLICK'] },
  { index: 'f0_19', role: 'textbox', kind: 'input', label: '手机', value: '', operations: ['TYPE_TEXT'] }
], resume, [{ kind: 'click', resumeField: 'basics.gender' }]);
const pickerConfirmPlan = buildActionPlan([
  { index: 'f0_16', role: 'option', kind: 'option-item', context: 'popup', label: '女', value: '', operations: ['CLICK'] },
  { index: 'f0_18', role: 'option', kind: 'option-item', context: 'popup', label: '确定', value: '', operations: ['CLICK'] }
], resume, [{ kind: 'click', context: 'popup', resumeField: 'basics.gender', label: '女' }]);

// 站内规则：勾选招聘协议；“亲属是否在本公司工作”统一选否。
const formRulePlan = buildActionPlan([
  { index: 'f0_21', role: 'checkbox', kind: 'checkbox', label: '我已阅读并同意招聘服务用户协议和隐私政策', value: '', checked: false, operations: ['CLICK'], formRuleSignals: ['agreement'] },
  { index: 'f0_22', role: 'radio', kind: 'radio', label: '是', optionValue: '是', checked: false, operations: ['CLICK'], formRuleSignals: ['relative-employment'] },
  { index: 'f0_23', role: 'radio', kind: 'radio', label: '否', optionValue: '否', checked: false, operations: ['CLICK'], formRuleSignals: ['relative-employment'] },
  { index: 'f0_24', role: 'button', kind: 'action', label: '提交简历', value: '', operations: ['CLICK'] }
], resume);
const relativePickerPlan = buildActionPlan([
  { index: 'f0_25', role: 'option', kind: 'option-item', context: 'popup', label: '是', value: '', operations: ['CLICK'] },
  { index: 'f0_26', role: 'option', kind: 'option-item', context: 'popup', label: '否', value: '', operations: ['CLICK'] },
  { index: 'f0_27', role: 'option', kind: 'option-item', context: 'popup', label: '确定', value: '', operations: ['CLICK'] }
], resume, [{ kind: 'click', formRule: 'relative-employment-no' }]);
const relativePickerConfirmPlan = buildActionPlan([
  { index: 'f0_27', role: 'option', kind: 'option-item', context: 'popup', label: '确定', value: '', operations: ['CLICK'] }
], resume, [{ kind: 'click', context: 'popup', formRule: 'relative-employment-no', label: '否' }]);
const formRuleDonePlan = buildActionPlan([
  { index: 'f0_28', role: 'checkbox', kind: 'checkbox', label: '我已阅读并同意招聘服务用户协议', value: '', checked: true, operations: ['CLICK'], formRuleSignals: ['agreement'] },
  { index: 'f0_29', role: 'radio', kind: 'radio', label: '否', optionValue: '否', checked: true, operations: ['CLICK'], formRuleSignals: ['relative-employment'] }
], resume);
const adjustmentPlan = buildActionPlan([
  { index: 'f0_40', role: 'radio', kind: 'radio', label: '否', optionValue: '否', checked: false, operations: ['CLICK'], formRuleSignals: ['job-adjustment'] },
  { index: 'f0_41', role: 'radio', kind: 'radio', label: '是', optionValue: '是', checked: false, operations: ['CLICK'], formRuleSignals: ['job-adjustment'] }
], resume);
const adjustmentPickerPlan = buildActionPlan([
  { index: 'f0_42', role: 'option', kind: 'option-item', context: 'popup', label: '否', value: '', operations: ['CLICK'] },
  { index: 'f0_43', role: 'option', kind: 'option-item', context: 'popup', label: '是', value: '', operations: ['CLICK'] }
], resume, [{ kind: 'click', formRule: 'job-adjustment-yes' }]);
const confirmationPlan = buildActionPlan([
  { index: 'f0_44', role: 'checkbox', kind: 'checkbox', label: '上述已知悉并确认', value: '', checked: false, operations: ['CLICK'] }
], resume);

const photoResume = {basics:{photo:{name:'头像.png',type:'image/png',dataUrl:'data:image/png;base64,AA=='}}};
const photoControl = {index:'f0_30',role:'button',kind:'file',section:'上传',label:'上传照片',value:'',operations:['UPLOAD_FILE']};
const photoPlan = buildActionPlan([photoControl], photoResume, [], {title:'微众银行 - 校园招聘'});
const uploadedPhotoPlan = buildActionPlan([photoControl], photoResume,
  [{kind:'upload_file',resumeField:'basics.photo'}], {title:'微众银行 - 校园招聘'});
const attachmentResume = {basics:{resumeFile:{name:'简历.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',dataUrl:'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AA=='}}};
const attachmentControl = {index:'f0_31',role:'button',kind:'file',section:'上传',label:'上传简历',value:'',operations:['UPLOAD_FILE']};
const attachmentPlan = buildActionPlan([attachmentControl], attachmentResume, [], {title:'微众银行 - 校园招聘'});
const uploadedAttachmentPlan = buildActionPlan([attachmentControl], attachmentResume,
  [{kind:'upload_file',resumeField:'basics.resumeFile'}], {title:'微众银行 - 校园招聘'});
const countryCodePlan = buildActionPlan([
  {index:'f0_31',role:'textbox',kind:'combobox',section:'个人信息',label:'手机号码',value:'+86',operations:['TYPE_TEXT','CLICK']},
  {index:'f0_32',role:'textbox',kind:'input',section:'个人信息',label:'手机号码',value:'',operations:['TYPE_TEXT']}
], resume, [], {title:'微众银行 - 校园招聘'});
const mokaAddPlan = buildSectionPlan([
  {index:'add-edu',role:'button',kind:'action',section:'教育背景',label:'添加',value:'',operations:['CLICK']},
  {index:'school-1',role:'textbox',kind:'input',section:'教育背景',label:'学校名称',value:'示例大学 A',operations:['TYPE_TEXT']}
], {education:[{institution:'示例大学 A'},{institution:'示例大学 B'}]}, {},
  {title:'微众银行 - 校园招聘',url:'https://app-tc.mokahr.com/apply'});
const mokaLocationAdjustment = buildActionPlan([
  {index:'moka-adjust',role:'textbox',kind:'custom-select',section:'个人信息',
    label:'顾问岗需要接受工作地点调配（北上广深），请问是否可以接受？',value:'',operations:['CLICK']}
], resume, [], {title:'明源云集团 - 校园招聘',url:'https://app.mokahr.com/apply'});
const mokaCityPreference = buildActionPlan([
  {index:'moka-city',role:'textbox',kind:'custom-select',section:'个人信息',
    label:'第一意向工作地点（请勿重复选择，若三个地点重复视为不接受调配）',value:'',operations:['CLICK']}
], resume, [], {title:'明源云集团 - 校园招聘',url:'https://app.mokahr.com/apply'});
const mokaRecruitmentSource = buildActionPlan([
  {index:'moka-source',role:'textbox',kind:'custom-select',section:'个人信息',
    label:'了解到明源云校招的途径 ？',value:'',operations:['CLICK']}
], resume, [], {title:'明源云集团 - 校园招聘',url:'https://app.mokahr.com/apply'});
const mokaEducationRegion = buildActionPlan([
  {index:'moka-region',role:'textbox',kind:'custom-select',section:'个人信息',
    label:'最高学历所在地',value:'',operations:['CLICK']}
], {basics:{highestDegree:'硕士'},education:[{degree:'硕士',institution:'香港示例大学'}]}, [],
  {title:'明源云集团 - 校园招聘',url:'https://app.mokahr.com/apply'});

const criteria = honorQuestions.action?.criteria || {};
const checks = [
  ['荣耀姓名动作绑定本地姓名字段', actionFor(honorPlan, 'f0_1', 'basics.name')?.operation === 'TYPE_TEXT'],
  ['荣耀邮箱动作绑定本地邮箱字段', actionFor(honorPlan, 'f0_2', 'basics.email')?.operation === 'TYPE_TEXT'],
  ['荣耀自定义性别字段生成点击入口', actionFor(honorPlan, 'f0_3', 'basics.gender')?.operation === 'CLICK'],
  ['最终投递控件未进入荣耀候选', !honorPlan.actions.some((a) => a.target === 'f0_4')],
  ['个人成就不再复用自我介绍字段', !honorPlan.actions.some((a) => a.target === 'f0_5')],
  ['Jev 只接收一个完整动作问题', Object.keys(honorQuestions).length === 1 && !!honorQuestions.action],
  ['每个普通候选包含动作、目标与字段绑定', Object.values(criteria).every((a) => a.operation && a.target && a.resume_field)],
  ['候选中没有 BLOCKED / DONE 等模型终止操作', !JSON.stringify(criteria).match(/BLOCKED|\bDONE\b/)],
  ['候选摘要不包含简历具体值', !JSON.stringify(criteria).includes('测试姓名') && !JSON.stringify(criteria).includes('test@example.com')],
  ['已填写的字节字段被判定完成', bytePlan.status === 'done' && bytePlan.actions.length === 0],
  ['最终投递控件不会妨碍完成判定', bytePlan.summary.mappedControls === 3],
  ['虎牙性别级联入口绑定性别字段', actionFor(huyaPlan, 'f0_1', 'basics.gender')?.operation === 'CLICK'],
  ['虎牙籍贯级联入口绑定籍贯字段', actionFor(huyaPlan, 'f0_2', 'basics.nativePlace')?.operation === 'CLICK'],
  ['重复教育字段依 DOM 顺序分别绑定第一、第二段经历',
    actionFor(huyaPlan, 'f0_3', 'education[0].institution')?.operation === 'TYPE_TEXT' &&
    actionFor(huyaPlan, 'f0_4', 'education[1].institution')?.operation === 'TYPE_TEXT'],
  ['虎牙入学年份选择器绑定派生年份字段', actionFor(huyaPlan, 'f0_5:1', 'education[0].startDate.year')?.operation === 'SELECT'],
  ['虎牙最终投递控件未进入候选', !huyaPlan.actions.some((a) => a.target === 'f0_6')],
  ['国家区号不会被本地手机号覆盖',
    !countryCodePlan.actions.some((a) => a.target === 'f0_31') && actionFor(countryCodePlan, 'f0_32', 'basics.phone')?.operation === 'TYPE_TEXT'],
  ['Moka 按本地条数由分区计划器新增后续教育记录',
    mokaAddPlan.actions.some((a) => a.target === 'add-edu' && a.operation === 'ADD_RECORD')],
  ['工作地点调配按用户设定选择是',
    mokaLocationAdjustment.actions.some((a) => a.target === 'moka-adjust' && a.formRule === 'job-adjustment-yes')],
  ['意向工作地点不复用岗位调配的“是”',
    !mokaCityPreference.actions.some((a) => a.target === 'moka-city' && a.formRule === 'job-adjustment-yes')],
  ['校招途径绑定招聘信息来源',
    mokaRecruitmentSource.actions.some((a) => a.target === 'moka-source' && a.formRule === 'recruitment-source')],
  ['有香港高校证据时最高学历所在地选海外',
    mokaEducationRegion.actions.some((a) => a.target === 'moka-region' && a.formRule === 'highest-education-region' && a.value === '海外')],
  ['视口外字段仍保留填写候选', actionFor(offscreenPlan, 'f0_1', 'basics.email')?.operation === 'TYPE_TEXT'],
  ['视口外字段保持填写动作，执行层负责定位目标', !offscreenPlan.actions.some((a) => a.operation === 'SCROLL_DOWN')],
  ['当前分区满足后只生成向前的下一步动作',
    sectionPlan.actions.some((a) => a.target === 'f0_3') && !sectionPlan.actions.some((a) => a.target === 'f0_2')],
  ['打开选择器后浮层选项绑定刚打开的性别字段', actionFor(popupPlan, 'f0_9', 'basics.gender')?.operation === 'CLICK'],
  ['打开荣耀 picker 后只提供匹配值选项', pickerValuePlan.actions.filter(a=>a.intent!=='RETURN').length === 1 && actionFor(pickerValuePlan, 'f0_16', 'basics.gender')?.operation === 'CLICK'],
  ['选值后只提供 picker 内确定动作', pickerConfirmPlan.actions.filter(a=>a.intent!=='RETURN').length === 1 && actionFor(pickerConfirmPlan, 'f0_18', 'basics.gender')?.operation === 'CLICK'],
  ['缺少出生日时不打开日期 picker', !unsafePickerPlan.actions.some((a) => a.target === 'f0_1')],
  ['扁平籍贯不驱动级联地点 picker', !unsafePickerPlan.actions.some((a) => a.target === 'f0_2')]
  ,['协议勾选框生成站内规则动作', actionFor(formRulePlan, 'f0_21')?.formRule === 'agreement']
  ,['亲属题只为“否”生成站内规则动作',
    !formRulePlan.actions.some((a) => a.target === 'f0_22') &&
    actionFor(formRulePlan, 'f0_23')?.formRule === 'relative-employment-no']
  ,['亲属自定义选择器打开后只提供“否”', relativePickerPlan.actions.filter(a=>a.intent!=='RETURN').length === 1 && actionFor(relativePickerPlan, 'f0_26')?.formRule === 'relative-employment-no']
  ,['亲属自定义选择器选值后只提供确定', relativePickerConfirmPlan.actions.filter(a=>a.intent!=='RETURN').length === 1 && actionFor(relativePickerConfirmPlan, 'f0_27')?.formRule === 'relative-employment-no']
  ,['岗位调剂只为“是”生成站内规则动作',
    !adjustmentPlan.actions.some((a) => a.target === 'f0_40') &&
    actionFor(adjustmentPlan, 'f0_41')?.formRule === 'job-adjustment-yes']
  ,['岗位调剂选择器打开后只提供“是”',
    adjustmentPickerPlan.actions.filter(a=>a.intent!=='RETURN').length === 1 && actionFor(adjustmentPickerPlan, 'f0_43')?.formRule === 'job-adjustment-yes']
  ,['信息确认类勾选框生成协议动作', actionFor(confirmationPlan, 'f0_44')?.formRule === 'agreement']
  ,['规则项已满足时返回完成状态', formRuleDonePlan.status === 'done' && formRuleDonePlan.actions.length === 0]
  ,['照片控件生成本地上传动作', actionFor(photoPlan, 'f0_30', 'basics.photo')?.operation === 'UPLOAD_FILE']
  ,['网站清空 file input 后不重复上传已成功照片', !uploadedPhotoPlan.actions.some(a=>a.operation==='UPLOAD_FILE')]
  ,['简历附件控件生成本地上传动作', actionFor(attachmentPlan, 'f0_31', 'basics.resumeFile')?.operation === 'UPLOAD_FILE']
  ,['网站清空 file input 后不重复上传已成功简历附件', !uploadedAttachmentPlan.actions.some(a=>a.operation==='UPLOAD_FILE')]
  ,['申请信息仅使用明确提供的面试站点与意向城市',
    actionFor(applicationPlan,'site','application.interviewSite')?.operation === 'CLICK' &&
    actionFor(applicationPlan,'city','expected.city')?.operation === 'CLICK']
];

console.log('完整动作候选数（荣耀 / 虎牙）:', honorPlan.actions.length, '/', huyaPlan.actions.length);
console.log('\n=== 完整动作候选断言 ===');
let pass = true;
for (const [name, ok] of checks) {
  if (!ok) pass = false;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
console.log(pass ? '\n✅ 完整动作候选全部断言通过' : '\n❌ 完整动作候选存在失败项');
if (!pass) process.exitCode = 1;
