from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_short_named_visual_subject_route.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("function isNaturalImagePrompt", "isNaturalImagePrompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper = r"""
// SEEKDEEP_SHORT_NAMED_VISUAL_SUBJECT_ROUTE_START
function seekdeepLooksLikeShortNamedVisualSubject(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;
  if (p.length > 120) return false;

  // Do not hijack normal questions, support requests, research, code, tables, or status commands.
  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p)) return false;
  if (/\b(explain|tell me|summarize|summary|define|definition|compare|comparison|difference|pros|cons|table|spreadsheet|code|script|powershell|status|queue|archive|cache|help|commands|audit|search|look up|internet|web)\b/.test(p)) return false;

  const words = p.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 10) return false;

  const namedVisualCue = /\b(spyro|ripto|predator|xenomorph|alien|matrix|homer|simpson|sailor\s*moon|pepe|sonic|mario|zelda|link|kirby|pokemon|pok[eÃ©]mon|pikachu|animal\s*crossing|nintendo|batman|joker|spawn|doomguy|master\s*chief|crash\s*bandicoot)\b/.test(p);
  const visualModifierCue = /\b(predator|alien|matrix|cyberpunk|gothic|metal|emo|screamo|hardcore|neon|robot|mutant|monster|dragon|demon|vampire|zombie|armor|armored|samurai|wizard|pirate|ninja|forest|jungle|space|castle|cathedral|balcony|sunset|poster|album|cover)\b/.test(p);

  // Short subject phrase with a known visual entity and some modifier/second subject.
  if (namedVisualCue && visualModifierCue) return true;

  // Two known entities mashed together, e.g. "Pepe Sailor Moon".
  const knownMatches = p.match(/\b(spyro|ripto|predator|matrix|homer|simpson|sailor\s*moon|pepe|sonic|mario|zelda|link|kirby|pikachu|batman|joker)\b/g) || [];
  if (knownMatches.length >= 2) return true;

  return false;
}
// SEEKDEEP_SHORT_NAMED_VISUAL_SUBJECT_ROUTE_END

"""

if "SEEKDEEP_SHORT_NAMED_VISUAL_SUBJECT_ROUTE_START" not in text:
    # Put the helper before isNaturalImagePrompt to keep route helpers together.
    pos = text.find("function isNaturalImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate isNaturalImagePrompt anchor.")
    text = text[:pos] + helper + text[pos:]

# Patch the messageCreate image route boundary. Prefer the raw-mode route if present.
if "seekdeepLooksLikeShortNamedVisualSubject(prompt)" not in text[text.find("client.on('messageCreate'"):]:
    msg_start = text.find("client.on('messageCreate'")
    if msg_start < 0:
        raise SystemExit("Could not locate messageCreate.")

    old_raw = "    if ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || isNaturalImagePrompt(prompt)) {"
    new_raw = "    if ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)) {"

    raw_pos = text.find(old_raw, msg_start)
    if raw_pos >= 0:
        text = text[:raw_pos] + new_raw + text[raw_pos + len(old_raw):]
    else:
        old_plain = "    if (isNaturalImagePrompt(prompt)) {"
        plain_pos = text.find(old_plain, msg_start)
        if plain_pos < 0:
            raise SystemExit("Could not locate messageCreate image route condition.")
        new_plain = "    if ((typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)) {"
        text = text[:plain_pos] + new_plain + text[plain_pos + len(old_plain):]

# Patch explicit trigger as a fallback if function exists and does not already include generate-for-me trigger.
if "function seekdeepHasExplicitImageRequest" in text and "SEEKDEEP_SHORT_SUBJECT_EXPLICIT_GENERATE_START" not in text:
    pos = text.find("function seekdeepHasExplicitImageRequest")
    marker = "if (!text) return false;"
    marker_pos = text.find(marker, pos)
    if marker_pos >= 0:
        insert_at = text.find("\n", marker_pos) + 1
        trigger = r"""

  // SEEKDEEP_SHORT_SUBJECT_EXPLICIT_GENERATE_START
  if (/^(?:generate|create|make|render|draw|paint|sketch|illustrate|design)\s+(?:(?:for\s+)?me\s+)?\S+/i.test(text) &&
      !/\b(?:table|spreadsheet|list|pros|cons|summary|explanation|code|script|powershell)\b/i.test(text)) {
    return true;
  }
  // SEEKDEEP_SHORT_SUBJECT_EXPLICIT_GENERATE_END
"""
        text = text[:insert_at] + trigger + text[insert_at:]

for needle, label in [
    ("function seekdeepLooksLikeShortNamedVisualSubject", "short named visual subject helper"),
    ("spyro|ripto|predator", "Spyro/Ripto/Predator cues"),
    ("seekdeepLooksLikeShortNamedVisualSubject(prompt)", "message route uses short subject helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched short named visual subject image route.")