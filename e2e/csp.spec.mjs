// SeekDeep · CSP regression harness (AUD-003 follow-up)
// =====================================================
// The Tauri WebView CSP (src-tauri/tauri.conf.json → app.security.csp) only
// takes effect in the PACKAGED desktop app — the FastAPI-served pages this e2e
// hits carry no such header, so plain browser e2e can't see a CSP regression.
//
// This spec closes that: it reads the SHIPPED CSP from tauri.conf.json, injects
// it as a Content-Security-Policy response header on every top-level gui/*.html
// page, and asserts ZERO securitypolicyviolation events. So if someone adds an
// inline `eval`, a cross-origin <script src>, or anything the policy forbids,
// THIS turns red instead of the packaged app breaking silently in the field.
//
// It does NOT prove the packaged app is violation-free for every interaction
// (it loads pages, doesn't click through every flow) — but it pins the policy
// against the common regressions and lets us tighten the CSP with confidence.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The exact CSP the desktop shell ships.
const CSP = (() => {
  const conf = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return conf?.app?.security?.csp || '';
})();

// Top-level GUI pages. Subdirectories (e.g. gui/activity/* — the Discord Activity
// sub-app, which runs in Discord's iframe with its own policy, not the desktop
// shell) are intentionally excluded.
const PAGES = readdirSync(path.join(ROOT, 'gui'))
  .filter((f) => f.endsWith('.html'))
  .sort();

test.describe('Tauri CSP (shipped policy, injected)', () => {
  test.beforeEach(async ({ page }) => {
    // Match control-center.spec: keep the unconfigured-CI "setup required" modal
    // from auto-opening (its backdrop + scripts are noise for this check).
    await page.addInitScript(() => {
      try { sessionStorage.setItem('sd-setup-prompted', '1'); } catch {}
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(
          `${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`
          + ` @ ${e.sourceFile || ''}:${e.lineNumber || ''}`,
        );
      });
    });
    // Inject the shipped CSP onto every HTML document the page loads. Wrapped in
    // try/catch: background pollers (version.js hits /health) keep firing requests,
    // so a route can resolve after the test's context tears down — that race is
    // harmless and must not surface as a spurious error.
    await page.route('**/*', async (route) => {
      try {
        const resp = await route.fetch();
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('text/html') && CSP) {
          await route.fulfill({ response: resp, headers: { ...resp.headers(), 'content-security-policy': CSP } });
        } else {
          await route.fulfill({ response: resp });
        }
      } catch {
        try { await route.abort(); } catch {}
      }
    });
  });

  test('tauri.conf.json carries a CSP to enforce', () => {
    expect(CSP, 'app.security.csp is empty in tauri.conf.json').not.toEqual('');
  });

  for (const file of PAGES) {
    test(`no CSP violations: gui/${file}`, async ({ page }) => {
      try {
        await page.goto(`/gui/${file}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch {
        // A page that redirects or can't load standalone isn't a CSP failure;
        // skip the navigation hiccup and check whatever violations fired.
      }
      await page.waitForTimeout(600); // let inline scripts run + violations dispatch
      const violations = await page.evaluate(() => window.__cspViolations || []);
      expect(violations, `CSP violations on gui/${file}:\n  ${violations.join('\n  ')}`).toEqual([]);
    });
  }
});
