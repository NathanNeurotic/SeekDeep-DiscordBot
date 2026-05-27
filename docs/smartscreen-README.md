# SmartScreen screenshots

This folder holds the two SmartScreen "Windows protected your PC" screenshots
that every README + GitHub release embeds. They're referenced from:

- `README.md` (the "Windows protected your PC — what to do" section)
- `.github/workflows/tauri-release.yml` (the release body template)
- `scripts/backfill_release_smartscreen.sh` (past-release backfill)

## Expected filenames

| File | Shows |
|---|---|
| `smartscreen-1-more-info.png` | First dialog with the **More info** link circled |
| `smartscreen-2-run-anyway.png` | Second dialog with the **Run anyway** button circled |

Drop the two PNGs at exactly those paths (relative to repo root: `docs/`),
`git add` them, and the README + every future release picks them up
automatically. To backfill past releases, run:

```bash
bash scripts/backfill_release_smartscreen.sh
```
