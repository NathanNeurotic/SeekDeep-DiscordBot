          (function wireLaunchAll() {
            const btn = document.getElementById('launchAllBtn');
            const log = document.getElementById('launchLog');
            if (!btn || !log) return;
            btn.addEventListener('click', async () => {
              const orig = btn.textContent;
              btn.disabled = true;
              btn.textContent = '… launching';
              log.style.display = 'block';
              log.textContent = '▸ POST /system/launch-all (SearXNG → AI server → bot)\n';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/launch-all', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(90_000),
                });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok !== false) {
                  log.textContent += '✓ all services up:\n';
                  for (const [svc, info] of Object.entries(data.services || {})) {
                    log.textContent += '  · ' + svc + ' · ' + (info.already_running ? 'already running' : (info.ok ? 'started' : ('FAILED: ' + (info.error || '')))) + '\n';
                  }
                  btn.textContent = '✓ STACK UP · PROBE';
                  btn.style.background = 'var(--good)';
                  setTimeout(() => { document.getElementById('probeStack')?.click(); }, 1500);
                } else {
                  log.textContent += '✕ partial · see services:\n' + JSON.stringify(data.services || data, null, 2);
                  btn.textContent = '✕ PARTIAL · RETRY';
                  btn.style.background = 'var(--warn)';
                }
              } catch (err) {
                log.textContent += '✕ ' + (err.message || err) + '\n';
                btn.textContent = '✕ ERROR · RETRY';
                btn.style.background = 'var(--bad)';
              }
              setTimeout(() => { btn.disabled = false; btn.textContent = orig; btn.style.background = ''; }, 8000);
            });
          })();
