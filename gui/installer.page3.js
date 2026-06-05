          (function wireOllama() {
            const base    = document.getElementById('ollamaBaseUrl');
            const key     = document.getElementById('ollamaApiKey');
            const signin  = document.getElementById('ollamaSigninBtn');
            const probe   = document.getElementById('ollamaProbeBtn');
            const status  = document.getElementById('ollamaStatus');
            const log     = document.getElementById('ollamaSigninLog');
            if (!base || !key || !signin || !probe) return;

            function persistOllama() {
              // Save to wizard state so .env preview + final save include
              // these fields. state is the installer's global state obj.
              if (typeof state === 'object' && state) {
                state.ollama_base_url = base.value.trim();
                state.ollama_api_key = key.value.trim();
                if (typeof saveState === 'function') saveState();
                if (typeof updateEnvPreview === 'function') updateEnvPreview();
              }
            }
            base.addEventListener('input', persistOllama);
            key.addEventListener('input', persistOllama);
            // Restore saved values on load. `state` is a const declared in
            // installer.page7.js, which loads AFTER this file — so reading it
            // at parse time hits the temporal dead zone (even `typeof` throws
            // on a TDZ const). Defer to DOMContentLoaded, by which point
            // page7 has initialized `state`.
            window.addEventListener('DOMContentLoaded', () => {
              if (typeof state === 'object' && state) {
                if (state.ollama_base_url) base.value = state.ollama_base_url;
                if (state.ollama_api_key)  key.value  = state.ollama_api_key;
              }
            });

            function wireBus() {
              if (!window.SeekDeepEvents) return false;
              window.SeekDeepEvents.on('ollama.signin.line', (d) => {
                if (!d || !d.line) return;
                log.style.display = 'block';
                log.textContent += d.line + '\n';
                log.scrollTop = log.scrollHeight;
              });
              window.SeekDeepEvents.on('ollama.signin.complete', (d) => {
                signin.disabled = false;
                signin.textContent = d.ok ? '✓ SIGNED IN' : '✕ FAILED · RETRY';
                signin.style.background = d.ok ? 'var(--good)' : 'var(--bad)';
                setTimeout(() => { probe.click(); }, 800);
              });
              window.SeekDeepEvents.on('ollama.signin.failed', (d) => {
                signin.disabled = false;
                signin.textContent = '✕ ERROR · RETRY';
                signin.style.background = 'var(--bad)';
                log.style.display = 'block';
                log.textContent += '✕ ' + (d && d.error || 'unknown') + '\n';
              });
              return true;
            }
            if (!wireBus()) { let n = 0; const iv = setInterval(() => { if (wireBus() || ++n > 30) clearInterval(iv); }, 250); }

            signin.addEventListener('click', async () => {
              signin.disabled = true;
              signin.textContent = '… opening browser';
              log.style.display = 'block';
              log.textContent = '▸ POST /system/ollama-signin · spawning `ollama signin`\n';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/ollama-signin', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: '{}', signal: AbortSignal.timeout(12_000),
                });
                if (!r.ok) {
                  const b = await r.json().catch(() => ({}));
                  log.textContent += '✕ ' + (b.detail || b.error || ('HTTP ' + r.status)) + '\n';
                  signin.disabled = false;
                  signin.textContent = '▸ Run ollama signin';
                }
              } catch (err) {
                log.textContent += '✕ ' + (err.message || err) + '\n';
                signin.disabled = false;
                signin.textContent = '▸ Run ollama signin';
              }
            });
            probe.addEventListener('click', async () => {
              status.textContent = '… probing';
              try {
                const r = await fetch(SEEKDEEP_BASE + '/system/ollama-status', {
                  cache: 'no-store', signal: AbortSignal.timeout(4000),
                });
                const data = await r.json();
                const parts = [];
                parts.push(data.daemon_reachable ? '✓ daemon up' : '✕ daemon offline');
                // The server reads OLLAMA_API_KEY from os.getenv (set from
                // .env at AI-server boot). Typing into this field saves to
                // wizard state, not .env — distinguish "saved & active" from
                // "typed but not yet persisted" so the user isn't confused.
                const typedKey = (key.value || '').trim();
                if (data.api_key_set) {
                  parts.push('✓ API key set');
                } else if (typedKey) {
                  parts.push('⚠ API key typed (finish wizard or click Save to apply)');
                } else {
                  parts.push('no API key');
                }
                parts.push(data.device_key_present ? '✓ device key' : 'no device key');
                status.textContent = parts.join(' · ');
                status.style.color = data.signed_in || data.daemon_reachable ? 'var(--good)' : 'var(--warn)';
              } catch (err) {
                status.textContent = '✕ ' + (err.message || err);
                status.style.color = 'var(--bad)';
              }
            });
            // Auto-probe on step activation
            setTimeout(() => probe.click(), 600);
          })();
