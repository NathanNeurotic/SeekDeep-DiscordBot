// SeekDeep · Control Center browser smoke (audit §12)
// =====================================================
// One assertion per tab/surface, each driving the REAL page in Edge against
// the running AI server. These specifically pin the bugs that shipped this
// week because nothing browser-driven was watching:
//   - stale "v10.35.6" version pill (version.js one-shot-no-retry) → §7
//   - dead Feature Flags toggles with no data-key → §1
//   - Auto-react rules "Edit failed: no rule" (data-dir divergence) → §2/§3
//   - canonical system-state.json not served → §8
//
// Run: start the AI server, then `npm run test:e2e`.
import { test, expect } from '@playwright/test';

// --- Token: pages need X-SeekDeep-Token for gated fetches. nav.js injects
// it from GET /token on load, so we just navigate and let the page wire it.
// For direct API assertions we fetch the token in-page.

test.describe('Control Center', () => {
  // CI boots the server with no .env, so /config/status returns
  // needs_setup=true and nav.js auto-opens the "setup required" modal. Its
  // full-screen backdrop (#sdPromptBack, z-index 10001) intercepts nav clicks —
  // which broke the More-menu click test — and trips the "modal is closed"
  // assertion in the feature-flag test. We're not exercising the setup flow
  // here, so pre-seed the sessionStorage flag nav.js checks (set before any
  // page script runs) so the modal never auto-opens. Locally (with a real
  // .env) the modal wasn't appearing anyway, so this is behaviour-neutral
  // there and only fixes the unconfigured CI environment.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { sessionStorage.setItem('sd-setup-prompted', '1'); } catch {}
    });
  });

  test('app.html loads + version pill resolves to a real version (not the hardcoded fallback)', async ({ page }) => {
    await page.goto('/gui/app.html');
    // version.js retries /health and paints every [data-version] cell. The
    // bug was it gave up after one try and left "v10.35.6" forever. Assert
    // the pill becomes a real version and is NOT the old hardcoded literal.
    const pill = page.locator('[data-version]').first();
    await expect(pill).not.toHaveText('v10.35.6', { timeout: 10_000 });
    await expect(pill).toContainText(/v?\d+\.\d+\.\d+/, { timeout: 10_000 });
  });

  test('Feature flag toggles carry data-key + hydrate from /config (§1)', async ({ page }) => {
    await page.goto('/gui/app.html');
    // Every feature toggle card must have a data-key so save can serialize it.
    const cards = page.locator('.cfg-feature[data-key^="SEEKDEEP_FEATURE_"]');
    await expect(cards.first()).toBeAttached({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(9); // 9 feature flags in the catalog
    // Local developer/e2e environments may intentionally omit required setup
    // keys; nav.js then opens the setup prompt over the page. Dismiss it so
    // this test can exercise the config-tab hydration path it is meant to pin.
    await page.evaluate(() => window.SeekDeepPrompt?.close?.(null));
    await expect(page.locator('#sdPromptBack.open')).toHaveCount(0, { timeout: 2_000 });
    // Real user flow: the toggles hydrate when the Bot config tab is opened
    // (loadFromDisk autoloads on first config-pane activation, not on raw
    // page load). Click the nav item, then assert the .save badge flips off
    // UNKNOWN once GET /config returns.
    await page.locator('.sidebar a[data-mod="config"]').click();
    const firstSave = cards.first().locator('.save');
    await expect(firstSave).toHaveText(/SAVED|DIRTY/, { timeout: 10_000 });
  });

  test('Auto-react rules pane loads without "Edit failed: no rule" (§2/§3)', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto('/gui/app.html#auto-react');
    // Give the pane time to fetch /data/auto-reactions.json and render.
    await page.waitForTimeout(2500);
    // No "no rule" alert should have fired on load.
    expect(dialogs.join(' ')).not.toContain('no rule');
    // The reacts data file must round-trip: empty-state or rule rows, never
    // a hard error. We assert the canonical data endpoint returns ok.
    const res = await page.evaluate(async () => {
      const tr = await fetch('/token').then(r => r.json()).catch(() => ({}));
      const token = tr.token || '';
      const r = await fetch('/data/auto-reactions.json', { headers: token ? { 'X-SeekDeep-Token': token } : {} });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
  });

  test('canonical system-state.json is served + has the three sections (§8)', async ({ page }) => {
    await page.goto('/gui/app.html');
    const res = await page.evaluate(async () => {
      const tr = await fetch('/token').then(r => r.json()).catch(() => ({}));
      const token = tr.token || '';
      const r = await fetch('/data/system-state.json', { headers: token ? { 'X-SeekDeep-Token': token } : {} });
      return { status: r.status, body: await r.json().catch(() => null) };
    });
    expect(res.status).toBe(200);
    const d = res.body?.data;
    expect(d).toBeTruthy();
    expect(d.ai_server).toBeTruthy();
    expect(d.bot).toBeTruthy();
    expect(d.searxng).toBeTruthy();
    expect(d.generated_at).toBeTruthy();
  });

  test('no uncaught console errors on app.html load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/gui/app.html');
    await page.waitForTimeout(2000);
    // Filter out benign network-abort noise that isn't a code fault.
    const real = errors.filter(e => !/AbortError|Failed to fetch|NetworkError/i.test(e));
    expect(real, real.join('\n')).toHaveLength(0);
  });

  test('boot-sequence panel does not falsely say "start the AI server" while server is up', async ({ page }) => {
    // Regression guard: the bootSeqLog panel fetches the token-gated
    // /logs/tail. A one-shot fetch that 401'd before nav.js installed its
    // token interceptor used to freeze on "unreachable — start the AI server"
    // even though the server was healthy. With retry, it must recover.
    await page.goto('/gui/app.html');
    const wrap = page.locator('#bootSeqLog');
    await expect(wrap).toBeAttached({ timeout: 10_000 });
    // Give the retry loop (4 attempts) time to ride out the token-interceptor
    // window, then assert the alarming false message is not stuck on screen.
    await page.waitForTimeout(6000);
    await expect(wrap).not.toContainText('start the AI server', { timeout: 8_000 });
  });

  test('nav "More" menu surfaces the hidden-but-real features; Cmd-K drops the mocks (SURFACES.md)', async ({ page }) => {
    await page.goto('/gui/index.html');

    // nav.js injects a "More v" trigger into the standard topnav so the real
    // but secondary surfaces (Memory, Image A/B, Prompts, Add a Model) are
    // reachable from every page — not only via Cmd-K.
    const moreBtn = page.locator('.topnav .links a.sd-more-btn');
    await expect(moreBtn).toBeVisible({ timeout: 10_000 });

    const panel = page.locator('.topnav .links .sd-more-panel');
    await expect(panel).toBeHidden();
    await moreBtn.click();
    await expect(panel).toBeVisible();
    for (const href of ['memory.html', 'image-ab.html', 'prompts.html', 'add-model.html']) {
      await expect(panel.locator(`a[href="${href}"]`)).toHaveCount(1);
    }

    // The Cmd-K jump palette must no longer offer the cut mock/marketing pages.
    // Assert a known survivor first so the absence checks below aren't vacuous.
    await page.locator('#sdJumpBtn').click();
    await expect(page.locator('.sd-jump-item[href="app.html"]')).toHaveCount(1, { timeout: 5_000 });
    for (const href of ['tts.html', 'landing.html', 'pitch.html', 'tour.html', 'mobile.html']) {
      await expect(page.locator(`.sd-jump-item[href="${href}"]`)).toHaveCount(0);
    }
  });

  test('prompts.html resolves to the live/empty state, not the @offline-demo seed (SURFACES.md)', async ({ page }) => {
    // The inline init runs before the deferred nav.js patches fetch with the
    // token interceptor, so the first /data/prompt-templates.json fetch 401s.
    // hydrateFromBackend now retries across that window; it must land on the
    // LIVE (populated or empty) state rather than the offline demo seed, and
    // the empty-state must render its placeholder card without throwing.
    // (Requires a server serving the CURRENT gui/ — a long-running dev server
    // that cached an old nav.js/prompts.html will read OFFLINE; restart it.)
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/gui/prompts.html');
    const tag = page.locator('#tplBackendTag');
    await expect(tag).not.toContainText('OFFLINE', { timeout: 12_000 });
    await expect(tag).toContainText('LIVE', { timeout: 12_000 });
    // The fake @offline-demo sample rows must never be what a connected user sees.
    await expect(page.locator('#tplList')).not.toContainText('cli-reviewer');
    const real = errors.filter((e) => !/AbortError|Failed to fetch|NetworkError/i.test(e));
    expect(real, real.join('\n')).toHaveLength(0);
  });

  test('All Settings renders typed controls via the shared config-render module', async ({ page }) => {
    // settings.html now builds every row with the shared SeekDeepConfigRender
    // module (config-render.js) instead of inline logic — the first step of
    // unifying the two config UIs. Drive the real page: the module must load,
    // the schema must render rows, and makeControl must produce a working
    // toggle + select + input — with no uncaught error from the extraction.
    // Assertions are by control TYPE (not specific keys) so they're robust to
    // whatever /config/schema the server returns.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/gui/settings.html');
    const hasModule = await page.evaluate(() =>
      !!(window.SeekDeepConfigRender && typeof window.SeekDeepConfigRender.makeControl === 'function'));
    expect(hasModule, 'SeekDeepConfigRender.makeControl must be loaded').toBe(true);
    const rows = page.locator('.set-row[data-key]');
    await expect(rows.first()).toBeAttached({ timeout: 12_000 });
    expect(await rows.count(), 'schema should render many rows').toBeGreaterThanOrEqual(30);
    // Each kind path in makeControl must produce its control.
    expect(await page.locator('.set-row .toggle').count(), 'toggle path').toBeGreaterThanOrEqual(1);
    expect(await page.locator('.set-row select').count(), 'select path').toBeGreaterThanOrEqual(1);
    expect(await page.locator('.set-row input').count(), 'input path').toBeGreaterThanOrEqual(1);
    const real = errors.filter((e) => !/AbortError|Failed to fetch|NetworkError/i.test(e));
    expect(real, real.join('\n')).toHaveLength(0);
  });

  test('Control Center selects render from the schema + save hook reads them (merge step 2c)', async ({ page }) => {
    // app.html's hand-coded SELECT rows are reconciled through the shared
    // renderer on config-pane load, so their options come from /config/schema
    // and can't drift from All Settings. CHAT_PROVIDER's hand-coded list omitted
    // 'ollama'; the schema enum has it — so its presence proves the reconcile
    // ran. We read the converted control via the 2a save hook (_sdRead) directly
    // rather than driving #cfg-save, so this never touches the real .env.
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/gui/app.html');
    await page.evaluate(() => window.SeekDeepPrompt?.close?.(null));
    await page.locator('.sidebar a[data-mod="config"]').click();
    // Against a served build that predates config-render.js in app.html (i.e. an
    // installed build older than this merge), there's nothing to reconcile —
    // skip rather than fail. CI serves the repo gui/, so it runs there.
    const hasRenderer = await page.evaluate(() => !!(window.SeekDeepConfigRender && window.SeekDeepConfigRender.makeControl));
    test.skip(!hasRenderer, 'served GUI predates config-render.js wiring in app.html (pre-2c build)');
    const row = page.locator('.config-row').filter({ has: page.locator('.key', { hasText: 'CHAT_PROVIDER' }) });
    const sel = row.locator('select').first();
    await expect(sel).toBeAttached({ timeout: 12_000 });
    await expect(sel.locator('option', { hasText: 'ollama' })).toHaveCount(1, { timeout: 8_000 });
    await sel.selectOption('ollama');
    const hooks = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.config-row')].find((x) => (x.querySelector('.key')?.textContent || '').trim() === 'CHAT_PROVIDER');
      return {
        sdRead: typeof r._sdRead === 'function' ? r._sdRead() : '(missing)',
        hasHydrate: typeof r._sdHydrate === 'function',
      };
    });
    expect(hooks.sdRead, 'save serializer reads the converted control via _sdRead').toBe('ollama');
    expect(hooks.hasHydrate, 'hydrate hook (_sdHydrate) present on the converted row').toBe(true);
    const real2 = errors.filter((e) => !/AbortError|Failed to fetch|NetworkError/i.test(e));
    expect(real2, real2.join('\n')).toHaveLength(0);
  });
});
