from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_focused_research_search_query.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function askChat", "askChat"),
    ("async function searchWeb", "searchWeb"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("function seekdeepResearchPrompt", "research prompt"),
    ("function seekdeepResearchFollowupPrompt", "research followup prompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1. Filter obviously bad SearXNG results.
old = "  const results = Array.isArray(json.results) ? json.results.slice(0, 6) : [];\n"
new = """  const rawResults = Array.isArray(json.results) ? json.results : [];
  const results = rawResults.filter((r) => {
    const title = String(r?.title || '').toLowerCase();
    const url = String(r?.url || '').toLowerCase();
    const snippet = String(r?.content || r?.snippet || '').toLowerCase();

    if (!title && !url && !snippet) return false;
    if (url.includes('google.com/recaptcha') || title.includes('recaptcha')) return false;
    if (title.includes('search anything') && url.includes('google.')) return false;
    if (url.includes('securedrop.org') && !query.toLowerCase().includes('securedrop')) return false;
    if (title.includes('newsarchive') && !query.toLowerCase().includes('newsarchive')) return false;

    return true;
  }).slice(0, 6);
"""
if old in text and "const rawResults = Array.isArray(json.results)" not in text:
    text = text.replace(old, new, 1)

# 2. Add searchQueryOverride option to askChat.
old_sig = "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null } = {}) {"
new_sig = "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null, searchQueryOverride = '' } = {}) {"
if old_sig in text:
    text = text.replace(old_sig, new_sig, 1)
elif "searchQueryOverride" not in text[text.find("async function askChat"):text.find("async function askVision")]:
    raise SystemExit("Could not patch askChat signature.")

old_query = "  const searchQuery = memoryKey ? buildSearchQuery(cleanPrompt, memoryKey) : cleanPrompt;\n"
new_query = "  const searchQuery = normalizeUserText(searchQueryOverride || (memoryKey ? buildSearchQuery(cleanPrompt, memoryKey) : cleanPrompt));\n"
if old_query in text:
    text = text.replace(old_query, new_query, 1)
elif "searchQueryOverride ||" not in text[text.find("async function askChat"):text.find("async function askVision")]:
    raise SystemExit("Could not patch askChat search query line.")

# 3. Add focused research query helper.
helper = r"""
function seekdeepBuildFocusedResearchSearchQuery(topic = '', mode = 'research') {
  const raw = normalizeUserText(topic);
  const p = raw.toLowerCase();

  if (/\b(lenovo|thinkpad|x1\s*carbon|x1carbon|t14|t14s)\b/.test(p)) {
    const terms = [];

    if (/\bx1\s*carbon|x1carbon\b/.test(p)) terms.push('"ThinkPad X1 Carbon"');
    if (/\bt14\b/.test(p)) terms.push('"ThinkPad T14"');
    if (/\bt14s\b/.test(p)) terms.push('"ThinkPad T14s"');
    if (/\bgen\s*2|generation\s*2\b/.test(p)) terms.push('"Gen 2"');
    if (/\bgen\s*3|generation\s*3\b/.test(p)) terms.push('"Gen 3"');
    if (/\bgen\s*9|generation\s*9\b/.test(p)) terms.push('"Gen 9"');
    if (/\bgen\s*10|generation\s*10\b/.test(p)) terms.push('"Gen 10"');
    if (/\bamd|ryzen\b/.test(p)) terms.push('AMD Ryzen');
    if (/\bintel|core\b/.test(p)) terms.push('Intel Core');

    terms.push('Lenovo PSREF specifications review comparison');

    return terms.join(' ');
  }

  let q = raw
    .replace(/\b(create|make|give me|show me|list|break down|pros and cons|pros\/cons|audit|fact check|verify|table|tablesheet|comparison table|chart|matrix)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (mode === 'audit') q += ' specifications sources fact check';
  if (mode === 'table') q += ' specs comparison';
  if (mode === 'proscons') q += ' pros cons review comparison';

  return q.trim() || raw;
}

"""

if "function seekdeepBuildFocusedResearchSearchQuery" not in text:
    anchor = "function seekdeepResearchSystem"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate seekdeepResearchSystem anchor.")
    text = text[:pos] + helper + text[pos:]

# 4. Add searchQueryOverride to research askChat calls when absent.
# Conservative replacements around known call sites.
text = text.replace(
    "        temperature: 0.2,\n      });",
    "        temperature: 0.2,\n        searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, 'table'),\n      });",
    1
)

text = text.replace(
    "      temperature: 0.2,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.2,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p)),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

text = text.replace(
    "      temperature: 0.2,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.2,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(mergedTopic, 'table'),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

text = text.replace(
    "      temperature: 0.22,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.22,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(topic, 'research'),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

# If an audit/followup call exists and did not receive override because formatting differed, insert by local anchor.
if "searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p))" not in text:
    anchor = "system: seekdeepResearchSystem(seekdeepResearchFollowupMode(p) === 'table' ? 'table' : 'research'),\n      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_FOLLOWUP_MAX_TOKENS || 1800),\n      temperature: 0.2,\n"
    if anchor in text:
        text = text.replace(anchor, anchor + "      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p)),\n", 1)

# 5. Strengthen source instruction to reject bad source sets.
if "Reject or down-rank irrelevant search results" not in text:
    text = text.replace(
        "'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',",
        "'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',\n"
        "    'Reject or down-rank irrelevant search results such as reCAPTCHA pages, unrelated PDFs, generic search landing pages, Reddit-only evidence, or unrelated model generations.',",
        1
    )

for needle, label in [
    ("searchQueryOverride", "askChat search query override"),
    ("function seekdeepBuildFocusedResearchSearchQuery", "focused research query helper"),
    ("Lenovo PSREF specifications review comparison", "ThinkPad focused query terms"),
    ("const rawResults = Array.isArray(json.results)", "search result filtering"),
    ("Reject or down-rank irrelevant search results", "bad source guard"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched focused research search queries and result filtering.")