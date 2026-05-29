# scripts/dev — manual / dev-only tooling

These scripts are **not** run by `npm run preflight` or any CI stage. They
are run by hand during development and release work, and exist here (rather
than in `scripts/`) so they don't imply automated coverage they don't
provide (audit DEAD-1).

| Script | What it does | Needs |
|---|---|---|
| `e2e_progress_events.py` | Probes the WS progress-event wiring (smoke/cache-prune/deps). | running AI server on :7865 |
| `e2e_self_update_events.py` | Probes self-update + dry-run-installer event wiring (renamed from the misleading `e2e_progress_events_v2.py`, audit DEAD-2). | running AI server |
| `e2e_control_center.py` | Probes Control Center endpoints end-to-end. | running AI server |
| `verify_e2e.py` | Drives chat/image/vision/status pipelines against a live server. | running AI server (GPU for chat/image) |
| `gen_installer_images.py` | Regenerates the WiX/NSIS banner + sidebar bitmaps. | Pillow |
| `backfill_release_smartscreen.sh` | One-off release-asset maintenance. | gh CLI |

For the automated browser-driven Control Center checks, see the Playwright
suite in `e2e/` + `npm run test:e2e` (audit §12) and the `gui-smoke`
preflight stage (`scripts/smoke_gui_endpoints.py`).
