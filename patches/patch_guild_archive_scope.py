from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_guild_archive_scope.py <index.js>")

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

def replace_named_function(source, name_or_signature, new_block):
    _, start, end = get_named_function(source, name_or_signature)
    if start < 0:
        fail(f"Could not locate function for replacement: {name_or_signature}")
    return source[:start] + new_block.rstrip() + source[end:]

require("client.on('interactionCreate'", "interaction handler")
require("seekdeepEnqueueImageJob(job, runner)", "image queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Insert central archive-scope helpers.
# ----------------------------------------------------------------------
helpers = r"""
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_START
function seekdeepGuildArchiveScopeFromTarget(target = null) {
  const guildId =
    target?.guild?.id ||
    target?.guildId ||
    target?.message?.guild?.id ||
    target?.message?.guildId ||
    target?.channel?.guild?.id ||
    target?.channel?.guildId ||
    target?.interaction?.guild?.id ||
    target?.interaction?.guildId ||
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
}

function seekdeepSanitizeArchiveScopeKey(scope = '') {
  return String(scope || 'unknown')
    .replace(/^guild:/, 'guild-')
    .replace(/^dm:/, 'dm-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function seekdeepArchiveScopedKey(target = null, key = '') {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  const cleanKey = String(key || 'default').replace(/^:+|:+$/g, '') || 'default';
  return `${scope}:${cleanKey}`;
}

function seekdeepArchiveUserScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `user:${uid}`);
}

function seekdeepArchiveThreadScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `thread:${uid}`);
}
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_END

"""

if "SEEKDEEP_ARCHIVE_GUILD_SCOPE_START" not in text:
    # Put this after response/footer helpers if possible, otherwise before first archive function.
    insert_pos = -1
    for anchor in [
        "function seekdeepImageActionRow",
        "function seekdeepArchive",
        "async function seekdeepArchive",
        "function archive",
        "async function archive",
        "client.on('interactionCreate'",
    ]:
        pos = text.find(anchor)
        if pos >= 0:
            insert_pos = pos
            break
    if insert_pos < 0:
        fail("Could not find insertion point for archive scope helpers.")
    text = text[:insert_pos] + helpers + "\n" + text[insert_pos:]

# ----------------------------------------------------------------------
# 2. Make archive button/message state keys guild-scoped where common patterns appear.
# ----------------------------------------------------------------------
# Common image action/archive state maps are usually keyed by actionId or message id.
# We scope only archive-related lookup keys, not regeneration keys.
replacements = [
    # Map get/set/delete for archive-specific maps if named that way.
    (r"(\bSEEKDEEP_ARCHIVE_[A-Z0-9_]*\.set\()\s*([^,\n]+)\s*,", r"\1seekdeepArchiveScopedKey(message || interaction || sentMessage || {}, \2),"),
    (r"(\bSEEKDEEP_ARCHIVE_[A-Z0-9_]*\.get\()\s*([^)]+)\)", r"\1seekdeepArchiveScopedKey(message || interaction || {}, \2))"),
    (r"(\bSEEKDEEP_ARCHIVE_[A-Z0-9_]*\.delete\()\s*([^)]+)\)", r"\1seekdeepArchiveScopedKey(message || interaction || {}, \2))"),
]
for pat, repl in replacements:
    text = re.sub(pat, repl, text)

# ----------------------------------------------------------------------
# 3. Patch known archive-thread helper functions if they exist.
# ----------------------------------------------------------------------
# If a function builds archive thread key from only a userId, replace with guild-scoped.
thread_key_candidates = [
    "seekdeepArchiveThreadKey",
    "seekdeepUserArchiveThreadKey",
    "seekdeepGetArchiveThreadKey",
    "archiveThreadKey",
]
for name in thread_key_candidates:
    fn, start, end = get_named_function(text, name)
    if start >= 0:
        # Make the function accept a target argument if it doesn't already.
        header_end = fn.find("{")
        header = fn[:header_end]
        if "target" not in header:
            header = re.sub(r"\(([^)]*)\)", lambda m: "(" + (m.group(1).strip() + ", target = null" if m.group(1).strip() else "target = null") + ")", header, count=1)
        body = """
{
  const maybeUserId = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveThreadScopedKey(target, maybeUserId);
}"""
        new_fn = header + body
        text = text[:start] + new_fn + text[end:]

# ----------------------------------------------------------------------
# 4. Patch archive directory/file path helpers if they exist.
# ----------------------------------------------------------------------
# Keep global base dir, but place actual archive files under per-guild / per-DM directory.
path_helper_candidates = [
    "seekdeepArchiveDir",
    "seekdeepGetArchiveDir",
    "seekdeepArchivePath",
    "seekdeepGetArchivePath",
    "seekdeepArchiveManifestPath",
]
for name in path_helper_candidates:
    fn, start, end = get_named_function(text, name)
    if start >= 0 and "seekdeepSanitizeArchiveScopeKey" not in fn:
        header_end = fn.find("{")
        header = fn[:header_end]
        # Do not risk rewriting very complex helpers. Add a scope-aware wrapper call if possible.
        if "target" not in header:
            header = re.sub(r"\(([^)]*)\)", lambda m: "(" + (m.group(1).strip() + ", target = null" if m.group(1).strip() else "target = null") + ")", header, count=1)
        body = r"""
{
  const scopeDir = seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(target));
  const base = path.join(__dirname, 'saved_generations', 'archives', scopeDir);
  fs.mkdirSync(base, { recursive: true });
  return base;
}"""
        # Only replace functions with "Dir" in name. Path helpers may need filenames, so skip those.
        if "Dir" in name:
            text = text[:start] + header + body + text[end:]

# ----------------------------------------------------------------------
# 5. Patch obvious saved_generations archive writes to include guild directory.
# ----------------------------------------------------------------------
# This preserves non-archive generation file behavior and only rewrites paths containing "archive".
text = re.sub(
    r"path\.join\(__dirname,\s*['\"]saved_generations['\"],\s*['\"]archive[s]?['\"]\)",
    "path.join(__dirname, 'saved_generations', 'archives', seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(message || interaction || {})))",
    text,
)

# ----------------------------------------------------------------------
# 6. Patch /archive command reads/writes if obvious user-only key is used.
# ----------------------------------------------------------------------
# Common forms:
#   const key = targetUser.id;
#   archiveMap.get(user.id)
# We only patch lines inside functions whose name contains Archive/archive.
def patch_archive_function_body(fn):
    # Avoid double patching.
    if "seekdeepArchiveUserScopedKey(" in fn or "seekdeepArchiveThreadScopedKey(" in fn:
        return fn

    # Replace very common user-only key variables.
    fn = re.sub(
        r"const\s+(\w*[Aa]rchive\w*[Kk]ey|\w*[Tt]hread\w*[Kk]ey|key)\s*=\s*(targetUser|user|member\.user|interaction\.user|message\.author)\.id\s*;",
        r"const \1 = seekdeepArchiveUserScopedKey(interaction || message || {}, \2.id);",
        fn,
    )
    fn = re.sub(
        r"let\s+(\w*[Aa]rchive\w*[Kk]ey|\w*[Tt]hread\w*[Kk]ey|key)\s*=\s*(targetUser|user|member\.user|interaction\.user|message\.author)\.id\s*;",
        r"let \1 = seekdeepArchiveUserScopedKey(interaction || message || {}, \2.id);",
        fn,
    )
    return fn

# Walk functions with Archive/archive in their signature and patch obvious local keys.
for m in list(re.finditer(r"(?:async\s+)?function\s+\w*[Aa]rchive\w*\s*\(", text)):
    sig_start = m.start()
    brace = text.find("{", sig_start)
    if brace < 0:
        continue
    end = find_matching_brace(text, brace) + 1
    fn = text[sig_start:end]
    patched = patch_archive_function_body(fn)
    if patched != fn:
        text = text[:sig_start] + patched + text[end:]

# ----------------------------------------------------------------------
# 7. Add a startup warning if old global archive paths/maps probably exist.
# ----------------------------------------------------------------------
if "SEEKDEEP_ARCHIVE_GUILD_SCOPE_MIGRATION_NOTE" not in text:
    note = r"""
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_MIGRATION_NOTE
// Archive state is now guild-scoped for new writes.
// Old global archive entries are intentionally left untouched so nothing is destroyed.
// If you need migration, copy old records into the relevant guild:<guildId> scope manually.
// SEEKDEEP_ARCHIVE_GUILD_SCOPE_MIGRATION_NOTE_END

"""
    pos = text.find("client.on('interactionCreate'")
    text = text[:pos] + note + text[pos:]

# ----------------------------------------------------------------------
# Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepGuildArchiveScopeFromTarget", "archive guild scope helper"),
    ("function seekdeepArchiveScopedKey", "archive scoped key helper"),
    ("function seekdeepArchiveUserScopedKey", "archive user scoped key helper"),
    ("function seekdeepArchiveThreadScopedKey", "archive thread scoped key helper"),
    ("guild:", "guild scope prefix"),
    ("dm:", "dm scope prefix"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched guild-scoped archive helper layer and common archive key/path patterns.")