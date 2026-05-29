/* SeekDeep · resilient fetch helper
 * ============================================
 * Closes audit §5 (one-shot fetches with no retry are everywhere).
 *
 * Every bare `fetch(url, {signal: AbortSignal.timeout(N)})` in the GUI was
 * "try once, leave whatever was on screen if it fails." That's how
 * stale-version pills survived across installs (`gui/version.js` fixed
 * separately), how "OFFLINE" cards stuck during sidecar respawn windows,
 * and how every Quick Action sometimes "Failed to fetch" without any
 * recovery path.
 *
 * Public API (window.SeekDeepFetch):
 *   .retry(url, opts)
 *       fetch with exponential backoff. Same options shape as native
 *       fetch plus:
 *         maxAttempts (default 5)
 *         baseDelayMs (default 1000)
 *         maxDelayMs  (default 30000)
 *         attemptTimeoutMs (default 8000) — per-attempt AbortSignal
 *         onAttempt({attempt, error, willRetry, delayMs}) — progress hook
 *       Returns the Response of the first successful attempt. Rejects
 *       with the final attempt's error if all retries fail.
 *
 *   .json(url, opts)
 *       Same as retry() but resolves to the parsed JSON body. Convenience
 *       wrapper because 90%+ of GUI fetches are JSON.
 *
 *   .liveStatus(handler, opts?)
 *       Subscribes `handler({connected: bool, lastError?: string,
 *       attemptsSinceSuccess: number})` to the connection state. Pages can
 *       use this to render "connecting..." banners instead of stale
 *       cached data. Fires once with connected=null on subscribe.
 *
 * Wire-up: auto-loaded by nav.js alongside events.js / version.js /
 * notify.js. Pages do nothing — `window.SeekDeepFetch` is just there.
 *
 * Visibility: refetches kick to attempt 0 (1s backoff) when the tab
 * regains visibility — covers the "I fixed the sidecar in another
 * window, why is this one still showing OFFLINE" UX path.
 */
(function () {
  'use strict';
  if (window.SeekDeepFetch) return;

  // Track every in-flight or scheduled retry so visibilitychange can
  // reset their attempt counter to 0 (= 1s backoff) and accelerate
  // recovery once the user comes back to the tab.
  const liveLoops = new Set();
  const statusSubscribers = new Set();
  let connectionState = { connected: null, lastError: null, attemptsSinceSuccess: 0 };

  function notifyStatus(patch) {
    connectionState = { ...connectionState, ...patch };
    for (const fn of statusSubscribers) {
      try { fn({ ...connectionState }); } catch {}
    }
  }

  function delayFor(attempt, baseMs, capMs) {
    const ms = Math.min(capMs, baseMs * Math.pow(2, attempt));
    // 20% jitter so multiple concurrent retry loops don't synchronize.
    return Math.round(ms * (0.9 + Math.random() * 0.2));
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function attemptOnce(url, opts, attemptTimeoutMs, externalSignal) {
    // Build per-attempt AbortController so the caller's signal AND our
    // own attempt timeout both abort cleanly. Native AbortSignal.any is
    // not in all webview2 builds yet — wire manually.
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), attemptTimeoutMs);
    let externalAborter = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(tid);
        throw externalSignal.reason || new DOMException('aborted', 'AbortError');
      }
      externalAborter = () => ctl.abort(externalSignal.reason || new DOMException('aborted', 'AbortError'));
      externalSignal.addEventListener('abort', externalAborter, { once: true });
    }
    try {
      const init = { ...opts, signal: ctl.signal };
      delete init.maxAttempts;
      delete init.baseDelayMs;
      delete init.maxDelayMs;
      delete init.attemptTimeoutMs;
      delete init.onAttempt;
      const resp = await fetch(url, init);
      return resp;
    } finally {
      clearTimeout(tid);
      if (externalAborter && externalSignal) {
        externalSignal.removeEventListener('abort', externalAborter);
      }
    }
  }

  async function retry(url, opts = {}) {
    const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : 5;
    const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 1000;
    const maxDelayMs  = Number.isFinite(opts.maxDelayMs)  ? opts.maxDelayMs  : 30000;
    const attemptTimeoutMs = Number.isFinite(opts.attemptTimeoutMs) ? opts.attemptTimeoutMs : 8000;
    const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
    const externalSignal = opts.signal || null;

    const loopRef = { attempt: 0 };
    liveLoops.add(loopRef);

    let lastErr = null;
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        loopRef.attempt = attempt;
        try {
          const resp = await attemptOnce(url, opts, attemptTimeoutMs, externalSignal);
          // 5xx is server-side transient; retry with backoff. 4xx is
          // caller's fault — return so caller can inspect status.
          if (resp.status >= 500 && resp.status <= 599 && attempt < maxAttempts - 1) {
            lastErr = new Error(`HTTP ${resp.status}`);
            if (onAttempt) onAttempt({ attempt, error: lastErr, willRetry: true, delayMs: delayFor(attempt, baseDelayMs, maxDelayMs) });
            notifyStatus({ connected: false, lastError: lastErr.message, attemptsSinceSuccess: attempt + 1 });
            await wait(delayFor(attempt, baseDelayMs, maxDelayMs));
            continue;
          }
          notifyStatus({ connected: true, lastError: null, attemptsSinceSuccess: 0 });
          return resp;
        } catch (err) {
          lastErr = err;
          const willRetry = attempt < maxAttempts - 1;
          if (onAttempt) onAttempt({ attempt, error: err, willRetry, delayMs: willRetry ? delayFor(attempt, baseDelayMs, maxDelayMs) : 0 });
          notifyStatus({ connected: false, lastError: String(err?.message || err), attemptsSinceSuccess: attempt + 1 });
          if (!willRetry) throw err;
          // External cancellation skips remaining attempts.
          if (externalSignal && externalSignal.aborted) throw err;
          await wait(delayFor(attempt, baseDelayMs, maxDelayMs));
        }
      }
      throw lastErr || new Error('exhausted retries');
    } finally {
      liveLoops.delete(loopRef);
    }
  }

  async function json(url, opts = {}) {
    const resp = await retry(url, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}${text ? ': ' + text.slice(0, 200) : ''}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }
    return resp.json();
  }

  function liveStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    statusSubscribers.add(handler);
    try { handler({ ...connectionState }); } catch {}
    return () => statusSubscribers.delete(handler);
  }

  // Visibility recovery: when the tab regains focus, reset every active
  // retry loop's attempt counter so it returns to 1s backoff instead of
  // sitting on a 30s tail. Resolves "I fixed the sidecar; why is the UI
  // still timing out?" without forcing a hard reload.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      for (const ref of liveLoops) ref.attempt = 0;
    });
  }

  window.SeekDeepFetch = { retry, json, liveStatus };
})();
