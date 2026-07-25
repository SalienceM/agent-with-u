import { expect, test, type CDPSession, type Page } from '@playwright/test';

const CONTROL_URL = 'http://127.0.0.1:45423';
const profile = process.env.HOME_QA_PROFILE === 'stress' ? 'stress' : 'typical';
const expected = profile === 'stress'
  ? { sessions: 250, loops: 60, pendingTasks: 2280, burst: 30 }
  : { sessions: 12, loops: 4, pendingTasks: 24, burst: 20 };

interface BrowserPerfState {
  longTasks: Array<{ startTime: number; duration: number }>;
  layoutShifts: Array<{ startTime: number; value: number }>;
}

async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: BrowserPerfState = { longTasks: [], layoutShifts: [] };
    (window as typeof window & { __homePerf?: BrowserPerfState }).__homePerf = state;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* Chromium without the optional longtask entry type. */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) {
            state.layoutShifts.push({ startTime: shift.startTime, value: shift.value });
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* Chromium without the optional layout-shift entry type. */ }
  });
}

async function openMeasuredHome(page: Page): Promise<void> {
  await installPerformanceObservers(page);
  await page.addInitScript(() => {
    localStorage.removeItem('agent-with-u:pane-sessions');
    localStorage.removeItem('awu.connectionTarget');
    localStorage.removeItem('awu.execRoster');
    localStorage.removeItem('awu.home.preferences.v1');
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
  await expect(page.locator('.home-status-item').nth(2).locator('strong'))
    .toHaveText(String(expected.pendingTasks));
  await expect(page.locator('.home-action-grid button').first()).toBeEnabled();
}

async function cdpMetrics(cdp: CDPSession): Promise<Record<string, number>> {
  const result = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
}

test.describe.serial('dashboard typical and stress performance acceptance', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Performance sampling runs once in desktop Chromium.');
    const cleanup = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanup.ok()).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    const cleanup = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanup.ok()).toBeTruthy();
  });

  test(`first screen stays interactive and bounded for ${profile} data`, async ({ page }, testInfo) => {
    const rpcFrames: Array<{ method: string; params: unknown[] }> = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        try {
          const payload = JSON.parse(String(frame.payload));
          if (payload?.method) rpcFrames.push({ method: payload.method, params: payload.params || [] });
        } catch { /* Non-JSON WebSocket frame. */ }
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    await openMeasuredHome(page);
    await page.waitForTimeout(300);
    const criticalStateReadyMs = await page.evaluate(() => performance.now());
    const browserMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const perf = (window as typeof window & { __homePerf?: BrowserPerfState }).__homePerf;
      const dashboard = document.querySelector<HTMLElement>('.home-dashboard')!;
      return {
        navigation: {
          domContentLoadedMs: navigation?.domContentLoadedEventEnd || 0,
          loadEventMs: navigation?.loadEventEnd || 0,
          responseEndMs: navigation?.responseEnd || 0,
          firstContentfulPaintMs: fcp?.startTime || 0,
        },
        longTasks: perf?.longTasks || [],
        cumulativeLayoutShift: (perf?.layoutShifts || []).reduce((sum, item) => sum + item.value, 0),
        domNodes: document.getElementsByTagName('*').length,
        horizontalOverflowPx: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          dashboard.scrollWidth - dashboard.clientWidth,
        ),
        rendered: {
          status: document.querySelectorAll('.home-status-item').length,
          actions: document.querySelectorAll('.home-action-grid button').length,
          loops: document.querySelectorAll('.home-module-loops .home-list-row').length,
          tasks: document.querySelectorAll('.home-module-tasks .home-list-row').length,
          sessions: document.querySelectorAll('.home-module-sessions .home-list-row').length,
          activity: document.querySelectorAll('.home-activity li').length,
        },
      };
    });

    const interactionMs = await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>('.home-sync button:nth-of-type(2)')!;
      const startedAt = performance.now();
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!document.querySelector('.home-customizer')) throw new Error('Customizer did not render');
      return performance.now() - startedAt;
    });
    await page.locator('.home-sync button').nth(1).click();
    await expect(page.locator('.home-customizer')).toBeHidden();

    await cdp.send('HeapProfiler.collectGarbage');
    const memory = await cdpMetrics(cdp);
    const signatureCounts = new Map<string, number>();
    for (const frame of rpcFrames) {
      const signature = JSON.stringify(frame);
      signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
    }
    const duplicateRpcSignatures = [...signatureCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([signature, count]) => ({ ...JSON.parse(signature), count }));
    const maxLongTaskMs = Math.max(0, ...browserMetrics.longTasks.map((task) => task.duration));
    const totalBlockingTimeMs = browserMetrics.longTasks
      .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);

    const result = {
      profile,
      fixture: expected,
      criticalStateReadyMs,
      interactionMs,
      ...browserMetrics,
      maxLongTaskMs,
      totalBlockingTimeMs,
      memory: {
        jsHeapUsedMb: (memory.JSHeapUsedSize || 0) / 1024 / 1024,
        jsHeapTotalMb: (memory.JSHeapTotalSize || 0) / 1024 / 1024,
        nodes: memory.Nodes || 0,
        documents: memory.Documents || 0,
      },
      rpc: {
        framesSent: rpcFrames.length,
        methodCounts: Object.fromEntries(
          [...new Set(rpcFrames.map((frame) => frame.method))]
            .sort()
            .map((method) => [method, rpcFrames.filter((frame) => frame.method === method).length]),
        ),
        duplicateSignatures: duplicateRpcSignatures,
      },
    };
    await testInfo.attach('first-screen-performance.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('performance-first-screen.png'), fullPage: false });

    expect(criticalStateReadyMs).toBeLessThan(3000);
    expect(interactionMs).toBeLessThan(200);
    expect(browserMetrics.horizontalOverflowPx).toBe(0);
    expect(browserMetrics.cumulativeLayoutShift).toBeLessThanOrEqual(0.1);
    expect(maxLongTaskMs).toBeLessThanOrEqual(200);
    expect(totalBlockingTimeMs).toBeLessThanOrEqual(500);
    expect(browserMetrics.rendered).toMatchObject({
      status: 3,
      actions: 5,
      loops: Math.min(expected.loops, 6),
      tasks: 8,
      sessions: 8,
    });
    expect(browserMetrics.domNodes).toBeLessThan(1800);
    expect(result.memory.jsHeapUsedMb).toBeLessThan(40);
    expect(duplicateRpcSignatures.every((item) => item.count <= 2)).toBeTruthy();
  });

  test(`a ${expected.burst}-event burst remains responsive and avoids unrelated DOM churn`, async ({
    page,
    request,
  }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await openMeasuredHome(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const memoryBefore = await cdpMetrics(cdp);

    await page.evaluate(() => {
      const selectors = {
        status: '.home-module-global-status',
        actions: '.home-module-quick-actions',
        loops: '.home-module-loops',
        tasks: '.home-module-tasks',
        sessions: '.home-module-sessions',
        model: '.home-module-model-status',
        metrics: '.home-module-metrics',
        activity: '.home-module-activity',
      };
      const counters: Record<string, number> = {};
      const refs: Record<string, Element | null> = {};
      const observers: MutationObserver[] = [];
      for (const [name, selector] of Object.entries(selectors)) {
        const element = document.querySelector(selector);
        refs[name] = element;
        counters[name] = 0;
        if (!element) continue;
        const observer = new MutationObserver((records) => { counters[name] += records.length; });
        observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
        observers.push(observer);
      }
      (window as typeof window & {
        __homeMutationAudit?: {
          counters: Record<string, number>;
          refs: Record<string, Element | null>;
          observers: MutationObserver[];
        };
      }).__homeMutationAudit = { counters, refs, observers };
    });
    const perfBefore = await page.evaluate(() => {
      const state = (window as typeof window & { __homePerf?: BrowserPerfState }).__homePerf;
      return {
        longTasks: state?.longTasks.length || 0,
        layoutShifts: state?.layoutShifts.length || 0,
        scrollHeight: document.querySelector<HTMLElement>('.home-dashboard')!.scrollHeight,
      };
    });

    const burstStartedAt = Date.now();
    const response = await request.get(`${CONTROL_URL}/event/task/burst?count=${expected.burst}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.locator('.home-status-item').nth(2).locator('strong'))
      .toHaveText(String(expected.pendingTasks + expected.burst), { timeout: 10_000 });
    const visibleLatencyMs = Date.now() - burstStartedAt;
    await page.waitForTimeout(250);

    await cdp.send('HeapProfiler.collectGarbage');
    const memoryAfter = await cdpMetrics(cdp);
    const audit = await page.evaluate(() => {
      const perf = (window as typeof window & { __homePerf?: BrowserPerfState }).__homePerf;
      const mutation = (window as typeof window & {
        __homeMutationAudit?: {
          counters: Record<string, number>;
          refs: Record<string, Element | null>;
          observers: MutationObserver[];
        };
      }).__homeMutationAudit!;
      mutation.observers.forEach((observer) => observer.disconnect());
      const stableReferences = Object.fromEntries(
        Object.entries(mutation.refs).map(([name, element]) => [
          name,
          element === document.querySelector(`.home-module-${
            name === 'status'
              ? 'global-status'
              : name === 'actions'
                ? 'quick-actions'
                : name === 'model'
                  ? 'model-status'
                  : name
          }`),
        ]),
      );
      const dashboard = document.querySelector<HTMLElement>('.home-dashboard')!;
      return {
        mutationRecords: mutation.counters,
        stableReferences,
        longTasks: perf?.longTasks || [],
        layoutShifts: perf?.layoutShifts || [],
        rendered: {
          loops: document.querySelectorAll('.home-module-loops .home-list-row').length,
          tasks: document.querySelectorAll('.home-module-tasks .home-list-row').length,
          sessions: document.querySelectorAll('.home-module-sessions .home-list-row').length,
          activity: document.querySelectorAll('.home-activity li').length,
        },
        scrollHeight: dashboard.scrollHeight,
        horizontalOverflowPx: Math.max(0, dashboard.scrollWidth - dashboard.clientWidth),
      };
    });
    const newLongTasks = audit.longTasks.slice(perfBefore.longTasks);
    const newLayoutShifts = audit.layoutShifts.slice(perfBefore.layoutShifts);
    const maxLongTaskMs = Math.max(0, ...newLongTasks.map((task) => task.duration));
    const layoutShift = newLayoutShifts.reduce((sum, shift) => sum + shift.value, 0);
    const heapDeltaMb = ((memoryAfter.JSHeapUsedSize || 0) - (memoryBefore.JSHeapUsedSize || 0)) / 1024 / 1024;
    const result = {
      profile,
      burstEvents: expected.burst,
      visibleLatencyMs,
      maxLongTaskMs,
      layoutShift,
      heapBeforeMb: (memoryBefore.JSHeapUsedSize || 0) / 1024 / 1024,
      heapAfterMb: (memoryAfter.JSHeapUsedSize || 0) / 1024 / 1024,
      heapDeltaMb,
      scrollHeightDeltaPx: audit.scrollHeight - perfBefore.scrollHeight,
      ...audit,
    };
    await testInfo.attach('event-burst-performance.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('performance-event-burst.png'), fullPage: false });

    expect(visibleLatencyMs).toBeLessThan(3000);
    expect(maxLongTaskMs).toBeLessThanOrEqual(200);
    expect(layoutShift).toBeLessThanOrEqual(0.1);
    expect(heapDeltaMb).toBeLessThan(12);
    expect(audit.horizontalOverflowPx).toBe(0);
    expect(audit.rendered).toEqual({
      loops: Math.min(expected.loops, 6),
      tasks: 8,
      sessions: 8,
      activity: 1,
    });
    expect(audit.stableReferences).toEqual({
      status: true,
      actions: true,
      loops: true,
      tasks: true,
      sessions: true,
      model: true,
      metrics: true,
      activity: true,
    });
    expect(audit.mutationRecords.loops).toBe(0);
    expect(audit.mutationRecords.sessions).toBe(0);
    expect(audit.mutationRecords.model).toBe(0);
  });
});
