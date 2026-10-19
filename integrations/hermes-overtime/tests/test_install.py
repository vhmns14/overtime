"""install.sh against a local fake Overtime: private files, idempotency, checksum verification, and
the token never on curl's command line."""

import hashlib
import http.server
import json
import os
import shutil
import stat
import subprocess
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
OFFICE = "of-abc12345"
TOKEN = "ot_ing_installtoken_aaaaaaaaaaaaaaaa"
FILES = ["plugin.yaml", "__init__.py", "overtime_control.py"]

pytestmark = pytest.mark.skipif(shutil.which("curl") is None or shutil.which("sh") is None, reason="needs sh and curl")


class Fake(http.server.BaseHTTPRequestHandler):
    sums_override = None
    posts = []

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/plain"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        p = self.path
        if p.startswith("/hermes-overtime/"):
            name = p.rsplit("/", 1)[1]
            if name == "SHA256SUMS":
                body = Fake.sums_override or "".join(f"{hashlib.sha256((ROOT / f).read_bytes()).hexdigest()}  {f}\n" for f in FILES)
                return self._send(200, body)
            if name in FILES:
                return self._send(200, (ROOT / name).read_bytes())
        if p == f"/api/ext/runs/{OFFICE}/share":
            ok = self.headers.get("authorization") == f"Bearer {TOKEN}"
            return self._send(200 if ok else 401, json.dumps({"watch": "http://x/watch/" + OFFICE + "#v=ot_view_x"} if ok else {}), "application/json")
        self._send(404, "")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        Fake.posts.append((self.path, self.headers.get("authorization"), self.rfile.read(n)))
        self._send(200, '{"accepted":2}', "application/json")


@pytest.fixture()
def server(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    Fake.sums_override = None
    Fake.posts = []
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def run(origin, home, *extra, token=TOKEN, env_token=False, path_prefix=None):
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env.update({"HOME": str(home), "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1"})
    if path_prefix:
        env["PATH"] = f"{path_prefix}:{env['PATH']}"
    args = ["sh", str(ROOT / "install.sh"), "--url", f"{origin}/api/ext/runs/{OFFICE}/hermes", "--no-enable", "--hermes-home", str(home / ".hermes"), *extra]
    if env_token:
        env["OVERTIME_TOKEN"] = token
    else:
        args += ["--token", token]
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)


def test_installs_privately_and_idempotently(server, tmp_path):
    hh = tmp_path / ".hermes"
    hh.mkdir()
    (hh / ".env").write_text("API_SERVER_KEY=keep-me\nOVERTIME_TOKEN=old\n")
    os.chmod(hh / ".env", 0o644)
    for _ in range(2):
        r = run(server, tmp_path)
        assert r.returncode == 0, r.stderr
    env = (hh / ".env").read_text()
    assert env.count("OVERTIME_TOKEN=") == 1 and f"OVERTIME_TOKEN={TOKEN}" in env and "API_SERVER_KEY=keep-me" in env
    assert stat.S_IMODE(os.stat(hh / ".env").st_mode) == 0o600
    plug = hh / "plugins" / "hermes-overtime"
    for f in FILES:
        assert (plug / f).read_bytes() == (ROOT / f).read_bytes()
        assert stat.S_IMODE(os.stat(plug / f).st_mode) & 0o077 == 0  # umask 077
    assert not list(hh.glob("*.tmp")) and not list(plug.glob("*.tmp"))
    assert any(p[0].endswith("/hermes") and p[1] == f"Bearer {TOKEN}" for p in Fake.posts)
    assert "watch it here" in r.stdout


def test_checksum_mismatch_aborts_before_installing(server, tmp_path):
    Fake.sums_override = "0" * 64 + "  __init__.py\n"
    r = run(server, tmp_path)
    assert r.returncode != 0 and "checksum mismatch for __init__.py" in r.stderr
    assert not (tmp_path / ".hermes" / "plugins" / "hermes-overtime" / "__init__.py").exists()


def test_token_from_environment_and_never_in_curl_argv(server, tmp_path):
    shim = tmp_path / "bin"
    shim.mkdir()
    log = tmp_path / "argv.log"
    real = shutil.which("curl")
    (shim / "curl").write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\nexec "{real}" "$@"\n')
    os.chmod(shim / "curl", 0o755)
    r = run(server, tmp_path, env_token=True, path_prefix=str(shim))
    assert r.returncode == 0, r.stderr
    assert TOKEN not in log.read_text()
    assert any(p[1] == f"Bearer {TOKEN}" for p in Fake.posts)


def test_rejects_malformed_values_before_touching_anything(server, tmp_path):
    r = run(server, tmp_path, token="ot_ing_x\nOVERTIME_REMOTE_TASKS=1")
    assert r.returncode != 0
    assert not (tmp_path / ".hermes" / ".env").exists()


def test_warns_about_plain_http_to_a_public_host():
    src = (ROOT / "install.sh").read_text()
    assert "plain http; the ingest token travels unencrypted" in src
    assert "umask 077" in src and "sudo" not in src.split("\n", 20)[-1]
