"""hermes-overtime: watch this Hermes agent work live in Overtime's pixel office.

Registers Hermes *observer* hooks only (no pre_tool_call / pre_llm_call / transform_* / approval
transports), turns each firing into the same envelope Hermes uses for outbound webhooks
(``hook_event_name``, ``tool_name``, ``tool_input``, ``session_id``, ``extra``, ``timestamp``),
trims it to the configured privacy level and hands it to a background thread that POSTs batches
to Overtime. Hook callbacks never do network I/O, never raise, and never wait: when the queue is
full or Overtime is down, events are dropped and counted.

Configuration (environment, e.g. ``~/.hermes/.env``):

  OVERTIME_URL       ingest URL from Overtime's Connect screen: https://<host>/api/ext/runs/<office>/hermes
  OVERTIME_TOKEN     the office's ingest token (ot_ing_…)
  OVERTIME_PRIVACY   metadata (default) | args | full
  OVERTIME_TIMEOUT   seconds per POST (default 3)
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

__version__ = "0.1.0"
logger = logging.getLogger("hermes_overtime")

# Observer hooks Overtime understands. Only the ones the running Hermes knows are registered.
OBSERVER_HOOKS = (
    "on_session_start", "on_session_end", "on_session_finalize", "on_session_reset", "agent_loop_stopped",
    "pre_api_request", "post_api_request", "api_request_error", "on_interim_message",
    "post_tool_call", "post_llm_call",
    "subagent_start", "subagent_stop",
    "pre_approval_request", "post_approval_response", "on_human_input_request", "on_human_input_resolved",
)
PRIVACY_LEVELS = ("metadata", "args", "full")

# extra fields that are metadata (ids, counts, statuses, timings, model names) and always allowed
_META_EXTRA = {
    "task_id", "turn_id", "tool_call_id", "api_request_id", "api_call_count", "retry_count",
    "parent_session_id", "parent_turn_id", "parent_subagent_id", "child_session_id", "child_subagent_id",
    "child_role", "child_status", "request_id", "kind", "outcome", "choice", "decided_by", "surface",
    "pattern_key", "status", "error_type", "duration_ms", "api_duration", "model", "response_model",
    "provider", "platform", "finish_reason", "assistant_tool_call_count", "completed", "interrupted",
    "failed", "turn_exit_reason", "reason", "retryable", "status_code", "max_retries", "description",
    "is_first_turn", "iteration", "already_streamed", "message_count", "tool_count",
}
_ARGS_EXTRA = {"child_goal", "child_summary", "command", "prompt", "error_message"}
_FULL_EXTRA = {"result", "user_message", "assistant_response", "text"}
_BULKY_ARGS = {"content", "old_string", "new_string", "patch", "code", "data", "body", "file_text"}

_SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)"),
    re.compile(r"\bsk-(?:or-v1-|ant-(?:api\d+-)?|proj-|live-|test-)?[A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
    re.compile(r"\bot_(?:ing|view|whs)_[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}"),
]
_SECRET_ASSIGN = re.compile(r"(?i)\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PRIVATE_?KEY)[A-Za-z0-9_]*)(\s*[=:]\s*[\"']?)([^\s\"'&,;]{4,})")
_SECRET_KEY = re.compile(r"(?i)^(?:.*[_-])?(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|cookie|private[_-]?key|credentials?|client[_-]?secret)$")
_MULTI = {"git", "npm", "pnpm", "yarn", "bun", "npx", "docker", "podman", "kubectl", "helm", "cargo", "go", "uv", "pip", "pip3", "poetry", "make", "systemctl", "wrangler", "fly", "flyctl", "vercel", "netlify", "gh", "terraform", "deno", "pytest", "ruff", "eslint", "tsc", "vitest", "jest", "crontab"}


def redact(s: str) -> str:
    for rx in _SECRET_RES:
        s = rx.sub("[redacted]", s)
    return _SECRET_ASSIGN.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", s)


def _clip(s: Any, n: int) -> str:
    s = s if isinstance(s, str) else json.dumps(s, default=str, ensure_ascii=False)
    s = redact(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def command_head(cmd: str) -> str:
    """First words of each part of a shell command: subcommands only, never free arguments."""
    heads: List[str] = []
    for seg in re.split(r"&&|\|\||;|\||\n", cmd)[:4]:
        out: List[str] = []
        pre: List[str] = []
        for t in seg.split():
            if not out and t in ("sudo", "time", "nohup", "exec", "env", "command"):
                if t == "sudo":
                    pre.append(t)
                continue
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
                continue
            py_m = t == "-m" and len(out) == 1 and out[0].startswith("python")
            if t[:1] in "<>&" or (t.startswith("-") and not py_m) or not re.match(r"^[\w.+:@-]{1,40}$", t):
                break
            if len(out) == 1 and not py_m and out[0].rsplit("/", 1)[-1] not in _MULTI:
                break
            if len(out) == 2 and out[1] not in ("run", "compose", "exec", "x", "-m"):
                break
            out.append(t)
            if len(out) >= 3:
                break
        if out and out != ["cd"]:
            heads.append(" ".join(pre + out))
    return " && ".join(heads)[:80]


def _host_path(u: str) -> str:
    m = re.match(r"^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?([^/?#]+)([^?#]*)", u, re.I)
    return (m.group(1) + (m.group(2) if m.group(2) not in ("", "/") else ""))[:200] if m else u.split("?")[0][:200]


def trim_args(tool: Optional[str], args: Any, privacy: str) -> Optional[Dict[str, Any]]:
    """Tool arguments at the chosen privacy level."""
    if not isinstance(args, dict):
        return None
    out: Dict[str, Any] = {}
    if privacy == "metadata":
        for k in ("path", "file_path", "filepath", "mode"):
            if isinstance(args.get(k), str):
                out[k] = args[k][:300]
        if isinstance(args.get("url"), str):
            out["url"] = _host_path(args["url"])
        if isinstance(args.get("command"), str):
            out["command"] = command_head(args["command"])
        if tool == "patch" and isinstance(args.get("patch"), str):
            # paths only: "*** Update File: x" headers survive, contents do not
            out["patch"] = "\n".join(re.findall(r"^\*\*\* (?:Update|Add|Delete) File: .+$", args["patch"], re.M)[:20])
        if tool in ("todo_list", "todo") and isinstance(args.get("todos"), list):
            out["todos"] = [
                {"id": str(t.get("id", ""))[:64], "content": _clip(str(t.get("content", "")), 80), "status": str(t.get("status", ""))[:16]}
                for t in args["todos"][:40] if isinstance(t, dict)
            ]
        if tool == "delegate_task" and isinstance(args.get("tasks"), list):
            out["tasks"] = [{} for _ in args["tasks"][:20]]
        return out
    for k, v in list(args.items())[:30]:
        if k == "todos" and isinstance(v, list):
            out[k] = trim_args(tool, {"todos": v}, "metadata").get("todos", []) if tool in ("todo_list", "todo") else _clip(v, 300)
        elif _SECRET_KEY.match(str(k)):
            out[k] = "[redacted]"
        elif k in _BULKY_ARGS and isinstance(v, str):
            # file bodies never leave the machine; a patch keeps only its "*** Update File:" headers
            heads = "\n".join(re.findall(r"^\*\*\* (?:Update|Add|Delete) File: .+$", v, re.M)[:20]) if k == "patch" else ""
            out[k] = heads or f"[{len(v)} chars]"
        elif isinstance(v, str):
            out[k] = _clip(v, 300)
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            out[k] = _clip(v, 300)
    return out


def _tool_calls(kwargs: Dict[str, Any], privacy: str) -> List[Dict[str, Any]]:
    msg = kwargs.get("assistant_message")
    calls = getattr(msg, "tool_calls", None) if msg is not None else None
    if calls is None and isinstance(msg, dict):
        calls = msg.get("tool_calls")
    out: List[Dict[str, Any]] = []
    for tc in (calls or [])[:20]:
        fn = getattr(tc, "function", None) if not isinstance(tc, dict) else tc.get("function")
        name = getattr(fn, "name", None) if not isinstance(fn, dict) else fn.get("name")
        raw = getattr(fn, "arguments", None) if not isinstance(fn, dict) else fn.get("arguments")
        tid = getattr(tc, "id", None) if not isinstance(tc, dict) else tc.get("id")
        if not isinstance(name, str):
            continue
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            args = None
        out.append({"id": tid if isinstance(tid, str) else None, "function": {"name": name, "arguments": trim_args(name, args, privacy) or {}}})
    return out


def _iso_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


def build_envelope(hook: str, kwargs: Dict[str, Any], privacy: str = "metadata", profile: str = "default") -> Dict[str, Any]:
    """Outbound-webhook-shaped envelope, trimmed to the privacy level. Cheap: no deep copies."""
    allowed = set(_META_EXTRA)
    if privacy in ("args", "full"):
        allowed |= _ARGS_EXTRA
    if privacy == "full":
        allowed |= _FULL_EXTRA
    extra: Dict[str, Any] = {}
    for k in allowed:
        if k not in kwargs:
            continue
        v = kwargs[k]
        if isinstance(v, (int, float, bool)) or v is None:
            extra[k] = v
        elif isinstance(v, str):
            extra[k] = _clip(v, 1000 if k in ("user_message", "assistant_response", "text") else 500 if k == "result" else 300)
        else:
            extra[k] = _clip(v, 500)
    usage = kwargs.get("usage")
    if isinstance(usage, dict):
        extra["usage"] = {k: v for k, v in usage.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
    if hook == "post_api_request":
        extra["tool_calls"] = _tool_calls(kwargs, privacy)
    if hook == "subagent_stop" and isinstance(kwargs.get("tool_call_history"), list):
        extra["tool_call_history"] = [{} for _ in kwargs["tool_call_history"][:200]]
    if hook == "api_request_error" and isinstance(kwargs.get("error"), dict):
        e = kwargs["error"]
        extra["error"] = {"type": str(e.get("type", ""))[:64], **({"message": _clip(e.get("message", ""), 300)} if privacy != "metadata" else {})}
    tool = kwargs.get("tool_name") if isinstance(kwargs.get("tool_name"), str) else None
    return {
        "hook_event_name": hook,
        "profile": profile,
        "tool_name": tool,
        "tool_input": trim_args(tool, kwargs.get("args"), privacy) if tool else None,
        "session_id": str(kwargs.get("session_id") or kwargs.get("parent_session_id") or "")[:128],
        "extra": extra,
        "timestamp": _iso_now(),
    }


class Config:
    def __init__(self, url: str = "", token: str = "", privacy: str = "metadata", timeout: float = 3.0,
                 batch_max: int = 50, flush_s: float = 0.4, queue_max: int = 2000) -> None:
        self.url = url.strip()
        self.token = token.strip()
        self.privacy = privacy if privacy in PRIVACY_LEVELS else "metadata"
        self.timeout = max(0.5, min(float(timeout), 10.0))
        self.batch_max = batch_max
        self.flush_s = flush_s
        self.queue_max = queue_max

    @classmethod
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> "Config":
        e = os.environ if env is None else env
        try:
            timeout = float(e.get("OVERTIME_TIMEOUT", "3") or 3)
        except ValueError:
            timeout = 3.0
        return cls(e.get("OVERTIME_URL", ""), e.get("OVERTIME_TOKEN", ""), (e.get("OVERTIME_PRIVACY", "metadata") or "metadata").strip().lower(), timeout)

    @property
    def ready(self) -> bool:
        return bool(self.url and self.token and re.match(r"^https?://", self.url))

    @property
    def share_url(self) -> str:
        return re.sub(r"/hermes/?$", "/share", self.url)


Post = Callable[[str, bytes, Dict[str, str], float], int]


def _urllib_post(url: str, body: bytes, headers: Dict[str, str], timeout: float) -> int:
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a: Any, **k: Any) -> None:  # a redirected POST would drop the body
            return None

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    opener = urllib.request.build_opener(_NoRedirect())
    with opener.open(req, timeout=timeout) as r:
        return int(r.status)


class Sender:
    """Bounded queue + one daemon thread. Batches, times out, drops on failure, backs off after 3 failures."""

    def __init__(self, cfg: Config, post: Optional[Post] = None, cost_fn: Optional[Callable[[Dict[str, Any]], Optional[float]]] = None) -> None:
        self.cfg = cfg
        self._post = post or _urllib_post
        self._cost_fn = cost_fn
        self._q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue(maxsize=cfg.queue_max)
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._fails = 0
        self._open_until = 0.0
        self._last_warn = 0.0
        self._idle = threading.Event()
        self._idle.set()
        self.stats = {"queued": 0, "sent": 0, "dropped": 0, "failed_batches": 0, "last_error": ""}

    def enqueue(self, env: Dict[str, Any]) -> bool:
        try:
            self._q.put_nowait(env)
        except queue.Full:
            self.stats["dropped"] += 1
            return False
        self.stats["queued"] += 1
        self._idle.clear()
        self._ensure_thread()
        return True

    def _ensure_thread(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._run, name="hermes-overtime-sender", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            try:
                first = self._q.get(timeout=5.0)
            except queue.Empty:
                self._idle.set()
                continue
            batch = [first]
            deadline = time.monotonic() + self.cfg.flush_s
            while len(batch) < self.cfg.batch_max:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                try:
                    batch.append(self._q.get(timeout=left))
                except queue.Empty:
                    break
            try:
                self._send(batch)
            except Exception as exc:  # belt and braces: the thread must survive anything
                self.stats["dropped"] += len(batch)
                self.stats["last_error"] = type(exc).__name__
            if self._q.empty():
                self._idle.set()

    def _send(self, batch: List[Dict[str, Any]]) -> None:
        now = time.monotonic()
        if now < self._open_until:
            self.stats["dropped"] += len(batch)
            return
        if self._cost_fn:
            for env in batch:
                if env.get("hook_event_name") == "post_api_request":
                    try:
                        c = self._cost_fn(env)
                        if c is not None:
                            env["extra"]["cost_usd"] = c
                    except Exception:
                        pass
                    env["extra"].pop("_pricing", None)
        body = json.dumps({"batch": batch}, ensure_ascii=False, default=str).encode("utf-8")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.cfg.token}", "User-Agent": f"hermes-overtime/{__version__}"}
        try:
            status = self._post(self.cfg.url, body, headers, self.cfg.timeout)
            if status >= 300:
                raise urllib.error.HTTPError(self.cfg.url, status, "status", None, None)  # type: ignore[arg-type]
            self.stats["sent"] += len(batch)
            self._fails = 0
        except Exception as exc:
            self._fails += 1
            self.stats["failed_batches"] += 1
            self.stats["dropped"] += len(batch)
            code = getattr(exc, "code", None)
            self.stats["last_error"] = f"HTTP {code}" if code else type(exc).__name__
            if self._fails >= 3:
                self._open_until = time.monotonic() + 30.0
            if now - self._last_warn > 60:
                self._last_warn = now
                logger.warning("hermes-overtime: could not reach Overtime (%s); events are being dropped", self.stats["last_error"])

    def flush(self, timeout: float = 5.0) -> bool:
        return self._idle.wait(timeout)


def _hermes_cost(env: Dict[str, Any]) -> Optional[float]:
    """Hermes' own price estimate for one API call (agent.usage_pricing), when it knows the model."""
    p = env.get("extra", {}).pop("_pricing", None)
    if not p:
        return None
    try:
        from agent.usage_pricing import CanonicalUsage, estimate_usage_cost  # type: ignore
    except Exception:
        return None
    u = p.get("usage") or {}
    fields = {k: int(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")}
    try:
        res = estimate_usage_cost(p.get("model") or "", CanonicalUsage(**fields), provider=p.get("provider"), base_url=p.get("base_url"))
    except Exception:
        return None
    amt = getattr(res, "amount_usd", None)
    return float(amt) if amt is not None else None


def _profile_name() -> str:
    try:
        from hermes_cli.profiles import get_active_profile_name  # type: ignore
        return str(get_active_profile_name() or "default")
    except Exception:
        return "default"


class Plugin:
    def __init__(self, cfg: Optional[Config] = None, sender: Optional[Sender] = None) -> None:
        self.cfg = cfg or Config.from_env()
        self.sender = sender or Sender(self.cfg, cost_fn=_hermes_cost)
        self.profile = _profile_name()

    def _refresh(self) -> None:
        # ~/.hermes/.env may be loaded after the plugin registered
        if not self.cfg.ready:
            fresh = Config.from_env()
            if fresh.ready:
                self.cfg.__dict__.update(fresh.__dict__)

    def hook(self, name: str) -> Callable[..., None]:
        def _observer(**kwargs: Any) -> None:
            try:
                self._refresh()
                if not self.cfg.ready:
                    return None
                env = build_envelope(name, kwargs, self.cfg.privacy, self.profile)
                if name == "post_api_request":
                    env["extra"]["_pricing"] = {"model": kwargs.get("response_model") or kwargs.get("model"), "provider": kwargs.get("provider"), "base_url": kwargs.get("base_url"), "usage": env["extra"].get("usage")}
                self.sender.enqueue(env)
            except Exception:
                logger.debug("hermes-overtime hook %s failed", name, exc_info=True)
            return None  # observers never return directives

        _observer.__name__ = f"overtime_{name}"
        return _observer

    def viewer_link(self) -> str:
        self._refresh()
        if not self.cfg.ready:
            return ("Overtime is not connected. Open Overtime → Connect Hermes, then put OVERTIME_URL and "
                    "OVERTIME_TOKEN in ~/.hermes/.env and restart Hermes.")
        link = ""
        try:
            req = urllib.request.Request(self.cfg.share_url, headers={"Authorization": f"Bearer {self.cfg.token}", "User-Agent": f"hermes-overtime/{__version__}"})
            with urllib.request.urlopen(req, timeout=self.cfg.timeout) as r:
                link = json.loads(r.read().decode("utf-8")).get("watch", "")
        except Exception as exc:
            link = f"(could not fetch the viewer link: {type(exc).__name__})"
        s = self.sender.stats
        return (f"Overtime office: {link}\n"
                f"privacy={self.cfg.privacy} · sent {s['sent']} · dropped {s['dropped']}"
                + (f" · last error {s['last_error']}" if s["last_error"] else ""))

    def send_test(self) -> str:
        self._refresh()
        if not self.cfg.ready:
            return self.viewer_link()
        envs = [build_envelope("on_session_start", {"session_id": "overtime-test", "model": "test", "platform": "cli"}, self.cfg.privacy, self.profile),
                build_envelope("on_session_end", {"session_id": "overtime-test", "completed": True}, self.cfg.privacy, self.profile)]
        body = json.dumps({"batch": envs}).encode("utf-8")
        try:
            status = _urllib_post(self.cfg.url, body, {"Content-Type": "application/json", "Authorization": f"Bearer {self.cfg.token}"}, self.cfg.timeout)
            return f"Overtime answered HTTP {status}. Check the office: a test session should appear."
        except Exception as exc:
            code = getattr(exc, "code", None)
            return f"Could not reach Overtime: {'HTTP ' + str(code) if code else type(exc).__name__}"


_PLUGIN: Optional[Plugin] = None


def register(ctx: Any) -> None:
    global _PLUGIN
    plugin = Plugin()
    _PLUGIN = plugin
    try:
        from hermes_cli.plugins import VALID_HOOKS  # type: ignore
        valid = set(VALID_HOOKS)
    except Exception:
        valid = set(OBSERVER_HOOKS)
    for name in OBSERVER_HOOKS:
        if name in valid:  # older Hermes releases know fewer hooks; never register unknown names
            ctx.register_hook(name, plugin.hook(name))

    def _slash(raw_args: str = "", **_: Any) -> str:
        return plugin.send_test() if raw_args.strip() == "test" else plugin.viewer_link()

    if hasattr(ctx, "register_command"):
        try:
            ctx.register_command("overtime", _slash, description="Show the Overtime office link and delivery stats (/overtime test sends a test event)")
        except Exception:
            logger.debug("hermes-overtime: register_command failed", exc_info=True)

    if hasattr(ctx, "register_cli_command"):
        def _setup(p: Any) -> None:
            p.add_argument("action", nargs="?", default="link", choices=["link", "test"], help="link: print the viewer URL; test: send a test session")

        def _run(args: Any) -> None:
            print(plugin.send_test() if getattr(args, "action", "link") == "test" else plugin.viewer_link())

        try:
            ctx.register_cli_command("overtime", "Overtime pixel-office viewer for this agent", _setup, _run, description="Print the Overtime viewer link or send a test event")
        except Exception:
            logger.debug("hermes-overtime: register_cli_command failed", exc_info=True)
