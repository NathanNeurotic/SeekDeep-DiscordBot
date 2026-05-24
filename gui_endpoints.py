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
import asyncio
import subprocess
from pathlib import Path
from typing import Any
from fastapi import FastAPI, HTTPException, Body
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel


# ====================================================================
# REQUEST MODELS
# ====================================================================

class ConfigPatch(BaseModel):
    updates: dict  # { "KEY": "value", ... }


class WarmRequest(BaseModel):
    role: str = "default_chat"


# Whitelist of services the launcher endpoint may control.
ALLOWED_SERVICES = {"ai-server", "bot", "searxng"}
ALLOWED_ACTIONS  = {"start", "stop", "restart", "status"}

# Per-process state for the launcher endpoint.
_PROCESSES: dict[str, subprocess.Popen] = {}


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


def _is_running(service: str) -> bool:
    proc = _PROCESSES.get(service)
    return proc is not None and proc.poll() is None


def _start_service(service: str, cwd: Path) -> dict:
    if _is_running(service):
        return {"ok": True, "service": service, "state": "already-running",
                "pid": _PROCESSES[service].pid}
    cmd = _service_command(service)
    if not cmd:
        raise HTTPException(400, f"no command mapping for service {service!r}")
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        _PROCESSES[service] = proc
        return {"ok": True, "service": service, "state": "starting", "pid": proc.pid}
    except FileNotFoundError as e:
        raise HTTPException(500, f"failed to start {service}: {e}")


def _stop_service(service: str) -> dict:
    proc = _PROCESSES.get(service)
    if proc is None or proc.poll() is not None:
        return {"ok": True, "service": service, "state": "not-running"}
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    return {"ok": True, "service": service, "state": "stopped"}


def _status_service(service: str) -> dict:
    proc = _PROCESSES.get(service)
    if proc is None:
        return {"ok": True, "service": service, "state": "not-running"}
    rc = proc.poll()
    if rc is None:
        return {"ok": True, "service": service, "state": "running", "pid": proc.pid}
    return {"ok": True, "service": service, "state": "exited", "returncode": rc}


# ====================================================================
# REGISTRATION
# ====================================================================

def register_gui_endpoints(
    app: FastAPI,
    log_dir: str = "logs",
    data_dir: str = "data",
    env_path: str = ".env",
    repo_root: str | None = None,
) -> None:
    """Attach every GUI-required endpoint to `app`. Idempotent."""
    root = Path(repo_root or os.path.dirname(os.path.abspath(__file__))).resolve()
    _log_dir = (root / log_dir).resolve()
    _data_dir = (root / data_dir).resolve()
    _env_path = (root / env_path).resolve()

    # ----- POST /config -----
    @app.post("/config")
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
        if not str(path).startswith(str(_log_dir)):
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
    @app.post("/launcher/{service}/{action}")
    async def post_launcher(service: str, action: str):
        if service not in ALLOWED_SERVICES:
            raise HTTPException(400, f"unknown service · allowed: {sorted(ALLOWED_SERVICES)}")
        if action not in ALLOWED_ACTIONS:
            raise HTTPException(400, f"unknown action · allowed: {sorted(ALLOWED_ACTIONS)}")

        if action == "start":   return _start_service(service, root)
        if action == "stop":    return _stop_service(service)
        if action == "status":  return _status_service(service)
        if action == "restart":
            _stop_service(service)
            time.sleep(0.5)
            return _start_service(service, root)

    # ----- GET /data/{file} -----
    @app.get("/data/{file}")
    async def get_data_file(file: str):
        # Reject anything that escapes data_dir
        target = (_data_dir / file).resolve()
        if not str(target).startswith(str(_data_dir)):
            raise HTTPException(400, "path traversal blocked")
        if not target.is_file():
            raise HTTPException(404, f"{file} not found in {_data_dir}")
        # Only allow .json
        if target.suffix.lower() != ".json":
            raise HTTPException(400, "only .json files exposed")
        try:
            with target.open("r", encoding="utf-8") as f:
                return {"ok": True, "file": target.name, "data": json.load(f)}
        except json.JSONDecodeError as e:
            return {"ok": False, "error": f"invalid json: {e}", "file": target.name}

    # ----- POST /model/warm -----
    # NOTE: this is a stub. Wire it to your existing role->model loader.
    @app.post("/model/warm")
    async def post_model_warm(req: WarmRequest):
        try:
            # === Wire to your existing model loader here ===
            # e.g. from local_ai_server import _load_chat_model
            # _load_chat_model(role=req.role)
            return {"ok": True, "role": req.role, "loaded": True, "stub": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    print(f"[SeekDeep] GUI endpoints registered  (log_dir={_log_dir}  data_dir={_data_dir}  env={_env_path})")
