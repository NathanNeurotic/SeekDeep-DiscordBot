"""SeekDeep local model cache utility.

Warms (downloads) Hugging Face models referenced by the SeekDeep configuration and
provides safe audit / quarantine / purge tools so the SSD model cache can be cleaned
up without deleting models that are still in use.

Default behaviour (no arguments) keeps the original warmup script semantics: download
or cache-check every configured active model (chat default + fallback + quality +
reasoning, vision, image).

Hugging Face cache layout (per ``huggingface_hub``):

    <cache_dir>/models--<org>--<repo>/
        blobs/
        refs/
        snapshots/

This script only ever touches folders shaped like ``models--*`` inside the configured
cache. It never deletes anything outside ``models/_quarantine/``.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable

from dotenv import load_dotenv
from huggingface_hub import snapshot_download

load_dotenv()

ROOT = Path(__file__).resolve().parent

# Resolve the SSD cache location the FastAPI server uses.
CACHE_DIR = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not CACHE_DIR.is_absolute():
    CACHE_DIR = ROOT / CACHE_DIR
CACHE_DIR.mkdir(parents=True, exist_ok=True)

QUARANTINE_ROOT = ROOT / "models" / "_quarantine"

HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None


# ---------------------------------------------------------------------------
# Model role / repo resolution
# ---------------------------------------------------------------------------

def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def _chat_role_repos() -> list[tuple[str, str, str, bool]]:
    """Return list of (role, repo_id, env_var, required) for chat roles."""
    default_id = _env("LOCAL_CHAT_MODEL_ID") or "Qwen/Qwen3-8B"
    roles = [
        ("default_chat", default_id, "LOCAL_CHAT_MODEL_ID", True),
        ("fallback_chat", _env("LOCAL_CHAT_FALLBACK_MODEL_ID"), "LOCAL_CHAT_FALLBACK_MODEL_ID", False),
        ("quality_text", _env("LOCAL_CHAT_QUALITY_MODEL_ID"), "LOCAL_CHAT_QUALITY_MODEL_ID", False),
        ("reasoning_code", _env("LOCAL_CHAT_REASONING_MODEL_ID"), "LOCAL_CHAT_REASONING_MODEL_ID", False),
        ("lightweight_chat", _env("LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID"), "LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID", False),
    ]
    return roles


def _active_repo_ids(include_optional: bool, skip_image: bool, skip_vision: bool, chat_only: bool) -> list[tuple[str, str, str, bool]]:
    """Return the active list of (role, repo_id, env_var, required) tuples to warm.

    ``lightweight_chat`` is only included when ``include_optional`` is True.
    ``LOCAL_VISION_MODEL_ID`` / ``LOCAL_IMAGE_MODEL_ID`` are only included when not
    explicitly skipped and ``chat_only`` is False.
    """
    items: list[tuple[str, str, str, bool]] = []
    for role, repo, var, required in _chat_role_repos():
        if role == "lightweight_chat" and not include_optional:
            continue
        if not repo:
            # Unconfigured optional roles are silently skipped at warmup, but listed below.
            continue
        items.append((role, repo, var, required))

    if not chat_only:
        if not skip_vision:
            vision_repo = _env("LOCAL_VISION_MODEL_ID")
            if vision_repo:
                items.append(("vision", vision_repo, "LOCAL_VISION_MODEL_ID", True))
        if not skip_image:
            image_repo = _env("LOCAL_IMAGE_MODEL_ID")
            if image_repo:
                items.append(("image", image_repo, "LOCAL_IMAGE_MODEL_ID", True))
    return items


def configured_active_repo_ids() -> set[str]:
    """Every repo ID that the current ``.env`` references as active (any role / vision / image).

    Always includes lightweight_chat when set, regardless of warmup flags, so it is never
    treated as unused by audit/prune.
    """
    repos: set[str] = set()
    for _role, repo, _var, _required in _chat_role_repos():
        if repo:
            repos.add(repo)
    for env_name in ("LOCAL_VISION_MODEL_ID", "LOCAL_IMAGE_MODEL_ID"):
        repo = _env(env_name)
        if repo:
            repos.add(repo)
    return repos


# ---------------------------------------------------------------------------
# Hugging Face cache folder helpers
# ---------------------------------------------------------------------------

def _repo_to_cache_folder(repo_id: str) -> str:
    """Convert ``org/name`` to the Hugging Face cache directory name ``models--org--name``."""
    return "models--" + repo_id.replace("/", "--")


def _cache_folder_to_repo(folder_name: str) -> str | None:
    """Reverse ``models--org--name`` -> ``org/name``. Returns None if it does not match."""
    if not folder_name.startswith("models--"):
        return None
    remainder = folder_name[len("models--"):]
    parts = remainder.split("--")
    if len(parts) < 2:
        return None
    # Re-join everything after the org with '--' in case the repo name had hyphens originally,
    # then convert only the first '--' separator back into '/'.
    org = parts[0]
    name = "--".join(parts[1:])
    if not org or not name:
        return None
    return f"{org}/{name}"


def _cached_model_folders(cache_dir: Path) -> list[Path]:
    if not cache_dir.exists():
        return []
    return sorted(p for p in cache_dir.iterdir() if p.is_dir() and p.name.startswith("models--"))


def _folder_size_mb(path: Path) -> float:
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for fn in files:
                fp = Path(root) / fn
                try:
                    total += fp.stat().st_size
                except (FileNotFoundError, PermissionError):
                    continue
    except (FileNotFoundError, PermissionError):
        return 0.0
    return total / (1024 * 1024)


# ---------------------------------------------------------------------------
# Warmup
# ---------------------------------------------------------------------------

def warm_models(items: list[tuple[str, str, str, bool]]) -> int:
    """Snapshot-download every entry. Returns nonzero exit code if a required entry failed."""
    failures_required = 0
    print("==========================================")
    print("SeekDeep model cache warmup")
    print("==========================================")
    print(f"[SeekDeep] Hugging Face cache: {CACHE_DIR}")
    print()
    if not items:
        print("[SeekDeep] No models to warm with current flags.")
        return 0
    for role, repo, env_var, required in items:
        tag = "required" if required else "optional"
        # Optional per-model pinning: <ENV_VAR>_REVISION pins to a commit SHA, tag, or branch.
        # Example: LOCAL_CHAT_MODEL_ID_REVISION=8a5f2c0
        revision_env = f"{env_var}_REVISION"
        revision = (os.getenv(revision_env) or "").strip() or None
        rev_label = f" rev={revision}" if revision else ""
        print(f"[SeekDeep] role={role:<16} repo={repo:<55} ({tag}, env={env_var}){rev_label}")
        try:
            snapshot_download(
                repo_id=repo,
                cache_dir=str(CACHE_DIR),
                token=HF_TOKEN,
                resume_download=True,
                revision=revision,
            )
            print(f"           cached/downloaded OK")
        except Exception as exc:  # noqa: BLE001
            print(f"           FAILED: {exc}")
            print("           Hint: check HF_TOKEN, accept the model's terms on Hugging Face if it is gated, then rerun warmup.")
            if revision:
                print(f"           Note: pinned to revision={revision} via {revision_env}. Unset that env var to take latest.")
            if required:
                failures_required += 1
        print()
    if failures_required:
        print(f"[SeekDeep] Warmup completed with {failures_required} required failure(s).")
        return 1
    print("[SeekDeep] Cache warmup complete.")
    return 0


# ---------------------------------------------------------------------------
# Audit / prune / purge
# ---------------------------------------------------------------------------

def audit_cache(show_unused: bool, include_optional: bool) -> int:
    """Print a human-readable audit of cached vs configured repos. Never deletes."""
    active_repos = configured_active_repo_ids()
    cached_folders = _cached_model_folders(CACHE_DIR)

    cached_repo_to_folder: dict[str, Path] = {}
    unrecognised_folders: list[Path] = []
    for folder in cached_folders:
        repo = _cache_folder_to_repo(folder.name)
        if repo:
            cached_repo_to_folder[repo] = folder
        else:
            unrecognised_folders.append(folder)

    kept_used: list[tuple[str, Path, float]] = []
    unused: list[tuple[str, Path, float]] = []
    for repo, folder in cached_repo_to_folder.items():
        size_mb = _folder_size_mb(folder)
        if repo in active_repos:
            kept_used.append((repo, folder, size_mb))
        else:
            unused.append((repo, folder, size_mb))

    print("==========================================")
    print("SeekDeep model cache audit")
    print("==========================================")
    print(f"[SeekDeep] cache_dir: {CACHE_DIR}")
    print()

    print("Configured active models (from .env):")
    if not active_repos:
        print("  (none configured)")
    else:
        for role, repo, env_var, _required in _chat_role_repos():
            label = repo or "(unset)"
            if role == "lightweight_chat" and not repo and not include_optional:
                label = "(unset, optional)"
            cached_flag = "cached" if repo and repo in cached_repo_to_folder else ("not cached" if repo else "not configured")
            print(f"  role={role:<16} env={env_var:<35} repo={label:<55} {cached_flag}")
        for env_name, role_name in (("LOCAL_VISION_MODEL_ID", "vision"), ("LOCAL_IMAGE_MODEL_ID", "image")):
            repo = _env(env_name)
            label = repo or "(unset)"
            cached_flag = "cached" if repo and repo in cached_repo_to_folder else ("not cached" if repo else "not configured")
            print(f"  role={role_name:<16} env={env_name:<35} repo={label:<55} {cached_flag}")
    print()

    print(f"Cached models still in use ({len(kept_used)}):")
    if not kept_used:
        print("  (none)")
    else:
        for repo, folder, size_mb in sorted(kept_used):
            print(f"  KEEP  {repo:<55}  {size_mb:>9.1f} MiB  {folder.name}")
    print()

    if show_unused or unused:
        print(f"Cached models that appear UNUSED ({len(unused)}):")
        if not unused:
            print("  (none)")
        else:
            for repo, folder, size_mb in sorted(unused):
                print(f"  UNUSED {repo:<55}  {size_mb:>9.1f} MiB  {folder.name}")
        print()

    if unrecognised_folders:
        print(f"Cache entries that could NOT be mapped to a Hugging Face repo ({len(unrecognised_folders)}):")
        print("  These will never be quarantined or purged by this script.")
        for folder in unrecognised_folders:
            print(f"  SKIP   {folder}")
        print()

    reclaimable = sum(size for _r, _f, size in unused)
    print(f"Total reclaimable if all UNUSED models are quarantined: {reclaimable:.1f} MiB")
    return 0


def _enumerate_unused() -> list[tuple[str, Path, float]]:
    active_repos = configured_active_repo_ids()
    unused: list[tuple[str, Path, float]] = []
    for folder in _cached_model_folders(CACHE_DIR):
        repo = _cache_folder_to_repo(folder.name)
        if not repo:
            # Never touch folders we cannot confidently map to a HF repo.
            continue
        if repo in active_repos:
            continue
        unused.append((repo, folder, _folder_size_mb(folder)))
    return unused


def prune_quarantine() -> int:
    """Move unused cached repo folders to ``models/_quarantine/YYYYMMDD-HHMMSS/``."""
    unused = _enumerate_unused()
    if not unused:
        print("[SeekDeep] No unused cached repos to quarantine.")
        return 0

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target_root = QUARANTINE_ROOT / stamp
    target_root.mkdir(parents=True, exist_ok=True)

    print("==========================================")
    print(f"SeekDeep model cache prune (quarantine -> {target_root})")
    print("==========================================")

    moved = 0
    for repo, folder, size_mb in unused:
        dest = target_root / folder.name
        try:
            shutil.move(str(folder), str(dest))
            print(f"  QUARANTINED  {repo:<55}  {size_mb:>9.1f} MiB  -> {dest}")
            moved += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  SKIP         {repo:<55}  reason: {exc}")

    print()
    print(f"[SeekDeep] Quarantined {moved} cached repo folder(s).")
    print("[SeekDeep] To permanently delete quarantined folders only:")
    print("           python warmup_local_cache.py --purge-quarantine")
    print("[SeekDeep] To restore a model, move its folder back into the cache directory.")
    return 0


def purge_quarantine() -> int:
    """Permanently delete folders inside ``models/_quarantine/``."""
    if not QUARANTINE_ROOT.exists():
        print(f"[SeekDeep] No quarantine directory at {QUARANTINE_ROOT}; nothing to purge.")
        return 0

    print("==========================================")
    print(f"SeekDeep model cache purge (deleting contents of {QUARANTINE_ROOT})")
    print("==========================================")

    deleted = 0
    for child in sorted(QUARANTINE_ROOT.iterdir()):
        # Only delete *inside* the quarantine root. Refuse to delete anything outside.
        try:
            child_resolved = child.resolve()
            quarantine_resolved = QUARANTINE_ROOT.resolve()
            if quarantine_resolved not in child_resolved.parents and child_resolved != quarantine_resolved:
                print(f"  SKIP (outside quarantine)  {child}")
                continue
        except Exception as exc:  # noqa: BLE001
            print(f"  SKIP (cannot resolve)  {child}: {exc}")
            continue

        try:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
            print(f"  DELETED  {child}")
            deleted += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  SKIP     {child}  reason: {exc}")

    print()
    print(f"[SeekDeep] Purged {deleted} quarantine entry/entries.")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Warm/audit/quarantine the SeekDeep local Hugging Face model cache.",
    )
    parser.add_argument("--include-optional", action="store_true", help="Also warm/list optional models (lightweight_chat).")
    parser.add_argument("--skip-image", action="store_true", help="Skip LOCAL_IMAGE_MODEL_ID warmup.")
    parser.add_argument("--skip-vision", action="store_true", help="Skip LOCAL_VISION_MODEL_ID warmup.")
    parser.add_argument("--chat-only", action="store_true", help="Only warm chat-role models.")
    parser.add_argument("--audit-cache", action="store_true", help="Audit cached vs configured models. Never deletes anything.")
    parser.add_argument("--show-unused", action="store_true", help="With --audit-cache, list cached models that are no longer configured.")
    parser.add_argument("--prune-unused", action="store_true", help="Move unused cached repos to quarantine (does not delete).")
    parser.add_argument("--quarantine", action="store_true", help="Required modifier for --prune-unused.")
    parser.add_argument("--purge-quarantine", action="store_true", help="Permanently delete folders already inside models/_quarantine/.")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)

    if args.purge_quarantine:
        return purge_quarantine()

    if args.prune_unused:
        if not args.quarantine:
            print("[SeekDeep] --prune-unused requires --quarantine (this script never permanently deletes by default).")
            print("           Example: python warmup_local_cache.py --prune-unused --quarantine")
            return 2
        return prune_quarantine()

    if args.audit_cache:
        return audit_cache(show_unused=args.show_unused, include_optional=args.include_optional)

    items = _active_repo_ids(
        include_optional=args.include_optional,
        skip_image=args.skip_image,
        skip_vision=args.skip_vision,
        chat_only=args.chat_only,
    )
    return warm_models(items)


if __name__ == "__main__":
    sys.exit(main())
