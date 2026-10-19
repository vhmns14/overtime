"""Tests for hermes-overtime remote control: approvals answered from Overtime (signature checks, the
timeout/error fallback to Hermes' local approval, local answers first) and the task bridge (signed
commands, allowlist, Hermes API server calls). Uses an in-process fake Overtime and fake Hermes API
server; one test drives Hermes' real tools.approval when hermes-agent is importable."""

import hashlib
import hmac
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("hermes_overtime_control_t", ROOT / "overtime_control.py")
oc = importlib.util.module_from_spec(_spec)
sys.modules["hermes_overtime_control_t"] = oc
_spec.loader.exec_module(oc)

OFFICE = "of-abc12345"
URL = f"https://overtime.test/api/ext/runs/{OFFICE}/hermes"
BASE = f"https://overtime.test/api/ext/runs/{OFFICE}/control"
TOKEN = "ot_ing_testtoken_aaaaaaaaaaaaaaaa"
VIEW = "ot_view_testtoken_bbbbbbbbbbbbbbbb"
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()


def sign_decision(key_token, rid, command, choice, by="Pixel 8", at=1760000000000):
    msg = "|".join(["v1", "decision", OFFICE, rid, sha(command), choice, by, str(at)])
    return {"request_id": rid, "command_sha256": sha(command), "choice": choice, "by": by, "at": at,
            "sig": hmac.new(sha(key_token).encode(), msg.encode(), hashlib.sha256).hexdigest()}


def sign_command(key_token, cid, kind, payload, created=1760000000000):
    msg = "|".join(["v1", "command", OFFICE, cid, kind, sha(payload), str(created)])
    return {"id": cid, "kind": kind, "payload": payload, "created_at": created, "by": "Laptop",
            "sig": hmac.new(sha(key_token).encode(), msg.encode(), hashlib.sha256).hexdigest()}


class FakeOvertime:
    """Speaks the /control routes the plugin uses."""

    def __init__(self, decide=None, register_status=201, down=False):
        self.decide = decide  # fn(rid, command) -> decision dict or None
        self.register_status = register_status
        self.down = down
        self.calls = []
        self.outcomes = {}
        self.acks = []
        self.commands = []
        self.approvals = {}
        self.lock = threading.Lock()

    def __call__(self, method, url, body, headers, timeout):
        with self.lock:
            self.calls.append((method, url, body, headers.get("Authorization")))
        if self.down:
            raise ConnectionError("down")
        assert headers["Authorization"] == f"Bearer {TOKEN}"
        path = url[len(BASE):]
        if method == "POST" and path == "/approvals":
            self.approvals[body["request_id"]] = body
            return self.register_status, ({"id": body["request_id"]} if self.register_status == 201 else {"code": "remote_approval_off"})
        if method == "GET" and path.startswith("/approvals/"):
            rid = path.split("/")[2].split("?")[0]
            d = self.decide(rid, self.approvals[rid]["command"]) if self.decide else None
            if d is None:
                time.sleep(0.01)
                return 200, {"id": rid, "status": "pending", "decision": None}
            return 200, {"id": rid, "status": "decided", "decision": d}
        if method == "POST" and path.endswith("/outcome"):
            self.outcomes[path.split("/")[2]] = body["outcome"]
            return 200, {"ok": True}
        if method == "GET" and path.startswith("/commands/next"):
            return 200, {"command": self.commands.pop(0) if self.commands else None}
        if method == "POST" and path.endswith("/ack"):
            self.acks.append((path.split("/")[2], body))
            return 200, {"ok": True}
        return 404, {}


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def approver(fake, env=None, resolver=None, timeout=60.0):
    cfg = oc.ControlConfig({"OVERTIME_REMOTE_APPROVAL": "1", **(env or {})})
    calls = []

    def res(session_key, choice, command):
        calls.append((session_key, choice, command))
        return "applied"

    a = oc.RemoteApprover(cfg, URL, TOKEN, http=fake, resolver=resolver or res, timeout_fn=lambda: timeout)
    return a, calls


REQ = {"command": "git push origin main --force", "description": "force push", "pattern_key": "git_force_push", "session_key": "agent:main:telegram:dm:42", "surface": "gateway"}


# ---------------- remote approval ----------------

def test_off_by_default():
    cfg = oc.ControlConfig({})
    assert not cfg.remote_approval and not cfg.remote_tasks
    fake = FakeOvertime()
    a = oc.RemoteApprover(cfg, URL, TOKEN, http=fake)
    assert a.on_request(REQ) is None
    assert fake.calls == []


def test_verified_decision_is_applied():
    fake = FakeOvertime(decide=lambda rid, cmd: sign_decision(TOKEN, rid, cmd, "once"))
    a, calls = approver(fake)
    t = a.on_request(REQ, "20261019_120000_ab")
    t.join(5)
    assert calls == [("agent:main:telegram:dm:42", "once", REQ["command"])]
    rid = next(iter(fake.approvals))
    assert fake.approvals[rid]["session"] == "20261019_120000_ab"
    assert fake.approvals[rid]["expires_in"] == 55
    assert fake.outcomes[rid] == "applied"


def test_timeout_falls_back_to_hermes_and_never_approves():
    fake = FakeOvertime(decide=None)
    clock = Clock()
    cfg = oc.ControlConfig({"OVERTIME_REMOTE_APPROVAL": "1"})
    calls = []
    a = oc.RemoteApprover(cfg, URL, TOKEN, http=fake, resolver=lambda *x: calls.append(x) or "applied", timeout_fn=lambda: 60.0, clock=clock, sleep=clock.sleep)
    orig = fake.__call__

    def ticking(method, url, body, headers, timeout):
        r = orig(method, url, body, headers, timeout)
        if method == "GET":
            clock.t += 25  # each long-poll uses its full wait
        return r

    a.http = ticking
    a.on_request(REQ).join(5)
    assert calls == []
    assert list(fake.outcomes.values()) == ["timeout"]
    polls = [c for c in fake.calls if c[0] == "GET"]
    assert [c[1].split("wait=")[1] for c in polls] == ["25", "25", "5"]


def test_overtime_down_never_raises_and_leaves_it_to_hermes():
    fake = FakeOvertime(down=True)
    a, calls = approver(fake)
    t = a.on_request(REQ)
    t.join(5)
    assert calls == []
    assert not t.is_alive()


def test_remote_approval_off_in_overtime():
    fake = FakeOvertime(register_status=409)
    a, calls = approver(fake)
    a.on_request(REQ).join(5)
    assert calls == [] and fake.outcomes == {}
    assert [c[0] for c in fake.calls] == ["POST"]


def test_poll_errors_back_off_then_give_up():
    clock = Clock()
    fake = FakeOvertime()
    n = {"get": 0}

    def flaky(method, url, body, headers, timeout):
        if method == "GET":
            n["get"] += 1
            raise TimeoutError()
        return fake(method, url, body, headers, timeout)

    cfg = oc.ControlConfig({"OVERTIME_REMOTE_APPROVAL": "1"})
    calls = []
    a = oc.RemoteApprover(cfg, URL, TOKEN, http=flaky, resolver=lambda *x: calls.append(x), timeout_fn=lambda: 300.0, clock=clock, sleep=clock.sleep)
    a.on_request(REQ).join(5)
    assert n["get"] == 5 and calls == []
    assert list(fake.outcomes.values()) == ["timeout"]


@pytest.mark.parametrize("bad", [
    lambda rid, cmd: sign_decision(VIEW, rid, cmd, "once"),                      # signed with the wrong key
    lambda rid, cmd: {**sign_decision(TOKEN, rid, cmd, "deny"), "choice": "once"},  # tampered choice
    lambda rid, cmd: sign_decision(TOKEN, rid, "rm -rf /", "once"),              # bound to another command
    lambda rid, cmd: sign_decision(TOKEN, "apr_someoneelse0000000000", cmd, "once"),  # another request
    lambda rid, cmd: sign_decision(TOKEN, rid, cmd, "always"),                   # never accepted remotely
])
def test_unverifiable_decisions_are_ignored(bad):
    fake = FakeOvertime(decide=bad)
    a, calls = approver(fake)
    a.on_request(REQ).join(5)
    assert calls == []
    assert list(fake.outcomes.values()) == ["stale"]
    assert a.stats["rejected"] == 1


def test_local_answer_first_cancels_the_remote_wait():
    gate = threading.Event()

    def decide(rid, cmd):
        gate.wait(2)
        return None

    fake = FakeOvertime(decide=decide)
    a, calls = approver(fake)
    t = a.on_request(REQ)
    time.sleep(0.05)
    a.on_response({**REQ, "choice": "deny"})
    gate.set()
    t.join(5)
    assert calls == []
    assert list(fake.outcomes.values()) == ["answered_locally"]


def test_cli_and_smart_surfaces_stay_local():
    fake = FakeOvertime(decide=lambda rid, cmd: sign_decision(TOKEN, rid, cmd, "once"))
    a, calls = approver(fake)
    assert a.on_request({**REQ, "surface": "cli"}) is None
    assert a.on_request({**REQ, "surface": "smart"}) is None
    assert fake.calls == []


def test_short_hermes_timeouts_are_not_mirrored():
    fake = FakeOvertime()
    a, _ = approver(fake, timeout=8.0)
    assert a.on_request(REQ) is None
    a2, _ = approver(fake, env={"OVERTIME_APPROVAL_WAIT": "30"}, timeout=300.0)
    assert a2.wait_seconds() == 30


def _fake_tools_approval(monkeypatch, entries):
    mod = types.ModuleType("tools.approval")
    mod._lock = threading.Lock()
    mod._gateway_queues = {"sk": [types.SimpleNamespace(data={"command": c}) for c in entries]}
    resolved = []

    def resolve(session_key, choice, resolve_all=False, reason=None):
        q = mod._gateway_queues.get(session_key) or []
        if not q:
            return 0
        resolved.append((session_key, choice, q.pop(0).data["command"]))
        return 1

    mod.resolve_gateway_approval = resolve
    pkg = types.ModuleType("tools")
    pkg.approval = mod
    monkeypatch.setitem(sys.modules, "tools", pkg)
    monkeypatch.setitem(sys.modules, "tools.approval", mod)
    return resolved


def test_resolver_only_answers_the_matching_head(monkeypatch):
    resolved = _fake_tools_approval(monkeypatch, ["rm -rf build", "git push --force"])
    assert oc.hermes_resolver("sk", "once", "git push --force") == "stale"  # not the head: never answer another approval
    assert resolved == []
    assert oc.hermes_resolver("sk", "deny", "rm -rf build") == "applied"
    assert resolved == [("sk", "deny", "rm -rf build")]
    assert oc.hermes_resolver("other", "once", "x") == "stale"


def test_resolver_refuses_unknown_hermes_internals(monkeypatch):
    mod = types.ModuleType("tools.approval")
    mod.resolve_gateway_approval = lambda *a, **k: 1
    pkg = types.ModuleType("tools")
    pkg.approval = mod
    monkeypatch.setitem(sys.modules, "tools", pkg)
    monkeypatch.setitem(sys.modules, "tools.approval", mod)
    assert oc.hermes_resolver("sk", "once", "x") == "unsupported"


def _real_hermes():
    try:
        import tools.approval as ap  # noqa: F401
        return ap if hasattr(ap, "_await_gateway_decision") else None
    except Exception:
        return None


@pytest.mark.skipif(_real_hermes() is None, reason="hermes-agent not importable in this Python")
def test_real_hermes_gateway_approval_is_resolved_remotely(monkeypatch):
    """Hermes' own blocking gateway wait (tools.approval._await_gateway_decision), answered from Overtime."""
    import tools.approval as ap
    for m in [k for k in list(sys.modules) if k == "tools" or k.startswith("tools.")]:
        pass
    monkeypatch.setattr(ap, "_get_approval_timeout", lambda: 30)
    fake = FakeOvertime(decide=lambda rid, cmd: sign_decision(TOKEN, rid, cmd, "deny"))
    cfg = oc.ControlConfig({"OVERTIME_REMOTE_APPROVAL": "1"})
    a = oc.RemoteApprover(cfg, URL, TOKEN, http=fake, timeout_fn=lambda: 30.0)  # the real resolver
    threads = []
    real_fire = ap._fire_approval_hook

    def fire(name, **kw):
        if name == "pre_approval_request":
            threads.append(a.on_request(kw, "s-real"))
        elif name == "post_approval_response":
            a.on_response(kw)
        return real_fire(name, **kw)

    monkeypatch.setattr(ap, "_fire_approval_hook", fire)
    data = {"command": "git push --force", "description": "force push", "pattern_key": "k", "pattern_keys": ["k"]}
    t0 = time.monotonic()
    out = ap._await_gateway_decision("real-session", lambda d: None, data, surface="gateway")
    assert out["resolved"] is True and out["choice"] == "deny"
    assert time.monotonic() - t0 < 10
    threads[0].join(5)
    assert list(fake.outcomes.values()) == ["applied"]


# ---------------- tasks ----------------

class FakeHermesAPI:
    def __init__(self, status=202, down=False, final="completed"):
        self.status = status
        self.down = down
        self.final = final
        self.calls = []

    def __call__(self, method, url, body, headers, timeout):
        self.calls.append((method, url, body, headers.get("Authorization")))
        if self.down:
            raise ConnectionRefusedError()
        if method == "POST" and url.endswith("/v1/runs"):
            return (self.status, {"run_id": "run_0123456789abcdef", "status": "started"}) if self.status == 202 else (self.status, {"error": {"message": "nope"}})
        if method == "GET" and "/v1/runs/" in url:
            return 200, {"run_id": "run_0123456789abcdef", "status": self.final}
        if method == "POST" and url.endswith("/stop"):
            return 200, {"ok": True}
        return 404, {}


def bridge(fake, api, env=None):
    cfg = oc.ControlConfig({"OVERTIME_REMOTE_TASKS": "1", "API_SERVER_KEY": "hermes-api-key", **(env or {})})
    return oc.TaskBridge(cfg, URL, TOKEN, http=fake, api_http=api, sleep=lambda s: None, track_poll_s=0.01, track_max_s=1)


def wait_for(cond, t=3.0):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_task_is_started_through_the_hermes_api_server_and_tracked():
    fake, api = FakeOvertime(), FakeHermesAPI()
    fake.commands.append(sign_command(TOKEN, "cmd_1", "run", "Summarise today's open PRs"))
    b = bridge(fake, api)
    assert b.run_once() == "cmd_1"
    assert api.calls[0] == ("POST", "http://127.0.0.1:8642/v1/runs", {"input": "Summarise today's open PRs"}, "Bearer hermes-api-key")
    assert wait_for(lambda: len(fake.acks) == 2)
    assert fake.acks == [("cmd_1", {"status": "started", "run_id": "run_0123456789abcdef"}), ("cmd_1", {"status": "completed", "run_id": "run_0123456789abcdef"})]


@pytest.mark.parametrize("cmd,why", [
    (sign_command(VIEW, "cmd_2", "run", "hi"), "signature"),
    ({**sign_command(TOKEN, "cmd_3", "run", "hi"), "payload": "rm -rf ~"}, "signature"),
    (sign_command(TOKEN, "cmd_4", "run", "/yolo"), "slash"),
    (sign_command(TOKEN, "cmd_5", "exec", "ls"), "not allowed"),
    (sign_command(TOKEN, "cmd_6", "run", "x" * 4001), "OVERTIME_TASK_MAX_CHARS"),
])
def test_bad_or_disallowed_tasks_are_refused_without_touching_hermes(cmd, why):
    fake, api = FakeOvertime(), FakeHermesAPI()
    fake.commands.append(cmd)
    bridge(fake, api).run_once()
    assert api.calls == []
    assert fake.acks[0][1]["status"] == "rejected"
    assert why in fake.acks[0][1]["error"]


def test_allowlist_and_slash_are_configurable():
    fake, api = FakeOvertime(), FakeHermesAPI()
    fake.commands.append(sign_command(TOKEN, "cmd_7", "stop", "run_0123456789abcdef"))
    bridge(fake, api, {"OVERTIME_REMOTE_COMMANDS": "run"}).run_once()
    assert fake.acks[0][1]["status"] == "rejected"
    fake2, api2 = FakeOvertime(), FakeHermesAPI()
    fake2.commands.append(sign_command(TOKEN, "cmd_8", "run", "/help"))
    bridge(fake2, api2, {"OVERTIME_ALLOW_SLASH": "1"}).run_once()
    assert api2.calls and api2.calls[0][2] == {"input": "/help"}


def test_missing_api_key_or_unreachable_api_server_fail_clearly():
    fake, api = FakeOvertime(), FakeHermesAPI()
    fake.commands.append(sign_command(TOKEN, "cmd_9", "run", "hi"))
    bridge(fake, api, {"API_SERVER_KEY": ""}).run_once()
    assert fake.acks[0][1]["status"] == "failed" and "API_SERVER_KEY" in fake.acks[0][1]["error"]
    fake2, api2 = FakeOvertime(), FakeHermesAPI(down=True)
    fake2.commands.append(sign_command(TOKEN, "cmd_10", "run", "hi"))
    bridge(fake2, api2).run_once()
    assert fake2.acks[0][1]["status"] == "failed" and "API_SERVER_ENABLED" in fake2.acks[0][1]["error"]
    fake3, api3 = FakeOvertime(), FakeHermesAPI(status=429)
    fake3.commands.append(sign_command(TOKEN, "cmd_11", "run", "hi"))
    bridge(fake3, api3).run_once()
    assert "HTTP 429" in fake3.acks[0][1]["error"]


def test_stop_maps_to_the_api_server_stop_route():
    fake, api = FakeOvertime(), FakeHermesAPI()
    fake.commands.append(sign_command(TOKEN, "cmd_12", "stop", "run_0123456789abcdef"))
    bridge(fake, api).run_once()
    assert api.calls == [("POST", "http://127.0.0.1:8642/v1/runs/run_0123456789abcdef/stop", {}, "Bearer hermes-api-key")]
    assert fake.acks == [("cmd_12", {"status": "completed"})]


def test_empty_queue_and_tasks_switched_off():
    fake, api = FakeOvertime(), FakeHermesAPI()
    b = bridge(fake, api)
    assert b.run_once() is None
    slept = []
    b.sleep = slept.append
    b.http = lambda *a: (200, {"command": None, "off": True})
    assert b.run_once() is None and slept == [30.0]


def test_task_bridge_only_runs_in_the_gateway(monkeypatch):
    monkeypatch.delitem(sys.modules, "gateway.run", raising=False)
    monkeypatch.delenv("OVERTIME_BRIDGE", raising=False)
    monkeypatch.setenv("OVERTIME_REMOTE_TASKS", "1")
    c = oc.Control(URL, TOKEN, oc.ControlConfig({"OVERTIME_REMOTE_TASKS": "1"}))
    assert c.maybe_start_tasks() is False
    assert "waiting for the gateway" in c.status()


def test_control_base_parsing():
    assert oc.control_base(URL) == (BASE, OFFICE)
    assert oc.control_base("https://x/other") == ("", "")


# ---------------- wiring inside the plugin ----------------

_pspec = importlib.util.spec_from_file_location("hermes_overtime_plugin_t", ROOT / "__init__.py")
ho = importlib.util.module_from_spec(_pspec)
sys.modules["hermes_overtime_plugin_t"] = ho
_pspec.loader.exec_module(ho)


class NullSender:
    def __init__(self):
        self.envs = []

    def enqueue(self, env):
        self.envs.append(env)
        return True


def test_plugin_without_flags_never_loads_control(monkeypatch):
    for k in ("OVERTIME_REMOTE_APPROVAL", "OVERTIME_REMOTE_TASKS"):
        monkeypatch.delenv(k, raising=False)
    p = ho.Plugin(ho.Config(URL, TOKEN), NullSender())
    p.hook("pre_approval_request")(**REQ)
    assert p.control is None
    assert p.sender.envs[0]["hook_event_name"] == "pre_approval_request"


def test_plugin_routes_approval_hooks_to_control_with_the_agent_threads_session(monkeypatch):
    monkeypatch.setenv("OVERTIME_REMOTE_APPROVAL", "1")
    seen = []
    ctl = types.SimpleNamespace(
        maybe_start_tasks=lambda: False,
        approver=types.SimpleNamespace(on_request=lambda kw, sid: seen.append(("req", sid, kw["session_key"])), on_response=lambda kw: seen.append(("resp", kw["choice"]))),
        status=lambda: "x",
    )
    p = ho.Plugin(ho.Config(URL, TOKEN), NullSender(), control=ctl)
    p.hook("pre_api_request")(session_id="20261019_090826_7eba2a", model="m")
    p.hook("pre_approval_request")(**REQ)
    p.hook("post_approval_response")(**REQ, choice="once")
    assert seen == [("req", "20261019_090826_7eba2a", REQ["session_key"]), ("resp", "once")]
    # the observer event now lands in the right office session too
    assert p.sender.envs[1]["session_id"] == "20261019_090826_7eba2a"


def test_plugin_loads_the_control_module_by_path(monkeypatch):
    monkeypatch.setenv("OVERTIME_REMOTE_TASKS", "1")
    p = ho.Plugin(ho.Config(URL, TOKEN), NullSender())
    ctl = p._control()
    assert ctl is not None and ctl.tasks.ready and not ctl.approver.ready
