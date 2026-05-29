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
});
