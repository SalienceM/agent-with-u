import type { SessionBranchTip } from '../types/taskWorkspaces';

export interface BranchBadge { label: string; detail: string; tone: 'muted' | 'warning' | 'good' }

const usable = (tip: SessionBranchTip) => tip.state === 'known' && !tip.busy
  && Number.isInteger(tip.ahead) && tip.ahead! >= 0 && Number.isInteger(tip.behind) && tip.behind! >= 0 && typeof tip.dirty === 'boolean';

/** 合并回执不参与投影；只根据完整且同主干快照的当前成员计算。 */
export function projectBranchBadges(tips: SessionBranchTip[], checkedAt: number): Map<string, BranchBadge> {
  const result = new Map<string, BranchBadge>();
  const main = tips.find(tip => tip.main);
  if (!main) return result;
  const children = tips.filter(tip => !tip.main);
  const time = new Date(checkedAt * 1000).toLocaleTimeString();
  for (const tip of tips) {
    if (!usable(tip) || !usable(main)) {
      result.set(tip.sessionId, { label: tip.busy ? '运行/编辑中 · 待核对' : '状态待核对', detail: tip.notice || '当前工作区无法核对，不能判断为最新', tone: 'muted' });
      continue;
    }
    let label: string, tone: BranchBadge['tone'] = 'warning';
    let detail = `相对 ${main.title}：待合入 ${tip.ahead} 个提交，待同步 ${tip.behind} 个提交。`;
    if (tip.main) {
      const pending = children.filter(child => usable(child) && child.ahead! > 0).length;
      const unknown = children.some(child => !usable(child));
      const dirty = children.filter(child => child.dirty).length;
      label = pending ? `${pending} 个分支待合并${unknown ? ' · 部分待核对' : ''}`
        : unknown ? '部分分支待核对' : dirty ? `${dirty} 个分支未提交` : '最新 · 分支均已合入';
      detail = `当前 ${children.length} 个副本中，${pending} 个有待合入提交，${dirty} 个有未提交文件。${unknown ? '部分成员未知，未判断全项目最新。' : ''}`;
      if (!pending && !unknown && !dirty) tone = 'good';
    } else {
      label = tip.ahead && tip.behind ? '待合并 · 待同步' : tip.ahead ? '待合并' : tip.behind ? '待同步' : '已同步';
      if (!tip.ahead && !tip.behind) tone = 'good';
    }
    if (tip.dirty) { label = tone === 'good' ? '有未提交改动' : `${label} · 未提交`; tone = 'warning'; }
    result.set(tip.sessionId, { label, detail: `${detail}${tip.dirty ? '当前工作区还有未提交文件。' : ''} 核对于 ${time}。`, tone });
  }
  return result;
}
