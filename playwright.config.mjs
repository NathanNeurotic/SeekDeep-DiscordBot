// SeekDeep · Playwright config (audit §12)
// =========================================
// Browser-driven smoke of the Control Center tabs. The audit's point: the
// in-process smoke suite (scripts/smoke_gui_endpoints.py) and doctor.mjs
// never load HTML or click anything, so every UI regression (dead toggles,
// stale version pill, data-dir rule bug) shipped unless a human happened to
// click the right button. These specs close that gap.
//
// Uses the system Edge (channel: 'msedge') — the SAME WebView2 engine the
// Tauri shell renders with — so there's no 130 MB chromium download and the
// tests exercise the real runtime. Edge ships on every Win10/11.
//
// The AI server must be reachable at http://127.0.0.1:7865 (it serves /gui).
// Start it first: `.venv/Scripts/python local_ai_server.py`, then
// `npm run test:e2e`. CI starts it in the workflow step before this runs.
import { defineConfig, devices } from '@playwright/test';

const BASE = process.env.SEEKDEEP_E2E_BASE || 'http://127.0.0.1:7865';
// Local (Windows): default to system Edge — same WebView2 engine the Tauri
// shell uses, no 130 MB download. CI (Linux) sets SEEKDEEP_E2E_CHANNEL=chromium
// since Edge isn't present there.
const CHANNEL = process.env.SEEKDEEP_E2E_CHANNEL || 'msedge';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,       // one server, serialize to avoid model-load contention
  retries: 1,                 // ride out a single sidecar-respawn blip
  reporter: [['list']],
  use: {
    baseURL: BASE,
    headless: true,
    actionTimeout: 8_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: CHANNEL === 'chromium' ? 'chromium' : 'edge',
      use: CHANNEL === 'chromium'
        ? { ...devices['Desktop Chrome'] }            // bundled chromium (CI)
        : { ...devices['Desktop Edge'], channel: CHANNEL },  // system Edge (local)
    },
  ],
});
