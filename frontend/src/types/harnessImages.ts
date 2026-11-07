import contract from './harnessImageContract.json';

/** AWU 资源预算，不代表当前路由支持图片，也不授予提交资格。 */
export const HARNESS_IMAGE_CONTRACT = Object.freeze({
  ...contract,
  formats: Object.freeze([...contract.formats]),
  limits: Object.freeze({ ...contract.limits }),
});

export type HarnessImageLimits = typeof HARNESS_IMAGE_CONTRACT.limits;
export interface HarnessImageExtension {
  version: number;
  bridgeVersion: number;
  limits: HarnessImageLimits;
}

/** 缺扩展或混用限额时拒绝；能力、身份和本次准入仍由执行器另外核对。 */
export function matchesHarnessImageExtension(value: unknown): value is HarnessImageExtension {
  if (!value || typeof value !== 'object') return false;
  const extension = value as Partial<HarnessImageExtension>;
  if (extension.version !== HARNESS_IMAGE_CONTRACT.version || extension.bridgeVersion !== HARNESS_IMAGE_CONTRACT.bridgeVersion
      || !extension.limits || typeof extension.limits !== 'object') return false;
  return Object.keys(extension.limits).length === Object.keys(HARNESS_IMAGE_CONTRACT.limits).length
    && Object.entries(HARNESS_IMAGE_CONTRACT.limits).every(([key, limit]) =>
      extension.limits![key as keyof HarnessImageLimits] === limit);
}
