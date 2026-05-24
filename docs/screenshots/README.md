# SeekDeep Repository Screenshots

This directory serves as a placeholder for visual assets and screenshots demonstrating the bot's features in action on Discord.

When publishing the repository, capture and upload high-resolution screenshots for the following key features:

## Required Screenshots

1. **Bot Status & Health Report**
   - console output showcasing the consolidation system health report grid on boot.
   - `@SeekDeep status` (or `/status`) inline response in a server channel.

2. **GPU Monitoring**
   - `@SeekDeep status verbose` displaying live GPU VRAM bars, CUDA details, and loaded models.
   - The live-updating `gpu watch` command output showing real-time memory fluctuations.

3. **Conversational Chat & Personas**
   - Chat dialogue with SeekDeep showing responses in different styles (e.g., `clinical`, `neurotic`, `chaotic`).
   - Modal persona switcher interface (`/persona`).

4. **Web Search Grounding**
   - A chat response showing web research in action, featuring the compact citation footer with links matching query terms.

5. **Image Generation & Prompt Refinement**
   - The prompt choice selection preview displaying original, refined, and both button options.
   - Generated images alongside the interactive buttons (Original/Refined/Re-Refine/Download/Archive).
   - Conversational follow-up modifications (e.g., replying to a generated image "now make it winter").

6. **Vision and OCR analysis**
   - Image analysis requests asking "what is this?" or "transcribe this text" using the local vision model (`/vision` or mentioning the image).

7. **Thread-Based Image Archive**
   - An example user archive thread showing numbering, coin emotes, and archived images.
   - A shared server archive thread showing community collections.

8. **Prompt Debugger**
   - Output from `@SeekDeep prompt debug` detailing prompt cleaning steps, negative prompts, seed, steps, and rendering speed parameters.

9. **Permission Diagnostics**
   - Report from `@SeekDeep permissions` listing green checkmarks for required Discord intents and channel access scopes.

## Guidelines
- Crop images tightly to remove unnecessary Discord client UI.
- Use a dark theme client for all screenshots to maintain premium aesthetic.
- Mask or censor any channel ids, guild names, or token credentials before pushing.
