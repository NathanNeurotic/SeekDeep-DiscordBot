const RELEASES = [
  { v: 'v10.38', kind: 'major', tagline: 'GUI⇄Discord parity · self-service TTS · CSP Phase A · DataDash Activity · audit round-2', tags: ['feat','fix','perf'], items: [
    '<strong>Self-update was silently dead — fixed:</strong> the self-updater\'s signature gate does <span class="mono">import release_signing</span>, but <span class="mono">release_signing.py</span> was never in the updater\'s file manifest, so it never reached the installed app — every self-update 500\'d with <span class="mono">ModuleNotFoundError: No module named \'release_signing\'</span> <em>before</em> it could commit a single file (the staging is atomic, so it failed clean — but it never updated). The module is now shipped in the self-update manifest, so fresh installs and future updates carry it and self-update completes. (Found while pushing the bridge fix to the running app — the app had been stuck unable to pull any update.)',
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
