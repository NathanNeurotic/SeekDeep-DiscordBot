/* SeekDeep · updater.js
   ====================
   Tauri-only update checker. Auto-loaded by nav.js's autoLoadSiblings.

   On chat.html load (and only chat.html — playground is the daily-use
   surface where users will actually see it), pings the Tauri shell's
   check_for_update command, which curl-GETs GitHub's releases API.
   If a newer stable tag exists upstream, shows a one-shot notify.banner
   with "View release ↗" + "Remind me later" + "Skip this version" actions.

   Skip-this-version persists via localStorage so dismissing a release
   doesn't re-prompt on every page reload.

   Self-gates via window.__seekdeepUpdaterLoaded + the location.pathname
   check (chat.html only — other pages stay quiet).
*/
(function () {
  'use strict';
  if (window.__seekdeepUpdaterLoaded) return;
  window.__seekdeepUpdaterLoaded = true;

  // Page gate — keep the update banner out of the directory / docs / boot
  // animation / wizard pages. chat.html is where users dwell.
  const here = (location.pathname.split('/').pop() || '').toLowerCase();
  if (here !== 'chat.html') return;

  // Tauri gate — pure-browser visits can't invoke the Rust command.
  const tauri = (typeof window !== 'undefined' && window.__TAURI__) || null;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;

  const SKIP_KEY = 'sd-updater-skip-version';
  const REMIND_KEY = 'sd-updater-remind-at';
  const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

  function notify() { return window.SeekDeepNotify || null; }

  function openExternalUrl(url) {
    tauri.core.invoke('open_external', { url }).catch(() => window.open(url, '_blank'));
  }

  // HTML-escape version strings before they land in the html:true banner body.
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  async function probe() {
    // Honor "remind me later" cooldown
    const remindAt = parseInt(localStorage.getItem(REMIND_KEY) || '0', 10);
    if (remindAt && Date.now() < remindAt) return;

    let result;
    try {
      result = await tauri.core.invoke('check_for_update');
    } catch (err) {
      // Network failure / curl missing — silent. Updater is a nice-to-have.
      return;
    }
    if (!result || !result.update_available) return;
    if (localStorage.getItem(SKIP_KEY) === result.latest) return; // user skipped this version

    const sdn = notify();
    if (!sdn) {
      // Notify primitive not loaded — log + bail. We don't hand-roll the UI
      // for a low-priority feature.
      console.info('[SeekDeep updater] new version available:', result.latest, '(current:', result.current + ')');
      return;
    }
    sdn.banner({
      id: 'sd-updater-banner',
      tone: 'info',
      title: 'New SeekDeep release available',
      // html:true so the <code> tags render (without it the banner escapes the
      // body and shows raw "<code>…</code>" markup); versions are esc()'d since
      // we now own escaping. Plain version strings, but escape defensively.
      body: 'You\'re on <code>v' + esc(result.current) + '</code>. Latest is <code>v' + esc(result.latest) + '</code>.',
      html: true,
      primary: {
        label: 'View release ↗',
        onClick: ({ close }) => { openExternalUrl(result.release_url); close(); },
      },
      secondary: {
        label: 'Remind me later',
        onClick: ({ close }) => {
          localStorage.setItem(REMIND_KEY, String(Date.now() + REMIND_AFTER_MS));
          close();
        },
      },
      dismissible: true,
    });

    // Provide a "skip this version forever" path via a follow-on toast.
    // The user reads the banner, then if they dismiss with X they can opt
    // into the harder skip via the toast.
    setTimeout(() => {
      if (!document.querySelector('[data-id="sd-updater-banner"]')) {
        // banner already closed
        sdn.toast({
          tone: 'neutral',
          title: 'Update reminder muted for 24h',
          body: '<a href="#" data-sd-skip-update>Skip v' + String(result.latest).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) + ' permanently</a>',
          html: true,
          ttl: 8000,
        });
      }
    }, 200);

    document.addEventListener('click', function skipHandler(ev) {
      if (ev.target && ev.target.matches && ev.target.matches('[data-sd-skip-update]')) {
        ev.preventDefault();
        localStorage.setItem(SKIP_KEY, result.latest);
        document.removeEventListener('click', skipHandler);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    probe();
  }
})();
