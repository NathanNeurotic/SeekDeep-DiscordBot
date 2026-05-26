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
import subprocess
import shutil
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

# Loopback IPs that may fetch GET /token. Anything else gets 403.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


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


def _merge_env(env_path: Path, updates: dict[str, Any]) -> dict[str, Any]:
    """Merge `updates` into the on-disk .env file, preserving comments and order."""
    if not env_path.is_file():
        raise HTTPException(404, f".env not found at {env_path}")

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

    # Atomic write
    tmp = env_path.with_suffix(env_path.suffix + ".tmp")
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
# LOG TAILING
# ====================================================================

def _find_active_log(log_dir: Path) -> Path | None:
    """Pick the newest seekdeep-*.log file."""
    if not log_dir.is_dir():
        return None
    candidates = sorted(log_dir.glob("seekdeep-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


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
    Return (state, pid) by consulting both in-process state and PID file.
    State is one of: "running", "not-running", "exited", "unknown".

    Special cases:
      ai-server: If we reach this function, the AI server is by definition
                 running — it's the process serving this HTTP request. So
                 when no PID file / tracked-spawn match, return our own
                 process PID with state="running" instead of the misleading
                 "not-running" that would make the launcher card lie.
      searxng:   No PID file — fall back to a TCP port probe on the
                 configured searxng port (default 8080). If the port
                 accepts a connection, report running; else unknown
                 (it might be docker-managed, or just down).
    """
    # 1. In-process spawn we tracked
    proc = _PROCESSES.get(service)
    if proc is not None:
        rc = proc.poll()
        if rc is None:
            return "running", proc.pid
        # Process we started has exited; fall through to PID-file check
        # in case the user restarted via launcher.bat.

    # 2. PID file written by launcher.bat
    pid = _read_pid_file(log_dir, service)
    if pid is not None:
        return ("running" if _pid_alive(pid) else "not-running"), pid

    # 3. Service-specific fallbacks (we know more about ai-server / searxng
    #    than the generic "no PID file = not running")
    if service == "ai-server":
        # We ARE the ai-server. Return our own PID, state running.
        return "running", os.getpid()
    if service == "searxng":
        # Probe the configured searxng port. If something accepts the
        # connection, it's "running"; if connection refused, "not-running";
        # any other socket error → "unknown".
        port_str = (os.getenv("SEARXNG_PORT") or "").strip() or "8080"
        try:
            port = int(port_str)
        except ValueError:
            port = 8080
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return "running", None
        except ConnectionRefusedError:
            return "not-running", None
        except OSError:
            return "unknown", None

    # 4. No info — for services we don't track this way
    if service not in _PID_FILE_NAMES:
        return "unknown", None
    return "not-running", None


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
    # Route stdout/stderr to per-launch log files so failures aren't invisible.
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_log = log_dir / f"{service}-{stamp}.gui.out.log"
    err_log = log_dir / f"{service}-{stamp}.gui.err.log"
    try:
        out_f = out_log.open("ab")
        err_f = err_log.open("ab")
        proc = subprocess.Popen(
            cmd, cwd=str(cwd),
            stdout=out_f, stderr=err_f, stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        _PROCESSES[service] = proc
        return {"ok": True, "service": service, "state": "starting",
                "pid": proc.pid, "log": str(out_log.name)}
    except FileNotFoundError as e:
        raise HTTPException(500, f"failed to start {service}: {e}")


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
) -> None:
    """
    Attach every GUI-required endpoint to `app`. Idempotent.

    warmup_handlers, if provided, maps the model class ("chat", "image",
    "vision") to a callable that warms it. The chat handler is called with
    a `role` kwarg; image/vision are called with no args. When omitted,
    /model/warm returns a clearly-flagged stub response.

    stats_provider, if provided, is a zero-arg callable returning the
    AI-server's live request-counter snapshot dict (the same shape as
    local_ai_server._seekdeep_req_stats() returns). /stats/snapshot calls
    this for the ai_server.* block. Without it, we'd have to dynamically
    `import local_ai_server` here — and when local_ai_server is the
    process's __main__ module (i.e. `python local_ai_server.py`), that
    import resolves to a DIFFERENT module instance with its own zero-
    initialized counters. Passing a callback at registration time pins
    us to the live counters in the running process.
    """
    root = Path(repo_root or os.path.dirname(os.path.abspath(__file__))).resolve()
    _log_dir = (root / log_dir).resolve()
    _data_dir = (root / data_dir).resolve()
    _env_path = (root / env_path).resolve()

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
        return {"token": _current_token(), "header": _TOKEN_HEADER, "disabled": _token_disabled}

    # ----- POST /config -----
    @app.post("/config", dependencies=[Depends(_require_gui_token)])
    async def post_config(patch: ConfigPatch):
        if not patch.updates:
            return {"ok": True, "updated": []}
        return _merge_env(_env_path, patch.updates)

    # ----- GET /logs/tail -----
    @app.get("/logs/tail")
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
    @app.get("/logs/stream")
    async def get_logs_stream():
        path = _find_active_log(_log_dir)
        if path is None:
            return JSONResponse({"ok": False, "error": "no log file"}, status_code=404)
        return StreamingResponse(_stream_log(path), media_type="text/event-stream")

    # ----- POST /launcher/{service}/{action} -----
    @app.post("/launcher/{service}/{action}", dependencies=[Depends(_require_gui_token)])
    async def post_launcher(service: str, action: str):
        if service not in ALLOWED_SERVICES:
            raise HTTPException(400, f"unknown service · allowed: {sorted(ALLOWED_SERVICES)}")
        if action not in ALLOWED_ACTIONS:
            raise HTTPException(400, f"unknown action · allowed: {sorted(ALLOWED_ACTIONS)}")

        if action == "start":   return _start_service(service, root, _log_dir)
        if action == "stop":    return _stop_service(service, _log_dir)
        if action == "status":  return _status_service(service, _log_dir)
        if action == "restart":
            # Refuse restart for self-hosted services up-front rather than
            # killing this very request handler half-way through.
            if service in SELF_HOSTED_SERVICES:
                raise HTTPException(409,
                    f"{service} is self-hosted; refusing to restart it from inside the AI server. "
                    f"Use seekdeep_launcher.bat instead.")
            _stop_service(service, _log_dir)
            time.sleep(0.5)
            return _start_service(service, root, _log_dir)

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
    @app.get("/launchers/status")
    def get_launchers_status():
        services_out = {}
        for svc in sorted(ALLOWED_SERVICES):
            base_status = _status_service(svc, _log_dir)
            pid = base_status.get("pid")
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
            services_out[svc] = {
                **base_status,
                "uptime_seconds": uptime_s,
                "started_at":      started_at,
            }
        return {
            "ok": True,
            "services": services_out,
            "generated_at": _now_iso(),
        }

    # ----- GET /system/firstrun -----
    # Discovers what's missing for a fresh install and returns a checklist
    # the GUI can render as a "do these N things first" banner. Replaces
    # the previous experience where a user with no .env / no models / no
    # Discord token saw a bunch of empty panes with no clear next step.
    @app.get("/system/firstrun")
    def get_system_firstrun():
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
        # 2. DISCORD_TOKEN looks plausible
        tok = (env.get("DISCORD_TOKEN") or "").strip()
        checks.append({
            "id": "discord_token",
            "label": "DISCORD_TOKEN set",
            "ok": bool(tok) and len(tok) >= 50,
            "fix": "Paste your bot token in the Installer Discord row, or edit .env directly.",
            "blocking": True,
        })
        # 3. DISCORD_CLIENT_ID set (for slash command registration)
        cid = (env.get("DISCORD_CLIENT_ID") or "").strip()
        checks.append({
            "id": "discord_client_id",
            "label": "DISCORD_CLIENT_ID set (for slash commands)",
            "ok": bool(cid) and cid.isdigit() and len(cid) >= 15,
            "fix": "Copy the Application ID from the Discord developer portal -> General Information.",
            "blocking": False,
        })
        # 4. SEEKDEEP_ADMIN_IDS set (admin features will all 403 without this)
        admin = (env.get("SEEKDEEP_ADMIN_IDS") or env.get("ADMIN_USER_IDS") or "").strip()
        checks.append({
            "id": "admin_ids",
            "label": "SEEKDEEP_ADMIN_IDS set (admin features need it)",
            "ok": bool(admin),
            "fix": "Add your Discord user ID(s) to SEEKDEEP_ADMIN_IDS in .env (comma-separated).",
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
        checks.append({
            "id": "ml_deps",
            "label": "ML dependencies installed (torch / transformers / diffusers)",
            "ok": ml_ok,
            "fix": "Click \"Install ML libraries\" in the Control Center, or run `pip install -r requirements-ml.txt`.",
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
        # 7. searxng container reachable (web search)
        try:
            with socket.create_connection(("127.0.0.1", 8080), timeout=1):
                searxng_up = True
        except Exception:
            searxng_up = False
        checks.append({
            "id": "searxng",
            "label": "SearXNG container running (web search)",
            "ok": searxng_up,
            "fix": "`docker compose up -d searxng` from the repo, or skip if you don't need web-routed chat.",
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
        checks.append({
            "id": "chat_model",
            "label": "A chat model is reachable (HF cache or Ollama)",
            "ok": has_hf_cache or ollama_up,
            "fix": "Open the Models pane and click Warm on a chat role, or install ollama + pull a model.",
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

    # ----- GET /system/runtime -----
    # Probe-only check for Node + Python + Git versions on PATH. Replaces
    # the installer page's "server up implies node ok" placeholder — that
    # told you the AI server was running but nothing about whether the
    # supplied Node/Python actually meet the minimum versions. This runs
    # locally only (loopback server already implies trust on this box).
    @app.get("/system/runtime")
    def get_system_runtime():
        out: dict[str, dict] = {}
        # Node — "node --version" → v20.11.0
        try:
            r = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=2)
            if r.returncode == 0:
                v = (r.stdout or "").strip().lstrip("v")
                major = int(v.split(".")[0]) if v else 0
                out["node"] = {
                    "installed": True,
                    "version": v,
                    "major": major,
                    "meets_min": major >= 20,  # discord.js v14 needs Node 20+
                    "min_required": "20.x",
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
    @app.get("/system/docker")
    def get_system_docker():
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
        try:
            with target.open("r", encoding="utf-8") as f:
                raw = json.load(f)
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"invalid json: {e}", "file": target.name}
        normalizer = _DATA_NORMALIZERS.get(target.name)
        data = normalizer(raw) if normalizer else raw
        return {"ok": True, "file": target.name, "data": data, "normalized": bool(normalizer)}

    # ----- POST /model/warm -----
    @app.post("/model/warm", dependencies=[Depends(_require_gui_token)])
    async def post_model_warm(req: WarmRequest):
        role = (req.role or "default_chat").strip().lower() or "default_chat"
        if not warmup_handlers:
            return {"ok": True, "role": role, "loaded": False, "stub": True,
                    "note": "no warmup handlers wired; pass warmup_handlers=... to register_gui_endpoints"}
        # Dispatch: image/vision are categorical; everything else is a chat role.
        try:
            if role == "image":
                handler = warmup_handlers.get("image")
                if not handler: return {"ok": False, "role": role, "error": "no image handler"}
                result = handler()
            elif role == "vision":
                handler = warmup_handlers.get("vision")
                if not handler: return {"ok": False, "role": role, "error": "no vision handler"}
                result = handler()
            else:
                handler = warmup_handlers.get("chat")
                if not handler: return {"ok": False, "role": role, "error": "no chat handler"}
                result = handler(role)
            # Loaders return implementation-specific objects; just stringify a hint.
            return {"ok": True, "role": role, "loaded": True,
                    "result": str(result)[:200] if result is not None else None}
        except Exception as e:
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
        cfg = _read_archive_config()
        updates = patch.updates or {}
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
                redacted[k] = v
        return {"ok": True, "env": redacted}

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

    def _read_custom_persona_slugs() -> list[str]:
        """Slugs of every persona in data/custom-personas.json (lowercase).
        Empty list if the file's missing or malformed. Used to make /persona's
        valid_personas list include user-defined personas so the chat-playground
        popover and the persona admin command stay in sync."""
        try:
            if not _custom_personas_path.is_file():
                return []
            raw = json.loads(_custom_personas_path.read_text(encoding="utf-8"))
            personas = (raw or {}).get("personas") or {}
            return [str(k).lower() for k in personas.keys() if str(k).strip()]
        except Exception:
            return []

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
        return {"ok": True, "scope": scope, "persona": persona, "set_at": entry["setAt"]}

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
    @app.get("/stats/snapshot")
    def get_stats_snapshot():
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
            from huggingface_hub import scan_cache_dir
            try:
                from huggingface_hub.errors import CacheNotFound
            except ImportError:
                CacheNotFound = Exception
            cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
            try:
                info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
                cache["hf_size_bytes"] = int(info.size_on_disk)
                cache["hf_repo_count"] = len(info.repos)
            except CacheNotFound:
                cache["hf_size_bytes"] = 0
                cache["hf_repo_count"] = 0
        except ImportError:
            pass
        # Ollama tag count (best-effort; daemon may be down)
        try:
            import local_ai_server as _lai
            if _lai.ollama_available():
                cache["ollama_tag_count"] = len(_lai.ollama_list_tags())
        except Exception:
            pass
        out["cache"] = cache

        return out

    # ----- POST /cache/prune -----
    # Frees disk space by deleting HF snapshots older than --keep-recent (oldest
    # repos first, by last_accessed). Backs the app.html "Prune cache (4.2 GB)"
    # button. Token-required because it's destructive.
    @app.post("/cache/prune", dependencies=[Depends(_require_gui_token)])
    def post_cache_prune():
        try:
            from huggingface_hub import scan_cache_dir
            try:
                from huggingface_hub.errors import CacheNotFound
            except ImportError:
                CacheNotFound = Exception
        except ImportError:
            raise HTTPException(503, "huggingface_hub not installed (install ML deps first)")

        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        try:
            info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
        except CacheNotFound:
            return {"ok": True, "freed_bytes": 0, "note": "HF cache directory not found"}

        # Conservative policy: only prune revisions that aren't the "current"
        # (refs) revision. Pinned models we use every day stay put; we just
        # drop downloaded-but-untagged-anymore revisions.
        revisions_to_delete = []
        for repo in info.repos:
            for rev in repo.revisions:
                if not rev.refs:  # not referenced by any ref → unreachable
                    revisions_to_delete.append(rev.commit_hash)
        if not revisions_to_delete:
            return {"ok": True, "freed_bytes": 0, "note": "nothing to prune (all revisions still referenced)"}

        try:
            delete_strategy = info.delete_revisions(*revisions_to_delete)
            freed = int(delete_strategy.expected_freed_size)
            delete_strategy.execute()
            return {
                "ok": True,
                "freed_bytes": freed,
                "revisions_deleted": len(revisions_to_delete),
                "note": f"deleted {len(revisions_to_delete)} unreferenced revision(s)",
            }
        except Exception as e:
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
            try:
                event_bus.publish_sync({
                    "type": "deps.install.started",
                    "data": {"requirements_file": req_name, "venv": in_venv},
                })
                pip_args = [sys.executable, "-m", "pip", "install", "--upgrade"]
                if not in_venv:
                    pip_args.append("--user")
                pip_args.extend(["-r", str(req_path)])
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
                        event_bus.publish_sync({
                            "type": "deps.install.line",
                            "data": {"line": line.rstrip()},
                        })
                proc.wait()
                if proc.returncode == 0:
                    event_bus.publish_sync({
                        "type": "deps.install.complete",
                        "data": {"requirements_file": req_name},
                    })
                else:
                    event_bus.publish_sync({
                        "type": "deps.install.failed",
                        "data": {
                            "requirements_file": req_name,
                            "exit_code": proc.returncode,
                        },
                    })
            except Exception as exc:
                event_bus.publish_sync({
                    "type": "deps.install.failed",
                    "data": {"requirements_file": req_name, "error": str(exc)},
                })

        threading.Thread(target=run_install, daemon=True).start()
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
        await websocket.accept()
        await event_bus.subscribe(websocket)
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
                # We don't expect inbound messages from the client; just keep the
                # connection alive and detect disconnect via the receive timeout.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
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
        return {"ok": True, "subscribers": event_bus.subscriber_count, "server_time_ms": int(time.time() * 1000)}

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
        tmp = path.with_suffix(path.suffix + ".tmp." + str(os.getpid()))
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)

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
        store = _read_presets_store()
        store["users"] = store.get("users") or {}
        store["users"][str(user_id)] = {"presets": deduped, "updatedAt": _now_iso()}
        _atomic_write_json(_memory_presets_path, store)
        return {"ok": True}

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

    @app.on_event("startup")
    async def _start_heartbeat():
        # Capture the running loop so producers in OTHER modules (notably
        # local_ai_server.py's sync model loaders) can publish via
        # event_bus.publish_sync(...) without each one juggling its own loop.
        loop = asyncio.get_running_loop()
        event_bus.attach_loop(loop)
        # Stash the task on app.state so it can be cancelled on shutdown
        app.state.seekdeep_heartbeat_task = loop.create_task(_heartbeat_loop())

    @app.on_event("shutdown")
    async def _stop_heartbeat():
        t = getattr(app.state, "seekdeep_heartbeat_task", None)
        if t and not t.done():
            t.cancel()

    print(f"[SeekDeep] GUI endpoints registered  (log_dir={_log_dir}  data_dir={_data_dir}  env={_env_path})")
