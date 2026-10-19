"""Tests for the hermes-overtime plugin: observer-only registration, envelope trimming per privacy
level, batching, and failure isolation (a dead or slow Overtime never slows or breaks Hermes)."""

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("hermes_overtime", Path(__file__).resolve().parents[1] / "__init__.py")
ho = importlib.util.module_from_spec(_spec)
sys.modules["hermes_overtime"] = ho
_spec.loader.exec_module(ho)

URL = "https://overtime.test/api/ext/runs/of-abc12345/hermes"


class Recorder:
    def __init__(self, fail=False, delay=0.0, status=200):
        self.calls = []
        self.fail = fail
        self.delay = delay
        self.status = status
        self.lock = threading.Lock()

    def __call__(self, url, body, headers, timeout):
        if self.delay:
            time.sleep(self.delay)
        with self.lock:
            self.calls.append({"url": url, "batch": json.loads(body)["batch"], "headers": headers, "timeout": timeout})
        if self.fail:
            raise ConnectionError("down")
        return self.status


def make(privacy="metadata", **kw):
    cfg = ho.Config(URL, "ot_ing_testtoken", privacy, timeout=kw.pop("timeout", 3.0), flush_s=kw.pop("flush_s", 0.05), batch_max=kw.pop("batch_max", 50), queue_max=kw.pop("queue_max", 2000))
    rec = kw.pop("rec", Recorder())
    return ho.Plugin(cfg, ho.Sender(cfg, post=rec)), rec


class FakeCtx:
    def __init__(self):
        self.hooks = {}
        self.commands = {}
        self.cli = {}

    def register_hook(self, name, cb):
        self.hooks.setdefault(name, []).append(cb)

    def register_command(self, name, handler, description=""):
        self.commands[name] = handler

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description=""):
        self.cli[name] = (setup_fn, handler_fn)


# ---------- registration ----------

def test_registers_observer_hooks_only(monkeypatch):
    monkeypatch.setenv("OVERTIME_URL", URL)
    monkeypatch.setenv("OVERTIME_TOKEN", "ot_ing_x")
    ctx = FakeCtx()
    ho.register(ctx)
    assert set(ctx.hooks) == set(ho.OBSERVER_HOOKS)
    behaviour_changing = {"pre_tool_call", "pre_llm_call", "pre_verify", "pre_gateway_dispatch", "post_gateway_admission",
                          "transform_tool_result", "transform_terminal_output", "transform_llm_output", "pre_transcription",
                          "transform_api_error_classification"}
    assert not behaviour_changing & set(ctx.hooks)
    assert "overtime" in ctx.commands and "overtime" in ctx.cli


def test_only_hooks_the_running_hermes_knows(monkeypatch):
    fake = type(sys)("hermes_cli.plugins")
    fake.VALID_HOOKS = {"post_tool_call", "on_session_start", "pre_tool_call"}
    monkeypatch.setitem(sys.modules, "hermes_cli", type(sys)("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.plugins", fake)
    ctx = FakeCtx()
    ho.register(ctx)
    assert set(ctx.hooks) == {"post_tool_call", "on_session_start"}


def test_hooks_return_none_and_never_raise():
    p, rec = make()
    cb = p.hook("post_tool_call")
    assert cb(tool_name="terminal", args={"command": "ls"}, status="ok") is None
    assert cb(tool_name=object(), args=object(), weird=lambda: 1) is None  # garbage in, nothing out
    assert p.hook("post_api_request")(assistant_message=object(), usage="nope") is None


def test_unconfigured_plugin_sends_nothing_and_explains(monkeypatch):
    monkeypatch.delenv("OVERTIME_URL", raising=False)
    monkeypatch.delenv("OVERTIME_TOKEN", raising=False)
    rec = Recorder()
    cfg = ho.Config("", "")
    p = ho.Plugin(cfg, ho.Sender(cfg, post=rec))
    p.hook("on_session_start")(session_id="s", model="m")
    time.sleep(0.1)
    assert rec.calls == []
    assert "OVERTIME_URL" in p.viewer_link()


def test_config_from_env():
    c = ho.Config.from_env({"OVERTIME_URL": URL, "OVERTIME_TOKEN": "t", "OVERTIME_PRIVACY": "FULL", "OVERTIME_TIMEOUT": "99"})
    assert c.ready and c.privacy == "full" and c.timeout == 10.0
    assert c.share_url.endswith("/share")
    assert ho.Config.from_env({"OVERTIME_URL": URL, "OVERTIME_TOKEN": "t", "OVERTIME_PRIVACY": "everything"}).privacy == "metadata"
    assert not ho.Config.from_env({"OVERTIME_URL": "ftp://x", "OVERTIME_TOKEN": "t"}).ready


# ---------- envelopes and privacy ----------

def test_envelope_has_the_outbound_webhook_shape():
    e = ho.build_envelope("post_tool_call", {"tool_name": "write_file", "args": {"path": "a.py", "content": "SECRET BODY"}, "session_id": "s1", "task_id": "t", "tool_call_id": "c1", "status": "ok", "duration_ms": 12, "result": "ok"})
    assert set(e) == {"hook_event_name", "profile", "tool_name", "tool_input", "session_id", "extra", "timestamp"}
    assert e["tool_input"] == {"path": "a.py"}
    assert e["extra"]["tool_call_id"] == "c1" and e["extra"]["duration_ms"] == 12
    assert "result" not in e["extra"]
    assert "SECRET BODY" not in json.dumps(e)


def test_metadata_keeps_command_names_not_arguments():
    e = ho.build_envelope("post_tool_call", {"tool_name": "terminal", "args": {"command": "cd /srv && API_KEY=abc123456 python -m pytest -q && echo hunter2"}, "status": "ok"})
    assert e["tool_input"] == {"command": "python -m pytest && echo"}
    e = ho.build_envelope("pre_approval_request", {"command": "sudo rm -rf /", "description": "recursive delete", "pattern_key": "rm"})
    assert "command" not in e["extra"] and e["extra"]["description"] == "recursive delete"


def test_args_level_truncates_and_redacts():
    e = ho.build_envelope("post_tool_call", {"tool_name": "terminal", "args": {"command": "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx " + "x" * 1000, "token": "abc"}, "status": "ok"}, privacy="args")
    cmd = e["tool_input"]["command"]
    assert len(cmd) <= 300 and "sk-proj" not in cmd and "[redacted]" in cmd
    assert e["tool_input"]["token"] == "[redacted]"
    e = ho.build_envelope("post_tool_call", {"tool_name": "write_file", "args": {"path": "a", "content": "body"}}, privacy="args")
    assert e["tool_input"]["content"] == "[4 chars]"


def test_full_level_adds_messages_and_outputs_truncated():
    e = ho.build_envelope("post_llm_call", {"user_message": "u" * 5000, "assistant_response": "done", "conversation_history": ["huge"]}, privacy="full")
    assert len(e["extra"]["user_message"]) == 1000
    assert "conversation_history" not in e["extra"]
    assert "user_message" not in ho.build_envelope("post_llm_call", {"user_message": "u"}, privacy="args")["extra"]


def test_post_api_request_carries_tool_calls_and_usage_only():
    class Fn:
        name = "write_file"
        arguments = '{"path": "hello.py", "content": "print(1)"}'

    class Call:
        id = "call_1"
        function = Fn()

    class Msg:
        tool_calls = [Call()]
        content = "secret reasoning"

    e = ho.build_envelope("post_api_request", {"assistant_message": Msg(), "usage": {"input_tokens": 10, "output_tokens": 5, "note": "x"}, "response": {"big": "payload"}, "model": "m"})
    assert e["extra"]["tool_calls"] == [{"id": "call_1", "function": {"name": "write_file", "arguments": {"path": "hello.py"}}}]
    assert e["extra"]["usage"] == {"input_tokens": 10, "output_tokens": 5}
    assert "response" not in e["extra"] and "secret reasoning" not in json.dumps(e)


def test_todo_plans_survive_every_level():
    todos = [{"id": "1", "content": "Write the test", "status": "in_progress"}]
    for level in ho.PRIVACY_LEVELS:
        e = ho.build_envelope("post_tool_call", {"tool_name": "todo", "args": {"todos": todos}, "status": "ok"}, privacy=level)
        assert e["tool_input"]["todos"] == [{"id": "1", "content": "Write the test", "status": "in_progress"}], level


# ---------- batching and failure isolation ----------

def test_batches_up_to_the_limit():
    p, rec = make(batch_max=50, flush_s=0.2)
    cb = p.hook("post_tool_call")
    for i in range(120):
        cb(tool_name="read_file", args={"path": f"f{i}"}, status="ok", session_id="s")
    assert p.sender.flush(5)
    sizes = [len(c["batch"]) for c in rec.calls]
    assert sum(sizes) == 120 and max(sizes) <= 50 and len(sizes) >= 3
    assert rec.calls[0]["headers"]["Authorization"] == "Bearer ot_ing_testtoken"
    assert rec.calls[0]["url"] == URL
    assert p.sender.stats["sent"] == 120


def test_passes_the_timeout_to_every_post():
    p, rec = make(timeout=1.5)
    p.hook("on_session_start")(session_id="s", model="m")
    p.sender.flush(5)
    assert rec.calls[0]["timeout"] == 1.5


def test_hooks_never_wait_for_the_network():
    p, rec = make(rec=Recorder(delay=0.5), flush_s=0.01, batch_max=1)
    cb = p.hook("post_tool_call")
    t = time.perf_counter()
    for _ in range(50):
        cb(tool_name="terminal", args={"command": "ls"}, status="ok")
    assert time.perf_counter() - t < 0.25  # 50 hook calls while every POST takes 0.5 s


def test_failures_drop_events_and_open_the_circuit():
    p, rec = make(rec=Recorder(fail=True), flush_s=0.01, batch_max=1)
    cb = p.hook("post_tool_call")
    for _ in range(10):
        cb(tool_name="terminal", args={}, status="ok")
        time.sleep(0.02)
    p.sender.flush(5)
    assert len(rec.calls) == 3  # three failed POSTs, then 30 s of quiet
    assert p.sender.stats["dropped"] == 10
    assert p.sender.stats["last_error"] == "ConnectionError"


def test_http_errors_count_as_failures():
    p, rec = make(rec=Recorder(status=401))
    p.hook("on_session_start")(session_id="s")
    p.sender.flush(5)
    assert p.sender.stats["dropped"] == 1 and p.sender.stats["sent"] == 0


def test_full_queue_drops_instead_of_blocking():
    gate = threading.Event()

    def stuck(url, body, headers, timeout):
        gate.wait(5)
        return 200

    cfg = ho.Config(URL, "t", queue_max=5, flush_s=0.01, batch_max=1)
    p = ho.Plugin(cfg, ho.Sender(cfg, post=stuck))
    cb = p.hook("post_tool_call")
    t = time.perf_counter()
    for _ in range(30):
        cb(tool_name="x", args={}, status="ok")
    assert time.perf_counter() - t < 0.2
    assert p.sender.stats["dropped"] >= 20
    gate.set()


def test_sender_thread_survives_a_crashing_cost_estimate():
    rec = Recorder()
    cfg = ho.Config(URL, "t", flush_s=0.01)

    def boom(env):
        raise RuntimeError("pricing exploded")

    s = ho.Sender(cfg, post=rec, cost_fn=boom)
    p = ho.Plugin(cfg, s)
    p.hook("post_api_request")(usage={"input_tokens": 1}, model="m")
    p.hook("on_session_end")(session_id="s", completed=True)
    s.flush(5)
    assert sum(len(c["batch"]) for c in rec.calls) == 2
    assert all("_pricing" not in e["extra"] for c in rec.calls for e in c["batch"])


def test_cost_estimate_is_attached_off_the_hook_thread():
    rec = Recorder()
    cfg = ho.Config(URL, "t", flush_s=0.01)
    seen = []

    def cost(env):
        seen.append(threading.current_thread().name)
        return 0.0042

    p = ho.Plugin(cfg, ho.Sender(cfg, post=rec, cost_fn=cost))
    p.hook("post_api_request")(usage={"input_tokens": 1}, model="m")
    p.sender.flush(5)
    assert rec.calls[0]["batch"][0]["extra"]["cost_usd"] == 0.0042
    assert seen == ["hermes-overtime-sender"]


@pytest.mark.parametrize("cmd,head", [
    ("git push origin main", "git push"),
    ("npm run test -- --watch", "npm run test"),
    ("sudo systemctl restart api", "sudo systemctl restart"),
    ("python3 hello.py", "python3"),
    ("cd /x && docker compose up -d", "docker compose up"),
    ("echo secret-value", "echo"),
])
def test_command_head_matches_the_overtime_mapper(cmd, head):
    assert ho.command_head(cmd) == head
