# MAINTAINER.md

How to maintain `gui/` and the backend wiring around it without losing
work to recurring "designer zip" drops.

This file exists because every designer-shipped zip we've merged so
far (zips 15, 17, 18, 19, 20, 21, 22, 23, 27) has done the same
three things wrong, and we keep having to undo them by hand. Treat
this file as the playbook so any future zip merge is a checklist
instead of fresh discovery.

---

## 1. Files with overrides — DO NOT accept the designer's version verbatim

These files are owned by us, not by the designer. Their zips ship
older or regressed copies. Always keep our version and port any
genuinely new pieces into it manually.

| File | What our version contains that the designer's drops |
|---|---|
| `gui_endpoints.py` | Schema normalizers for `server-stats` / `auto-reactions`, PID-aware launcher (reads `logs/local-ai.pid` + `logs/bot.pid`), `ai-server` self-host guard (returns 409 instead of trying to kill itself), real `/model/warm` dispatch via `warmup_handlers={}` kwarg, `/config/status` with sensible REQUIRED/OPTIONAL classification, `/token` endpoint + `X-SeekDeep-Token` dependency on the three write routes |
| `INTEGRATION.md` § 4 | Archive bridge snippet rewritten to match `index.js` conventions: sync `fs` (not `fs/promises`), `writeJsonAtomic` helper, `seekdeepReadArchiveGuildConfig()`, `client.once('clientReady', ...)` (not `'ready'`). Designer's draft uses APIs that don't exist in the actual file. |
| `local_ai_server.py` register block | Passes `warmup_handlers={chat,image,vision}` wired to the real loaders. The designer's docs say "add 2 lines" — adding 2 lines gives you a stub `/model/warm` that never loads anything. |
| `local_ai_server.py` Ollama backend | `_resolve_chat_backend` + `_run_ollama_generation` + `_ollama_*` helpers + `warm_chat_role` + `chat_backends` / `ollama` keys in `/health`. Designer ships nothing about Ollama. Per-role HF↔Ollama dispatch lives here. See INTEGRATION.md §3.4. |
| `gui/nav.js` token interceptor | Monkey-patches `window.fetch` to auto-inject `X-SeekDeep-Token` on same-origin POSTs. Designer's nav.js does not know about auth. |
| `gui/nav.js` events.js auto-load | The tail of `nav.js` dynamically appends `<script src="events.js">` so `window.SeekDeepEvents` exists on every page. Designer's nav.js does not do this. |
| `gui/events.js` | Entire file is ours — designer doesn't ship this. WebSocket consumer for `/events` (pub/sub for `model.loaded` / `vram.sample` / `queue.depth` / `log.line` / etc). |
| `gui/version.js` | Entire file is ours — designer doesn't ship this. Reads `version` from `/health` and rewrites every `[data-version]` element. Hardcoded version strings stay as the fallback if `/health` is unreachable. |
| `gui/playground.js` | Entire file is ours — designer doesn't ship this. Turns the `chat.html` composer into a live local AI playground (drives `/chat`, `/image`, `/vision`, `/memory/*` via slash commands). Auto-injected by `nav.js` on every page; self-gates to chat.html only. Hooks designer's existing `#msgInput`, `.composer .send-btn`, and `#messages` selectors — if designer changes those, playground breaks silently (preflight `js` stage catches the parse error but not the selector mismatch). |
| `src-tauri/` (entire dir) | Tauri 2 desktop shell. Cargo.toml, tauri.conf.json, build.rs, src/main.rs, src/lib.rs, capabilities/, icons/. Designer never touches Rust — this is entirely Claude Code's. The Tauri shell wraps the existing browser GUI in a native window; building it produces Windows .msi / .exe, macOS .dmg, Linux .AppImage installers via the `.github/workflows/tauri-release.yml` rolling-nightly workflow. |
| `.github/workflows/tauri-release.yml` | CI matrix-builds the Tauri app on Win/Mac/Linux and publishes installers as a rolling `nightly` pre-release on every push to main. Companion to the existing `preflight` workflow — that catches code regressions; this catches build/packaging regressions. |

When a zip arrives:

1. Diff its `gui_endpoints.py` against ours. If the zip adds a new endpoint or
   helper, port that piece in. Discard everything else.
2. Diff its `INTEGRATION.md` against ours. Same pattern.
3. Verify the `gui/nav.js` token interceptor is still present at the top of
   the IIFE after copying. If the zip's nav.js shipped without it, paste it
   back in from this repo's history.

---

## 2. Recurring designer slip-ups — fix on every merge

The designer's *narrative* in chat doesn't match what the zip *ships*. This
list catches what they always forget. Audit before each merge:

| Designer claim | What the zip actually does | Fix |
|---|---|---|
| "Brand surface removed" | `brand.html` still in the zip, still linked from `app.html` sidebar + `landing.html` topnav + "View design system" CTA + `nav.js` palette | Delete `gui/brand.html`; strip all 5 references; renumber hub cards (currently 01-14) and `nav.js` palette (currently 01-15) to fill the gap |
| "Every `seekdeep-mark.png` swapped to animated WebP" | Zero `.webp` references in any HTML — orphan asset | Swap all `seekdeep-mark.png` references to `seekdeep-mark.webp` across every `gui/*.html` and `gui/nav.js` |
| "Hub cards renumbered 01-N" | Renumbered with a gap (e.g. jumps 01 → 03 because they forgot to remove the brand entry first) | Re-renumber to be consecutive after our brand removal |
| "gui_endpoints.py has all endpoints" | Ships the old 321-line version without normalizers/PID/auth/etc. | See §1 |

Use the Python helper at the bottom of this file (§ 7) to run the brand+webp
sweep in one shot.

---

## 2.5 Recurring designer-audit misconceptions — sanity-check before acting

When designer ships a deep audit of the repo (not just a zip drop), some findings are based on their **local working copy**, which lags behind `main`. Run these cross-checks on every audit before doing any work:

| Designer says | Cross-check | What's actually true |
|---|---|---|
| "nav.js TODO tails were never re-pasted" | `grep -c installTokenInterceptor gui/nav.js` (should be >0) and `grep -c autoLoadSiblings gui/nav.js` (should be >0) | The three tails (installTokenInterceptor, events.js auto-load, version.js auto-load) ARE pasted on main. Designer's local nav.js still has the TODO marker; ours doesn't. |
| "Stale vendor-drop folders in the repo" (`seekdeep-designer-drop/`, `seekdeep-gui-cumulative/`, `seekdeep-zip-35/`, etc.) | `ls -d seekdeep-* 2>/dev/null` (should return nothing) | These dirs exist INSIDE designer's zips, never extracted to main. Don't try to delete them. |
| "Legacy v1 files (index v1.html, landing v1.html, pitch v1.html)" | `ls gui/*v1*.html 2>/dev/null` (should return nothing) | Designer's local backup copies. Not in main. |
| "Move gui_endpoints.py, local_ai_server.py, index.js, smoke_test.mjs into reference/" | Those files ARE the bot. We're a bot + GUI mono-repo. | Moving them breaks every script, import, and CI workflow. They belong at root. |
| "Four copies of HANDOFF_CLAUDE_CODE.md" | `find . -name HANDOFF_CLAUDE_CODE.md` (should return exactly 1) | One copy at root. The "extras" exist only in designer's zip dirs. |
| "v10.35 hardcoded in 78 cells, never gets rewritten" | Verify `[data-version]` is on the element and `version.js` is loaded via `nav.js`'s autoLoadSiblings | The literal `v10.35` is the **offline fallback** for `[data-version]` cells. When `version.js` runs (auto-injected on every page via nav.js), it rewrites them all to whatever `/health.version` returns. The literal only shows if `version.js` didn't load OR `/health` is unreachable. |
| "INTEGRATION.md is a stub" | `wc -l INTEGRATION.md` (should be 500+) | Our INTEGRATION.md is fully populated. Designer may be looking at a stub copy inside one of their zips. |

**Latest audit response:** see [`AUDIT_DESIGNER_2026-05-25.md`](AUDIT_DESIGNER_2026-05-25.md) for the full 30-finding breakdown of which were real vs misconception. Real findings folded into PLANNED.md as items G/H/I/J.

---

## 3. The token auth model

Set up automatically. You shouldn't have to do anything.

- On first server boot, `gui_endpoints.py` checks `.env` for `SEEKDEEP_GUI_TOKEN`.
- If absent, generates a 32-byte url-safe random token and appends it
  to `.env` (preserves existing content).
- The three write endpoints — `POST /config`, `POST /launcher/{svc}/{action}`,
  `POST /model/warm` — require `X-SeekDeep-Token: <token>` on every request.
- Read endpoints (`/health`, `/gpu`, `/data/*`, `/logs/*`, `/config/status`)
  stay open so the page renders without the token.
- The GUI's `nav.js` monkey-patches `window.fetch` to grab the token from
  `GET /token` (loopback-only) and add the header to every same-origin POST
  automatically. Designer-shipped HTMLs don't need to know about it.

### Operations

| Action | How |
|---|---|
| Rotate the token | Edit `SEEKDEEP_GUI_TOKEN` in `.env`. Browsers cache it until next refresh; tell users to Ctrl+F5. No server restart needed — the dependency re-reads `.env` on each request. |
| Disable auth (trusted local dev only) | Set `SEEKDEEP_GUI_TOKEN_DISABLED=1` in the environment (or `.env`) and restart the server. The `[SeekDeep] auth DISABLED` log line will appear at startup. |
| Recover from a wiped token | If `.env` loses `SEEKDEEP_GUI_TOKEN`, restart the server — it'll regenerate. |
| Use POSTs from outside the GUI | `curl -H "X-SeekDeep-Token: $(grep ^SEEKDEEP_GUI_TOKEN= .env | cut -d= -f2-)" ...` |

### Security model — what this protects against and what it does not

Protects:

- A second program running on the same box (browser extension, sibling
  service, copy-paste from a tutorial) calling `POST /config` or
  `POST /launcher/bot/stop` without your knowledge. Requires the token,
  which is only readable by users with access to `.env`.
- A request bouncing through an authenticating reverse proxy on a non-
  loopback interface — the proxy can serve `GET /gui/`, but only its
  caller can read the token from the served HTML (we serve the token
  via `GET /token`, which only answers loopback callers).

Does not protect:

- Any user with shell access to the box (they can `cat .env`).
- Anyone with network access to port 7865 if you've exposed it via
  ngrok / cloudflare tunnel / port-forward — the token leaks via the
  tunnel like any other response body. **Don't do that.** Bind to
  `127.0.0.1` only (the default in `local_ai_server.py`).

---

## 4. Branch hygiene

Main contains everything. We deliberately do not maintain long-lived
feature branches.

- Designer iterations land directly on `main` after the merge protocol in §1+§2.
- Audit fixes land directly on `main`.
- Worktrees under `.claude/worktrees/` are runtime-managed by Claude Code and
  may be created/destroyed without notice.
- The `backup/*` branch is a manual safety net. Don't delete it.
- The remote `jules-*` and `backup` branches are external bot/backup branches,
  not ours.

Periodic cleanup:

```bash
# Show local branches that have nothing main doesn't already have
git for-each-ref --format='%(refname:short)' refs/heads/ | \
  while read -r br; do
    [ "$br" = "main" ] && continue
    ah=$(git rev-list --count "main..$br" 2>/dev/null)
    [ "$ah" = "0" ] && echo "$br (safe to delete)"
  done
```

---

## 4.3 · Doc split (README / AGENTS / CODEX_REPO_BRIEF / INTEGRATION / MAINTAINER)

| File | Role | Audience | Canonical for |
|---|---|---|---|
| `README.md` | User-facing manual | new users, contributors | install, configure, run, commands, feature flags, tunables |
| `AGENTS.md` | Architecture reference | maintainers, internal contributors | each agent/subsystem (chat, vision, image, web search, archive, etc.) and where its entry points live |
| `CODEX_REPO_BRIEF.md` | AI-assistant onboarding | Codex / Claude / etc. picking up the repo cold | repo shape, routing map, common edit playbooks, gotchas |
| `INTEGRATION.md` | GUI ↔ backend wiring spec | anyone wiring the GUI to a backend | static mount, write endpoints, auth, WebSocket bridge, archive bot bridge |
| `MAINTAINER.md` | This file | future-me, anyone merging designer zips | designer-zip merge protocol, audit overrides catalog, recurring slip-ups |

When two of these documents describe the same thing and they disagree:
- For agent/subsystem behavior → **AGENTS.md wins**, update the others.
- For user-facing commands → **README.md wins**.
- For GUI ↔ backend wiring → **INTEGRATION.md wins**.
- For "how do I handle the next designer zip" → **MAINTAINER.md wins**.

The designer never touches these docs. They're entirely ours to maintain.

## 4.4 · `.env.default` vs `.env.example`

Two intentional roles, documented in the headers of each file:

- **`.env.default`** — minimal first-run template. `setup_local.ps1` copies
  this file to `.env` on first run if `.env` is missing. Keep it lean; only
  the keys a user MUST set or that we want them to see immediately.
- **`.env.example`** — full env reference. Every supported environment
  variable with section headers and inline comments. Read it when you want
  to know "is there a knob for X?". Setup does NOT copy it; users copy
  individual sections into their `.env` (or into `.env.default` if they
  want a knob shipped to fresh installs).

Invariant: `.env.example` is a strict superset of `.env.default`. After
adding a new key to either file, run:

```bash
grep -E "^[A-Z_]+=" .env.default | cut -d= -f1 | sort -u > /tmp/d.txt
grep -E "^[A-Z_]+=" .env.example | cut -d= -f1 | sort -u > /tmp/e.txt
comm -13 /tmp/e.txt /tmp/d.txt   # should print nothing
```

If it prints something, add those keys to `.env.example` so the reference
stays complete.

## 4.5 · Version `[data-version]` pattern (for the designer to adopt)

Every HTML page hardcodes the version in the titlebar / footer / sidebar
(`v10.35` at time of writing). Until the designer marks those cells, the
hardcoded text shows. Once they mark them as below, `gui/version.js`
auto-overwrites the text with the actual server version from `/health`:

```html
<!-- BEFORE (literal) -->
<span class="pill">v10.35</span>

<!-- AFTER (auto-swapped) -->
<span class="pill" data-version>v10.35</span>
```

The literal text stays as the static fallback so `file://` viewing still
shows a sensible value. When the server is up, `version.js` rewrites it
to whatever `/health` reports.

Optional attributes:
- `data-version-prefix="v"` — force the prefix even if /health returns a
  numeric-only version like `10.35`.
- `data-version-raw` — suppress the auto `v` prefix entirely.

The designer just needs to add `data-version` to every existing version
cell. No JS / fetch / wiring on their side — `version.js` is auto-loaded
by `nav.js`.

## 5. After every merge — verification checklist

The fast path is one command:

```bash
npm run preflight
```

`preflight` (defined in `scripts/preflight.mjs`) runs three stages:

- **js** — `node --check` on `index.js`, `smoke_test.mjs`, `scripts/preflight.mjs`, `gui/nav.js`
- **py** — `python -m py_compile` on `local_ai_server.py`, `warmup_local_cache.py`, `gui_endpoints.py`
- **smoke** — `node smoke_test.mjs` (no Discord login, no model load, no file mutation)

Exit code 0 = green. Same checks run in CI on every push + PR via
`.github/workflows/ci.yml`.

When you want the deeper check (full server import + route enumeration,
beyond what py_compile gives you):

```bash
.venv/Scripts/python.exe -c "
import sys, importlib.util; sys.path.insert(0, '.')
spec = importlib.util.spec_from_file_location('s', 'local_ai_server.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print('GUI routes:',
      sorted(set(r.path for r in m.app.routes if hasattr(r, 'path') and r.path.startswith(('/config','/data','/launcher','/logs','/model','/gui','/token')))))
"
```

Expected GUI routes after a healthy merge:

```
['/config', '/config/status', '/data/{file}', '/gui',
 '/launcher/{service}/{action}', '/logs/stream', '/logs/tail',
 '/model/warm', '/token']
```

And the one-liner that catches the recurring designer slip-ups:

```bash
grep -lE "brand\.html|seekdeep-mark\.gif" gui/*.html gui/*.js 2>/dev/null && \
  echo "FAIL: brand or .gif refs still present" || echo "OK: clean"
```

---

## 6. Asset weight

`gui/assets/` should stay under ~5 MB. Current state:

| File | Size | Purpose |
|---|---|---|
| `seekdeep-mark.webp` | 473 KB | Animated 512×512 @ 25 fps logo (was 18 MB GIF) |
| `seekdeep-mark.png` | 1.5 MB | Static fallback (no JS contexts) |
| `seekdeep-logo.png` | 1.5 MB | Wordmark |
| `seekdeep-banner.png` | 2.0 MB | Optional hero / README art |

If a future zip ships a `seekdeep-mark.gif`, re-encode it before committing:

```bash
ffmpeg -y -i gui/assets/seekdeep-mark.gif \
  -vf "scale=512:512:flags=lanczos,fps=25" \
  -c:v libwebp -q:v 75 -loop 0 -an \
  gui/assets/seekdeep-mark.webp
rm gui/assets/seekdeep-mark.gif
```

The 18 MB GIF still exists in git history. To evict it from history:

```bash
git lfs migrate import --include="*.gif" --everything   # move to LFS, OR
git filter-branch --tree-filter 'rm -f gui/assets/seekdeep-mark.gif' HEAD
```

Both rewrite history. Coordinate with anyone else with a clone.

---

## 7. Merge helper script

Paste this into a Python REPL (or save as `scripts/merge_gui_zip.py`) when a
new designer zip lands. It performs the recurring fixes in one shot.

```python
import re, glob, os, sys
from pathlib import Path

GUI = Path('gui')

# 1. Delete brand.html if it appeared
brand = GUI / 'brand.html'
if brand.exists():
    brand.unlink()
    print('removed gui/brand.html')

# 2. Strip every brand.html reference
for f in list(GUI.glob('*.html')) + [GUI / 'nav.js']:
    if not f.exists(): continue
    s = f.read_text(encoding='utf-8')
    orig = s
    s = re.sub(r'\s*<a href="brand\.html"[^>]*>.*?</a>', '', s, flags=re.DOTALL)
    s = re.sub(r'\s*<a class="btn btn-ghost" href="brand\.html"[^>]*>.*?</a>', '', s, flags=re.DOTALL)
    s = re.sub(r'\s*<div class="grp"[^>]*>v[\d.]+</div>\s*<a data-mod="brand"[^>]*>.*?</a>',
               '\n      <div class="grp" style="margin-top:auto; padding-top: 24px;">v10.15</div>',
               s, flags=re.DOTALL)
    # nav.js PAGES entry
    s = re.sub(r"\s*\{\s*id:\s*'brand',[^}]*\},", '', s)
    if s != orig:
        f.write_text(s, encoding='utf-8')
        print(f'stripped brand from {f.name}')

# 3. Re-swap seekdeep-mark.png and .gif -> .webp
swapped = 0
for f in list(GUI.glob('*.html')) + [GUI / 'nav.js']:
    if not f.exists(): continue
    s = f.read_text(encoding='utf-8')
    new = s.replace('seekdeep-mark.gif', 'seekdeep-mark.webp') \
           .replace('seekdeep-mark.png', 'seekdeep-mark.webp')
    if new != s:
        f.write_text(new, encoding='utf-8')
        swapped += (s.count('seekdeep-mark.png') + s.count('seekdeep-mark.gif'))
print(f'swapped {swapped} mark refs to .webp')

# 4. Verify the token interceptor still exists in nav.js
nav = (GUI / 'nav.js').read_text(encoding='utf-8')
if 'installTokenInterceptor' not in nav:
    print('FAIL: nav.js is missing the token interceptor. Re-paste from MAINTAINER.md §3 or git log.')
    sys.exit(1)
print('nav.js token interceptor: OK')
```

---

## 8. When everything breaks

`git diff HEAD~5 -- gui_endpoints.py local_ai_server.py INTEGRATION.md gui/nav.js`
will show what the recent designer/audit churn has been. The last commit
message tagged `[main]` on `main` is typically a good rollback target.

`git reflog` covers anything you blew away locally.
