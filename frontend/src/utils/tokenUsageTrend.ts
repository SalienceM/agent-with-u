export interface DirectionalTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type TokenDirection = 'input' | 'output' | 'total';

export function tokenCount(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

export function directionalTokens(event: DirectionalTokenUsage | undefined, direction: TokenDirection): number {
  const input = tokenCount(event?.inputTokens);
  const output = tokenCount(event?.outputTokens);
  return direction === 'input' ? input : direction === 'output' ? output : input + output;
}

function trendText(values: number[]): string {
  if (values.length < 4) return '数据积累中';
  const split = Math.floor(values.length / 2);
  const before = values.slice(0, split).reduce((sum, value) => sum + value, 0) / split;
  const afterValues = values.slice(split);
  const after = afterValues.reduce((sum, value) => sum + value, 0) / afterValues.length;
  if (!before) return after ? '近期从零上升' : '近期基本平稳';
  const change = Math.round(((after - before) / before) * 100);
  if (Math.abs(change) < 10) return '近期基本平稳';
  return change > 0 ? `近期上升 ${change}%` : `近期下降 ${Math.abs(change)}%`;
}

export function tokenTrendStats(events: DirectionalTokenUsage[], direction: TokenDirection) {
  const recent = events.slice(-6).map(event => directionalTokens(event, direction));
  return {
    latest: directionalTokens(events.at(-1), direction),
    average: recent.length ? Math.round(recent.reduce((sum, value) => sum + value, 0) / recent.length) : 0,
    peak: Math.max(0, ...events.slice(-16).map(event => directionalTokens(event, direction))),
    trend: trendText(recent),
  };
}
