#!/usr/bin/env bash
# Update every existing GitHub release's body to include the SmartScreen
# screenshot instructions. Idempotent — re-running is safe; releases that
# already contain the marker block are left alone.
#
# Run from the repo root:
#   bash scripts/backfill_release_smartscreen.sh
#
# Requires: gh CLI authenticated against NathanNeurotic/SeekDeep-DiscordBot.

set -euo pipefail

REPO="NathanNeurotic/SeekDeep-DiscordBot"
MARKER='SmartScreen step 1: click "More info"'  # presence = already updated

# The block we splice in. Lives under a stable H3 so subsequent edits can
# find + replace cleanly. Matches the prose used in README.md.
read -r -d '' BLOCK <<'EOF' || true

### "Windows protected your PC" — what to do

When you run the `.msi` or `.exe`, Windows shows the SmartScreen warning. This is expected for any installer whose publisher isn't on Microsoft's reputation list (signing certs cost $300–$700/year and SeekDeep ships unsigned). The app is safe — every build is from a public commit on GitHub Actions.

**To run it — exactly two clicks:**

**Step 1.** Click the **"More info"** link below the body text:

![SmartScreen step 1: click "More info"](https://raw.githubusercontent.com/NathanNeurotic/SeekDeep-DiscordBot/main/docs/smartscreen-1-more-info.png)

**Step 2.** A **"Run anyway"** button appears at the bottom-right. Click it:

![SmartScreen step 2: click "Run anyway"](https://raw.githubusercontent.com/NathanNeurotic/SeekDeep-DiscordBot/main/docs/smartscreen-2-run-anyway.png)

SmartScreen remembers your choice for that file — you won't be prompted again for the same installer.

**macOS:** same story — right-click the app in Applications → **Open** → **Open** again.

---

EOF

# Enumerate every release (including prereleases + drafts; gh defaults to non-drafts).
tags=$(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName')

updated=0
skipped=0
for tag in $tags; do
  body=$(gh release view "$tag" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")
  if echo "$body" | grep -qF "$MARKER"; then
    echo "  [skip]   $tag  (already has SmartScreen block)"
    skipped=$((skipped+1))
    continue
  fi
  # Prepend the block above the existing body so the instructions are visible
  # without scrolling, then keep the original body underneath.
  new_body="${BLOCK}${body}"
  echo "  [update] $tag"
  printf '%s' "$new_body" | gh release edit "$tag" --repo "$REPO" --notes-file -
  updated=$((updated+1))
done

echo
echo "Done. updated=$updated  skipped=$skipped"
