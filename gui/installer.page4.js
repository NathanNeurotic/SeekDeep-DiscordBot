          (function wireSearxngStart() {
            const btn = document.getElementById('startSearxngBtn');
            if (!btn) return;
            btn.addEventListener('click', async () => {
              const orig = btn.textContent;
              btn.disabled = true;
              btn.textContent = '… starting';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/docker/start-searxng', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(60_000),
                });
                const data = await r.json().catch(() => ({}));
                if (r.ok && data.ok !== false) {
                  btn.textContent = '✓ STARTED · WAIT 5-15s';
                  btn.style.background = 'var(--good)';
                  setTimeout(() => { document.getElementById('probeSearxng')?.click(); }, 8000);
                } else {
                  btn.textContent = '✕ FAILED · ' + ((data.error || '').slice(0, 60) || 'see console');
                  btn.style.background = 'var(--bad)';
                  console.warn('[SeekDeep installer] /docker/start-searxng:', data);
                }
              } catch (err) {
                btn.textContent = '✕ ERROR';
                btn.style.background = 'var(--bad)';
                console.warn('[SeekDeep installer] /docker/start-searxng error:', err);
              }
              setTimeout(() => { btn.disabled = false; btn.textContent = orig; btn.style.background = ''; }, 8000);
            });
          })();
