import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace
import pytest
from signaltrace.investigate import main, save_new_json, load_bundle, checked_path
from signaltrace.investigation import investigate, replay_investigation
from signaltrace.meta_provider import ProviderResponse, ToolCall
from signaltrace.recordings import demo_recording


def saved_bundle():
    class Provider:
        provider_name = "scripted_test"
        model = "contract_mock"
        execution_mode = "mocked_test"
        def respond(self, **kwargs):
            return ProviderResponse("r1", (ToolCall("c1", "finish", dict(status="inconclusive", candidate=None,
                evidence_ids=[], narrative="No proposal in this mock test.", questions=[])),))
    recording = demo_recording("synthetic_control")
    return investigate(recording, channel="PPG", question="Preserve timing?", notes="", target="pulse_timing", start_s=0, end_s=30, provider=Provider())


def test_default_help_and_check_do_not_initialize_provider(monkeypatch, capsys):
    import signaltrace.investigate as module
    def forbidden(**kwargs):
        raise AssertionError("No network")
    monkeypatch.setattr(module, "MetaProvider", forbidden)
    assert main(["check"]) == 0
    assert "No network request" in capsys.readouterr().out
    with pytest.raises(SystemExit) as error:
        main([])
    assert error.value.code == 2


def test_cli_requires_live_consent_and_key(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY", raising=False)
    args = ["live", "--demo", "synthetic_control", "--target", "pulse_timing", "--question", "Timing?",
            "--start", "0", "--end", "30", "--output", str(tmp_path / "new.json")]
    for suffix, category in [([], "network_not_authorized"), (["--allow-network"], "missing_or_invalid_credential")]:
        with pytest.raises(SystemExit) as error:
            main(args + suffix)
        assert error.value.code == 2
        assert category in capsys.readouterr().err
    assert not (tmp_path / "new.json").exists()


@pytest.mark.parametrize("case", ["short", "all_missing", "flat", "fragmented"])
def test_unavailable_live_cli_rejects_before_provider_construction_and_key(tmp_path, monkeypatch, capsys, case):
    import numpy as np
    import signaltrace.investigate as module
    from signaltrace.availability import UNAVAILABLE_MESSAGE
    from signaltrace.recordings import Recording
    t = np.arange(3750) / 125
    x = np.sin(t)
    if case == "all_missing":
        x[:] = np.nan
    elif case == "flat":
        x[:] = .75
    elif case == "fragmented":
        x[::250] = np.nan
    source = Recording("local", "ppg", t, {"x": x}, "a.u.", {})
    monkeypatch.setattr(module, "demo_recording", lambda name: source)
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: pytest.fail("Unavailable CLI constructed a provider"))
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY", raising=False)
    output = tmp_path / "unavailable.json"
    with pytest.raises(SystemExit) as error:
        main(["live", "--demo", "synthetic_control", "--target", "pulse_timing", "--question", "Timing?",
              "--start", "0", "--end", "4" if case == "short" else "30", "--output", str(output)])
    assert error.value.code == 2
    captured = capsys.readouterr()
    assert UNAVAILABLE_MESSAGE in captured.err and "Starting Live" not in captured.out
    assert not output.exists()


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("failed_round", [1, 2])
def test_live_failure_reports_safe_structural_diagnostics(tmp_path, monkeypatch, capsys, history_mode, failed_round):
    import httpx
    import signaltrace.investigate as module
    from signaltrace.meta_provider import MetaProvider, MODEL
    calls = []
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-only-never-real")
    def handler(req):
        calls.append(json.loads(req.content))
        if len(calls) == failed_round:
            return httpx.Response(500, text="secret-server-body fake-only-never-real")
        return httpx.Response(200, json=dict(id="r1", model=MODEL, status="completed", output=[
            dict(type="function_call", call_id="c1", name="inspect", arguments='{"start_s":0,"end_s":30}')]))
    initialized = []
    def factory(**kwargs):
        initialized.append(kwargs)
        return MetaProvider(**kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(module, "MetaProvider", factory)
    destination = tmp_path / "failure.json"
    args = ["live", "--allow-network", "--demo", "synthetic_control", "--target", "pulse_timing",
            "--question", "Timing?", "--start", "0", "--end", "30", "--output", str(destination)]
    if history_mode == "stateless":
        args += ["--history-mode", history_mode]
    assert main(args) == 2
    assert initialized == [dict(allow_network=True, history_mode=history_mode, request_timeout_s=90.)]
    text = capsys.readouterr().out
    assert f"HTTP 500; round {failed_round}; {'initial' if failed_round == 1 else 'continuation'}; history mode {history_mode}" in text
    assert f"{failed_round - 1} observation(s)" in text
    assert "cause is unknown" in text and "No automatic retry" in text
    assert ("explicit stateless mode and its observed limits" in text) == (history_mode == "stored")
    assert ("Stop repeated identical runs" in text) == (history_mode == "stateless")
    assert "secret-server-body" not in text and "fake-only-never-real" not in text
    assert len(calls) == failed_round
    bundle = load_bundle(destination)
    assert bundle["identity"]["history_mode"] == history_mode
    assert bundle["error"] == dict(category="server", http_status=500)
    module.replay_investigation(bundle)


def test_unknown_history_mode_rejected_before_provider(tmp_path, monkeypatch):
    import signaltrace.investigate as module
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: pytest.fail("No provider"))
    with pytest.raises(SystemExit) as error:
        main(["live", "--demo", "synthetic_control", "--target", "pulse_timing", "--question", "Timing?",
              "--start", "0", "--end", "30", "--output", str(tmp_path / "new.json"), "--history-mode", "auto"])
    assert error.value.code == 2


@pytest.mark.parametrize("value", ["9", "181", "nan", "inf", "true", "bad"])
def test_invalid_cli_timeout_fails_before_provider(tmp_path, monkeypatch, value):
    import signaltrace.investigate as module
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: pytest.fail("No provider"))
    with pytest.raises(SystemExit) as error:
        main(["live", "--demo", "synthetic_control", "--target", "pulse_timing", "--question", "Timing?",
              "--start", "0", "--end", "30", "--output", str(tmp_path / "new.json"), "--request-timeout-seconds", value])
    assert error.value.code == 2


def test_cli_reports_local_finish_rejection_and_selected_timeout(tmp_path, monkeypatch, capsys):
    import httpx
    import signaltrace.investigate as module
    from signaltrace.meta_provider import MetaProvider, MODEL
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-only-never-real")
    calls = []
    def handler(req):
        calls.append(req)
        assert req.extensions["timeout"]["read"] == 120
        return httpx.Response(200, json=dict(id=f"r{len(calls)}", model=MODEL, status="completed", output=[
            dict(type="function_call", call_id=f"c{len(calls)}", name="finish", arguments=json.dumps(dict(
                status="inconclusive", candidate=None, evidence_ids=[], narrative="SENTINEL_PRIVATE"*100, questions=[])))]))
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: MetaProvider(**kwargs, transport=httpx.MockTransport(handler)))
    destination = tmp_path / "failure.json"
    assert main(["live", "--allow-network", "--history-mode", "stateless", "--demo", "synthetic_control",
        "--target", "pulse_timing", "--question", "Timing?", "--start", "0", "--end", "30",
        "--request-timeout-seconds", "120", "--output", str(destination)]) == 2
    output = capsys.readouterr().out
    assert "network-operation timeout 120s" in output
    assert "round_budget_exhausted" in output and "Local finish validation rejected" in output
    assert "finish_narrative_too_long" in output and "not a provider HTTP failure" in output
    assert "SENTINEL_PRIVATE" not in output + destination.read_text()
    assert len(calls) == 6
    replay_investigation(load_bundle(destination))


def test_export_new_only_and_replay_offline(tmp_path, monkeypatch, capsys):
    import signaltrace.investigate as module
    def forbidden(**kwargs):
        raise AssertionError("Replay cannot initialize provider")
    monkeypatch.setattr(module, "MetaProvider", forbidden)
    source, destination = tmp_path / "bundle.json", tmp_path / "replayed.json"
    save_new_json(saved_bundle(), source)
    original = source.read_bytes()
    with pytest.raises(FileExistsError):
        save_new_json({}, source)
    assert source.read_bytes() == original
    assert main(["replay", str(source), "--output", str(destination)]) == 0
    assert "Offline numerical replay" in capsys.readouterr().out
    assert json.loads(destination.read_text())["historical_conclusion"]["status"] == "inconclusive"
    with pytest.raises(SystemExit):
        main(["replay", str(source), "--output", str(destination)])


@pytest.mark.parametrize("name", [".env", ".env.private.json", "private_key.json", "credentials.json", ".env/okay.json", "okay/.env.child/out.json", r"\\credentials-server\share\okay.json"])
def test_secret_paths_rejected_before_filesystem_io(monkeypatch, name):
    def forbidden(*args, **kwargs):
        raise AssertionError("No filesystem access for secret-like names")
    monkeypatch.setattr(Path, "stat", forbidden)
    monkeypatch.setattr(Path, "lstat", forbidden)
    monkeypatch.setattr(Path, "is_symlink", forbidden)
    with pytest.raises(ValueError):
        load_bundle(name)
    with pytest.raises(ValueError):
        save_new_json({}, name)


@pytest.mark.parametrize("name", [
    "ordinary.json:stream.json", "ordinary.json::$DATA", "C:/ordinary.json:stream.json",
    r"\\?\C:\ordinary.json", r"\\.\C:\ordinary.json", r"\??\C:\ordinary.json",
    "//?/C:/ordinary.json", "//./C:/ordinary.json", "C:ordinary.json",
    "CON.json", "nul.JSON", "AUX/file.json", "PRN.json", "COM1.json", "lpt9.json",
    "COM¹.json", "LPT²/file.json", "CONIN$.json", "CONOUT$.json", "NUL .json",
    "folder./ordinary.json", "folder /ordinary.json",
])
def test_windows_streams_devices_and_aliases_rejected_before_filesystem_io(monkeypatch, name):
    def forbidden(*args, **kwargs):
        raise AssertionError("No filesystem lookup or open for unsafe path syntax")
    monkeypatch.setattr(Path, "stat", forbidden)
    monkeypatch.setattr(Path, "lstat", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    for operation in (load_bundle, lambda path: save_new_json({}, path)):
        with pytest.raises(ValueError):
            operation(name)


def test_alternate_stream_cannot_read_or_write_on_existing_file(tmp_path):
    ordinary = tmp_path / "ordinary.json"
    ordinary.write_text('{"ordinary": true}')
    stream = str(ordinary) + ":stream.json"
    with pytest.raises(ValueError):
        save_new_json({"stream": True}, stream)
    with pytest.raises(ValueError):
        load_bundle(stream)
    assert ordinary.read_text() == '{"ordinary": true}'


@pytest.mark.parametrize("location", ["file", "ancestor"])
@pytest.mark.parametrize("kind", ["reparse", "symlink"])
def test_nonfollowing_metadata_rejects_links_without_symlink_privileges(tmp_path, monkeypatch, location, kind):
    folder = tmp_path / "folder"
    folder.mkdir()
    source = folder / "bundle.json"
    source.write_text("{}")
    blocked = source if location == "file" else folder
    original_lstat = Path.lstat
    looked_up = []
    def metadata(path, *args, **kwargs):
        looked_up.append(path)
        if path == blocked:
            return SimpleNamespace(st_mode=stat.S_IFLNK if kind == "symlink" else stat.S_IFREG,
                                   st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT if kind == "reparse" else 0)
        return original_lstat(path, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError("Link must be rejected before opening")
    monkeypatch.setattr(Path, "lstat", metadata)
    monkeypatch.setattr(Path, "open", forbidden)
    for operation in (load_bundle, lambda path: save_new_json({}, path)):
        looked_up.clear()
        with pytest.raises(ValueError, match="links"):
            operation(source)
        assert looked_up[-1] == blocked


def test_ordinary_absolute_relative_and_drive_paths_remain_supported(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert checked_path("ordinary.json") == tmp_path / "ordinary.json"
    assert checked_path(tmp_path / "ordinary.json") == tmp_path / "ordinary.json"
    if os.name == "nt":
        assert checked_path(str(tmp_path / "ordinary.json").replace("\\", "/")) == tmp_path / "ordinary.json"
    save_new_json({"ordinary": True}, "ordinary.json")
    assert load_bundle("ordinary.json") == {"ordinary": True}


def test_links_and_oversized_inputs_rejected(tmp_path):
    source = tmp_path / "bundle.json"
    source.write_text("{}")
    link = tmp_path / "link.json"
    try:
        link.symlink_to(source)
    except OSError:
        pytest.skip("Creating symlinks unavailable in this Windows account")
    with pytest.raises(ValueError, match="links"):
        load_bundle(link)
    with pytest.raises(ValueError, match="links"):
        save_new_json({}, link)


def test_duplicate_nonfinite_and_tampered_json_rejected(tmp_path):
    source = tmp_path / "bundle.json"
    for body in ('{"x":1,"x":2}', '{"x": NaN}'):
        source.write_text(body)
        with pytest.raises(ValueError):
            load_bundle(source)
    source.write_text('{}')
    with pytest.raises(SystemExit) as error:
        main(["replay", str(source), "--output", str(tmp_path / "new.json")])
    assert error.value.code == 2


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("status,details,code", [
    ("incomplete", {"reason": "max_output_tokens"}, "incomplete_max_output_tokens"),
    ("incomplete", {"reason": "PRIVATE_REASON"}, "incomplete_other"),
    ("failed", None, "failed_response"),
])
def test_cli_http200_response_validation_diagnostics_are_fixed_safe_and_replayable(tmp_path, monkeypatch, capsys, history_mode, status, details, code):
    import httpx
    import signaltrace.investigate as module
    from signaltrace.meta_provider import MetaProvider, MODEL
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-only-never-real")
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=dict(id="r1", status=status, model=MODEL,
            incomplete_details=details, error={"message": "PRIVATE_SERVER_ERROR"},
            output=[dict(type="message", role="assistant", content=[dict(type="output_text", text="PRIVATE_TEXT")])]))
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: MetaProvider(**kwargs, transport=httpx.MockTransport(handler)))
    destination = tmp_path / "failure.json"
    assert main(["live", "--allow-network", "--history-mode", history_mode, "--demo", "synthetic_control",
        "--target", "pulse_timing", "--question", "Timing?", "--start", "0", "--end", "30", "--output", str(destination)]) == 2
    output = capsys.readouterr().out
    assert f"HTTP 200; round 1; initial; history mode {history_mode}" in output
    assert f"Provider response validation: {code}." in output
    assert "no automatic retry or token-limit change occurred" in output
    assert "PRIVATE_" not in output + destination.read_text() and len(seen) == 1
    bundle = load_bundle(destination)
    assert bundle["error"] == dict(category="invalid_response", http_status=200, response_code=code)
    replay_investigation(bundle)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_cli_explains_exhaustion_after_normal_text_without_leaking_it(tmp_path, monkeypatch, capsys, history_mode):
    import httpx
    import signaltrace.investigate as module
    from signaltrace.meta_provider import MetaProvider, MODEL
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-only-never-real")
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=dict(id=f"r{len(seen)}", status="completed", model=MODEL,
            output=[dict(type="message", role="assistant", phase=None, content=[dict(type="output_text", text="PRIVATE_TEXT")])]))
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: MetaProvider(**kwargs, transport=httpx.MockTransport(handler)))
    destination = tmp_path / "failure.json"
    assert main(["live", "--allow-network", "--history-mode", history_mode, "--demo", "synthetic_control",
        "--target", "pulse_timing", "--question", "Timing?", "--start", "0", "--end", "30", "--output", str(destination)]) == 2
    output = capsys.readouterr().out
    assert "normal text reply was received" in output and "required finish tool was not produced" in output
    assert "PRIVATE_" not in output + destination.read_text() and len(seen) == 6
    replay_investigation(load_bundle(destination))
