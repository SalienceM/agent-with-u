import type { ProjectBranchGraphData } from '../types/taskWorkspaces';

/** 拓扑次序决定横坐标；只沿真实 first-parent 分配轨道，所有父提交均保留边。 */
export function layoutBranchGraph(data: ProjectBranchGraphData) {
  const commits = new Map(data.commits.map(commit => [commit.hash, commit]));
  const lanes = new Map<string, number>();
  let nextLane = 0;
  const walk = (hash: string, lane: number) => {
    while (commits.has(hash) && !lanes.has(hash)) {
      lanes.set(hash, lane); hash = commits.get(hash)!.parents[0];
    }
  };
  for (const branch of data.branches) if (branch.head && commits.has(branch.head) && !lanes.has(branch.head)) walk(branch.head, nextLane++);
  for (const commit of data.commits) if (!lanes.has(commit.hash)) walk(commit.hash, nextLane++);
  const nodes = [...data.commits].reverse().map((commit, index) => ({ ...commit,
    x: 70 + index * 74, y: 44 + lanes.get(commit.hash)! * 58, lane: lanes.get(commit.hash)! }));
  const byHash = new Map(nodes.map(node => [node.hash, node]));
  const edges = nodes.flatMap(node => node.parents.map(parent => ({ child: node, parent: byHash.get(parent), parentHash: parent })));
  return { nodes, edges, width: Math.max(300, nodes.length * 74 + 80), height: Math.max(120, nextLane * 58 + 50) };
}
