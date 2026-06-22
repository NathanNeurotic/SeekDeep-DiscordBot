          (function wireDoctor() {
            const btn = document.getElementById('doctorRunBtn');
            const log = document.getElementById('doctorLog');
            if (!btn || !log) return;
            let doctorSafetyTimer = null;
            function wireBus() {
              if (!window.SeekDeepEvents) return false;
              window.SeekDeepEvents.on('doctor.line', (d) => {
                if (!d || !d.line) return;
                log.style.display = 'block';
                log.textContent += d.line + '\n';
                log.scrollTop = log.scrollHeight;
              });
              window.SeekDeepEvents.on('doctor.complete', (d) => {
                if (doctorSafetyTimer) { clearTimeout(doctorSafetyTimer); doctorSafetyTimer = null; }
                btn.disabled = false;
                btn.textContent = d.ok ? '✓ ALL CHECKS PASSED · RE-RUN' : '✕ FAILED · RE-RUN';
                btn.style.background = d.ok ? 'var(--good)' : 'var(--warn)';
                log.textContent += '\n--- doctor finished with exit code ' + d.exit_code + ' ---\n';
              });
              window.SeekDeepEvents.on('doctor.failed', (d) => {
                if (doctorSafetyTimer) { clearTimeout(doctorSafetyTimer); doctorSafetyTimer = null; }
                btn.disabled = false;
                btn.textContent = '✕ ERROR · RE-RUN';
                btn.style.background = 'var(--bad)';
                log.textContent += '\n--- doctor failed: ' + (d && d.error || 'unknown') + ' ---\n';
              });
              return true;
            }
            if (!wireBus()) { let n = 0; const iv = setInterval(() => { if (wireBus() || ++n > 30) clearInterval(iv); }, 250); }
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              btn.textContent = '… RUNNING';
              btn.style.background = '';
              log.style.display = 'block';
              log.textContent = '';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/doctor', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(15_000),
                });
                if (!r.ok) {
                  const b = await r.json().catch(() => ({}));
                  log.textContent += '✕ ' + (b.detail || b.error || ('HTTP ' + r.status)) + '\n';
                  btn.disabled = false; btn.textContent = '▸ RETRY';
                } else {
                  // Success: the server streams doctor.line and fires
                  // doctor.complete/failed (which re-enable + clear this timer). If
                  // the WS bus never connects, those never arrive — backstop so the
                  // button doesn't stay stuck at "… RUNNING" forever.
                  doctorSafetyTimer = setTimeout(() => {
                    doctorSafetyTimer = null;
                    if (btn.disabled) { btn.disabled = false; btn.textContent = '▸ RE-RUN'; }
                  }, 30000);
                }
              } catch (err) {
                log.textContent += '✕ ' + (err.message || err) + '\n';
                btn.disabled = false; btn.textContent = '▸ RETRY';
              }
            });
          })();
