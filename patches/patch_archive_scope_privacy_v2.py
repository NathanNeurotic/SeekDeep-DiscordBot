from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_scope_privacy_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

def find_matching_brace(source, open_brace_index):
    depth = 0
    i = open_brace_index
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escaped = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == "'":
                in_single = False
            escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == '"':
                in_double = False
            escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == "`":
                in_template = False
            escaped = False
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue

        if ch == '"':
            in_double = True
            i += 1
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    fail("Could not find matching closing brace.")

def get_named_function(source, name_or_signature):
    if name_or_signature.startswith("function ") or name_or_signature.startswith("async function "):
        start = source.find(name_or_signature)
    else:
        start = source.find(f"function {name_or_signature}(")
        if start < 0:
            start = source.find(f"async function {name_or_signature}(")
    if start < 0:
        return None, -1, -1
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for {name_or_signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[start:brace_close + 1], start, brace_close + 1

def replace_or_insert_function(source, fn_name, fn_code, insert_anchor):
    existing, start, end = get_named_function(source, fn_name)
    if start >= 0:
        return source[:start] + fn_code.rstrip() + source[end:]

    pos = source.find(insert_anchor)
    if pos < 0:
        # Fallback: before interaction handler.
        pos = source.find("client.on('interactionCreate'")
    if pos < 0:
        fail(f"Could not find insertion point for {fn_name}")

    return source[:pos] + fn_code.rstrip() + "\n\n" + source[pos:]

require("client.on('interactionCreate'", "interaction handler")
require("seekdeepEnqueueImageJob(job, runner)", "image queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

insert_anchor = "client.on('interactionCreate'"

# ----------------------------------------------------------------------
# 1. Ensure every archive helper exists.
# ----------------------------------------------------------------------
helper_functions = {
"seekdeepGuildArchiveScopeFromTarget": r"""function seekdeepGuildArchiveScopeFromTarget(target = null) {
  const guildId =
    target?.guild?.id ||
    target?.guildId ||
    target?.message?.guild?.id ||
    target?.message?.guildId ||
    target?.channel?.guild?.id ||
    target?.channel?.guildId ||
    target?.interaction?.guild?.id ||
    target?.interaction?.guildId ||
    target?.member?.guild?.id ||
    '';

  if (guildId) return `guild:${guildId}`;

  const userId =
    target?.user?.id ||
    target?.author?.id ||
    target?.member?.user?.id ||
    target?.message?.author?.id ||
    target?.message?.interaction?.user?.id ||
    target?.requesterId ||
    'unknown';

  return `dm:${userId}`;
}""",

"seekdeepSanitizeArchiveScopeKey": r"""function seekdeepSanitizeArchiveScopeKey(scope = '') {
  return String(scope || 'unknown')
    .replace(/^guild:/, 'guild-')
    .replace(/^dm:/, 'dm-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}""",

"seekdeepArchiveScopeLabel": r"""function seekdeepArchiveScopeLabel(target = null) {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  if (scope.startsWith('guild:')) return 'this server';
  if (scope.startsWith('dm:')) return 'this DM';
  return 'current archive scope';
}""",

"seekdeepArchiveScopedKey": r"""function seekdeepArchiveScopedKey(target = null, key = '') {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  const cleanKey = String(key || 'default').replace(/^:+|:+$/g, '') || 'default';
  return `${scope}:${cleanKey}`;
}""",

"seekdeepArchiveUserScopedKey": r"""function seekdeepArchiveUserScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `user:${uid}`);
}""",

"seekdeepArchiveThreadScopedKey": r"""function seekdeepArchiveThreadScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `thread:${uid}`);
}""",

"seekdeepArchiveDirForTarget": r"""function seekdeepArchiveDirForTarget(target = null) {
  const scopeDir = seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(target));
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const out = path.join(baseDir, 'saved_generations', 'archives', scopeDir);
  try {
    fs.mkdirSync(out, { recursive: true });
  } catch {}
  return out;
}""",

"seekdeepRedactArchivePathForDiscord": r"""function seekdeepRedactArchivePathForDiscord(value = '') {
  return String(value || '')
    .replace(/[A-Z]:\\[^\n\r`]+/gi, '[local archive path hidden]')
    .replace(/\/(?:home|Users|mnt|var|tmp)\/[^\n\r`]+/gi, '[local archive path hidden]');
}""",
}

for name, code in helper_functions.items():
    text = replace_or_insert_function(text, name, code, insert_anchor)

# ----------------------------------------------------------------------
# 2. Replace no-target archive helper calls with current interaction/message target.
# ----------------------------------------------------------------------
call_replacements = [
    ("seekdeepArchiveDir()", "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))"),
    ("seekdeepGetArchiveDir()", "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))"),
    ("seekdeepArchivePath()", "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))"),
    ("seekdeepGetArchivePath()", "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))"),
]
for old, new in call_replacements:
    text = text.replace(old, new)

# Replace common direct path join pattern for archives.
text = re.sub(
    r"path\.join\((__dirname|process\.cwd\(\)),\s*['\"]saved_generations['\"],\s*['\"]archives['\"],\s*[^)]*\)",
    "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))",
    text,
)

# ----------------------------------------------------------------------
# 3. Insert archiveTarget in slash command archive branches.
# ----------------------------------------------------------------------
text = re.sub(
    r"(if\s*\(\s*(?:commandName|interaction\.commandName)\s*===\s*['\"](?:archivestatus|postarchive|archive|weeklyarchive|alltimearchive|purgearchive)['\"]\s*\)\s*\{\n)(?!\s*const\s+archiveTarget)",
    r"\1      const archiveTarget = interaction || message || {};\n",
    text,
)

# Also support switch/case command branches.
text = re.sub(
    r"(case\s+['\"](?:archivestatus|postarchive|archive|weeklyarchive|alltimearchive|purgearchive)['\"]\s*:\s*\n)(?!\s*const\s+archiveTarget)",
    r"\1      const archiveTarget = interaction || message || {};\n",
    text,
)

# ----------------------------------------------------------------------
# 4. Redact path disclosure in Discord-facing labels/messages.
# ----------------------------------------------------------------------
text = text.replace("Archived on the bot host:", "Archived locally for this server.")
text = text.replace("Archived on bot host:", "Archived locally for this server.")
text = text.replace("Path checked:", "Archive scope checked:")
text = text.replace("Path:", "Archive scope:")

# Replace interpolated path variables in visible template strings with scope label.
for var in ["archiveDir", "archivePath", "savedPath", "filePath", "outPath", "targetPath"]:
    text = text.replace("${" + var + "}", "${seekdeepArchiveScopeLabel(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))}")

# Patch literal saved_generations\archives\dm-unknown if it was ever emitted.
text = text.replace("saved_generations\\\\archives\\\\dm-unknown", "saved_generations\\\\archives\\\\guild-scoped")
text = text.replace("saved_generations/archives/dm-unknown", "saved_generations/archives/guild-scoped")

# Wrap common archive response payload content values in redactor, if not already wrapped.
text = re.sub(
    r"(content:\s*)(`[^`]*(?:Image archive status|Archive is empty|Archived locally for this server|Archive scope checked|Archive scope:)[^`]*`)",
    r"\1seekdeepRedactArchivePathForDiscord(\2)",
    text,
    flags=re.DOTALL,
)
text = re.sub(
    r"(content:\s*)(['\"][^'\"]*(?:Image archive status|Archive is empty|Archived locally for this server|Archive scope checked|Archive scope:)[^'\"]*['\"])",
    r"\1seekdeepRedactArchivePathForDiscord(\2)",
    text,
    flags=re.DOTALL,
)

# ----------------------------------------------------------------------
# 5. Patch old archive dir helper if present and simple.
# ----------------------------------------------------------------------
for old_name in ["seekdeepArchiveDir", "seekdeepGetArchiveDir"]:
    fn, start, end = get_named_function(text, old_name)
    if start >= 0 and "seekdeepArchiveDirForTarget" not in fn:
        brace = fn.find("{")
        header = fn[:brace]
        if "target" not in header:
            header = re.sub(r"\(([^)]*)\)", lambda m: "(" + (m.group(1).strip() + ", target = null" if m.group(1).strip() else "target = null") + ")", header, count=1)
        new_fn = header + r"""{
  return seekdeepArchiveDirForTarget(target);
}"""
        text = text[:start] + new_fn + text[end:]

# ----------------------------------------------------------------------
# 6. Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepGuildArchiveScopeFromTarget", "scope helper"),
    ("function seekdeepSanitizeArchiveScopeKey", "sanitize helper"),
    ("function seekdeepArchiveScopeLabel", "scope label helper"),
    ("function seekdeepArchiveDirForTarget", "dir helper"),
    ("function seekdeepRedactArchivePathForDiscord", "path redactor"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive scope/path privacy v2.")