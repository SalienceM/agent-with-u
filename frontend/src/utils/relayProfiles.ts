/**
 * Relay 预设管理(浏览器 localStorage)。
 *
 * 类似 backends 那样把「常用的中继 + token」存成一个列表,在「连接」面板里
 * 可以点选切换,不用每次重新输 URL 和 token。每个预设是 (label, url, token)
 * 三元组,token 明文存,跟当前 connectionTarget 的存法一致。
 *
 * 注意:跨端不同步——这是 UI 侧的偏好,不放在后端。Tauri 桌面端和浏览器各自
 * 一份。如果要在多设备共享,后续可考虑挪到后端 store。
 */

import type { RelayUserProfile } from '../api';

const STORAGE_KEY = 'awu.relayProfiles';

export interface RelayProfile {
  id: string;
  label: string;
  url: string;
  token: string;
  user?: RelayUserProfile;
  createdAt: number;
}

function genId(): string {
  return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listRelayProfiles(): RelayProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p.id === 'string' && typeof p.url === 'string')
      .map((p) => ({
        id: String(p.id),
        label: String(p.label || p.url),
        url: String(p.url),
        token: String(p.token || ''),
        user: p.user && typeof p.user === 'object' ? p.user as RelayUserProfile : undefined,
        createdAt: Number(p.createdAt || 0),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function writeAll(list: RelayProfile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 配额满或被禁:忽略,功能降级为「不持久化」
  }
}

/**
 * 保存或更新一条预设。
 *
 * - 不带 id:新建,按 (url+token) 做幂等去重——同样的中继重复存只留一条
 * - 带 id  :按 id 更新(改 label / url / token)
 */
export function saveRelayProfile(
  input: { id?: string; label: string; url: string; token: string; user?: RelayUserProfile },
): RelayProfile {
  const all = listRelayProfiles();
  if (input.id) {
    const next = all.map((p) =>
      p.id === input.id
        ? { ...p, label: input.label, url: input.url, token: input.token, user: input.user }
        : p,
    );
    writeAll(next);
    return next.find((p) => p.id === input.id) || {
      id: input.id, label: input.label, url: input.url, token: input.token, user: input.user, createdAt: Date.now(),
    };
  }
  // 同 url+token 已存在 → 更新 label,返回原 id
  const dup = all.find((p) => p.url === input.url && p.token === input.token);
  if (dup) {
    const next = all.map((p) =>
      p.id === dup.id ? { ...p, label: input.label, user: input.user || p.user } : p,
    );
    writeAll(next);
    return { ...dup, label: input.label, user: input.user || dup.user };
  }
  const profile: RelayProfile = {
    id: genId(),
    label: input.label || input.url,
    url: input.url,
    token: input.token,
    user: input.user,
    createdAt: Date.now(),
  };
  writeAll([profile, ...all]);
  return profile;
}

export function deleteRelayProfile(id: string): void {
  const next = listRelayProfiles().filter((p) => p.id !== id);
  writeAll(next);
}
