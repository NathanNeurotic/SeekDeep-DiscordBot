/* DATA DASH boot — extracted from the inline <script> in index.html so it runs
   under the Tauri webview's strict CSP (script-src 'self'). Inline scripts are
   blocked there, which is why the "back to Control Center" link never appeared
   in the installed app. (In Discord the page has no such CSP; external is fine
   in both contexts.)

   Show the "← Control Center" affordance only when this is NOT a Discord
   Activity — Discord launches with a ?frame_id and iframes the page, where
   Control Center isn't reachable. In the SeekDeep desktop GUI it's a normal
   top-level page, so offer the way back. */
(function () {
  try {
    var inDiscord = !!new URLSearchParams(location.search).get('frame_id') || window.self !== window.top;
    if (!inDiscord) { var el = document.getElementById('sd-return-cc'); if (el) el.hidden = false; }
  } catch (e) {}
})();
