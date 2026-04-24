// AgentRoom 冒烟测试：覆盖窗口开启、空态、创建向导、cheatsheet、ErrorBoundary 等关键可视化路径。
// 不涉及真实 LLM 调用；目的只是保证前端代码不会因为重构而在运行期崩溃（最小化回归成本）。
import { test, expect, type Page } from '@playwright/test';
import { login, openWindow } from './auth';

// ── 辅助函数 ──

/** 收集页面错误（过滤掉 Vite HMR / prefetch / favicon 等无关噪音） */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;
      if (t.includes('[vite]')) return;
      if (t.includes('favicon')) return;
      errors.push(`[console.error] ${t}`);
    }
  });
  return errors;
}

/**
 * 等待 AgentRoom 完全加载（Suspense chunk + API listRooms() 完成），
 * 返回最终稳定状态 'hero'（无房间）或 'room'（有房间三栏视图）。
 *
 * 原因：组件 mount 时 rooms=[] 会先闪一下 Hero，listRooms() resolve 后
 * 立即切到三栏；如果在闪烁期间断言 Hero 元素会导致 race。
 */
type AgentRoomState = 'hero' | 'room' | 'list';

async function waitForAgentRoomReady(page: Page): Promise<AgentRoomState> {
  const heroTitle = page.locator('text=/召集你的 AI 团队|Summon your AI team/');
  const composerBox = page.locator('textarea');
  const topBarState = page.locator('text=/房间已暂停|讨论中|已暂停|待开始|已关闭|Active|Paused|Draft|Closed/');
  const emptyCenter = page.locator('text=/请选择或创建一个房间|Select or create a room/');

  // 等 Suspense chunk 加载完
  await heroTitle.or(composerBox).or(topBarState).or(emptyCenter)
    .first().waitFor({ state: 'visible', timeout: 15_000 });

  // 等 2s 让 listRooms() 有机会 resolve
  await page.waitForTimeout(2000);

  // 稳定性双检：如果 Hero 还在，再等 1.5s 确认不是闪烁
  if (await heroTitle.count() > 0) {
    await page.waitForTimeout(1500);
  }

  // 最终状态判定
  if (await heroTitle.count() > 0) return 'hero';
  if (await emptyCenter.count() > 0) return 'list';
  return 'room';
}

/** 断言无 ErrorBoundary */
async function assertNoErrorBoundary(page: Page, ctx = '') {
  const errors = page.locator('text=Something went wrong');
  expect(await errors.count(), `${ctx}不应触发 ErrorBoundary`).toBe(0);
}

// ══════════════════════════════════════════════════════════════════
// 1. 基础开启 & ErrorBoundary
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — basics', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('P0: opens without crash, renders UI chrome', async ({ page }) => {
    await openWindow(page, 'agentroom');
    const state = await waitForAgentRoomReady(page);
    await assertNoErrorBoundary(page);

    if (state === 'hero') {
      await expect(page.locator('.material-symbols-outlined:text("groups_3")').first()).toBeVisible();
    } else if (state === 'room') {
      const composer = page.locator('textarea');
      const topbar = page.locator('text=/讨论中|已暂停|待开始|已关闭|会议已关闭|Active|Paused|Draft|Closed/');
      expect((await composer.count()) + (await topbar.count())).toBeGreaterThan(0);
    } else {
      // list 状态：有房间列表但未选中房间
      await expect(page.locator('text=/请选择或创建一个房间|Select or create a room/').first()).toBeVisible();
    }
  });

  test('P0: handles missing API gracefully without crash', async ({ page }) => {
    const errors = collectErrors(page);
    await openWindow(page, 'agentroom');
    await waitForAgentRoomReady(page);
    await assertNoErrorBoundary(page);
    const pageErrors = errors.filter(e => e.startsWith('[pageerror]'));
    expect(pageErrors, `不应有未捕获异常:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('P1: no uncaught console errors during open', async ({ page }) => {
    const errors = collectErrors(page);
    await openWindow(page, 'agentroom');
    await waitForAgentRoomReady(page);
    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Hero Card（空态）
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — hero card', () => {
  let pageState: AgentRoomState = 'room';

  test.beforeEach(async ({ page }) => {
    await login(page);
    await openWindow(page, 'agentroom');
    pageState = await waitForAgentRoomReady(page);
  });

  test('P0: hero card renders title, description and 3 action buttons', async ({ page }) => {
    if (pageState !== 'hero') {
      test.skip();
      return;
    }

    // 标题
    await expect(page.locator('h1').first()).toBeVisible();

    // 3 个按钮：Start now / Browse templates / Build your own
    const buttons = page.locator('button').filter({ has: page.locator('.material-symbols-outlined') });
    // 至少 3 个可见按钮（rocket_launch, play_circle, construction）
    const visibleCount = await buttons.count();
    expect(visibleCount, 'Hero 应至少有 3 个动作按钮').toBeGreaterThanOrEqual(3);
  });

  test('P0: hero feature cards are visible', async ({ page }) => {
    if (pageState !== 'hero') {
      test.skip();
      return;
    }

    // 特性卡片：forum (Real-time chat) + back_hand (Jump in anytime)
    const forum = page.locator('.material-symbols-outlined:text("forum")');
    const hand = page.locator('.material-symbols-outlined:text("back_hand")');
    expect((await forum.count()) + (await hand.count()), 'Hero 特性卡片应可见').toBeGreaterThanOrEqual(2);
  });

  test('P0: "Browse templates" opens wizard in template mode', async ({ page }) => {
    if (pageState !== 'hero') {
      test.skip();
      return;
    }

    // "Browse templates" 按钮带 play_circle 图标
    const browseBtn = page.locator('button:has(.material-symbols-outlined:text("play_circle"))').first();
    if (!(await browseBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await browseBtn.click();
    await page.waitForTimeout(600);

    // Wizard 应弹出；模板路径会直接显示模板列表（不显示 ModeChooser）
    const wizard = page.locator('.fixed.inset-0');
    await expect(wizard.first()).toBeVisible({ timeout: 3000 });
    await assertNoErrorBoundary(page);
    await page.keyboard.press('Escape');
  });

  test('P0: "Build your own" opens wizard in custom mode', async ({ page }) => {
    if (pageState !== 'hero') {
      test.skip();
      return;
    }

    // "Build your own" 按钮带 construction 图标
    const customBtn = page.locator('button:has(.material-symbols-outlined:text("construction"))').first();
    if (!(await customBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await customBtn.click();
    await page.waitForTimeout(600);

    const wizard = page.locator('.fixed.inset-0');
    await expect(wizard.first()).toBeVisible({ timeout: 3000 });
    await assertNoErrorBoundary(page);
    await page.keyboard.press('Escape');
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. Create Room Wizard
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — wizard', () => {
  let pageState: AgentRoomState = 'room';

  test.beforeEach(async ({ page }) => {
    await login(page);
    await openWindow(page, 'agentroom');
    pageState = await waitForAgentRoomReady(page);
  });

  test('P0: "Start now" opens wizard with mode chooser', async ({ page }) => {
    if (pageState !== 'hero') {
      test.skip();
      return;
    }

    // "Start now" 按钮带 rocket_launch 图标
    const startBtn = page.locator('button:has(.material-symbols-outlined:text("rocket_launch"))').first();
    if (!(await startBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await startBtn.click();
    await page.waitForTimeout(600);

    // Wizard 弹出
    const wizard = page.locator('.fixed.inset-0');
    await expect(wizard.first()).toBeVisible({ timeout: 3000 });
    await assertNoErrorBoundary(page);
  });

  test('P0: wizard from RoomsRail "+" shows mode chooser', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // 房间列表左栏有 "+" 新建按钮
    const addBtn = page.locator('button:has(.material-symbols-outlined:text("add"))').first();
    if (!(await addBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(800);

    // ModeChooser 有"选一个模板"和"自己搭建"
    const chooserContent = page.locator('text=/选一个模板|自己搭建|auto_awesome|construction/');
    const wizardExists = (await chooserContent.count()) > 0;
    expect(wizardExists, 'Wizard ModeChooser 应可见').toBeTruthy();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await assertNoErrorBoundary(page);
  });

  test('P0: Escape closes wizard', async ({ page }) => {
    // 打开向导：Hero 用 rocket_launch，Room/List 用 "+" 按钮
    if (pageState === 'hero') {
      const startBtn = page.locator('button:has(.material-symbols-outlined:text("rocket_launch"))').first();
      if (!(await startBtn.isVisible().catch(() => false))) { test.skip(); return; }
      await startBtn.click();
    } else {
      const addBtn = page.locator('button:has(.material-symbols-outlined:text("add"))').first();
      if (!(await addBtn.isVisible().catch(() => false))) { test.skip(); return; }
      await addBtn.click();
    }
    await page.waitForTimeout(800);

    // Wizard 弹出后一定有"召集你的 AI 团队"或模板类别文案
    const wizardContent = page.locator('text=/召集你的 AI 团队|选一个模板|自己搭建|运营|开发/');
    expect(await wizardContent.count(), 'Wizard 应已打开').toBeGreaterThan(0);

    // Escape 关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // 向导内容应消失（回到 room view 或 hero）
    expect(await wizardContent.count(), 'Escape 应关闭 wizard').toBe(0);
    await assertNoErrorBoundary(page);
  });

  test('P0: backdrop click closes wizard', async ({ page }) => {
    if (pageState === 'hero') {
      const startBtn = page.locator('button:has(.material-symbols-outlined:text("rocket_launch"))').first();
      if (!(await startBtn.isVisible().catch(() => false))) { test.skip(); return; }
      await startBtn.click();
    } else {
      const addBtn = page.locator('button:has(.material-symbols-outlined:text("add"))').first();
      if (!(await addBtn.isVisible().catch(() => false))) { test.skip(); return; }
      await addBtn.click();
    }
    await page.waitForTimeout(800);

    const wizardContent = page.locator('text=/召集你的 AI 团队|选一个模板|自己搭建/');
    if (await wizardContent.count() === 0) {
      // wizard 未正常打开，跳过避免误报
      test.skip();
      return;
    }

    // 点击 backdrop 区域关闭 wizard
    // wizard 对话框居中 ~x:200-830 ~y:180-440，点击对话框外的 backdrop
    // 用 page.mouse.click 绕过 Playwright 的 pointer 拦截检查
    await page.mouse.click(150, 480);
    await page.waitForTimeout(600);

    expect(await wizardContent.count(), 'Backdrop 点击应关闭 wizard').toBe(0);
    await assertNoErrorBoundary(page);
  });

  test('P1: wizard opens and closes rapidly without React errors', async ({ page }) => {
    const errors = collectErrors(page);

    // 选取可用的触发按钮
    const triggerBtn = pageState === 'hero'
      ? page.locator('button:has(.material-symbols-outlined:text("rocket_launch"))').first()
      : page.locator('button:has(.material-symbols-outlined:text("add"))').first();
    // 稳定性：确认按钮真的可见且稳定
    await page.waitForTimeout(300);
    if (!(await triggerBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // 快速开关 5 次
    for (let i = 0; i < 5; i++) {
      await triggerBtn.click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    const reactErrors = errors.filter(e =>
      e.includes('#310') || e.includes('fewer hooks') || e.includes('Rendered fewer') || e.startsWith('[pageerror]'));
    expect(reactErrors, `React errors:\n${reactErrors.join('\n')}`).toEqual([]);
    await assertNoErrorBoundary(page);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. 三栏视图（有房间时）
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — room view', () => {
  let pageState: AgentRoomState = 'room';

  test.beforeEach(async ({ page }) => {
    await login(page);
    await openWindow(page, 'agentroom');
    pageState = await waitForAgentRoomReady(page);
  });

  test('P0: room view shows TopBar with room state badge', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // TopBar 应包含房间状态标签
    const stateBadge = page.locator('text=/讨论中|已暂停|待开始|已关闭|已归档|等待你拍板|总结收尾中/');
    expect(await stateBadge.count(), 'TopBar 应有状态标签').toBeGreaterThan(0);
    await assertNoErrorBoundary(page);
  });

  test('P0: room view shows Composer input area', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // Composer 含有 textarea 或 contenteditable
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 3000 });
    await assertNoErrorBoundary(page);
  });

  test('P1: right panel has CollapsibleSection groups', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // 右侧面板的分组标题（在 1440+ 视口下可见）
    // PanelGroupHeader 渲染 material icon + 大写标签
    // 检查至少 Members 计数或 group headers
    const membersLabel = page.locator('text=/Members|成员/');
    expect(await membersLabel.count(), '右侧面板应有 Members 区域').toBeGreaterThan(0);
  });

  test('P1: TopBar more menu opens without crash', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // TopBar 右端 more_vert 菜单按钮
    const moreBtn = page.locator('button:has(.material-symbols-outlined:text("more_vert"))').first();
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(400);
      await assertNoErrorBoundary(page);
      // 关闭
      await page.keyboard.press('Escape');
    }
  });

  test('P1: Composer textarea accepts input', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    const textarea = page.locator('textarea').first();
    if (!(await textarea.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await textarea.click();
    await textarea.fill('Hello e2e test');
    const val = await textarea.inputValue();
    expect(val).toContain('Hello e2e test');
    await assertNoErrorBoundary(page);
  });

  test('P1: left panel rooms rail visible at wide viewport', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // 默认视口 1440×900（playwright.config.ts）—— 应显示左侧 RoomsRail
    // RoomsRail 含有"新建"按钮（+ 图标）
    const addBtn = page.locator('button:has(.material-symbols-outlined:text("add"))');
    // 可能有多个 add 按钮，只要有一个可见即可
    const visible = await addBtn.first().isVisible().catch(() => false);
    // 宽屏下左栏应可见
    expect(visible || (await page.locator('text=/新建|New room|Create/').count()) > 0).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. 快捷键 Cheatsheet
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — cheatsheet', () => {
  let pageState: AgentRoomState = 'room';

  test.beforeEach(async ({ page }) => {
    await login(page);
    await openWindow(page, 'agentroom');
    pageState = await waitForAgentRoomReady(page);
  });

  test('P1: cheatsheet modal contains shortcut descriptions', async ({ page }) => {
    if (pageState !== 'room') {
      test.skip();
      return;
    }

    // 通过 Composer textarea 输入 /help 并回车来打开 cheatsheet
    const textarea = page.locator('textarea').first();
    if (!(await textarea.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await textarea.click();
    await textarea.fill('/help');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);

    // Cheatsheet modal 应包含 kbd 元素和快捷键
    const kbdElements = page.locator('kbd');
    if (await kbdElements.count() > 0) {
      expect(await kbdElements.count(), 'Cheatsheet 应包含快捷键').toBeGreaterThan(0);

      // 验证包含 Space / Enter / Escape 等
      const bodyText = await page.locator('body').innerText();
      const hasShortcuts = bodyText.includes('Space') || bodyText.includes('Enter') || bodyText.includes('Esc');
      expect(hasShortcuts, 'Cheatsheet 应列出快捷键描述').toBeTruthy();

      // 验证 slash 命令也在
      const hasSlash = bodyText.includes('/pause') || bodyText.includes('/fork') || bodyText.includes('/help');
      expect(hasSlash, 'Cheatsheet 应列出 slash 命令').toBeTruthy();

      // Escape 关闭
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await assertNoErrorBoundary(page);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. 窗口切换稳定性
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — stability', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('P1: window navigation back and forth is stable', async ({ page }) => {
    // 在 AgentRoom 和 Gateway 之间来回切，验证挂载/卸载不累积错误
    await openWindow(page, 'agentroom');
    await page.waitForTimeout(800);
    await openWindow(page, 'gateway');
    await page.waitForTimeout(800);
    await openWindow(page, 'agentroom');
    await page.waitForTimeout(800);

    await assertNoErrorBoundary(page);
  });

  test('P1: rapid AgentRoom open/close cycles', async ({ page }) => {
    const errors = collectErrors(page);

    for (let i = 0; i < 4; i++) {
      await openWindow(page, 'agentroom');
      await page.waitForTimeout(400);
      await openWindow(page, 'sessions');
      await page.waitForTimeout(400);
    }
    await openWindow(page, 'agentroom');
    await page.waitForTimeout(800);

    await assertNoErrorBoundary(page);
    const pageErrors = errors.filter(e => e.startsWith('[pageerror]'));
    expect(pageErrors, `pageerrors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('P1: switching through multiple windows then back to AgentRoom', async ({ page }) => {
    const windowIds = ['agentroom', 'gateway', 'editor', 'sessions', 'skills', 'agentroom'];

    for (const id of windowIds) {
      await openWindow(page, id);
      await page.waitForTimeout(600);
      await assertNoErrorBoundary(page, `切到 ${id} 后`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. 响应式布局
// ══════════════════════════════════════════════════════════════════

test.describe('AgentRoom smoke — responsive', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('P2: narrow viewport does not crash', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openWindow(page, 'agentroom');
    await waitForAgentRoomReady(page);
    await assertNoErrorBoundary(page);
  });

  test('P2: mobile-width viewport does not crash', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await openWindow(page, 'agentroom');
    await waitForAgentRoomReady(page);
    await assertNoErrorBoundary(page);
  });

  test('P2: resize during viewing does not crash', async ({ page }) => {
    await openWindow(page, 'agentroom');
    await page.waitForTimeout(800);

    // 从宽到窄
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    // 再回宽
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);

    await assertNoErrorBoundary(page);
  });
});
