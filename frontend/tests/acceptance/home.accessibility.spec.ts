import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CONTROL_URL = 'http://127.0.0.1:45423';

async function openCleanHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('agent-with-u:pane-sessions');
    localStorage.removeItem('awu.connectionTarget');
    localStorage.removeItem('awu.execRoster');
    localStorage.removeItem('awu.home.preferences.v1');
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '工作总览' })).toBeVisible();
  await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
}

async function tabTo(page: Page, selector: string, index = 0): Promise<number> {
  for (let presses = 1; presses <= 80; presses += 1) {
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(
      ({ targetSelector, targetIndex }) => (
        document.activeElement === document.querySelectorAll(targetSelector)[targetIndex]
      ),
      { targetSelector: selector, targetIndex: index },
    );
    if (reached) return presses;
  }
  throw new Error(`Keyboard focus did not reach ${selector}[${index}]`);
}

test.describe.serial('dashboard runtime accessibility acceptance', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop-chromium',
      'The accessibility matrix runs once in desktop Chromium.',
    );
    const cleanupResponse = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanupResponse.ok()).toBeTruthy();
  });

  test.afterEach(async ({ request }) => {
    const cleanupResponse = await request.get(`${CONTROL_URL}/event/task/remove`);
    expect(cleanupResponse.ok()).toBeTruthy();
  });

  test('landmarks, names, contrast and the accessibility tree pass an automated scan', async ({ page }, testInfo) => {
    await openCleanHome(page);

    await expect(page.getByRole('main', { name: '工作总览' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: '工作总览' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: '全局关键状态' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: '快捷操作' })).toHaveCount(1);
    await expect(page.getByRole('status')).not.toHaveCount(0);

    const unnamedControls = await page.locator(
      '.home-dashboard button, .home-dashboard input, .home-dashboard a',
    ).evaluateAll((elements) => elements
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .filter((element) => {
        const labelledBy = element.getAttribute('aria-labelledby');
        const label = element.closest('label')?.textContent;
        return !(
          element.getAttribute('aria-label')?.trim()
          || (labelledBy && document.getElementById(labelledBy)?.textContent?.trim())
          || label?.trim()
          || element.textContent?.trim()
          || element.getAttribute('title')?.trim()
        );
      })
      .map((element) => element.outerHTML));
    expect(unnamedControls).toEqual([]);

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    await testInfo.attach('axe-results.json', {
      body: JSON.stringify(axe, null, 2),
      contentType: 'application/json',
    });
    expect(
      axe.violations,
      axe.violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
    ).toEqual([]);

    const ariaTree = await page.getByRole('main', { name: '工作总览' }).ariaSnapshot();
    await testInfo.attach('screen-reader-tree.yml', {
      body: ariaTree,
      contentType: 'text/yaml',
    });
  });

  test('skip link, focus order and the customizer work with the keyboard alone', async ({ page }, testInfo) => {
    await openCleanHome(page);

    await page.keyboard.press('Tab');
    const skip = page.locator('.app-skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    const focusStyle = await skip.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        top: rect.top,
        left: rect.left,
      };
    });
    expect(focusStyle.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Enter');
    await expect(page.locator('.home-module-grid')).toBeFocused();

    const expectedOrder = [
      '.home-status-item:nth-of-type(1)',
      '.home-status-item:nth-of-type(2)',
      '.home-status-item:nth-of-type(3)',
      '.home-action-grid button:nth-of-type(1)',
      '.home-action-grid button:nth-of-type(2)',
      '.home-action-grid button:nth-of-type(3)',
      '.home-action-grid button:nth-of-type(4)',
      '.home-action-grid button:nth-of-type(5)',
    ];
    const focusOrder: string[] = ['跳到首页主要内容', '首页主要内容'];
    for (const selector of expectedOrder) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate((targetSelector) => {
        const active = document.activeElement as HTMLElement | null;
        return {
          matches: active?.matches(targetSelector) || false,
          name: (active?.getAttribute('aria-label') || active?.innerText || '').trim().replace(/\s+/g, ' '),
        };
      }, selector);
      expect(state.matches, `Expected focus on ${selector}, received ${state.name}`).toBeTruthy();
      focusOrder.push(state.name);
    }

    await page.reload();
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('24');
    await page.keyboard.press('Tab');
    await expect(page.locator('.app-skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.home-module-grid')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.home-sync button').nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.home-customizer')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('.home-density button').first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.home-density button').nth(1)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('.home-dashboard')).toHaveClass(/density-compact/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.home-customizer')).toBeHidden();
    await expect(page.locator('.home-sync button').nth(1)).toBeFocused();

    await testInfo.attach('keyboard-focus-order.json', {
      body: JSON.stringify({ focusStyle, focusOrder, escapeReturnedToTrigger: true }, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('keyboard-focus-visible.png'), fullPage: false });
  });

  test('all five core destinations are reachable by keyboard activation', async ({ browser }, testInfo) => {
    const checks: Array<{
      index: number;
      id: string;
      verify: (page: Page) => Promise<void>;
    }> = [
      {
        index: 0,
        id: 'new-chat',
        verify: async (page) => expect(page.getByRole('heading', { name: 'New Session' })).toBeVisible(),
      },
      {
        index: 1,
        id: 'new-loop',
        verify: async (page) => expect(page.getByText(/Loop 策略与心智/)).toBeVisible(),
      },
      {
        index: 2,
        id: 'resume-work',
        verify: async (page) => expect(page.getByText('loopexecute', { exact: true }).first()).toBeVisible(),
      },
      {
        index: 3,
        id: 'open-tasks',
        verify: async (page) => expect(page.locator('[title="收起"]')).toBeVisible(),
      },
      {
        index: 4,
        id: 'manage-models',
        verify: async (page) => expect(page.getByRole('heading', { name: 'Backend Manager' })).toBeVisible(),
      },
    ];
    const results: Array<{ id: string; tabPresses: number; activation: string; passed: boolean }> = [];

    for (const check of checks) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await openCleanHome(page);
      await page.keyboard.press('Tab');
      await expect(page.locator('.app-skip-link')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('.home-module-grid')).toBeFocused();
      const tabPresses = await tabTo(page, '.home-action-grid button', check.index);
      await page.keyboard.press('Enter');
      await check.verify(page);
      results.push({ id: check.id, tabPresses, activation: 'Enter', passed: true });
      await page.screenshot({ path: testInfo.outputPath(`keyboard-${check.id}.png`), fullPage: false });
      await context.close();
    }
    await testInfo.attach('keyboard-core-actions.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });

  test('live updates are announced without moving focus', async ({ page, request }, testInfo) => {
    await openCleanHome(page);
    await tabTo(page, '.home-action-grid button', 0);
    const focusedBefore = await page.evaluate(() => document.activeElement?.textContent?.trim() || '');
    const liveRegion = page.locator('.home-sr-only[role="status"]');
    const announcementBefore = await liveRegion.textContent();

    const eventResponse = await request.get(`${CONTROL_URL}/event/task`);
    expect(eventResponse.ok()).toBeTruthy();
    await expect(page.locator('.home-status-item').nth(2).locator('strong')).toHaveText('25');
    await expect.poll(async () => liveRegion.textContent(), { timeout: 5_000 })
      .not.toBe(announcementBefore);
    await expect(liveRegion).not.toBeEmpty();
    await expect(page.locator('.home-action-grid button').first()).toBeFocused();

    await testInfo.attach('live-announcement.json', {
      body: JSON.stringify({
        before: announcementBefore,
        after: await liveRegion.textContent(),
        focusBefore: focusedBefore,
        focusPreserved: true,
      }, null, 2),
      contentType: 'application/json',
    });
  });

  test('200 percent equivalent reflow and reduced motion remain usable', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCleanHome(page);

    const audit = await page.evaluate(() => {
      const dashboard = document.querySelector<HTMLElement>('.home-dashboard')!;
      const animated = Array.from(dashboard.querySelectorAll<HTMLElement>('*'))
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            animationDuration: style.animationDuration,
            transitionDuration: style.transitionDuration,
            scrollBehavior: style.scrollBehavior,
          };
        })
        .filter((style) => (
          !['0s', '0.01ms'].includes(style.animationDuration)
          || !['0s', '0.01ms'].includes(style.transitionDuration)
          || style.scrollBehavior === 'smooth'
        ));
      return {
        cssViewport: { width: innerWidth, height: innerHeight },
        physicalWidthAt200PercentEquivalent: innerWidth * 2,
        html: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
        dashboard: { scrollWidth: dashboard.scrollWidth, clientWidth: dashboard.clientWidth },
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        nonReducedElements: animated,
      };
    });
    expect(audit.physicalWidthAt200PercentEquivalent).toBe(1280);
    expect(audit.html.scrollWidth).toBeLessThanOrEqual(audit.html.clientWidth + 1);
    expect(audit.dashboard.scrollWidth).toBeLessThanOrEqual(audit.dashboard.clientWidth + 1);
    expect(audit.reducedMotion).toBeTruthy();
    expect(audit.nonReducedElements).toEqual([]);
    await expect(page.locator('.home-status-item')).toHaveCount(3);
    await expect(page.locator('.home-action-grid button')).toHaveCount(5);

    await testInfo.attach('zoom-reduced-motion.json', {
      body: JSON.stringify(audit, null, 2),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('zoom-200-reflow.png'), fullPage: false });
  });
});
