/* Discord Embedded App SDK loader — extracted from the inline <script type=module>
   in index.html so it runs under the Tauri webview's strict CSP (script-src
   'self'). Guarded so it also works as a plain web page: outside Discord (no
   ?frame_id) it returns BEFORE the esm.sh import, so the strict CSP is never
   exercised in the desktop app. Inside Discord (no Tauri CSP) the import runs
   exactly as before. */
window.SEEKDEEP_DISCORD_CLIENT_ID = "1500739883046670346";

(async () => {
  try {
    const params = new URLSearchParams(location.search);
    // Only attempt the handshake when actually launched inside Discord.
    if (!params.get("frame_id")) return;
    const { DiscordSDK } = await import("https://esm.sh/@discord/embedded-app-sdk@1.9.0");
    const sdk = new DiscordSDK(window.SEEKDEEP_DISCORD_CLIENT_ID);
    await sdk.ready();
    window.__discordSDK = sdk;
    document.documentElement.classList.add("discord-activity-ready");
  } catch (e) { /* not in Discord / SDK unavailable — run as normal web page */ }
})();
