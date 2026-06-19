const RELEASES = [
  { v: 'v10.38', kind: 'major', tagline: 'GUI⇄Discord parity · self-service TTS · CSP Phase A · DataDash Activity · audit round-2', tags: ['feat','fix','perf'], items: [
    '<strong>DataDash resize-safety now covers every hazard, not just terrain:</strong> a follow-up to the mid-run resize fix. That fix rescaled the player + live terrain columns, but other things storing absolute vertical coordinates didn&rsquo;t move with the resized channel — so once the brief post-resize invulnerability expired they could still kill you: in-flight <strong>firewalls</strong> (their <span class="mono">gapY/gapH</span> desynced from the channel), the <strong>reverse-replay history</strong> (<span class="mono">colHistory</span>, replayed by the rewind mystery), and <strong>bots / bombs / bullets</strong> sitting at stale Y. <span class="mono">resize()</span> now rescales all of them — plus player bullets, pickups, and the <strong>boss daemons</strong> (<span class="mono">y / homeY / ty / orbR / crashVy</span>) — by the same height ratio, so a resize/rotate is fully consistent across every gameplay state, including a boss fight. The per-entity rescaling now runs through one shared <span class="mono">rescaleProps</span> helper (internal cleanup, no behavior change). From three rounds of review on the resize fix.',
    '<strong>Image-prompt buttons now survive a bot restart:</strong> the Original / Refined / Both choices were held in an in-memory map that was wiped on every restart — and since deploys kill+respawn the bot, clicking a button created before a restart hit the &ldquo;prompt choice expired&rdquo; path (or, mid-reconnect, Discord&rsquo;s &ldquo;This interaction failed&rdquo;). That pending state is now persisted to <span class="mono">data/pending-image-prompts.json</span> (atomic write, 15-min TTL, expired entries dropped on load) and rehydrated on boot, so the buttons keep working across a restart. Best-effort: a persistence hiccup only loses restart-survivability, never the live flow. Likely the cause behind the &ldquo;action failed&rdquo; button report.',
    '<strong>Image generation: faster prompt-refine, visible failures, clearer timing:</strong> three fixes to the <span class="mono">draw</span> / image flow. (1) <strong>Refine no longer wastes seconds on a doomed model:</strong> the prompt-refine role defaulted to the <em>multimodal</em> lightweight model (<span class="mono">gemma-3n</span>), which can&rsquo;t load as a causal text LM — so every refine tried it, failed (<span class="mono">multimodal-not-causal-lm</span>), and fell back to Granite, adding seconds. Refine now resolves straight to the text fallback model (and a <span class="mono">.env</span> default pins it). (2) <strong>Failures are no longer silent:</strong> if a queued Original/Refined generation errors (server down/busy), the bot now posts the reason instead of leaving a frozen &ldquo;Queued…&rdquo; card with the loading spinner. (3) <strong>Honest timing:</strong> the prompt-choice card showed &ldquo;Time to Generate&rdquo; before anything was generated — it now reads &ldquo;Time to Prepare&rdquo; (that number is the prep/refine time). Surfaced from a live chat. (Bot + server side — takes effect after the next bot restart + server update.)',
    '<strong>DataDash: resizing / rotating mid-run no longer kills you:</strong> follow-up to the resolution-independence fix. The terrain columns store absolute ceil/floor frozen at creation, but the collision check mixes them with the <em>live</em> height — so when the viewport height changed mid-run (window resize, device rotation, or the mobile address-bar sliding in/out) the floor dropped under the craft and instantly cost a &ldquo;wall&rdquo; life. <span class="mono">resize()</span> now rescales the player <em>and</em> the live terrain by the same height ratio so the channel stays aligned, with brief invulnerability as a safety net for in-flight firewalls/bullets. From a code review (the review&rsquo;s player-only rescale would have desynced the craft from the un-rescaled channel; rescaling both is the complete fix).',
    '<strong>DataDash difficulty no longer changes with window size / zoom (mobile was near-impossible):</strong> the game world filled the viewport, so every speed and the player&rsquo;s hitbox were fixed pixels while the gaps scaled with the window — on a small/short canvas the craft was huge relative to the (height-relative) gaps and obstacles gave far less reaction time, so a phone felt unplayable while a big monitor felt easy. Gameplay is now normalized to a fixed reference field: vertical motion + the player scale by <span class="mono">H/refH</span>, the scroll + columns + side-thrust by <span class="mono">W/refW</span>, and enemy/boss projectiles by the geometric mean — so the player-to-gap ratio, reaction time, and terrain undulation are constant across screens and zoom levels. The view still fills the window (no letterbox). Score/economy stays tied to the <em>unscaled</em> scroll, so best-scores remain comparable across devices. New <span class="mono">TUNING.refW/refH</span> set the global difficulty baseline.',
    '<strong>CI now type-checks the Rust shell on all three OSes:</strong> the PR-time <span class="mono">cargo check</span> ran on Linux only, so Windows-only / macOS-only <span class="mono">#[cfg]</span> arms (like the per-OS Docker-CLI resolver) never compiled until a tagged release build — a platform-specific break could pass every PR check and only surface at MSI/DMG time. The <span class="mono">rust</span> job is now a <span class="mono">[ubuntu, windows, macos]</span> matrix (<span class="mono">fail-fast: false</span> so one red OS doesn&rsquo;t mask the others), closing that gap. Linux build deps stay Linux-only; the Windows/macOS runners already ship what <span class="mono">cargo check</span> needs.',
    '<strong>Docker probe pins the absolute CLI on macOS too:</strong> a follow-up to the L-4 PATH-hijack hardening (which only covered Windows). The Docker-start probe now prefers standard absolute binaries on macOS — Docker Desktop&rsquo;s bundled CLI (<span class="mono">/Applications/Docker.app/&hellip;/docker</span>), then the symlink Docker Desktop installs / the Intel-Homebrew prefix (<span class="mono">/usr/local/bin/docker</span>), then the Apple-Silicon Homebrew prefix (<span class="mono">/opt/homebrew/bin/docker</span>) — before the bare-<span class="mono">docker</span> PATH fallback, so a polluted <span class="mono">PATH</span> (or a cwd-local <span class="mono">docker</span>) can&rsquo;t shadow it. The Homebrew prefixes are user-writable so they aren&rsquo;t a hard trust boundary, but pinning them still beats PATH-order shadowing and is never worse than the PATH fallback. Linux/BSD stay on PATH resolution — CLI locations there vary by distro/runtime with no single canonical path to pin. From two rounds of code review on the L-4 PRs.',
    '<strong>Bot stops promising diagrams it can&rsquo;t draw:</strong> asked &ldquo;how do you work,&rdquo; the 8B chat model would offer to <em>draw a diagram of its internals</em> via <span class="mono">/image</span> — but image gen is an SDXL <em>art</em> model (it painted a fantasy ship, not a diagram), and it also echoed the literal <span class="mono">/draw &hellip;</span> command back as a chat reply for the user to run by hand. Tightened the system prompt: image gen is now explicitly described as scene/character/concept art that <em>cannot</em> produce accurate diagrams, flowcharts, charts, or legible text; the model is told never to promise a &ldquo;diagram of its internals&rdquo; (explain in words instead) and never to answer with a slash-command string (typing one doesn&rsquo;t run it). Surfaced from a live chat. (Bot-side — takes effect on the next bot restart.)',
    '<strong>Security-audit follow-ups (M-2 / L-4 + M-1 documented):</strong> from the 2026-06-18 audit. <strong>M-2:</strong> the GUI cross-process config lock now FAILS CLOSED — a write that can&rsquo;t get the lock within the timeout returns a retryable <span class="mono">503</span> instead of silently proceeding and risking a lost update (the Node bot&rsquo;s twin lock stays fail-open — it has no HTTP caller to retry and forward progress matters there). <strong>L-4:</strong> the Docker probe prefers the absolute Docker Desktop CLI path over a bare <span class="mono">docker</span> from <span class="mono">PATH</span> (and still falls back to PATH so non-standard installs keep detecting). <strong>M-1:</strong> the Tauri global-IPC blast radius is now documented in <span class="mono">SECURITY.md</span> as accepted, BOUNDED residual risk (every command input is validated/fixed — disruptive, not RCE); the real fix (drop <span class="mono">withGlobalTauri</span>) needs a GUI build step and is tracked as a follow-up. Token-gating was rejected as security theater since <span class="mono">/token</span> is open.',
    '<strong>Security-audit hardening (low-severity items):</strong> from the 2026-06-18 security + reliability audit. (1) The GUI smoke test no longer kills the operator&rsquo;s running bot — the <span class="mono">/launcher/bot/kill-all</span> check is now hermetic (it mocks process discovery, so it verifies auth + response shape with <span class="mono">found:0</span> instead of enumerating and killing real bot processes), which also fixes a flaky failure on busy machines. (2) <span class="mono">POST /chart</span> validates <span class="mono">day_buckets</span> defensively — a malformed date key or a non-object row now returns a clean 400 instead of an unhandled 500. (3) Corrected the SSRF docs (<span class="mono">SECURITY.md</span> + the code comment): DNS rebinding is fully closed by the pinned-IP fetch agent — the old &ldquo;not fully closed&rdquo; note was stale. No critical or unauthenticated-RCE findings; the remaining audit items (self-update signing default, Tauri IPC blast radius, fail-open locks) are tracked separately.',
    '<strong>Lite-mode toggle stays in sync across windows:</strong> a follow-up to the localStorage fallback — the state read prioritized the in-memory value, which (when storage works) would let one window&rsquo;s choice permanently shadow a toggle made in another window. Now it reads <span class="mono">localStorage</span> first (in-memory fallback only when storage throws) and listens for the cross-window <span class="mono">storage</span> event, so flipping the toggle in one window updates the others <em>instantly</em>; the blocked-storage behavior is unchanged. From a code review of the fallback PR.',
    '<strong>Lite-mode toggle works even when localStorage is blocked:</strong> the FX / Lite toggle persisted only via <span class="mono">localStorage</span>; if that throws (blocked storage, or a private window in the loopback browser) a click showed a success toast but had no visible effect — the state read fell back to the OS preference. Added a session-scoped in-memory fallback so the toggle always applies for the current session; a readable <span class="mono">localStorage</span> still persists it across reloads. (The desktop app has persistent storage, so this only affected browser use.) From a code review of the Lite-mode change.',
    '<strong>GUI stops hammering an offline server (CPU backoff):</strong> the CPU half of the idle-load fix. When the AI server is down or restarting, the GUI used to keep firing fixed-cadence fetches forever — the Logs pane polled <span class="mono">/logs/tail</span> every 3s (even with the tab hidden), and each WebSocket drop fanned <span class="mono">_close</span>+<span class="mono">_probing</span>+<span class="mono">_error</span> into ~80+ failing <span class="mono">/launchers/status</span>+<span class="mono">/gpu</span> fetches per minute. Now the logs poll self-reschedules with failure backoff (3s → cap 30s, reset on a good poll) and skips entirely when the tab is hidden; the launcher bus-drop pumps are debounced to one fetch/sec; and the <span class="mono">/events</span> WebSocket reconnect widens its cap from 5s to 20s after ~6 straight failures (keeping the fast sub-second ramp for the common quick-respawn). Recovery stays snappy; a durably-down server no longer spins the CPU. Pairs with the opt-in Lite mode (the GPU half).',
    '<strong>Lite mode — a one-click lever for the GUI&rsquo;s idle CPU/GPU load:</strong> chasing &ldquo;the app bogs my system down even with no models loaded&rdquo; traced the cost to the GUI compositor, not VRAM — the always-on animated, heavily-blurred background layers (<span class="mono">.abyss</span> / <span class="mono">.rays</span> / particles) plus ~68 stacked <span class="mono">backdrop-filter:blur</span> glass panels that re-blur every frame as those layers drift behind them. A new <strong>FX</strong> toggle in the topnav (and automatic when your OS &ldquo;reduce motion&rdquo; setting is on) flips a <strong>Lite mode</strong> that removes the animated layers and drops the blur — the panel gradients keep the look — cutting idle compositor work substantially. Opt-in: full effects stay the default; the choice persists (localStorage) and applies on every page. Also added a real <span class="mono">prefers-reduced-motion</span> path and retired reliance on the old &ldquo;Ambient drift&rdquo; tweak, which was edit-mode-only and only paused 5 layers.',
    '<strong>Confirmation dialogs show their message again (not raw HTML):</strong> the in-app confirm modal — <strong>Self-update</strong>, <strong>Kill-all</strong>, Emoji delete, the multi-window guard, etc. — wraps its body in a mono-styled, HTML-escaped <span class="mono">&lt;div&gt;</span>, but had stopped telling the renderer the body was HTML, so the modal escaped it a second time and displayed the literal <span class="mono">&lt;div style=&hellip;&gt;&hellip;&lt;/div&gt;</span> markup as text. Restored the <span class="mono">html</span> flag (guarded to a non-empty body, so empty-body confirms still drop the body element cleanly). The wrapped text stays escaped, so there is no injection risk. Reported on the Self-update dialog.',
    '<strong>Topnav pages scroll again (Bot Bridge, Operations, &hellip;):</strong> content pages with a long body were clipped below the fold with no way to scroll — the shared fixed-viewport <span class="mono">body.has-topnav</span> layout pins the content area to the window height, and the per-page scroll opt-in had only ever been added to Emoji Vault / Force React. The <strong>Bot Bridge</strong> page tipped over once it grew the vision-mode + web-search cards; <strong>Operations</strong>, <strong>Add model</strong>, and <strong>Chat</strong> had the same latent gap. Promoted <span class="mono">overflow-y:auto</span> onto the shared <span class="mono">.app-wrap</span> rule so every current and future topnav page scrolls when its content exceeds the viewport. The fixed-window pages (Control Center, etc.) are unaffected — their inner panel is sized 48px shorter than the viewport, so it still fits and no scrollbar appears.',
    '<strong>Code-review hardening (post-parity round):</strong> three fixes from review of the just-shipped toggles + changelog proxy. (1) <span class="mono">GET /changelog/commits</span> no longer echoes raw exception text into its JSON on a fetch failure (CodeQL &ldquo;information exposure through an exception&rdquo;) — the detail is logged server-side and the client gets a generic message; the cached/stale fallback is unchanged. (2) <span class="mono">POST /bot/vision-mode</span> + <span class="mono">/bot/web-search</span> now reject a valid-but-non-dict JSON body (a bare array/string/number) with a clean 400 instead of a 500 (an <span class="mono">isinstance</span> guard before <span class="mono">.get</span>). (3) The Bot Bridge cards (vision mode, web search, Discord bindings) now <span class="mono">await</span> the on-error re-sync before re-enabling their controls, so a failed save cannot leave a control briefly clickable against stale state.',
    '<strong>VRAM auto-eviction no longer leaks image auxiliaries:</strong> when the model router evicted a role to fit a new model under the VRAM budget, the image branch just nulled the main pipeline handle — leaving the <span class="mono">instruct-pix2pix</span> and <span class="mono">clipseg</span> editing auxiliaries resident (a real VRAM leak), never firing the <span class="mono">model.evicted</span> event (so the GPU pane still showed the model as loaded), and not clearing <span class="mono">loaded_task</span>. Auto-eviction now routes through the same per-role unload helpers the explicit <span class="mono">/unload</span> button uses (so it frees the auxiliaries + emits the event), tagged <span class="mono">reason:"task-lru"</span> so the GUI distinguishes an automatic budget eviction from an operator unload. Also fixes <span class="mono">unload_image_model</span> to clear <span class="mono">loaded_task</span> for the <span class="mono">instruct_pix2pix</span> task too (not just <span class="mono">image</span>), and to still emit <span class="mono">model.evicted</span> when only the pix2pix editing pipe was resident. (Surfaced by a code review of the per-role-unload change.)',
    '<strong>Default web search, now settable from the GUI (parity):</strong> whether chat AUTO-augments answers with web search (SearXNG) on the <span class="mono">@mention</span> chat path was a fixed heuristic with no operator control. The <strong>Bot Bridge</strong> page gained a <strong>Default web search</strong> toggle — <strong>Auto</strong> (search when a question looks like it needs current info — the historical behavior), <strong>Off</strong> (no automatic search; an explicit &ldquo;search the web for&hellip;&rdquo; still works), or <strong>Always</strong> (augment every chat). Persisted to <span class="mono">data/web-search-config.json</span> via the new token-gated <span class="mono">GET/POST /bot/web-search</span>; the bot reads it LIVE (mtime-aware) at the single <span class="mono">askChat</span> decision point, so it applies with no restart. A per-message &ldquo;don&rsquo;t search&rdquo; still wins, and the explicit research / comparison / <span class="mono">/ask web:always</span> paths are unaffected. Cold default via <span class="mono">SEEKDEEP_WEB_SEARCH_DEFAULT</span>; ships as <em>auto</em> so existing behavior is unchanged until you flip it. (Requires <span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE=on</span>.)',
    '<strong>Default vision mode, now settable from the GUI (parity):</strong> the bot reads cues in your text to decide whether an <span class="mono">@mention</span>-an-image request is a <em>describe</em> (caption / analyze) or an <em>OCR</em> (text-extraction) job — but an image with <em>no</em> clear instruction (a bare mention, an empty reply, &ldquo;what is this&rdquo;) always fell back to describe with no way to change it. The <strong>Bot Bridge</strong> page gained a <strong>Default vision mode</strong> toggle (Describe / OCR) that persists the operator default to <span class="mono">data/vision-mode-config.json</span> via the new token-gated <span class="mono">GET/POST /bot/vision-mode</span>; the bot reads it LIVE (mtime-aware, like the force-react config) so it applies with no restart. A per-message cue (&ldquo;read this&rdquo; / &ldquo;describe this&rdquo;) still always wins — the default only resolves the ambiguous case. Cold default via <span class="mono">SEEKDEEP_VISION_DEFAULT_MODE</span>; ships as <em>describe</em> so existing behavior is unchanged until you flip it. (Requires <span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE=on</span>.)',
    '<strong>Say — post to a channel from the GUI (parity):</strong> the <strong>Bot Bridge</strong> page gained a <strong>Say</strong> card — load your servers, pick a server + channel, type, Send, and the bot posts it. New <span class="mono">say</span> bridge action resolves the guild + channel from the bot\'s LIVE cache (not trusted as raw input) and <strong>hard-locks <span class="mono">allowedMentions</span> to none</strong>, so a GUI-typed message can never ping <span class="mono">@everyone</span> / <span class="mono">@here</span> / a role no matter what it contains; content is capped at Discord\'s 2000 chars. (Requires <span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE=on</span>.)',
    '<strong>Live changelog — this page now shows recent commits too:</strong> above the curated release notes, a <strong>Recent commits</strong> section pulls the actual latest commits on <span class="mono">main</span> straight from GitHub. The GUI can\'t reach <span class="mono">api.github.com</span> directly (the desktop CSP <span class="mono">connect-src</span> is loopback-only), so the server proxies it: new <span class="mono">GET /changelog/commits</span> fetches a fixed repo URL (no request input → no SSRF), trims each commit to sha/subject/author/date/link, and TTL-caches the result (<span class="mono">SEEKDEEP_CHANGELOG_COMMITS_TTL_S</span>, default 5 min) to stay under GitHub\'s rate limit — serving stale cache if a refresh fails. Commit text is rendered injection-safe (textContent, never innerHTML), and the sha links open on GitHub via the external-link handler.',
    '<strong>Image queue, now visible + clearable from the GUI (parity):</strong> the bot\'s image-generation queue — where a burst of <span class="mono">/image</span> requests backs up — was only inspectable in Discord. The <strong>Bot Bridge</strong> page gained an <strong>Image queue</strong> card: <strong>Refresh</strong> shows the active job, the pending count + list, and completed/failed tallies; <strong>Clear pending</strong> drops the waiting jobs (their Discord requesters get a cancelled notice via a rejected promise — no hang) while the job that\'s actively generating keeps running. Backed by two new bridge actions <span class="mono">queue.status</span> / <span class="mono">queue.clear</span> against the bot\'s live <span class="mono">seekdeepImageQueueState</span>. (Requires <span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE=on</span>.)',
    '<strong>Self-update was silently dead — fixed (and made self-healing):</strong> the self-updater\'s signature gate does <span class="mono">import release_signing</span>, but <span class="mono">release_signing.py</span> was in <em>none</em> of the shipped-file lists (not bundled, not extracted, not self-updated), so it never reached the installed app — every self-update 500\'d with <span class="mono">ModuleNotFoundError: No module named \'release_signing\'</span> <em>before</em> committing a single file (atomic staging meant it failed clean, but it could never recover — the update that would deliver the module couldn\'t run without it). Two-part fix: (1) <span class="mono">release_signing.py</span> is now a first-class shipped core file across every consumer (bundle resources, sidecar extraction, the self-update manifest, and the signing manifest — enforced by the release-files drift guard); (2) the updater now imports the signer <em>defensively</em> — an absent signer skips the signature gate (unless <span class="mono">REQUIRE_SIGNATURE=on</span>, which still fails closed) instead of crashing, so the update proceeds and commits the very module that was missing, self-healing for next time. (Found while pushing the bridge fix to the running app, which had been stuck unable to pull any update.)',
    '<strong>Bot Bridge command relay fixed (every command was 500ing):</strong> the GUI→bot command bridge (<span class="mono">POST /bot/command</span>) crashed with <span class="mono">TypeError: _seekdeep_audit() got multiple values for argument \'action\'</span> on <em>every</em> action — ping, status, guilds, and the new bindings. The audit helper\'s first positional is its own <span class="mono">action</span> (the audit event name), and the relay also passed <span class="mono">action=</span> for the bot action, colliding. Latent the whole time because the bridge ships gated off (<span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE</span>) and had never been exercised; it surfaced the instant the bridge was enabled. Now logs the bot action under a distinct <span class="mono">cmd</span> field, so the entire bridge surface works.',
    '<strong>Per-role model unload (free one role\'s VRAM, keep the rest):</strong> the GPU/VRAM pane previously offered only <span class="mono">/unload all</span> — an all-or-nothing flush. Added <strong>unload chat</strong>, <strong>unload vision</strong>, and <strong>unload image</strong> buttons that evict just that role (the image button also drops the pix2pix / clipseg editing auxiliaries), so you can reclaim VRAM for, say, an image burst without losing your warm chat model. Backed by <span class="mono">POST /unload?kind=chat|vision|image|all</span> (new <span class="mono">unload_vision_model</span> / <span class="mono">unload_image_model</span> helpers), each firing the same <span class="mono">model.evicted</span> event so the live model state updates. Parity with the existing per-role keep-resident pins. (<span class="mono">/unload all</span> unchanged.)',
    '<strong>Bot status hardened against restart windows:</strong> <span class="mono">@SeekDeep gpu</span> (and the status / GPU-watch readouts) sometimes reported a flat "Local AI server: OFFLINE" when the server was merely mid-restart — uvicorn rebinding <span class="mono">:7865</span> after a self-update or crash-watchdog respawn, a ~20s window. The GPU stat fetch now makes a second quick attempt before giving up, so a transient blip no longer surfaces as a hard outage; and when it genuinely can\'t reach the server the message now says it may be starting up / restarting and to retry shortly, instead of declaring it dead. (Pairs with the model-scan cache fix that cut the respawn churn in the first place.)',
    '<strong>Discord bindings, now in the GUI (parity):</strong> the <strong>Bot Bridge</strong> page can finally see + change the per-server automatic-behavior channels that were previously settable only in Discord — the <strong>daily-digest</strong> channel and the <strong>auto-translate</strong> channel. Hit "Load bindings" to list your servers; pick a channel (or "off") per binding and it writes through the bot command bridge to the same <span class="mono">persona-overrides</span> store the Discord command uses, applied live (no restart). Closes the top GUI⇄Discord gap from the coverage audit — the bot bound these invisibly; now they\'re visible and editable. (Requires <span class="mono">SEEKDEEP_FEATURE_BOT_BRIDGE=on</span> + the bot connected.)',
    '<strong>Config save/read reliability — model-scan no longer starves the loop:</strong> on the Bot config page, settings sometimes read "UNKNOWN" and saves felt laggy/unreliable. Root cause: <span class="mono">GET /models/available</span> walks the whole Hugging Face model cache (multi-second on a large cache) with no caching, so the page\'s several concurrent fetches each re-triggered the walk — which starved the server\'s event loop long enough that the parallel <span class="mono">/config</span> reads hit their abort timeout and rendered UNKNOWN. The scan is now cached (short TTL, <span class="mono">SEEKDEEP_MODELS_AVAIL_TTL_S</span>, default 20s) with the live model selection overlaid on each hit, so repeated/concurrent loads don\'t re-walk the cache and config values + saves stay responsive.',
    '<strong>Code-review hardening (Gemini, round 4):</strong> the verb-group nav dropdowns now close each other when you open another (dropped an over-eager <span class="mono">stopPropagation</span>), and feature-gated items load under the macOS/Linux Tauri <span class="mono">tauri:</span> protocol (the gate only matched <span class="mono">http(s):</span> before — Windows was fine). The page registry is now frozen read-only, and the suppressed-alert toast fallback no longer prints "undefined" when an action has no detail body.',
    '<strong>GUI · Operations page + recovery fixed in the app (reorg phase 3):</strong> the stack-control actions (restart bot / AI server / SearXNG / whole stack · flush model cache · reload .env · smoke · doctor · self-update · kill-all) were reachable ONLY from a hidden right-click menu — and that menu was silently <em>broken in the desktop app</em>, because its fetches were relative and never reached the loopback server. Added a visible <strong>Operations</strong> page (MANAGE group) rendering those actions as labelled buttons, and fixed the shared action runner to prefix the loopback base — so recovery works in the app for the first time, from both the new page AND the right-click menu (one shared <span class="mono">SeekDeepOps</span> registry, no drift). Destructive actions still confirm.',
    '<strong>GUI nav · verb-grouped topnav (reorg phase 2):</strong> the top navigation is now rendered from the page registry as four verb groups — <strong>RUN</strong> (Chat · Control Center · Hub · Setup) as direct links, and <strong>CREATE</strong> / <strong>MANAGE</strong> / <strong>LEARN</strong> as dropdowns — so the real day-to-day tools (Image A/B, Prompts, Personas, TTS, Memory, Settings…) finally live on the bar instead of being exiled to a single "More" menu or only findable via ⌘K. Feature-gated pages (Emoji Vault / Force React / Bot Bridge) slot into MANAGE when their flag is on. The static per-page link list remains as a no-JS fallback. (Audit IA finding; control-center e2e updated to match.)',
    '<strong>GUI · Hub cleanup (reorg phase 4, final):</strong> the Hub directory no longer lists the dead marketing/mock pages (landing · pitch · tour · mobile · boot — no live backend; the files stay in-repo, marked <span class="mono">live:false</span> in the registry), so browsing it can\'t land you on a dead-end. The "Surfaces" count is now derived from the page registry (self-maintaining) instead of a hardcoded number that disagreed with itself across the Hub, palette, and server — and the ⌘K palette header derives that same registry count on every page, so it no longer drifts page-to-page. Plus two Operations-page polish fixes: the action buttons inherit the app font, and disable while their op runs so a double-click can\'t fire a heavy restart/kill twice. (Completes the 4-phase nav/IA reorg from the full audit.)',
    '<strong>GUI nav · single page registry (reorg phase 1):</strong> introduced <span class="mono">gui/pages.js</span> — one source of truth for every GUI surface (group · live · feature-gate · glyph) — and wired the ⌘K jump palette, the "More" menu, and the feature-gated items to read from it instead of three hand-maintained lists that had drifted apart. No visible change yet (same surfaces reachable); this is the foundation for the verb-grouped topnav, a dedicated Operations page, and a self-deriving Hub directory in the next phases. (From the full audit\'s IA finding.)',
    '<strong>Code-review hardening (Gemini, round 3):</strong> thread-scoped the atomic <span class="mono">.env</span> / data-file temp names (FastAPI runs sync handlers in a threadpool, so pid-scoping alone could collide between threads), decode the capped provider response straight from the bytearray (skips a redundant copy of up to 16 MB), and the suppressed-alert toast fallbacks now carry the error body. (Verified false positive, rejected: Gemini claimed the pinned Python floors don\'t exist on PyPI — a live PyPI check confirms every one does; its "latest version" numbers were a stale cutoff, and lowering the floors as suggested would have re-admitted CVE-bearing Pillow.)',
    '<strong>Supply-chain hardening (audit Track C):</strong> every first-party GitHub Action (checkout, setup-node/python, cache, upload-artifact, CodeQL) is now pinned to a full commit SHA — matching the third-party actions, so a hijacked action tag can\'t inject into CI (Dependabot keeps the pins current). Release builds now publish a signed <strong>SLSA build-provenance attestation</strong> for every installer (verify with <span class="mono">gh attestation verify &lt;file&gt; --repo NathanNeurotic/SeekDeep-DiscordBot</span>) — a real integrity anchor for the unsigned installers. And the boot Python deps gained upper version caps so a breaking major (a pydantic 3, a FastAPI major) can\'t silently land on a fresh first-run install.',
    '<strong>Server/bot hardening (audit Track B):</strong> the Control Center launcher Start/Stop/Restart/Kill-all actions now run their blocking subprocess work off the event loop, so the GUI no longer flickers OFFLINE while a service transitions; remote chat-provider responses are read with a 16 MB cap (<span class="mono">SEEKDEEP_PROVIDER_MAX_RESP_BYTES</span>) so a hostile or buggy endpoint cannot OOM the server; <span class="mono">/save-file</span> now allowlists export types (images / JSON / text / zip — no executables); the fresh-bundle boot path confirms a port owner is actually SeekDeep before reclaiming <span class="mono">:7865</span>; plus a timeout-bounded background GPU-log fetch, a pid-scoped <span class="mono">.env</span> temp write, and an off-loop <span class="mono">/data</span> read.',
    '<strong>Full-audit quick wins:</strong> a ruthless 11-dimension audit (every finding re-verified against source) surfaced two pages that were silently dead in the desktop app — <strong>Force React</strong> and the Model pane\'s <strong>keep-resident toggles</strong> both used fetches that never reached the loopback server under Tauri; both now use the shared base resolver. Also: file drag-drop into the image/vision zones now works in the app (<span class="mono">dragDropEnabled:false</span> stops the webview from swallowing OS drops — lands next build); built-in-react / model-warm / catalog buttons report failures via the in-app toast instead of a suppressed <span class="mono">alert()</span>; the Kill-all toast uses real tone names so its color coding shows; the Hub stops mislabeling the live <strong>TTS Voice</strong> page as a "Mock"; and the non-Windows PyTorch floor moved to <span class="mono">&gt;=2.6</span> to exclude the CVE-2025-32434 torch.load range.',
    '<strong>Code-review hardening (Gemini):</strong> verified the AI code-review findings and fixed the real ones — the Emoji Vault delete confirm now branches so the <span class="mono">window.confirm</span> fallback gets a plain string (not "[object Object]"), the external-link handler no longer calls <span class="mono">stopPropagation</span> (other click handlers still fire) and its failure toast uses the correct object form, the emoji-backup result skips repainting if you switched servers mid-save, and the server-side backup write is offloaded off the event loop. A second review round added two more: <span class="mono">/save-file</span> now caps the raw base64 payload <em>before</em> decoding (so an oversize request cannot exhaust memory ahead of the decoded-size check), and both file-save paths uniquify the timestamped filename so two saves in the same second no longer silently overwrite. (False positives, verified and rejected: the FFmpeg note — prism-media already falls back to a PATH ffmpeg; the <span class="mono">warn</span> toast tone — it is valid and styled; deprecated <span class="mono">unescape</span> — universally supported and output-identical.)',
    '<strong>Download/Save/Export buttons actually produce files now:</strong> Image Studio "Download", Image A/B "SAVE", and the Memory + Prompt-template "Export" buttons all used the same blob/anchor trick the Tauri WebView2 silently drops — clicking them did nothing. They now go through a token-gated <span class="mono">/save-file</span> endpoint (shared <span class="mono">SeekDeepSaveFile</span> helper) that writes to your Downloads and reports the path, exactly like the emoji backup. (Batch 2 of the webview-interaction audit.)',
    '<strong>Dialogs that silently failed in the app now work:</strong> the Tauri WebView2 suppresses <span class="mono">window.confirm/prompt</span> (returns false/null with no dialog), which dead-ended three actions — <strong>Emoji Vault delete</strong>, <strong>auto-react rule edit</strong>, and the <strong>multi-window guard</strong> (Save config / Reload .env / Force-kill / HF-cache-lock when 2+ windows are open). All three now use the in-app modal (<span class="mono">SeekDeepConfirm</span>) that already backs other destructive actions, so they prompt + proceed correctly. Surfaced by the webview-interaction audit.',
    '<strong>External links open in the browser:</strong> in the desktop app, clicking an external link (GitHub, Hugging Face, installer help, etc.) did nothing — the locked Tauri webview will not navigate out. nav.js now routes external links + <span class="mono">discord:</span> deep-links through the shipped <span class="mono">open_external</span> command (opens the OS browser, host-allowlisted). Also added the installer/partner hosts (git-scm, nodejs, virustotal, demonbot) to the allowlist. JS handler ships via self-update; the new allowlist hosts land in the next build.',
    '<strong>Emoji Vault backup actually saves now:</strong> the zip download did nothing in the desktop app — the Tauri WebView2 silently drops blob/anchor downloads (no download handler, and a Rust fix cannot ship via self-update). Backup now uses <span class="mono">?save=1</span> so the server writes the zip to your Downloads folder and returns the path, and the page shows <span class="mono">Backed up N emoji → &lt;path&gt;</span>. Works the same in the app and the loopback browser since both run on the server machine.',
    '<strong>Emoji Vault + Force React scrolling:</strong> both pages use a normal content layout, but the shared <span class="mono">body.has-topnav</span> rule pins the wrapper to viewport height and locks body overflow (for the fixed-window pages), so a long emoji grid/pool got clipped with no way to scroll. Added <span class="mono">overflow-y:auto</span> to each page wrapper so the content scrolls.',
    '<strong>Bundled FFmpeg for Discord voice:</strong> added <span class="mono">ffmpeg-static</span> as a dependency so <span class="mono">@SeekDeep tts say</span> transcodes to Opus with zero system install — prism-media auto-detects the bundled binary. Previously Discord TTS dead-ended for fresh users needing a manual FFmpeg install (the in-browser Speak test was unaffected). Surfaced by an end-to-end audit of the whole TTS path.',
    '<strong>Tauri base-URL fix (the big one):</strong> the TTS Voice, Emoji Vault, and Bot Bridge pages — plus the nav feature-gating + kill-all actions — used <em>relative</em> fetches, which in the desktop app resolve to <span class="mono">tauri.localhost</span> and never reach the loopback server. So TTS looked permanently "server not responding" even with a healthy backend. All now route through the shared Tauri-aware base resolver (<span class="mono">http://127.0.0.1:7865</span>) like every other page. This was the real reason in-app TTS setup went in circles.',
    '<strong>Self-service TTS setup:</strong> the <strong>TTS Voice</strong> page (Control Center → More) now installs the Piper speech engine on demand (one click, ~30 MB — no terminal), lists curated Piper voices and downloads them, switches the engine to the chosen voice live (no restart), persists <span class="mono">SEEKDEEP_TTS_PIPER_VOICE</span> + <span class="mono">SEEKDEEP_FEATURE_TTS_VOICE=on</span> to <span class="mono">.env</span>, then you Speak to test it in the browser. <span class="mono">piper-tts</span> is now a declared ML dependency. The page no longer lies about its state — engine status starts "checking" until the server answers, and an empty/unreachable catalog (server still booting) retries then shows a Retry button instead of a dead "no voices" screen. Replaces the old mock UI.',
    '<strong>GUI⇄Discord parity:</strong> a read-only <strong>Emoji Vault</strong> page and a <strong>Force React</strong> config page (per-guild cumulative react cap + emoji pool), both feature-gated, both reachable from Control Center → More.',
    '<strong>Force React per-guild cap:</strong> configurable 1–20 cumulative cap per user-per-message (default 3) + emoji allow-list · mtime-aware so GUI edits apply without a bot restart.',
    '<strong>CSP Phase A:</strong> <span class="mono">connect-src</span> + security headers on the Tauri WebView and the loopback browser path · the Discord Activity is exempted. (Dropping <span class="mono">unsafe-inline</span> from script-src is the remaining defense-in-depth step.)',
    '<strong>DataDash Discord Activity:</strong> replaced the embedded mockup with the real DataDash game, wired into the nav and hardened (unconditional Pepe spawns, audio loader, typeable high-score field, CSP-safe corrections).',
    '<strong>Routing fixes:</strong> image-only @mention now runs vision instead of "no command text" · bare "draw it" no longer reuses a long chat reply as the subject · code/markup requests stay in chat instead of misrouting to image gen · heavy code/quality replies defer behind the image queue instead of dropping to the 8B.',
    '<strong>Audit round-2 remediation:</strong> bounded in-memory stores, plugged a video temp-file leak, SHA-pinned third-party GitHub Actions, CI least-privilege, env-coverage + release-files preflight drift guards, Tauri System32 path pinning + .env loading.',
  ]},
  { v: 'v10.37', kind: 'patch', tagline: 'cross-process lock + CodeQL fixes + dependency bumps', tags: ['fix','perf'], items: [
    'Cross-process advisory file-lock primitive, wired through every shared-file writer · eliminates cross-process write races on <span class="mono">data/*.json</span>.',
    'Patched 6 real CodeQL findings (DOM-XSS sink, origin-check, regex anchor).',
    'Batched Dependabot dependency + GitHub-Action version bumps.',
  ]},
  { v: 'v10.36', kind: 'major', tagline: 'security & supply-chain hardening (post deep-audit)', tags: ['fix','perf','feat'], items: [
    'Whole-codebase critical deep audit, then remediation across the stack.',
    'Added CodeQL security-extended, dependency + secret scanning, and Dependabot to CI.',
    'Bounded the image queue and capped on-disk outputs · DoS input caps (tokenizer, <span class="mono">/chart</span>, emoji-vault zip).',
    'nav.js attaches the GUI token only on an exact-origin match · default <span class="mono">trust_remote_code</span> off + validate <span class="mono">/model/install</span> repo ids · closed an auto-react regex ReDoS.',
    'Quarantine corrupt <span class="mono">data/*.json</span> + fsync atomic writes · surfaced the keep-resident toggle on the Models pane.',
  ]},
  { v: 'v10.35.1-6', kind: 'fresh', tagline: 'post-audit stabilization wave · stale-server guard · cache death · launcher/installer honesty', tags: ['fix','perf','feat'], items: [
    '<strong>Stale-server guard (10.35.3):</strong> Tauri sidecar boot now does a <span class="mono">GET /health</span> identity check on :7865 instead of a raw TCP probe. Mismatched version → auto-kill the stale PID and respawn fresh. Was the root cause of "I installed v10.35.x but the title bar shows v10.35.0" — port-bound stale server was being reused forever.',
    '<strong>GUI cache death (10.35.2):</strong> server stamps <span class="mono">Cache-Control: no-store</span> on every .html/.js/.css/.json under /gui. Service worker rewritten as a self-destruct (unregisters + wipes caches on next visit). Updates now land on page reload, no "clear site data" ever needed.',
    '<strong>Reconnect tightening (10.35.4):</strong> events.js WS backoff capped 30s → 5s. nav.js token interceptor stops permanently caching empty strings after a transient /token failure. launcher.js retries network errors once before showing the toast. New <span class="mono">_probing</span> event keeps the LIVE pill from sticking to OFFLINE during sidecar respawns.',
    '<strong>Installer page honesty (10.35.5):</strong> probeAiHealth timeout 1.2s → 6s (matches the ollama-probe stall). Tauri-skip banner moved out of step 1 so it persists across all 9 steps. Auto-runs System Check on load so red "install Node" dots flip green automatically for Tauri users.',
    '<strong>Docker Try-start (10.35.6):</strong> new <span class="mono">try_start_docker_desktop</span> Tauri command probes <span class="mono">docker info</span>/<span class="mono">--version</span> and spawns Docker Desktop if installed but not running, instead of dead-ending at "Install Docker" for users who clearly already have it.',
    '<strong>GPU probe fix (10.35.6):</strong> Installer was checking <span class="mono">gpu.detected</span> (doesn\'t exist) so CPU-only installs falsely showed green "detected (no detail)". Now honors <span class="mono">gpu.available === false</span> with "no GPU · CPU mode" yellow.',
    '<strong>Last "MOCK" label sweep:</strong> killed remaining "MOCK · STANDALONE" / "MOCK (server offline)" / "LOCAL-MOCK" / "from MOCK to LIVE" copy across app.html, api.html, docs.html, tour.html — every state is now LIVE / PROBING / OFFLINE.',
    '<strong>Codex audit fixes:</strong> Discord bot-wide allowedMentions:{parse:[]} (no more model output pinging @everyone); GUI XSS hardened across 6 renderers; sensitive read endpoints token-gated; b64 size caps + consistent 400/413; image filename collisions via time_ns; persona create/remove/list admin commands.',
    '<strong>Image upload UX:</strong> drop an image + type your question → message becomes the prompt FOR the image automatically. No /vision command needed.',
  ]},
  { v: 'v10.35', kind: 'fresh', tagline: 'archive integrity, prompt refinement reliability, image-reply intent', tags: ['feat','fix','perf'], items: [
    'Archive writes include stable <span class="mono">Archive Key</span> · dedupe across retries, restarts, and reaction shortcuts.',
    'Prompt refinement pinned to <span class="mono">default_chat</span> · reports AI-refine fallback reasons, clamps SDXL prompts.',
    'New <span class="mono">RE-REFINE</span> button on generated images for fresh refinement.',
    'Upscale clears loading attachments on success/failure · Lanczos + configurable mild sharpening.',
    'Image replies classified as edit / inspired / vision / upscale / regenerate / RE-REFINE.',
    'Web source URLs wrapped in <span class="mono">&lt; &gt;</span> to suppress Discord preview spam.',
  ]},
  { v: 'v10.34', kind: 'major', tagline: '13 fixes from a full live-testing audit', tags: ['fix','perf','feat'], items: [
    'Archive buttons no longer scan 1000+ messages on every click (was 77-637s, now instant via trusted JSON profile counts).',
    'Archive delete no longer hits <span class="mono">50027 Invalid Webhook Token</span>.',
    'Persona modal crash fixed (label was 52 chars, Discord max 45).',
    'All 11 <span class="mono">ephemeral: true</span> migrated to <span class="mono">flags: MessageFlags.Ephemeral</span>.',
    'Inpaint prompt extraction captures removal target instead of generic fill text.',
    'Pix2Pix adaptive <span class="mono">image_guidance_scale</span> (1.2 heavy / 2.0 light / 1.5 default).',
    'img2img gets its own <span class="mono">IMAGE_IMG2IMG_GUIDANCE_SCALE</span> (default 5.0).',
    'img2img modal auto-routes instruction-like prompts to pix2pix/inpaint.',
    '<span class="mono">lightweight_chat</span> routes translations, greetings, and trivial queries to gemma-3n.',
    'Thread rename debounce (30s cooldown).',
    '14 new smoke tests (274 total).',
  ]},
  { v: 'v10.33', kind: 'patch', tagline: 'loading gif + bug fixes', tags: ['fix','feat'], items: [
    'Loading gif added to 8 context menu handlers + 3 slash commands for visible wait feedback.',
    'Ephemeral modal ack fixed · context menu modal submits no longer produce two messages.',
    'Pix2Pix output fixed · non-square input no longer stretches to wrong aspect ratio.',
    'Context menu embed image fallback · images in embeds now found by vision/upscale/img2img.',
    '7 new smoke tests (256 total).',
  ]},
  { v: 'v10.32', kind: 'patch', tagline: 'context menu modals + adaptive img2img + pix2pix tuning', tags: ['feat','fix'], items: [
    'Context menu Edit Image / Remove Object now open Discord modals for prompt/target input.',
    'Adaptive img2img strength · style keywords 0.65 · scene transforms 0.70 · color/lighting 0.45 · default 0.55.',
    'Pix2Pix adaptive image_guidance_scale initial pass.',
  ]},
  { v: 'v10.31', kind: 'major', tagline: 'InstructPix2Pix + Inpainting + routing overhaul', tags: ['feat'], items: [
    '<span class="mono">/pix2pix</span> edits images with natural-language instructions via <span class="mono">timbrooks/instruct-pix2pix</span>.',
    '<span class="mono">/inpaint</span> removes objects via CLIPSeg auto-mask + SDXL inpainting.',
    'Conversational image edit detection auto-routes "make it darker" to pix2pix and "remove the wizard" to inpaint.',
    'Both gated behind <span class="mono">SEEKDEEP_FEATURE_*</span> flags.',
    '15 new smoke tests (226 total).',
  ]},
  { v: 'v10.30', kind: 'patch', tagline: 'image quality tuning', tags: ['perf'], items: [
    'Scheduler, negative prompt, and guidance scale defaults tuned for Dreamshaper-XL to reduce artifacts.',
  ]},
  { v: 'v10.29', kind: 'patch', tagline: 'auto-translate channel', tags: ['feat'], items: [
    '<span class="mono">@SeekDeep translate channel here</span> designates one channel per server.',
    'Fast regex detector for non-Latin Unicode (Cyrillic, CJK, Arabic, Devanagari, Thai, Korean).',
    '3-second per-channel cooldown · fire-and-forget · no mention required.',
  ]},
  { v: 'v10.28', kind: 'patch', tagline: 'refinement retry + analytics chart + token budget bump', tags: ['fix','feat'], items: [
    'Refiner retries once at +0.15 temperature when the validator rejects the first output.',
    'Max refinement tokens bumped 360 → 512.',
    '<span class="mono">@SeekDeep stats chart</span> renders 30-day data as a matplotlib chart via new <span class="mono">/chart</span> endpoint.',
  ]},
  { v: 'v10.27', kind: 'patch', tagline: 'COMMANDS.md permission column + new command docs', tags: ['docs'], items: [
    'Complete rewrite of <span class="mono">COMMANDS.md</span> with a Permission column on every command.',
    'Documents commands from v10.16-v10.26: search, templates, img2img, upscale, /persona modal, GPU/VRAM, context menu.',
  ]},
  { v: 'v10.26', kind: 'patch', tagline: 'persona editor modal', tags: ['feat'], items: [
    '<span class="mono">/persona</span> opens a Discord modal with three fields · admin-only via ManageGuild.',
  ]},
  { v: 'v10.25', kind: 'major', tagline: 'img2img + upscale', tags: ['feat'], items: [
    'img2img reuses Dreamshaper-XL · zero additional download via <span class="mono">AutoPipelineForImage2Image.from_pipe()</span>.',
    'Source image resolved via 3-step waterfall: attachment → reply → most recent bot image.',
    'Upscale uses Lanczos resampling (PIL, no model needed). Real-ESRGAN scaffolded.',
  ]},
  { v: 'v10.24', kind: 'patch', tagline: 'saved prompt templates', tags: ['feat'], items: [
    'Per-user prompt templates persisted to <span class="mono">data/prompt-templates.json</span>.',
    'Max 25 templates per user · names auto-sanitized.',
  ]},
  { v: 'v10.23', kind: 'patch', tagline: 'conversation search', tags: ['feat'], items: [
    '<span class="mono">@SeekDeep search &lt;query&gt;</span> pages through recent channel messages and matches user→bot exchange pairs.',
  ]},
  { v: 'v10.22', kind: 'patch', tagline: 'archive numbering reliability', tags: ['fix'], items: [
    'Three bugs fixed in concert · trusted profile counts instead of rescanning · single authoritative scan · rescan after deletion.',
    '20 new smoke tests for archive counting.',
  ]},
  { v: 'v10.21', kind: 'patch', tagline: 'repo cleanup', tags: ['docs'], items: [
    'Tracked files: 473 → 27.',
    'Removed pre-git patch scripts, backup snapshots, temp artifacts, secrets file.',
    'Updated <span class="mono">.gitignore</span> to prevent recurrence.',
  ]},
  { v: 'v10.20', kind: 'patch', tagline: 'context-aware Discord status', tags: ['feat'], items: [
    'Discord presence shows actual task ("Thinking…", "Generating your image…", "Analyzing image…").',
    'Reference-counted override · concurrent tasks don\'t clobber each other.',
  ]},
  { v: 'v10.19', kind: 'patch', tagline: 'archive clean', tags: ['feat'], items: [
    'Prune old entries with two-step preview + confirm flow.',
    'Supports duration units h, d, w, m. 2-minute TTL on pending confirmation.',
  ]},
  { v: 'v10.18', kind: 'patch', tagline: 'OCR mode for vision', tags: ['feat'], items: [
    '<span class="mono">/vision mode:ocr</span> extracts text exactly as it appears.',
    'Natural triggers: "extract text", "read this", "what does it say", "transcribe this".',
    'Max output tokens raised to 1500 in OCR mode.',
  ]},
  { v: 'v10.17', kind: 'patch', tagline: 'help search', tags: ['feat'], items: [
    '<span class="mono">@SeekDeep help search &lt;query&gt;</span> fuzzy-matches across all help sections.',
  ]},
  { v: 'v10.16', kind: 'patch', tagline: 'rotating Discord status', tags: ['feat'], items: [
    '52 fun statuses across Playing / Watching / Listening / Competing / Custom.',
    'Fisher-Yates shuffle ensures no repeats within a cycle · rotates every 10 minutes.',
  ]},
  { v: 'v10.15', kind: 'patch', tagline: '.env.default quantization fix', tags: ['fix','perf'], items: [
    '<span class="mono">LOCAL_CHAT_QUANT_FULL_ROLES</span> shipped empty by default.',
    'default_chat now 4-bit-quantized (~5 GB VRAM) instead of fp16 (~16 GB) · ~10 GB headroom on a 24 GB GPU.',
    'Prevents the chat+SDXL transient peak from spilling into shared system memory.',
  ]},
  { v: 'v10.14', kind: 'patch', tagline: 'subject-preservation threshold loosened', tags: ['fix'], items: [
    'New threshold caps required matches at 3 for medium/long prompts so subject-relevant keywords aren\'t drowned out by non-visual filler.',
    '8 new smoke checks.',
  ]},
  { v: 'v10.13', kind: 'patch', tagline: 'dynamic image refine: preamble stripping + rejection logging', tags: ['fix'], items: [
    '<span class="mono">seekdeepCleanDynamicImagePrompt</span> strips benign chat-model openers before the refusal check.',
    'Every rejection now logs its reason · silent fallbacks to static rules are diagnosable.',
  ]},
  { v: 'v10.12', kind: 'major', tagline: 'live GPU / VRAM monitoring', tags: ['feat'], items: [
    'New <span class="mono">/gpu</span> endpoint and <span class="mono">gpu</span> sub-object on <span class="mono">/health</span>.',
    '<span class="mono">@SeekDeep gpu watch [N]</span> live-tail mode · edits one message every N seconds · React ✋ to stop.',
    'Status command shows GPU summary + thrashing warning when reserved pool ≥ 90% of total.',
    '17 new smoke checks.',
  ]},
  { v: 'v10.11', kind: 'patch', tagline: 'documentation pass', tags: ['docs'], items: [
    'Created <span class="mono">PLANNED.md</span> for deferred work.',
    'Pruned 4 legacy text files (42.5k lines of stale inventory).',
    'Updated AGENTS, COMMANDS, CONTRIBUTING, REQUIREMENTS, SECURITY, SMOKE_TEST.',
  ]},
  { v: 'v10.10', kind: 'patch', tagline: 'visual-attachment helper dedup', tags: ['perf'], items: [
    'Final audit cleanup · stricter helpers · simplified <span class="mono">seekdeepGetReplyVisualAttachment</span> from 10 lines to 2.',
  ]},
  { v: 'v10.9', kind: 'major', tagline: 'messageCreate handler split (632 → 112 lines)', tags: ['perf'], items: [
    'Anonymous handler extracted into <span class="mono">seekdeepDispatchAddressedMessage</span> and <span class="mono">seekdeepProcessPreAddressMessageRoutes</span>.',
    'Route order and error handling preserved bit-identically.',
  ]},
  { v: 'v10.8', kind: 'patch', tagline: 'SendImageWithButtons consolidation', tags: ['perf'], items: [
    '4th and final Message/Interaction send-pair merged. <span class="mono">seekdeepSendImageWithButtons</span> replaces 219-line Message variant + 126-line Interaction variant.',
    '20 call sites rewritten · two latent bugs fixed.',
  ]},
  { v: 'v10.5', kind: 'patch', tagline: 'hygiene pass + Discord-mock test harness', tags: ['perf','feat'], items: [
    '25 dead top-level functions deleted (~700 LOC).',
    '<span class="mono">SEEKDEEP_TEST_MODE=1</span> gate exposes whitelisted helpers on <span class="mono">globalThis.__seekdeepTest</span> so smoke tests use real functions.',
    '<span class="mono">npm run preflight</span> runs <span class="mono">node --check</span> + <span class="mono">py_compile</span> + smoke test in ~1 second.',
  ]},
  { v: 'v10.4', kind: 'patch', tagline: 'help topics, vision pin, chunker hardening', tags: ['feat','fix'], items: [
    '<span class="mono">@SeekDeep help &lt;topic&gt;</span> slices help to one section · 12 topics.',
    'Vision keep-resident · <span class="mono">LOCAL_VISION_KEEP_RESIDENT=on</span> pins vision model in VRAM.',
    'Fence-aware Discord chunker · closes open <span class="mono">```</span> on a cut chunk and reopens on the next.',
  ]},
  { v: 'v10.3', kind: 'major', tagline: 'demonbot-inspired features', tags: ['feat'], items: [
    'Auto Reactions · per-guild rules in <span class="mono">data/auto-reactions.json</span> · substring or regex.',
    'Force React · paginated emoji picker (feature-flagged off by default).',
    '<span class="mono">/say</span> admin anonymous posting · strips mass mentions.',
    'Emoji Vault · thread-based backup with ZIP (feature-flagged off by default).',
  ]},
  { v: 'v10.2', kind: 'major', tagline: 'tier-1 UX wins + strengthening + polish', tags: ['feat'], items: [
    'Persona overrides, memory presets, server stats, daily digest.',
    'Did-you-mean fuzzy suggestions, frustration filter with word-count guards.',
    'Refined-prompt cache · vision follow-up auto-route · KK-Slider-style proper-noun lookups.',
    'Image quality/style presets on <span class="mono">/image</span>.',
  ]},
  { v: 'v10.1', kind: 'major', tagline: 'role-aware routing + 4-bit quant', tags: ['feat'], items: [
    '23-item polish pass · cooldown progress bar, prompt-choice TTL extension, refined-prompt cache.',
    'Archive numbering fix · Download + Delete-from-Archive buttons on archive entries.',
    'Audit / quarantine / purge for the HF cache.',
    'Role-aware chat model selection · 4-bit quantization for big roles on 24GB VRAM.',
  ]},
];

// Stats
document.getElementById('stReleases').textContent = RELEASES.length;

// Rail
const rail = document.getElementById('rail');
const groupHead = document.createElement('div');
groupHead.className = 'grp';
groupHead.innerHTML = `<span>VERSIONS</span><em>${RELEASES.length}</em>`;
rail.appendChild(groupHead);
RELEASES.forEach(r => {
  const el = document.createElement('div');
  el.className = 'ver';
  el.dataset.v = r.v;
  el.innerHTML = `<span class="num">${r.v}</span><span class="lbl">${r.tagline.split(/[·,]/)[0].trim().slice(0,28)}</span>`;
  el.addEventListener('click', () => {
    document.querySelectorAll('.rail .ver').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    const tgt = document.getElementById('rel-' + r.v.replace(/\./g,'_'));
    if (tgt) document.querySelector('.main').scrollTo({ top: tgt.offsetTop - 16, behavior: 'smooth' });
  });
  rail.appendChild(el);
});

// Timeline
const tl = document.getElementById('timeline');
RELEASES.forEach(r => {
  const sec = document.createElement('div');
  sec.className = 'release';
  sec.id = 'rel-' + r.v.replace(/\./g,'_');
  const tags = (r.tags || []).map(t => `<span class="tag c-${t}">${t}</span>`).join('');
  sec.innerHTML = `
    <div class="release-head">
      <h2>${r.v}</h2>
      <span class="tagline">${r.tagline}</span>
      <span class="badge ${r.kind}">${r.kind}</span>
    </div>
    <div class="release-tags">${tags}</div>
    <ul>${r.items.map(i => `<li>${i}</li>`).join('')}</ul>
    <div class="meta"><span>SHIPPED · <em>${r.v}</em></span><span>${r.items.length} item${r.items.length===1?'':'s'}</span></div>
  `;
  tl.appendChild(sec);
});

// ---- Recent commits (live, from GitHub via the loopback server) -------------
// The curated RELEASES above are hand-written; this section shows the actual
// recent commits on main, fetched through GET /changelog/commits (the server
// proxies api.github.com because the GUI's CSP connect-src is loopback-only).
// Commit text is external data → built with textContent (never innerHTML) to
// stay injection-safe. Prepended above the curated releases.
(function loadRecentCommits() {
  const tlEl = document.getElementById('timeline');
  if (!tlEl) return;

  // Tauri-aware base: a relative fetch resolves to tauri.localhost in the app
  // and never reaches the Python server. Mirror the shared resolver.
  const BASE = (function () {
    try { if (typeof window.SeekDeepResolveBase === 'function') return window.SeekDeepResolveBase(); } catch (_) {}
    if (window.__TAURI__ || (window.location.hostname || '') === 'tauri.localhost') return 'http://127.0.0.1:7865';
    return (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865';
  })();

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    let s = Math.floor((Date.now() - t) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24); if (d < 30) return d + 'd ago';
    return new Date(t).toISOString().slice(0, 10);
  }

  const sec = document.createElement('div');
  sec.className = 'release';
  sec.id = 'recent-commits';
  const head = document.createElement('div');
  head.className = 'release-head';
  head.innerHTML = '<h2>Recent commits</h2><span class="tagline">live from GitHub · main</span><span class="badge fresh">git</span>';
  sec.appendChild(head);
  const status = document.createElement('div');
  status.className = 'meta';
  status.innerHTML = '<span>loading recent commits…</span>';
  sec.appendChild(status);
  const ul = document.createElement('ul');
  ul.className = 'commits';
  sec.appendChild(ul);
  tlEl.insertBefore(sec, tlEl.firstChild);

  fetch(BASE + '/changelog/commits?limit=20', { headers: { 'Accept': 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((body) => {
      const commits = (body && Array.isArray(body.commits)) ? body.commits : [];
      if (!body || body.ok === false || !commits.length) {
        status.innerHTML = '<span>recent commits unavailable</span>';
        return;
      }
      status.textContent = '';
      const live = document.createElement('span');
      live.textContent = (body.stale ? 'CACHED' : (body.cached ? 'LIVE · cached' : 'LIVE')) + ' · GitHub API';
      const cnt = document.createElement('span');
      cnt.textContent = commits.length + ' commit' + (commits.length === 1 ? '' : 's');
      status.appendChild(live); status.appendChild(cnt);
      commits.forEach((c) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'commit-sha';
        a.textContent = c.shortSha || '';
        if (c.url) { a.href = c.url; a.rel = 'noopener noreferrer'; }
        const msg = document.createElement('span');
        msg.className = 'commit-msg';
        msg.textContent = ' ' + (c.message || '');
        const meta = document.createElement('span');
        meta.className = 'commit-meta';
        meta.textContent = '  — ' + (c.author || 'unknown') + (c.date ? ' · ' + relTime(c.date) : '');
        li.appendChild(a); li.appendChild(msg); li.appendChild(meta);
        ul.appendChild(li);
      });
    })
    .catch(() => { status.innerHTML = '<span>recent commits unavailable (server offline?)</span>'; });
})();
