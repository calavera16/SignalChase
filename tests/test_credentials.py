"""Fake canaries only; no external requests and no credential-file access."""
import json
from threading import Event
import httpx
import pytest
from fastapi.testclient import TestClient
from signaltrace import server, investigation_jobs as jobs_module
from signaltrace.credentials import Credentials
from signaltrace.explanation_jobs import ExplanationJobs
from signaltrace.investigation_jobs import InvestigationJobs
from signaltrace.local_store import LocalStore
from signaltrace.meta_provider import MetaProvider, ProviderError, ENDPOINT, MODEL

CANARY = "FAKE_SIGNALTRACE_CREDENTIAL_CANARY_ONLY_491"
SECOND = "FAKE_REPLACEMENT_CANARY_ONLY_492"
HEADERS = {"Origin": "http://localhost", "x-signaltrace-request": "1", "Content-Type": "application/json"}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", CANARY)
    monkeypatch.setattr(server, "credentials", Credentials())
    monkeypatch.setattr(server, "investigation_jobs", InvestigationJobs(storage=LocalStore(tmp_path / "store")))
    monkeypatch.setattr(server, "explanation_jobs", ExplanationJobs())
    monkeypatch.setattr(httpx, "HTTPTransport", lambda **kw: pytest.fail("Unexpected real network transport"))
    with TestClient(server.app, base_url="http://localhost") as client:
        yield client


def put(client, value=SECOND, headers=HEADERS):
    return client.put("/api/credentials/meta", json={"api_key": value}, headers=headers)


def test_memory_entry_status_clear_disables_fallback_no_network(client, monkeypatch, caplog, capsys, tmp_path):
    assert client.get("/api/credentials/meta").json() == {"configured": True, "source": "environment"}
    response = put(client)
    assert response.json() == {"configured": True, "source": "browser"}
    assert server.credentials.snapshot() == SECOND
    assert client.get("/api/investigations/config").json()["key_configured"] is True
    response = client.request("DELETE", "/api/credentials/meta", json={}, headers=HEADERS)
    assert response.json() == {"configured": False, "source": "none"}
    assert server.credentials.snapshot() is None
    assert client.get("/api/explanations/config").json()["key_configured"] is False
    assert CANARY not in response.text and SECOND not in response.text
    assert not server.investigation_jobs.list() and not server.explanation_jobs.list()
    assert not list(tmp_path.rglob("*.json"))
    output = capsys.readouterr()
    assert CANARY not in caplog.text + output.out + output.err
    assert SECOND not in caplog.text + output.out + output.err
    # Clearing did not mutate the CLI environment. A fresh server can use it.
    assert Credentials().status() == {"configured": True, "source": "environment"}


@pytest.mark.parametrize("value", [None, 12, True, [], {}, [CANARY], "", " " + CANARY, CANARY + "\n", "x" * 4097, "\u0080"])
def test_invalid_keys_are_fixed_errors_without_reflected_inputs(client, value, caplog):
    response = put(client, value)
    assert response.status_code == 422
    assert CANARY not in response.text and CANARY not in caplog.text
    assert "input" not in response.json()
    assert server.credentials.status()["source"] == "environment"


@pytest.mark.parametrize("body,status", [
    ('{"api_key":"' + CANARY + '","api_key":"x"}', 422),
    ('{"api_key":"' + CANARY + '","extra":true}', 422),
    ('{"api_key":"' + CANARY, 422),
    ('["' + CANARY + '"]', 422),
    (b'\xff', 422), ('x' * 8193, 413), ('{"api_key":NaN}', 422),
])
def test_malformed_bounded_bodies_never_echo(client, body, status, caplog):
    response = client.put("/api/credentials/meta", content=body, headers=HEADERS)
    assert response.status_code == status
    assert CANARY not in response.text + caplog.text


@pytest.mark.parametrize("headers,status", [({}, 403),
    ({**HEADERS, "Origin": "http://evil.invalid"}, 403),
    ({**HEADERS, "Origin": "null"}, 403),
    ({**HEADERS, "Origin": "http://localhost:81"}, 403),
    ({**HEADERS, "Host": "evil.invalid"}, 403),
    ({**HEADERS, "Host": "localhost.evil.invalid"}, 403),
    ({**HEADERS, "Host": "localhost:"}, 403),
    ({**HEADERS, "Content-Type": "text/plain"}, 415),
    ({**HEADERS, "sec-fetch-site": "cross-site"}, 403),
    ({**HEADERS, "x-signaltrace-request": "no"}, 403)])
def test_cross_origin_and_dns_rebinding_controls(client, headers, status):
    assert put(client, headers=headers).status_code == status


def test_duplicate_headers_remote_peer_and_security_headers(client):
    response = client.put("/api/credentials/meta", json={"api_key": SECOND},
        headers=[*HEADERS.items(), ("Origin", "http://evil.invalid")])
    assert response.status_code == 400
    with TestClient(server.app, base_url="http://localhost", client=("192.0.2.10", 123)) as remote:
        assert remote.get("/api/credentials/meta").status_code == 403
    for path in ("/", "/api/credentials/meta", "/api/investigations/config", "/api/explanations/config"):
        response = client.get(path)
        assert response.headers["cache-control"] == "no-store"
        assert "script-src 'self'" in response.headers["content-security-policy"]
        assert response.headers["x-frame-options"] == "DENY"
    assert client.get("/api/credentials/meta?api_key=FAKE_QUERY").status_code == 400


def test_running_jobs_reject_mutation(client, monkeypatch):
    monkeypatch.setattr(server.explanation_jobs, "running", lambda: True)
    assert put(client).status_code == 409
    assert client.request("DELETE", "/api/credentials/meta", json={}, headers=HEADERS).status_code == 409
    assert server.credentials.snapshot() == CANARY


def test_invalid_value_and_unhandled_errors_do_not_leak(client, monkeypatch, caplog):
    def fail(*args, **kw):
        raise ValueError(CANARY)
    monkeypatch.setattr(server, "demo_recording", fail)
    response = client.post("/api/demo", json={"demo_id": "synthetic_control"})
    assert response.status_code == 422 and CANARY not in response.text
    def crash(*args, **kw):
        raise RuntimeError(CANARY)
    monkeypatch.setattr(server, "demo_recording", crash)
    response = client.post("/api/demo", json={"demo_id": "synthetic_control"})
    assert response.status_code == 500 and CANARY not in response.text + caplog.text


def test_provider_snapshot_redirect_exception_and_response_echo(monkeypatch, caplog):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", SECOND)
    seen = []
    def redirect(request):
        seen.append(str(request.url))
        assert request.headers["authorization"] == "Bearer " + CANARY
        return httpx.Response(307, headers={"location": "https://evil.invalid/" + CANARY})
    p = MetaProvider(allow_network=True, api_key=CANARY, transport=httpx.MockTransport(redirect))
    with pytest.raises(ProviderError, match="redirect_rejected") as caught:
        p.respond(instructions="fixed", context={}, tools=[])
    assert CANARY not in str(caught.value) + repr(caught.value) + caplog.text
    assert seen == [ENDPOINT]
    def echo(request):
        return httpx.Response(200, json={"id": "r1", "status": "completed", "model": MODEL,
            "output": [{"type": "function_call", "call_id": "c1", "name": "inspect", "arguments": json.dumps({"x": CANARY})}]})
    p = MetaProvider(allow_network=True, api_key=CANARY, transport=httpx.MockTransport(echo))
    with pytest.raises(ProviderError, match="invalid_response"):
        p.respond(instructions="fixed", context={}, tools=[])
    def crash(request):
        raise RuntimeError(CANARY)
    p = MetaProvider(allow_network=True, api_key=CANARY, transport=httpx.MockTransport(crash))
    with pytest.raises(ProviderError, match="transport") as caught:
        p.respond(instructions="fixed", context={}, tools=[])
    assert CANARY not in str(caught.value) + caplog.text


def test_job_key_is_frozen_not_in_snapshot_persistence_or_exports(client, monkeypatch, tmp_path, caplog):
    from test_investigation_jobs import MockProvider, terminal
    gate = Event()
    observed = []
    def factory(**options):
        observed.append(options["api_key"])
        return MockProvider(gate=gate)
    monkeypatch.setattr(jobs_module, "MetaProvider", factory)
    put(client)
    record = client.post("/api/demo", json={"demo_id": "synthetic_control"}).json()["recording"]
    experiment = client.post("/api/experiments", json={"recording_id": record["id"], "protocol": {
        "name": "Fake-key security check", "research_question": "Preserve timing?", "task": "ppg_preprocessing",
        "target": "pulse_timing", "evaluation": "synthetic_reference", "processing_mode": "offline", "notes": ""}}).json()
    body = dict(request_id="credential-check", experiment_id=experiment["id"], recording_id=record["id"],
        channel=record["channels"][0]["name"], start_s=0., end_s=30., question="Preserve timing?", notes="", allow_network=True)
    response = client.post("/api/investigations", json=body)
    assert response.status_code == 202
    try:
        assert put(client, CANARY).status_code == 409
        monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_CHANGED_AFTER_ADMISSION")
    finally:
        gate.set()
    job = terminal(client, response.json()["id"])
    assert job["status"] == "completed"
    assert observed == [SECOND]
    exported = client.get(f"/api/investigations/{job['id']}/export").text
    data = json.dumps(job) + exported + caplog.text
    for path in tmp_path.rglob("*.json"):
        data += path.read_text()
    assert CANARY not in data and SECOND not in data
    assert put(client, CANARY).status_code == 200


def test_explanation_admission_freezes_key_and_keeps_artifact_private(client, monkeypatch, tmp_path, caplog):
    from signaltrace import explanation_jobs as explanation_module
    from signaltrace.investigation import investigate
    from signaltrace.recordings import demo_recording
    from test_explanation import InvestigationProvider, ExplanationProvider, wait_job
    recording = demo_recording("synthetic_drift_noise")
    bundle = investigate(recording, channel=next(iter(recording.channels)), question="Timing sensitivity?",
        notes="", target="pulse_timing", start_s=0., end_s=30., provider=InvestigationProvider())
    investigation = server.investigation_jobs.import_bundle("security-explanation-source", bundle)
    monkeypatch.setattr(server, "explanation_jobs", ExplanationJobs(LocalStore(tmp_path / "explanation")))
    gate, observed = Event(), []
    def factory(**options):
        observed.append(options["api_key"])
        return ExplanationProvider(gate=gate)
    monkeypatch.setattr(explanation_module, "MetaProvider", factory)
    put(client)
    body = dict(request_id="security-explanation", investigation_id=investigation["id"],
        evidence_digest=investigation["evidence_digest"], allow_network=True)
    no_consent = client.post("/api/explanations", json={**body, "allow_network": False})
    assert no_consent.status_code == 422 and not observed
    response = client.post("/api/explanations", json=body)
    assert response.status_code == 202
    try:
        assert client.request("DELETE", "/api/credentials/meta", json={}, headers=HEADERS).status_code == 409
        monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_CHANGED_EXPLANATION_ENV")
    finally:
        gate.set()
    job = wait_job(server.explanation_jobs, response.json()["id"])
    assert job["status"] == "completed" and observed == [SECOND]
    data = client.get(f"/api/explanations/{job['id']}/export").text + json.dumps(job) + caplog.text
    for path in tmp_path.rglob("*.json"):
        data += path.read_text()
    assert CANARY not in data and SECOND not in data


def test_catalog_default_is_synthetic_and_missing_actual_data_is_not_advertised(client, monkeypatch):
    from pathlib import Path
    original = Path.is_file
    monkeypatch.setattr(Path, "is_file", lambda path: False if path.name == "bidmc_01_Signals.csv" else original(path))
    catalog = client.get("/api/catalog").json()
    assert catalog["demos"][0]["id"] == "synthetic_control"
    assert all(demo["id"].startswith("synthetic_") for demo in catalog["demos"])
    assert client.post("/api/demo", json={"demo_id": catalog["demos"][0]["id"]}).status_code == 200
