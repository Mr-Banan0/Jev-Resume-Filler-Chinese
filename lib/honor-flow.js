export const HONOR_OVERVIEW_PATH = '/mc/deliver/resumerDetail';

const SECTIONS = [
  ['语言能力', resume => resume.languages],
  ['获奖经历', resume => resume.awards],
  ['荣耀亲属', () => [{}]],
  ['工作经历', resume => resume.work?.length ? resume.work : resume.internship],
  ['项目经验', resume => resume.projects],
  ['专业技能', resume => resume.professionalSkills],
  ['论文著作', resume => resume.publications],
  ['个人专利', resume => resume.patents],
  ['专业资格认证', resume => resume.certificates],
  ['培训经历', resume => resume.training],
  ['计算机能力', resume => resume.computerSkills],
  ['教育经历', resume => resume.education],
  ['个人基本信息', () => [{}]]
];

export function honorSections(resume, observedEntries) {
  const observed = new Set(observedEntries.filter(entry => entry.kind === 'section-entry').map(entry => entry.label));
  return SECTIONS.filter(([name]) => observed.has(name)).map(([name, select]) => ({
    name, records: select(resume) || []
  }));
}

export function recordIdentity(record) {
  return [record.title, record.institution, record.name, record.company,
    record.language, record.number, record.area].filter(Boolean);
}

export function savedAt(text) {
  return String(text || '').match(/自动保存于\s*\d{1,2}:\d{2}/)?.[0] || '';
}
