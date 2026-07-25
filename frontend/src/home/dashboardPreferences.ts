import { useCallback, useEffect, useMemo, useState } from 'react';
import { DASHBOARD_MODULES, type DashboardModuleId } from './dashboardModel';

export type DashboardDensity = 'comfortable' | 'compact';

export interface DashboardPreferences {
  version: 1;
  density: DashboardDensity;
  order: DashboardModuleId[];
  visible: Record<DashboardModuleId, boolean>;
}

const STORAGE_KEY = 'awu.home.preferences.v1';
const MODULE_IDS = DASHBOARD_MODULES.map((module) => module.id);
const MODULE_ID_SET = new Set<string>(MODULE_IDS);
const PROTECTED_IDS = new Set(
  DASHBOARD_MODULES.filter((module) => module.minimumVisible).map((module) => module.id),
);

export function defaultDashboardPreferences(): DashboardPreferences {
  return {
    version: 1,
    density: 'comfortable',
    order: [...DASHBOARD_MODULES]
      .sort((a, b) => a.defaultOrder - b.defaultOrder)
      .map((module) => module.id),
    visible: Object.fromEntries(
      DASHBOARD_MODULES.map((module) => [module.id, module.defaultVisible]),
    ) as Record<DashboardModuleId, boolean>,
  };
}

export function normalizeDashboardPreferences(value: unknown): DashboardPreferences {
  const defaults = defaultDashboardPreferences();
  if (!value || typeof value !== 'object') return defaults;
  const candidate = value as Partial<DashboardPreferences>;
  const suppliedOrder = Array.isArray(candidate.order)
    ? candidate.order.filter((id): id is DashboardModuleId => typeof id === 'string' && MODULE_ID_SET.has(id))
    : [];
  const completeOrder = [...new Set(suppliedOrder)];
  for (const id of MODULE_IDS) {
    if (!completeOrder.includes(id)) completeOrder.push(id);
  }
  // 一级关键模块永远占据布局前区，用户仍可在关键区/普通区内部自由排序。
  const order = [
    ...completeOrder.filter((id) => PROTECTED_IDS.has(id)),
    ...completeOrder.filter((id) => !PROTECTED_IDS.has(id)),
  ];
  const visible = { ...defaults.visible };
  if (candidate.visible && typeof candidate.visible === 'object') {
    for (const id of MODULE_IDS) {
      if (typeof candidate.visible[id] === 'boolean') visible[id] = candidate.visible[id];
    }
  }
  for (const id of PROTECTED_IDS) visible[id] = true;
  return {
    version: 1,
    density: candidate.density === 'compact' ? 'compact' : 'comfortable',
    order,
    visible,
  };
}

function readPreferences(): DashboardPreferences {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeDashboardPreferences(JSON.parse(saved)) : defaultDashboardPreferences();
  } catch {
    return defaultDashboardPreferences();
  }
}

export function useDashboardPreferences() {
  const [preferences, setPreferences] = useState<DashboardPreferences>(readPreferences);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* */ }
  }, [preferences]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try { setPreferences(normalizeDashboardPreferences(JSON.parse(event.newValue))); } catch { /* */ }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  const setDensity = useCallback((density: DashboardDensity) => {
    setPreferences((current) => ({ ...current, density }));
  }, []);

  const toggleModule = useCallback((id: DashboardModuleId) => {
    if (PROTECTED_IDS.has(id)) return;
    setPreferences((current) => ({
      ...current,
      visible: { ...current.visible, [id]: !current.visible[id] },
    }));
  }, []);

  const moveModule = useCallback((id: DashboardModuleId, direction: -1 | 1) => {
    setPreferences((current) => {
      const index = current.order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      if (PROTECTED_IDS.has(id) !== PROTECTED_IDS.has(current.order[target])) return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  }, []);

  const reset = useCallback(() => setPreferences(defaultDashboardPreferences()), []);
  const protectedIds = useMemo(() => PROTECTED_IDS, []);
  const canMoveModule = useCallback((id: DashboardModuleId, direction: -1 | 1) => {
    const index = preferences.order.indexOf(id);
    const target = index + direction;
    return index >= 0
      && target >= 0
      && target < preferences.order.length
      && PROTECTED_IDS.has(id) === PROTECTED_IDS.has(preferences.order[target]);
  }, [preferences.order]);

  return { preferences, setDensity, toggleModule, moveModule, canMoveModule, reset, protectedIds };
}
