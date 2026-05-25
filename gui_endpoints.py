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
import json
import time
import secrets
import asyncio
import subprocess
from pathlib import Path
from typing import Any, Callable
from fastapi import FastAPI, HTTPException, Header, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel


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
    data: dict[str, Any] = {}


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

    # 3. No info — for services we don't track this way (e.g. searxng)
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
                                  builtins:{...}}}}
    GUI expects : {rules:[{id,emoji,pattern,channel?,user?,enabled,hits}]}
    """
    if not isinstance(raw, dict):
        return {"rules": []}
    rules_out: list[dict[str, Any]] = []
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
    return {"rules": rules_out}


# Map known data files to their normalizer functions. Anything not listed
# is returned to the GUI as-is (raw bot schema).
_DATA_NORMALIZERS: dict[str, Callable[[Any], Any]] = {
    "server-stats.json":   _normalize_server_stats,
    "auto-reactions.json": _normalize_auto_reactions,
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
) -> None:
    """
    Attach every GUI-required endpoint to `app`. Idempotent.

    warmup_handlers, if provided, maps the model class ("chat", "image",
    "vision") to a callable that warms it. The chat handler is called with
    a `role` kwarg; image/vision are called with no args. When omitted,
    /model/warm returns a clearly-flagged stub response.
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

    # ----- GET /data/{file} -----
    @app.get("/data/{file}")
    async def get_data_file(file: str):
        # Reject anything that escapes data_dir
        target = (_data_dir / file).resolve()
        if not _is_inside(target, _data_dir):
            raise HTTPException(400, "path traversal blocked")
        if not target.is_file():
            # Empty success so the GUI's normalized panes can show empty-state
            # rather than reporting an error for files the bot hasn't written yet.
            if file in _DATA_NORMALIZERS:
                return {"ok": True, "file": file, "data": _DATA_NORMALIZERS[file]({}), "empty": True}
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
