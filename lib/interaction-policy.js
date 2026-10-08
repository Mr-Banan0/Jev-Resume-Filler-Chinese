// 弹窗、调度器和诊断共用策略默认值；用户可显式切换原适配策略进行对照。
export const OBSERVED_POLICY = 'observed';
export const ADAPTED_POLICY = 'adapted';
export const DEFAULT_INTERACTION_POLICY = OBSERVED_POLICY;

export function resolveInteractionPolicy(value) {
  return value === ADAPTED_POLICY ? ADAPTED_POLICY : DEFAULT_INTERACTION_POLICY;
}
