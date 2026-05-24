# SeekDeep Release Checklist

This document details the checklist of automated validations, smoke tests, quality reviews, and workspace verification required prior to finalizing any SeekDeep bot release or merge.

## 1. Syntax & Integrity Checks
Run basic syntax compilation checks to verify files are parseable:
- [ ] `node --check index.js`
- [ ] `node --check smoke_test.mjs`
- [ ] `node --check scripts/doctor.mjs`
- [ ] For Python changes: Run `python -m py_compile local_ai_server.py`

## 2. Automated Test Coverage
Verify all bot tests pass successfully:
- [ ] `npm test` (Runs `smoke_test.mjs` which validates helpers, routing, prompt cleaners, and formatting functions). Ensure 100% pass rate.

## 3. Environment & Configuration Verification
Verify system setup using setup diagnostics:
- [ ] `npm run doctor`
  - Required checks must pass (`[PASS]`).
  - Verify that optional warnings (`[WARN]`) for SearXNG or Local AI server are expected for the deployment target.

## 4. Security & Secrets Review
Avoid accidental credential leaks:
- [ ] Scan `.env` file to ensure no hardcoded production secrets are added.
- [ ] Run `git diff` to ensure no active keys, personal user IDs, or API tokens are staged or added to git history.
- [ ] Confirm `.env.example` has been updated with any new environment variables introduced in this release, using safe empty/placeholder values.
- [ ] Confirm that `keys.txt` or any key-like files are listed in `.gitignore` and are not tracked.

## 5. Documentation Review
Verify that user guides and lists are current:
- [ ] Check if `README.md` needs configuration or step adjustments.
- [ ] Verify `COMMANDS.md` matches active slash commands and mention commands.
- [ ] Ensure `AGENTS.md` is updated if any internal components or entry-point functions have been modified.

## 6. Fresh Clone & Setup Verification
Validate onboarding:
- [ ] Perform a clean clone into a separate temporary directory.
- [ ] Run `npm install` and verify it succeeds without peer dependency resolution issues.
- [ ] Copy `.env.example` to `.env` and verify `npm run doctor` detects missing credentials exactly as expected.

## 7. Versioning & Git Release
Follow clean version tag releases:
- [ ] Update version string in `package.json`.
- [ ] Commit all code changes.
- [ ] Create a git tag for the version release:
  ```bash
  git tag -a v10.X.X -m "Release version 10.X.X"
  ```
- [ ] Push the commits and tags to remote:
  ```bash
  git push origin main --tags
  ```
- [ ] Author release notes on GitHub describing:
  - Phase batch context
  - Features added
  - Fixed issues
  - Dependency changes
