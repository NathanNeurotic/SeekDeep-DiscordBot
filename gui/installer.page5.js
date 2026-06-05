          (function wireWarmup() {
            const runBtn  = document.getElementById('warmupRunBtn');
            const lockBtn = document.getElementById('lockCacheBtn');
            const log     = document.getElementById('warmupLog');
            const tg      = document.querySelector('[data-step="warmup"] .toggle[data-flag="warmup_done"]');
            if (!runBtn || !log) return;
            function wireBus() {
              if (!window.SeekDeepEvents) return false;
              window.SeekDeepEvents.on('warmup.line', (d) => {
                if (!d || !d.line) return;
                log.style.display = 'block';
                log.textContent += d.line + '\n';
                log.scrollTop = log.scrollHeight;
              });
              window.SeekDeepEvents.on('warmup.complete', (d) => {
                runBtn.disabled = false;
                runBtn.textContent = d.ok ? '✓ WARMUP DONE · RE-RUN' : '✕ FAILED · RE-RUN';
                runBtn.style.background = d.ok ? 'var(--good)' : 'var(--warn)';
                log.textContent += '\n--- warmup finished, exit ' + d.exit_code + ' ---\n';
                if (d.ok && tg && !tg.classList.contains('on')) tg.classList.add('on');
              });
              window.SeekDeepEvents.on('warmup.failed', (d) => {
                runBtn.disabled = false;
                runBtn.textContent = '✕ ERROR · RE-RUN';
                runBtn.style.background = 'var(--bad)';
                log.textContent += '\n--- warmup failed: ' + (d && d.error || 'unknown') + ' ---\n';
              });
              return true;
            }
            if (!wireBus()) { let n = 0; const iv = setInterval(() => { if (wireBus() || ++n > 30) clearInterval(iv); }, 250); }
            // Probe actual cache state at page load so the toggle reflects
            // disk reality, not a clicked-once localStorage value. We use
            // /system/firstrun's chat_model check as the canary because it
            // verifies the model files are physically present in the HF
            // cache directory (not just that .env names one).
            // Deferred to DOMContentLoaded: this probe reads SEEKDEEP_BASE,
            // a const declared in installer.page7.js which loads AFTER this
            // file — calling it at parse time would hit the temporal dead
            // zone and silently fail. page7 has run by DOMContentLoaded.
            async function probeWarmupState() {
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/firstrun', {
                  cache: 'no-store', signal: AbortSignal.timeout(8000),
                });
                if (!r.ok) return;
                const data = await r.json();
                const checks = (data && Array.isArray(data.checks)) ? data.checks : [];
                const chat = checks.find(c => c && (c.id === 'chat_model' || c.id === 'chat'));
                if (chat && chat.ok === true) {
                  if (tg && !tg.classList.contains('on')) tg.classList.add('on');
                } else {
                  if (tg && tg.classList.contains('on')) tg.classList.remove('on');
                }
              } catch (_) { /* server offline; leave toggle off */ }
            }
            // Run once page7's SEEKDEEP_BASE exists. Check the dependency DIRECTLY
            // (not a readyState proxy): typeof throws for a TDZ const → caught → wait
            // for DOMContentLoaded (after every parser script incl page7); if already
            // defined (any post-parse insertion), run now.
            var hasBase = false;
            try { hasBase = typeof SEEKDEEP_BASE !== 'undefined'; } catch (_) {}
            if (hasBase) probeWarmupState();
            else window.addEventListener('DOMContentLoaded', probeWarmupState);
            runBtn.addEventListener('click', async () => {
              runBtn.disabled = true;
              runBtn.textContent = '… DOWNLOADING';
              runBtn.style.background = '';
              log.style.display = 'block';
              log.textContent = '';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/warmup', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(15_000),
                });
                if (!r.ok) {
                  const b = await r.json().catch(() => ({}));
                  log.textContent += '✕ ' + (b.detail || b.error || ('HTTP ' + r.status)) + '\n';
                  runBtn.disabled = false; runBtn.textContent = '▸ RETRY';
                }
              } catch (err) {
                log.textContent += '✕ ' + (err.message || err) + '\n';
                runBtn.disabled = false; runBtn.textContent = '▸ RETRY';
              }
            });
            lockBtn.addEventListener('click', async () => {
              const orig = lockBtn.textContent;
              lockBtn.disabled = true;
              lockBtn.textContent = '… LOCKING';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/lock-cache', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(8_000),
                });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok !== false) {
                  lockBtn.textContent = '✓ LOCKED · RESTART AI';
                  lockBtn.style.background = 'var(--good)';
                } else {
                  lockBtn.textContent = '✕ FAILED';
                  lockBtn.style.background = 'var(--bad)';
                }
              } catch (err) {
                lockBtn.textContent = '✕ ERROR';
                lockBtn.style.background = 'var(--bad)';
              }
              setTimeout(() => { lockBtn.disabled = false; lockBtn.textContent = orig; lockBtn.style.background = ''; }, 5000);
            });
          })();
