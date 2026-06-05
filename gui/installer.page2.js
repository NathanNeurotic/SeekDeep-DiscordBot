          (function wireBootstrapStep() {
            const statusEl = document.getElementById('bootstrapStatus');
            const runBtn   = document.getElementById('bootstrapRunBtn');
            const hintEl   = document.getElementById('bootstrapHint');
            const logEl    = document.getElementById('bootstrapLog');
            const toggle   = document.querySelector('[data-step="bootstrap"] .toggle[data-flag="bootstrap_done"]');
            if (!statusEl || !runBtn) return;

            function renderRows(steps) {
              if (!Array.isArray(steps)) return;
              statusEl.innerHTML = '';
              for (const s of steps) {
                const row = document.createElement('div');
                row.style.cssText = 'display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: start; padding: 4px 0;';
                const m = document.createElement('span');
                m.textContent = s.ok ? '✓' : '✕';
                m.style.color = s.ok ? 'var(--good)' : 'var(--warn)';
                row.appendChild(m);
                const right = document.createElement('div');
                const lbl = document.createElement('div');
                lbl.textContent = s.label;
                lbl.style.color = s.ok ? 'var(--hull-3)' : 'var(--hull-1)';
                right.appendChild(lbl);
                if (!s.ok && s.fix) {
                  const fx = document.createElement('div');
                  fx.textContent = '↳ ' + s.fix;
                  fx.style.cssText = 'font-size: 10.5px; color: var(--hull-3); margin-top: 2px; line-height: 1.45;';
                  right.appendChild(fx);
                }
                row.appendChild(right);
                statusEl.appendChild(row);
              }
            }
            async function refreshStatus() {
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/bootstrap-status', {
                  cache: 'no-store', signal: AbortSignal.timeout(4000),
                });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                renderRows(data.steps);
                if (data.ready) {
                  hintEl.textContent = '✓ everything is set up · this step is complete';
                  hintEl.style.color = 'var(--good)';
                  runBtn.textContent = '✓ ALL SET';
                  runBtn.disabled = true;
                  if (toggle && !toggle.classList.contains('on')) toggle.classList.add('on');
                } else {
                  hintEl.textContent = '— skips anything already in place';
                  hintEl.style.color = '';
                  runBtn.textContent = '▸ SET UP NOW';
                  runBtn.disabled = false;
                }
              } catch (err) {
                statusEl.innerHTML = `<div style="color: var(--warn); padding: 6px 0;">⚠ couldn't reach the local AI server (${String(err.message || err).slice(0, 80)}) — start it from the Launcher pane and re-open this step.</div>`;
              }
            }
            // Subscribe to bootstrap.line events for live log. Hide
            // the log pane until the first line arrives.
            function wireBus() {
              if (!window.SeekDeepEvents) return false;
              window.SeekDeepEvents.on('bootstrap.line', (d) => {
                if (!d || !d.line) return;
                logEl.style.display = 'block';
                logEl.textContent += d.line + '\n';
                logEl.scrollTop = logEl.scrollHeight;
              });
              window.SeekDeepEvents.on('bootstrap.complete', () => {
                logEl.textContent += '\n--- bootstrap complete ---\n';
                logEl.scrollTop = logEl.scrollHeight;
                refreshStatus();
                runBtn.disabled = false;
              });
              window.SeekDeepEvents.on('bootstrap.failed', (d) => {
                logEl.textContent += '\n--- bootstrap FAILED · ' + (d && (d.step || d.error) || 'see log') + ' ---\n';
                logEl.scrollTop = logEl.scrollHeight;
                runBtn.disabled = false;
                runBtn.textContent = '▸ RETRY';
              });
              return true;
            }
            if (!wireBus()) { let n = 0; const iv = setInterval(() => { if (wireBus() || ++n > 30) clearInterval(iv); }, 250); }

            runBtn.addEventListener('click', async () => {
              runBtn.disabled = true;
              runBtn.textContent = '… RUNNING';
              logEl.style.display = 'block';
              logEl.textContent = '';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/bootstrap', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(10_000),
                });
                if (!r.ok) {
                  const body = await r.json().catch(() => ({}));
                  logEl.textContent += '✕ ' + (body.detail || body.error || ('HTTP ' + r.status)) + '\n';
                  runBtn.disabled = false;
                  runBtn.textContent = '▸ RETRY';
                }
                // Success path: bootstrap.line events stream from the
                // server. The complete/failed handlers above re-enable
                // the button.
              } catch (err) {
                logEl.textContent += '✕ ' + String(err.message || err) + '\n';
                runBtn.disabled = false;
                runBtn.textContent = '▸ RETRY';
              }
            });

            // Trigger probe whenever this step becomes visible.
            function onVisible() {
              const pane = document.querySelector('[data-step="bootstrap"]');
              if (pane && getComputedStyle(pane).display !== 'none') refreshStatus();
            }
            // The installer's setStep() toggles display:; we don't
            // hook into that directly. A short interval is fine — the
            // probe is cheap (filesystem stat).
            onVisible();
            setInterval(onVisible, 4000);
          })();
