"""hermes-overtime remote control (opt-in): answer Hermes approvals and send tasks from Overtime.

Loaded by the plugin only when OVERTIME_REMOTE_APPROVAL=1 and/or OVERTIME_REMOTE_TASKS=1. Nothing
here runs otherwise.

Remote approval (OVERTIME_REMOTE_APPROVAL=1)
  Hermes' gateway (Telegram, Discord, Slack, the API server, ...) blocks the agent thread on a
  pending approval and fires the ``pre_approval_request`` hook with the session key. The plugin
  registers that request with Overtime and long-polls for an answer in a background thread. When a
  paired device answers, the plugin checks the HMAC signature (key: sha256 of the ingest token),
  that the answer is bound to *this* request id and the exact command, that the pending approval at
  the head of Hermes' queue is still this command, and then resolves it with
  ``tools.approval.resolve_gateway_approval(session_key, choice)``: the same call Hermes' own
  ``/approve``, ``/deny`` and ``POST /v1/runs/{id}/approval`` make. Hermes keeps asking locally the
  whole time; whichever answer comes first wins. On timeout, error, a bad signature or anything
  unexpected the plugin does nothing and Hermes' normal local approval carries on. It never approves
  on its own and never sends "always" (permanent allowlist entries stay a local decision).
  CLI sessions are not supported: the CLI prompt reads the terminal and has no remote resolver.

Tasks (OVERTIME_REMOTE_TASKS=1)
  A paired device queues a prompt in Overtime. Inside the Hermes gateway process (or under
  ``hermes overtime bridge``) the plugin long-polls Overtime's queue, claims one task at a time,
  checks its signature and the local allowlist, and starts it through Hermes' own OpenAI-compatible
  API server: ``POST /v1/runs`` (needs API_SERVER_ENABLED=true and API_SERVER_KEY). It reports
  started/finished back, and ``stop`` maps to ``POST /v1/runs/{id}/stop``.

Environment
  OVERTIME_REMOTE_APPROVAL   1 to answer gateway approvals from Overtime (default off)
  OVERTIME_APPROVAL_WAIT     seconds to wait for Overtime before leaving it to Hermes (default: Hermes'
                             approval timeout minus 5 s, at most 900)
  OVERTIME_REMOTE_TASKS      1 to accept tasks from Overtime (default off)
  OVERTIME_REMOTE_COMMANDS   allowlist of task kinds, comma separated (default "run,stop")
  OVERTIME_ALLOW_SLASH       1 to allow prompts that start with "/" (default refused)
  OVERTIME_TASK_MAX_CHARS    longest prompt accepted (default 4000)
  OVERTIME_HERMES_API        Hermes API server base URL (default http://127.0.0.1:$API_SERVER_PORT, port 8642)
  API_SERVER_KEY             Hermes' own API server key (already in ~/.hermes/.env when the API server is on)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Dict, Optional, Tuple

logger = logging.getLogger("hermes_overtime.control")

Http = Callable[[str, str, Optional[Dict[str, Any]], Dict[str, str], float], Tuple[int, Dict[str, Any]]]
Resolver = Callable[[str, str, str], str]
TRUTHY = {"1", "true", "yes", "on"}
REMOTE_CHOICES = ("once", "session", "deny")


def _truthy(v: Optional[str]) -> bool:
    return (v or "").strip().lower() in TRUTHY


def urllib_http(method: str, url: str, body: Optional[Dict[str, Any]], headers: Dict[str, str], timeout: float) -> Tuple[int, Dict[str, Any]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = dict(headers)
    if data is not None:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8") or "{}"
            return int(r.status), json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
        return int(e.code), payload if isinstance(payload, dict) else {}


class ControlConfig:
    def __init__(self, env: Optional[Dict[str, str]] = None) -> None:
        e = os.environ if env is None else env
        self.remote_approval = _truthy(e.get("OVERTIME_REMOTE_APPROVAL"))
        self.remote_tasks = _truthy(e.get("OVERTIME_REMOTE_TASKS"))
        try:
            self.approval_wait = float(e.get("OVERTIME_APPROVAL_WAIT", "0") or 0)
        except ValueError:
            self.approval_wait = 0.0
        allowed = (e.get("OVERTIME_REMOTE_COMMANDS", "run,stop") or "").lower()
        self.commands = {c.strip() for c in allowed.split(",") if c.strip()}
        self.allow_slash = _truthy(e.get("OVERTIME_ALLOW_SLASH"))
        try:
            self.max_chars = max(1, min(int(e.get("OVERTIME_TASK_MAX_CHARS", "4000") or 4000), 4000))
        except ValueError:
            self.max_chars = 4000
        port = (e.get("API_SERVER_PORT") or "8642").strip()
        self.api_url = (e.get("OVERTIME_HERMES_API") or f"http://127.0.0.1:{port}").rstrip("/")
        self.api_key = (e.get("API_SERVER_KEY") or "").strip()

    @property
    def any(self) -> bool:
        return self.remote_approval or self.remote_tasks


def control_base(ingest_url: str) -> Tuple[str, str]:
    """https://h/api/ext/runs/<office>/hermes -> (https://h/api/ext/runs/<office>/control, <office>)"""
    m = re.match(r"^(https?://.+/api/ext/runs/(of-[a-z0-9]{8,24}))/(?:hermes|events)/?$", ingest_url.strip())
    if not m:
        return "", ""
    return m.group(1) + "/control", m.group(2)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def verify_decision(token: str, office: str, d: Dict[str, Any]) -> bool:
    try:
        msg = "|".join(["v1", "decision", office, str(d["request_id"]), str(d["command_sha256"]), str(d["choice"]), str(d["by"]), str(int(d["at"]))])
        want = hmac.new(_sha(token).encode(), msg.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(want, str(d.get("sig", "")))
    except Exception:
        return False


def verify_command(token: str, office: str, c: Dict[str, Any]) -> bool:
    try:
        msg = "|".join(["v1", "command", office, str(c["id"]), str(c["kind"]), _sha(str(c["payload"])), str(int(c["created_at"]))])
        want = hmac.new(_sha(token).encode(), msg.encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(want, str(c.get("sig", "")))
    except Exception:
        return False


def hermes_resolver(session_key: str, choice: str, command: str) -> str:
    """Resolve the pending gateway approval for session_key, only if its head is this command.

    Uses tools.approval.resolve_gateway_approval, the function behind Hermes' /approve, /deny and the
    API server's POST /v1/runs/{id}/approval. Returns applied | stale | unsupported.
    """
    try:
        from tools import approval as ap  # type: ignore
    except Exception:
        return "unsupported"
    resolve = getattr(ap, "resolve_gateway_approval", None)
    queues = getattr(ap, "_gateway_queues", None)
    lock = getattr(ap, "_lock", None)
    if resolve is None or queues is None or lock is None:
        return "unsupported"  # a Hermes build we do not know: never guess which approval to answer
    try:
        with lock:
            q = queues.get(session_key) or []
            head = q[0] if q else None
            data = getattr(head, "data", None) if head is not None else None
            same = isinstance(data, dict) and data.get("command") == command
        if not same:
            return "stale"
        return "applied" if resolve(session_key, choice) > 0 else "stale"
    except Exception:
        logger.debug("hermes-overtime: resolve failed", exc_info=True)
        return "unsupported"


def hermes_approval_timeout() -> float:
    try:
        from tools.approval import _get_approval_timeout  # type: ignore
        return float(_get_approval_timeout())
    except Exception:
        return 60.0


class RemoteApprover:
    """Mirrors gateway approvals to Overtime and applies verified answers. Never blocks the agent."""

    def __init__(self, cfg: ControlConfig, ingest_url: str, token: str, http: Optional[Http] = None,
                 resolver: Optional[Resolver] = None, timeout_fn: Callable[[], float] = hermes_approval_timeout,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic) -> None:
        self.cfg = cfg
        self.base, self.office = control_base(ingest_url)
        self.token = token
        self.http = http or urllib_http
        self.resolver = resolver or hermes_resolver
        self.timeout_fn = timeout_fn
        self.sleep = sleep
        self.clock = clock
        self._pending: Dict[Tuple[str, str], Tuple[str, threading.Event]] = {}
        self._lock = threading.Lock()
        self.stats = {"registered": 0, "applied": 0, "timeouts": 0, "rejected": 0, "local": 0}
        self._warned_cli = False

    @property
    def ready(self) -> bool:
        return bool(self.cfg.remote_approval and self.base and self.token)

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": "hermes-overtime-control"}

    def wait_seconds(self) -> float:
        hermes = self.timeout_fn()
        cap = hermes - 5 if hermes > 10 else 0
        if self.cfg.approval_wait > 0:
            cap = min(cap, self.cfg.approval_wait)
        return max(0.0, min(cap, 900.0))

    def on_request(self, kwargs: Dict[str, Any], session_id: str = "") -> Optional[threading.Thread]:
        """pre_approval_request observer. Returns the worker thread (tests join it)."""
        if not self.ready:
            return None
        surface = str(kwargs.get("surface") or "")
        if surface != "gateway":
            if surface == "cli" and not self._warned_cli:
                self._warned_cli = True
                logger.info("hermes-overtime: remote approval works for gateway sessions; CLI approvals stay in the terminal")
            return None
        session_key = str(kwargs.get("session_key") or "")
        command = kwargs.get("command")
        if not session_key or not isinstance(command, str) or not command:
            return None
        wait = self.wait_seconds()
        if wait < 5:
            return None
        rid = "apr_" + uuid.uuid4().hex[:24]
        cancel = threading.Event()
        with self._lock:
            self._pending[(session_key, command)] = (rid, cancel)
        t = threading.Thread(target=self._run, args=(rid, session_key, command, kwargs, session_id or session_key, wait, cancel), name="hermes-overtime-approval", daemon=True)
        t.start()
        return t

    def on_response(self, kwargs: Dict[str, Any]) -> None:
        """post_approval_response observer: Hermes got an answer (locally or from us)."""
        key = (str(kwargs.get("session_key") or ""), str(kwargs.get("command") or ""))
        with self._lock:
            hit = self._pending.get(key)
        if hit:
            hit[1].set()

    def _outcome(self, rid: str, outcome: str, detail: str = "") -> None:
        try:
            self.http("POST", f"{self.base}/approvals/{rid}/outcome", {"outcome": outcome, "detail": detail[:120]}, self._headers(), 10)
        except Exception:
            pass

    def _run(self, rid: str, session_key: str, command: str, kwargs: Dict[str, Any], session: str, wait: float, cancel: threading.Event) -> None:
        try:
            self._run_inner(rid, session_key, command, kwargs, session, wait, cancel)
        except Exception:
            logger.debug("hermes-overtime: remote approval thread failed", exc_info=True)
        finally:
            with self._lock:
                if self._pending.get((session_key, command), (None,))[0] == rid:
                    self._pending.pop((session_key, command), None)

    def _run_inner(self, rid: str, session_key: str, command: str, kwargs: Dict[str, Any], session: str, wait: float, cancel: threading.Event) -> None:
        start = self.clock()
        body = {
            "request_id": rid, "session": session[:128], "surface": "gateway", "command": command,
            "description": str(kwargs.get("description") or "")[:300], "pattern_key": str(kwargs.get("pattern_key") or "")[:120],
            "expires_in": int(wait),
        }
        try:
            status, j = self.http("POST", f"{self.base}/approvals", body, self._headers(), 10)
        except Exception as exc:
            logger.debug("hermes-overtime: could not register approval (%s)", type(exc).__name__)
            return
        if status != 201:
            logger.debug("hermes-overtime: Overtime did not take the approval (HTTP %s %s)", status, j.get("code", ""))
            return
        self.stats["registered"] += 1
        decision: Optional[Dict[str, Any]] = None
        errors = 0
        while not cancel.is_set():
            left = wait - (self.clock() - start)
            if left < 1:
                break
            w = int(min(25, left))
            try:
                status, j = self.http("GET", f"{self.base}/approvals/{rid}?wait={w}", None, self._headers(), w + 10)
            except Exception:
                errors += 1
                if errors >= 5:
                    break
                self.sleep(min(5.0, 2.0 ** errors))
                continue
            if status != 200:
                errors += 1
                if status in (401, 404) or errors >= 5:
                    break
                self.sleep(2.0)
                continue
            st = j.get("status")
            if st == "decided" and isinstance(j.get("decision"), dict):
                decision = j["decision"]
                break
            if st != "pending":
                return  # expired, or settled elsewhere
        if cancel.is_set():
            self.stats["local"] += 1
            self._outcome(rid, "answered_locally")
            return
        if decision is None:
            self.stats["timeouts"] += 1
            self._outcome(rid, "timeout", "no answer from Overtime in time; Hermes keeps asking locally")
            return
        if not (verify_decision(self.token, self.office, decision) and decision.get("request_id") == rid
                and decision.get("command_sha256") == _sha(command) and decision.get("choice") in REMOTE_CHOICES):
            self.stats["rejected"] += 1
            logger.warning("hermes-overtime: ignored an Overtime decision that failed verification")
            self._outcome(rid, "stale", "decision failed verification; ignored")
            return
        if cancel.is_set():
            self._outcome(rid, "answered_locally")
            return
        result = self.resolver(session_key, str(decision["choice"]), command)
        if result == "applied":
            self.stats["applied"] += 1
        self._outcome(rid, result, "" if result == "applied" else "the approval was no longer pending in Hermes")


def in_gateway_process() -> bool:
    return "gateway.run" in sys.modules or _truthy(os.environ.get("OVERTIME_BRIDGE"))


class TaskBridge:
    """Claims tasks from Overtime and starts them through Hermes' API server."""

    TERMINAL = {"completed": "completed", "failed": "failed", "cancelled": "cancelled", "interrupted": "failed"}

    def __init__(self, cfg: ControlConfig, ingest_url: str, token: str, http: Optional[Http] = None, api_http: Optional[Http] = None,
                 sleep: Callable[[float], None] = time.sleep, track_poll_s: float = 5.0, track_max_s: float = 6 * 3600) -> None:
        self.cfg = cfg
        self.base, self.office = control_base(ingest_url)
        self.token = token
        self.http = http or urllib_http
        self.api_http = api_http or urllib_http
        self.sleep = sleep
        self.track_poll_s = track_poll_s
        self.track_max_s = track_max_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.stats = {"claimed": 0, "started": 0, "rejected": 0, "failed": 0, "last_error": ""}

    @property
    def ready(self) -> bool:
        return bool(self.cfg.remote_tasks and self.base and self.token)

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "User-Agent": "hermes-overtime-control"}

    def _api_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.api_key}"} if self.cfg.api_key else {}

    def _ack(self, cid: str, status: str, run_id: str = "", error: str = "") -> None:
        body: Dict[str, Any] = {"status": status}
        if run_id:
            body["run_id"] = run_id
        if error:
            body["error"] = error[:300]
        try:
            self.http("POST", f"{self.base}/commands/{cid}/ack", body, self._headers(), 10)
        except Exception:
            pass

    def start(self) -> bool:
        if not self.ready or (self._thread and self._thread.is_alive()):
            return False
        self._thread = threading.Thread(target=self.loop, name="hermes-overtime-tasks", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    def loop(self) -> None:
        errors = 0
        while not self._stop.is_set():
            try:
                self.run_once(25)
                errors = 0
            except Exception as exc:
                errors += 1
                self.stats["last_error"] = type(exc).__name__
                self.sleep(min(60.0, 2.0 ** min(errors, 6)))

    def run_once(self, wait: int = 0) -> Optional[str]:
        """Claims and handles at most one task. Returns its id, or None."""
        status, j = self.http("GET", f"{self.base}/commands/next?wait={int(wait)}", None, self._headers(), wait + 10)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        if j.get("off"):
            self.sleep(30.0)  # tasks are switched off in Overtime: check back later
            return None
        cmd = j.get("command")
        if not isinstance(cmd, dict):
            return None
        self.stats["claimed"] += 1
        self.handle(cmd)
        return str(cmd.get("id"))

    def _reject(self, cid: str, why: str) -> None:
        self.stats["rejected"] += 1
        self._ack(cid, "rejected", error=why)

    def handle(self, cmd: Dict[str, Any]) -> None:
        cid = str(cmd.get("id") or "")
        if not verify_command(self.token, self.office, cmd):
            self._reject(cid, "signature check failed")
            return
        kind = str(cmd.get("kind"))
        payload = str(cmd.get("payload") or "")
        if kind not in self.cfg.commands:
            self._reject(cid, f"'{kind}' is not allowed by OVERTIME_REMOTE_COMMANDS on the Hermes machine")
            return
        if kind == "run":
            if len(payload) > self.cfg.max_chars:
                self._reject(cid, f"prompt longer than OVERTIME_TASK_MAX_CHARS ({self.cfg.max_chars})")
                return
            if payload.lstrip().startswith("/") and not self.cfg.allow_slash:
                self._reject(cid, "slash commands are refused (set OVERTIME_ALLOW_SLASH=1 to allow)")
                return
            self._start_run(cid, payload)
        elif kind == "stop":
            if not re.match(r"^run_[A-Za-z0-9]{8,64}$", payload):
                self._reject(cid, "not a Hermes run id")
                return
            try:
                status, j = self.api_http("POST", f"{self.cfg.api_url}/v1/runs/{payload}/stop", {}, self._api_headers(), 15)
            except Exception as exc:
                self._ack(cid, "failed", error=f"Hermes API server unreachable ({type(exc).__name__})")
                return
            self._ack(cid, "completed" if status < 300 else "failed", error="" if status < 300 else f"Hermes API server answered HTTP {status}")
        else:
            self._reject(cid, f"unknown task kind {kind}")

    def _start_run(self, cid: str, prompt: str) -> None:
        if not self.cfg.api_key:
            self._ack(cid, "failed", error="API_SERVER_KEY is not set: enable Hermes' API server (API_SERVER_ENABLED=true, API_SERVER_KEY=...)")
            return
        try:
            status, j = self.api_http("POST", f"{self.cfg.api_url}/v1/runs", {"input": prompt}, self._api_headers(), 30)
        except Exception as exc:
            self.stats["failed"] += 1
            self._ack(cid, "failed", error=f"Hermes API server unreachable at {self.cfg.api_url} ({type(exc).__name__}); is API_SERVER_ENABLED=true?")
            return
        run_id = str(j.get("run_id") or "")
        if status not in (200, 201, 202) or not run_id:
            self.stats["failed"] += 1
            err = j.get("error")
            msg = err.get("message") if isinstance(err, dict) else ""
            self._ack(cid, "failed", error=f"Hermes API server answered HTTP {status}{': ' + str(msg)[:200] if msg else ''}")
            return
        self.stats["started"] += 1
        self._ack(cid, "started", run_id=run_id)
        threading.Thread(target=self._track, args=(cid, run_id), name="hermes-overtime-track", daemon=True).start()

    def _track(self, cid: str, run_id: str) -> None:
        waited = 0.0
        while waited < self.track_max_s and not self._stop.is_set():
            self.sleep(self.track_poll_s)
            waited += self.track_poll_s
            try:
                status, j = self.api_http("GET", f"{self.cfg.api_url}/v1/runs/{run_id}", None, self._api_headers(), 15)
            except Exception:
                continue
            if status == 404:
                return
            st = self.TERMINAL.get(str(j.get("status")))
            if st:
                err = j.get("error")
                self._ack(cid, st, run_id=run_id, error=str(err)[:300] if err and st != "completed" else "")
                return


class Control:
    """What the plugin holds: the approver, the task bridge and their status line."""

    def __init__(self, ingest_url: str, token: str, cfg: Optional[ControlConfig] = None) -> None:
        self.cfg = cfg or ControlConfig()
        self.approver = RemoteApprover(self.cfg, ingest_url, token)
        self.tasks = TaskBridge(self.cfg, ingest_url, token)
        self._tls = threading.local()
        self._last_session = ""
        self._started = False

    def note_session(self, session_id: Any) -> None:
        if isinstance(session_id, str) and session_id:
            self._tls.session = session_id
            self._last_session = session_id

    def session(self) -> str:
        return getattr(self._tls, "session", "") or self._last_session

    def maybe_start_tasks(self) -> bool:
        if self._started or not self.tasks.ready or not in_gateway_process():
            return False
        self._started = self.tasks.start()
        if self._started:
            logger.info("hermes-overtime: accepting tasks from Overtime through %s", self.cfg.api_url)
        return self._started

    def status(self) -> str:
        parts = []
        if self.cfg.remote_approval:
            s = self.approver.stats
            parts.append(f"remote approval on (gateway sessions; {s['applied']} applied, {s['timeouts']} left to Hermes)")
        if self.cfg.remote_tasks:
            s = self.tasks.stats
            where = "running" if self._started else "waiting for the gateway (or run `hermes overtime bridge`)"
            parts.append(f"tasks {where} via {self.cfg.api_url} ({s['started']} started, {s['rejected']} refused)")
        return " · ".join(parts) or "remote control off"
