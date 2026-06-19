"""
gui_endpoints.py · SeekDeep GUI backend endpoints
==================================================

Drop-in module that registers the write endpoints the SeekDeep GUI expects:

    POST /config                    - merge .env updates
    GET  /logs/tail?lines=N         - tail the seekdeep log file
    GET  /logs/stream               - SSE stream of new log lines
    POST /launcher/{svc}/{action}   - start/stop/restart a managed process
    GET  /data/{file}               - read a data/*.json file
    POST /model/warm                - force-load a role's model

USAGE - add 3 lines to local_ai_server.py:

    from gui_endpoints import register_gui_endpoints
    register_gui_endpoints(app, log_dir="logs", data_dir="data", env_path=".env")

That's it. Restart the server and the Control Center Save / Logs / Launcher /
Stats panes all light up.

SECURITY - these endpoints accept HTTP input that can write files and spawn
processes. Bind the server to 127.0.0.1 ONLY. Do not expose port 7865 publicly
without an authenticating reverse proxy in front.
"""

from __future__ import annotations
import os
import re
import sys
import json
import time
import secrets
import asyncio
import socket
import subprocess as _real_subprocess
import shutil
import threading
import io
import zipfile

# Subprocess shim: shadows `subprocess` so every run/Popen in this file gets
# creationflags=CREATE_NO_WINDOW on Windows — no terminal flashes per probe.
class _SubprocessShim:
    _NW = getattr(_real_subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    PIPE = _real_subprocess.PIPE
    STDOUT = _real_subprocess.STDOUT
    DEVNULL = _real_subprocess.DEVNULL
    TimeoutExpired = _real_subprocess.TimeoutExpired
    CalledProcessError = _real_subprocess.CalledProcessError
    SubprocessError = _real_subprocess.SubprocessError
    CREATE_NEW_PROCESS_GROUP = getattr(_real_subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    CREATE_NO_WINDOW = _NW
    Popen = staticmethod(_real_subprocess.Popen)  # rebound below to wrap
    @staticmethod
    def run(*args, **kwargs):
        if os.name == "nt" and "creationflags" not in kwargs:
            kwargs["creationflags"] = _SubprocessShim._NW
        return _real_subprocess.run(*args, **kwargs)
def _Popen_hidden(*args, **kwargs):
    if os.name == "nt" and "creationflags" not in kwargs:
        kwargs["creationflags"] = _SubprocessShim._NW
    return _real_subprocess.Popen(*args, **kwargs)
_SubprocessShim.Popen = staticmethod(_Popen_hidden)
subprocess = _SubprocessShim()  # module-local rebinding — only THIS file uses the shim
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from fastapi import FastAPI, HTTPException, Header, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field


def _now_iso() -> str:
    """ISO-8601 UTC timestamp ending in 'Z'. Matches what writeJsonAtomic in
    the bot produces via `new Date().toISOString()` so a row updated via
    GUI looks identical to one updated via Discord command."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
           f"{int(datetime.now(timezone.utc).microsecond / 1000):03d}Z"


# ====================================================================
# REQUEST MODELS
# ====================================================================

class ConfigPatch(BaseModel):
    updates: dict  # { "KEY": "value", ... }


class WarmRequest(BaseModel):
    role: str = "default_chat"


class EventPayload(BaseModel):
    """Body of POST /events/emit. `type` is the event topic (e.g. 'model.loaded',
    'vram.sample'); `data` is an arbitrary JSON object the consumer interprets."""
    type: str
    data: dict[str, Any] = Field(default_factory=dict)  # AUD-019 — Field over mutable {}


class BotCommandBody(BaseModel):
    """Body of POST /bot/command. `action` selects a whitelisted bot command,
    `args` is an arbitrary JSON object the bot's dispatcher interprets, and
    `timeout` bounds how long Python waits for the bot's correlated reply."""
    action: str
    args: dict[str, Any] = Field(default_factory=dict)
    timeout: float | None = None


class FactBody(BaseModel):
    """Body for POST /memory/user/{id}/fact and PATCH /memory/user/{id}/fact/{n}."""
    text: str


class PresetsBody(BaseModel):
    """Body for POST /memory/presets/{id}. Mirrors SEEKDEEP_KNOWN_PRESETS from index.js."""
    presets: list[str] = []


class ArchiveConfigPatch(BaseModel):
    """Body for POST /archive/config. updates: { mode?, notify_self?, channels? }.
    Module-level (not nested in register_gui_endpoints) because Pydantic v2 + FastAPI
    treat closure-scoped BaseModel classes as query params, not request bodies."""
    updates: dict


class DepsInstallBody(BaseModel):
    """Body for POST /deps/install. requirements_file defaults to the heavy
    ML stack; the only other valid value is requirements-local.txt. See
    ArchiveConfigPatch above for why this is module-level (FastAPI + Pydantic
    v2 treat closure-scoped BaseModels as query params, not request bodies)."""
    requirements_file: str = "requirements-ml.txt"


class PersonaPatch(BaseModel):
    """Body for POST /persona. Schema:
        { scope: 'channel'|'server'|'global', persona: 'neurotic'|'unsettling'|'clinical'|'chaotic' }
        { scope: 'channel'|'server'|'global', action: 'reset' }
    For 'channel' / 'server' scopes the request must include channel_id / guild_id.
    The web playground (single-user-owner, no Discord context) always uses scope='global'."""
    scope: str = "global"
    persona: str | None = None
    action: str | None = None
    channel_id: str | None = None
    guild_id: str | None = None


class CustomPersonaPatch(BaseModel):
    """Body for POST /personas (create / update a custom persona). Module-level
    for the same reason as PersonaPatch — FastAPI + Pydantic v2 treat a
    closure-scoped BaseModel as a bag of query params, not a JSON body.

    Validation mirrors index.js's `persona create` handler so the GUI write
    path and the Discord command reject exactly the same things and stay in
    agreement on data/custom-personas.json:
      slug  → ^[a-z0-9_-]{2,32}$, not a built-in, not a reserved keyword
      tone  → 2..2000 chars (the personality line injected into the prompt)."""
    slug: str = ""
    tone: str = ""


# Constants mirror index.js. If you bump the bot-side env vars, mirror here too;
# the bot remains source of truth -- these are just the validation ceilings on
# the GUI write path so we don't silently accept facts the bot would reject.
_MEMORY_FACTS_MAX = max(5, min(200, int(os.getenv("SEEKDEEP_USER_FACTS_MAX", "25"))))
_MEMORY_FACT_MAX_CHARS = max(40, min(2000, int(os.getenv("SEEKDEEP_USER_FACT_MAX_CHARS", "500"))))
_MEMORY_KNOWN_PRESETS = {
    "brief", "expert", "no-emoji", "no-followup-questions", "formal", "casual",
}


# ====================================================================
# EVENT BUS (WebSocket pub/sub)
# ====================================================================
# Single in-process broadcaster. Producers call `await bus.publish({...})`,
# every connected websocket gets the event as a JSON message. Dead connections
# are pruned lazily.
#
# Why module-level singleton: register_gui_endpoints can be called more than
# once during tests / hot-reload, but we want a single subscriber set so events
# fan out to ALL live connections regardless of which app instance produced them.

class _EventBus:
    def __init__(self) -> None:
        self._subscribers: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        # Reference to the event loop the FastAPI app runs on. Captured at
        # startup so publish_sync() can schedule from sync code (e.g. the
        # model loaders in local_ai_server.py that aren't async).
        self._loop: asyncio.AbstractEventLoop | None = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Called once at server startup. Enables publish_sync()."""
        self._loop = loop

    async def subscribe(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subscribers.add(ws)

    async def unsubscribe(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subscribers.discard(ws)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def publish(self, event: dict[str, Any]) -> int:
        """Broadcast `event` to every subscriber. Returns the number of
        successful sends. Auto-prunes any subscriber whose send raised."""
        # Stamp with server ms if caller didn't provide ts
        event.setdefault("ts", int(time.time() * 1000))
        async with self._lock:
            targets = list(self._subscribers)
        if not targets:
            return 0
        sent = 0
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(event)
                sent += 1
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._subscribers.discard(ws)
        return sent

    async def publish_to(self, targets, event: dict[str, Any]) -> int:
        """Send `event` ONLY to the given subscriber sockets (must already be
        subscribed). Used for directed frames -- notably `bot.command`, which
        must reach the bot command-bridge and NOT every browser tab on the bus
        (a tab that never sees the frame can't learn its correlation id to forge
        a reply). Returns successful sends; prunes any dead socket."""
        event.setdefault("ts", int(time.time() * 1000))
        async with self._lock:
            live = [ws for ws in targets if ws in self._subscribers]
        if not live:
            return 0
        sent = 0
        dead: list[WebSocket] = []
        for ws in live:
            try:
                await ws.send_json(event)
                sent += 1
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._subscribers.discard(ws)
        return sent

    def publish_sync(self, event: dict[str, Any]) -> None:
        """Schedule a publish from sync code. Safe to call from anywhere --
        a sync FastAPI handler, a threadpool worker, a load_chat_model()
        completion site. No-op if the loop hasn't been attached yet (e.g.
        during module import) or isn't running."""
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        # Cheap fast-path: skip the dispatch entirely if nothing is listening.
        if not self._subscribers:
            return
        try:
            asyncio.run_coroutine_threadsafe(self.publish(event), loop)
        except Exception:
            # Don't let event publishing crash the caller (model loaders etc.)
            pass


# Module-level singleton. Importable from local_ai_server.py so producers can
# call `from gui_endpoints import event_bus` and `await event_bus.publish(...)`.
event_bus = _EventBus()


# ---- Bot command-bridge: correlation registry --------------------------------
# POST /bot/command parks an asyncio.Future here keyed by a correlation id and
# publishes a `bot.command` event; the bot (a WS client on /events) runs the
# command and sends back a `bot.command.result` frame, which the /events
# receive-loop routes to _resolve_bot_command() to complete the Future.
# Module-level so it survives the idempotent re-registration of the route table.
_bot_command_pending = {}  # cid -> asyncio.Future
_bot_bridge_sockets = set()  # WebSockets that announced themselves as the bot (bot.bridge.hello)

def _bot_bridge_online() -> bool:
    return len(_bot_bridge_sockets) > 0

def _resolve_bot_command(cid, payload):
    if not cid:
        return
    fut = _bot_command_pending.get(cid)
    if fut is not None and not fut.done():
        try:
            fut.set_result(payload or {})
        except Exception:
            pass


# Whitelist of services the launcher endpoint may control.
ALLOWED_SERVICES = {"ai-server", "bot", "searxng"}
ALLOWED_ACTIONS  = {"start", "stop", "restart", "status"}

# Services we refuse to start/stop/restart from inside the AI server itself.
# (Killing the AI server from within an AI-server HTTP request would terminate
# the request handler; spawning a duplicate would just fail to bind port 7865.)
SELF_HOSTED_SERVICES = {"ai-server"}

# Per-process state for processes we spawned ourselves. External processes
# (e.g. ones started by seekdeep_launcher.bat) are detected via PID files.
_PROCESSES: dict[str, subprocess.Popen] = {}

# PID-file locations written by seekdeep_launcher.bat
_PID_FILE_NAMES = {
    "ai-server": "local-ai.pid",
    "bot":       "bot.pid",
    # searxng has no PID file; we treat "missing PID file" as "unknown" for it
}

# ============================================================================
# LIFECYCLE STATE TRUTH SOURCE
# ============================================================================
# Single source of truth for "is service X running, and how many instances".
# Status pills + launcher cards + firstrun checks ALL read from here. The
# fragmented detection (Popen handle vs PID file vs port probe) is preserved
# inside _service_state() with a deterministic precedence, but callers see
# one stable shape: {state, pid, count, source, transitioning, last_change}.
#
# Why this exists: status pills used to lie for up to ~5s because the 4
# detection paths disagreed and the polling cadence was the only correction
# mechanism. Now state changes publish to event_bus immediately, so pills
# update on the WS bus the moment the backend notices, not on the next poll.

# Services currently mid-action (start/stop/restart/kill-all). Reads as
# "transitioning" until the action returns. Prevents the red-flash-during-
# restart UX where stop emits "not-running" before start emits "running".
_TRANSITIONING: set[str] = set()
_TRANSITIONING_LOCK = threading.Lock()

# AUD-001: serialize /system/self-update. Two concurrent clicks could stage and
# commit executable code over the live tree at the same time. Non-blocking
# acquire -> 409 when an update is already running.
_SELF_UPDATE_LOCK = threading.Lock()

# AUD-001: bounded reads for the self-updater so a hostile/garbled GitHub/CDN
# response can't exhaust memory mid-update. Per-source-file vs API-listing caps.
_SELF_UPDATE_MAX_FILE_BYTES = int(os.environ.get("SEEKDEEP_SELF_UPDATE_MAX_FILE_BYTES", str(25 * 1024 * 1024)))
_SELF_UPDATE_MAX_API_BYTES = int(os.environ.get("SEEKDEEP_SELF_UPDATE_MAX_API_BYTES", str(8 * 1024 * 1024)))
# Defense-in-depth: cap how many files a single subtree listing may enqueue, so a
# malformed/compromised contents-API response can't fan out into thousands of
# fetches. Today gui/ holds ~90 files and scripts/ ~15; keep this comfortably
# above the real tree size so a legitimate update never gets silently truncated.
_SELF_UPDATE_MAX_TREE_ENTRIES = int(os.environ.get("SEEKDEEP_SELF_UPDATE_MAX_TREE_ENTRIES", "200"))

# AUD-001: ref allowlist. Strict (default) accepts only an immutable release tag
# (vMAJOR.MINOR.PATCH[-pre]) or a full 40-char commit SHA — NOT mutable `main`
# or an over-broad `v*` prefix. The self-updater writes executable code over the
# running install, so the default refuses anything that can move under it.
_SELF_UPDATE_SEMVER_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")
_SELF_UPDATE_FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_SELF_UPDATE_SHORT_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")

# Rolling release channels. The latest code ships on `main` + a `nightly` rolling
# pre-release, NOT as fresh vMAJOR.MINOR.PATCH tags (the newest numbered release
# can be OLDER than the running build, so "update to the latest tag" would be a
# downgrade). The strict policy refuses those mutable channel names, so
# self-update always failed for the rolling workflow. Fix: resolve a known
# rolling channel to its CURRENT commit SHA in our repo BEFORE the policy check —
# a 40-char SHA is immutable (strict accepts it), the audit log records the exact
# commit installed, and the hardcoded repo guarantees it is still only OUR code.
# Only this small allowlist of channels is resolved; arbitrary branch names are not.
_SELF_UPDATE_REPO = "NathanNeurotic/SeekDeep-DiscordBot"
_SELF_UPDATE_ROLLING_REFS = {"main", "nightly"}

# GET /changelog/commits proxy cache. The GUI's CSP connect-src is loopback-only,
# so the changelog page can't hit api.github.com directly — the server fetches it
# (fixed repo URL, no user input → no SSRF) and caches the trimmed result. TTL
# keeps us well under GitHub's unauthenticated 60 req/hr cap; a GITHUB_TOKEN (if
# set) raises that ceiling. Module-level so it survives across requests.
_CHANGELOG_COMMITS_CACHE: dict = {"at": 0.0, "iso": "", "data": None}
_CHANGELOG_COMMITS_TTL_S = float(os.environ.get("SEEKDEEP_CHANGELOG_COMMITS_TTL_S", "300") or 300)
_CHANGELOG_COMMITS_MAX_BYTES = 512 * 1024  # ~30 commits of GitHub JSON is well under this


def _resolve_self_update_ref(ref: str) -> tuple[str, str]:
    """Resolve a rolling channel (main/nightly) to its 40-char commit SHA via the
    GitHub commits API. Returns (resolved_ref, note); a non-rolling ref (a release
    tag or an explicit SHA) passes through unchanged with an empty note. Raises on
    a network/garbled failure so the caller surfaces a clear error instead of
    silently falling back to a refused mutable ref."""
    rl = (ref or "").strip().lower()
    if rl not in _SELF_UPDATE_ROLLING_REFS:
        return (ref or "").strip(), ""
    # rl is now exactly "main" or "nightly". Select the channel as a LITERAL rather
    # than interpolating the request-derived string into the URL: the URL is then
    # provably constant (fixed host + fixed path), which is both genuinely safe and
    # clears CodeQL py/partial-ssrf (set-membership isn't treated as sanitization).
    channel = "nightly" if rl == "nightly" else "main"
    import urllib.request
    url = "https://api.github.com/repos/" + _SELF_UPDATE_REPO + "/commits/" + channel
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github.sha",  # asks GitHub for the bare 40-char SHA
        "User-Agent": "SeekDeep-self-update",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 — fixed https GitHub host
        sha = resp.read(64).decode("ascii", "replace").strip()
    if not _SELF_UPDATE_FULL_SHA_RE.match(sha):
        raise ValueError(f"GitHub did not return a commit SHA for {channel!r}")
    return sha, f"rolling channel {channel!r} pinned to commit {sha[:12]}"


def _self_update_ref_is_allowed(ref: str) -> tuple[bool, str]:
    """Return (allowed, reason). Policy is read from env at call time:

      SEEKDEEP_SELF_UPDATE_REF_POLICY = strict (default) | loose
        strict: a 'vMAJOR.MINOR.PATCH[-pre]' tag, or a full 40-char SHA.
                'main' allowed only if SEEKDEEP_SELF_UPDATE_ALLOW_MAIN=on.
        loose : additionally accepts 'main' and 7-40 char short SHAs.
    """
    ref = (ref or "").strip()
    policy = str(os.environ.get("SEEKDEEP_SELF_UPDATE_REF_POLICY", "strict")).strip().lower()
    loose = policy in ("loose", "dev", "any")
    allow_main = loose or str(os.environ.get("SEEKDEEP_SELF_UPDATE_ALLOW_MAIN", "")).strip().lower() in ("1", "true", "yes", "on")
    if not ref:
        return False, "ref is empty"
    if ref == "main":
        if allow_main:
            return True, ""
        return False, ("ref 'main' is refused by the strict self-update policy; pass a 'vMAJOR.MINOR.PATCH' "
                       "tag or a 40-char commit SHA, or set SEEKDEEP_SELF_UPDATE_ALLOW_MAIN=on")
    if _SELF_UPDATE_SEMVER_TAG_RE.match(ref):
        return True, ""
    if _SELF_UPDATE_FULL_SHA_RE.match(ref):
        return True, ""
    if loose and _SELF_UPDATE_SHORT_SHA_RE.match(ref):
        return True, ""
    return False, ("ref must be a 'vMAJOR.MINOR.PATCH' release tag or a 40-char commit SHA "
                   "(set SEEKDEEP_SELF_UPDATE_REF_POLICY=loose to also allow 'main' and short SHAs)")

# Last-known state per service, so we can detect transitions and emit
# `service.state.changed` events. Keyed by service name; value is the
# previous dict returned by _service_state() (sans transitioning flag).
_LAST_SERVICE_STATE: dict[str, dict] = {}

# Loopback IPs that may fetch GET /token. Anything else gets 403.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
# Origins we'll accept from browser callers. Loopback variants for the FastAPI-
# served GUI; tauri.localhost (Windows) + tauri://localhost (macOS/Linux) for
# the Tauri 2 shell. A drive-by malicious site at https://evil.com sends
# Origin: https://evil.com, fails this check, gets 403 — even though its TCP
# connection still appears as 127.0.0.1 (the browser is the loopback peer).
TRUSTED_BROWSER_ORIGINS = (
    "http://127.0.0.1:7865",
    "http://localhost:7865",
    "http://tauri.localhost",
    "tauri://localhost",
    "https://tauri.localhost",
)


# ====================================================================
# TOKEN AUTH
# ====================================================================
# The three write endpoints (/config, /launcher/*, /model/warm) can rewrite
# .env and spawn / kill processes. Without auth, anything that can reach
# port 7865 -- including code running on the same box, browser extensions,
# or callers via a proxy you forgot was up -- can wipe your bot.
#
# Model: a single shared token, generated on first server boot and stored
# in .env as SEEKDEEP_GUI_TOKEN. The GUI fetches it via GET /token (which
# only answers loopback callers) and includes it as X-SeekDeep-Token on
# every write request. Read endpoints (/health, /gpu, /data/*, /logs/*,
# /config/status) stay open so the page can render without the token.
#
# To rotate: edit .env, restart the server. To disable for trusted local
# dev only: set SEEKDEEP_GUI_TOKEN_DISABLED=1 in .env.

_TOKEN_HEADER = "X-SeekDeep-Token"
_TOKEN_ENV_KEY = "SEEKDEEP_GUI_TOKEN"
_TOKEN_DISABLE_KEY = "SEEKDEEP_GUI_TOKEN_DISABLED"

# Module-level auth state. Populated by register_gui_endpoints() on first call
# so other modules (notably local_ai_server.py) can `from gui_endpoints import
# require_gui_token` and apply the same dependency to their own destructive
# endpoints (/unload, /warmup/*).
_AUTH_STATE: dict[str, Any] = {
    "env_path": None,   # Path to .env
    "initial": "",      # Token read or generated at register time
    "disabled": False,  # SEEKDEEP_GUI_TOKEN_DISABLED honored
    "ready": False,     # True once register_gui_endpoints has run
}


def _current_token() -> str:
    """Read the current token from .env, falling back to the initial value
    captured at register time. Lets `.env` rotation take effect without a
    server restart."""
    env_path = _AUTH_STATE.get("env_path")
    initial = _AUTH_STATE.get("initial", "")
    if not env_path or not env_path.is_file():
        return str(initial).strip()
    env_kv: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = _ENV_LINE_RE.match(line)
        if m:
            env_kv[m.group(1)] = line.split("=", 1)[1].strip().strip('"').strip("'")
    return env_kv.get(_TOKEN_ENV_KEY, str(initial)).strip()


async def require_gui_token(request: Request) -> None:
    """FastAPI dependency: 401 unless X-SeekDeep-Token matches the live .env
    value. Exported so endpoints outside gui_endpoints.py (e.g. /unload in
    local_ai_server.py) can apply the same auth via Depends()."""
    if not _AUTH_STATE.get("ready"):
        # Auth hasn't been registered yet (e.g. import-only test); permit.
        return
    if _AUTH_STATE.get("disabled"):
        return
    header_val = request.headers.get(_TOKEN_HEADER) or request.headers.get(_TOKEN_HEADER.lower())
    expected = _current_token()
    if not expected:
        raise HTTPException(503, f"{_TOKEN_ENV_KEY} not configured; restart server to regenerate")
    if not header_val or not secrets.compare_digest(header_val, expected):
        raise HTTPException(401,
            f"missing or invalid {_TOKEN_HEADER}; GUI fetches the token from GET /token, "
            f"or you can read it from .env and pass it manually")


def _ensure_gui_token(env_path: Path) -> tuple[str, bool]:
    """
    Return (token, was_generated). If SEEKDEEP_GUI_TOKEN is already in .env,
    return it as-is. Otherwise generate a fresh urlsafe token, append it to
    .env (preserving existing content), and return it with was_generated=True
    so callers can log the action.
    """
    env_kv: dict[str, str] = {}
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = _ENV_LINE_RE.match(line)
            if m:
                env_kv[m.group(1)] = line.split("=", 1)[1].strip().strip('"').strip("'")
    existing = env_kv.get(_TOKEN_ENV_KEY, "").strip()
    if existing:
        return existing, False
    token = secrets.token_urlsafe(32)
    block = (
        "\n"
        "# --- SeekDeep GUI token (auto-generated; rotate by replacing the value + restarting) ---\n"
        f"{_TOKEN_ENV_KEY}={token}\n"
    )
    if env_path.is_file():
        text = env_path.read_text(encoding="utf-8")
        if not text.endswith("\n"):
            text += "\n"
        env_path.write_text(text + block, encoding="utf-8")
    else:
        env_path.parent.mkdir(parents=True, exist_ok=True)
        env_path.write_text(block.lstrip("\n"), encoding="utf-8")
    return token, True


# ====================================================================
# .ENV MERGE
# ====================================================================

_ENV_LINE_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)\s*=")


# Audit P2-2: the SearXNG container image. Defaults to :latest to preserve the
# existing launcher behavior; set SEEKDEEP_SEARXNG_IMAGE to pin a specific tag
# or digest (e.g. searxng/searxng@sha256:...) for reproducible web search. Read
# at launch time so a /config edit + restart takes effect without a code change.
def _seekdeep_searxng_image() -> str:
    return os.environ.get("SEEKDEEP_SEARXNG_IMAGE", "").strip() or "searxng/searxng:latest"


_ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

# Keys that must NOT be writable through the user-facing POST /config path — they
# govern auth + self-update, so letting the config UI set them would turn a
# leaked/borrowed GUI token into a persistent auth-off / RCE foothold. Internal
# _merge_env callers (token sync at ~991, lock-cache) are unaffected; this gate
# is applied only to the user-supplied /config patch.
_CONFIG_PROTECTED_KEYS = frozenset({
    "SEEKDEEP_GUI_TOKEN",
    "SEEKDEEP_GUI_TOKEN_DISABLED",
    "SEEKDEEP_SELF_UPDATE_ENABLED",
    # self-update integrity policy — must not be relaxable via the user-facing /config
    # patch (a leaked/borrowed token could otherwise weaken the update gate after a restart)
    "SEEKDEEP_SELF_UPDATE_REF_POLICY",
    "SEEKDEEP_SELF_UPDATE_ALLOW_MAIN",
    "SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE",
    "SEEKDEEP_RELEASE_SIGNING_PUBKEY",
    # self-update resource bounds — a leaked token must not be able to set these
    # to 0 (break updates) or huge (OOM / unbounded fetch fan-out) after a restart
    "SEEKDEEP_SELF_UPDATE_MAX_FILE_BYTES",
    "SEEKDEEP_SELF_UPDATE_MAX_API_BYTES",
    "SEEKDEEP_SELF_UPDATE_MAX_TREE_ENTRIES",
})

# Cap on concurrent /events WebSocket subscribers so a token-holder can't exhaust
# connections (token-gated DoS). Hardcoded (no env read → no env-coverage entry needed).
_MAX_WS_SUBSCRIBERS = 64


def _merge_env(env_path: Path, updates: dict[str, Any]) -> dict[str, Any]:
    """Merge `updates` into the on-disk .env file, preserving comments and order.

    Security (antigravity AUD-004 + Codex):
    - Reject keys that don't match POSIX env-var format (rejects e.g. injection
      via punctuation or non-uppercase keys).
    - Reject values containing \\r or \\n — those would let an attacker write
      additional env lines like `FOO=x\\nSEEKDEEP_GUI_TOKEN_DISABLED=1` that
      get parsed on next server boot, disabling auth.
    Caller must already be token-gated (Depends(_require_gui_token) on /config).
    These checks are defense-in-depth if a token ever leaks.
    """
    if not env_path.is_file():
        raise HTTPException(404, f".env not found at {env_path}")

    for k, v in updates.items():
        if not isinstance(k, str) or not _ENV_KEY_RE.match(k):
            raise HTTPException(400, f"invalid env key {k!r}: must match {_ENV_KEY_RE.pattern}")
        sv = str(v)
        if "\n" in sv or "\r" in sv:
            raise HTTPException(400, f"env value for {k!r} contains newline; refusing to write")

    with env_path.open("r", encoding="utf-8") as f:
        lines = f.readlines()

    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        m = _ENV_LINE_RE.match(line)
        if m and m.group(1) in updates:
            key = m.group(1)
            val = str(updates[key])
            # Quote if it contains whitespace
            if any(c in val for c in " #") and not (val.startswith('"') and val.endswith('"')):
                val = f'"{val}"'
            out.append(f"{key}={val}\n")
            seen.add(key)
        else:
            out.append(line)

    # Append new keys at the bottom
    new_keys = [k for k in updates if k not in seen]
    if new_keys:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append("\n# === Added by SeekDeep GUI ===\n")
        for k in new_keys:
            val = str(updates[k])
            if any(c in val for c in " #"):
                val = f'"{val}"'
            out.append(f"{k}={val}\n")

    # Atomic write. pid- AND thread-scope the temp name (mirrors _atomic_write_json)
    # so two concurrent writers — even two threads in one process, since FastAPI
    # runs sync handlers in a threadpool — can't both target the same temp file and
    # interleave / collide on the rename.
    tmp = env_path.with_suffix(env_path.suffix + ".tmp." + str(os.getpid()) + "." + str(threading.get_ident()))
    with tmp.open("w", encoding="utf-8") as f:
        f.writelines(out)
    tmp.replace(env_path)

    return {
        "ok": True,
        "updated": list(updates.keys()),
        "new_keys": new_keys,
        "total_keys": len([l for l in out if _ENV_LINE_RE.match(l)]),
    }


# ====================================================================
# HF CACHE SCAN — resilient against WinError 448 + symlink trust issues
# ====================================================================
# huggingface_hub.scan_cache_dir() calls Path.is_dir() on every snapshot
# file. On Windows, HF cache uses symlinks (snapshots/<rev>/file →
# blobs/<sha>) and the OS occasionally throws WinError 448 "untrusted
# mount point" when the link target crosses a security boundary (file
# backup mount, Dev Drive, etc). One bad symlink would crash the entire
# scan and 500 the endpoint. This wrapper catches per-repo errors and
# returns whatever scan completed plus a list of bad repos.

def _safe_scan_hf_cache(cache_dir: str | None = None):
    """Returns (info_or_None, error_str_or_None). info exposes size_on_disk
    + repos. error_str is set only when the scan completely failed or hit
    a symlink crash that prevented full enumeration."""
    try:
        from huggingface_hub import scan_cache_dir
    except ImportError:
        return None, "huggingface_hub not installed"
    try:
        from huggingface_hub.errors import CacheNotFound
    except ImportError:
        CacheNotFound = Exception  # type: ignore

    cache_dir = cache_dir or (os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None)
    try:
        info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
        return info, None
    except CacheNotFound:
        return _EmptyScanInfo(), None
    except OSError as exc:
        # WinError 448 (untrusted mount point), ENOENT on broken symlinks, etc.
        # Fall back to a manual directory walk that skips unreadable files.
        try:
            info = _manual_hf_cache_scan(cache_dir)
            return info, f"partial scan · skipped unreadable files · {type(exc).__name__}: {exc}"[:280]
        except Exception as inner:
            return _EmptyScanInfo(), f"{type(exc).__name__}: {exc} (fallback: {inner})"[:280]
    except Exception as exc:
        return _EmptyScanInfo(), f"{type(exc).__name__}: {exc}"[:280]


class _EmptyScanInfo:
    """Stand-in for huggingface_hub.HFCacheInfo when scan fails completely.

    Deliberately does NOT define delete_revisions — callers detect partial
    scans via hasattr() and surface a 503 instead of crashing inside prune.
    """
    size_on_disk = 0
    repos = ()
    warnings = ()
    # NOTE: no delete_revisions attribute by design — see /cache/prune guard.


class _StubRepo:
    """Minimal HFCacheInfo.Repo stand-in for partial scans."""
    def __init__(self, repo_id, repo_path, size_on_disk, nb_files, last_modified):
        self.repo_id       = repo_id
        self.repo_type     = "model"
        self.repo_path     = repo_path
        self.size_on_disk  = size_on_disk
        self.nb_files      = nb_files
        self.last_modified = last_modified
        self.revisions     = ()


def _manual_hf_cache_scan(cache_dir: str | None):
    """Walk the HF cache directly when huggingface_hub.scan_cache_dir() crashes
    on a symlink. We trade detail (no per-revision tracking, no refs) for
    resilience. Used only as the fallback path."""
    root = Path(cache_dir) if cache_dir else Path(os.path.expanduser("~/.cache/huggingface/hub"))
    if not root.is_dir():
        return _EmptyScanInfo()
    repos = []
    total_bytes = 0
    for entry in root.iterdir():
        try:
            name = entry.name
            if not name.startswith("models--") and not name.startswith("datasets--") and not name.startswith("spaces--"):
                continue
            repo_id = name.split("--", 1)[1].replace("--", "/") if "--" in name else name
            size = 0
            nfiles = 0
            try:
                for p in entry.rglob("*"):
                    try:
                        if p.is_file():
                            size += p.stat().st_size
                            nfiles += 1
                    except OSError:
                        # Skip the file that crashed scan_cache_dir originally.
                        continue
            except OSError:
                pass
            try:
                last_mod = entry.stat().st_mtime
            except OSError:
                last_mod = 0
            repos.append(_StubRepo(repo_id, str(entry), size, nfiles, last_mod))
            total_bytes += size
        except Exception:
            continue
    info = _EmptyScanInfo()
    info.size_on_disk = total_bytes  # type: ignore
    info.repos = tuple(repos)        # type: ignore
    return info


# ====================================================================
# LOG TAILING
# ====================================================================

def _find_active_log(log_dir: Path) -> Path | None:
    """Pick the newest seekdeep-*.log file, or fall back to server.log.

    The Discord bot (index.js) writes daily seekdeep-YYYY-MM-DD.log files.
    The Tauri sidecar redirects the AI server's stdout to server.log. In
    standalone mode (no bot running) we still want the viewer to surface
    server.log so users can see why the chat is failing.
    """
    if not log_dir.is_dir():
        return None
    candidates = sorted(log_dir.glob("seekdeep-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if candidates:
        return candidates[0]
    fallback = log_dir / "server.log"
    return fallback if fallback.is_file() else None


def _tail(path: Path, lines: int) -> list[str]:
    """Return the last `lines` lines from a file. Memory-efficient for moderate sizes."""
    if not path.is_file():
        return []
    block_size = 4096
    encoding = "utf-8"
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        data = b""
        found = 0
        while size > 0 and found <= lines:
            read = min(block_size, size)
            size -= read
            f.seek(size)
            data = f.read(read) + data
            found = data.count(b"\n")
    text = data.decode(encoding, errors="replace")
    return text.splitlines()[-lines:]


async def _stream_log(path: Path):
    """Async generator that yields new lines appended to `path` as SSE events."""
    if not path.is_file():
        yield f"event: error\ndata: log file not found at {path}\n\n"
        return
    with path.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if line:
                yield f"data: {json.dumps(line.rstrip())}\n\n"
            else:
                await asyncio.sleep(0.5)


# ====================================================================
# LAUNCHER
# ====================================================================

def _service_command(service: str) -> list[str] | None:
    """Map a whitelisted service name to its start command."""
    if service == "ai-server":
        return ["python", "local_ai_server.py"]
    if service == "bot":
        return ["node", "index.js"]
    if service == "searxng":
        return ["docker", "compose", "-f", "searxng/docker-compose.yml", "up", "-d"]
    return None


def _pid_alive(pid: int) -> bool:
    """Return True if `pid` is a live process. Cross-platform best effort."""
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            # On Windows, sending signal 0 is not supported. Use OpenProcess via ctypes.
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            exit_code = ctypes.c_ulong()
            still_active = ctypes.windll.kernel32.GetExitCodeProcess(
                handle, ctypes.byref(exit_code))
            ctypes.windll.kernel32.CloseHandle(handle)
            # STILL_ACTIVE = 259
            return bool(still_active) and exit_code.value == 259
        else:
            os.kill(pid, 0)
            return True
    except (OSError, ProcessLookupError, PermissionError):
        return False


def _read_pid_file(log_dir: Path, service: str) -> int | None:
    """Return PID from logs/<svc>.pid, or None if file is missing/invalid."""
    name = _PID_FILE_NAMES.get(service)
    if not name:
        return None
    pid_path = log_dir / name
    if not pid_path.is_file():
        return None
    try:
        return int(pid_path.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return None


def _detect_running(service: str, log_dir: Path) -> tuple[str, int | None]:
    """
    Backwards-compatible (state, pid) wrapper around _service_state.
    Prefer _service_state for new callers — it also returns count + source.
    """
    info = _service_state(service, log_dir)
    return info["state"], info["pid"]


def _service_state(service: str, log_dir: Path) -> dict:
    """
    ONE source of truth for service lifecycle state. Returns:
      {
        "state":  "running" | "not-running" | "exited" | "transitioning" | "unknown",
        "pid":    int | None,    # primary PID (oldest of `count` instances)
        "count":  int,           # how many matching procs are alive (bot pile-up detection)
        "source": str,           # which detection mechanism resolved this state
        "transitioning": bool,   # True if a start/stop/restart action is in flight
      }

    Detection precedence (first hit wins, then count is augmented):
      1. We just kicked off start/stop/restart → "transitioning"
      2. _PROCESSES[svc] Popen handle is alive → "running" via "tracked-popen"
      3. PID file written by launcher.bat resolves to an alive pid → "running" via "pid-file"
      4. Service-specific probes:
           ai-server: this very process IS ai-server → "running" via "self-host"
           searxng:   TCP probe on the configured port → "running"/"not-running" via "port-probe"
      5. For bot: also psutil-scan for orphan node.exe procs running our index.js — this
         catches launcher.bat-spawned bots whose PID file got cleaned + manual pile-ups.
      6. Nothing matched → "not-running" (or "unknown" for non-tracked services)

    After resolving state, for the bot specifically, do a psutil pile-up
    scan so `count` reflects ALL alive instances regardless of which one
    won precedence above. This is what makes "running (3 instances)" possible.
    """
    # 0. Transitioning beats everything: the UI should freeze on yellow
    #    while we're mid-action, not flap between red and green.
    with _TRANSITIONING_LOCK:
        is_transitioning = service in _TRANSITIONING

    state: str = "not-running"
    pid: int | None = None
    source: str = "none"

    # 1. In-process spawn we tracked
    proc = _PROCESSES.get(service)
    if proc is not None:
        rc = proc.poll()
        if rc is None:
            state, pid, source = "running", proc.pid, "tracked-popen"

    # 2. PID file written by launcher.bat (only check if step 1 didn't win)
    if state != "running":
        fpid = _read_pid_file(log_dir, service)
        if fpid is not None:
            if _pid_alive(fpid):
                state, pid, source = "running", fpid, "pid-file"
            else:
                state, pid, source = "not-running", fpid, "pid-file-stale"

    # 3. Service-specific fallbacks
    if state not in ("running",) and source == "none":
        if service == "ai-server":
            state, pid, source = "running", os.getpid(), "self-host"
        elif service == "searxng":
            port_str = (os.getenv("SEARXNG_PORT") or "").strip() or "8080"
            try:
                port = int(port_str)
            except ValueError:
                port = 8080
            # Bump timeout 0.5s → 1.5s. The 500ms probe was flapping to
            # UNKNOWN on busy systems (e.g. during fresh-boot when docker
            # cleanup + bot spawn are in flight). 1.5s is still well
            # under the launcher's 5s status poll budget and matches
            # what curl-based probes elsewhere in this file use.
            #
            # Also collapse socket.timeout (TimeoutError) into the
            # "not-running" branch so a slow/overloaded SearXNG that
            # eventually responds shows as "not-running" → user clicks
            # Restart → fresh container fixes it. Previously it showed
            # as "unknown" which is a meaningless state for an HTTP
            # service either listening or not.
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1.5):
                    state, source = "running", "port-probe"
            except (ConnectionRefusedError, TimeoutError, socket.timeout):
                state, source = "not-running", "port-probe"
            except OSError:
                state, source = "unknown", "port-probe-error"

    # 4. Bot-specific orphan scan — catches launcher.bat spawns whose PID
    #    file was deleted, plus manual pile-ups. Augments `count` always;
    #    if state was "not-running" but procs exist, flip to running.
    count = 1 if state == "running" else 0
    if service == "bot":
        try:
            bot_cwd = _resolve_bot_cwd(log_dir.parent)
            procs = _find_bot_processes(bot_cwd)
            if procs:
                count = len(procs)
                if state != "running":
                    state, pid, source = "running", procs[0]["pid"], "psutil-scan"
                elif source == "tracked-popen":
                    # Keep tracked pid as primary, but reflect higher count
                    pass
                else:
                    pid = procs[0]["pid"]
        except Exception:
            # psutil might not be installed; fall back to count from state.
            pass

    # Service tracked but no signal at all
    if state == "not-running" and source == "none":
        source = "no-signal"

    # Unknown for services we don't track
    if service not in _PID_FILE_NAMES and service not in {"ai-server", "searxng"}:
        state, source = "unknown", "untracked"

    if is_transitioning:
        # Preserve discovered pid/count for UX continuity but flag the
        # state as transitioning so pills show yellow.
        return {"state": "transitioning", "pid": pid, "count": count,
                "source": source, "transitioning": True}

    return {"state": state, "pid": pid, "count": count,
            "source": source, "transitioning": False}


def _emit_state_change_if_any(service: str, current: dict) -> None:
    """Compare `current` to last cached state; on change, publish a
    `service.state.changed` event on the bus and update the cache. Status
    pills + launcher cards subscribe to this so they update on the WS bus
    immediately instead of waiting for the next 5s poll to notice."""
    prev = _LAST_SERVICE_STATE.get(service)
    # Compare on the fields that actually drive UI rendering. The `source`
    # field is diagnostic — don't fire events when only `source` changes.
    keys = ("state", "pid", "count", "transitioning")
    if prev is not None and all(prev.get(k) == current.get(k) for k in keys):
        return
    _LAST_SERVICE_STATE[service] = {k: current.get(k) for k in keys}
    try:
        event_bus.publish_sync({
            "type": "service.state.changed",
            "data": {
                "service": service,
                "state": current.get("state"),
                "pid": current.get("pid"),
                "count": current.get("count"),
                "source": current.get("source"),
                "transitioning": current.get("transitioning"),
                "prev_state": (prev or {}).get("state"),
            },
        })
    except Exception:
        pass


def _begin_transition(service: str) -> None:
    """Mark a service as mid-action. UI pills should render yellow while
    this is set. Pair with _end_transition() in a try/finally."""
    with _TRANSITIONING_LOCK:
        _TRANSITIONING.add(service)
    try:
        event_bus.publish_sync({
            "type": "service.state.changed",
            "data": {"service": service, "state": "transitioning",
                     "transitioning": True, "source": "action-begin"},
        })
    except Exception:
        pass


def _end_transition(service: str) -> None:
    with _TRANSITIONING_LOCK:
        _TRANSITIONING.discard(service)
    # Force-emit current state after the lock clears so UI re-paints
    # immediately on the now-settled state.
    # _LAST_SERVICE_STATE may still hold "transitioning" — invalidate.
    _LAST_SERVICE_STATE.pop(service, None)


def _resolve_bot_cwd(default_cwd: Path) -> Path:
    """Pick where to run `node index.js` from. Order: SEEKDEEP_BOT_CWD env
    override → default_cwd if it has index.js → known clone locations
    (~/SeekDeep-DiscordBot, ./../SeekDeep-DiscordBot). Returns the first
    directory whose index.js exists, or default_cwd as a last resort so
    the caller still surfaces a sensible error path."""
    override = (os.getenv("SEEKDEEP_BOT_CWD") or "").strip()
    if override:
        p = Path(override).expanduser().resolve()
        if (p / "index.js").is_file():
            return p
    if (default_cwd / "index.js").is_file():
        return default_cwd
    candidates = [
        Path.home() / "SeekDeep-DiscordBot",
        default_cwd.parent / "SeekDeep-DiscordBot",
        default_cwd.parent.parent / "SeekDeep-DiscordBot",
    ]
    for c in candidates:
        try:
            if (c / "index.js").is_file():
                return c.resolve()
        except OSError:
            continue
    return default_cwd


# Cache of paths resolved inside register_gui_endpoints that module-level helpers
# (like _start_service, which runs later when the GUI spawns the bot) need.
# Previously _start_service referenced a bare `_env_path` that only exists inside
# register_gui_endpoints -> NameError every call, swallowed by the surrounding
# try/except, so the SEEKDEEP_BOT_CWD data-dir lock and the GUI-token sync to the
# bot's .env silently never happened. Mutating this dict needs no `global`.
_GUI_RUNTIME_PATHS: dict = {}


def _start_service(service: str, cwd: Path, log_dir: Path) -> dict:
    if service in SELF_HOSTED_SERVICES:
        raise HTTPException(409,
            f"{service} is self-hosted; cannot start it from inside the AI server. "
            f"Use seekdeep_launcher.bat instead.")
    state, pid = _detect_running(service, log_dir)
    if state == "running":
        return {"ok": True, "service": service, "state": "already-running", "pid": pid}
    cmd = _service_command(service)
    if not cmd:
        raise HTTPException(400, f"no command mapping for service {service!r}")
    # For the Discord bot we need index.js + node_modules in cwd. In Tauri
    # mode the AI server runs from %APPDATA%/SeekDeep/app/ where these
    # files don't exist. Auto-resolve to the user's actual repo dir.
    if service == "bot":
        cwd = _resolve_bot_cwd(cwd)
        if not (cwd / "index.js").is_file():
            raise HTTPException(400,
                f"bot files not found · `index.js` is missing from {cwd}. "
                f"Set SEEKDEEP_BOT_CWD in .env to the absolute path of your "
                f"SeekDeep-DiscordBot repo (the directory that contains "
                f"index.js + node_modules), then click Start again.")
        if not (cwd / "node_modules").is_dir():
            raise HTTPException(400,
                f"bot dependencies missing · `node_modules` is not present in {cwd}. "
                f"Run `npm install` in that directory (or use the Installer's "
                f"setup button), then click Start again.")
    # Route stdout/stderr to per-launch log files so failures aren't invisible.
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_log = log_dir / f"{service}-{stamp}.gui.out.log"
    err_log = log_dir / f"{service}-{stamp}.gui.err.log"

    # Build the child's env. For the bot, inject the LIVE SEEKDEEP_GUI_TOKEN
    # from our .env so the bot can authenticate POST /events/emit calls
    # WITHOUT having to read its own __dirname/.env (which diverges from
    # the AI server's .env when SEEKDEEP_BOT_CWD points at the user's repo
    # while the AI server runs from the Tauri runtime dir). Without this,
    # the bot's emit-event path 401s and disables itself with the error
    # "GUI events emit got 401 (after .env re-read) — token mismatch
    # persists; disabling further emits."
    child_env = os.environ.copy()
    if service == "bot":
        # Audit §2: lock the canonical bot cwd. _resolve_bot_cwd walks up to
        # five candidate paths every boot; once we've successfully resolved
        # the dir that actually has index.js, persist it as SEEKDEEP_BOT_CWD
        # so every future _resolve_bot_cwd call (including the one that
        # computes _data_dir at next boot) hits the env-override branch
        # first and returns the SAME path deterministically. Converts the
        # fragile heuristic into a guess-once-then-locked contract — the bot
        # and the AI server's data dir can never diverge again on a box
        # where the repo lives somewhere the heuristic wouldn't guess.
        try:
            cwd_abs = str(cwd.resolve())
            child_env["SEEKDEEP_BOT_CWD"] = cwd_abs
            os.environ["SEEKDEEP_BOT_CWD"] = cwd_abs  # this process agrees too
            if (os.getenv("SEEKDEEP_BOT_CWD") or "").strip() != cwd_abs:
                pass
            try:
                _managed_env = _GUI_RUNTIME_PATHS.get("env_path")
                if _managed_env is not None:
                    _merge_env(_managed_env, {"SEEKDEEP_BOT_CWD": cwd_abs})
            except Exception:
                pass
        except Exception:
            pass
        try:
            tok = _current_token()
            if tok:
                child_env["SEEKDEEP_GUI_TOKEN"] = tok
            # Also write it to the BOT's .env so `_seekdeepReReadTokenFromEnvFile`
            # in index.js (the bot's own self-heal path) doesn't hit a stale
            # value if/when this process-env one ever rotates mid-session.
            try:
                bot_env_path = (cwd / ".env").resolve()
                _managed_env = _GUI_RUNTIME_PATHS.get("env_path")
                # Only sync if it's NOT the same file we already manage.
                if tok and (_managed_env is None or bot_env_path != _managed_env.resolve()):
                    _merge_env(bot_env_path, {"SEEKDEEP_GUI_TOKEN": tok})
            except Exception:
                pass
        except Exception:
            pass

    try:
        out_f = out_log.open("ab")
        err_f = err_log.open("ab")
        # OR in CREATE_NO_WINDOW with CREATE_NEW_PROCESS_GROUP so the spawned
        # bot daemon doesn't pop its own console window on Windows.
        _flags = 0
        if os.name == "nt":
            _flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), env=child_env,
            stdout=out_f, stderr=err_f, stdin=subprocess.DEVNULL,
            creationflags=_flags,
        )
        _PROCESSES[service] = proc
        return {"ok": True, "service": service, "state": "starting",
                "pid": proc.pid, "log": str(out_log.name), "cwd": str(cwd)}
    except FileNotFoundError as e:
        raise HTTPException(500,
            f"failed to start {service}: {e} · is `{cmd[0]}` on PATH? "
            f"(Tauri inherits the parent process env — try running the Tauri "
            f"shell from a terminal where `node`/`docker` is reachable.)")


def _stop_service(service: str, log_dir: Path) -> dict:
    if service in SELF_HOSTED_SERVICES:
        raise HTTPException(409,
            f"{service} is self-hosted; refusing to stop it (it would kill this "
            f"very request). Use seekdeep_launcher.bat instead.")
    # 1. If we spawned it, terminate that.
    proc = _PROCESSES.get(service)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return {"ok": True, "service": service, "state": "stopped", "source": "in-process"}
    # 2. Otherwise try to terminate the PID from the launcher's PID file.
    pid = _read_pid_file(log_dir, service)
    if pid is not None and _pid_alive(pid):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               check=False, capture_output=True)
            else:
                os.kill(pid, 15)  # SIGTERM
                for _ in range(10):
                    time.sleep(0.5)
                    if not _pid_alive(pid):
                        break
                else:
                    os.kill(pid, 9)  # SIGKILL
            return {"ok": True, "service": service, "state": "stopped",
                    "source": "pid-file", "pid": pid}
        except (OSError, PermissionError) as e:
            raise HTTPException(500, f"failed to stop {service} (pid {pid}): {e}")
    return {"ok": True, "service": service, "state": "not-running"}


def _status_service(service: str, log_dir: Path) -> dict:
    state, pid = _detect_running(service, log_dir)
    out: dict[str, Any] = {"ok": True, "service": service, "state": state}
    if pid is not None:
        out["pid"] = pid
    return out


def _find_bot_processes(bot_cwd: Path) -> list[dict]:
    # Enumerate all node processes running index.js whose cwd OR command line
    # points at bot_cwd. Returning [{pid,cmdline,cwd,source}] — scoped to this
    # repo so we never kill an unrelated Node project the user is running.
    bot_cwd_str = str(bot_cwd.resolve()).lower()
    found: list[dict] = []
    seen_pids: set[int] = set()
    # 1) psutil — cleanest. Installed via accelerate on systems with ML deps,
    #    may be absent on a fresh boot-deps-only install.
    try:
        import psutil  # type: ignore
        my_pid = os.getpid()
        for p in psutil.process_iter(["pid", "name", "cmdline", "cwd"]):
            try:
                pid = p.info.get("pid")
                if not pid or pid == my_pid or pid in seen_pids:
                    continue
                name = (p.info.get("name") or "").lower()
                if not name.startswith("node"):
                    continue
                cmdline = p.info.get("cmdline") or []
                joined = " ".join(cmdline).lower()
                if "index.js" not in joined:
                    continue
                # Match by cwd or by cmdline-contains-bot_cwd. Either signal
                # is enough; both is best.
                pcwd = ""
                try:
                    pcwd = (p.info.get("cwd") or p.cwd() or "").lower()
                except Exception:
                    pcwd = ""
                if bot_cwd_str not in pcwd and bot_cwd_str not in joined:
                    continue
                found.append({"pid": pid, "cmdline": " ".join(cmdline)[:400],
                              "cwd": pcwd, "source": "psutil"})
                seen_pids.add(pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                # Process vanished mid-iteration or we lack rights to inspect
                # it — skip silently, the kill list just won't include it.
                continue
        return found
    except ImportError:
        pass
    except Exception:
        # psutil might be present but fail (perm errors etc.); fall through.
        pass
    # 2) Windows fallback — PowerShell + WMI exposes CommandLine on Win32_Process.
    if os.name == "nt":
        try:
            ps_cmd = (
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='node'\" "
                "| Where-Object { $_.CommandLine -like '*index.js*' } "
                "| Select-Object ProcessId, CommandLine, ExecutablePath "
                "| ConvertTo-Json -Compress"
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                capture_output=True, text=True, timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            raw = (out.stdout or "").strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict):
                    data = [data]
                for entry in data:
                    pid = entry.get("ProcessId")
                    cmd = (entry.get("CommandLine") or "")
                    if not pid or pid in seen_pids:
                        continue
                    # Cmdline must contain the bot_cwd path — without psutil's
                    # cwd() probe this is our only safety check against killing
                    # an unrelated Node project.
                    if bot_cwd_str not in cmd.lower():
                        continue
                    found.append({"pid": int(pid), "cmdline": cmd[:400],
                                  "cwd": "", "source": "wmi"})
                    seen_pids.add(int(pid))
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
            pass
        return found
    # 3) POSIX fallback — `ps -eo pid,args` then grep node+index.js+cwd.
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid,args"], capture_output=True, text=True, timeout=10,
        )
        for line in (out.stdout or "").splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            args = parts[1]
            args_lc = args.lower()
            if pid in seen_pids:
                continue
            if "node" not in args_lc or "index.js" not in args_lc:
                continue
            if bot_cwd_str not in args_lc:
                continue
            found.append({"pid": pid, "cmdline": args[:400],
                          "cwd": "", "source": "ps"})
            seen_pids.add(pid)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return found


def _find_ai_server_processes(project_root: Path) -> list[dict]:
    """Mirror of _find_bot_processes but for `python local_ai_server.py`
    rooted at project_root. Used by fresh-boot cleanup to kill stale AI
    server zombies from prior sessions WITHOUT killing ourselves (callers
    are responsible for filtering os.getpid() out of the result)."""
    root_str = str(project_root.resolve()).lower()
    found: list[dict] = []
    seen_pids: set[int] = set()
    # 1) psutil — cleanest.
    try:
        import psutil  # type: ignore
        for p in psutil.process_iter(["pid", "name", "cmdline", "cwd"]):
            try:
                pid = p.info.get("pid")
                if not pid or pid in seen_pids:
                    continue
                name = (p.info.get("name") or "").lower()
                # Match python / pythonw / py / uvicorn binaries.
                if not (name.startswith("python") or name.startswith("uvicorn") or name == "py.exe" or name == "py"):
                    continue
                cmdline = p.info.get("cmdline") or []
                joined = " ".join(cmdline).lower()
                if "local_ai_server.py" not in joined:
                    continue
                pcwd = ""
                try:
                    pcwd = (p.info.get("cwd") or p.cwd() or "").lower()
                except Exception:
                    pcwd = ""
                if root_str not in pcwd and root_str not in joined:
                    continue
                found.append({"pid": pid, "cmdline": " ".join(cmdline)[:400],
                              "cwd": pcwd, "source": "psutil"})
                seen_pids.add(pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return found
    except ImportError:
        pass
    except Exception:
        pass
    # 2) Windows WMI fallback.
    if os.name == "nt":
        try:
            ps_cmd = (
                "Get-CimInstance Win32_Process "
                "| Where-Object { ($_.Name -like 'python*' -or $_.Name -like 'pythonw*' -or $_.Name -eq 'py.exe' -or $_.Name -like 'uvicorn*') "
                "-and ($_.CommandLine -like '*local_ai_server.py*') } "
                "| Select-Object ProcessId, CommandLine, ExecutablePath "
                "| ConvertTo-Json -Compress"
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                capture_output=True, text=True, timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            raw = (out.stdout or "").strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict):
                    data = [data]
                for entry in data:
                    pid = entry.get("ProcessId")
                    cmd = (entry.get("CommandLine") or "")
                    if not pid or pid in seen_pids:
                        continue
                    if root_str not in cmd.lower():
                        continue
                    found.append({"pid": int(pid), "cmdline": cmd[:400],
                                  "cwd": "", "source": "wmi"})
                    seen_pids.add(int(pid))
        except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
            pass
    # 3) POSIX fallback.
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid,args"], capture_output=True, text=True, timeout=10,
        )
        for line in (out.stdout or "").splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            args = parts[1]
            args_lc = args.lower()
            if pid in seen_pids:
                continue
            if "local_ai_server.py" not in args_lc:
                continue
            if root_str not in args_lc:
                continue
            found.append({"pid": pid, "cmdline": args[:400],
                          "cwd": "", "source": "ps"})
            seen_pids.add(pid)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return found


def _kill_pid(pid: int, timeout_s: float = 2.0) -> tuple[bool, str | None]:
    # Terminate a single PID gracefully, escalating to force-kill if it
    # outlives `timeout_s`. Returns (killed, error_message_or_None).
    if not _pid_alive(pid):
        return True, "already-dead"
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False, capture_output=True, timeout=10,
            )
        else:
            os.kill(pid, 15)  # SIGTERM
            for _ in range(int(timeout_s * 4)):
                time.sleep(0.25)
                if not _pid_alive(pid):
                    return True, None
            os.kill(pid, 9)   # SIGKILL
            time.sleep(0.25)
        return (not _pid_alive(pid)), (None if not _pid_alive(pid) else "still-alive")
    except (OSError, PermissionError) as e:
        return False, f"{type(e).__name__}: {e}"


# ====================================================================
# DATA FILE NORMALIZERS
# ====================================================================
# The bot writes data/*.json files in its own per-guild schema. The GUI's
# Control Center expects a flatter shape (top-level totals, flat rule arrays,
# day-bucket time series). These normalizers translate so the GUI consumes
# real data instead of falling back to mock visuals.

def _normalize_server_stats(raw: Any) -> dict:
    """
    Bot schema  : {guilds:{<gid>:{totalChats,totalImages,totalVision,
                                  users:{<uid>:{chats,images,vision}},
                                  dayBuckets:{YYYY-MM-DD:{chats,images,vision}}}}}
    GUI expects : {totals:{messages,images,vision},
                   dayBuckets:{messages:[...]} (30-day series, newest last),
                   top:[{name,count,id}] sorted desc by count}
    """
    if not isinstance(raw, dict):
        return {"totals": {}, "dayBuckets": {}, "top": []}
    guilds = raw.get("guilds") or {}

    totals = {"messages": 0, "images": 0, "vision": 0}
    day_agg: dict[str, dict[str, int]] = {}      # date -> {messages,images,vision}
    user_agg: dict[str, dict[str, Any]] = {}     # uid  -> {id,name?,count}

    for _gid, g in guilds.items():
        if not isinstance(g, dict):
            continue
        totals["messages"] += int(g.get("totalChats") or 0)
        totals["images"]   += int(g.get("totalImages") or 0)
        totals["vision"]   += int(g.get("totalVision") or 0)

        for date, bucket in (g.get("dayBuckets") or {}).items():
            if not isinstance(bucket, dict):
                continue
            d = day_agg.setdefault(date, {"messages": 0, "images": 0, "vision": 0})
            d["messages"] += int(bucket.get("chats") or 0)
            d["images"]   += int(bucket.get("images") or 0)
            d["vision"]   += int(bucket.get("vision") or 0)

        for uid, u in (g.get("users") or {}).items():
            if not isinstance(u, dict):
                continue
            entry = user_agg.setdefault(uid, {"id": uid, "count": 0})
            entry["count"] += int(u.get("chats") or 0) + int(u.get("images") or 0) + int(u.get("vision") or 0)
            # Best-effort display name (the bot may add one in future)
            for key in ("name", "username", "displayName"):
                if u.get(key):
                    entry["name"] = u[key]
                    break

    # 30-day time series (newest last). If there are gaps, the GUI's bar
    # chart just shows shorter columns; we don't insert zero-filler dates.
    sorted_dates = sorted(day_agg.keys())[-30:]
    day_buckets_flat = {
        "messages": [day_agg[d]["messages"] for d in sorted_dates],
        "images":   [day_agg[d]["images"]   for d in sorted_dates],
        "vision":   [day_agg[d]["vision"]   for d in sorted_dates],
        "dates":    sorted_dates,
    }
    top = sorted(user_agg.values(), key=lambda u: u.get("count", 0), reverse=True)[:25]

    return {"totals": totals, "dayBuckets": day_buckets_flat, "top": top}


def _normalize_auto_reactions(raw: Any) -> dict:
    """
    Bot schema  : {guilds:{<gid>:{rules:[{id,emoji,pattern,scope,target,enabled,...}],
                                  builtins:{<key>:{enabled,emoji,threshold?}}}}}
    GUI expects : {rules:[{id,emoji,pattern,channel?,user?,enabled,hits}],
                   builtins:{<key>:{enabled,emoji,threshold?,guilds_on:[...]}}}

    builtins are surfaced as a per-key OR across guilds (enabled = any
    guild has it on) so the Control Center can paint the global default
    state. The full per-guild grid would need a guild selector — not yet
    wired in the GUI.
    """
    if not isinstance(raw, dict):
        return {"rules": [], "builtins": {}}
    rules_out: list[dict[str, Any]] = []
    builtins_out: dict[str, dict[str, Any]] = {}
    for gid, g in (raw.get("guilds") or {}).items():
        if not isinstance(g, dict):
            continue
        for rule in (g.get("rules") or []):
            if not isinstance(rule, dict):
                continue
            scope = (rule.get("scope") or "").lower()
            target = rule.get("target") or ""
            flat = {
                "id":      rule.get("id") or "",
                "emoji":   rule.get("emoji") or "?",
                "pattern": rule.get("pattern") or "",
                "enabled": rule.get("enabled") is not False,
                "hits":    int(rule.get("hits") or 0),
                "guild":   gid,
            }
            if scope == "channel" and target:
                flat["channel"] = str(target)
            elif scope == "user" and target:
                flat["user"] = str(target)
            rules_out.append(flat)
        for key, b in (g.get("builtins") or {}).items():
            if not isinstance(b, dict):
                continue
            agg = builtins_out.setdefault(str(key), {
                "enabled": False, "emoji": b.get("emoji") or "?",
                "threshold": b.get("threshold"), "guilds_on": [],
            })
            if b.get("enabled") is not False:
                agg["enabled"] = True
                agg["guilds_on"].append(gid)
            if b.get("emoji") and not agg.get("emoji"):
                agg["emoji"] = b["emoji"]
            if b.get("threshold") and not agg.get("threshold"):
                agg["threshold"] = b["threshold"]
    return {"rules": rules_out, "builtins": builtins_out}


def _normalize_prompt_templates(raw: Any) -> dict:
    """
    Bot schema  : {guilds:{<gid>:{<uid>:{<name>:{prompt,createdAt,updatedAt,
                                                usedCount}}}}}
    GUI expects : {templates:[{id,name,owner_user_id,guild,prompt,vars,
                               char_count,used_count,created_at,updated_at}]}

    Flattens the nested guild→user→name structure into a flat list and
    extracts {{vars}} from each prompt body for the GUI's "Variables"
    column. Token-gated since prompts often include personal context.
    """
    if not isinstance(raw, dict):
        return {"templates": [], "count": 0}
    import re as _re
    var_re = _re.compile(r"\{\{\s*([a-z0-9_-]{1,40})\s*\}\}", _re.IGNORECASE)
    out: list[dict[str, Any]] = []
    for gid, g in (raw.get("guilds") or {}).items():
        if not isinstance(g, dict):
            continue
        for uid, u in g.items():
            if not isinstance(u, dict):
                continue
            for name, t in u.items():
                if not isinstance(t, dict):
                    continue
                prompt = str(t.get("prompt") or "")
                vars_seen: list[str] = []
                for m in var_re.finditer(prompt):
                    v = m.group(1).lower()
                    if v not in vars_seen:
                        vars_seen.append(v)
                out.append({
                    "id":             f"{gid}:{uid}:{name}",
                    "name":           str(name),
                    "owner_user_id":  str(uid),
                    "guild":          str(gid),
                    "prompt":         prompt,
                    "vars":           vars_seen,
                    "char_count":     len(prompt),
                    "used_count":     int(t.get("usedCount") or 0),
                    "created_at":     str(t.get("createdAt") or ""),
                    "updated_at":     str(t.get("updatedAt") or ""),
                })
    # Sort newest-updated first; the GUI can re-sort client-side.
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return {"templates": out, "count": len(out)}


def _normalize_archive_snapshot(raw: Any) -> dict:
    """Empty-state shape for data/archive-snapshot.json so the GUI Archive
    pane can render its "no snapshot yet" message without a JSON parse
    error before the bot has written its first snapshot."""
    if not isinstance(raw, dict):
        return {
            "generated_at": None,
            "guild_count": 0,
            "shared_thread_count": 0,
            "user_thread_count": 0,
            "total_shared_entries": 0,
            "total_user_entries": 0,
            "guilds": {},
            "empty": True,
        }
    raw.setdefault("guilds", {})
    return raw


# Map known data files to their normalizer functions. Anything not listed
# is returned to the GUI as-is (raw bot schema).
_DATA_NORMALIZERS: dict[str, Callable[[Any], Any]] = {
    "server-stats.json":     _normalize_server_stats,
    "auto-reactions.json":   _normalize_auto_reactions,
    "archive-snapshot.json": _normalize_archive_snapshot,
    "prompt-templates.json": _normalize_prompt_templates,
}


# ====================================================================
# REGISTRATION
# ====================================================================

def register_gui_endpoints(
    app: FastAPI,
    log_dir: str = "logs",
    data_dir: str = "data",
    env_path: str = ".env",
    repo_root: str | None = None,
    warmup_handlers: dict[str, Callable[..., Any]] | None = None,
    stats_provider: Callable[[], dict] | None = None,
    tick_providers: dict[str, Callable[[], dict]] | None = None,
) -> None:
    """
    Attach every GUI-required endpoint to `app`. Idempotent.

    warmup_handlers, if provided, maps the model class ("chat", "image",
    "vision") to a callable that warms it. The chat handler is called with
    a `role` kwarg; image/vision are called with no args. When omitted,
    /model/warm returns a clearly-flagged stub response.

    stats_provider, if provided, is a zero-arg callable returning the
    AI-server's live request-counter snapshot dict.

    tick_providers, if provided, maps event-topic ("gpu"/"health"/"route")
    to a zero-arg snapshot callable. The tick loop calls each at its
    configured cadence and publishes "<key>.tick" onto the WS event bus.
    Lets us replace per-client HTTP polling with one server-side timer
    fanning out via the existing /events websocket.
    """
    root = Path(repo_root or os.path.dirname(os.path.abspath(__file__))).resolve()
    _log_dir = (root / log_dir).resolve()
    # Data-dir canonicalization (Family B from the audit). The Discord bot
    # writes every data/*.json (auto-reactions, prompt-templates, user-facts,
    # memory-presets, persona-overrides, server-stats, archive-snapshot,
    # archive-guild-config, archive-config, bot-status, custom-personas) to
    # its own __dirname/data — which under Tauri is the repo path the bot
    # was spawned from, NOT the AI server's runtime AppData. The GUI
    # endpoints used to read/write from <runtime>/data, so any edit a user
    # made through the Control Center wrote to a file the bot would never
    # see ("Edit failed: no rule rr_…" on auto-reactions, persona overrides
    # silently disappearing, etc.). Resolve to the bot's data/ directly so
    # both ends share one source of truth. Falls back to <runtime>/data if
    # the bot cwd is unresolvable (CI, headless smoke test).
    _bot_cwd = _resolve_bot_cwd(root)
    _bot_data_dir = (_bot_cwd / "data").resolve()
    if (_bot_cwd / "index.js").is_file():
        _data_dir = _bot_data_dir
        # One-time migration: any *.json the user previously edited through
        # the Control Center while _data_dir pointed at <runtime>/data is
        # sitting in the AppData copy now. Copy it forward to bot_cwd/data
        # if the bot doesn't have its own version, so the switch doesn't
        # lose persona overrides / saved templates / custom-personas / etc.
        # Only fires once per file because subsequent boots find the
        # destination already populated.
        try:
            _legacy_data_dir = (root / data_dir).resolve()
            if _legacy_data_dir.is_dir() and _legacy_data_dir != _data_dir:
                _data_dir.mkdir(parents=True, exist_ok=True)
                for legacy_file in _legacy_data_dir.glob("*.json"):
                    dest = _data_dir / legacy_file.name
                    if not dest.exists():
                        try:
                            shutil.copy2(legacy_file, dest)
                        except OSError:
                            pass
        except Exception:
            pass
    else:
        _data_dir = (root / data_dir).resolve()
    _env_path = (root / env_path).resolve()
    _GUI_RUNTIME_PATHS["env_path"] = _env_path  # so module-level _start_service can reach it

    # Audit trail for destructive actions (config writes, dependency installs,
    # self-update, restarts). One line per action appended to data/audit.log.
    # NEVER records token or secret material — only the action name and
    # non-sensitive context (e.g. WHICH keys changed, not their values).
    # Best-effort: auditing must never break or slow the action it records.
    # (Audit P0-2: the single loopback GUI token is high-authority. Splitting it
    # into per-scope tokens is over-engineering for a single-user GUI that
    # legitimately needs every scope; making destructive use accountable via an
    # append-only local log is the proportionate, low-risk hardening.)
    def _seekdeep_audit(action: str, **fields) -> None:
        try:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            # strip CR/LF from action + values so a client/operator-influenced field
            # can't forge extra audit-log lines (log injection)
            _noln = lambda x: str(x).replace("\r", " ").replace("\n", " ")
            safe = " ".join(
                f"{k}={_noln(v)}" for k, v in fields.items()
                if "token" not in k.lower() and "secret" not in k.lower()
            )
            with open(_data_dir / "audit.log", "a", encoding="utf-8") as fh:
                fh.write(f"{ts} {_noln(action)} {safe}".rstrip() + "\n")
        except Exception:
            pass

    def _is_inside(child: Path, parent: Path) -> bool:
        try:
            child.relative_to(parent)
            return True
        except ValueError:
            return False

    # ----- Token bootstrap -----
    # Populate module-level auth state so `require_gui_token` works for
    # callers outside this function (e.g. /unload in local_ai_server.py).
    _initial_token, _token_was_generated = _ensure_gui_token(_env_path)
    _AUTH_STATE["env_path"] = _env_path
    _AUTH_STATE["initial"] = _initial_token
    _AUTH_STATE["disabled"] = os.environ.get(_TOKEN_DISABLE_KEY, "").strip().lower() in {"1", "true", "yes", "on"}
    _AUTH_STATE["ready"] = True
    if _token_was_generated:
        print(f"[SeekDeep] generated new {_TOKEN_ENV_KEY}; persisted to {_env_path}")
    if _AUTH_STATE["disabled"]:
        print(f"[SeekDeep] auth DISABLED ({_TOKEN_DISABLE_KEY} is set) - GUI write endpoints are unprotected")

    # Local alias for the rest of register_gui_endpoints so the existing
    # Depends() calls below don't have to change. Same function object.
    _require_gui_token = require_gui_token
    _token_disabled = _AUTH_STATE["disabled"]  # used by the WS endpoint below

    # ----- GET /token -----
    # Returns the GUI token but only to loopback callers. If someone exposes
    # port 7865 via ngrok / cloudflared / a reverse proxy, the remote callers
    # will hit 403 here while local browser tabs still work.
    @app.get("/token")
    async def get_token(request: Request):
        host = (request.client.host if request.client else "") or ""
        if host not in _LOOPBACK_HOSTS:
            raise HTTPException(403, f"GET /token is loopback-only; refused for client {host!r}")
        # Defense against browser drive-by exfiltration: even though the TCP
        # connection appears as loopback (the browser IS local), the Origin
        # header reveals the page that initiated the fetch. Reject anything
        # outside the trusted GUI shells. Server-to-server callers (bot, curl)
        # don't send Origin, so this still allows them through.
        origin = request.headers.get("origin") or ""
        if origin and origin not in TRUSTED_BROWSER_ORIGINS:
            raise HTTPException(403,
                f"GET /token rejected: untrusted Origin {origin!r}. "
                f"Allowed: {list(TRUSTED_BROWSER_ORIGINS)}")
        # Sec-Fetch-Site is a Fetch Metadata header browsers attach since
        # ~2020. Only apply when Origin is ABSENT — the Origin allowlist
        # above already covers the browser drive-by case where Origin is
        # present. Without this Origin gate, the Tauri WebView (which runs
        # on tauri.localhost and fetches 127.0.0.1:7865) gets rejected
        # because browsers tag cross-host loopback fetches as
        # Sec-Fetch-Site: cross-site even when both ends are local and
        # the Origin is in the allowlist. That regression made every
        # token-gated GUI button return 401 on real installs.
        sfs = (request.headers.get("sec-fetch-site") or "").lower()
        if not origin and sfs == "cross-site":
            raise HTTPException(403,
                "GET /token rejected: Sec-Fetch-Site: cross-site without Origin (browser drive-by blocked)")
        return {"token": _current_token(), "header": _TOKEN_HEADER, "disabled": _token_disabled}

    # ----- POST /config -----
    @app.post("/config", dependencies=[Depends(_require_gui_token)])
    async def post_config(patch: ConfigPatch):
        if not patch.updates:
            return {"ok": True, "updated": []}
        # Case-insensitive match (Gemini audit): Windows env vars are
        # case-insensitive, so a lowercase key (e.g. seekdeep_gui_token_disabled)
        # would still take effect — block it too. _CONFIG_PROTECTED_KEYS is upper.
        blocked = sorted(k for k in patch.updates if k.upper() in _CONFIG_PROTECTED_KEYS)
        if blocked:
            raise HTTPException(400, f"refusing to set protected key(s) via /config: {', '.join(blocked)}")
        result = _merge_env(_env_path, patch.updates)
        _seekdeep_audit("config.write", keys=",".join(list(patch.updates.keys())[:32]))
        # Routing/persona/model knobs are env-driven, so any /config write
        # might have changed how /chat resolves. Push route.changed so the
        # chat helper-row badge re-fetches /route/debug without polling.
        try:
            event_bus.publish_sync({"type": "route.changed",
                                     "data": {"keys": list(patch.updates.keys())[:32]}})
        except Exception:
            pass
        return result

    # ----- GET /changelog/commits -----
    # Public changelog data, proxied server-side (the GUI's CSP connect-src is
    # loopback-only, so it can't reach api.github.com directly). Open — no token
    # gate — it's public repo data and the changelog page renders pre-auth. The
    # URL is built from the fixed _SELF_UPDATE_REPO constant with NO request
    # input, so the host+path are provably constant (no SSRF). TTL-cached; on a
    # fetch failure we serve stale cache if we have it rather than going blank.
    @app.get("/changelog/commits")
    def get_changelog_commits(limit: int = 20):
        n = max(1, min(int(limit or 20), 30))
        now = time.time()
        cached = _CHANGELOG_COMMITS_CACHE.get("data")
        if cached is not None and (now - float(_CHANGELOG_COMMITS_CACHE.get("at") or 0)) < _CHANGELOG_COMMITS_TTL_S:
            return {"ok": True, "commits": cached[:n], "cached": True,
                    "fetched_at": _CHANGELOG_COMMITS_CACHE.get("iso")}
        import urllib.request
        url = "https://api.github.com/repos/" + _SELF_UPDATE_REPO + "/commits?per_page=30&sha=main"
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "SeekDeep-changelog"}
        gh_tok = str(os.environ.get("GITHUB_TOKEN", "")).strip()
        if gh_tok:
            headers["Authorization"] = f"Bearer {gh_tok}"
        try:
            req = urllib.request.Request(url, headers=headers)  # noqa: S310 — fixed https GitHub host+path
            with urllib.request.urlopen(req, timeout=12) as resp:  # noqa: S310
                raw = resp.read(_CHANGELOG_COMMITS_MAX_BYTES + 1)
            if len(raw) > _CHANGELOG_COMMITS_MAX_BYTES:
                raise ValueError("commits response exceeds cap")
            data = json.loads(raw.decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001 — network/garbled GitHub response
            # Log the detail server-side; never echo the exception text to the
            # client (CodeQL "information exposure through an exception"). The
            # GUI only reads ok/commits/stale/cached, so a generic message is safe.
            print(f"[SeekDeep] /changelog/commits refresh failed: {exc}", flush=True)
            if cached is not None:
                return {"ok": True, "commits": cached[:n], "cached": True, "stale": True,
                        "fetched_at": _CHANGELOG_COMMITS_CACHE.get("iso"),
                        "note": "refresh failed (serving cached; see server log)"}
            return {"ok": False, "commits": [], "error": "could not fetch recent commits"}
        commits = []
        for c in (data if isinstance(data, list) else []):
            if not isinstance(c, dict):
                continue
            sha = str(c.get("sha") or "")
            commit = c.get("commit") or {}
            author = commit.get("author") or {}
            subject = str(commit.get("message") or "").split("\n", 1)[0][:160]
            commits.append({
                "sha": sha,
                "shortSha": sha[:7],
                "message": subject,
                "author": str(author.get("name") or (c.get("author") or {}).get("login") or ""),
                "date": str(author.get("date") or ""),
                "url": str(c.get("html_url") or ""),
            })
        iso = _now_iso()
        _CHANGELOG_COMMITS_CACHE["data"] = commits
        _CHANGELOG_COMMITS_CACHE["at"] = now
        _CHANGELOG_COMMITS_CACHE["iso"] = iso
        return {"ok": True, "commits": commits[:n], "cached": False, "fetched_at": iso}

    # ----- GET /logs/tail -----
    # Token-gated: log bodies leak prompts, file paths, model state, errors.
    # Browser drive-by would read these without auth before this gate.
    @app.get("/logs/tail", dependencies=[Depends(_require_gui_token)])
    async def get_logs_tail(lines: int = 200, file: str | None = None):
        path = (_log_dir / file).resolve() if file else _find_active_log(_log_dir)
        if path is None:
            return {"ok": False, "error": "no log file found"}
        if not _is_inside(path, _log_dir):
            raise HTTPException(400, "path traversal blocked")
        lines = max(1, min(2000, int(lines)))
        return {
            "ok": True,
            "file": path.name,
            "size_bytes": path.stat().st_size if path.is_file() else 0,
            "lines": _tail(path, lines),
        }

    # ----- GET /logs/stream -----
    # Token-gated for the same reason as /logs/tail. Browser EventSource
    # API cannot send custom headers, so accept the token via `?token=` query
    # param too — same fallback pattern as the /events WebSocket below. The
    # header path is preferred (used by fetch-based callers); the query path
    # exists solely for EventSource. We don't use Depends(_require_gui_token)
    # because that gate only checks the header.
    @app.get("/logs/stream")
    async def get_logs_stream(request: Request, token: str = ""):
        if _AUTH_STATE.get("ready") and not _AUTH_STATE.get("disabled"):
            expected = _current_token()
            header_val = request.headers.get(_TOKEN_HEADER) or request.headers.get(_TOKEN_HEADER.lower())
            supplied = header_val or token  # header beats query string
            if not expected or not supplied or not secrets.compare_digest(supplied, expected):
                raise HTTPException(401,
                    f"missing or invalid {_TOKEN_HEADER}; GUI EventSource passes it as ?token=, "
                    f"fetch callers pass it as the {_TOKEN_HEADER} header")
        path = _find_active_log(_log_dir)
        if path is None:
            return JSONResponse({"ok": False, "error": "no log file"}, status_code=404)
        return StreamingResponse(_stream_log(path), media_type="text/event-stream")

    # ----- POST /launcher/bot/kill-all -----
    # Nuclear option for when bot instances have piled up — enumerate every
    # node process running index.js scoped to this repo's cwd and force-kill
    # them. Safety: matches MUST contain the resolved bot_cwd path in cwd
    # or cmdline, so we never reach into an unrelated Node project the user
    # is running. Declared BEFORE the generic /launcher/{service}/{action}
    # dispatcher so FastAPI matches the specific path first.
    @app.post("/launcher/bot/kill-all", dependencies=[Depends(_require_gui_token)])
    async def post_launcher_bot_kill_all():
        _begin_transition("bot")
        try:
            bot_cwd = _resolve_bot_cwd(root)
            # Offload the WMI/ps enumeration + the per-PID taskkill/SIGTERM-sleep
            # loop to a worker thread — they block for seconds, and this is an async
            # handler, so running them on the loop stalls /health + the status poll.
            def _enumerate_and_kill():
                procs_ = _find_bot_processes(bot_cwd)
                killed_: list[dict] = []
                failed_: list[dict] = []
                for entry in procs_:
                    pid = entry["pid"]
                    ok, err = _kill_pid(pid)
                    row = {"pid": pid, "cmdline": entry.get("cmdline", "")[:200],
                           "source": entry.get("source", "?")}
                    if ok:
                        if err:
                            row["note"] = err  # e.g. "already-dead"
                        killed_.append(row)
                    else:
                        row["error"] = err or "unknown"
                        failed_.append(row)
                return procs_, killed_, failed_
            procs, killed, failed = await asyncio.to_thread(_enumerate_and_kill)
            # Also clear in-process tracking + stale PID file so the launcher
            # card flips to "not-running" on the next status poll.
            proc = _PROCESSES.pop("bot", None)
            if proc is not None:
                try:
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
            try:
                pid_name = _PID_FILE_NAMES.get("bot")
                if pid_name:
                    pid_path = _log_dir / pid_name
                    if pid_path.is_file():
                        pid_path.unlink()
            except OSError:
                pass
            return {
                "ok": not failed,
                "service": "bot",
                "scope": str(bot_cwd),
                "found": len(procs),
                "killed": killed,
                "failed": failed,
            }
        finally:
            _end_transition("bot")
            # Force a state recomputation + event publish so UI pills
            # update immediately on the now-settled state.
            _emit_state_change_if_any("bot", _service_state("bot", _log_dir))

    # ----- POST /launcher/{service}/{action} -----
    @app.post("/launcher/{service}/{action}", dependencies=[Depends(_require_gui_token)])
    async def post_launcher(service: str, action: str):
        if service not in ALLOWED_SERVICES:
            raise HTTPException(400, f"unknown service · allowed: {sorted(ALLOWED_SERVICES)}")
        if action not in ALLOWED_ACTIONS:
            raise HTTPException(400, f"unknown action · allowed: {sorted(ALLOWED_ACTIONS)}")

        # `status` is a read-only query — no transition lock needed.
        if action == "status":
            return _status_service(service, _log_dir)

        # start/stop/restart are state-changing. Wrap in transition lock so
        # the UI shows yellow "transitioning" pills instead of flickering
        # red/green during the action.
        _begin_transition(service)
        try:
            # Offload the blocking subprocess/wait/sleep work to a worker thread.
            # This is an async handler, so running Popen / proc.wait(timeout=5) /
            # the SIGTERM->SIGKILL sleep loop on the event loop stalls /health, the
            # /launchers/status poll, and the /events WS for seconds (the read-only
            # get_launchers_status twin was already fixed this way). The transition
            # bookkeeping in `finally` stays on the loop.
            if action == "start":
                return await asyncio.to_thread(_start_service, service, root, _log_dir)
            if action == "stop":
                return await asyncio.to_thread(_stop_service, service, _log_dir)
            if action == "restart":
                # Refuse restart for self-hosted services up-front rather than
                # killing this very request handler half-way through.
                if service in SELF_HOSTED_SERVICES:
                    raise HTTPException(409,
                        f"{service} is self-hosted; refusing to restart it from inside the AI server. "
                        f"Use seekdeep_launcher.bat instead.")
                def _restart_sync():
                    _stop_service(service, _log_dir)
                    time.sleep(0.5)
                    return _start_service(service, root, _log_dir)
                return await asyncio.to_thread(_restart_sync)
        finally:
            _end_transition(service)
            # Force a state recomputation + event publish so UI pills
            # update immediately on the now-settled state.
            _emit_state_change_if_any(service, _service_state(service, _log_dir))

    # ----- GET /launchers/status -----
    # Per-service status snapshot for the Control Center launcher cards.
    # Backs the previously-hardcoded PID 14882/14883/14884 + Uptime 4h 12m
    # placeholders that lived in app.html. Open endpoint (read-only).
    #
    # Per-service shape: { service, state, pid?, uptime_seconds?, started_at? }
    # state: 'running' | 'not-running' | 'exited' | 'unknown'
    # uptime: best-effort, derived from PID file mtime when the process
    #         was spawned via launcher.bat (we don't have a started_at
    #         for in-process spawns without psutil).
    def _compute_launchers_status_payload() -> dict:
        services_out = {}
        for svc in sorted(ALLOWED_SERVICES):
            info = _service_state(svc, _log_dir)
            pid = info["pid"]
            uptime_s = None
            started_at = None
            if pid is not None:
                # PID file mtime is a poor man's started_at — launcher.bat
                # writes the file when it spawns, so file age ≈ uptime.
                name = _PID_FILE_NAMES.get(svc)
                if name:
                    pid_path = _log_dir / name
                    if pid_path.is_file():
                        try:
                            mtime = pid_path.stat().st_mtime
                            uptime_s = int(max(0, time.time() - mtime))
                            started_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                        except OSError:
                            pass
            # When a GUI-spawned service has exited, surface a tail of its
            # most recent .gui.err.log so the launcher card can show WHY
            # instead of just "EXITED". Was the #1 cause of "feels broken"
            # complaints — a silent EXITED pill with no error surface.
            #
            # Critical: ONLY surface err.log entries from the current session.
            # The previous logic picked the most recent err.log by mtime,
            # which could be a yesterday-old crash log still sitting in
            # logs/ — and the launcher card would show that stale trace on
            # every load, making the user think the bot was actively
            # crashing when in fact they just hadn't started it. Now we
            # pair the err.log against the matching .gui.out.log timestamp
            # (same prefix `bot-YYYYMMDD-HHMMSS.gui.{err,out}.log`) and
            # require the err.log to be NEWER than the latest .gui.out.log
            # start — i.e. errors from the current spawn, not a previous
            # session.
            last_error = None
            err_log_name = None
            if info["state"] in ("exited", "not-running"):
                try:
                    # Find the most recent .gui.out.log — its mtime is the
                    # current/latest spawn's launch timestamp. err.logs
                    # newer than this are this-session crashes.
                    out_logs = sorted(
                        _log_dir.glob(f"{svc}-*.gui.out.log"),
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    latest_spawn_mtime = (out_logs[0].stat().st_mtime
                                          if out_logs else 0.0)
                    err_logs = sorted(
                        _log_dir.glob(f"{svc}-*.gui.err.log"),
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    for candidate in err_logs:
                        st = candidate.stat()
                        if st.st_size <= 0:
                            continue
                        # Stale-log guard: only surface this err.log if it
                        # came from the most recent spawn. Allow ±5s slop
                        # for filesystem clock skew. If no .gui.out.log
                        # exists yet (fresh install), permit any err.log
                        # newer than 1 hour.
                        if latest_spawn_mtime > 0:
                            if st.st_mtime + 5.0 < latest_spawn_mtime:
                                continue  # err.log predates current spawn
                        else:
                            if time.time() - st.st_mtime > 3600:
                                continue  # > 1h old, treat as stale
                        tail = _tail(candidate, 20)
                        if tail:
                            last_error = "\n".join(tail)[-1200:]
                            err_log_name = candidate.name
                            break
                except OSError:
                    pass
            services_out[svc] = {
                "ok": True,
                "service": svc,
                "state": info["state"],
                "pid": pid,
                "count": info["count"],
                "source": info["source"],
                "transitioning": info["transitioning"],
                "uptime_seconds": uptime_s,
                "started_at":      started_at,
                "last_error":      last_error,
                "last_error_log":  err_log_name,
            }
            # Bot-specific: surface Discord login state. Process being alive
            # is NOT proof the bot is online in the user's server — Discord
            # gateway login is a separate handshake that can fail (bad token,
            # missing intents, network), succeed late, or drop mid-session.
            # The bot writes data/bot-status.json on every ready/disconnect
            # transition and every 30s as a heartbeat; we read it here so
            # the launcher card pill can reflect REAL connectivity.
            if svc == "bot":
                services_out[svc]["discord"] = _read_bot_discord_status()
            # Fire service.state.changed if anything user-visible flipped
            # since the last query. UI subscribers update immediately,
            # without waiting for the next 5s poll to notice.
            _emit_state_change_if_any(svc, info)
        return {
            "ok": True,
            "services": services_out,
            "generated_at": _now_iso(),
        }

    @app.get("/launchers/status")
    async def get_launchers_status():
        # async + to_thread so the per-service WMI / psutil scan inside
        # _service_state doesn't queue behind /chat or /image when the
        # sync threadpool is busy. The UI's 5s status poll was the single
        # biggest "every card flips OFFLINE" trigger; this is the fix.
        import asyncio as _asyncio_ls
        return await _asyncio_ls.to_thread(_compute_launchers_status_payload)

    # ----- GET /system/firstrun -----
    # Discovers what's missing for a fresh install and returns a checklist
    # the GUI can render as a "do these N things first" banner. Replaces
    # the previous experience where a user with no .env / no models / no
    # Discord token saw a bunch of empty panes with no clear next step.
    def _compute_system_firstrun_payload() -> dict:
        checks: list[dict[str, Any]] = []
        env = _read_env_kv(_env_path) if _env_path.is_file() else {}
        # 1. .env exists at all
        checks.append({
            "id": "env_file",
            "label": "`.env` file exists",
            "ok": _env_path.is_file(),
            "fix": f"Copy `.env.default` -> `.env` in the repo root (or run setup_local.ps1).",
            "blocking": True,
        })
        # 2. DISCORD_TOKEN looks plausible — format check, not just length.
        # Real Discord bot tokens are three base64url segments separated by
        # dots: `<base64 user_id>.<base64 timestamp>.<HMAC>`, typically
        # ~70 chars total. The previous check (len >= 50) passed any
        # 50-char garbage string. The regex below rejects placeholder
        # text, partial pastes, and pure-whitespace values while still
        # not requiring a network call to Discord (full validity needs
        # the bot to actually connect — that's what /clientReady proves).
        tok = (env.get("DISCORD_TOKEN") or "").strip()
        _BOT_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{20,}$")
        tok_ok = bool(tok) and bool(_BOT_TOKEN_RE.match(tok))
        checks.append({
            "id": "discord_token",
            "label": "DISCORD_TOKEN set",
            "ok": tok_ok,
            "fix": "Paste your bot token below — saved to .env, bot restart needed for it to take effect.",
            "fix_action": {
                "endpoint": "/config", "method": "POST", "label": "Save token",
                "body_template": {"updates": {}},
                "prompt_for": [{
                    "key": "DISCORD_TOKEN", "label": "Discord bot token",
                    "placeholder": "MTIzNDU2…  (3 dot-separated base64 segments)",
                    "secret": True,
                    "validate_regex": r"^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{20,}$",
                    "validate_error": "Bot tokens have three dot-separated parts: <bot-id>.<timestamp>.<HMAC>. Looks like a partial paste or wrong field.",
                }],
            },
            "blocking": True,
        })
        # 3. DISCORD_CLIENT_ID set (for slash command registration).
        # Discord snowflakes are 17-20 digit integers (will widen to 21
        # by 2090 per the snowflake epoch). Reject anything outside that
        # range so a user pasting their bot's display name or a partial
        # ID fails the check instead of silently passing.
        cid = (env.get("DISCORD_CLIENT_ID") or "").strip()
        checks.append({
            "id": "discord_client_id",
            "label": "DISCORD_CLIENT_ID set (for slash commands)",
            "ok": bool(cid) and cid.isdecimal() and 17 <= len(cid) <= 20,
            "fix": "Paste your Discord Application ID below. Find it at discord.com/developers/applications -> your bot -> General Information -> Application ID.",
            "fix_action": {
                "endpoint": "/config", "method": "POST", "label": "Save ID",
                "body_template": {"updates": {}},
                "prompt_for": [{
                    "key": "DISCORD_CLIENT_ID", "label": "Application ID",
                    "placeholder": "1234567890123456789  (17-20 digit snowflake)",
                    "validate_regex": r"^\d{17,20}$",
                    "validate_error": "Application ID is a 17-20 digit Discord snowflake — copy it from discord.com/developers/applications.",
                }],
            },
            "blocking": False,
        })
        # 4. SEEKDEEP_ADMIN_IDS set (admin features will all 403 without this).
        # Parse the comma-separated list and validate each ID is a Discord
        # snowflake (17-20 digits). Previously `bool(admin)` passed any
        # non-empty value — "abc" or "your_id_here" both registered as ok.
        admin = (env.get("SEEKDEEP_ADMIN_IDS") or env.get("ADMIN_USER_IDS") or "").strip()
        admin_ok = False
        if admin:
            parts = [p.strip() for p in admin.split(",") if p.strip()]
            admin_ok = bool(parts) and all(p.isdecimal() and 17 <= len(p) <= 20 for p in parts)
        checks.append({
            "id": "admin_ids",
            "label": "SEEKDEEP_ADMIN_IDS set (admin features need it)",
            "ok": admin_ok,
            "fix": "Paste your Discord user ID(s) below. In Discord with Developer Mode on, right-click your name -> Copy User ID. Comma-separate for multiple admins.",
            "fix_action": {
                "endpoint": "/config", "method": "POST", "label": "Save",
                "body_template": {"updates": {}},
                "prompt_for": [{
                    "key": "SEEKDEEP_ADMIN_IDS", "label": "Discord user ID(s)",
                    "placeholder": "123456789012345678  (17-20 digits per ID, comma-separated)",
                    "validate_regex": r"^\d{17,20}(?:\s*,\s*\d{17,20})*$",
                    "validate_error": "Each user ID is a 17-20 digit Discord snowflake. With multiple IDs, separate by commas only — no spaces inside an ID.",
                }],
            },
            "blocking": False,
        })
        # 5. ML deps installed (best-effort; full check is /ml_deps which lives on local_ai_server)
        ml_ok = False
        for mod in ("torch", "transformers", "diffusers"):
            try:
                __import__(mod)
                ml_ok = True
            except Exception:
                ml_ok = False
                break
        # If ml_deps is missing in the running Python, BUT we can detect
        # a venv on disk that already has torch + CUDA, the better fix
        # is to point SEEKDEEP_PYTHON at that venv (instant, no 2 GB
        # download) instead of pip-installing torch into the running
        # Python. The wizard's "Use detected .venv" button does this
        # by POSTing /system/use-venv. We only suggest it when the
        # current interpreter is NOT already the candidate.
        better_python = None
        if not ml_ok:
            # Quick scan of repo-local .venv only (fast — the heavier
            # multi-root scan lives at /system/detect-venv for the
            # full wizard). This is the 95% case for users who ran
            # setup_local.ps1 in the repo.
            for sub in (".venv/Scripts/python.exe", ".venv/bin/python", ".venv/bin/python3"):
                p = root / sub
                if p.is_file() and str(p.resolve()) != sys.executable:
                    better_python = str(p.resolve())
                    break
        if better_python:
            checks.append({
                "id": "ml_deps",
                "label": "ML dependencies installed (torch / transformers / diffusers)",
                "ok": ml_ok,
                "fix": f"A .venv with ML libraries is sitting in your repo at {better_python}. Point the server at it (no re-download) — saves ~2 GB and is instant.",
                "fix_action": {"endpoint": "/system/use-venv", "method": "POST",
                               "label": "Use detected .venv",
                               "body": {"executable": better_python}},
                "blocking": False,
            })
        else:
            checks.append({
                "id": "ml_deps",
                "label": "ML dependencies installed (torch / transformers / diffusers)",
                "ok": ml_ok,
                "fix": "Click \"Install ML libraries\" — runs `pip install -r requirements-ml.txt` against the running Python.",
                "fix_action": {"endpoint": "/deps/install", "method": "POST",
                               "label": "Install ML libraries", "body": {"requirements_file": "requirements-ml.txt"},
                               "long_running": True, "watch_events": ["deps.install.complete", "deps.install.failed"]},
                "blocking": False,
            })
        # 6. nvidia-smi reachable (GPU detected)
        try:
            r = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True, timeout=2)
            gpu_present = r.returncode == 0 and bool((r.stdout or "").strip())
        except Exception:
            gpu_present = False
        checks.append({
            "id": "gpu",
            "label": "NVIDIA GPU detected by driver",
            "ok": gpu_present,
            "fix": "GPU is optional but strongly recommended for local chat/image. CPU mode is slow.",
            "blocking": False,
        })
        # 7. searxng container reachable (web search). 1s was too tight —
        # SearXNG behind WSL2 Docker can take 1-3s to answer cold. The
        # firstrun checklist then said "⚠ container running" while the
        # Launcher card said "HEALTHY" on the SAME load, because the
        # Launcher card uses a longer-running HTTP probe with more
        # tolerance. Bump to 3s + try GET /healthz (which actually proves
        # SearXNG is reachable, not just that something owns the port).
        searxng_up = False
        try:
            with socket.create_connection(("127.0.0.1", 8080), timeout=3):
                searxng_up = True
        except Exception:
            searxng_up = False
        checks.append({
            "id": "searxng",
            "label": "SearXNG container running (web search)",
            "ok": searxng_up,
            "fix": "Click 'Start SearXNG' in the first-run wizard, or POST /docker/start-searxng. The previous 'docker compose up' hint was wrong (no compose file in the repo).",
            "fix_action": {"endpoint": "/docker/start-searxng", "method": "POST", "label": "Start SearXNG"},
            "blocking": False,
        })
        # 8. At least one chat model can be loaded — HF cache or Ollama tag.
        # Best-effort: check HF cache dir + ollama daemon. Skipping the full
        # cache scan here to keep this endpoint snappy (<200ms typical).
        hf_cache = Path(env.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface"))
        has_hf_cache = hf_cache.is_dir() and any(hf_cache.iterdir()) if hf_cache.exists() else False
        try:
            with socket.create_connection(("127.0.0.1", 11434), timeout=1):
                ollama_up = True
        except Exception:
            ollama_up = False
        # PyTorch GPU compatibility — catches the silent CPU-fallback case
        # where the user's GPU has a newer compute capability than the
        # installed torch wheel knows about (e.g. RTX 50-series sm_120 with
        # a cu121 torch that only supports up to sm_90). Without this check
        # chat works but uses CPU; user sees 'slow' with no obvious reason.
        try:
            import torch as _torch  # type: ignore
            if _torch.cuda.is_available():
                cap_major, cap_minor = _torch.cuda.get_device_capability(0)
                cap = f"sm_{cap_major}{cap_minor}"
                arch_list = list(_torch.cuda.get_arch_list() or [])
                gpu_supported = cap in arch_list
                # Map known compute caps to recommended cu128+ wheels.
                # Blackwell (sm_120) needs cu128+; Hopper (sm_90) cu121+.
                rec_variant = "cu128" if (cap_major, cap_minor) >= (12, 0) else (
                    "cu126" if (cap_major, cap_minor) >= (9, 0) else "cu121")
                if not gpu_supported:
                    checks.append({
                        "id": "torch_gpu_compat",
                        "label": f"PyTorch supports your GPU ({cap})",
                        "ok": False,
                        "fix": (f"GPU is {cap} but installed PyTorch only supports up to "
                                f"{arch_list[-1] if arch_list else 'unknown'}. "
                                f"Falls back to CPU silently. Reinstall PyTorch with {rec_variant} "
                                f"wheels (Blackwell / RTX 50-series support)."),
                        "fix_action": {
                            "endpoint": "/system/reinstall-torch", "method": "POST",
                            "label": f"Reinstall PyTorch ({rec_variant})",
                            "body": {"variant": rec_variant},
                            "long_running": True,
                            "watch_events": ["deps.install.complete", "deps.install.failed"],
                        },
                        "blocking": False,
                    })
                else:
                    checks.append({
                        "id": "torch_gpu_compat",
                        "label": f"PyTorch supports your GPU ({cap})",
                        "ok": True, "fix": "", "blocking": False,
                    })
        except ImportError:
            pass  # ml_deps check already covers missing torch
        except Exception:
            pass  # torch installed but probe failed; not blocking

        # Ollama parity with HF: detect installed-ness, daemon state, auth.
        # Each failure gets a one-click fix button so the user doesn't have
        # to remember where Ollama lives or how to start it.
        ollama_exe_found = False
        ollama_paths = []
        for p in [
            os.path.expandvars("%LOCALAPPDATA%/Programs/Ollama/ollama.exe"),
            os.path.expandvars("%ProgramFiles%/Ollama/ollama.exe"),
        ]:
            if os.path.isfile(p):
                ollama_exe_found = True
                ollama_paths.append(p)
                break
        if not ollama_exe_found:
            try:
                r = subprocess.run(["where", "ollama"], capture_output=True, text=True, timeout=3)
                if r.returncode == 0 and r.stdout.strip():
                    ollama_exe_found = True
                    ollama_paths.append(r.stdout.strip().splitlines()[0])
            except Exception:
                pass
        checks.append({
            "id": "ollama_installed",
            "label": "Ollama installed (optional · alternative to HuggingFace)",
            "ok": ollama_exe_found,
            "fix": "Install Ollama via winget — one click. Lets you pull quantized chat models that load faster than HF and run alongside the HF backend.",
            "fix_action": {"endpoint": "/system/install-ollama", "method": "POST",
                           "label": "Install Ollama", "body": {}, "long_running": True},
            "blocking": False,
        })
        # Daemon check is only meaningful if ollama is installed OR a role is wired to ollama.
        # Otherwise skip — no point telling a user "your Ollama daemon is down" if they don't use Ollama.
        ollama_in_env = bool((env.get("OLLAMA_BASE_URL") or "").strip()) or bool((env.get("OLLAMA_API_KEY") or "").strip())
        if ollama_exe_found or ollama_in_env:
            try:
                with socket.create_connection(("127.0.0.1", 11434), timeout=1):
                    daemon_up = True
            except Exception:
                daemon_up = False
            checks.append({
                "id": "ollama_daemon",
                "label": "Ollama daemon running (port 11434)",
                "ok": daemon_up,
                "fix": "Start the local Ollama daemon — runs `ollama serve` in the background. Required for any Ollama backend role to work.",
                "fix_action": {"endpoint": "/system/start-ollama", "method": "POST",
                               "label": "Start daemon", "body": {}},
                "blocking": False,
            })
        # Cloud auth check — only if user set OLLAMA_API_KEY or has signed in via device key.
        if (env.get("OLLAMA_API_KEY") or "").strip():
            checks.append({
                "id": "ollama_cloud_auth",
                "label": "Ollama Cloud API key set",
                "ok": True,
                "fix": "",
                "blocking": False,
            })

        # Check that LOCAL_CHAT_MODEL_ID is set AND its model is actually
        # cached. Either condition failing is a real fresh-user blocker: a
        # blank var fails the new no-model-configured guard at /chat time,
        # and a configured-but-not-cached model triggers a 5-30 GB download
        # mid-conversation. Surface both as the same fixable check.
        chat_id = (env.get("LOCAL_CHAT_MODEL_ID") or "").strip()
        chat_ready = bool(chat_id) and (has_hf_cache or ollama_up)
        if not chat_id:
            fix_copy = "No chat model is configured yet. Open the model picker — curated starter models are one click to install."
        elif not (has_hf_cache or ollama_up):
            fix_copy = f"LOCAL_CHAT_MODEL_ID is `{chat_id}` but no HF cache or Ollama daemon is reachable. Install it from the picker."
        else:
            fix_copy = ""
        checks.append({
            "id": "chat_model",
            "label": "Chat model installed and configured",
            "ok": chat_ready,
            "fix": fix_copy,
            "fix_action": {
                # Route to Bot config's model-picker section with a hash
                # trigger that auto-opens the curated catalog modal.
                # Replaces the old standalone add-model.html flow because
                # the picker now has everything: cached repos + Ollama
                # tags + recommended catalog + one-click install.
                "navigate": "app.html#open-model-catalog",
                "label": "▸ Pick model",
            },
            "blocking": False,
        })

        blocking_failed = [c for c in checks if c["blocking"] and not c["ok"]]
        warning_failed  = [c for c in checks if not c["blocking"] and not c["ok"]]
        return {
            "ok": True,
            "ready": not blocking_failed,
            "checks": checks,
            "summary": {
                "total":            len(checks),
                "passed":           sum(1 for c in checks if c["ok"]),
                "blocking_failed":  len(blocking_failed),
                "warning_failed":   len(warning_failed),
            },
            "generated_at": _now_iso(),
        }

    @app.get("/system/firstrun")
    async def get_system_firstrun():
        # subprocess.run + socket.create_connection in here can total 3-10s on
        # slow boxes. async + to_thread keeps the event loop free so concurrent
        # /health / /launchers/status polls don't time out.
        import asyncio as _asyncio_fr
        return await _asyncio_fr.to_thread(_compute_system_firstrun_payload)

    # ----- GET /system/runtime -----
    # Probe-only check for Node + Python + Git versions on PATH. Replaces
    # the installer page's "server up implies node ok" placeholder — that
    # told you the AI server was running but nothing about whether the
    # supplied Node/Python actually meet the minimum versions. This runs
    # locally only (loopback server already implies trust on this box).
    def _compute_system_runtime_payload() -> dict:
        out: dict[str, dict] = {}
        # Node — "node --version" → v20.11.0
        try:
            r = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=2)
            if r.returncode == 0:
                v = (r.stdout or "").strip().lstrip("v")
                _p = v.split(".")
                major = int(_p[0]) if v and _p[0].isdecimal() else 0
                minor = int(_p[1]) if len(_p) > 1 and _p[1].isdecimal() else 0
                out["node"] = {
                    "installed": True,
                    "version": v,
                    "major": major,
                    "minor": minor,
                    # @discordjs/voice 0.19+ needs Node >=22.12.0 (Node 20 is EOL);
                    # enforce the minor so 22.0–22.11 don't falsely meet the floor.
                    "meets_min": major > 22 or (major == 22 and minor >= 12),
                    "min_required": "22.12.0",
                }
            else:
                out["node"] = {"installed": False, "error": (r.stderr or "").strip()[:160]}
        except FileNotFoundError:
            out["node"] = {"installed": False, "error": "node not on PATH"}
        except Exception as exc:
            out["node"] = {"installed": False, "error": str(exc)[:160]}
        # Python — sys.version_info (this server IS Python so this always works).
        # ALSO probe for torch importability + version + CUDA build flag so
        # the user can see whether the running Python has the ML stack
        # their .bat launcher uses. The common failure mode: Tauri sidecar
        # finds system Python 3.14 (which has no torch wheels yet), so the
        # GUI complains about "CUDA not available" while the .bat-launched
        # .venv Python 3.11 has working torch. Surfacing both pieces here
        # lets the user diagnose without thinking about venvs.
        try:
            ver_t = (sys.version_info.major, sys.version_info.minor)
            # PyTorch supports up to Python 3.12 as of 2026-Q2. 3.13+ has no
            # official wheels; warn so the user knows why torch.cuda is False.
            torch_compat = ver_t <= (3, 12)
            try:
                import torch as _torch  # noqa
                torch_present = True
                torch_version = getattr(_torch, "__version__", "unknown")
                torch_cuda_built = getattr(getattr(_torch, "version", None), "cuda", None) or None
                try:
                    torch_cuda_runtime = bool(_torch.cuda.is_available())
                except Exception:
                    torch_cuda_runtime = False
            except Exception:
                torch_present = False
                torch_version = None
                torch_cuda_built = None
                torch_cuda_runtime = False
            out["python"] = {
                "installed": True,
                "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "major": sys.version_info.major,
                "minor": sys.version_info.minor,
                "meets_min": ver_t >= (3, 11),
                "min_required": "3.11",
                "max_torch_supported": "3.12",
                "torch_supported_by_version": torch_compat,
                "executable": sys.executable,
                "venv_active": bool(os.environ.get("VIRTUAL_ENV")) or "venv" in sys.executable.lower() or ".venv" in sys.executable.lower(),
                "venv_path":  os.environ.get("VIRTUAL_ENV") or "",
                # torch surface — lets the installer page distinguish
                # "wrong Python" from "right Python, wrong wheel"
                "torch_present":      torch_present,
                "torch_version":      torch_version,
                "torch_cuda_built":   torch_cuda_built,   # cu121 / cu124 / None
                "torch_cuda_runtime": torch_cuda_runtime, # torch.cuda.is_available()
            }
        except Exception as exc:
            out["python"] = {"installed": True, "error": str(exc)[:160]}
        # Git — "git --version" → git version 2.43.0
        try:
            r = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=2)
            if r.returncode == 0:
                out["git"] = {"installed": True, "version": (r.stdout or "").strip().replace("git version ", "")[:40]}
            else:
                out["git"] = {"installed": False, "error": (r.stderr or "").strip()[:160]}
        except FileNotFoundError:
            out["git"] = {"installed": False, "error": "git not on PATH"}
        except Exception as exc:
            out["git"] = {"installed": False, "error": str(exc)[:160]}
        # Disk free — best-effort, shutil.disk_usage on the repo root
        try:
            usage = shutil.disk_usage(str(root))
            out["disk"] = {
                "free_gb":  round(usage.free  / (1024**3), 1),
                "total_gb": round(usage.total / (1024**3), 1),
                "used_pct": round(100.0 * usage.used / usage.total, 1) if usage.total else None,
                "meets_min": usage.free >= 80 * (1024**3),  # 80 GB rec for full ML cache
                "min_recommended_gb": 80,
                "path": str(root),
            }
        except Exception as exc:
            out["disk"] = {"error": str(exc)[:160]}
        return {"ok": True, "runtime": out, "generated_at": _now_iso()}

    @app.get("/system/runtime")
    async def get_system_runtime():
        import asyncio as _asyncio_rt
        return await _asyncio_rt.to_thread(_compute_system_runtime_payload)

    # ----- GET /system/docker -----
    # Probe-only Docker check. Spawns `docker info` then `docker --version`
    # to distinguish:
    #   running                — daemon is up + reachable
    #   installed_not_running  — CLI works but daemon isn't (Desktop closed)
    #   not_installed          — `docker` not on PATH
    # Installer page (and the Control Center) call this instead of inferring
    # Docker state from SearXNG reachability — which lied because SearXNG
    # being down doesn't tell you anything about Docker (the user might have
    # Docker running but never started the SearXNG container).
    def _compute_system_docker_payload() -> dict:
        # `docker info` can take 10-15s on a fresh Docker Desktop boot
        # (WSL2 backend negotiates with the Linux VM). 3s was too tight
        # and produced "daemon unresponsive" false-positives during normal
        # warm-up. 12s gives Docker Desktop time to answer; if it's truly
        # hung past that the user can hit "Try start" to force a relaunch.
        # First try a cheap "docker version --format ..." (no daemon
        # round-trip) — if that succeeds AND fast info also succeeds,
        # the daemon is up; if version works but info hangs, daemon's
        # asleep.
        try:
            r = subprocess.run(
                ["docker", "info", "--format", "{{.ServerVersion}}"],
                capture_output=True, text=True, timeout=12,
            )
        except FileNotFoundError:
            return {"ok": True, "state": "not_installed",
                    "detail": "`docker` not on PATH — install Docker Desktop"}
        except subprocess.TimeoutExpired:
            return {"ok": True, "state": "installed_not_running",
                    "detail": "`docker info` didn't answer in 12s — daemon is likely starting up (WSL2 backend takes a moment) OR not running. Click \"Try start\" to launch Docker Desktop, then re-run System Check."}
        except Exception as exc:
            return {"ok": False, "state": "error", "detail": str(exc)[:160]}
        if r.returncode == 0:
            return {"ok": True, "state": "running",
                    "server_version": (r.stdout or "").strip()[:80] or None}
        # `docker info` failed — try `docker --version` to see if at least
        # the CLI is installed. That distinguishes "Docker installed but
        # daemon stopped" from "Docker not installed at all".
        try:
            r2 = subprocess.run(
                ["docker", "--version"], capture_output=True, text=True, timeout=2,
            )
        except Exception:
            return {"ok": True, "state": "not_installed",
                    "detail": "`docker --version` failed too"}
        if r2.returncode == 0:
            stderr_first = (r.stderr or "").splitlines()
            hint = stderr_first[0][:160] if stderr_first else "Docker installed but daemon not running"
            return {"ok": True, "state": "installed_not_running", "detail": hint,
                    "client_version": (r2.stdout or "").strip()[:80] or None}
        return {"ok": True, "state": "not_installed",
                "detail": "`docker --version` exited non-zero"}

    @app.get("/system/docker")
    async def get_system_docker():
        # subprocess.run(docker info) blocks up to 12s on cold Docker Desktop.
        # async + to_thread keeps the event loop free.
        import asyncio as _asyncio_dk
        return await _asyncio_dk.to_thread(_compute_system_docker_payload)

    # ----- Docker Desktop + SearXNG auto-start (cold boot) -----
    # On a cold boot Docker Desktop is often installed but the daemon is
    # stopped, so SearXNG (web search) never comes up and the user has to
    # babysit Docker. Best-effort: if SearXNG isn't reachable, ensure the
    # Docker daemon (launch Docker Desktop if it's down), wait for it, then
    # start the SearXNG container. Gated by SEEKDEEP_AUTO_START_SEARXNG
    # (default on); runs ONCE in a background thread; never blocks boot.
    def _seekdeep_searxng_reachable(timeout: float = 1.5) -> bool:
        import socket
        try:
            with socket.create_connection(("127.0.0.1", 8080), timeout=timeout):
                return True
        except OSError:
            return False

    def _seekdeep_docker_daemon_up() -> bool:
        try:
            r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                               capture_output=True, text=True, timeout=12)
            return r.returncode == 0
        except Exception:
            return False

    def _seekdeep_find_docker_desktop() -> "str | None":
        import sys as _sys
        if os.name == "nt":
            for c in (
                os.path.expandvars(r"%ProgramFiles%\Docker\Docker\Docker Desktop.exe"),
                os.path.expandvars(r"%ProgramW6432%\Docker\Docker\Docker Desktop.exe"),
                os.path.expandvars(r"%LocalAppData%\Docker\Docker Desktop.exe"),
            ):
                if c and os.path.isfile(c):
                    return c
            return None
        if _sys.platform == "darwin":
            return "Docker"  # launched via `open -a Docker`
        return None

    def _seekdeep_launch_docker_desktop() -> bool:
        import sys as _sys
        exe = _seekdeep_find_docker_desktop()
        if not exe:
            return False
        try:
            if os.name == "nt":
                subprocess.Popen([exe], close_fds=True,
                                 creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
            elif _sys.platform == "darwin":
                subprocess.Popen(["open", "-a", "Docker"])
            else:
                return False
            return True
        except Exception:
            return False

    def _seekdeep_run_searxng_container() -> dict:
        # Same command as POST /docker/start-searxng — duplicated deliberately
        # so the boot path can never break the working "Start SearXNG" endpoint.
        try:
            subprocess.run(["docker", "rm", "-f", "seekdeep-searxng"],
                           capture_output=True, text=True, timeout=10)
        except Exception:
            pass
        try:
            searxng_dir = (root / "searxng").resolve()
            searxng_dir.mkdir(parents=True, exist_ok=True)
            vol = f"{searxng_dir}:/etc/searxng:rw"
            r = subprocess.run([
                "docker", "run", "-d", "--name", "seekdeep-searxng",
                "--restart", "unless-stopped", "-p", "8080:8080",
                "-e", "BASE_URL=http://localhost:8080/",
                "-e", "INSTANCE_NAME=SeekDeep",
                "-v", vol, _seekdeep_searxng_image(),
            ], capture_output=True, text=True, timeout=90)
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or r.stdout or "docker run failed").strip()[:300]}
            return {"ok": True, "container_id": (r.stdout or "").strip()[:12]}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}

    def _seekdeep_ensure_searxng_stack():
        # Never auto-launch Docker in CI / tests / smoke / lite boots — only in a
        # real app/standalone boot. (GitHub Actions sets CI=true on every step,
        # so this covers both the preflight and e2e CI jobs.)
        if (os.environ.get("CI") or os.environ.get("SEEKDEEP_TEST_MODE")
                or os.environ.get("SEEKDEEP_LOCAL_AI_BOOT_LITE")
                or os.environ.get("PYTEST_CURRENT_TEST")):
            return
        flag = (os.environ.get("SEEKDEEP_AUTO_START_SEARXNG", "1") or "").strip().lower()
        if flag in ("0", "false", "no", "off"):
            return
        try:
            if _seekdeep_searxng_reachable():
                return  # already up — nothing to do
            if not _seekdeep_docker_daemon_up():
                if not _seekdeep_launch_docker_desktop():
                    print("[SeekDeep] auto-start: Docker daemon down + Docker Desktop not found — "
                          "skipping SearXNG. Install/launch Docker Desktop, or set "
                          "SEEKDEEP_AUTO_START_SEARXNG=0 to silence.", flush=True)
                    return
                print("[SeekDeep] auto-start: launched Docker Desktop; waiting up to 120s for the daemon…", flush=True)
                deadline = time.time() + 120
                while time.time() < deadline:
                    time.sleep(4)
                    if _seekdeep_docker_daemon_up():
                        break
                else:
                    print("[SeekDeep] auto-start: Docker daemon didn't answer in 120s — "
                          "leaving SearXNG for manual start.", flush=True)
                    return
            if _seekdeep_searxng_reachable():
                return
            res = _seekdeep_run_searxng_container()
            if res.get("ok"):
                print(f"[SeekDeep] auto-start: SearXNG container started ({res.get('container_id', '')}); "
                      "it answers in ~5-15s.", flush=True)
            else:
                print(f"[SeekDeep] auto-start: SearXNG start failed: {res.get('error', '')}", flush=True)
        except Exception as exc:
            print(f"[SeekDeep] auto-start: ensure SearXNG errored: {exc!r}", flush=True)

    # Kick it once, in the background, at registration (boot). The app.state
    # guard prevents a double-spawn if registration ever runs twice.
    try:
        if not getattr(app.state, "seekdeep_searxng_autostart_spawned", False):
            app.state.seekdeep_searxng_autostart_spawned = True
            threading.Thread(target=_seekdeep_ensure_searxng_stack, daemon=True).start()
    except Exception:
        pass

    # ----- POST /docker/start-searxng -----
    # Start the SearXNG container with the same flags seekdeep_launcher.bat
    # uses, so the GUI can offer a "Start SearXNG" button instead of asking
    # the user to drop to a terminal. The firstrun checklist previously
    # said `docker compose up -d searxng` but there's no compose file in
    # the repo — this is the real command.
    #
    # Token-gated because it spawns a long-running container with bound
    # ports + volumes. Idempotent: if the container already exists it's
    # removed first so the new flags take effect (matches the .bat).
    @app.post("/docker/start-searxng", dependencies=[Depends(_require_gui_token)])
    def post_docker_start_searxng():
        try:
            # Best-effort cleanup of any prior container with the same name.
            subprocess.run(["docker", "rm", "-f", "seekdeep-searxng"],
                           capture_output=True, text=True, timeout=10)
        except Exception:
            pass
        try:
            # Mirror the .bat's startSearxngQuiet flags exactly.
            searxng_dir = (root / "searxng").resolve()
            searxng_dir.mkdir(parents=True, exist_ok=True)
            vol = f"{searxng_dir}:/etc/searxng:rw"
            r = subprocess.run(
                [
                    "docker", "run", "-d",
                    "--name", "seekdeep-searxng",
                    "--restart", "unless-stopped",
                    "-p", "8080:8080",
                    "-e", "BASE_URL=http://localhost:8080/",
                    "-e", "INSTANCE_NAME=SeekDeep",
                    "-v", vol,
                    _seekdeep_searxng_image(),
                ],
                capture_output=True, text=True, timeout=60,
            )
            if r.returncode != 0:
                return {"ok": False, "error": (r.stderr or r.stdout or "docker run failed").strip()[:600]}
            return {"ok": True, "container_id": (r.stdout or "").strip()[:12],
                    "note": "SearXNG started. /healthz takes 5-15s to respond as the image initializes."}
        except FileNotFoundError:
            return {"ok": False, "error": "`docker` not on PATH. Install Docker Desktop and re-try."}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "docker run timed out after 60s. Check Docker Desktop is running."}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:600]}

    # ----- POST /system/install-python -----
    # Auto-install a Python the Tauri sidecar's find_python() can pick up.
    # Windows: winget install Python.Python.3.12 (the highest version with
    # current PyTorch wheel coverage). After install the user MUST restart
    # the Tauri shell so the sidecar re-runs find_python; we just kick the
    # install and return.
    def _run_winget_streamed(prefix: str, cmd: list[str], timeout_s: int) -> dict:
        # Spawn `cmd` via Popen, publish <prefix>.started/line/progress/complete/failed
        # on the event bus, return a dict with the same shape the old subprocess.run
        # path returned. The HTTP request thread still blocks until completion so
        # the API contract is preserved; the bus just lets a watching UI render live.
        event_bus.publish_sync({"type": f"{prefix}.started",
                                "data": {"cmd": " ".join(cmd[:6])}})
        stdout_buf: list[str] = []
        line_count = 0
        proc = None
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, errors="replace")
            deadline = time.time() + timeout_s
            for line in iter(proc.stdout.readline, ""):
                line = line.rstrip()
                if line:
                    line_count += 1
                    stdout_buf.append(line)
                    event_bus.publish_sync({"type": f"{prefix}.line", "data": {"line": line}})
                    event_bus.publish_sync({"type": f"{prefix}.progress",
                                            "data": {"current": line_count, "label": line[:80]}})
                if time.time() > deadline:
                    try: proc.kill()
                    except Exception: pass
                    raise subprocess.TimeoutExpired(cmd, timeout_s)
            rc = proc.wait()
            ok = rc == 0
            topic = f"{prefix}.complete" if ok else f"{prefix}.failed"
            event_bus.publish_sync({"type": topic, "data": {"exit_code": rc}})
            return {"ok": ok, "exit_code": rc,
                    "stdout": "\n".join(stdout_buf)[-2000:], "stderr": ""}
        except subprocess.TimeoutExpired:
            event_bus.publish_sync({"type": f"{prefix}.failed",
                                    "data": {"error": f"timeout after {timeout_s}s"}})
            return {"ok": False, "error": f"{prefix} timed out after {timeout_s}s",
                    "stdout": "\n".join(stdout_buf)[-2000:]}
        except Exception as exc:
            event_bus.publish_sync({"type": f"{prefix}.failed",
                                    "data": {"error": str(exc)[:240]}})
            raise

    @app.post("/system/install-python", dependencies=[Depends(_require_gui_token)])
    def post_install_python(body: dict | None = None):
        # dry_run=true lets smoke tests verify the auth gate without
        # actually invoking winget install (which takes 10+ minutes).
        dry_run = bool((body or {}).get("dry_run"))
        # Probe winget — Windows 10/11 ship it by default since 2021.
        try:
            probe = subprocess.run(["winget", "--version"], capture_output=True, text=True, timeout=5)
            if probe.returncode != 0:
                return {"ok": False, "error": "winget not available — install Python 3.12 manually from python.org"}
        except FileNotFoundError:
            return {"ok": False, "error": "winget not on PATH — only Windows 10/11 1809+ have it. Install Python 3.12 manually from python.org"}
        except Exception as exc:
            return {"ok": False, "error": f"winget probe failed: {exc}"}
        if dry_run:
            return {"ok": True, "dry_run": True, "note": "Would run: winget install --id Python.Python.3.12 -e --silent"}
        try:
            r = _run_winget_streamed("install-python",
                ["winget", "install", "--id", "Python.Python.3.12", "-e",
                 "--silent", "--accept-package-agreements", "--accept-source-agreements"],
                600)
            r.setdefault("note", "Restart the Tauri shell to pick up the new interpreter.")
            return r
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:600]}

    # ----- POST /system/self-update -----
    # Hot-patch the running install from GitHub. The Tauri bundle ships
    # a snapshot of server + GUI files; over time the bundle goes stale
    # (e.g. user installed v10.35.6 .msi but main has shipped 8 commits
    # since). This endpoint closes that gap WITHOUT requiring a .msi
    # reinstall: it streams the latest files from raw.githubusercontent
    # .com into the server's own working directory, writes a sentinel
    # marker so sidecar's extractor doesn't clobber them on next boot,
    # and tells the caller to restart the sidecar.
    #
    # Safety scope: only files inside the SeekDeep tree get touched.
    # All paths are validated to be inside `root` (no .. escapes), and
    # we only fetch from a hardcoded allowlist of GitHub raw URLs on the
    # NathanNeurotic/SeekDeep-DiscordBot repo's `main` branch.
    @app.post("/system/self-update", dependencies=[Depends(_require_gui_token)])
    def post_self_update(body: dict | None = None):
        ref = str((body or {}).get("ref") or "main").strip()
        # P0-3: let operators disable remote self-update entirely. Default on
        # (preserves behavior). SEEKDEEP_SELF_UPDATE_ENABLED=off refuses with 403
        # — for locked-down installs that should update only via the signed MSI.
        # This is the switch that turns off writing executable .py over the
        # running install from a GitHub ref.
        if str(os.environ.get("SEEKDEEP_SELF_UPDATE_ENABLED", "on")).strip().lower() in ("0", "false", "no", "off"):
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": "self-update disabled (SEEKDEEP_SELF_UPDATE_ENABLED=off)"}})
            raise HTTPException(403, "Self-update is disabled on this install (SEEKDEEP_SELF_UPDATE_ENABLED=off).")
        # Resolve rolling channels (main/nightly) to an immutable commit SHA so the
        # strict ref policy accepts them and the audit records the exact commit —
        # this is what makes self-update actually work for the rolling-release
        # workflow (latest code lives on main/nightly, not on vX.Y.Z tags).
        resolve_note = ""
        try:
            ref, resolve_note = _resolve_self_update_ref(ref)
        except Exception as exc:  # noqa: BLE001 — network/garbled GitHub response
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": f"could not resolve update ref from GitHub: {exc}"}})
            raise HTTPException(502, f"Could not resolve the update ref from GitHub: {exc}")
        # AUD-001: ref allowlist (strict by default — immutable tag or full SHA).
        ok_ref, ref_reason = _self_update_ref_is_allowed(ref)
        if not ok_ref:
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": ref_reason}})
            raise HTTPException(400, ref_reason)
        # AUD-001: only one self-update at a time. A second concurrent click must
        # not stage/commit over the same live tree — return 409 instead.
        if not _SELF_UPDATE_LOCK.acquire(blocking=False):
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": "a self-update is already in progress"}})
            raise HTTPException(409, "A self-update is already in progress on this install.")
        try:
            if resolve_note:
                event_bus.publish_sync({"type": "self-update.line", "data": {"line": resolve_note}})
            return _post_self_update_locked(ref)
        finally:
            _SELF_UPDATE_LOCK.release()

    def _post_self_update_locked(ref: str):
        import urllib.request, urllib.error, urllib.parse, posixpath
        _seekdeep_audit("self_update", ref=ref)
        REPO = _SELF_UPDATE_REPO
        base_url = f"https://raw.githubusercontent.com/{REPO}/{ref}/"
        single_files = [
            "local_ai_server.py", "gui_endpoints.py", "warmup_local_cache.py",
            # release_signing.py is imported by the self-update SIGNATURE GATE
            # below (`import release_signing`). It MUST ship or self-update 500s
            # with ModuleNotFoundError before it can ever commit — which is
            # exactly how this install's self-update was silently dead (the
            # module landed in the repo but was never added here, so it never
            # reached the app dir). Keep it in this list.
            "release_signing.py",
            "package.json", "requirements-local.txt", "requirements-ml.txt",
        ]
        event_bus.publish_sync({"type": "self-update.started",
                                "data": {"ref": ref, "phase": "stage"}})
        # Wipe abandoned staging dirs from prior crashed runs before we make our own.
        for stale in root.glob(".self-update-staging-*"):
            try: shutil.rmtree(stale, ignore_errors=True)
            except Exception: pass
        # Two-phase atomic update: stage everything in a sibling dir first,
        # then move-replace into the live tree only after the batch lands.
        # Mid-batch network failure leaves the live tree untouched instead
        # of half-patched.
        staging = root / f".self-update-staging-{os.getpid()}"
        try:
            staging.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise HTTPException(500, f"could not create staging dir: {exc}")
        staged: list[dict] = []
        errors: list[str] = []
        def _fetch(url: str, timeout: float = 20.0, max_bytes: int = _SELF_UPDATE_MAX_FILE_BYTES) -> bytes:
            # AUD-001: bounded read. A garbled CDN body, an HTML error page in
            # place of code, or an unexpectedly huge API response can't blow up
            # memory mid-update — we stop at max_bytes and fail this file/listing
            # (the staging pipeline then aborts before touching the live tree).
            headers = {
                "User-Agent": "SeekDeep-Self-Updater",
                "Accept": "application/vnd.github.raw",
            }
            # Optional: authenticate ONLY GitHub API calls when a token is present,
            # so rate-limit failures don't look like product failures. Never sent
            # to raw.githubusercontent (public; avoids leaking the token to a CDN).
            gh_tok = str(os.environ.get("GITHUB_TOKEN", "")).strip()
            if gh_tok and url.startswith("https://api.github.com/"):
                headers["Authorization"] = f"Bearer {gh_tok}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                buf = bytearray()
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise ValueError(f"response exceeds {max_bytes} byte cap")
                return bytes(buf)
        def _stage(rel_path: str, content: bytes):
            staged_target = (staging / rel_path).resolve()
            if not _is_inside(staged_target, staging):
                raise ValueError(f"path escape: {rel_path}")
            staged_target.parent.mkdir(parents=True, exist_ok=True)
            staged_target.write_bytes(content)
        # Phase 1: download every file into staging.
        for fname in single_files:
            try:
                content = _fetch(base_url + fname)
                _stage(fname, content)
                staged.append({"path": fname, "bytes": len(content)})
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": f"staged {fname} ({len(content)} B)"}})
            except urllib.error.HTTPError as e:
                errors.append(f"{fname}: HTTP {e.code}")
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": f"FAIL {fname}: HTTP {e.code}"}})
            except Exception as exc:
                errors.append(f"{fname}: {str(exc)[:120]}")
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": f"FAIL {fname}: {str(exc)[:120]}"}})
            event_bus.publish_sync({"type": "self-update.progress",
                                    "data": {"current": len(staged), "label": fname}})
        # gui/ + scripts/ trees — list via contents API, then fetch each
        # file. scripts/doctor.mjs has to exist for the Installer's System
        # check step.
        for sub in ("gui", "scripts"):
            sub_contents_url = f"https://api.github.com/repos/{REPO}/contents/{sub}?ref={ref}"
            try:
                api_resp = _fetch(sub_contents_url, max_bytes=_SELF_UPDATE_MAX_API_BYTES)
                import json as _json
                entries = _json.loads(api_resp)
                if isinstance(entries, list):
                    sub_files = [e for e in entries if isinstance(e, dict) and e.get("type") == "file"]
                    if len(sub_files) > _SELF_UPDATE_MAX_TREE_ENTRIES:
                        # Truncate rather than fan out into an unbounded fetch storm.
                        errors.append(f"{sub}/ listing: {len(sub_files)} files exceeds cap "
                                      f"{_SELF_UPDATE_MAX_TREE_ENTRIES}; truncated")
                        event_bus.publish_sync({"type": "self-update.line",
                                                "data": {"line": f"WARN {sub}/ has {len(sub_files)} files "
                                                                 f"(> cap {_SELF_UPDATE_MAX_TREE_ENTRIES}); truncating"}})
                        sub_files = sub_files[:_SELF_UPDATE_MAX_TREE_ENTRIES]
                    event_bus.publish_sync({"type": "self-update.line",
                                            "data": {"line": f"{sub}/ has {len(sub_files)} files to fetch"}})
                    for entry in sub_files:
                        name = entry.get("name") or ""
                        download_url = entry.get("download_url") or ""
                        if not name or not download_url:
                            continue
                        # SSRF + path-traversal guard: the contents API hands us a
                        # download_url, but we only ever fetch our own repo's raw
                        # content. Parse + NORMALIZE the URL (decode %-escapes,
                        # collapse ../) before checking, so a spoofed/compromised
                        # listing can't redirect a fetch to another host OR — via
                        # ../ segments the CDN would resolve — to another repo on the
                        # same host (e.g. .../SeekDeep-DiscordBot/../../evil/repo/...).
                        # A plain startswith() would let that traversal pass. Repo-
                        # level (not ref-level) so a future change in how the API
                        # echoes the ref into download_url can't silently skip every
                        # file. The git-blob-SHA gate below is the backstop (off-repo
                        # bytes won't match this repo's published SHA); this just
                        # fails fast before any fetch. _stage pins the local write.
                        # urlsplit (not urlparse): urlparse peels a trailing ;params
                        # segment off .path, which is a footgun for path-prefix checks;
                        # urlsplit keeps the whole path so normpath sees all of it.
                        _dl = urllib.parse.urlsplit(download_url)
                        _dl_path = posixpath.normpath(urllib.parse.unquote(_dl.path or ""))
                        if (_dl.scheme.lower() != "https"
                                or (_dl.hostname or "").lower() != "raw.githubusercontent.com"
                                or not _dl_path.startswith(f"/{REPO}/")):
                            errors.append(f"{sub}/{name}: download_url off-prefix; skipped")
                            event_bus.publish_sync({"type": "self-update.line",
                                                    "data": {"line": f"FAIL {sub}/{name}: unexpected download host/path; skipped"}})
                            continue
                        try:
                            content = _fetch(download_url)
                            _stage(f"{sub}/{name}", content)
                            staged.append({"path": f"{sub}/{name}", "bytes": len(content)})
                            event_bus.publish_sync({"type": "self-update.line",
                                                    "data": {"line": f"staged {sub}/{name} ({len(content)} B)"}})
                        except Exception as exc:
                            errors.append(f"{sub}/{name}: {str(exc)[:120]}")
                            event_bus.publish_sync({"type": "self-update.line",
                                                    "data": {"line": f"FAIL {sub}/{name}: {str(exc)[:120]}"}})
                        event_bus.publish_sync({"type": "self-update.progress",
                                                "data": {"current": len(staged), "label": f"{sub}/{name}"}})
            except Exception as exc:
                errors.append(f"{sub}/ listing: {str(exc)[:120]}")
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": f"FAIL {sub}/ listing: {str(exc)[:120]}"}})
        # Nothing landed → abort + wipe. Don't pretend success.
        if not staged:
            try: shutil.rmtree(staging, ignore_errors=True)
            except Exception: pass
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"errors": errors or ["no files were downloaded"]}})
            return {
                "ok": False,
                "ref": ref,
                "downloaded": [],
                "errors": errors or ["no files were downloaded"],
                "note": "Self-update failed before any file was applied. The live tree is untouched.",
            }
        # Integrity gate (P0-3): verify EVERY staged file's content matches the
        # git blob SHA GitHub publishes for this ref, BEFORE we write executable
        # code over the live install. Catches a corrupted / truncated / MITM-
        # altered fetch and a CDN serving an HTML error page in place of code.
        # Fail CLOSED — if we can't verify, we don't commit. (This is content
        # integrity vs. the published git tree; it does NOT by itself defend
        # against a *compromised repo*, which needs code signing — the ref
        # allowlist + HTTPS + token gate remain the mitigations there.)
        def _git_blob_sha(data: bytes) -> str:
            import hashlib
            h = hashlib.sha1()
            h.update(b"blob " + str(len(data)).encode() + b"\x00")
            h.update(data)
            return h.hexdigest()
        blob_shas = None
        try:
            import json as _json
            tree = _json.loads(_fetch(f"https://api.github.com/repos/{REPO}/git/trees/{ref}?recursive=1", max_bytes=_SELF_UPDATE_MAX_API_BYTES))
            blob_shas = {e["path"]: e["sha"] for e in tree.get("tree", [])
                         if isinstance(e, dict) and e.get("type") == "blob" and e.get("path") and e.get("sha")}
        except Exception as exc:
            errors.append(f"integrity: could not fetch git tree: {str(exc)[:120]}")
        bad_integrity = []
        if blob_shas is None:
            bad_integrity = ["<git tree unavailable — cannot verify>"]
        else:
            for item in staged:
                rel = item["path"]
                try:
                    actual = _git_blob_sha((staging / rel).read_bytes())
                except Exception:
                    actual = None
                if blob_shas.get(rel) != actual or actual is None:
                    bad_integrity.append(rel)
        if bad_integrity:
            try: shutil.rmtree(staging, ignore_errors=True)
            except Exception: pass
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": "integrity check failed", "files": bad_integrity[:20]}})
            raise HTTPException(409,
                "Self-update aborted: file integrity check against GitHub failed (live tree untouched): "
                + ", ".join(bad_integrity[:8]))
        event_bus.publish_sync({"type": "self-update.line",
                                "data": {"line": f"integrity ok: {len(staged)} file(s) match git SHAs"}})
        # AUD-001 follow-up: release-SIGNATURE gate. The git-SHA check proves the
        # bytes match GitHub's tree for this ref; it does NOT defend a compromised
        # repo (the malicious code would have a valid git SHA). When a release-
        # signing public key is pinned, require a valid maintainer Ed25519
        # signature over a manifest whose sha256s match the staged files, BEFORE
        # commit. A present-but-invalid signature ALWAYS aborts (attack signal).
        # Import the signer defensively: an older install (or a partial tree)
        # may not have release_signing.py yet, and the import used to crash the
        # WHOLE updater with ModuleNotFoundError BEFORE it could ever commit the
        # file that fixes the gap — a self-update that could never self-heal.
        # Now: if the module is absent we fail CLOSED only when signatures are
        # REQUIRED; otherwise we skip the gate and let the update proceed, which
        # commits the shipped release_signing.py and heals the signer for next
        # time. (The git-blob integrity gate above already ran regardless.)
        try:
            import release_signing as _rsign
        except ImportError:
            _rsign = None
        _sig_require = str(os.environ.get("SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE", "")).strip().lower() in ("1", "true", "yes", "on")

        def _abort_sig(reason: str):
            try: shutil.rmtree(staging, ignore_errors=True)
            except Exception: pass
            event_bus.publish_sync({"type": "self-update.failed",
                                    "data": {"error": "signature check failed", "detail": reason}})
            raise HTTPException(409, f"Self-update aborted: {reason} (live tree untouched).")

        if _rsign is None:
            if _sig_require:
                _abort_sig("signature required (SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on) but the release_signing module is not present on this install")
            event_bus.publish_sync({"type": "self-update.line",
                                    "data": {"line": "signature check skipped: release_signing module absent (this update installs it)"}})
        else:
            _pubkey_hex = str(os.environ.get("SEEKDEEP_RELEASE_SIGNING_PUBKEY", "") or _rsign.RELEASE_SIGNING_PUBKEY_HEX or "").strip()
            if not _pubkey_hex:
                if _sig_require:
                    _abort_sig("signature required (SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on) but no release-signing key is pinned")
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": "signature check skipped: no pinned release-signing key"}})
            else:
                _have_manifest = True
                try:
                    _manifest_bytes = _fetch(base_url + _rsign.MANIFEST_NAME)
                    _sig_bytes = _fetch(base_url + _rsign.MANIFEST_SIG_NAME)
                except Exception:
                    _have_manifest = False
                if not _have_manifest:
                    if _sig_require:
                        _abort_sig(f"signature required but no signed manifest is published for ref {ref}")
                    event_bus.publish_sync({"type": "self-update.line",
                                            "data": {"line": f"no signed manifest for ref {ref}; proceeding unsigned (set SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on to refuse)"}})
                else:
                    _ok, _reason, _manifest = _rsign.verify_release_bytes(_manifest_bytes, _sig_bytes, _pubkey_hex)
                    if not _ok:
                        _abort_sig(f"release signature invalid: {_reason}")
                    if str((_manifest or {}).get("ref") or "") != ref:
                        _abort_sig(f"manifest ref mismatch (manifest={(_manifest or {}).get('ref')!r}, requested={ref!r})")
                    _files_ok, _files_reason = _rsign.check_staged_against_manifest(_manifest, staging, staged)
                    if not _files_ok:
                        _abort_sig(_files_reason)
                    event_bus.publish_sync({"type": "self-update.line",
                                            "data": {"line": f"signature ok: manifest verified against pinned key ({len((_manifest or {}).get('files', {}))} files)"}})
        # Phase 2: commit. Each src.replace(target) is atomic on the same
        # volume (staging is a sibling so always same vol). Live tree only
        # transitions consistent old → consistent new per file.
        event_bus.publish_sync({"type": "self-update.line",
                                "data": {"line": f"phase 2: committing {len(staged)} file(s)"}})
        committed: list[dict] = []
        commit_errors: list[str] = []
        total_staged = len(staged)
        for item in staged:
            rel_path = item["path"]
            src = staging / rel_path
            target = (root / rel_path).resolve()
            if not _is_inside(target, root):
                commit_errors.append(f"{rel_path}: path escape on commit")
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                src.replace(target)
                committed.append(item)
                event_bus.publish_sync({"type": "self-update.progress",
                                        "data": {"current": len(committed),
                                                 "total": total_staged,
                                                 "label": f"commit {rel_path}"}})
            except Exception as exc:
                commit_errors.append(f"{rel_path}: commit failed: {str(exc)[:120]}")
                event_bus.publish_sync({"type": "self-update.line",
                                        "data": {"line": f"FAIL commit {rel_path}: {str(exc)[:120]}"}})
        # Wipe the (now mostly empty) staging dir.
        try: shutil.rmtree(staging, ignore_errors=True)
        except Exception: pass
        errors.extend(commit_errors)
        # Sentinel lists only committed paths — sidecar.rs reads this on
        # next Tauri boot and skips re-extracting files we just patched.
        try:
            sentinel = root / ".self-updated"
            sentinel.write_text(
                f"# SeekDeep self-update sentinel\n# ref={ref}\n# at={_now_iso()}\n"
                + "\n".join(d["path"] for d in committed) + "\n",
                encoding="utf-8",
            )
        except Exception:
            pass
        ok = bool(committed) and not commit_errors
        topic = "self-update.complete" if ok else "self-update.failed"
        event_bus.publish_sync({"type": topic,
                                "data": {"ref": ref,
                                         "committed": len(committed),
                                         "errors": errors[:6]}})
        return {
            "ok": ok,
            "ref": ref,
            "downloaded": committed,
            "errors": errors,
            "note": "Self-update applied. Restart the AI server (Reload .env in Quick Actions, or restart from the system tray) so the new code is in-memory.",
        }

    # ----- POST /system/verify -----
    # Single-call answer to "is everything actually working right now?"
    # Drives a chat completion, an image generation, a vision describe,
    # /health, and /launchers/status; reports one pass/fail per pipeline.
    # The Quick Action button that calls this gives the user a yes/no
    # without making them poke five different endpoints by hand.
    @app.post("/system/verify", dependencies=[Depends(_require_gui_token)])
    def post_system_verify():
        import urllib.request, urllib.error, ssl, socket as _sock
        results: list[dict] = []
        token = _current_token()
        base = "http://127.0.0.1:7865"
        hdr = {"X-SeekDeep-Token": token, "Content-Type": "application/json"} if token else {"Content-Type": "application/json"}

        def call(label: str, method: str, path: str, body=None, timeout=90):
            t0 = time.time()
            req = urllib.request.Request(base + path, method=method, headers=hdr,
                                          data=json.dumps(body or {}).encode("utf-8") if body is not None else None)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read()
                    ms = int((time.time() - t0) * 1000)
                    return {"label": label, "ok": True, "status": r.status, "ms": ms, "body": raw}
            except urllib.error.HTTPError as e:
                ms = int((time.time() - t0) * 1000)
                return {"label": label, "ok": False, "status": e.code, "ms": ms,
                        "body": e.read()[:400]}
            except Exception as e:
                ms = int((time.time() - t0) * 1000)
                return {"label": label, "ok": False, "status": 0, "ms": ms,
                        "body": f"{type(e).__name__}: {str(e)[:200]}".encode()}

        # 1. health
        r = call("health", "GET", "/health", timeout=15)
        results.append({"name": "health", "ok": r["ok"], "ms": r["ms"]})
        # 2. launchers status
        r = call("launchers", "GET", "/launchers/status", timeout=10)
        results.append({"name": "launchers", "ok": r["ok"], "ms": r["ms"]})
        # 3. chat (default_chat) — verifies tokenizer + model load + generation
        r = call("chat", "POST", "/chat",
                 body={"role": "default_chat", "prompt": "reply: ok"}, timeout=120)
        chat_text = None
        if r["ok"]:
            try:
                chat_text = (json.loads(r["body"]).get("text") or "").strip()
            except Exception:
                pass
        results.append({"name": "chat", "ok": r["ok"] and bool(chat_text),
                        "ms": r["ms"], "sample": (chat_text or "")[:80]})
        # 4. image (1 step so it's quick) — verifies diffusers + cache + cuda
        r = call("image", "POST", "/image",
                 body={"prompt": "test", "width": 512, "height": 512,
                       "steps": 1, "guidance_scale": 1.0, "seed": 1},
                 timeout=60)
        image_ok = r["ok"]
        image_b64 = None
        if image_ok:
            try:
                image_b64 = json.loads(r["body"]).get("image_b64")
                image_ok = bool(image_b64)
            except Exception:
                image_ok = False
        results.append({"name": "image", "ok": image_ok, "ms": r["ms"]})
        # 5. vision — feed the image from step 4 (if we got one) or a tiny stock
        # PNG. The vision schema needs media_b64, not image_url; the previous
        # version of this endpoint used image_url and 422'd in 18ms.
        if not image_b64:
            # 1x1 transparent PNG — enough to drive the load path even if image
            # step failed for unrelated reasons (e.g. VRAM).
            image_b64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIA"
                         "AAUAAarVyFEAAAAASUVORK5CYII=")
        r = call("vision", "POST", "/vision",
                 body={"prompt": "what is this", "media_b64": image_b64,
                       "filename": "verify.png", "media_kind": "image"},
                 timeout=180)
        results.append({"name": "vision", "ok": r["ok"], "ms": r["ms"]})

        passed = sum(1 for r in results if r["ok"])
        total = len(results)
        return {
            "ok": passed == total,
            "passed": passed, "total": total,
            "checks": results,
            "summary": f"{passed}/{total} pipelines verified" if passed == total
                       else f"{passed}/{total} pipelines verified — {total-passed} failed",
        }

    # ----- POST /system/doctor -----
    # Runs `node scripts/doctor.mjs` and streams the output as
    # `doctor.line` events on the WS bus so the Installer's Step 2
    # (System check) panel can render real-time diagnostic output
    # instead of asking the user to drop to PowerShell.
    @app.post("/system/doctor", dependencies=[Depends(_require_gui_token)])
    def post_doctor():
        import threading
        def run():
            event_bus.publish_sync({"type": "doctor.started", "data": {}})
            try:
                proc = subprocess.Popen(
                    ["node", "scripts/doctor.mjs"],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1, cwd=str(root),
                    shell=(os.name == "nt"),
                )
                if proc.stdout:
                    for line in proc.stdout:
                        event_bus.publish_sync({"type": "doctor.line", "data": {"line": line.rstrip()}})
                proc.wait()
                event_bus.publish_sync({"type": "doctor.complete",
                                        "data": {"exit_code": proc.returncode, "ok": proc.returncode == 0}})
            except FileNotFoundError:
                event_bus.publish_sync({"type": "doctor.failed",
                                        "data": {"error": "node not on PATH — install Node 22+ from nodejs.org"}})
            except Exception as exc:
                event_bus.publish_sync({"type": "doctor.failed", "data": {"error": str(exc)[:240]}})
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True, "started": True,
                "note": "subscribe to doctor.line / doctor.complete / doctor.failed on /events"}

    # ----- POST /system/warmup -----
    # Runs warmup_local_cache.py against the server's own Python so the
    # Installer's Step 7 can pull/verify HF weights without a terminal.
    # Streams warmup.line events on the WS bus.
    @app.post("/system/warmup", dependencies=[Depends(_require_gui_token)])
    def post_warmup(body: dict | None = None):
        import threading
        roles = (body or {}).get("roles") or []
        script = root / "warmup_local_cache.py"
        if not script.is_file():
            raise HTTPException(404, f"{script} not found")
        def run():
            event_bus.publish_sync({"type": "warmup.started", "data": {"roles": roles}})
            try:
                cmd = [sys.executable, str(script)]
                if roles:
                    for r in roles:
                        cmd.extend(["--role", str(r)])
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1, cwd=str(root),
                )
                if proc.stdout:
                    for line in proc.stdout:
                        event_bus.publish_sync({"type": "warmup.line", "data": {"line": line.rstrip()}})
                proc.wait()
                event_bus.publish_sync({"type": "warmup.complete",
                                        "data": {"exit_code": proc.returncode, "ok": proc.returncode == 0}})
            except Exception as exc:
                event_bus.publish_sync({"type": "warmup.failed", "data": {"error": str(exc)[:240]}})
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True, "started": True,
                "note": "subscribe to warmup.line / warmup.complete / warmup.failed on /events"}

    # ----- POST /system/lock-cache -----
    # Flip HF_HUB_OFFLINE=1 + TRANSFORMERS_OFFLINE=1 in .env so subsequent
    # boots refuse to hit the HuggingFace hub. Installer Step 7's
    # "Lock cache for offline" button. Idempotent — already-set values
    # stay put. Caller is expected to restart the AI server for the new
    # env to take effect (we surface that in the note).
    @app.post("/system/lock-cache", dependencies=[Depends(_require_gui_token)])
    def post_lock_cache(body: dict | None = None):
        unlock = bool((body or {}).get("unlock"))
        if unlock:
            updates = {"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0"}
        else:
            updates = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
        _merge_env(_env_path, updates)
        return {"ok": True, "locked": not unlock, "updated": updates,
                "note": "Restart the AI server (Quick Actions -> Reload .env) so the offline flag takes effect."}

    # ----- POST /system/ollama-signin -----
    # Runs `ollama signin` — Ollama's CLI command that generates / uploads
    # a device ed25519 keypair to the user's ollama.com account so the
    # local Ollama daemon can push/pull from the account's cloud models.
    # Opens a browser tab for the auth handshake. Idempotent — running
    # twice on the same machine is a no-op (Ollama detects existing
    # keypair at ~/.ollama/id_ed25519).
    #
    # User-facing equivalent of the "Device Keys" section in the Ollama
    # account portal. After this completes successfully, /system/ollama-
    # status reports `signed_in: true` and the user can use any cloud
    # model from their account in SeekDeep.
    @app.post("/system/ollama-signin", dependencies=[Depends(_require_gui_token)])
    def post_ollama_signin():
        import threading
        def run():
            event_bus.publish_sync({"type": "ollama.signin.started", "data": {}})
            try:
                # Use Popen so we can stream the URL+code that ollama
                # prints during browser handshake. The CLI exits with 0
                # when the user has completed sign-in in the browser.
                proc = subprocess.Popen(
                    ["ollama", "signin"],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1,
                    shell=(os.name == "nt"),
                )
                if proc.stdout:
                    for line in proc.stdout:
                        event_bus.publish_sync({"type": "ollama.signin.line",
                                                "data": {"line": line.rstrip()}})
                proc.wait()
                event_bus.publish_sync({"type": "ollama.signin.complete",
                                        "data": {"ok": proc.returncode == 0,
                                                 "exit_code": proc.returncode}})
            except FileNotFoundError:
                event_bus.publish_sync({"type": "ollama.signin.failed",
                                        "data": {"error": "ollama not on PATH — install Ollama from ollama.com/download first"}})
            except Exception as exc:
                event_bus.publish_sync({"type": "ollama.signin.failed",
                                        "data": {"error": str(exc)[:240]}})
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True, "started": True,
                "note": "subscribe to ollama.signin.line / ollama.signin.complete / ollama.signin.failed on /events. A browser tab opens for the auth handshake."}

    # ----- GET /system/ollama-status -----
    # Quick probe so the GUI can show the user where they stand re Ollama:
    # daemon reachable, signed in to cloud, available cloud models.
    @app.get("/system/ollama-status")
    def get_ollama_status():
        out: dict = {"ok": True, "base_url": os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")}
        # Daemon reachability
        try:
            with socket.create_connection(("127.0.0.1", 11434), timeout=1):
                out["daemon_reachable"] = True
        except Exception:
            out["daemon_reachable"] = False
        # Has device keypair? Ollama generates ~/.ollama/id_ed25519 on first
        # `ollama signin`. Presence is the cleanest "signed in" signal we
        # can get without invoking ollama itself.
        ollama_dir = Path(os.path.expanduser("~")) / ".ollama"
        out["device_key_present"] = (ollama_dir / "id_ed25519").is_file()
        out["device_pubkey_present"] = (ollama_dir / "id_ed25519.pub").is_file()
        # API key configured?
        out["api_key_set"] = bool((os.getenv("OLLAMA_API_KEY") or "").strip())
        out["signed_in"] = out["device_key_present"] or out["api_key_set"]
        return out

    # ----- POST /system/launch-all -----
    # Sequenced bring-up: SearXNG -> AI server -> Discord bot. Mirrors
    # `seekdeep_launcher.bat` option 8 (clean start of all three) so the
    # Installer Step 8 can offer one button instead of a PowerShell
    # snippet. Each sub-action reuses the existing /launcher/ + /docker/
    # endpoints internally so a single function gates the whole sequence.
    @app.post("/system/launch-all", dependencies=[Depends(_require_gui_token)])
    def post_launch_all():
        results: dict = {}
        # 1. SearXNG — start the container if it's not already on :8080.
        try:
            with socket.create_connection(("127.0.0.1", 8080), timeout=1):
                results["searxng"] = {"ok": True, "already_running": True}
        except Exception:
            try:
                searxng_dir = (root / "searxng").resolve()
                searxng_dir.mkdir(parents=True, exist_ok=True)
                vol = f"{searxng_dir}:/etc/searxng:rw"
                # Remove any prior container
                subprocess.run(["docker", "rm", "-f", "seekdeep-searxng"],
                               capture_output=True, text=True, timeout=10)
                r = subprocess.run([
                    "docker", "run", "-d", "--name", "seekdeep-searxng",
                    "--restart", "unless-stopped", "-p", "8080:8080",
                    "-e", "BASE_URL=http://localhost:8080/",
                    "-e", "INSTANCE_NAME=SeekDeep",
                    "-v", vol, _seekdeep_searxng_image(),
                ], capture_output=True, text=True, timeout=60)
                results["searxng"] = {"ok": r.returncode == 0,
                                       "container_id": (r.stdout or "").strip()[:12],
                                       "error": (r.stderr or "")[:200] if r.returncode != 0 else None}
            except Exception as exc:
                results["searxng"] = {"ok": False, "error": str(exc)[:200]}
        # 2. AI server — already running (it's us), so this is informational.
        results["ai_server"] = {"ok": True, "already_running": True,
                                 "note": "this endpoint is served by the AI server, so it's necessarily up"}
        # 3. Discord bot — start via the module-level _start_service
        # helper (same function /launcher/bot/start delegates to).
        try:
            r = _start_service("bot", root, _log_dir)
            results["bot"] = {"ok": bool(r and r.get("ok")), "detail": r}
        except Exception as exc:
            results["bot"] = {"ok": False, "error": str(exc)[:200]}
        return {"ok": all(v.get("ok") for v in results.values()),
                "services": results}

    # ----- GET /system/bootstrap-status -----
    # Quick probe of what setup_local.ps1 + `npm install` would do.
    # Returns flags + summary copy the Installer's Step-3 panel can
    # render so the user sees what's actually missing (usually nothing
    # for Tauri-bundled users) instead of being told to drop to
    # PowerShell. Token-free since it's just filesystem checks.
    @app.get("/system/bootstrap-status")
    def get_bootstrap_status():
        ready_dirs = ["logs", "models", "outputs", "temp", "searxng"]
        present_dirs = {d: (root / d).is_dir() for d in ready_dirs}
        env_file = (root / ".env").is_file()
        env_default = (root / ".env.default").is_file()
        # Venv: .venv exists with a python executable in either Win or
        # Unix layout. Bonus: do the live python have fastapi importable?
        venv_win = (root / ".venv" / "Scripts" / "python.exe").is_file()
        venv_nix = (root / ".venv" / "bin" / "python").is_file() or (root / ".venv" / "bin" / "python3").is_file()
        venv_present = venv_win or venv_nix
        # We can't easily import-check OTHER venvs from here, so the
        # "deps installed" signal is just: did we boot? If we got here,
        # the running python at sys.executable has fastapi/uvicorn/etc.
        # The relevant thing for setup_local.ps1 is the REPO .venv.
        node_modules = (root / "node_modules").is_dir()
        package_json = (root / "package.json").is_file()
        # All-clear when env exists, venv exists, node_modules exists.
        all_done = bool(env_file and venv_present and node_modules)
        steps = [
            {"id": "env",          "label": "`.env` file present",                "ok": env_file,
             "fix": None if env_file else ("Copy .env.default -> .env" if env_default else "No .env.default to seed from")},
            {"id": "venv",         "label": "Python virtualenv (.venv) present", "ok": venv_present,
             "fix": None if venv_present else "Create .venv with `python -m venv .venv` + pip install requirements-local.txt"},
            {"id": "node_modules", "label": "Discord bot deps (node_modules)",   "ok": node_modules,
             "fix": None if node_modules else ("Run `npm install` in repo root" if package_json else "No package.json found")},
            {"id": "data_dirs",    "label": "Working dirs (logs, models, outputs, temp, searxng)",
             "ok": all(present_dirs.values()),
             "fix": None if all(present_dirs.values())
                    else "Create: " + ", ".join(d for d, ok in present_dirs.items() if not ok)},
        ]
        return {
            "ok": True, "ready": all_done, "steps": steps,
            "repo_root": str(root),
        }

    # ----- POST /system/bootstrap -----
    # Run the equivalent of setup_local.ps1 + `npm install` server-side.
    # This is the GUI button the Installer's Step-3 panel calls so the
    # user never has to open PowerShell. Token-gated because it spawns
    # subprocesses + writes to disk. Streams progress on the event bus
    # as `bootstrap.line` events.
    #
    # What it does, in order (skipping any already-present):
    #   1. mkdir logs/ models/ outputs/ temp/ searxng/
    #   2. Copy .env.default -> .env if .env missing
    #   3. python -m venv .venv  (if .venv missing)
    #   4. .venv/.../python -m pip install -r requirements-local.txt
    #   5. npm install  (if node_modules missing)
    @app.post("/system/bootstrap", dependencies=[Depends(_require_gui_token)])
    def post_bootstrap():
        import shutil, threading
        def _publish(line: str):
            event_bus.publish_sync({"type": "bootstrap.line", "data": {"line": str(line)}})

        def run_bootstrap():
            try:
                event_bus.publish_sync({"type": "bootstrap.started", "data": {}})
                # 1. Working dirs
                for d in ("logs", "models", "outputs", "temp", "searxng"):
                    p = root / d
                    if not p.is_dir():
                        p.mkdir(parents=True, exist_ok=True)
                        _publish(f"mkdir {d}/")
                # 2. .env from .env.default
                env_p = root / ".env"
                env_d = root / ".env.default"
                if not env_p.is_file() and env_d.is_file():
                    shutil.copyfile(env_d, env_p)
                    _publish("cp .env.default -> .env")
                elif env_p.is_file():
                    _publish(".env already exists (preserved)")
                # 3. python -m venv .venv
                venv_py_win = root / ".venv" / "Scripts" / "python.exe"
                venv_py_nix = root / ".venv" / "bin" / "python"
                if not venv_py_win.is_file() and not venv_py_nix.is_file():
                    _publish("python -m venv .venv  (creating virtualenv)")
                    proc = subprocess.Popen(
                        [sys.executable, "-m", "venv", str(root / ".venv")],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, bufsize=1, cwd=str(root),
                    )
                    if proc.stdout:
                        for line in proc.stdout:
                            _publish(line.rstrip())
                    proc.wait()
                    if proc.returncode != 0:
                        event_bus.publish_sync({"type": "bootstrap.failed",
                                                "data": {"step": "venv", "exit_code": proc.returncode}})
                        return
                # 4. pip install requirements-local.txt into the .venv
                venv_py = venv_py_win if venv_py_win.is_file() else venv_py_nix
                req = root / "requirements-local.txt"
                if venv_py.is_file() and req.is_file():
                    _publish(f"{venv_py.name} -m pip install -r requirements-local.txt")
                    proc = subprocess.Popen(
                        [str(venv_py), "-m", "pip", "install", "--upgrade",
                         "--disable-pip-version-check", "-r", str(req)],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, bufsize=1, cwd=str(root),
                    )
                    if proc.stdout:
                        for line in proc.stdout:
                            _publish(line.rstrip())
                    proc.wait()
                    if proc.returncode != 0:
                        event_bus.publish_sync({"type": "bootstrap.failed",
                                                "data": {"step": "pip_install_local", "exit_code": proc.returncode}})
                        return
                # 5. npm install
                node_modules = root / "node_modules"
                pkg_json = root / "package.json"
                if not node_modules.is_dir() and pkg_json.is_file():
                    _publish("npm install  (Discord.js + jszip)")
                    try:
                        proc = subprocess.Popen(
                            ["npm", "install"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, cwd=str(root),
                            # SECURITY: shell=True only to route to npm.cmd on
                            # Windows. The argv is a HARDCODED literal — NEVER add
                            # user/Discord-supplied package names or flags here, or
                            # this becomes command injection. (DeepSeek audit C-2.)
                            shell=(os.name == "nt"),
                        )
                        if proc.stdout:
                            for line in proc.stdout:
                                _publish(line.rstrip())
                        proc.wait()
                        if proc.returncode != 0:
                            event_bus.publish_sync({"type": "bootstrap.failed",
                                                    "data": {"step": "npm_install", "exit_code": proc.returncode}})
                            return
                    except FileNotFoundError:
                        _publish("npm not on PATH — install Node 22+ (nodejs.org) and re-run this step")
                        event_bus.publish_sync({"type": "bootstrap.failed",
                                                "data": {"step": "npm_install", "error": "npm not found"}})
                        return
                event_bus.publish_sync({"type": "bootstrap.complete", "data": {}})
            except Exception as exc:
                _publish(f"✕ unexpected error: {exc}")
                event_bus.publish_sync({"type": "bootstrap.failed",
                                        "data": {"error": str(exc)[:300]}})

        threading.Thread(target=run_bootstrap, daemon=True).start()
        return {"ok": True, "started": True,
                "note": "subscribe to bootstrap.line / bootstrap.complete / bootstrap.failed on /events"}

    # ----- GET /system/detect-venv -----
    # Scan filesystem locations the user is likely to have a venv with
    # working torch + CUDA. The Tauri sidecar's find_python() walks
    # py-launcher entries by default and picks a torch-supported one,
    # but it doesn't know about a venv that lives in the user's repo
    # checkout (e.g. C:\…\SeekDeep-DiscordBot\.venv\Scripts\python.exe).
    # That venv often has the RIGHT wheel for the user's GPU because
    # they ran setup_local.ps1 there. We surface it here so the wizard
    # can auto-set SEEKDEEP_PYTHON and skip the "Install ML libraries"
    # download entirely.
    def _compute_detect_venv_payload() -> dict:
        import subprocess
        candidates: list[dict] = []
        seen: set[str] = set()
        # Search roots, ordered most-likely-to-be-the-repo first.
        # Repo CWD comes first because the server is usually launched
        # from there (.bat or Tauri's runtime dir).
        roots: list[Path] = []
        roots.append(root)
        # User's home + common subdirs people park projects in.
        home = Path(os.path.expanduser("~"))
        for sub in ("", "Documents", "Desktop", "Downloads", "github", "GitHub",
                    "Source", "src", "Projects", "code", "OneDrive\\Documents"):
            roots.append(home / sub if sub else home)
        # The repo dir if SEEKDEEP_REPO_DIR is set in env (uncommon but cheap).
        env_repo = os.environ.get("SEEKDEEP_REPO_DIR")
        if env_repo:
            roots.append(Path(env_repo))

        def probe_python(exe: Path) -> dict | None:
            if not exe.is_file():
                return None
            key = str(exe.resolve())
            if key in seen:
                return None
            seen.add(key)
            try:
                code = (
                    "import sys, json;"
                    "v = sys.version_info;"
                    "out = {'python':f'{v.major}.{v.minor}.{v.micro}',"
                    " 'executable':sys.executable,"
                    " 'torch':None, 'cuda_runtime':None, 'cuda_built':None, 'gpu_name':None};"
                    "try:\n"
                    " import torch;"
                    " out['torch']=getattr(torch,'__version__',None);"
                    " out['cuda_built']=getattr(getattr(torch,'version',None),'cuda',None);"
                    " out['cuda_runtime']=bool(torch.cuda.is_available());"
                    " out['gpu_name']=(torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)\n"
                    "except Exception:\n"
                    " pass\n"
                    "print(json.dumps(out))"
                )
                r = subprocess.run([str(exe), "-c", code],
                                   capture_output=True, text=True, timeout=8)
                if r.returncode != 0:
                    return {"executable": key, "error": (r.stderr or "")[-200:]}
                import json as _json
                data = _json.loads((r.stdout or "").strip().splitlines()[-1])
                data["executable"] = key
                return data
            except Exception as exc:
                return {"executable": key, "error": str(exc)[:200]}

        # Search depth: 1 level deep from each root (so we catch
        # `~/Documents/MyRepo/.venv` without recursing forever).
        # The .venv itself is detected by the presence of
        # Scripts/python.exe (Windows) or bin/python (Unix).
        def find_venvs_under(d: Path) -> list[Path]:
            found: list[Path] = []
            if not d.is_dir():
                return found
            # Direct
            for sub in (".venv", "venv", "env"):
                exe = d / sub / "Scripts" / "python.exe"
                if exe.is_file(): found.append(exe)
                exe2 = d / sub / "bin" / "python"
                if exe2.is_file(): found.append(exe2)
                exe3 = d / sub / "bin" / "python3"
                if exe3.is_file(): found.append(exe3)
            # One level deeper (~/Documents/<project>/.venv/...)
            try:
                for entry in d.iterdir():
                    if not entry.is_dir(): continue
                    # Skip dotted dirs at this level except known venv names
                    if entry.name.startswith(".") and entry.name not in (".venv",):
                        continue
                    for sub in (".venv", "venv", "env"):
                        exe = entry / sub / "Scripts" / "python.exe"
                        if exe.is_file(): found.append(exe)
                        exe2 = entry / sub / "bin" / "python"
                        if exe2.is_file(): found.append(exe2)
                        exe3 = entry / sub / "bin" / "python3"
                        if exe3.is_file(): found.append(exe3)
            except Exception:
                pass
            return found

        for r_root in roots:
            try:
                for exe in find_venvs_under(r_root):
                    info = probe_python(exe)
                    if info: candidates.append(info)
            except Exception:
                pass

        # Rank: cuda_runtime=True first, then torch present, then by Python version.
        def rank_key(c: dict) -> tuple:
            return (
                -1 if c.get("cuda_runtime") else 0,
                -1 if c.get("torch") else 0,
                -float(("".join(c.get("python", "0.0.0").split(".")[:2])) or 0),
            )
        candidates.sort(key=rank_key)
        return {
            "ok": True,
            "candidates": candidates,
            "current": _current_python_status(),
        }

    @app.get("/system/detect-venv")
    async def get_detect_venv():
        # Spawns ~10 subprocess.run() calls (8s timeout each) to probe each
        # venv's torch/CUDA. Sync execution would block the event loop for
        # many seconds. async + to_thread keeps the loop free.
        import asyncio as _asyncio_dv
        return await _asyncio_dv.to_thread(_compute_detect_venv_payload)

    def _current_python_status() -> dict:
        # Inline because gui_endpoints lives in a tight import scope.
        out = {"executable": sys.executable, "torch": None, "cuda_runtime": None, "cuda_built": None}
        try:
            import torch as _t
            out["torch"] = getattr(_t, "__version__", None)
            out["cuda_built"] = getattr(getattr(_t, "version", None), "cuda", None)
            try: out["cuda_runtime"] = bool(_t.cuda.is_available())
            except Exception: out["cuda_runtime"] = False
        except Exception:
            pass
        return out

    # ----- POST /system/use-venv -----
    # One-click apply: write SEEKDEEP_PYTHON=<path> to .env so the next
    # Tauri sidecar boot uses the user's existing venv. After this fires
    # the user has to restart the AI server (the running process can't
    # swap its own interpreter); we surface the restart hint in the
    # response.
    @app.post("/system/use-venv", dependencies=[Depends(_require_gui_token)])
    def post_use_venv(body: dict):
        exe = str((body or {}).get("executable") or "").strip()
        if not exe:
            raise HTTPException(400, "executable is required")
        exe_path = Path(exe)
        if not exe_path.is_file():
            raise HTTPException(400, f"{exe!r} is not a file")
        # Use the same atomic + comment-preserving merger /config POST
        # uses. SEEKDEEP_PYTHON is read by src-tauri/src/sidecar.rs's
        # find_python() on the next sidecar boot.
        try:
            _merge_env(_env_path, {"SEEKDEEP_PYTHON": str(exe_path.resolve())})
            return {"ok": True, "executable": str(exe_path.resolve()),
                    "note": "Restart the AI server so SEEKDEEP_PYTHON takes effect (Quick Actions -> Reload .env, or tray -> Restart AI server)."}
        except Exception as exc:
            raise HTTPException(500, f"failed to write .env: {exc}")

    # ----- POST /system/install-docker -----
    # Same shape as /system/install-python but for Docker Desktop. The
    # user still has to launch Docker Desktop + accept the EULA after
    # install — we can't automate that bit.
    @app.post("/system/install-docker", dependencies=[Depends(_require_gui_token)])
    def post_install_docker(body: dict | None = None):
        # dry_run=true: probe winget but don't actually install. Used by
        # smoke tests; also useful for the wizard to check "would this
        # work?" before committing to a multi-GB download.
        dry_run = bool((body or {}).get("dry_run"))
        try:
            probe = subprocess.run(["winget", "--version"], capture_output=True, text=True, timeout=5)
            if probe.returncode != 0:
                return {"ok": False, "error": "winget not available — install Docker Desktop manually from docker.com"}
        except FileNotFoundError:
            return {"ok": False, "error": "winget not on PATH — only Windows 10/11 1809+ have it. Install Docker Desktop manually from docker.com"}
        except Exception as exc:
            return {"ok": False, "error": f"winget probe failed: {exc}"}
        if dry_run:
            return {"ok": True, "dry_run": True, "note": "Would run: winget install --id Docker.DockerDesktop -e --silent"}
        try:
            r = _run_winget_streamed("install-docker",
                ["winget", "install", "--id", "Docker.DockerDesktop", "-e",
                 "--silent", "--accept-package-agreements", "--accept-source-agreements"],
                900)
            r.setdefault("note", "Launch Docker Desktop once installed so the daemon starts; then return to SeekDeep.")
            return r
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:600]}

    # ----- POST /system/reinstall-torch -----
    # Force-reinstall the torch/torchvision/torchaudio triple from PyTorch's
    # CUDA-specific wheel index. Use when the firstrun probe detects a GPU
    # whose compute capability isn't in the installed torch's arch_list
    # (e.g. RTX 50-series sm_120 on a cu121 wheel that only supports sm_90).
    #
    # Variant maps to the pip index URL:
    #   cu118 -> https://download.pytorch.org/whl/cu118
    #   cu121 -> https://download.pytorch.org/whl/cu121
    #   cu124 -> https://download.pytorch.org/whl/cu124
    #   cu126 -> https://download.pytorch.org/whl/cu126
    #   cu128 -> https://download.pytorch.org/whl/cu128  (Blackwell/sm_120)
    #   cpu   -> https://download.pytorch.org/whl/cpu
    #
    # Streams pip stdout/stderr to event_bus as deps.install.line; emits
    # deps.install.complete or .failed at the end so the wizard's progress
    # spinner can resolve.
    _ALLOWED_TORCH_VARIANTS = {"cu118", "cu121", "cu124", "cu126", "cu128", "cpu"}

    @app.post("/system/reinstall-torch", dependencies=[Depends(_require_gui_token)])
    def post_reinstall_torch(body: dict | None = None):
        import sys
        import threading
        variant = ((body or {}).get("variant") or "cu128").strip().lower()
        if variant not in _ALLOWED_TORCH_VARIANTS:
            raise HTTPException(400, f"variant must be one of {sorted(_ALLOWED_TORCH_VARIANTS)}; got {variant!r}")
        index_url = f"https://download.pytorch.org/whl/{variant}"
        py_str_lower = sys.executable.lower()
        in_venv = (bool(os.environ.get("VIRTUAL_ENV"))
                   or ".venv" in py_str_lower or "\\venv\\" in py_str_lower or "/venv/" in py_str_lower)
        def run():
            try:
                event_bus.publish_sync({"type": "deps.install.started",
                                        "data": {"variant": variant, "index_url": index_url}})
                # torchaudio is intentionally omitted: SeekDeep doesn't
                # import it, and pinning it causes ResolutionImpossible
                # when audio's torch-pin lags vision's. See
                # requirements-ml.txt for the reasoning.
                cmd = [sys.executable, "-m", "pip", "install",
                       "--upgrade", "--force-reinstall", "--no-deps",
                       "--index-url", index_url,
                       "torch", "torchvision",
                       "--disable-pip-version-check"]
                if not in_venv:
                    cmd.insert(4, "--user")  # before --index-url
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1)
                for line in iter(proc.stdout.readline, ""):
                    line = line.rstrip()
                    if line:
                        event_bus.publish_sync({"type": "deps.install.line", "data": {"line": line}})
                rc = proc.wait()
                ok = rc == 0
                event_bus.publish_sync({
                    "type": "deps.install.complete" if ok else "deps.install.failed",
                    "data": {"variant": variant, "exit_code": rc,
                             "note": f"torch/{variant} reinstalled · restart AI server to pick up the new wheel" if ok else None},
                })
            except Exception as exc:
                event_bus.publish_sync({"type": "deps.install.failed",
                                        "data": {"variant": variant, "error": str(exc)[:400]}})
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True, "variant": variant, "index_url": index_url, "note": "install started · subscribe to deps.install.* events for progress"}

    # ----- POST /system/install-ollama -----
    # Same winget pattern as Docker. After install, the user can either run
    # `ollama serve` manually OR the launcher's start-ollama endpoint will
    # spawn it in the background.
    @app.post("/system/install-ollama", dependencies=[Depends(_require_gui_token)])
    def post_install_ollama(body: dict | None = None):
        dry_run = bool((body or {}).get("dry_run"))
        try:
            probe = subprocess.run(["winget", "--version"], capture_output=True, text=True, timeout=5)
            if probe.returncode != 0:
                return {"ok": False, "error": "winget not available — install Ollama manually from ollama.com"}
        except FileNotFoundError:
            return {"ok": False, "error": "winget not on PATH — install Ollama manually from ollama.com"}
        except Exception as exc:
            return {"ok": False, "error": f"winget probe failed: {exc}"}
        if dry_run:
            return {"ok": True, "dry_run": True, "note": "Would run: winget install --id Ollama.Ollama -e --silent"}
        try:
            r = _run_winget_streamed("install-ollama",
                ["winget", "install", "--id", "Ollama.Ollama", "-e",
                 "--silent", "--accept-package-agreements", "--accept-source-agreements"],
                600)
            r.setdefault("note", "Installed. Click 'Start Ollama daemon' next, or open Ollama from Start menu.")
            return r
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:600]}

    # ----- POST /system/start-ollama -----
    # Spawn the local Ollama daemon (`ollama serve`) in the background.
    # Idempotent: if the daemon is already up (probed via OLLAMA_BASE_URL),
    # returns ok=True immediately.
    @app.post("/system/start-ollama", dependencies=[Depends(_require_gui_token)])
    def post_start_ollama(body: dict | None = None):
        base = (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")
        # Quick probe — daemon already running?
        try:
            with socket.create_connection(("127.0.0.1", 11434), timeout=1.5):
                return {"ok": True, "state": "already-running", "base_url": base}
        except Exception:
            pass
        # Find ollama executable. Common Windows install path: %LOCALAPPDATA%/Programs/Ollama/ollama.exe
        exe = None
        candidates = []
        try:
            r = subprocess.run(["where", "ollama"], capture_output=True, text=True, timeout=3)
            if r.returncode == 0 and r.stdout.strip():
                candidates.extend([line.strip() for line in r.stdout.strip().splitlines() if line.strip()])
        except Exception:
            pass
        local_app = os.path.expandvars("%LOCALAPPDATA%/Programs/Ollama/ollama.exe")
        if os.path.isfile(local_app):
            candidates.append(local_app)
        program_files = os.path.expandvars("%ProgramFiles%/Ollama/ollama.exe")
        if os.path.isfile(program_files):
            candidates.append(program_files)
        for c in candidates:
            if os.path.isfile(c):
                exe = c
                break
        if not exe:
            return {"ok": False, "error": "ollama.exe not found · install via POST /system/install-ollama or from ollama.com"}
        try:
            # Spawn detached so it survives the AI server's lifetime.
            _log_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            out_log = _log_dir / f"ollama-{stamp}.gui.out.log"
            err_log = _log_dir / f"ollama-{stamp}.gui.err.log"
            out_f = out_log.open("ab")
            err_f = err_log.open("ab")
            flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
            if os.name == "nt":
                # Hide the daemon's console window.
                flags |= subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            proc = subprocess.Popen(
                [exe, "serve"],
                stdout=out_f, stderr=err_f, stdin=subprocess.DEVNULL,
                creationflags=flags,
            )
            # Give it 2s to bind the port.
            time.sleep(2.0)
            try:
                with socket.create_connection(("127.0.0.1", 11434), timeout=2):
                    return {"ok": True, "state": "started", "pid": proc.pid, "exe": exe, "log": out_log.name, "base_url": base}
            except Exception:
                return {
                    "ok": False,
                    "error": "started ollama serve but port 11434 isn't accepting connections yet — check the err log.",
                    "pid": proc.pid, "exe": exe, "log": err_log.name,
                }
        except Exception as exc:
            return {"ok": False, "error": f"spawn failed: {exc}"}

    # ----- GET /system/ollama-status -----
    # Already exists below; kept for cross-reference. Probes daemon
    # reachability + device-key presence + OLLAMA_API_KEY presence.

    # AUD-003: which data files contain user-identifying info and should be
    # token-gated. Stats / built-in stacks stay public so the dashboard pane
    # works without the GUI nav.js token interceptor being loaded.
    _DATA_TOKEN_REQUIRED = {
        "user-facts.json",         # discord IDs + remembered text
        "memory-presets.json",     # per-user preset bindings
        "archive-config.json",     # author notify routing
        "archive-optout.json",     # per-user opt-out list
        "archive-guild-config.json",  # guild/channel routing IDs
        "archive-snapshot.json",   # per-thread entry metadata + prompts + thumbnails
        "prompt-templates.json",   # discord user IDs + saved prompt bodies
        "auto-reactions.json",     # guild IDs, channel IDs, creator IDs, patterns
        "server-stats.json",       # per-user discord IDs + activity counts
        "persona-overrides.json",  # guild/channel IDs + who set each override
        "custom-personas.json",    # user-authored persona definitions
        "bot-status.json",         # presence / runtime status
    }

    # ----- GET /data/{file} -----
    @app.get("/data/{file}")
    async def get_data_file(file: str, request: Request):
        # Reject anything that escapes data_dir
        target = (_data_dir / file).resolve()
        if not _is_inside(target, _data_dir):
            raise HTTPException(400, "path traversal blocked")
        # Sensitive data files: require token (AUD-003). nav.js's token
        # interceptor injects X-SeekDeep-Token on every same-server fetch
        # in the GUI; raw HTTP callers (curl from outside) get 401.
        if file in _DATA_TOKEN_REQUIRED:
            await _require_gui_token(request)
        # Bot may write to its OWN data dir (e.g. when SEEKDEEP_BOT_CWD points
        # at the user's repo while the AI server runs from the Tauri runtime
        # dir). If the primary _data_dir copy doesn't exist, fall back to
        # ${bot_cwd}/data/${file}. This rescues the case where the user runs
        # @SeekDeep archive snapshot and the bot writes successfully but the
        # GUI's Archive browser pane shows "bot has not written a snapshot
        # yet" because it's looking in the wrong directory.
        if not target.is_file():
            try:
                bot_cwd = _resolve_bot_cwd(root)
                if bot_cwd and bot_cwd.resolve() != root.resolve():
                    fallback = (bot_cwd / "data" / file).resolve()
                    if _is_inside(fallback, bot_cwd) and fallback.is_file():
                        target = fallback
            except Exception:
                pass
        if not target.is_file():
            # Empty success so the GUI's normalized panes can show empty-state
            # rather than reporting an error for files the bot hasn't written yet.
            if file in _DATA_NORMALIZERS:
                return {"ok": True, "file": file, "data": _DATA_NORMALIZERS[file]({}),
                        "normalized": True, "empty": True}
            raise HTTPException(404, f"{file} not found in {_data_dir}")
        # Only allow .json
        if target.suffix.lower() != ".json":
            raise HTTPException(400, "only .json files exposed")
        # Offload the blocking read+parse+normalize to a worker thread — large data
        # files (server-stats / auto-reactions / archive-snapshot) parsed on the
        # event loop would momentarily stall /health + the /events WS.
        def _read_normalize():
            with target.open("r", encoding="utf-8") as f:
                raw = json.load(f)
            normalizer = _DATA_NORMALIZERS.get(target.name)
            return (normalizer(raw) if normalizer else raw), bool(normalizer)
        try:
            data, normalized = await asyncio.to_thread(_read_normalize)
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"invalid json: {e}", "file": target.name}
        return {"ok": True, "file": target.name, "data": data, "normalized": normalized}

    # ----- POST /model/warm -----
    @app.post("/model/warm", dependencies=[Depends(_require_gui_token)])
    async def post_model_warm(req: WarmRequest):
        # async + to_thread: handler() loads model weights (30+s, holds GIL via
        # CUDA calls). Calling it directly from async blocks the event loop —
        # every other endpoint queues. Offload to the default executor so the
        # loop stays responsive for /health, /launchers/status, /events.
        import asyncio as _asyncio_mw
        role = (req.role or "default_chat").strip().lower() or "default_chat"
        if not warmup_handlers:
            return {"ok": True, "role": role, "loaded": False, "stub": True,
                    "note": "no warmup handlers wired; pass warmup_handlers=... to register_gui_endpoints"}
        try:
            if role == "image":
                handler = warmup_handlers.get("image")
                if not handler: return {"ok": False, "role": role, "error": "no image handler"}
                result = await _asyncio_mw.to_thread(handler)
            elif role == "vision":
                handler = warmup_handlers.get("vision")
                if not handler: return {"ok": False, "role": role, "error": "no vision handler"}
                result = await _asyncio_mw.to_thread(handler)
            else:
                handler = warmup_handlers.get("chat")
                if not handler: return {"ok": False, "role": role, "error": "no chat handler"}
                result = await _asyncio_mw.to_thread(handler, role)
            return {"ok": True, "role": role, "loaded": True,
                    "result": str(result)[:200] if result is not None else None}
        except Exception as e:
            # Log the FULL traceback server-side — the GUI only surfaces str(e),
            # which hides WHERE a warm actually failed (e.g. a NameError bubbling up
            # from the transformers/bitsandbytes 4-bit load path). Route to stderr so
            # the _Tee log wrapper tags the whole block ERR (not just the Traceback
            # lines), and let print_exc append the type+message itself (no duplication).
            import traceback as _tb
            print(f"[SeekDeep] /model/warm failed (role={role!r}):", file=sys.stderr, flush=True)
            _tb.print_exc(file=sys.stderr)
            return {"ok": False, "error": str(e)}

    # ----- GET /config/status -----
    # Drives the GUI's "missing values" modal (window.SeekDeepPrompt). Classifies
    # required + optional env vars as present / placeholder / missing. Placeholder
    # values like "YOUR_TOKEN_HERE" count as missing so the modal auto-pops.
    # Only keys the bot literally cannot start without. The designer's draft
    # included DISCORD_CLIENT_ID and LOCAL_CHAT_MODEL_ID here, but both have
    # working fallbacks: client.user.id (index.js:1349) and a hardcoded default
    # of meta-llama/Llama-3.1-8B-Instruct (local_ai_server.py:105). Marking
    # those required would auto-pop the modal on every page load for users
    # whose bot is already running fine, which is annoying.
    REQUIRED_KEYS = [
        ("DISCORD_TOKEN",       "Discord bot token from the developer portal.",                          "secret"),
    ]
    OPTIONAL_KEYS = [
        ("DISCORD_CLIENT_ID",    "Discord application ID. Auto-derived from client.user.id at runtime.", "id"),
        ("LOCAL_CHAT_MODEL_ID",  "HuggingFace repo ID for the default chat model. Defaults to Llama-3.1-8B-Instruct.", "model"),
        ("HF_TOKEN",             "Hugging Face token - required only for gated models like Llama-3.1.", "secret"),
        ("LOCAL_VISION_MODEL_ID","HuggingFace repo ID for the vision model. Leave blank to disable.",    "model"),
        ("LOCAL_IMAGE_MODEL_ID", "HuggingFace repo ID for SDXL image gen. Leave blank to disable.",      "model"),
        ("SEARXNG_BASE_URL",     "Local SearXNG URL - enables web-routed answers.",                      "url"),
        ("SEEKDEEP_ADMIN_IDS",   "Comma-separated Discord user IDs that get queue priority.",            "csv"),
    ]
    PLACEHOLDER_FRAGMENTS = ("YOUR_", "TOKEN_HERE", "CLIENT_ID_HERE", "KEY_HERE", "REPLACE_ME")

    def _read_env_kv(env_file: Path) -> dict[str, str]:
        if not env_file.is_file():
            return {}
        out: dict[str, str] = {}
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            m = _ENV_LINE_RE.match(line)
            if not m:
                continue
            key = m.group(1)
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            out[key] = val
        return out

    @app.get("/config/status")
    async def get_config_status():
        env = _read_env_kv(_env_path)
        def status(key: str, desc: str, kind: str):
            v = env.get(key, "")
            is_placeholder = any(p in v for p in PLACEHOLDER_FRAGMENTS) if v else False
            return {
                "key": key,
                "description": desc,
                "kind": kind,
                "present": bool(v) and not is_placeholder,
                "is_placeholder": is_placeholder,
                # Hide secret values from the wire so HF_TOKEN etc. don't leak
                # into browser DevTools / cached fetches; non-secrets echo back.
                "value": "" if kind == "secret" else v,
            }
        required = [status(k, d, kind) for k, d, kind in REQUIRED_KEYS]
        optional = [status(k, d, kind) for k, d, kind in OPTIONAL_KEYS]
        missing_required = [r for r in required if not r["present"]]
        return {
            "ok": True,
            "env_path": str(_env_path),
            "required": required,
            "optional": optional,
            "missing_required": missing_required,
            "needs_setup": bool(missing_required),
        }

    # ----- GET /config/features -----
    # On/off state of every optional feature flag the GUI exposes as a toggle
    # (the Docs page's inline switches + Bot config). Booleans only — no secrets
    # — read from the SAME .env that POST /config writes, so a Docs toggle
    # round-trips correctly. The keys are the catalog keys (SEEKDEEP_FEATURE_*
    # without the _ENABLED suffix), which is the actual env var the bot reads.
    # Open (no token) like /config/status; nothing returned here is sensitive.
    @app.get("/config/features")
    async def get_config_features():
        env = _read_env_kv(_env_path)
        def _on(v) -> bool:
            return str(v or "").strip().lower() in ("1", "true", "yes", "on")
        out: dict[str, bool] = {}
        # Every SEEKDEEP_FEATURE_* present in .env...
        for k, v in env.items():
            if k.startswith("SEEKDEEP_FEATURE_"):
                out[k] = _on(v)
        # ...plus the known toggleable keys (reported false when absent), so the
        # Docs switches always have a defined state to render.
        for k in ("SEEKDEEP_FEATURE_IMG2IMG", "SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX",
                  "SEEKDEEP_FEATURE_INPAINT", "SEEKDEEP_FEATURE_UPSCALE_REALESRGAN",
                  "SEEKDEEP_FEATURE_NSFW_GATE", "SEEKDEEP_FEATURE_TTS_VOICE",
                  "SEEKDEEP_FEATURE_EMOJI_VAULT", "SEEKDEEP_FEATURE_FORCE_REACT",
                  "SEEKDEEP_FEATURE_AUTO_REACT", "SEEKDEEP_DM_CHAT_ENABLED",
                  "JOIN_LEAVE_LOGS_ENABLED"):
            out.setdefault(k, _on(env.get(k)))
        return {"ok": True, "features": out}

    # ----- Emoji Vault (read-only) · SEEKDEEP_FEATURE_EMOJI_VAULT -----
    # GUI parity for the Discord "@SeekDeep emoji backup/list/count" admin feature:
    # list the bot's servers, list/count a server's custom emojis, and download a zip
    # backup of every emoji image — no Discord client needed. The Python server calls
    # Discord's REST API directly with the bot token. READ-ONLY here (writes — import,
    # delete — are a later phase). Every endpoint requires the GUI token AND the
    # feature flag; with the flag off they 404 so the GUI page stays hidden.
    _DISCORD_API = "https://discord.com/api/v10"
    _EMOJI_GUILD_ID_RE = re.compile(r"^\d{5,25}$")

    def _emoji_vault_token() -> str:
        # 404 when the feature is off (page hidden); 503 when the bot token is absent.
        env = _read_env_kv(_env_path)
        if str(env.get("SEEKDEEP_FEATURE_EMOJI_VAULT") or "").strip().lower() not in ("1", "true", "yes", "on"):
            raise HTTPException(404, "Emoji vault is disabled (set SEEKDEEP_FEATURE_EMOJI_VAULT=on).")
        token = (env.get("DISCORD_TOKEN") or "").strip()
        if not token:
            raise HTTPException(503, "DISCORD_TOKEN is not set; cannot reach Discord.")
        return token

    def _discord_get_json_sync(path: str, token: str):
        import requests
        try:
            r = requests.get(
                f"{_DISCORD_API}{path}",
                headers={
                    "Authorization": f"Bot {token}",
                    "User-Agent": "SeekDeep-DiscordBot (control-center, 1.0)",
                },
                timeout=20,
            )
        except Exception as exc:
            raise HTTPException(502, f"Could not reach Discord: {str(exc)[:200]}")
        if r.status_code == 401:
            raise HTTPException(502, "Discord rejected the bot token (401).")
        if r.status_code == 403:
            raise HTTPException(502, "Discord refused access (403) — check the bot's server membership/permissions.")
        if r.status_code == 429:
            raise HTTPException(503, "Discord rate-limited the request; retry shortly.")
        if r.status_code >= 400:
            raise HTTPException(502, f"Discord API error {r.status_code}.")
        try:
            return r.json()
        except Exception:
            raise HTTPException(502, "Discord returned a non-JSON response.")

    def _emoji_items(raw) -> list[dict]:
        items: list[dict] = []
        for e in (raw or []):
            if not isinstance(e, dict) or not e.get("id"):
                continue
            animated = bool(e.get("animated"))
            ext = "gif" if animated else "png"
            items.append({
                "id": str(e.get("id")),
                "name": str(e.get("name") or "emoji"),
                "animated": animated,
                "url": f"https://cdn.discordapp.com/emojis/{e.get('id')}.{ext}",
            })
        items.sort(key=lambda x: x["name"].lower())
        return items

    @app.get("/emoji-vault/guilds", dependencies=[Depends(_require_gui_token)])
    async def emoji_vault_guilds():
        token = _emoji_vault_token()
        raw = await asyncio.to_thread(_discord_get_json_sync, "/users/@me/guilds", token)
        guilds = [
            {"id": str(g.get("id")), "name": str(g.get("name") or "(unnamed)"), "icon": g.get("icon")}
            for g in (raw or []) if isinstance(g, dict) and g.get("id")
        ]
        guilds.sort(key=lambda x: x["name"].lower())
        return {"ok": True, "guilds": guilds}

    @app.get("/emoji-vault/{guild_id}/emojis", dependencies=[Depends(_require_gui_token)])
    async def emoji_vault_emojis(guild_id: str):
        token = _emoji_vault_token()
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        items = _emoji_items(await asyncio.to_thread(_discord_get_json_sync, f"/guilds/{guild_id}/emojis", token))
        animated = sum(1 for x in items if x["animated"])
        return {"ok": True, "count": len(items), "animated": animated,
                "static": len(items) - animated, "emojis": items}

    def _build_emoji_zip_sync(items: list[dict]) -> bytes:
        import requests
        buf = io.BytesIO()
        used: set[str] = set()
        manifest: list[str] = []
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            # One pooled session: every emoji image lives on cdn.discordapp.com,
            # so connection reuse avoids a fresh TCP+TLS handshake per emoji (a
            # server can have 50-250) — much faster and less socket churn.
            with requests.Session() as session:
                for it in items:
                    ext = "gif" if it["animated"] else "png"
                    base = re.sub(r"[^A-Za-z0-9_.-]+", "_", it["name"]).strip("_") or "emoji"
                    fname = f"{base}.{ext}"
                    n = 1
                    while fname in used:
                        fname = f"{base}_{n}.{ext}"
                        n += 1
                    used.add(fname)
                    try:
                        img = session.get(it["url"], timeout=20)
                        if img.status_code == 200 and img.content:
                            zf.writestr(fname, img.content)
                            manifest.append(f":{it['name']}: -> {fname}")
                    except Exception:
                        pass
            zf.writestr("MANIFEST.txt", "SeekDeep emoji backup\n" + "\n".join(manifest) + "\n")
        return buf.getvalue()

    @app.get("/emoji-vault/{guild_id}/backup.zip", dependencies=[Depends(_require_gui_token)])
    async def emoji_vault_backup(guild_id: str, save: int = 0):
        token = _emoji_vault_token()
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        items = _emoji_items(await asyncio.to_thread(_discord_get_json_sync, f"/guilds/{guild_id}/emojis", token))
        if not items:
            raise HTTPException(404, "This server has no custom emojis to back up.")
        data = await asyncio.to_thread(_build_emoji_zip_sync, items)
        _seekdeep_audit("emoji-vault-backup", guild=guild_id, count=len(items))
        if save:
            # save=1: write the zip server-side to the user's Downloads folder and
            # return its path, instead of streaming it for a browser download. The
            # GUI runs on the SAME machine as this loopback server (Tauri app AND
            # the loopback browser), so a server-side write is the reliable
            # cross-surface "download": the Tauri WebView2 silently drops blob/anchor
            # downloads (no download handler in the Rust shell) and a Rust fix can't
            # ship via self-update. Timestamped so repeat backups don't overwrite.
            from pathlib import Path as _Path
            import time as _time
            home = _Path.home()
            dest_dir = home / "Downloads"
            if not dest_dir.is_dir():
                dest_dir = home
            stem = f"emoji-backup-{guild_id}-{_time.strftime('%Y%m%d-%H%M%S')}"
            # Uniquify: second-resolution timestamps collide on rapid repeat backups
            # of the same guild, and write_bytes would silently overwrite.
            dest = dest_dir / f"{stem}.zip"
            n = 1
            while dest.exists():
                dest = dest_dir / f"{stem}-{n}.zip"
                n += 1
            fname = dest.name
            try:
                # Offload the blocking disk write — this is an async handler, so a
                # synchronous write_bytes would stall the event loop (and every
                # other in-flight request) for the duration of the write.
                await asyncio.to_thread(dest.write_bytes, data)
            except OSError as exc:
                raise HTTPException(500, f"could not write backup to disk: {exc}")
            return {"ok": True, "path": str(dest), "filename": fname,
                    "bytes": len(data), "count": len(items)}
        return StreamingResponse(
            io.BytesIO(data),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="emoji-backup-{guild_id}.zip"'},
        )

    # ----- generic "save a GUI-built file to Downloads" -----------------------
    # The Tauri WebView2 silently drops blob/anchor downloads, so GUI "download/
    # export/save" buttons (image studio, image A/B, memory + prompt JSON export)
    # have to write through the loopback server, which runs on the SAME machine as
    # the GUI. Token-gated; basename-only filename (no traversal); size-capped;
    # confined to ~/Downloads (fallback ~). Mirrors the emoji backup save=1 pattern.
    class SaveFileRequest(BaseModel):
        filename: str = Field(..., description="desired file name (basename only)")
        content_b64: str = Field(..., description="base64-encoded file bytes")

    @app.post("/save-file", dependencies=[Depends(_require_gui_token)])
    def save_file(req: SaveFileRequest):
        import base64 as _b64, re as _re, time as _time
        from pathlib import Path as _Path
        safe = _re.sub(r"[^A-Za-z0-9._-]", "_", _Path(req.filename or "").name)[:120]
        if not safe or safe in (".", ".."):
            raise HTTPException(400, "invalid filename")
        b64 = req.content_b64 or ""
        # Guard the RAW base64 length BEFORE decoding — b64decode allocates the
        # full decoded buffer in memory, so checking only the decoded size (below)
        # would let an oversize request OOM us first (uvicorn/h11 caps headers, not
        # body). Base64 inflates ~4/3, so 64 MB decoded is ~86 MB of text; 90 MB
        # leaves headroom while the exact 64 MB cap still enforces post-decode.
        if len(b64) > 90 * 1024 * 1024:
            raise HTTPException(413, "file too large (max 64 MB)")
        try:
            data = _b64.b64decode(b64, validate=False)
        except Exception:
            raise HTTPException(400, "invalid content_b64")
        if not data:
            raise HTTPException(400, "empty content")
        if len(data) > 64 * 1024 * 1024:
            raise HTTPException(413, "file too large (max 64 MB)")
        p = _Path(safe)
        # Extension allowlist: this endpoint backs image/JSON/text exports only, so
        # refuse to write executable/script/shortcut types into ~/Downloads where
        # they sit next to real downloads and could be double-clicked.
        _ALLOWED_SAVE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif",
                                  ".json", ".txt", ".csv", ".md", ".zip"}
        if p.suffix.lower() not in _ALLOWED_SAVE_SUFFIXES:
            raise HTTPException(400, f"unsupported file type '{p.suffix}'; allowed: "
                                     + ", ".join(sorted(_ALLOWED_SAVE_SUFFIXES)))
        home = _Path.home()
        dest_dir = home / "Downloads"
        if not dest_dir.is_dir():
            dest_dir = home
        stem = f"{p.stem}-{_time.strftime('%Y%m%d-%H%M%S')}"
        # Second-resolution timestamps collide on rapid repeat saves; uniquify so a
        # second save in the same second doesn't silently overwrite the first.
        dest = dest_dir / f"{stem}{p.suffix}"
        n = 1
        while dest.exists():
            dest = dest_dir / f"{stem}-{n}{p.suffix}"
            n += 1
        try:
            dest.write_bytes(data)
        except OSError as exc:
            raise HTTPException(500, f"could not write file: {exc}")
        _seekdeep_audit("save-file", name=dest.name, bytes=len(data))
        return {"ok": True, "path": str(dest), "filename": dest.name, "bytes": len(data)}

    # ----- Emoji Vault writes (import + delete) · same gate as read-only -----
    # Mutating parity for the emoji vault: bulk-import a backup .zip as new guild
    # emojis, and delete individual emojis. Both need the GUI token AND the feature
    # flag, and both hit Discord's REST API with the bot token — which must have
    # "Manage Expressions/Emojis" in the target guild or Discord answers 403.
    _EMOJI_NAME_RE = re.compile(r"[^A-Za-z0-9_]+")
    _EMOJI_IMPORT_MAX_FILES = 250                 # cap one import batch
    _EMOJI_IMPORT_MAX_UPLOAD = 64 * 1024 * 1024   # 64 MB zip ceiling
    _EMOJI_MAX_IMAGE_BYTES = 256 * 1024           # Discord's per-emoji image limit
    _EMOJI_MIME = {"png": "image/png", "gif": "image/gif", "jpg": "image/jpeg",
                   "jpeg": "image/jpeg", "webp": "image/webp"}

    def _sanitize_emoji_name(raw: str) -> str:
        # Discord emoji names are 2-32 chars of [A-Za-z0-9_].
        base = _EMOJI_NAME_RE.sub("_", str(raw or "")).strip("_")
        if len(base) < 2:
            base = (base + "_emoji").strip("_")
        return base[:32] or "emoji"

    def _discord_emoji_write_sync(method: str, path: str, token: str, json_body=None):
        # Returns (status_code, parsed_json_or_None, retry_after_seconds).
        import requests
        r = requests.request(
            method, f"{_DISCORD_API}{path}",
            headers={"Authorization": f"Bot {token}",
                     "User-Agent": "SeekDeep-DiscordBot (control-center, 1.0)"},
            json=json_body, timeout=30,
        )
        try:
            data = r.json()
        except Exception:
            data = None
        retry_after = 0.0
        if r.status_code == 429:
            try:
                retry_after = float((data or {}).get("retry_after")
                                    or r.headers.get("Retry-After") or 1.0)
            except Exception:
                retry_after = 1.0
        return r.status_code, data, retry_after

    def _emoji_create_one_sync(guild_id: str, token: str, name: str, mime: str, raw: bytes) -> dict:
        import base64 as _b64
        import time as _time
        data_uri = f"data:{mime};base64,{_b64.b64encode(raw).decode('ascii')}"
        payload = {"name": name, "image": data_uri, "roles": []}
        for attempt in range(2):
            try:
                status, data, retry_after = _discord_emoji_write_sync(
                    "POST", f"/guilds/{guild_id}/emojis", token, payload)
            except Exception as exc:
                return {"name": name, "ok": False, "error": f"network: {str(exc)[:120]}"}
            if status in (200, 201):
                return {"name": str((data or {}).get("name") or name), "ok": True,
                        "id": str((data or {}).get("id") or "")}
            if status == 429 and attempt == 0:
                _time.sleep(min(retry_after or 1.0, 8.0))
                continue
            msg = str(data.get("message")) if isinstance(data, dict) and data.get("message") is not None else ""
            return {"name": name, "ok": False,
                    "error": (msg or f"HTTP {status}")[:160], "status": status}
        return {"name": name, "ok": False, "error": "rate-limited", "status": 429}

    def _emoji_import_zip_sync(guild_id: str, token: str, blob: bytes) -> dict:
        created: list[dict] = []
        skipped: list[dict] = []
        failed: list[dict] = []
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
        except Exception:
            raise HTTPException(400, "Uploaded file is not a valid .zip archive.")
        processed = 0
        with zf:
            for entry in zf.namelist():
                if entry.endswith("/"):
                    continue
                fname = entry.rsplit("/", 1)[-1]
                if not fname or fname.upper() == "MANIFEST.TXT":
                    continue
                ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
                if ext not in _EMOJI_MIME:
                    skipped.append({"name": fname, "reason": "not an image"})
                    continue
                if processed >= _EMOJI_IMPORT_MAX_FILES:
                    skipped.append({"name": fname, "reason": "batch limit (250) reached"})
                    continue
                try:
                    info = zf.getinfo(entry)
                    if info.file_size == 0 or info.file_size > _EMOJI_MAX_IMAGE_BYTES:
                        skipped.append({"name": fname, "reason": "image is empty or >256 KB"})
                        continue
                    raw = zf.read(entry)
                except Exception:
                    failed.append({"name": fname, "error": "could not read from zip"})
                    continue
                processed += 1
                res = _emoji_create_one_sync(
                    guild_id, token, _sanitize_emoji_name(fname.rsplit(".", 1)[0]),
                    _EMOJI_MIME[ext], raw)
                (created if res.get("ok") else failed).append(res)
        return {"ok": True, "created": created, "skipped": skipped, "failed": failed,
                "summary": {"created": len(created), "skipped": len(skipped),
                            "failed": len(failed)}}

    @app.post("/emoji-vault/{guild_id}/import", dependencies=[Depends(_require_gui_token)])
    async def emoji_vault_import(guild_id: str, request: Request):
        # Body is the raw .zip bytes (no multipart dep). The frontend POSTs the
        # File object directly; nav.js attaches the GUI token.
        token = _emoji_vault_token()
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        try:
            clen = int(request.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            clen = 0
        if clen > _EMOJI_IMPORT_MAX_UPLOAD:
            raise HTTPException(413, "zip too large (max 64 MB)")
        blob = await request.body()
        if not blob:
            raise HTTPException(400, "empty upload — POST a .zip backup as the request body")
        if len(blob) > _EMOJI_IMPORT_MAX_UPLOAD:
            raise HTTPException(413, "zip too large (max 64 MB)")
        result = await asyncio.to_thread(_emoji_import_zip_sync, guild_id, token, blob)
        _seekdeep_audit("emoji-vault-import", guild=guild_id,
                        created=result["summary"]["created"], failed=result["summary"]["failed"])
        return result

    @app.delete("/emoji-vault/{guild_id}/emojis/{emoji_id}", dependencies=[Depends(_require_gui_token)])
    async def emoji_vault_delete(guild_id: str, emoji_id: str):
        token = _emoji_vault_token()
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        if not _EMOJI_GUILD_ID_RE.match(emoji_id or ""):
            raise HTTPException(400, "invalid emoji id")
        try:
            status, data, _ = await asyncio.to_thread(
                _discord_emoji_write_sync, "DELETE",
                f"/guilds/{guild_id}/emojis/{emoji_id}", token, None)
        except Exception as exc:
            raise HTTPException(502, f"Discord API connection failed: {str(exc)[:120]}")
        if status in (200, 204):
            _seekdeep_audit("emoji-vault-delete", guild=guild_id, emoji=emoji_id)
            return {"ok": True}
        if status == 403:
            raise HTTPException(502, "Discord refused (403) — the bot needs Manage Emojis in that server.")
        if status == 404:
            raise HTTPException(404, "That emoji no longer exists.")
        if status == 429:
            raise HTTPException(503, "Discord rate-limited the delete; retry shortly.")
        msg = str(data.get("message")) if isinstance(data, dict) and data.get("message") is not None else ""
        raise HTTPException(502, (msg or f"Discord API error {status}")[:160])

    # ----- Force React config (read/write) · SEEKDEEP_FEATURE_FORCE_REACT -----
    # GUI for the existing right-click Force React picker: pick a server, set the
    # per-user-per-message cap + cooldown, and choose which emojis the picker offers.
    # The config lives in data/force-react-config.json (the BOT reads it; server +
    # emoji lists come from Discord REST, reusing the helpers above). All endpoints
    # are token-gated; the Discord-REST ones + the config read/write are also
    # feature-gated (404 when SEEKDEEP_FEATURE_FORCE_REACT is off).
    _force_react_config_file = (_data_dir / "force-react-config.json")

    def _force_react_enabled() -> bool:
        return str(_read_env_kv(_env_path).get("SEEKDEEP_FEATURE_FORCE_REACT") or "").strip().lower() in ("1", "true", "yes", "on")

    def _force_react_token() -> str:
        if not _force_react_enabled():
            raise HTTPException(404, "Force React is disabled (set SEEKDEEP_FEATURE_FORCE_REACT=on).")
        token = (_read_env_kv(_env_path).get("DISCORD_TOKEN") or "").strip()
        if not token:
            raise HTTPException(503, "DISCORD_TOKEN is not set; cannot reach Discord.")
        return token

    def _force_react_read_all() -> dict:
        try:
            if _force_react_config_file.is_file():
                raw = json.loads(_force_react_config_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("guilds"), dict):
                    return raw
        except Exception:
            pass
        return {"guilds": {}}

    def _force_react_guild_cfg(all_cfg: dict, guild_id: str) -> dict:
        b = (all_cfg.get("guilds") or {}).get(str(guild_id)) or {}
        try:
            cap = max(1, min(20, int(b.get("cap", 3))))
        except (TypeError, ValueError):
            cap = 3
        try:
            cooldown_ms = max(0, int(b.get("cooldown_ms", 0)))
        except (TypeError, ValueError):
            cooldown_ms = 0
        allowed = b.get("allowed_emoji_ids")
        allowed = [str(x) for x in allowed] if isinstance(allowed, list) else []
        return {"cap": cap, "cooldown_ms": cooldown_ms, "allowed_emoji_ids": allowed}

    @app.get("/force-react/guilds", dependencies=[Depends(_require_gui_token)])
    async def force_react_guilds():
        token = _force_react_token()
        raw = await asyncio.to_thread(_discord_get_json_sync, "/users/@me/guilds", token)
        guilds = [
            {"id": str(g.get("id")), "name": str(g.get("name") or "(unnamed)"), "icon": g.get("icon")}
            for g in (raw or []) if isinstance(g, dict) and g.get("id")
        ]
        guilds.sort(key=lambda x: x["name"].lower())
        return {"ok": True, "guilds": guilds}

    @app.get("/force-react/{guild_id}/emojis", dependencies=[Depends(_require_gui_token)])
    async def force_react_emojis(guild_id: str):
        token = _force_react_token()
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        items = _emoji_items(await asyncio.to_thread(_discord_get_json_sync, f"/guilds/{guild_id}/emojis", token))
        return {"ok": True, "count": len(items), "emojis": items}

    @app.get("/force-react/{guild_id}/config", dependencies=[Depends(_require_gui_token)])
    async def force_react_get_config(guild_id: str):
        if not _force_react_enabled():
            raise HTTPException(404, "Force React is disabled (set SEEKDEEP_FEATURE_FORCE_REACT=on).")
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        return {"ok": True, "config": _force_react_guild_cfg(_force_react_read_all(), guild_id)}

    @app.post("/force-react/{guild_id}/config", dependencies=[Depends(_require_gui_token)])
    async def force_react_set_config(guild_id: str, request: Request):
        if not _force_react_enabled():
            raise HTTPException(404, "Force React is disabled (set SEEKDEEP_FEATURE_FORCE_REACT=on).")
        if not _EMOJI_GUILD_ID_RE.match(guild_id or ""):
            raise HTTPException(400, "invalid guild id")
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "invalid JSON body")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        try:
            cap = max(1, min(20, int(body.get("cap", 3))))
        except (TypeError, ValueError):
            raise HTTPException(400, "cap must be an integer 1-20")
        try:
            cooldown_ms = max(0, int(body.get("cooldown_ms", 0)))
        except (TypeError, ValueError):
            raise HTTPException(400, "cooldown_ms must be a non-negative integer")
        allowed = body.get("allowed_emoji_ids", [])
        if not isinstance(allowed, list):
            raise HTTPException(400, "allowed_emoji_ids must be a list")
        if len(allowed) > 2000:
            raise HTTPException(400, "allowed_emoji_ids list is too long (max 2000)")
        allowed = [str(x) for x in allowed if re.fullmatch(r"\d{5,25}", str(x))]
        # Serialize the read-modify-write through the cross-process advisory lock
        # (COUP-1) so concurrent POSTs / the bot's own writer can't clobber each
        # other — offloaded to a thread so the blocking lock + sync file I/O don't
        # stall the asyncio event loop.
        def _save_force_react():
            # The lock now raises HTTPException(503) on a busy timeout (audit
            # M-2); the coroutine re-raises that as-is so the caller gets a
            # retryable 503, and maps any OTHER failure (read/write) to a 500.
            with _seekdeep_file_lock(_force_react_config_file):
                all_cfg = _force_react_read_all()
                all_cfg.setdefault("guilds", {})[str(guild_id)] = {
                    "cap": cap, "cooldown_ms": cooldown_ms, "allowed_emoji_ids": allowed,
                }
                _atomic_write_json(_force_react_config_file, all_cfg)   # fsync-durable write
        try:
            await asyncio.to_thread(_save_force_react)
        except HTTPException:
            raise  # lock-busy 503 etc. — pass through, don't mask as 500
        except Exception as exc:
            raise HTTPException(500, f"could not save config: {str(exc)[:200]}")
        _seekdeep_audit("force-react-config-write", guild=guild_id, cap=cap, allowed=len(allowed))
        return {"ok": True, "config": {"cap": cap, "cooldown_ms": cooldown_ms, "allowed_emoji_ids": allowed}}

    # ----- Bot default vision mode (describe vs OCR) · SEEKDEEP_FEATURE_BOT_BRIDGE
    # GUI parity for the bot's default @mention-image behavior. The GUI writes
    # data/vision-mode-config.json here; the BOT (index.js) reads it LIVE
    # (mtime-aware) and applies it as the DEFAULT only when a request carries no
    # explicit OCR/describe cue. Token-gated; feature-gated on the bot-bridge flag
    # (404 when off) since it's part of the GUI<->Discord parity surface. The
    # write goes through the same cross-process file lock + fsync-durable atomic
    # write as the other data/*.json the bot also reads.
    _vision_mode_config_file = (_data_dir / "vision-mode-config.json")
    _VISION_MODES = ("describe", "ocr")

    def _vision_mode_read() -> tuple[str, str]:
        # File (GUI-set) wins; else the .env cold default; else 'describe' — the
        # bot resolves the same precedence, so the GUI always shows bot truth.
        # Returns (mode, source) where source is 'file' | 'env' | 'default'; the
        # source reflects where the RETURNED mode actually came from, so a file
        # that exists but holds an invalid mode reports the real fallback origin.
        try:
            if _vision_mode_config_file.is_file():
                raw = json.loads(_vision_mode_config_file.read_text(encoding="utf-8"))
                m = str((raw or {}).get("mode") or "").strip().lower()
                if m in _VISION_MODES:
                    return m, "file"
        except Exception:
            pass
        env_mode = str(_read_env_kv(_env_path).get("SEEKDEEP_VISION_DEFAULT_MODE") or "").strip().lower()
        if env_mode in _VISION_MODES:
            return env_mode, "env"
        return "describe", "default"

    @app.get("/bot/vision-mode", dependencies=[Depends(_require_gui_token)])
    async def get_vision_mode():
        if not _bot_bridge_enabled():
            raise HTTPException(404, "Bot bridge is disabled (set SEEKDEEP_FEATURE_BOT_BRIDGE=on).")
        mode, source = _vision_mode_read()
        return {"ok": True, "mode": mode, "source": source}

    @app.post("/bot/vision-mode", dependencies=[Depends(_require_gui_token)])
    async def set_vision_mode(request: Request):
        if not _bot_bridge_enabled():
            raise HTTPException(404, "Bot bridge is disabled (set SEEKDEEP_FEATURE_BOT_BRIDGE=on).")
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}  # valid-but-non-dict JSON (list/str/number) -> 400, not 500
        mode = str(body.get("mode") or "").strip().lower()
        if mode not in _VISION_MODES:
            raise HTTPException(400, f"mode must be one of {', '.join(_VISION_MODES)}")

        def _save_vision_mode():
            with _seekdeep_file_lock(_vision_mode_config_file):
                _atomic_write_json(_vision_mode_config_file, {"mode": mode})
        try:
            await asyncio.to_thread(_save_vision_mode)
        except HTTPException:
            raise  # lock-busy 503 etc. — pass through, don't mask as 500
        except Exception as exc:
            raise HTTPException(500, f"could not save vision mode: {str(exc)[:200]}")
        _seekdeep_audit("vision-mode-write", mode=mode)
        return {"ok": True, "mode": mode}

    # ----- Bot default web-search mode (auto/off/always) · SEEKDEEP_FEATURE_BOT_BRIDGE
    # GUI parity for whether chat AUTO-augments with web search (SearXNG). The GUI
    # writes data/web-search-config.json here; the BOT (index.js) reads it LIVE
    # (mtime-aware) and applies it on the chat web:'auto' path. 'auto' keeps the
    # historical shouldAutoSearch heuristic, 'off' disables auto-augment (an
    # explicit in-prompt search command still searches), 'always' augments every
    # auto chat. Token-gated; feature-gated on the bot-bridge flag (404 when off).
    _web_search_config_file = (_data_dir / "web-search-config.json")
    _WEB_SEARCH_MODES = ("auto", "off", "always")

    def _web_search_read() -> tuple[str, str]:
        # File (GUI-set) wins; else the .env cold default; else 'auto' — the bot
        # resolves the same precedence, so the GUI always shows bot truth.
        # Returns (mode, source) where source is 'file' | 'env' | 'default'.
        try:
            if _web_search_config_file.is_file():
                raw = json.loads(_web_search_config_file.read_text(encoding="utf-8"))
                m = str((raw or {}).get("mode") or "").strip().lower()
                if m in _WEB_SEARCH_MODES:
                    return m, "file"
        except Exception:
            pass
        env_mode = str(_read_env_kv(_env_path).get("SEEKDEEP_WEB_SEARCH_DEFAULT") or "").strip().lower()
        if env_mode in _WEB_SEARCH_MODES:
            return env_mode, "env"
        return "auto", "default"

    @app.get("/bot/web-search", dependencies=[Depends(_require_gui_token)])
    async def get_web_search_mode():
        if not _bot_bridge_enabled():
            raise HTTPException(404, "Bot bridge is disabled (set SEEKDEEP_FEATURE_BOT_BRIDGE=on).")
        mode, source = _web_search_read()
        return {"ok": True, "mode": mode, "source": source}

    @app.post("/bot/web-search", dependencies=[Depends(_require_gui_token)])
    async def set_web_search_mode(request: Request):
        if not _bot_bridge_enabled():
            raise HTTPException(404, "Bot bridge is disabled (set SEEKDEEP_FEATURE_BOT_BRIDGE=on).")
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}  # valid-but-non-dict JSON (list/str/number) -> 400, not 500
        mode = str(body.get("mode") or "").strip().lower()
        if mode not in _WEB_SEARCH_MODES:
            raise HTTPException(400, f"mode must be one of {', '.join(_WEB_SEARCH_MODES)}")

        def _save_web_search():
            with _seekdeep_file_lock(_web_search_config_file):
                _atomic_write_json(_web_search_config_file, {"mode": mode})
        try:
            await asyncio.to_thread(_save_web_search)
        except HTTPException:
            raise  # lock-busy 503 etc. — pass through, don't mask as 500
        except Exception as exc:
            raise HTTPException(500, f"could not save web-search mode: {str(exc)[:200]}")
        _seekdeep_audit("web-search-write", mode=mode)
        return {"ok": True, "mode": mode}

    # ----- GET /config -----
    # Read-only env map. Used by index.html's dynamic-facts IIFE to populate
    # the Models / Search / Runtime cells against live config. Secret-tagged
    # keys are redacted to '*****' so a public read can't leak Discord/HF
    # tokens via DevTools / cached fetches. Open (no token) because the
    # IIFE runs on the marketing About page where requiring auth would
    # silently break the live data flow.
    _SECRET_KEY_PATTERNS = re.compile(
        r"(?:^|_)(TOKEN|KEY|PASSWORD|SECRET|PASS|API_KEY|PRIVATE_KEY)(?:$|_)",
        re.IGNORECASE,
    )

    def _is_secret_key(name: str) -> bool:
        # Be liberal about what counts as a secret -- false positives just
        # redact a value that didn't need it; false negatives leak data.
        n = (name or "").strip()
        if not n:
            return False
        if _SECRET_KEY_PATTERNS.search(n):
            return True
        # Common Discord/HF/etc named keys that don't match the pattern
        return n in {"HF_TOKEN", "DISCORD_TOKEN", "OPENAI_API_KEY",
                     "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
                     "GROQ_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY",
                     "XAI_API_KEY", "SEEKDEEP_GUI_TOKEN"}

    # ----- /archive/config -----
    # Backs the app.html archive pane's "Author notify" settings strip.
    # See PLANNED.md item D for the spec.
    _archive_config_path = _data_dir / "archive-config.json"
    _ARCHIVE_MODES = {"silent", "dm", "reply", "react"}

    def _read_archive_config() -> dict:
        if not _archive_config_path.is_file():
            return {"mode": "silent", "notify_self": False, "sent_24h": 0, "channels": {}}
        try:
            data = json.loads(_archive_config_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"mode": "silent", "notify_self": False, "sent_24h": 0, "channels": {}}
            # Fill in defaults for missing keys
            data.setdefault("mode", "silent")
            data.setdefault("notify_self", False)
            data.setdefault("sent_24h", 0)
            data.setdefault("channels", {})
            if data["mode"] not in _ARCHIVE_MODES:
                data["mode"] = "silent"
            return data
        except Exception:
            return {"mode": "silent", "notify_self": False, "sent_24h": 0, "channels": {}}

    @app.get("/archive/config")
    def get_archive_config():
        return {"ok": True, "config": _read_archive_config()}

    @app.post("/archive/config", dependencies=[Depends(_require_gui_token)])
    def post_archive_config(patch: ArchiveConfigPatch):
        updates = patch.updates or {}
        with _seekdeep_file_lock(_archive_config_path):
            cfg = _read_archive_config()
            if "mode" in updates:
                new_mode = str(updates["mode"]).strip().lower()
                if new_mode not in _ARCHIVE_MODES:
                    raise HTTPException(400, f"mode must be one of: {', '.join(sorted(_ARCHIVE_MODES))}")
                cfg["mode"] = new_mode
            if "notify_self" in updates:
                cfg["notify_self"] = bool(updates["notify_self"])
            if "channels" in updates and isinstance(updates["channels"], dict):
                # Per-channel overrides: validate each value is a valid mode
                chans = {}
                for cid, mode in updates["channels"].items():
                    if not str(cid).strip():
                        continue
                    m = str(mode).strip().lower()
                    if m in _ARCHIVE_MODES:
                        chans[str(cid)] = m
                cfg["channels"] = chans
            _atomic_write_json(_archive_config_path, cfg)
            return {"ok": True, "config": cfg}

    @app.get("/config")
    def get_config():
        env = _read_env_kv(_env_path)
        redacted = {}
        for k, v in env.items():
            if _is_secret_key(k):
                redacted[k] = "*****" if v else ""
            else:
                # redact embedded URL credentials (scheme://user:pass@host) even when the key isn't secret-named
                redacted[k] = re.sub(r'([A-Za-z][A-Za-z0-9+.\-]*://)[^/@\s:]+:[^/@\s]+@', r'\1[redacted]@', v) if v else v
        return {"ok": True, "env": redacted}

    # ----- GET /config/schema -----
    # Drives the all-settings page (gui/settings.html). Parses the bundled
    # .env.default -- the canonical list of every supported key plus its inline
    # comment as help text -- into ordered, typed, grouped fields. Current
    # VALUES come separately from GET /config (secrets redacted there); this
    # returns only key names, inferred types, template defaults, and docs, so
    # it stays open (no token) like /config/status. Nothing here is sensitive.
    _SCHEMA_SECTION_ORDER = [
        "Discord & access", "Providers & endpoints", "Chat models & routing",
        "VRAM & model cache", "Conversation memory", "Web search",
        "Chat tuning", "Image generation", "Optional features",
        "Member join/leave log", "Desktop, logging & advanced",
    ]
    _SCHEMA_ENUMS = {
        "CHAT_PROVIDER": ["nvidia-local", "openai", "anthropic", "ollama"],
        "IMAGE_PROVIDER": ["nvidia-local", "openai"],
        "VISION_PROVIDER": ["nvidia-local", "openai"],
        "WEB_SEARCH_PROVIDER": ["searxng", "none"],
        "LOCAL_CHAT_QUANT": ["4bit", "8bit", "none"],
        "MODEL_KEEP_MODE": ["task-lru", "all", "none"],
        "SEEKDEEP_MEMORY_MODE": ["rolling", "off"],
        "SEEKDEEP_MEMORY_SCOPE": ["user", "channel"],
        "IMAGE_SCHEDULER": ["dpmsolver++", "default"],
        "SEEKDEEP_UPSCALE_METHOD": ["lanczos", "realesrgan"],
        "SEEKDEEP_UPSCALE_RESAMPLE": ["lanczos", "bicubic", "nearest"],
    }
    # Descriptions for keys that have no inline comment in .env.default /
    # .env.example. The schema prefers an env comment when present and falls back
    # to this map, so every key in All Settings shows a one-line explanation.
    _SCHEMA_DESC_FALLBACK = {
        "DISCORD_TOKEN": "Bot token from the Discord Developer Portal. Required.",
        "CHAT_PROVIDER": "Provider for chat completions.",
        "IMAGE_PROVIDER": "Provider for image generation.",
        "VISION_PROVIDER": "Provider for vision / image understanding.",
        # Providers & endpoints
        "WEB_SEARCH_PROVIDER": "Web-search backend (searxng, or none to disable search).",
        "LOCAL_AI_BASE_URL": "Base URL of the local AI server (the bundled FastAPI app).",
        "SEARXNG_BASE_URL": "Base URL of your SearXNG instance used for web search.",
        "OLLAMA_API_KEY": "API key for an Ollama endpoint (usually blank for local Ollama).",
        "OLLAMA_TIMEOUT_SECS": "Request timeout (seconds) for Ollama chat calls.",
        "OLLAMA_PROBE_TIMEOUT_SECS": "Timeout (seconds) for checking whether Ollama is up.",
        "OLLAMA_PULL_TIMEOUT_SECS": "Timeout (seconds) for pulling an Ollama model.",
        "LOCAL_AI_TIMEOUT_MS": "Request timeout (ms) for calls to the local AI server.",
        "HUGGINGFACE_TOKEN": "Alias for HF_TOKEN — your HuggingFace access token.",
        "DEEPSEEK_BASE_URL": "Base URL for the DeepSeek API (only if using DeepSeek).",
        "DEEPSEEK_MODEL": "DeepSeek model name (only if using DeepSeek).",
        "NIM_MODEL": "NVIDIA NIM model name (only if using NIM).",
        "NIM_API_KEY": "API key for NVIDIA NIM.",
        "NGC_API_KEY": "NVIDIA NGC API key (for NIM / NGC model pulls).",
        # Models & routing
        "LOCAL_CHAT_MODEL_ID": "HuggingFace repo ID of the default chat model.",
        "LOCAL_VISION_MODEL_ID": "HuggingFace repo ID of the vision (image-understanding) model.",
        "LOCAL_IMAGE_MODEL_ID": "HuggingFace repo ID of the image-generation (SDXL) model.",
        "LOCAL_CHAT_QUALITY_MODEL_ID": "Model for the 'quality' chat role (higher-effort replies).",
        "LOCAL_CHAT_REASONING_MODEL_ID": "Model for the 'reasoning' chat role.",
        "LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID": "Model for the 'lightweight' chat role (fast, cheap replies).",
        "MODEL_AUTO_FALLBACK": "Fall back to another model if the chosen one fails to load.",
        "MODEL_ROUTER_LOG": "Log every model-routing decision to logs/.",
        "MODEL_LOG_VRAM": "Log VRAM usage on each model load/unload.",
        # VRAM & cache
        "LOCAL_MODEL_CACHE_DIR": "Directory where downloaded models are cached.",
        "MODEL_KEEP_MODE": "Which models stay resident in VRAM (task-lru, all, or none).",
        "LOCAL_VISION_KEEP_RESIDENT": "Keep the vision model resident in VRAM to avoid reload lag.",
        "LOCAL_IMAGE_KEEP_RESIDENT": "Keep the image model resident in VRAM (uses more VRAM).",
        "VRAM_SAFETY_MARGIN_MB": "VRAM (MB) left free as a safety margin when loading models.",
        "HF_HUB_OFFLINE": "Lock HuggingFace to local cache only — no Hub downloads (run after first warmup).",
        "TRANSFORMERS_OFFLINE": "Lock Transformers to local cache only; pairs with HF_HUB_OFFLINE.",
        "HF_HOME": "HuggingFace home directory (cache root).",
        "HF_HUB_CACHE": "HuggingFace Hub cache directory.",
        "TRANSFORMERS_CACHE": "Transformers model cache directory.",
        # Chat tuning
        "CHAT_MAX_NEW_TOKENS": "Max tokens generated per chat reply.",
        "CHAT_TEMPERATURE": "Chat sampling temperature (higher = more random).",
        "CHAT_REPETITION_PENALTY": "Penalty against repeating tokens (>1 discourages repeats).",
        "CHAT_NO_REPEAT_NGRAM_SIZE": "Block repeating any N-gram of this size within a reply.",
        "CHAT_ANTI_LOOP_TEMPERATURE": "Lower temperature applied when a reply starts looping.",
        "CHAT_TOP_K": "Top-K sampling cutoff for chat generation.",
        "COOLDOWN_MS": "Minimum gap (ms) between replies to the same user/channel.",
        # Conversation memory
        "MAX_DISCORD_CHARS": "Max characters per Discord message before splitting (hard cap 2000).",
        "SEEKDEEP_MEMORY_MODE": "Conversation memory mode (rolling window, or off).",
        "MAX_CONTEXT_CHARS": "Max characters of conversation history kept in the memory store.",
        "SEEKDEEP_MEMORY_RECENT_ENTRIES": "How many recent turns to render into the prompt.",
        "SEEKDEEP_MEMORY_CONTEXT_CHARS": "Max characters of memory rendered into each prompt.",
        # Web search
        "WEB_AUTO_SEARCH": "Auto web-search when a question seems to need current info.",
        "WEB_SEARCH_STRICT_ROUTING": "Only web-search when routing is confident it's needed (fewer searches).",
        "WEB_SEARCH_FAIL_OPEN": "If web search errors, answer anyway instead of refusing.",
        "WEB_APPEND_SOURCES": "Append source links to answers that used web search.",
        "MAX_WEB_RESULTS": "Max web-search results to fetch per query.",
        # Image generation
        "IMAGE_HEIGHT": "Default generated-image height (pixels).",
        "IMAGE_NEGATIVE_PROMPT": "Default negative prompt (things to avoid) for image generation.",
        "LOCAL_TORCH_DTYPE": "Torch compute dtype for models (e.g. float16).",
        "IMAGE_USE_SAFETENSORS": "Load image-model weights from .safetensors when available.",
        "IMAGE_CFG_NORMALIZATION": "Apply CFG rescaling/normalization during image generation.",
        "SEEKDEEP_IMAGE_COOLDOWN_MS": "Minimum gap (ms) between image generations.",
        "SEEKDEEP_IMAGE_PROMPT_MAX_CHARS": "Cap on the rewritten image prompt before it hits the pipeline.",
        "SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT": "Let the AI rewrite/expand image prompts before generating.",
        "SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS": "Max time (ms) for the AI image-prompt rewrite step.",
        "SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_TOKENS": "Token budget for the AI image-prompt rewrite step.",
        "SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_WORDS": "Word cap on the rewritten image prompt.",
        "SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_CHARS": "Character cap on the rewritten image prompt.",
        # Upscaling
        "SEEKDEEP_UPSCALE_RESAMPLE": "Resampling filter index used when upscaling.",
        "SEEKDEEP_UPSCALE_SHARPEN": "Sharpening method applied after upscaling (e.g. unsharp).",
        "SEEKDEEP_UPSCALE_SHARPEN_RADIUS": "Unsharp-mask radius for post-upscale sharpening.",
        "SEEKDEEP_UPSCALE_SHARPEN_PERCENT": "Unsharp-mask strength (%) for post-upscale sharpening.",
        "SEEKDEEP_UPSCALE_SHARPEN_THRESHOLD": "Unsharp-mask threshold (0 = sharpen everything).",
        "SEEKDEEP_UPSCALE_MAX_OUTPUT_PIXELS": "Safety cap on upscaled output size (pixels).",
        # Personality & moderation
        "SEEKDEEP_PERSONA": "Default personality (neurotic, unsettling, clinical, chaotic, or a custom slug).",
        "SEEKDEEP_CENSORSHIP": "Content-filter strictness: off, loose, or minimal.",
        # Channel gating
        "SEEKDEEP_BLOCKED_CHANNELS": "Channel IDs where the bot never responds (comma-separated).",
        # Optional features
        "SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX": "Enable instruct-pix2pix image editing (needs the model).",
        "SEEKDEEP_FEATURE_INPAINT": "Enable inpainting — remove/replace parts of an image (needs the model).",
        "SEEKDEEP_FEATURE_UPSCALE_REALESRGAN": "Use Real-ESRGAN for upscaling (heavier; needs the model).",
        "SEEKDEEP_FEATURE_NSFW_GATE": "Enable the NSFW content gate on generated images.",
        "SEEKDEEP_FEATURE_TTS_VOICE": "Enable text-to-speech voice replies (needs TTS deps).",
        "SEEKDEEP_DAILY_DIGEST_HOUR": "Hour of day (0-23) to post the daily digest.",
        # Member join/leave log
        "JOIN_LEAVE_LOGS_ENABLED": "Master switch for the member join/leave logger.",
        "JOIN_LEAVE_LOG_JOINS": "Log when members join the server.",
        "JOIN_LEAVE_LOG_LEAVES": "Log when members leave the server.",
        # Caches / TTLs / ephemeral
        "SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS": "How long a pending image 'subject' is remembered (ms).",
        "SEEKDEEP_RECENT_VISION_TARGET_TTL_MS": "How long a recently-viewed image stays the vision target (ms).",
        "SEEKDEEP_LAST_SUBJECT_TTL_MS": "How long the last image subject is kept for follow-ups (ms).",
        "SEEKDEEP_DYNAMIC_REFINE_CACHE_TTL_MS": "TTL (ms) for the image prompt-refine cache.",
        "SEEKDEEP_CONTEXT_TRANSLATE_EPHEMERAL": "Make the right-click Translate reply ephemeral (only you see it).",
        "SEEKDEEP_CONTEXT_COMPARE_EPHEMERAL": "Make the 'Compare with previous' reply ephemeral.",
    }
    _SCHEMA_BOOLISH = {"on", "off", "true", "false", "yes", "no"}
    # 0/1-valued boolean flags (HF / Transformers offline convention) — render as
    # a toggle, not a raw "1"/"0" control (users found the bare numbers unclear).
    # NOT every 0/1 key is boolean (e.g. SEEKDEEP_UPSCALE_SHARPEN_THRESHOLD=0 is a
    # real number), so this is an explicit allowlist rather than "treat all 0/1 as
    # boolean". ON writes 1, OFF writes 0.
    _SCHEMA_TOGGLE_01 = {"HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"}

    def _schema_section_for(k):
        if k.startswith("JOIN_LEAVE_"):
            return "Member join/leave log"
        if k.startswith("SEEKDEEP_FEATURE_") or k.startswith("SEEKDEEP_DAILY_DIGEST"):
            return "Optional features"
        if k.startswith("SEEKDEEP_MEMORY_") or k.startswith("MAX_CONTEXT_") or k == "MAX_DISCORD_CHARS":
            return "Conversation memory"
        if k.startswith("WEB_"):
            return "Web search"
        if k.startswith(("IMAGE_", "SEEKDEEP_IMAGE_", "SEEKDEEP_UPSCALE_")):
            return "Image generation"
        if k.startswith("CHAT_") and k != "CHAT_PROVIDER":
            return "Chat tuning"
        if k in ("CHAT_PROVIDER", "IMAGE_PROVIDER", "VISION_PROVIDER",
                 "WEB_SEARCH_PROVIDER", "LOCAL_AI_BASE_URL", "SEARXNG_BASE_URL",
                 "HF_TOKEN") or k.startswith("OLLAMA_"):
            return "Providers & endpoints"
        if (k.startswith("VRAM_") or k.endswith("_KEEP_RESIDENT")
                or k in ("LOCAL_MODEL_CACHE_DIR", "MODEL_KEEP_MODE",
                         "LOCAL_CHAT_QUANT", "LOCAL_CHAT_QUANT_FULL_ROLES",
                         "HF_LOCAL_FILES_ONLY", "HF_HUB_OFFLINE",
                         "TRANSFORMERS_OFFLINE")):
            return "VRAM & model cache"
        if (k.startswith("LOCAL_CHAT_") or k.startswith("MODEL_")
                or k in ("LOCAL_VISION_MODEL_ID", "LOCAL_IMAGE_MODEL_ID")):
            return "Chat models & routing"
        if k.startswith("DISCORD_") or k in ("SEEKDEEP_ADMIN_IDS",
                "SEEKDEEP_ALLOWED_CHANNELS", "SEEKDEEP_BLOCKED_CHANNELS",
                "SEEKDEEP_DM_CHAT_ENABLED", "SEEKDEEP_BOT_CWD"):
            return "Discord & access"
        return "Desktop, logging & advanced"

    def _schema_kind_for(k, val):
        if _is_secret_key(k):
            return "secret"
        if k in _SCHEMA_ENUMS:
            return "select"
        v = (val or "").strip().lower()
        if v in _SCHEMA_BOOLISH or k in _SCHEMA_TOGGLE_01:
            return "toggle"
        if val and re.fullmatch(r"-?\d+(?:\.\d+)?", val.strip()):
            return "number"
        return "text"

    @app.get("/config/schema")
    def get_config_schema():
        # The bundled templates live beside this module (resource dir in the
        # packaged app, repo root in dev). We MERGE two sources so the page
        # surfaces every supported knob without dropping any:
        #   .env.default  — lean curated first-run set (authoritative on overlap)
        #   .env.example  — full ~126-key reference (adds everything else)
        # .env.default is parsed first so its (maintained) defaults win; the
        # example then contributes only keys .env.default doesn't already have.
        # Either file missing is fine — whichever exists is used.
        def _first(name):
            for base in (Path(__file__).resolve().parent, _env_path.parent, root):
                p = base / name
                if p.is_file():
                    return p
            return None
        df_path = _first(".env.default")
        ex_path = _first(".env.example")
        if df_path is None and ex_path is None:
            return {"ok": False, "error": ".env.default / .env.example not found", "sections": []}

        def _parse(path):
            out = []
            comment_buf = []
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                s = line.strip()
                if not s:
                    comment_buf = []          # blank line ends a comment block
                    continue
                if s.startswith("#"):
                    comment_buf.append(s.lstrip("#").strip())
                    continue
                m = _ENV_LINE_RE.match(line)
                if not m:
                    comment_buf = []
                    continue
                key = m.group(1)
                default = line.split("=", 1)[1].strip().strip('"').strip("'")
                desc = " ".join(c for c in comment_buf if c).strip()
                if not desc:
                    desc = _SCHEMA_DESC_FALLBACK.get(key, "")
                field = {
                    "key": key,
                    "default": default,
                    "desc": desc,
                    "kind": _schema_kind_for(key, default),
                    "section": _schema_section_for(key),
                }
                if key in _SCHEMA_ENUMS:
                    field["options"] = _SCHEMA_ENUMS[key]
                out.append(field)
                comment_buf = []
            return out

        fields = []
        seen = set()
        for src in (df_path, ex_path):   # default first → authoritative on overlap
            if src is None:
                continue
            for f in _parse(src):
                if f["key"] in seen:
                    continue
                seen.add(f["key"])
                fields.append(f)

        by_section = {}
        for f in fields:
            by_section.setdefault(f["section"], []).append(f)
        sections = []
        for title in _SCHEMA_SECTION_ORDER:
            if by_section.get(title):
                sections.append({"title": title, "keys": by_section[title]})
        for title, ks in by_section.items():
            if title not in _SCHEMA_SECTION_ORDER:
                sections.append({"title": title, "keys": ks})
        srcs = " + ".join(str(p) for p in (df_path, ex_path) if p)
        return {"ok": True, "template": srcs, "count": len(fields), "sections": sections}

    # ----- /persona -----
    # Wraps data/persona-overrides.json (the bot's persona override store) over
    # HTTP so the chat.html persona pill + the Tweaks panel can change persona
    # without going through Discord. See PLANNED.md item G.
    #
    # Schema mirrors what index.js's seekdeepReadPersonaOverrides() produces:
    #   { channels: {<channel_id>: {persona, setBy, setAt}},
    #     guilds:   {<guild_id>:   {persona, setBy, setAt}},
    #     global:   {persona, setBy, setAt}  ← NEW; checked by extended
    #                                          seekdeepGetEffectivePersona() after
    #                                          channels+guilds, before env default }
    #
    # The web playground has no channel/guild context, so it always sends
    # scope='global'. Channel/server scopes are accepted for symmetry but
    # require channel_id / guild_id in the body.
    _persona_overrides_path = _data_dir / "persona-overrides.json"
    _custom_personas_path   = _data_dir / "custom-personas.json"
    _BUILTIN_PERSONAS = frozenset({"neurotic", "unsettling", "clinical", "chaotic"})
    _VALID_SCOPES = {"channel", "server", "guild", "global"}
    _WEB_OWNER_ID = "web-owner"  # sentinel for setBy when the call comes from the playground

    # Custom-persona validation ceilings + reserved names — mirror index.js
    # (SEEKDEEP_CUSTOM_PERSONA_* + SEEKDEEP_RESERVED_PERSONA_KEYWORDS) so the
    # GUI /personas write path rejects exactly what the Discord `persona create`
    # handler rejects. The two write the SAME data/custom-personas.json.
    _CUSTOM_PERSONA_SLUG_MAX   = 32
    _CUSTOM_PERSONA_TONE_MAX   = 2000
    _CUSTOM_PERSONA_MAX_COUNT  = 50
    _CUSTOM_PERSONA_SLUG_RE    = re.compile(r"^[a-z0-9_-]{2,32}$")
    _RESERVED_PERSONA_KEYWORDS = frozenset(
        {"reset", "show", "create", "remove", "list", "channel", "server", "guild"})
    # Stock one-liners for the built-ins (the bot keeps the real tone strings in
    # its prompt builder; these are just human-readable blurbs for the GUI list).
    # Insertion order is the canonical order the UI shows them in.
    _BUILTIN_PERSONA_DESCRIPTIONS = {
        "neurotic":   "Anxious over-thinker — caveats, second-guessing, spiraling asides (the default).",
        "unsettling": "Quietly ominous — calm, courteous, and faintly wrong in a way you can't place.",
        "clinical":   "Cold and precise — numbered points, minimal warmth; a manpage with feelings.",
        "chaotic":    "Manic and unpredictable — tangents, sudden caps, gleeful disregard for the question.",
    }

    def _read_custom_personas() -> dict:
        """Full data/custom-personas.json contents, shape
        {"personas": {<slug>: {tone, createdBy, createdAt, updatedAt}}}. Mirrors
        index.js seekdeepReadCustomPersonas — returns the empty shape on a
        missing or malformed file so every caller is crash-proof."""
        try:
            if not _custom_personas_path.is_file():
                return {"personas": {}}
            raw = json.loads(_custom_personas_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return {"personas": {}}
            if not isinstance(raw.get("personas"), dict):
                raw["personas"] = {}
            return raw
        except Exception:
            return {"personas": {}}

    def _read_custom_persona_slugs() -> list[str]:
        """Slugs of every persona in data/custom-personas.json (lowercase).
        Empty list if the file's missing or malformed. Used to make /persona's
        valid_personas list include user-defined personas so the chat-playground
        popover and the persona admin command stay in sync."""
        personas = _read_custom_personas().get("personas") or {}
        return [str(k).lower() for k in personas.keys() if str(k).strip()]

    def _valid_personas() -> set[str]:
        """Built-in + custom slugs. Recomputed on each call so newly-created
        custom personas are visible without an AI-server restart."""
        return set(_BUILTIN_PERSONAS) | set(_read_custom_persona_slugs())

    def _read_persona_overrides() -> dict:
        try:
            if not _persona_overrides_path.is_file():
                return {"channels": {}, "guilds": {}, "global": None}
            data = json.loads(_persona_overrides_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"channels": {}, "guilds": {}, "global": None}
            if not isinstance(data.get("channels"), dict): data["channels"] = {}
            if not isinstance(data.get("guilds"), dict):   data["guilds"] = {}
            if "global" not in data: data["global"] = None
            return data
        except Exception:
            return {"channels": {}, "guilds": {}, "global": None}

    def _env_default_persona() -> str:
        env = _read_env_kv(_env_path)
        v = str(env.get("SEEKDEEP_PERSONA", "") or "").strip().lower()
        return v if v in _valid_personas() else "neurotic"

    @app.get("/persona")
    def get_persona():
        data = _read_persona_overrides()
        glob = data.get("global") or {}
        global_persona = str(glob.get("persona") or "").lower() if isinstance(glob, dict) else ""
        env_default = _env_default_persona()
        effective_global = global_persona if global_persona in _valid_personas() else env_default
        return {
            "ok": True,
            "valid_personas": sorted(_valid_personas()),
            "env_default": env_default,
            "global": global_persona or None,
            "effective_global": effective_global,
            "channels_count": len(data.get("channels") or {}),
            "guilds_count": len(data.get("guilds") or {}),
        }

    @app.post("/persona", dependencies=[Depends(_require_gui_token)])
    def post_persona(patch: PersonaPatch):
        scope = (patch.scope or "global").strip().lower()
        if scope == "guild":
            scope = "server"  # alias
        if scope not in {"channel", "server", "global"}:
            raise HTTPException(400, f"scope must be one of: channel, server, global (got {scope!r})")

        action = (patch.action or "").strip().lower() or None
        persona = (patch.persona or "").strip().lower() or None

        if action == "reset":
            with _seekdeep_file_lock(_persona_overrides_path):
                data = _read_persona_overrides()
                if scope == "global":
                    data["global"] = None
                elif scope == "channel":
                    cid = (patch.channel_id or "").strip()
                    if not cid:
                        raise HTTPException(400, "scope='channel' reset requires channel_id")
                    data["channels"].pop(cid, None)
                elif scope == "server":
                    gid = (patch.guild_id or "").strip()
                    if not gid:
                        raise HTTPException(400, "scope='server' reset requires guild_id")
                    data["guilds"].pop(gid, None)
                _atomic_write_json(_persona_overrides_path, data)
                return {"ok": True, "scope": scope, "persona": None, "action": "reset"}

        if not persona:
            raise HTTPException(400, "body must include either persona='...' or action='reset'")
        if persona not in _valid_personas():
            raise HTTPException(400, f"persona must be one of: {sorted(_valid_personas())} (got {persona!r})")

        entry = {"persona": persona, "setBy": _WEB_OWNER_ID, "setAt": _now_iso()}
        with _seekdeep_file_lock(_persona_overrides_path):
            data = _read_persona_overrides()
            if scope == "global":
                data["global"] = entry
            elif scope == "channel":
                cid = (patch.channel_id or "").strip()
                if not cid:
                    raise HTTPException(400, "scope='channel' requires channel_id")
                data["channels"][cid] = entry
            elif scope == "server":
                gid = (patch.guild_id or "").strip()
                if not gid:
                    raise HTTPException(400, "scope='server' requires guild_id")
                data["guilds"][gid] = entry
            _atomic_write_json(_persona_overrides_path, data)
        try:
            event_bus.publish_sync({"type": "route.changed",
                                     "data": {"scope": scope, "persona": persona}})
        except Exception:
            pass
        return {"ok": True, "scope": scope, "persona": persona, "set_at": entry["setAt"]}

    # ----- /personas (custom persona catalog: list / create-update / delete) -----
    # Wraps data/custom-personas.json so the GUI persona manager can do full
    # CRUD on user-authored personas — previously only the Discord `persona
    # create/remove` commands could touch this file. The bot reads the SAME
    # file (seekdeepReadCustomPersonas), so a persona created here is usable in
    # Discord on the bot's next message and vice-versa. GET is open (the names
    # aren't sensitive, matching GET /persona); writes are token-gated.
    @app.get("/personas")
    def list_personas():
        custom_raw = _read_custom_personas().get("personas") or {}
        custom = []
        for slug, row in custom_raw.items():
            if not isinstance(row, dict):
                continue
            custom.append({
                "slug": str(slug),
                "tone": str(row.get("tone") or ""),
                "updatedAt": row.get("updatedAt") or row.get("createdAt") or None,
            })
        custom.sort(key=lambda r: r["slug"])
        builtin = [{"slug": s, "description": d}
                   for s, d in _BUILTIN_PERSONA_DESCRIPTIONS.items()]
        return {
            "ok": True,
            "builtin": builtin,
            "custom": custom,
            "count": len(custom),
            "max": _CUSTOM_PERSONA_MAX_COUNT,
        }

    @app.post("/personas", dependencies=[Depends(_require_gui_token)])
    def upsert_persona(patch: CustomPersonaPatch):
        slug = (patch.slug or "").strip().lower()
        if not _CUSTOM_PERSONA_SLUG_RE.match(slug):
            raise HTTPException(
                400,
                f"slug must be 2-{_CUSTOM_PERSONA_SLUG_MAX} chars of lowercase letters, "
                f"digits, '-' or '_' (^[a-z0-9_-]{{2,{_CUSTOM_PERSONA_SLUG_MAX}}}$) — got {slug!r}")
        if slug in _BUILTIN_PERSONAS:
            raise HTTPException(400, f'"{slug}" is a built-in persona; pick a different name')
        if slug in _RESERVED_PERSONA_KEYWORDS:
            raise HTTPException(
                400, f'"{slug}" is reserved (used by the persona command itself); pick a different name')

        tone = (patch.tone or "").strip()
        if len(tone) < 2:
            raise HTTPException(
                400, "tone (the persona description) is too short — give it at least a sentence (min 2 chars)")
        if len(tone) > _CUSTOM_PERSONA_TONE_MAX:
            raise HTTPException(
                400,
                f"tone is too long — {len(tone)}/{_CUSTOM_PERSONA_TONE_MAX} chars; "
                f"trim about {len(tone) - _CUSTOM_PERSONA_TONE_MAX}")

        with _seekdeep_file_lock(_custom_personas_path):
            data = _read_custom_personas()
            personas = data.get("personas")
            if not isinstance(personas, dict):
                personas = {}
                data["personas"] = personas
            existed = slug in personas
            if not existed and len(personas) >= _CUSTOM_PERSONA_MAX_COUNT:
                raise HTTPException(
                    400, f"custom persona cap reached ({_CUSTOM_PERSONA_MAX_COUNT}); remove one first")

            now = _now_iso()
            prev = personas.get(slug) if isinstance(personas.get(slug), dict) else {}
            # Preserve createdAt + the original createdBy across edits (a persona
            # first authored in Discord keeps its Discord creator); only updatedAt
            # moves. Structure is byte-for-byte what index.js writes.
            personas[slug] = {
                "tone": tone,
                "createdBy": prev.get("createdBy") or _WEB_OWNER_ID,
                "createdAt": prev.get("createdAt") or now,
                "updatedAt": now,
            }
            _atomic_write_json(_custom_personas_path, data)
            return {
                "ok": True,
                "slug": slug,
                "created": not existed,
                "updatedAt": now,
                "count": len(personas),
                "max": _CUSTOM_PERSONA_MAX_COUNT,
            }

    @app.delete("/personas/{slug}", dependencies=[Depends(_require_gui_token)])
    def delete_persona(slug: str):
        s = (slug or "").strip().lower()
        if s in _BUILTIN_PERSONAS:
            raise HTTPException(404, f'"{s}" is a built-in persona and cannot be deleted')
        with _seekdeep_file_lock(_custom_personas_path):
            data = _read_custom_personas()
            personas = data.get("personas")
            if not isinstance(personas, dict) or s not in personas:
                raise HTTPException(404, f'no custom persona named "{s}"')
            personas.pop(s, None)
            data["personas"] = personas
            _atomic_write_json(_custom_personas_path, data)
            # Any channel/guild override pointing at this slug now fails
            # seekdeepIsValidPersonaSlug on the bot side and falls back to the env
            # default on the next message — no extra cleanup needed here.
            return {"ok": True, "slug": s, "removed": True, "count": len(personas)}

    # ----- GET /stats/counts -----
    # Source-of-truth counts that pages display in their stat tiles. Replaces
    # the hardcoded 274/35/109/18 literals on pitch.html + changelog.html so
    # they stop rotting whenever a test/release/command/surface ships. See
    # PLANNED.md item J.
    #
    # Each count has a "best-effort" data source — degrades to None if the
    # source file is missing so the endpoint can't crash the GUI. The endpoint
    # is open (no token) because the numbers are public anyway.
    _smoke_test_path     = root / "smoke_test.mjs"
    _smoke_gui_path      = root / "scripts" / "smoke_gui_endpoints.py"
    _commands_md_path    = root / "COMMANDS.md"
    _nav_js_path         = root / "gui" / "nav.js"

    _CHECK_CALL_RE   = re.compile(r"^\s*check\(", re.MULTILINE)
    _CMD_ROW_RE      = re.compile(r"^\|\s*`", re.MULTILINE)
    _NAV_PAGE_ENTRY  = re.compile(r"^\s*\{\s*id\s*:\s*'", re.MULTILINE)

    def _count_pattern(path: Path, regex: re.Pattern) -> int | None:
        try:
            if not path.is_file():
                return None
            return len(regex.findall(path.read_text(encoding="utf-8", errors="replace")))
        except Exception:
            return None

    def _count_git_tags() -> int | None:
        try:
            r = subprocess.run(
                ["git", "tag", "--list"],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=5,
            )
            if r.returncode != 0:
                return None
            return sum(1 for line in r.stdout.splitlines() if line.strip())
        except Exception:
            return None

    def _count_nav_surfaces() -> int | None:
        # Count entries inside the PAGES = [ ... ] block in gui/nav.js. We
        # scope to the PAGES region so unrelated `{ id: '...' }` literals
        # elsewhere in the file don't inflate the count.
        try:
            if not _nav_js_path.is_file():
                return None
            text = _nav_js_path.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"const\s+PAGES\s*=\s*\[(.*?)\];", text, re.DOTALL)
            if not m:
                return None
            return len(_NAV_PAGE_ENTRY.findall(m.group(1)))
        except Exception:
            return None

    @app.get("/stats/counts")
    def get_stats_counts():
        smoke_tests     = _count_pattern(_smoke_test_path, _CHECK_CALL_RE)
        gui_smoke_tests = _count_pattern(_smoke_gui_path,  _CHECK_CALL_RE)
        commands        = _count_pattern(_commands_md_path, _CMD_ROW_RE)
        releases        = _count_git_tags()
        surfaces        = _count_nav_surfaces()
        return {
            "ok": True,
            "smoke_tests":     smoke_tests,
            "gui_smoke_tests": gui_smoke_tests,
            "releases":        releases,
            "commands":        commands,
            "surfaces":        surfaces,
            "generated_at":    _now_iso(),
            "sources": {
                "smoke_tests":     "smoke_test.mjs (check() calls)",
                "gui_smoke_tests": "scripts/smoke_gui_endpoints.py (check() calls)",
                "releases":        "git tag --list",
                "commands":        "COMMANDS.md (table rows)",
                "surfaces":        "gui/nav.js (PAGES array)",
            },
        }

    # ----- GET /stats/snapshot -----
    # Live snapshot of everything the Control Center actually shows. Replaces
    # the hardcoded placeholders that have lived in app.html since v0
    # (PID 14882, Uptime 4h 12m, Reqs: 184, Latency: 48ms, Guilds: 3,
    # "↑ 18% vs last 30d", chart bar heights, cache size, etc.).
    #
    # Schema:
    #   {
    #     ok, generated_at,
    #     ai_server: { uptime_seconds, requests_24h, latency_p50_ms,
    #                  latency_p95_ms, by_family_24h: {...} },
    #     bot:       { total_chats, total_images, total_vision, guild_count,
    #                  user_count, day_buckets: [{date, chats, images, vision}] (last 30d) },
    #     deltas:    { messages_30d_pct, images_30d_pct, vision_30d_pct }
    #                — % change of latest-30d window vs prior-30d window
    #     cache:     { hf_size_bytes, hf_repo_count, ollama_tag_count }
    #   }
    #
    # AI server stats come from the in-process request middleware (live, in
    # memory). Bot stats come from data/server-stats.json which the bot
    # writes on every chat/image/vision via index.js's seekdeepBumpServerStats.
    # Cache size is huggingface_hub.scan_cache_dir().
    def _compute_stats_snapshot() -> dict:
        out: dict = {"ok": True, "generated_at": _now_iso()}

        # AI server live counters — pinned via the stats_provider callback
        # so we read the running process's counters (not a re-imported
        # module instance with zeroed state). See register_gui_endpoints
        # docstring for the __main__ vs import gotcha.
        try:
            if stats_provider is not None:
                out["ai_server"] = stats_provider() or {}
            else:
                out["ai_server"] = {"error": "no stats_provider passed to register_gui_endpoints"}
        except Exception as e:
            out["ai_server"] = {"error": str(e)}

        # Bot stats from server-stats.json
        bot_stats_path = _data_dir / "server-stats.json"
        bot: dict = {
            "total_chats": 0, "total_images": 0, "total_vision": 0,
            "guild_count": 0, "user_count": 0, "day_buckets": [],
            # Per-{persona, style, model} breakdowns. Empty until the bot
            # has bumped stats with persona/imageStyle/chatModel metadata
            # (see seekdeepTrackStatEvent in index.js). Powers the Stats
            # pane's three breakdown panels.
            "by_persona": {}, "by_image_style": {}, "by_chat_model": {},
        }
        day_agg: dict[str, dict[str, int]] = {}
        persona_agg:     dict[str, int] = {}
        image_style_agg: dict[str, int] = {}
        chat_model_agg:  dict[str, int] = {}
        # Aggregate per-user activity across guilds so we can surface a
        # top-contributors leaderboard (the Stats pane was looking for
        # data.top in server-stats.json but the file is keyed guild→user;
        # nothing was rendering even when there was real activity).
        user_agg: dict[str, dict[str, int]] = {}
        if bot_stats_path.is_file():
            try:
                raw = json.loads(bot_stats_path.read_text(encoding="utf-8"))
                guilds = raw.get("guilds") or {}
                bot["guild_count"] = len(guilds)
                user_ids: set = set()
                for g in guilds.values():
                    if not isinstance(g, dict): continue
                    bot["total_chats"]  += int(g.get("totalChats") or 0)
                    bot["total_images"] += int(g.get("totalImages") or 0)
                    bot["total_vision"] += int(g.get("totalVision") or 0)
                    for uid, u in (g.get("users") or {}).items():
                        user_ids.add(uid)
                        if not isinstance(u, dict): continue
                        agg = user_agg.setdefault(uid, {"chats": 0, "images": 0, "vision": 0})
                        agg["chats"]  += int(u.get("chats")  or 0)
                        agg["images"] += int(u.get("images") or 0)
                        agg["vision"] += int(u.get("vision") or 0)
                    for date, bucket in (g.get("dayBuckets") or {}).items():
                        if not isinstance(bucket, dict): continue
                        d = day_agg.setdefault(date, {"chats": 0, "images": 0, "vision": 0})
                        d["chats"]  += int(bucket.get("chats")  or 0)
                        d["images"] += int(bucket.get("images") or 0)
                        d["vision"] += int(bucket.get("vision") or 0)
                    for k, v in (g.get("byPersona") or {}).items():
                        persona_agg[str(k)] = persona_agg.get(str(k), 0) + int(v or 0)
                    for k, v in (g.get("byImageStyle") or {}).items():
                        image_style_agg[str(k)] = image_style_agg.get(str(k), 0) + int(v or 0)
                    for k, v in (g.get("byChatModel") or {}).items():
                        chat_model_agg[str(k)] = chat_model_agg.get(str(k), 0) + int(v or 0)
                bot["user_count"]     = len(user_ids)
                bot["by_persona"]     = persona_agg
                bot["by_image_style"] = image_style_agg
                bot["by_chat_model"]  = chat_model_agg
                # Top contributors: sorted by total activity (chats + images +
                # vision). Top 10. Bot has no display names — the GUI shows
                # the snowflake's last 6 digits as a stand-in.
                ranked = []
                for uid, u in user_agg.items():
                    total = u["chats"] + u["images"] + u["vision"]
                    if total <= 0: continue
                    ranked.append({
                        "id":     uid,
                        "tag":    "@" + uid[-6:],   # stand-in until display names ship
                        "count":  total,
                        "chats":  u["chats"],
                        "images": u["images"],
                        "vision": u["vision"],
                    })
                ranked.sort(key=lambda x: x["count"], reverse=True)
                bot["top_contributors"] = ranked[:10]
            except Exception as e:
                bot["error"] = str(e)
        else:
            bot["top_contributors"] = []
        # Merge web-playground chat counters into the bot's by_persona /
        # by_chat_model so the dashboard breakdowns reflect total chat
        # activity (Discord bot + web playground). Reuses the same
        # stats_provider callback (NOT a dynamic re-import) for the same
        # __main__-module-instance-mismatch reason as above.
        try:
            ai_stats = (stats_provider() if stats_provider else {}) or {}
            for k, v in (ai_stats.get("web_chat_by_persona") or {}).items():
                bot["by_persona"][str(k)] = bot["by_persona"].get(str(k), 0) + int(v or 0)
            for k, v in (ai_stats.get("web_chat_by_model") or {}).items():
                bot["by_chat_model"][str(k)] = bot["by_chat_model"].get(str(k), 0) + int(v or 0)
        except Exception:
            pass
        out["bot"] = bot

        # Last-30-day buckets (newest last) with gap-filling
        from datetime import date as _date, timedelta as _timedelta
        today = _date.today()
        day_buckets = []
        for i in range(30):
            d = today - _timedelta(days=29 - i)
            key = d.isoformat()
            b = day_agg.get(key, {"chats": 0, "images": 0, "vision": 0})
            day_buckets.append({"date": key, **b})
        out["bot"]["day_buckets"] = day_buckets

        # 30-day deltas (current 30d vs prior 30d). If we don't have prior-30d
        # data (fresh install or pre-rollover), report None so the GUI hides
        # the delta instead of showing 0% or a misleading +100%.
        def _sum_window(key: str, start_offset: int, end_offset: int) -> int:
            total = 0
            for i in range(start_offset, end_offset):
                d = today - _timedelta(days=i)
                b = day_agg.get(d.isoformat())
                if b: total += int(b.get(key) or 0)
            return total

        def _pct_change(current: int, prior: int) -> float | None:
            if prior == 0:
                return None  # avoid divide-by-zero / +infinity
            return round(((current - prior) / prior) * 100.0, 1)

        out["deltas"] = {
            "messages_30d_pct": _pct_change(_sum_window("chats", 0, 30),  _sum_window("chats", 30, 60)),
            "images_30d_pct":   _pct_change(_sum_window("images", 0, 30), _sum_window("images", 30, 60)),
            "vision_30d_pct":   _pct_change(_sum_window("vision", 0, 30), _sum_window("vision", 30, 60)),
        }

        # Cache: HF scan + Ollama tags
        cache: dict = {"hf_size_bytes": None, "hf_repo_count": None, "ollama_tag_count": None}
        try:
            info, scan_err = _safe_scan_hf_cache()
            if info is not None:
                cache["hf_size_bytes"] = int(getattr(info, "size_on_disk", 0) or 0)
                cache["hf_repo_count"] = len(getattr(info, "repos", []) or [])
            if scan_err:
                cache["scan_error"] = scan_err
        except Exception as exc:
            cache["scan_error"] = f"{type(exc).__name__}: {exc}"[:200]
        # Ollama tag count (best-effort; daemon may be down)
        try:
            import local_ai_server as _lai
            if _lai.ollama_available():
                cache["ollama_tag_count"] = len(_lai.ollama_list_tags())
        except Exception:
            pass
        out["cache"] = cache

        return out

    @app.get("/stats/snapshot")
    async def get_stats_snapshot():
        # async + to_thread: HF scan + bot-stats file read + day-bucket
        # aggregation shouldn't block the event loop or queue with /chat.
        import asyncio as _aio_st
        return await _aio_st.to_thread(_compute_stats_snapshot)

    # Auto-wire stats.tick provider so the WS bus broadcasts a fresh snapshot
    # every TICK_CADENCE_SEC["stats"] without callers having to pass it.
    if tick_providers is not None and "stats" not in tick_providers:
        tick_providers["stats"] = _compute_stats_snapshot

    # ----- POST /cache/prune -----
    # Frees disk space by deleting HF snapshots older than --keep-recent (oldest
    # repos first, by last_accessed). Backs the app.html "Prune cache (4.2 GB)"
    # button. Token-required because it's destructive.
    @app.post("/cache/prune", dependencies=[Depends(_require_gui_token)])
    def post_cache_prune():
        event_bus.publish_sync({"type": "cache.prune.started", "data": {}})
        info, scan_err = _safe_scan_hf_cache()
        if info is None:
            event_bus.publish_sync({"type": "cache.prune.failed",
                                    "data": {"error": scan_err or "huggingface_hub not installed"}})
            raise HTTPException(503, scan_err or "huggingface_hub not installed (install ML deps first)")
        if not info.repos:
            event_bus.publish_sync({"type": "cache.prune.complete",
                                    "data": {"freed_bytes": 0, "revisions_deleted": 0,
                                             "note": scan_err or "HF cache directory not found"}})
            return {"ok": True, "freed_bytes": 0,
                    "note": scan_err or "HF cache directory not found"}
        if scan_err and not hasattr(info, "delete_revisions"):
            # Partial-scan fallback can't call delete_revisions — surface honestly.
            event_bus.publish_sync({"type": "cache.prune.failed", "data": {"error": scan_err}})
            raise HTTPException(503, f"cache scan only completed partially; prune unavailable. {scan_err}")

        # Conservative policy: only prune revisions that aren't the "current"
        # (refs) revision. Pinned models we use every day stay put; we just
        # drop downloaded-but-untagged-anymore revisions.
        revisions_to_delete = []
        for repo in info.repos:
            for rev in repo.revisions:
                if not rev.refs:  # not referenced by any ref → unreachable
                    revisions_to_delete.append(rev.commit_hash)
                    event_bus.publish_sync({"type": "cache.prune.line",
                                            "data": {"line": f"queued: {repo.repo_id}@{rev.commit_hash[:8]}"}})
                    event_bus.publish_sync({"type": "cache.prune.progress",
                                            "data": {"current": len(revisions_to_delete),
                                                     "label": repo.repo_id}})
        if not revisions_to_delete:
            event_bus.publish_sync({"type": "cache.prune.complete",
                                    "data": {"freed_bytes": 0, "revisions_deleted": 0,
                                             "note": "nothing to prune (all revisions still referenced)"}})
            return {"ok": True, "freed_bytes": 0, "note": "nothing to prune (all revisions still referenced)"}

        try:
            delete_strategy = info.delete_revisions(*revisions_to_delete)
            freed = int(delete_strategy.expected_freed_size)
            delete_strategy.execute()
            event_bus.publish_sync({"type": "cache.prune.complete",
                                    "data": {"freed_bytes": freed,
                                             "revisions_deleted": len(revisions_to_delete)}})
            return {
                "ok": True,
                "freed_bytes": freed,
                "revisions_deleted": len(revisions_to_delete),
                "note": f"deleted {len(revisions_to_delete)} unreferenced revision(s)",
            }
        except Exception as e:
            event_bus.publish_sync({"type": "cache.prune.failed", "data": {"error": str(e)[:240]}})
            raise HTTPException(500, f"prune failed: {e}")

    # ----- POST /deps/install -----
    # Pairs with GET /ml_deps on the local_ai_server side. When the user
    # clicks "Install ML libraries" in the GUI banner, this endpoint spawns
    # `python -m pip install --user -r <requirements_file>` in a background
    # thread and streams pip's stdout/stderr to the event bus as
    # `deps.install.line` events. Front-end consumers (the install modal)
    # subscribe to those events to show progress.
    #
    # Token-required because pip-install can take ~5 minutes and pull ~2 GB,
    # so we don't want a random caller kicking it off.
    #
    # We deliberately don't tail-existing-install-job — if you POST twice,
    # both threads run pip in parallel against the same site-packages.
    # That's safe (pip itself locks) but wasteful. The frontend should gate
    # its own button to prevent re-clicks; we don't enforce it server-side.
    _ALLOWED_REQUIREMENTS_FILES = {"requirements-ml.txt", "requirements-local.txt"}
    # P0-5 hardening: serialize installs server-side. The frontend gates its
    # button, but a stray double-POST (or a second client) would otherwise
    # spawn a second pip against the same site-packages. pip self-locks so it's
    # not corrupting, just wasteful — reject the duplicate up front instead of
    # relying on the UI. Acquired non-blocking in the handler, released in
    # run_install's finally (Python Locks are not owner-bound, so the daemon
    # thread can release what the request thread acquired).
    _deps_install_lock = threading.Lock()

    @app.post("/deps/install", dependencies=[Depends(_require_gui_token)])
    def post_deps_install(body: DepsInstallBody):
        import sys
        import threading

        req_name = (body.requirements_file or "requirements-ml.txt").strip()
        if req_name not in _ALLOWED_REQUIREMENTS_FILES:
            raise HTTPException(400,
                f"requirements_file must be one of {sorted(_ALLOWED_REQUIREMENTS_FILES)}; got {req_name!r}")
        req_path = root / req_name
        if not req_path.is_file():
            raise HTTPException(404, f"{req_name} not found at {req_path}")

        # --user is pip's per-user install dir (~/AppData/Roaming/Python/...).
        # Inside a venv, pip REFUSES --user with: "Can not perform a '--user'
        # install. User site-packages are not visible in this virtualenv."
        # So drop the flag when we detect we're running under a venv —
        # otherwise the install fails before pip even starts downloading
        # anything. Matches sidecar.rs::pip_install's logic.
        py_str_lower = sys.executable.lower()
        in_venv = (
            bool(os.environ.get("VIRTUAL_ENV"))
            or ".venv" in py_str_lower
            or "\\venv\\" in py_str_lower
            or "/venv/" in py_str_lower
        )

        def run_install():
            # Keep a rolling tail of pip stdout/stderr so the failed event
            # can include the last few lines as diagnostic context. Without
            # this the user just sees 'exit_code: 1' and has no clue WHY —
            # pip's actual error (often 'no wheels for Python 3.14' or
            # 'Microsoft Visual C++ 14.0 is required') gets lost.
            from collections import deque
            tail = deque(maxlen=40)
            pip_args = [sys.executable, "-m", "pip", "install", "--upgrade"]
            if not in_venv:
                pip_args.append("--user")
            pip_args.extend(["-r", str(req_path)])
            cmd_str = " ".join(pip_args)
            try:
                event_bus.publish_sync({
                    "type": "deps.install.started",
                    "data": {
                        "requirements_file": req_name,
                        "venv": in_venv,
                        "python": sys.executable,
                        "cmd": cmd_str,
                    },
                })
                proc = subprocess.Popen(
                    pip_args,
                    cwd=str(root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
                # Stream pip output line-by-line so the frontend can show
                # progress. pip emits "Downloading torch-X.Y.Z-cu128 ..." style
                # lines that are useful to surface.
                if proc.stdout is not None:
                    for line in proc.stdout:
                        stripped = line.rstrip()
                        tail.append(stripped)
                        event_bus.publish_sync({
                            "type": "deps.install.line",
                            "data": {"line": stripped},
                        })
                proc.wait()
                if proc.returncode == 0:
                    event_bus.publish_sync({
                        "type": "deps.install.complete",
                        "data": {"requirements_file": req_name},
                    })
                else:
                    # Surface the last ~40 lines as a single 'detail' string so
                    # the GUI can show the actual pip error in the failure
                    # banner. Also classify common Windows / Python pitfalls
                    # so the user gets a hint, not just a raw traceback.
                    tail_text = "\n".join(tail).strip()
                    hint = ""
                    blob = tail_text.lower()
                    if "resolutionimpossible" in blob or "conflicting dependencies" in blob:
                        # pip's dependency resolver gave up — usually because
                        # we pinned package A to a version whose torch-pin
                        # disagrees with our own torch-pin. The pip output
                        # already names the culprits ("X depends on torch==Y");
                        # we point the user at the conflict resolution path.
                        hint = (
                            "Dependency conflict between two pinned packages. "
                            "Read the 'The conflict is caused by:' lines above "
                            "— they name which packages disagree on a torch "
                            "version. Drop the optional one from "
                            "requirements-ml.txt, or pin all three to a "
                            "matching triple (torch/torchvision/torchaudio all "
                            "ship the same minor)."
                        )
                    elif "no matching distribution found" in blob or "could not find a version" in blob:
                        # Disambiguate: if pip printed a "(from versions: ...)"
                        # list with cu-tagged builds available, the running
                        # Python isn't the problem — the requirements file
                        # pins a version that no longer exists on the index.
                        # Otherwise, default to the "Python too new" hint.
                        m = re.search(r"from versions:\s*([^)]+)\)", blob)
                        if m and "+cu" in m.group(1):
                            hint = (
                                "The requirements file pins a torch+cu128 version "
                                "that's no longer on the cu128 index. This is a "
                                "stale pin, not a Python version problem. Update "
                                "requirements-ml.txt to one of the available "
                                "+cu128 versions, or run the wizard's 'reinstall "
                                "torch with detected variant' fix."
                            )
                        else:
                            hint = (
                                "pip can't find a wheel for this Python version. "
                                "Most likely the running Python is too new (3.13+ "
                                "have limited torch wheel coverage). Install Python "
                                "3.11 or 3.12 alongside, set SEEKDEEP_PYTHON in .env, "
                                "and Reload .env."
                            )
                    elif "microsoft visual c++" in blob and "required" in blob:
                        hint = "A package needs the Visual C++ build tools. Install 'Build Tools for Visual Studio 2022' (vs.microsoft.com → Tools for Visual Studio → Build Tools), reboot, and retry."
                    elif "permission denied" in blob or "access is denied" in blob:
                        hint = "pip can't write to the install location. Try running SeekDeep as administrator once, or set up a venv and point SEEKDEEP_PYTHON at its python.exe."
                    elif "ssl" in blob and ("certificate" in blob or "verify failed" in blob):
                        hint = "pip can't verify HTTPS to pypi. Check that your system time/date is correct and your network doesn't strip TLS certificates (corporate proxies sometimes do)."
                    elif "no module named pip" in blob or "no module named 'pip'" in blob:
                        hint = "pip isn't installed in this Python. Run `python -m ensurepip --upgrade` in a terminal, or reinstall Python with the 'pip' option checked."
                    event_bus.publish_sync({
                        "type": "deps.install.failed",
                        "data": {
                            "requirements_file": req_name,
                            "exit_code": proc.returncode,
                            "cmd": cmd_str,
                            "python": sys.executable,
                            "detail": tail_text[-4000:],  # cap for ws payload
                            "hint": hint,
                        },
                    })
            except FileNotFoundError as exc:
                # python -m pip can't even start — typically pip not bundled
                # with the running Python (rare on Windows; possible after a
                # broken Python uninstall).
                event_bus.publish_sync({
                    "type": "deps.install.failed",
                    "data": {
                        "requirements_file": req_name,
                        "error": f"could not start pip: {exc}",
                        "cmd": cmd_str,
                        "python": sys.executable,
                        "hint": "Python or pip is missing from the install. Reinstall Python from python.org with the 'pip' option checked.",
                        "detail": "\n".join(tail).strip()[-4000:],
                    },
                })
            except Exception as exc:
                event_bus.publish_sync({
                    "type": "deps.install.failed",
                    "data": {
                        "requirements_file": req_name,
                        "error": str(exc)[:400],
                        "cmd": cmd_str,
                        "python": sys.executable,
                        "detail": "\n".join(tail).strip()[-4000:],
                    },
                })
            finally:
                # Release the single-install guard so the next install can run,
                # whether pip succeeded, failed, or raised.
                _deps_install_lock.release()

        # Reject a concurrent install rather than spawn a second pip (P0-5).
        if not _deps_install_lock.acquire(blocking=False):
            return {
                "ok": True,
                "started": False,
                "already_running": True,
                "requirements_file": req_name,
                "note": "a dependency install is already in progress; subscribe to /events for its progress",
            }
        try:
            threading.Thread(target=run_install, daemon=True).start()
        except Exception:
            _deps_install_lock.release()
            raise
        _seekdeep_audit("deps.install", file=req_name)
        return {
            "ok": True,
            "started": True,
            "requirements_file": req_name,
            "note": "subscribe to deps.install.line / deps.install.complete / deps.install.failed on /events",
        }

    # ----- WebSocket /events -----
    # Browsers can't set headers on the initial WS handshake, so auth is via
    # the ?token=<token> query param. Token check is the same compare_digest
    # against the live .env value, so rotation works without restart here too.
    @app.websocket("/events")
    async def events_ws(websocket: WebSocket, token: str = ""):
        if not _token_disabled:
            expected = _current_token()
            if not expected or not secrets.compare_digest(token or "", expected):
                # 4401 = custom close code; clients can distinguish auth from network
                await websocket.close(code=4401, reason="invalid or missing ?token=")
                return
        # Defense-in-depth (mirrors GET /token): reject a browser handshake whose Origin
        # isn't allowlisted. WS handshakes aren't covered by CORS/SOP, so this is the only
        # Origin gate. Server-to-server clients (the bot) send no Origin and still pass.
        _origin = websocket.headers.get("origin") or ""
        if _origin and _origin not in TRUSTED_BROWSER_ORIGINS:
            await websocket.close(code=4403, reason="untrusted Origin")
            return
        await websocket.accept()
        await event_bus.subscribe(websocket)
        # Cap concurrent subscribers (token-gated connection-exhaustion DoS).
        # Checked AFTER subscribe (not as a pre-check before accept): accept()
        # yields to the loop, so a pre-check would let many concurrent handshakes
        # all clear it before any incremented the count (TOCTOU). subscriber_count
        # now includes self, so '>' caps at exactly _MAX_WS_SUBSCRIBERS live sockets.
        if event_bus.subscriber_count > _MAX_WS_SUBSCRIBERS:
            await event_bus.unsubscribe(websocket)
            await websocket.close(code=1013, reason="too many subscribers")
            return
        # Send an initial 'hello' so the client knows the connection is live + auth'd
        try:
            await websocket.send_json({
                "type": "hello",
                "ts": int(time.time() * 1000),
                "data": {"subscribers": event_bus.subscriber_count, "server_time_ms": int(time.time() * 1000)},
            })
        except Exception:
            pass
        try:
            while True:
                # Browsers never send frames; the bot command-bridge client DOES —
                # it replies to `bot.command` with a `bot.command.result` frame,
                # which we route to the waiting Future. Anything else is ignored.
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "bot.command.result":
                    # Anti-spoof: only a socket that registered itself as the bot
                    # bridge may complete a pending command Future. A plain browser
                    # tab on the bus must not be able to forge a result -- and it
                    # never receives the `bot.command` frame (sent only to bridge
                    # sockets) so it can't learn the correlation id either.
                    if websocket in _bot_bridge_sockets:
                        d = msg.get("data")
                        if isinstance(d, dict):
                            _resolve_bot_command(d.get("cid"), d)
                elif msg.get("type") == "bot.bridge.hello":
                    # The bot identifies itself so /bot/command knows it is ACTUALLY
                    # connected (a browser tab also counts as a bus subscriber).
                    # Honour the registration ONLY when (a) the parity bridge feature
                    # is enabled -- with it off (the default) no socket is ever a
                    # bridge, /bot/command stays 404, no result frame is trusted; and
                    # (b) the socket is server-to-server (no Origin header). The bot
                    # sends no Origin; a browser always sends one. This stops a
                    # malicious trusted-origin tab from self-registering as a bridge
                    # (which would otherwise let it receive command cids + forge results).
                    if _bot_bridge_enabled() and not _origin:
                        _bot_bridge_sockets.add(websocket)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _bot_bridge_sockets.discard(websocket)
            await event_bus.unsubscribe(websocket)

    # ----- POST /events/emit -----
    # For producers that aren't already inside an async FastAPI handler
    # (notably the Node bot, which would POST events here from index.js).
    # Token-required so random callers can't spam fake events at the GUI.
    @app.post("/events/emit", dependencies=[Depends(_require_gui_token)])
    async def post_events_emit(event: EventPayload):
        sent = await event_bus.publish({"type": event.type, "data": event.data})
        return {"ok": True, "type": event.type, "subscribers": event_bus.subscriber_count, "delivered": sent}

    # ----- GET /events/status -----
    # Cheap GET so the GUI can probe whether the bus is up + how many subscribers
    # are connected (useful for the "WebSocket connected" indicator in the title bar).
    @app.get("/events/status")
    async def get_events_status():
        return {"ok": True, "subscribers": event_bus.subscriber_count,
                "bot_bridge": _bot_bridge_online(), "server_time_ms": int(time.time() * 1000)}

    # ----- POST /bot/command (GUI -> bot command bridge) -----
    # Feature-gated parity bridge: relay a whitelisted command to the running
    # Discord bot (a WS client on /events) and wait for its correlated reply.
    # 404 when SEEKDEEP_FEATURE_BOT_BRIDGE is off; 503 when nothing is on the bus;
    # 504 on no/slow reply. The bot only whitelists read-only, live-state actions.
    def _bot_bridge_enabled() -> bool:
        return str(_read_env_kv(_env_path).get("SEEKDEEP_FEATURE_BOT_BRIDGE") or "").strip().lower() in ("1", "true", "yes", "on")

    @app.post("/bot/command", dependencies=[Depends(_require_gui_token)])
    async def post_bot_command(cmd: BotCommandBody):
        if not _bot_bridge_enabled():
            raise HTTPException(404, "Bot bridge is disabled (set SEEKDEEP_FEATURE_BOT_BRIDGE=on).")
        action = (cmd.action or "").strip()
        if not action:
            raise HTTPException(400, "action is required")
        if not _bot_bridge_online():
            raise HTTPException(503, "the bot is not connected to the event bus")
        cid = secrets.token_hex(8)
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        _bot_command_pending[cid] = fut
        try:
            # Directed send: the command (and its correlation id) goes ONLY to
            # registered bridge sockets, never broadcast to every browser tab.
            sent = await event_bus.publish_to(list(_bot_bridge_sockets),
                                              {"type": "bot.command",
                                               "data": {"cid": cid, "action": action, "args": cmd.args or {}}})
            if sent == 0:
                # Race: the bot dropped off the bus between the online-check and
                # publish. Fail fast instead of waiting out the timeout.
                raise HTTPException(503, "the bot is not connected to the event bus")
            timeout = max(1.0, min(float(cmd.timeout or 8.0), 30.0))
            try:
                result = await asyncio.wait_for(fut, timeout=timeout)
            except asyncio.TimeoutError:
                raise HTTPException(504, "the bot did not respond in time")
        finally:
            _bot_command_pending.pop(cid, None)
        if not isinstance(result, dict):
            result = {"ok": False, "error": "malformed bot reply"}
        # NB: _seekdeep_audit's first positional IS its own `action` (the audit
        # event name), so the bot action goes under a distinct `cmd` field —
        # passing action= here collided ("multiple values for argument 'action'")
        # and 500'd every bridge command (latent until the bridge was enabled).
        _seekdeep_audit("bot-command", cmd=action, ok=bool(result.get("ok")))
        return {"ok": bool(result.get("ok", True)), "cid": cid,
                "result": result.get("result"), "error": result.get("error")}

    # ====================================================================
    # MEMORY  (read/write per-user facts + presets for memory.html GUI)
    # ====================================================================
    # The bot (index.js) is the canonical writer of data/user-facts.json and
    # data/memory-presets.json via writeJsonAtomic + the Discord
    # remember/recall/forget command handlers. These HTTP routes give the
    # GUI a parallel read+write path so memory.html can flip from mock to
    # live as soon as it sees GET /memory/users return 200. Writes use the
    # same atomic temp-then-rename pattern as the bot, so concurrent writes
    # are bounded to last-writer-wins (acceptable -- memory is low-frequency).
    _user_facts_path = _data_dir / "user-facts.json"
    _memory_presets_path = _data_dir / "memory-presets.json"

    def _read_facts_store() -> dict:
        if not _user_facts_path.is_file():
            return {"users": {}}
        try:
            data = json.loads(_user_facts_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
                return {"users": {}}
            return data
        except Exception:
            return {"users": {}}

    def _read_presets_store() -> dict:
        if not _memory_presets_path.is_file():
            return {"users": {}}
        try:
            data = json.loads(_memory_presets_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
                return {"users": {}}
            return data
        except Exception:
            return {"users": {}}

    def _atomic_write_json(path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp." + str(os.getpid()) + "." + str(threading.get_ident()))
        # PERSIST-3: fsync the temp file before replace so a crash/power-loss can't
        # leave a torn file the readers would treat as empty (silent data loss).
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        tmp.replace(path)
        try:
            dfd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except Exception:
            pass

    class _seekdeep_file_lock:
        """COUP-1 cross-process advisory lock — the twin of index.js's
        seekdeepWithFileLock. Uses the SAME `<path>.lock` sentinel on the SAME
        absolute data-file paths, so this server and the Node bot coordinate their
        read-modify-write of the shared data/*.json files. Steals a stale lock
        (crashed holder) after SEEKDEEP_FILE_LOCK_STALE_MS and FAILS CLOSED
        (raises HTTPException 503) after SEEKDEEP_FILE_LOCK_TIMEOUT_MS — audit M-2:
        a GUI mutation never silently loses a concurrent update by proceeding
        without the lock. (The Node bot's twin stays fail-open — no HTTP caller to
        retry, and forward progress matters there.)

        FUTURE (async upgrade): mirror index.js — swap the time.sleep wait for an
        await-based one in an async sibling; call sites stay `with`-scoped here."""
        _TIMEOUT_MS = max(0, int(os.getenv("SEEKDEEP_FILE_LOCK_TIMEOUT_MS", "2000") or 0))
        _STALE_MS = max(1000, int(os.getenv("SEEKDEEP_FILE_LOCK_STALE_MS", "15000") or 0))

        def __init__(self, path) -> None:
            self._lock_path = str(path) + ".lock"
            self._acquired = False

        def __enter__(self):
            start = time.time()
            while True:
                try:
                    fd = os.open(self._lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    try:
                        os.write(fd, f"{os.getpid()} {time.time():.3f}".encode())
                    finally:
                        os.close(fd)
                    self._acquired = True
                    break
                except FileExistsError:
                    try:
                        age_ms = (time.time() - os.path.getmtime(self._lock_path)) * 1000.0
                        if age_ms > self._STALE_MS:
                            try:
                                os.unlink(self._lock_path)
                            except OSError:
                                pass
                            continue
                    except OSError:
                        continue
                    if (time.time() - start) * 1000.0 >= self._TIMEOUT_MS:
                        # Fail CLOSED (audit M-2): the GUI write paths are a
                        # read-modify-write, so proceeding WITHOUT the lock could
                        # silently clobber the other process's update (atomic
                        # writes stop torn JSON, not a lost logical merge). A
                        # timeout is rare — writes are sub-ms; this only trips
                        # under genuine contention or a crashed holder not yet
                        # aged to the stale threshold — so surface a retryable 503
                        # rather than lose data. (Node's twin lock stays fail-open.)
                        print(f"[SeekDeep] file lock timeout on {os.path.basename(self._lock_path)}; failing closed (503).", flush=True)
                        raise HTTPException(503, "config store is busy; retry in a moment")
                    time.sleep(0.025)
                except OSError as exc:
                    print(f"[SeekDeep] file lock error on {os.path.basename(self._lock_path)}: {exc}; proceeding.", flush=True)
                    break
            return self

        def __exit__(self, *exc) -> bool:
            if self._acquired:
                try:
                    os.unlink(self._lock_path)
                except OSError:
                    pass
            return False

    def _user_row_bytes(facts: list) -> int:
        try:
            return len(json.dumps(facts, ensure_ascii=False).encode("utf-8"))
        except Exception:
            return 0

    @app.get("/memory/users", dependencies=[Depends(_require_gui_token)])
    def memory_list_users():
        """Summary of every user with stored facts. Token-gated (AUD-003 — user
        facts contain Discord IDs + arbitrary remembered text and should not
        be browsable by any local process)."""
        store = _read_facts_store()
        out = []
        for uid, row in (store.get("users") or {}).items():
            facts = row.get("facts") if isinstance(row, dict) else None
            if not isinstance(facts, list):
                continue
            out.append({
                "user_id": str(uid),
                "display": str(uid),   # bot writes raw IDs; GUI can resolve to names client-side
                "fact_count": len(facts),
                "bytes": _user_row_bytes(facts),
                "updatedAt": (row.get("updatedAt") if isinstance(row, dict) else None),
            })
        # Newest-updated first; deterministic order for clients
        out.sort(key=lambda u: (u["updatedAt"] or ""), reverse=True)
        return {"ok": True, "users": out}

    @app.get("/memory/user/{user_id}", dependencies=[Depends(_require_gui_token)])
    def memory_get_user(user_id: str):
        """Full row for one user. 404 if no row. Token-gated (AUD-003)."""
        store = _read_facts_store()
        row = (store.get("users") or {}).get(str(user_id))
        if not isinstance(row, dict) or not isinstance(row.get("facts"), list):
            raise HTTPException(404, f"no memory row for user {user_id!r}")
        facts = row["facts"]
        return {
            "ok": True,
            "user_id": str(user_id),
            "facts": facts,
            "updatedAt": row.get("updatedAt"),
            "bytes": _user_row_bytes(facts),
        }

    @app.post("/memory/user/{user_id}/fact", dependencies=[Depends(_require_gui_token)])
    def memory_add_fact(user_id: str, body: FactBody):
        """Append one fact. 422 on >MAX_CHARS or when the user already has MAX_FACTS."""
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(422, "fact text is required")
        if len(text) > _MEMORY_FACT_MAX_CHARS:
            raise HTTPException(422, f"fact exceeds {_MEMORY_FACT_MAX_CHARS}-char cap")
        with _seekdeep_file_lock(_user_facts_path):
            store = _read_facts_store()
            store["users"] = store.get("users") or {}
            row = store["users"].get(str(user_id)) or {"facts": [], "updatedAt": None}
            if not isinstance(row.get("facts"), list):
                row["facts"] = []
            if len(row["facts"]) >= _MEMORY_FACTS_MAX:
                raise HTTPException(422, f"user already has {_MEMORY_FACTS_MAX} facts (cap reached)")
            row["facts"].append({"text": text, "at": int(time.time() * 1000)})
            row["updatedAt"] = _now_iso()
            store["users"][str(user_id)] = row
            _atomic_write_json(_user_facts_path, store)
            return {"ok": True, "index": len(row["facts"])}

    @app.patch("/memory/user/{user_id}/fact/{n}", dependencies=[Depends(_require_gui_token)])
    def memory_update_fact(user_id: str, n: int, body: FactBody):
        """Update fact at 1-based index n. 404 if out of range, 422 if too long."""
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(422, "fact text is required")
        if len(text) > _MEMORY_FACT_MAX_CHARS:
            raise HTTPException(422, f"fact exceeds {_MEMORY_FACT_MAX_CHARS}-char cap")
        with _seekdeep_file_lock(_user_facts_path):
            store = _read_facts_store()
            row = (store.get("users") or {}).get(str(user_id))
            if not isinstance(row, dict) or not isinstance(row.get("facts"), list):
                raise HTTPException(404, f"no memory row for user {user_id!r}")
            idx = n - 1
            if idx < 0 or idx >= len(row["facts"]):
                raise HTTPException(404, f"no fact at index {n} (user has {len(row['facts'])})")
            existing = row["facts"][idx]
            if isinstance(existing, dict):
                existing["text"] = text
            else:
                row["facts"][idx] = {"text": text, "at": int(time.time() * 1000)}
            row["updatedAt"] = _now_iso()
            store["users"][str(user_id)] = row
            _atomic_write_json(_user_facts_path, store)
            return {"ok": True}

    @app.delete("/memory/user/{user_id}/fact/{n}", dependencies=[Depends(_require_gui_token)])
    def memory_delete_fact(user_id: str, n: int):
        """Remove fact at 1-based index n. 404 if out of range."""
        with _seekdeep_file_lock(_user_facts_path):
            store = _read_facts_store()
            row = (store.get("users") or {}).get(str(user_id))
            if not isinstance(row, dict) or not isinstance(row.get("facts"), list):
                raise HTTPException(404, f"no memory row for user {user_id!r}")
            idx = n - 1
            if idx < 0 or idx >= len(row["facts"]):
                raise HTTPException(404, f"no fact at index {n} (user has {len(row['facts'])})")
            removed = row["facts"].pop(idx)
            row["updatedAt"] = _now_iso()
            store["users"][str(user_id)] = row
            _atomic_write_json(_user_facts_path, store)
            return {"ok": True, "removed": removed if isinstance(removed, dict) else {"text": str(removed), "at": None}}

    @app.delete("/memory/user/{user_id}", dependencies=[Depends(_require_gui_token)])
    def memory_clear_user(user_id: str):
        """Wipe every fact for a user. 404 if no row to begin with."""
        with _seekdeep_file_lock(_user_facts_path):
            store = _read_facts_store()
            row = (store.get("users") or {}).get(str(user_id))
            if not isinstance(row, dict) or not isinstance(row.get("facts"), list):
                raise HTTPException(404, f"no memory row for user {user_id!r}")
            removed_n = len(row["facts"])
            del store["users"][str(user_id)]
            _atomic_write_json(_user_facts_path, store)
            return {"ok": True, "removed_facts": removed_n}

    @app.get("/memory/user/{user_id}/export", dependencies=[Depends(_require_gui_token)])
    def memory_export_user(user_id: str):
        """Download a single user's row as application/json with a Content-Disposition
        attachment header so a browser triggers a save dialog. 404 if no row.
        Token-gated (AUD-003)."""
        store = _read_facts_store()
        row = (store.get("users") or {}).get(str(user_id))
        if not isinstance(row, dict) or not isinstance(row.get("facts"), list):
            raise HTTPException(404, f"no memory row for user {user_id!r}")
        payload = {"user_id": str(user_id), **row}
        body = json.dumps(payload, indent=2).encode("utf-8")
        safe_id = re.sub(r"[^A-Za-z0-9_-]+", "_", str(user_id))[:64] or "user"
        return JSONResponse(
            content=payload,
            headers={"Content-Disposition": f'attachment; filename="seekdeep-memory-{safe_id}.json"'},
        )

    @app.get("/memory/presets/{user_id}", dependencies=[Depends(_require_gui_token)])
    def memory_get_presets(user_id: str):
        """Get the active preset keys for a user. Returns empty list if no row.
        Token-gated (AUD-003)."""
        store = _read_presets_store()
        row = (store.get("users") or {}).get(str(user_id))
        if isinstance(row, dict) and isinstance(row.get("presets"), list):
            return {"ok": True, "presets": list(row["presets"]), "updatedAt": row.get("updatedAt")}
        return {"ok": True, "presets": [], "updatedAt": None}

    @app.post("/memory/presets/{user_id}", dependencies=[Depends(_require_gui_token)])
    def memory_set_presets(user_id: str, body: PresetsBody):
        """Replace a user's preset list. 400 on any unknown key."""
        cleaned = [str(k).strip().lower() for k in (body.presets or []) if str(k).strip()]
        unknown = [k for k in cleaned if k not in _MEMORY_KNOWN_PRESETS]
        if unknown:
            raise HTTPException(400, f"unknown preset key(s): {', '.join(sorted(set(unknown)))}")
        # Dedupe while preserving order
        seen, deduped = set(), []
        for k in cleaned:
            if k not in seen:
                seen.add(k)
                deduped.append(k)
        with _seekdeep_file_lock(_memory_presets_path):
            store = _read_presets_store()
            store["users"] = store.get("users") or {}
            store["users"][str(user_id)] = {"presets": deduped, "updatedAt": _now_iso()}
            _atomic_write_json(_memory_presets_path, store)
            return {"ok": True}

    # =====================================================================
    # Prompt templates — GUI write endpoints. The bot already writes to
    # data/prompt-templates.json via @SeekDeep template slash commands;
    # this closes the GUI persistence gap (was read-only before).
    #
    # Schema on disk (matches bot writer):
    #   { guilds: { <gid>: { <uid>: { <name>: { prompt, vars?,
    #                                            createdAt, updatedAt,
    #                                            usedCount } } } } }
    # IDs surfaced to the GUI are "<gid>:<uid>:<name>" — match the
    # _normalize_prompt_templates fan-out so the same id works for read
    # and write paths.
    # =====================================================================
    _prompt_templates_path = _data_dir / "prompt-templates.json"

    def _read_prompt_templates_store() -> dict:
        if not _prompt_templates_path.is_file():
            return {"guilds": {}}
        try:
            data = json.loads(_prompt_templates_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"guilds": {}}
            data["guilds"] = data.get("guilds") or {}
            return data
        except Exception:
            return {"guilds": {}}

    import re as _re_for_vars
    _PROMPT_VAR_RE = _re_for_vars.compile(r"\{\{\s*([a-z0-9_-]{1,40})\s*\}\}", _re_for_vars.IGNORECASE)

    # ----- GET /prompts/channels -----
    # The #prompts channels admins have configured ("@SeekDeep prompts channel
    # here"), read from the bot's archive-guild-config.json. Lets the Prompts page
    # deep-link straight into the Discord desktop client
    # (discord://-/channels/<guild>/<channel>) instead of telling the user to find
    # the channel by hand. IDs only (not sensitive); open like /config/status.
    @app.get("/prompts/channels")
    def get_prompts_channels():
        out = []
        try:
            p = _data_dir / "archive-guild-config.json"
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8", errors="replace"))
                for gid, g in (data.get("guilds") or {}).items():
                    cid = str((g or {}).get("promptsChannelId") or "").strip()
                    if cid:
                        out.append({"guild_id": str(gid), "channel_id": cid})
        except Exception:
            pass
        return {"ok": True, "channels": out}

    @app.post("/prompts/template", dependencies=[Depends(_require_gui_token)])
    def post_prompt_template(body: dict):
        guild_id = str((body or {}).get("guild_id") or "").strip()
        owner_user_id = str((body or {}).get("owner_user_id") or "").strip()
        name = str((body or {}).get("name") or "").strip()
        prompt = str((body or {}).get("prompt") or "")
        if not guild_id or not owner_user_id or not name:
            raise HTTPException(400, "guild_id, owner_user_id, and name are required")
        if not prompt:
            raise HTTPException(400, "prompt body is required (non-empty)")
        if len(name) > 80 or not _re_for_vars.match(r"^[a-zA-Z0-9_\-]{1,80}$", name):
            raise HTTPException(400, "name must be 1-80 chars of [a-zA-Z0-9_-]")
        if len(prompt) > 8000:
            raise HTTPException(400, "prompt body exceeds 8000 chars")
        # Re-derive vars from the body so they stay in sync with what the
        # user actually typed. Caller can pass a vars[] override but we
        # ignore it — vars are an emergent property of the prompt text.
        vars_seen: list[str] = []
        for m in _PROMPT_VAR_RE.finditer(prompt):
            v = m.group(1).lower()
            if v not in vars_seen:
                vars_seen.append(v)
        with _seekdeep_file_lock(_prompt_templates_path):
            store = _read_prompt_templates_store()
            g = store["guilds"].setdefault(guild_id, {})
            u = g.setdefault(owner_user_id, {})
            now = _now_iso()
            existing = u.get(name) if isinstance(u.get(name), dict) else None
            u[name] = {
                "prompt":    prompt,
                "vars":      vars_seen,
                "createdAt": (existing or {}).get("createdAt") or now,
                "updatedAt": now,
                "usedCount": int((existing or {}).get("usedCount") or 0),
            }
            _atomic_write_json(_prompt_templates_path, store)
            return {
                "ok": True,
                "id": f"{guild_id}:{owner_user_id}:{name}",
                "created": existing is None,
                "vars": vars_seen,
                "char_count": len(prompt),
            }

    @app.delete("/prompts/template/{template_id:path}", dependencies=[Depends(_require_gui_token)])
    def delete_prompt_template(template_id: str):
        parts = template_id.split(":", 2)
        if len(parts) != 3:
            raise HTTPException(400, "template_id must be '<guild_id>:<owner_user_id>:<name>'")
        guild_id, owner_user_id, name = parts
        with _seekdeep_file_lock(_prompt_templates_path):
            store = _read_prompt_templates_store()
            g = store["guilds"].get(guild_id) or {}
            u = g.get(owner_user_id) or {}
            if name not in u:
                raise HTTPException(404, f"no template {template_id}")
            del u[name]
            # Prune empty branches so the file doesn't accumulate orphan keys.
            if not u:
                del g[owner_user_id]
            if not g:
                del store["guilds"][guild_id]
            _atomic_write_json(_prompt_templates_path, store)
            return {"ok": True, "removed": template_id}

    # =====================================================================
    # Auto-react rules — GUI write endpoints. Same persistence-gap fix
    # for the React Rules pane. The bot owns the file but writes are
    # additive so the GUI can write too without racing the bot's
    # @SeekDeep reactrule command (atomic file write + read-modify-write).
    #
    # Schema on disk:
    #   { guilds: { <gid>: { rules: [{id, emoji, pattern, scope?, target?,
    #                                  enabled, hits, createdAt}],
    #                        builtins: { <key>: { enabled, emoji?,
    #                                              threshold? } } } } }
    # =====================================================================
    _auto_reactions_path = _data_dir / "auto-reactions.json"

    def _read_auto_reactions_store() -> dict:
        if not _auto_reactions_path.is_file():
            return {"guilds": {}}
        try:
            data = json.loads(_auto_reactions_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"guilds": {}}
            data["guilds"] = data.get("guilds") or {}
            return data
        except Exception:
            return {"guilds": {}}

    def _prune_empty_guilds(store: dict) -> dict:
        """Drop guild entries whose `rules` list is empty AND `builtins` has
        no enabled entries. Stops smoke + verify suites from leaving stub
        guild keys (audit §3). Called before every persisted write.
        Also drops guild ids that don't look like Discord snowflakes
        (17–20 digits) UNLESS they're known smoke/verify markers — keeps
        the real production data file clean of test-only fixtures."""
        guilds = store.get("guilds") or {}
        keep = {}
        for gid, g in guilds.items():
            if not isinstance(g, dict):
                continue
            rules = g.get("rules") or []
            builtins_map = g.get("builtins") or {}
            any_builtin_on = any(
                isinstance(b, dict) and b.get("enabled") is not False
                for b in builtins_map.values()
            )
            if not rules and not any_builtin_on:
                continue
            keep[gid] = g
        store["guilds"] = keep
        return store

    def _new_rule_id() -> str:
        return f"rr_{secrets.token_hex(8)}"

    @app.post("/reacts/rule", dependencies=[Depends(_require_gui_token)])
    def post_reacts_rule(body: dict):
        guild_id = str((body or {}).get("guild_id") or "").strip()
        emoji = str((body or {}).get("emoji") or "").strip()
        pattern = str((body or {}).get("pattern") or "").strip()
        scope = str((body or {}).get("scope") or "").strip().lower()
        target = str((body or {}).get("target") or "").strip()
        # Accept a Discord mention (<@id>, <@!id>, <#id>, <@&id>) OR a raw ID and
        # normalize to the bare numeric ID. Without this, a target pasted as
        # "<@123>" (what you get by copying a mention) is stored verbatim and
        # never matches — the matcher compares against the raw author/channel id,
        # so the rule silently never fires.
        if target:
            _digits = re.sub(r"\D", "", target)
            if _digits and 15 <= len(_digits) <= 21:
                target = _digits
        enabled = (body or {}).get("enabled")
        if enabled is None: enabled = True
        if not guild_id or not emoji or not pattern:
            raise HTTPException(400, "guild_id, emoji, and pattern are required")
        if scope and scope not in ("channel", "user"):
            raise HTTPException(400, "scope must be 'channel' or 'user' (or omitted)")
        if scope and not target:
            raise HTTPException(400, "scope was set but target is empty")
        if len(pattern) > 400:
            raise HTTPException(400, "pattern exceeds 400 chars")
        with _seekdeep_file_lock(_auto_reactions_path):
            store = _read_auto_reactions_store()
            g = store["guilds"].setdefault(guild_id, {})
            rules = g.setdefault("rules", [])
            rule = {
                "id":       _new_rule_id(),
                "emoji":    emoji,
                "pattern":  pattern,
                "enabled":  bool(enabled),
                "hits":     0,
                "createdAt": _now_iso(),
            }
            if scope:
                rule["scope"] = scope
                rule["target"] = target
            rules.append(rule)
            _atomic_write_json(_auto_reactions_path, _prune_empty_guilds(store))
            return {"ok": True, "rule": rule}

    @app.patch("/reacts/rule/{rule_id}", dependencies=[Depends(_require_gui_token)])
    def patch_reacts_rule(rule_id: str, body: dict):
        # Locate the rule across guilds — GUI may not know which guild
        # owns it from the id alone.
        with _seekdeep_file_lock(_auto_reactions_path):
            store = _read_auto_reactions_store()
            for gid, g in store["guilds"].items():
                for r in (g.get("rules") or []):
                    if r.get("id") == rule_id:
                        if "emoji" in body and body["emoji"]:
                            r["emoji"] = str(body["emoji"])
                        if "pattern" in body and body["pattern"]:
                            if len(str(body["pattern"])) > 400:
                                raise HTTPException(400, "pattern exceeds 400 chars")
                            r["pattern"] = str(body["pattern"])
                        if "enabled" in body:
                            r["enabled"] = bool(body["enabled"])
                        if "scope" in body:
                            s = str(body["scope"] or "").lower()
                            if s and s not in ("channel", "user"):
                                raise HTTPException(400, "scope must be 'channel' or 'user'")
                            if s:
                                r["scope"] = s
                                r["target"] = str(body.get("target") or r.get("target") or "")
                            else:
                                r.pop("scope", None); r.pop("target", None)
                        r["updatedAt"] = _now_iso()
                        _atomic_write_json(_auto_reactions_path, _prune_empty_guilds(store))
                        return {"ok": True, "rule": r, "guild_id": gid}
            raise HTTPException(404, f"no rule {rule_id}")

    @app.delete("/reacts/rule/{rule_id}", dependencies=[Depends(_require_gui_token)])
    def delete_reacts_rule(rule_id: str):
        with _seekdeep_file_lock(_auto_reactions_path):
            store = _read_auto_reactions_store()
            for gid, g in store["guilds"].items():
                rules = g.get("rules") or []
                for i, r in enumerate(rules):
                    if r.get("id") == rule_id:
                        rules.pop(i)
                        _atomic_write_json(_auto_reactions_path, _prune_empty_guilds(store))
                        return {"ok": True, "removed": rule_id, "guild_id": gid}
            raise HTTPException(404, f"no rule {rule_id}")

    @app.post("/reacts/builtin/{key}", dependencies=[Depends(_require_gui_token)])
    def post_reacts_builtin(key: str, body: dict):
        # Per-guild builtin toggle. Body: { guild_id, enabled?, threshold? }
        guild_id = str((body or {}).get("guild_id") or "").strip()
        if not guild_id:
            raise HTTPException(400, "guild_id is required")
        key = key.strip()
        ALLOWED_BUILTINS = {"long_message", "forwarded", "code_block", "image_only", "link_only"}
        if key not in ALLOWED_BUILTINS:
            raise HTTPException(400, f"unknown builtin key {key!r}; allowed: {sorted(ALLOWED_BUILTINS)}")
        with _seekdeep_file_lock(_auto_reactions_path):
            store = _read_auto_reactions_store()
            g = store["guilds"].setdefault(guild_id, {})
            builtins = g.setdefault("builtins", {})
            b = builtins.setdefault(key, {})
            if "enabled" in body:  b["enabled"] = bool(body["enabled"])
            if "threshold" in body and body["threshold"] is not None:
                try:
                    b["threshold"] = int(body["threshold"])
                except (TypeError, ValueError):
                    raise HTTPException(400, "threshold must be an integer")
            if "emoji" in body and body["emoji"]:
                b["emoji"] = str(body["emoji"])
            _atomic_write_json(_auto_reactions_path, _prune_empty_guilds(store))
            return {"ok": True, "key": key, "guild_id": guild_id, "value": b}

    # ----- Heartbeat producer -----
    # Emits {"type":"heartbeat","data":{"server_time_ms":...,"subscribers":N}}
    # every HEARTBEAT_SEC. Gives clients a connection-keepalive AND a canary
    # so the bus is provably alive even before real producers (model.loaded,
    # vram.sample, etc.) are wired. Disabled when no subscribers to avoid
    # logging noise.
    HEARTBEAT_SEC = 10.0

    async def _heartbeat_loop():
        while True:
            try:
                await asyncio.sleep(HEARTBEAT_SEC)
                if event_bus.subscriber_count > 0:
                    await event_bus.publish({
                        "type": "heartbeat",
                        "data": {
                            "server_time_ms": int(time.time() * 1000),
                            "subscribers": event_bus.subscriber_count,
                        },
                    })
            except asyncio.CancelledError:
                break
            except Exception:
                # Don't let a stray exception kill the heartbeat task
                await asyncio.sleep(HEARTBEAT_SEC)

    # ----- POST /config/reload -----
    # Re-reads .env from disk into os.environ so config changes (HF_TOKEN,
    # DISCORD_TOKEN, model IDs, feature flags) take effect WITHOUT a sidecar
    # restart. Wired to the Quick Actions "Reload .env" button. Returns
    # the list of keys that changed so the GUI can toast a summary.
    @app.post("/config/reload", dependencies=[Depends(_require_gui_token)])
    async def post_config_reload():
        # async + to_thread: disk I/O + env mutation doesn't fight the sync
        # threadpool for a slot when /chat is mid-load. Was the "Reload .env
        # failed to fetch" toast the user kept seeing.
        import asyncio as _aio_cfg
        return await _aio_cfg.to_thread(_post_config_reload_inner)

    def _post_config_reload_inner():
        changed: list[str] = []
        added: list[str] = []
        try:
            if not _env_path.is_file():
                return {"ok": False, "error": f".env not found at {_env_path}"}
            new_env: dict[str, str] = {}
            for raw in _env_path.read_text(encoding="utf-8").splitlines():
                s = raw.strip()
                if not s or s.startswith("#"):
                    continue
                if "=" not in s:
                    continue
                k, _, v = s.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if not k:
                    continue
                new_env[k] = v
            skipped: list[str] = []
            for k, v in new_env.items():
                # Never let a .env reload apply auth-critical / self-update keys
                # (mirrors the POST /config protected-key guard above). A reload
                # must not be a backdoor to disable the token gate via a tampered
                # .env (e.g. SEEKDEEP_GUI_TOKEN_DISABLED=1). Case-insensitive
                # (Gemini audit): Windows env vars ignore case, so a lowercase
                # key would still take effect — normalize before the check.
                if k.upper() in _CONFIG_PROTECTED_KEYS:
                    skipped.append(k)
                    continue
                old = os.environ.get(k)
                if old is None:
                    added.append(k)
                elif old != v:
                    changed.append(k)
                os.environ[k] = v
            try:
                event_bus.publish_sync({"type": "config.reloaded",
                                         "data": {"changed": changed, "added": added}})
            except Exception:
                pass
            return {"ok": True, "changed": changed, "added": added,
                    "skipped_protected": skipped, "total_keys": len(new_env)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:240]}

    # ----- POST /system/kill-all -----
    # Force-kill EVERY service we manage: bot processes (uses the same
    # _find_bot_processes + _kill_pid that /launcher/bot/kill-all uses),
    # the SearXNG container, AND the in-process flag for AI-server self-
    # kill (we can't kill ourselves cleanly from here — caller should use
    # Tauri's restart_sidecar command for that). Wired to the Quick
    # Actions "Force kill all" button.
    @app.post("/system/kill-all", dependencies=[Depends(_require_gui_token)])
    def post_system_kill_all():
        _seekdeep_audit("system.kill_all")
        results: dict = {}
        # 1. Bot — reuse kill-all logic from above
        try:
            _begin_transition("bot")
            bot_cwd = _resolve_bot_cwd(root)
            procs = _find_bot_processes(bot_cwd)
            killed = []
            for entry in procs:
                ok, err = _kill_pid(entry["pid"])
                killed.append({"pid": entry["pid"], "ok": ok, "error": err})
            # Clean up tracker + PID file so launcher card reflects gone.
            _PROCESSES.pop("bot", None)
            try:
                pid_name = _PID_FILE_NAMES.get("bot")
                if pid_name:
                    (_log_dir / pid_name).unlink(missing_ok=True)
            except OSError:
                pass
            # Invalidate bot-status.json (BOTH possible paths — the one we
            # manage AND the one in the bot's __dirname when SEEKDEEP_BOT_CWD
            # points at the user's repo). Without this, the next /launchers/
            # status read finds a stale ready=true file from before the kill,
            # and the launcher card sits at "READY · DISCORD" for ~90s until
            # the heartbeat-stale check kicks in.
            for candidate in (_data_dir / "bot-status.json",
                              (bot_cwd / "data" / "bot-status.json").resolve()
                              if bot_cwd else None):
                if candidate is None:
                    continue
                try:
                    if candidate.is_file():
                        _atomic_write_json(candidate, {
                            "ready": False,
                            "exited": True,
                            "exit_at": _now_iso(),
                            "exit_reason": "force-kill-all",
                            "pid": None,
                            "heartbeat_at": _now_iso(),
                        })
                except Exception:
                    pass
            # Push a service.state.changed onto the bus so live subscribers
            # flip the card immediately (no waiting for the next 5s tick).
            try:
                event_bus.publish_sync({"type": "service.state.changed",
                                         "data": {"service": "bot",
                                                  "state": "not-running",
                                                  "reason": "force-kill-all"}})
            except Exception:
                pass
            results["bot"] = {"ok": True, "killed": killed, "count": len(killed)}
        except Exception as exc:
            results["bot"] = {"ok": False, "error": str(exc)[:200]}
        finally:
            _end_transition("bot")
        # 2. SearXNG — docker rm -f
        try:
            r = subprocess.run(["docker", "rm", "-f", "seekdeep-searxng"],
                               capture_output=True, text=True, timeout=15)
            results["searxng"] = {"ok": r.returncode == 0,
                                  "removed": "seekdeep-searxng" if r.returncode == 0 else None,
                                  "error": (r.stderr or "")[:200] if r.returncode != 0 else None}
        except Exception as exc:
            results["searxng"] = {"ok": False, "error": str(exc)[:200]}
        # 3. AI server self — refuse, point caller at Tauri restart
        results["ai_server"] = {"ok": False, "skipped": True,
                                "note": "use Tauri restart_sidecar to bounce the AI server"}
        return {"ok": True, "results": results}

    # ----- POST /system/smoke -----
    # Runs the in-process GUI endpoint smoke suite (scripts/smoke_gui_endpoints.py)
    # AND returns the structured pass/fail results. The script was designed
    # for command-line invocation but its check helpers + result list are
    # importable. Wired to the Quick Actions "Smoke test" button so the
    # user gets a single click → results modal instead of a "run this in a
    # terminal" instruction. Times out after 30s; safe to run repeatedly.
    def _run_system_smoke_inner() -> dict:
        import importlib.util
        smoke_path = root / "scripts" / "smoke_gui_endpoints.py"
        if not smoke_path.is_file():
            event_bus.publish_sync({"type": "smoke.failed",
                                    "data": {"error": "smoke script not found"}})
            return {"ok": False, "error": f"smoke script not found at {smoke_path}"}
        import io, contextlib
        buf = io.StringIO()
        spec = importlib.util.spec_from_file_location("seekdeep_smoke_runtime", smoke_path)
        if spec is None or spec.loader is None:
            event_bus.publish_sync({"type": "smoke.failed",
                                    "data": {"error": "could not load smoke script"}})
            return {"ok": False, "error": "could not load smoke script"}
        mod = importlib.util.module_from_spec(spec)
        rc: int | None = None
        event_bus.publish_sync({"type": "smoke.started", "data": {"path": str(smoke_path)}})
        try:
            spec.loader.exec_module(mod)
            # Wrap the smoke script's `check()` so every check emits a
            # smoke.line + smoke.progress event while the suite runs.
            # We don't know `total` until main() is partway through, so
            # progress emits current only when we don't know total yet.
            orig_check = getattr(mod, "check", None)
            seen = {"count": 0}
            def _wrapped_check(name, ok, detail=""):
                ret = orig_check(name, ok, detail) if orig_check else None
                seen["count"] += 1
                marker = "ok" if ok else "FAIL"
                line = f"{marker} {name}" + (f" -> {detail}" if detail else "")
                event_bus.publish_sync({"type": "smoke.line", "data": {"line": line, "ok": bool(ok)}})
                event_bus.publish_sync({"type": "smoke.progress",
                                        "data": {"current": seen["count"], "label": name}})
                return ret
            if orig_check is not None:
                mod.check = _wrapped_check
            if hasattr(mod, "main") and callable(mod.main):
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    try:
                        rc = mod.main()
                    except SystemExit as se:
                        rc = int(se.code) if isinstance(se.code, int) else 1
        except SystemExit as se:
            rc = int(se.code) if isinstance(se.code, int) else 1
        except Exception as exc:
            event_bus.publish_sync({"type": "smoke.failed", "data": {"error": str(exc)[:240]}})
            return {"ok": False, "error": str(exc)[:400],
                    "output": buf.getvalue()[-4000:]}
        results = getattr(mod, "_results", []) or []
        passed = sum(1 for r in results if r and r[0])
        failed = sum(1 for r in results if r and not r[0])
        ok = failed == 0 and (rc in (None, 0))
        topic = "smoke.complete" if ok else "smoke.failed"
        event_bus.publish_sync({"type": topic,
                                "data": {"total": len(results), "passed": passed,
                                         "failed": failed, "exit_code": rc}})
        return {
            "ok": ok,
            "total": len(results),
            "passed": passed,
            "failed": failed,
            "failures": [{"name": r[1], "detail": r[2]} for r in results if r and not r[0]],
            "output": buf.getvalue()[-4000:],
            "exit_code": rc,
        }

    @app.post("/system/smoke", dependencies=[Depends(_require_gui_token)])
    async def post_system_smoke():
        # The smoke suite hits ~50 endpoints sequentially with curl; cold-cache
        # it takes 10-30s. Sync execution blocks every other endpoint —
        # /health, /launchers/status, the whole UI freezes.
        # async + to_thread keeps the event loop responsive; progress is still
        # streamed via the smoke.line / smoke.progress events.
        import asyncio as _asyncio_sm
        return await _asyncio_sm.to_thread(_run_system_smoke_inner)

    # ----- Live-tick producer (replaces client-side polling) -----
    # Cadence per topic. Picked to be roughly twice as frequent as the
    # old setIntervals so the UI feels fresher. Zero-cost when nobody's
    # subscribed (publish() fast-paths to no-op).
    TICK_CADENCE_SEC = {"gpu": 3.0, "health": 5.0, "launchers": 5.0, "stats": 10.0}

    def _read_bot_discord_status() -> dict:
        """Read data/bot-status.json — the bot writes this on every ready /
        disconnect transition and a 30s heartbeat. Returns a normalized dict
        with at least {ready: bool, stale: bool} so the GUI can do branch-
        free rendering. `stale` is true when the file exists but heartbeat
        is > 90s old (means the bot process is alive — process state would
        have flipped otherwise — but the bot is wedged inside the Node loop
        and not writing heartbeats. Surface that as DEGRADED, not READY).

        Path-divergence guard: the bot writes to its OWN __dirname/data/
        which, under Tauri with SEEKDEEP_BOT_CWD pointing at the user's
        repo, is NOT the same path as the AI server's _data_dir. If the
        primary _data_dir copy doesn't exist, fall back to
        ${bot_cwd}/data/bot-status.json. Without this, the watchdog
        false-positives 'Discord not ready', restarts the bot every
        ~45s in an infinite kill-loop even though the bot is logged in
        and happy."""
        path = _data_dir / "bot-status.json"
        if not path.is_file():
            try:
                bot_cwd = _resolve_bot_cwd(root)
                fallback = (bot_cwd / "data" / "bot-status.json").resolve()
                if _is_inside(fallback, bot_cwd) and fallback.is_file():
                    path = fallback
            except Exception:
                pass
        if not path.is_file():
            return {"ready": False, "stale": False, "present": False}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"ready": False, "stale": True, "present": True,
                    "error": "bot-status.json unparseable"}
        if not isinstance(raw, dict):
            return {"ready": False, "stale": True, "present": True}
        # Heartbeat freshness check. Bot heartbeats every 30s; ≥ 90s stale.
        stale = False
        try:
            mtime = path.stat().st_mtime
            stale = (time.time() - mtime) > 90.0
        except OSError:
            stale = True
        # `exited` is from the file. A bot can self-exit, then auto-restart and
        # write a fresh ready=true; older bot builds didn't clear exit_at so the
        # file ends up self-contradictory. Treat exited as ignored when heartbeat
        # is fresher than exit_at (heartbeat wins — we know the bot is alive now).
        exited_flag = bool(raw.get("exited"))
        if exited_flag:
            try:
                hb = raw.get("heartbeat_at")
                ea = raw.get("exit_at")
                if hb and ea and str(hb) > str(ea):  # ISO 8601 sorts lexically
                    exited_flag = False
            except Exception:
                pass
        ready = bool(raw.get("ready")) and not stale and not exited_flag
        return {
            "ready": ready,
            "stale": stale,
            "present": True,
            "user_tag": raw.get("user_tag"),
            "user_id":  raw.get("user_id"),
            "guild_count": raw.get("guild_count"),
            "ready_at":  raw.get("ready_at"),
            "disconnect_at": raw.get("disconnect_at"),
            "last_disconnect_reason": raw.get("last_disconnect_reason"),
            "exited": exited_flag,
            "exit_reason": raw.get("exit_reason") if exited_flag else None,
            "heartbeat_at": raw.get("heartbeat_at"),
        }

    def _build_launchers_tick_payload() -> dict:
        """Slim version of GET /launchers/status — skips the err.log tail
        scan because we'd be doing it every 5s. service.state.changed
        already carries the err.log when an exit actually happens."""
        services_out = {}
        for svc in sorted(ALLOWED_SERVICES):
            info = _service_state(svc, _log_dir)
            pid = info["pid"]
            uptime_s = None
            started_at = None
            if pid is not None:
                name = _PID_FILE_NAMES.get(svc)
                if name:
                    pid_path = _log_dir / name
                    if pid_path.is_file():
                        try:
                            mtime = pid_path.stat().st_mtime
                            uptime_s = int(max(0, time.time() - mtime))
                            started_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                        except OSError:
                            pass
            row = {
                "ok": True, "service": svc,
                "state": info["state"], "pid": pid,
                "count": info["count"], "source": info["source"],
                "transitioning": info["transitioning"],
                "uptime_seconds": uptime_s, "started_at": started_at,
            }
            if svc == "bot":
                row["discord"] = _read_bot_discord_status()
            services_out[svc] = row
            _emit_state_change_if_any(svc, info)
        return {"ok": True, "services": services_out, "generated_at": _now_iso()}

    # Bot Discord watchdog state. Process-up-but-Discord-not-ready is the
    # exact failure mode the launcher pill used to lie about — and the user
    # had to manually click Restart to recover. This guard auto-restarts
    # the bot ONCE per session if Discord doesn't ready within ~45s of the
    # process starting. Subsequent failures need manual intervention (we
    # don't want a restart loop on persistently-bad tokens).
    #
    # ALSO auto-restarts on EXITED state up to N times: catches the case
    # where the bot crashes from a Discord ECONNRESET (transient WS drop)
    # and would otherwise sit as EXITED until the user manually clicks
    # Restart. Capped at SEEKDEEP_BOT_EXIT_RESTART_MAX (default 3) to
    # prevent crash-loops on persistent failures (bad token, missing
    # node_modules, etc).
    _bot_watchdog = {
        "first_running_at": 0.0,
        "auto_restarted": False,
        "exit_restart_count": 0,
        "last_exit_restart_at": 0.0,
        # Startup grace: don't spawn-on-"not-running" during the first 60s
        # of this AI-server process's life. Previous-AI-server's bots may
        # still be alive but not yet visible to psutil from this process's
        # perspective (cache lag), and we don't want to stack a 5th bot on
        # top of 4 existing ones just because we can't see them yet.
        "ai_server_started_at": time.time(),
    }
    _BOT_WATCHDOG_STARTUP_GRACE_S = float(os.getenv("SEEKDEEP_BOT_WATCHDOG_STARTUP_GRACE_S", "60") or 60)

    def _bot_discord_watchdog_check():
        """Called from the tick loop. Two recovery paths:

          (1) bot RUNNING but Discord not ready ≥45s → restart once
              (auto_restarted latches True for the session afterwards)

          (2) bot EXITED → restart up to N times with a 30s cool-down
              between attempts (catches transient Discord ECONNRESETs
              that crashed the bot; gives up if it keeps crashing right
              back so the user sees the err.log instead of a loop)
        """
        try:
            info = _service_state("bot", _log_dir)
            state = info["state"]
            bot_count = int(info.get("count") or 0)
            # If we have ≥1 bot running, this is the SAFE branch. Pile-up
            # reduction: if count > 1, kill the oldest excess so we converge
            # to exactly one bot without ever spawning a new one ourselves.
            if state == "running" and bot_count > 1:
                try:
                    bot_cwd = _resolve_bot_cwd(root)
                    procs = _find_bot_processes(bot_cwd)
                    # Sort by PID (ascending) — kill the OLDEST extras, keep
                    # the newest as the live one. Newest most likely matches
                    # the bot-status.json that downstream readers expect.
                    procs.sort(key=lambda p: p.get("pid") or 0)
                    excess = procs[:-1]  # all but the last (newest)
                    if excess:
                        print(f"[SeekDeep] bot watchdog: {len(procs)} bot instances detected — "
                              f"reaping {len(excess)} excess to converge to 1")
                        for entry in excess:
                            ok, err = _kill_pid(entry["pid"])
                            print(f"[SeekDeep]   reap bot pid {entry['pid']}: "
                                  f"{'killed' if ok else f'failed: {err or 0}'}")
                except Exception as exc:
                    print(f"[SeekDeep] bot watchdog: pile-up reap failed: {exc}")
            if state in ("exited", "not-running"):
                # Reset Discord-watchdog timer; the next spawn gets its
                # own fresh 45s grace window.
                _bot_watchdog["first_running_at"] = 0.0
                # Startup grace: previous AI server's bots may still be
                # alive but not yet visible to psutil from this fresh process.
                # Defer any spawn until we've been up long enough for the
                # scan to be reliable.
                age = time.time() - _bot_watchdog["ai_server_started_at"]
                if age < _BOT_WATCHDOG_STARTUP_GRACE_S:
                    return
                # Exit-respawn path, capped + cooled-down.
                max_restarts = int(os.getenv("SEEKDEEP_BOT_EXIT_RESTART_MAX", "3") or 3)
                cooldown_s = float(os.getenv("SEEKDEEP_BOT_EXIT_RESTART_COOLDOWN_S", "30") or 30)
                now_t = time.time()
                if _bot_watchdog["exit_restart_count"] >= max_restarts:
                    return  # gave up; leave the EXITED card visible
                if now_t - _bot_watchdog["last_exit_restart_at"] < cooldown_s:
                    return  # still in cooldown
                _bot_watchdog["exit_restart_count"] += 1
                _bot_watchdog["last_exit_restart_at"] = now_t
                print(f"[SeekDeep] bot watchdog: bot EXITED, auto-restarting "
                      f"(attempt {_bot_watchdog['exit_restart_count']}/{max_restarts})")
                try:
                    event_bus.publish_sync({"type": "bot.watchdog.restarting",
                                             "data": {"reason": "exited",
                                                      "attempt": _bot_watchdog["exit_restart_count"],
                                                      "max": max_restarts}})
                except Exception:
                    pass
                try:
                    _start_service("bot", root, _log_dir)
                except Exception as exc:
                    print(f"[SeekDeep] bot watchdog: exit-respawn failed: {exc}")
                return
            if state != "running":
                _bot_watchdog["first_running_at"] = 0.0
                return
            # Bot is running — reset the exit-respawn counter so a future
            # crash gets a fresh budget of retries.
            _bot_watchdog["exit_restart_count"] = 0
            _bot_watchdog["last_exit_restart_at"] = 0.0
            now = time.time()
            if _bot_watchdog["first_running_at"] == 0.0:
                _bot_watchdog["first_running_at"] = now
                return  # just observed running; give it the grace window
            if _bot_watchdog["auto_restarted"]:
                return  # already used our one shot
            if now - _bot_watchdog["first_running_at"] < 45.0:
                return  # still inside grace window
            d = _read_bot_discord_status()
            if d.get("ready"):
                return  # all good
            # Process up ≥45s but Discord isn't ready. Auto-restart once.
            _bot_watchdog["auto_restarted"] = True
            print(f"[SeekDeep] bot watchdog: process up {int(now - _bot_watchdog['first_running_at'])}s but Discord not ready — auto-restarting once")
            try:
                event_bus.publish_sync({"type": "bot.watchdog.restarting",
                                         "data": {"reason": "discord-not-ready-after-45s",
                                                  "discord": d}})
            except Exception:
                pass
            try:
                _stop_service("bot", _log_dir)
            except Exception as exc:
                print(f"[SeekDeep] bot watchdog: stop failed: {exc}")
            # Reset the timer so the new spawn gets its own 45s window.
            _bot_watchdog["first_running_at"] = 0.0
            time.sleep(0.8)
            try:
                _start_service("bot", root, _log_dir)
            except Exception as exc:
                print(f"[SeekDeep] bot watchdog: restart failed: {exc}")
        except Exception as exc:
            # Watchdog must never crash the tick loop.
            if os.getenv("SEEKDEEP_DEBUG"):
                print(f"[SeekDeep] bot watchdog error: {exc}")

    # Audit §8 (P2): one canonical status file. Three processes (AI server,
    # bot, Tauri tray) previously each polled a different source and
    # disagreed about "is the bot online" / "is the AI loaded". Now the AI
    # server writes data/system-state.json once per second with EVERY status
    # field, and every reader (UI poll, bot, tray) reads only this file.
    # Bot already POSTs its half via data/bot-status.json which we fold in.
    _system_state_path = _data_dir / "system-state.json"

    def _compute_system_state() -> dict:
        state: dict = {"generated_at": _now_iso(), "schema": 1}
        # --- AI server self-report (we ARE the AI server) ---
        ai: dict = {"state": "running", "pid": os.getpid()}
        try:
            if tick_providers and tick_providers.get("health"):
                h = tick_providers["health"]() or {}
                ai["version"] = h.get("version")
                ai["cuda_available"] = h.get("cuda_available")
                ai["loaded_task"] = h.get("loaded_task")
                ai["loaded_chat_model_id"] = h.get("loaded_chat_model_id")
        except Exception:
            pass
        try:
            if tick_providers and tick_providers.get("gpu"):
                g = tick_providers["gpu"]() or {}
                ai["vram_used_mb"] = g.get("used_mb")
                ai["vram_total_mb"] = g.get("total_mb")
                ai["device_name"] = g.get("device_name")
        except Exception:
            pass
        state["ai_server"] = ai
        # --- Bot (fold in its own heartbeat file) ---
        try:
            state["bot"] = _read_bot_discord_status()
        except Exception:
            state["bot"] = {"ready": False, "present": False}
        # --- SearXNG (port probe; cheap, 0.4s) ---
        searxng_state = "unknown"
        try:
            port_str = (os.getenv("SEARXNG_PORT") or "").strip() or "8080"
            port = int(port_str) if port_str.isdecimal() else 8080
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                searxng_state = "running"
        except (ConnectionRefusedError, TimeoutError, socket.timeout, OSError):
            searxng_state = "not-running"
        except Exception:
            searxng_state = "unknown"
        state["searxng"] = {"state": searxng_state}
        return state

    def _write_system_state() -> None:
        try:
            _atomic_write_json(_system_state_path, _compute_system_state())
        except Exception:
            pass

    async def _tick_loop():
        next_due = {topic: 0.0 for topic in TICK_CADENCE_SEC}
        next_watchdog = 0.0
        next_state_write = 0.0
        while True:
            try:
                await asyncio.sleep(1.0)
                now = time.time()
                # Bot Discord watchdog runs every 5s regardless of subscribers
                # — the GUI doesn't have to be open for this auto-recovery.
                if now >= next_watchdog:
                    next_watchdog = now + 5.0
                    _bot_discord_watchdog_check()
                # Canonical status file (§8): written every 1s regardless of
                # subscribers — the tray + bot read it even with no GUI open.
                # The compute is cheap (one bot-status.json read + a 0.4s
                # searxng probe + provider dict reads) so 1Hz is fine.
                if now >= next_state_write:
                    next_state_write = now + 1.0
                    await asyncio.to_thread(_write_system_state)
                if event_bus.subscriber_count <= 0:
                    continue
                if now >= next_due["gpu"]:
                    next_due["gpu"] = now + TICK_CADENCE_SEC["gpu"]
                    if tick_providers and tick_providers.get("gpu"):
                        try:
                            data = tick_providers["gpu"]() or {}
                            await event_bus.publish({"type": "gpu.tick", "data": data})
                        except Exception:
                            pass
                if now >= next_due["health"]:
                    next_due["health"] = now + TICK_CADENCE_SEC["health"]
                    if tick_providers and tick_providers.get("health"):
                        try:
                            data = tick_providers["health"]() or {}
                            await event_bus.publish({"type": "health.tick", "data": data})
                        except Exception:
                            pass
                if now >= next_due["launchers"]:
                    next_due["launchers"] = now + TICK_CADENCE_SEC["launchers"]
                    try:
                        await event_bus.publish({"type": "launchers.tick",
                                                  "data": _build_launchers_tick_payload()})
                    except Exception:
                        pass
                if now >= next_due["stats"]:
                    next_due["stats"] = now + TICK_CADENCE_SEC["stats"]
                    if tick_providers and tick_providers.get("stats"):
                        try:
                            data = tick_providers["stats"]() or {}
                            await event_bus.publish({"type": "stats.tick", "data": data})
                        except Exception:
                            pass
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(2.0)

    def _clean_stale_stack_at_boot() -> None:
        """Mirrors seekdeep_launcher.bat option 8's :cleanStaleStack. On
        every Tauri cold-launch, before any new launchers spawn, reap every
        stale instance from previous sessions so the user gets a clean
        slate — no stacked node.exe / python.exe processes, no leftover
        Docker containers serving stale code.

        Order is:
          1. node index.js scoped to our repo  (kill — except ourselves: not applicable)
          2. python local_ai_server.py scoped to our repo  (kill — EXCLUDING our own PID)
          3. Docker containers we manage: seekdeep-searxng + seekdeep-nim-*

        Gate: SEEKDEEP_FRESH_BOOT=1 (Tauri-set on first sidecar spawn per
        app launch). Mid-session sidecar respawns (ML install, restart-
        sidecar, crash watchdog) skip this so the user's running stack
        doesn't get nuked mid-task.
        """
        # 1. Stale bot processes
        try:
            bot_cwd = _resolve_bot_cwd(root)
            procs = _find_bot_processes(bot_cwd)
            if procs:
                print(f"[SeekDeep] fresh-boot: reaping {len(procs)} orphan bot process(es)")
                for entry in procs:
                    pid = entry["pid"]
                    ok, err = _kill_pid(pid)
                    note = "killed" if ok else f"failed: {err or 'unknown'}"
                    print(f"[SeekDeep]   bot pid {pid} ({entry.get('source', '?')}) - {note}")
                try:
                    pid_name = _PID_FILE_NAMES.get("bot")
                    if pid_name:
                        (_log_dir / pid_name).unlink(missing_ok=True)
                except OSError:
                    pass
        except Exception as exc:
            print(f"[SeekDeep] fresh-boot bot cleanup failed: {exc}")

        # 2. AI server cleanup is DELIBERATELY skipped here. Tauri's
        #    sidecar.rs::kill_listener_on_7865() already nukes any
        #    process bound to :7865 BEFORE spawning the new sidecar, and
        #    that's the only AI server that matters. Trying to also do
        #    a psutil-based scan from inside the freshly-spawned server
        #    raced badly: psutil's process_iter() saw our own python.exe
        #    (and/or a transient Python sub-process from uvicorn worker
        #    init) and the `pid != os.getpid()` filter wasn't catching
        #    every variant. Log showed reliable self-immolation:
        #
        #      03:03:24  Started server process [94508]
        #      03:03:28  fresh-boot: reaping 1 orphan ai-server
        #      03:03:36  Started server process [67544]   ← Tauri respawned
        #
        #    So we leave the AI-server reaping to the Rust side (which
        #    can safely target :7865 only) and limit Python-side fresh-
        #    boot cleanup to the bot + docker containers.

        # 3. SeekDeep-managed Docker containers (only if docker is up).
        try:
            r = subprocess.run(["docker", "version"], capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                removed = []
                for container in ("seekdeep-searxng", "seekdeep-nim-chat", "seekdeep-nim-visual"):
                    rr = subprocess.run(["docker", "rm", "-f", container],
                                        capture_output=True, text=True, timeout=10)
                    if rr.returncode == 0 and (rr.stdout or "").strip():
                        removed.append(container)
                if removed:
                    print(f"[SeekDeep] fresh-boot: removed stale docker container(s): {', '.join(removed)}")
        except FileNotFoundError:
            # docker not installed — fine, skip silently.
            pass
        except Exception as exc:
            if os.getenv("SEEKDEEP_DEBUG"):
                print(f"[SeekDeep] fresh-boot docker cleanup skipped: {exc}")

    def _autostart_stack_at_boot() -> None:
        """After the clean-slate cleanup, bring the whole stack back up:
          - SearXNG container (fresh — the previous one was just removed)
          - AI server is us; no-op
          - Bot via _start_service (fresh process, fresh Discord login)
        Idempotent — re-checks state before each spawn. Opt out via
        SEEKDEEP_AUTOSTART_BOT=off in .env (the env var also gates SearXNG
        since 'clean every boot' is a single user choice)."""
        if os.getenv("SEEKDEEP_AUTOSTART_BOT", "on").strip().lower() in {"0", "false", "no", "off"}:
            print("[SeekDeep] fresh-boot autostart skipped (SEEKDEEP_AUTOSTART_BOT=off)")
            return

        # SearXNG — we just removed the container in cleanup, so port 8080
        # should be dead. If something else is on :8080, leave it alone.
        try:
            sx_up = False
            try:
                with socket.create_connection(("127.0.0.1", 8080), timeout=1):
                    sx_up = True
            except Exception:
                sx_up = False
            if sx_up:
                print("[SeekDeep] fresh-boot autostart: searxng already on :8080, skipping")
            else:
                searxng_dir = (root / "searxng").resolve()
                searxng_dir.mkdir(parents=True, exist_ok=True)
                vol = f"{searxng_dir}:/etc/searxng:rw"
                print("[SeekDeep] fresh-boot autostart: starting searxng container")
                rr = subprocess.run([
                    "docker", "run", "-d", "--name", "seekdeep-searxng",
                    "--restart", "unless-stopped", "-p", "8080:8080",
                    "-e", "BASE_URL=http://localhost:8080/",
                    "-e", "INSTANCE_NAME=SeekDeep",
                    "-v", vol, _seekdeep_searxng_image(),
                ], capture_output=True, text=True, timeout=60)
                if rr.returncode == 0:
                    cid = (rr.stdout or "").strip()[:12]
                    print(f"[SeekDeep] fresh-boot autostart: searxng container {cid} up")
                else:
                    err = (rr.stderr or "").strip()[:200]
                    print(f"[SeekDeep] fresh-boot autostart: searxng docker run failed: {err}")
        except FileNotFoundError:
            print("[SeekDeep] fresh-boot autostart: docker not installed; skipping searxng")
        except Exception as exc:
            print(f"[SeekDeep] fresh-boot autostart searxng error: {exc}")

        # Bot
        try:
            info = _service_state("bot", _log_dir)
            if info["state"] == "running":
                print(f"[SeekDeep] fresh-boot autostart: bot already running pid={info['pid']}, skipping")
                return
            print("[SeekDeep] fresh-boot autostart: starting bot service")
            result = _start_service("bot", root, _log_dir)
            pid = result.get("pid") if isinstance(result, dict) else None
            print(f"[SeekDeep] fresh-boot autostart: bot spawned pid={pid}")
        except HTTPException as exc:
            print(f"[SeekDeep] fresh-boot autostart bot failed: {exc.detail}")
        except Exception as exc:
            print(f"[SeekDeep] fresh-boot autostart bot failed: {exc}")

    @app.on_event("startup")
    async def _start_heartbeat():
        # Capture the running loop so producers in OTHER modules (notably
        # local_ai_server.py's sync model loaders) can publish via
        # event_bus.publish_sync(...) without each one juggling its own loop.
        loop = asyncio.get_running_loop()
        event_bus.attach_loop(loop)
        # Sweep abandoned self-update staging dirs from a prior crashed/killed
        # run. The updater also wipes these before staging its own, but a crash
        # that never gets a follow-up update would otherwise leave the dir (and
        # its partial download) on disk indefinitely. Wiping ALL matches (not just
        # this PID's) is safe: only one server binds 127.0.0.1:7865, so there is
        # never another live updater whose in-progress dir we could clobber.
        try:
            for stale in root.glob(".self-update-staging-*"):
                shutil.rmtree(stale, ignore_errors=True)
        except Exception:
            pass
        # Fresh-boot ritual: clean the entire stale stack (bots + stray
        # AI servers + SeekDeep Docker containers), then bring the stack
        # back up. Mirrors seekdeep_launcher.bat option 8. Gated on the
        # env var Tauri sets ONLY on the first sidecar spawn per app
        # launch; mid-session respawns (ML install, restart-sidecar,
        # crash watchdog) skip both so the user's running stack isn't
        # nuked-and-respawned on every routine bounce.
        if os.getenv("SEEKDEEP_FRESH_BOOT", "").strip().lower() in {"1", "true", "yes", "on"}:
            _clean_stale_stack_at_boot()
            _autostart_stack_at_boot()
        # Stash the task on app.state so it can be cancelled on shutdown
        app.state.seekdeep_heartbeat_task = loop.create_task(_heartbeat_loop())
        app.state.seekdeep_tick_task = loop.create_task(_tick_loop())

    @app.on_event("shutdown")
    async def _stop_heartbeat():
        for attr in ("seekdeep_heartbeat_task", "seekdeep_tick_task"):
            t = getattr(app.state, attr, None)
            if t and not t.done():
                t.cancel()

    print(f"[SeekDeep] GUI endpoints registered  (log_dir={_log_dir}  data_dir={_data_dir}  env={_env_path})")
