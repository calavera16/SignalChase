"""Mocked browser admission, concurrency, secret boundaries and replay tests."""
import json
import time
import numpy as np
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import pytest
from fastapi.testclient import TestClient
from signaltrace import server
from signaltrace import investigation_jobs as jobs_module
from signaltrace.investigation import replay_investigation
from signaltrace.investigation_jobs import InvestigationJobs
from signaltrace.meta_provider import MODEL, ProviderError, ProviderResponse, ToolCall
from signaltrace.recordings import Recording


class MockProvider:
    provider_name, model, execution_mode, history_mode = "meta", MODEL, "mocked_test", "stateless"
    def __init__(self, *, gate=None, fail=False):
        self.round = 0
        self.gate, self.fail = gate, fail

    def respond(self, **request):
        self.round += 1
        if self.gate is not None:
            assert self.gate.wait(5), "Test did not release mock worker"
        if self.round == 1:
            name, arguments = "inspect", dict(start_s=0., end_s=30.)
        elif self.round == 2:
            name, arguments = "compare", dict(start_s=0., end_s=30.,
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.))
        elif self.fail:
            raise RuntimeError("FAKE_TEST_SENTINEL_PRIVATE_KEY private response body")
        else:
            name, arguments = "finish", dict(status="candidate", candidate=dict(comparison_id="e2", method="median"),
                evidence_ids=["e1", "e2"], narrative="Researcher review only; accuracy is unverified.", questions=[])
        return ProviderResponse(f"r{self.round}", (ToolCall(f"c{self.round}", name, arguments),))


@pytest.fixture
def workspace(monkeypatch):
    server.recordings.clear()
    server.experiments.clear()
    store = InvestigationJobs()
    monkeypatch.setattr(server, "investigation_jobs", store)
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_SENTINEL_PRIVATE_KEY")
    constructions = []
    def factory(**options):
        constructions.append(options)
        return MockProvider()
    monkeypatch.setattr(jobs_module, "MetaProvider", factory)
    with TestClient(server.app, base_url="http://localhost") as client:
        recording = client.post("/api/demo", json=dict(demo_id="synthetic_drift_noise")).json()["recording"]
        experiment = client.post("/api/experiments", json=dict(recording_id=recording["id"], protocol=dict(
            name="Immutable investigation scope", research_question="Preserve timing?", task="ppg_preprocessing",
            target="pulse_timing", evaluation="synthetic_reference", processing_mode="offline", notes=""))).json()
        body = dict(request_id="browser-request-1", experiment_id=experiment["id"], recording_id=recording["id"],
                    channel=recording["channels"][0]["name"], start_s=0., end_s=30., question="Preserve timing?",
                    notes="Acquisition is unknown.", allow_network=True)
        yield client, body, store, constructions


def terminal(client, identifier):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(f"/api/investigations/{identifier}")
        assert response.status_code == 200
        if response.json()["status"] != "running":
            return response.json()
        time.sleep(.01)
    pytest.fail("Mocked investigation did not finish")


def test_config_and_missing_key_never_construct_provider(workspace, monkeypatch):
    client, body, store, constructions = workspace
    config = client.get("/api/investigations/config").json()
    assert config == dict(available=True, key_configured=True, model=MODEL, history_mode="stateless", max_rounds=6, max_tool_attempts=8)
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY")
    assert client.get("/api/investigations/config").json()["key_configured"] is False
    response = client.post("/api/investigations", json=body)
    assert response.status_code == 503 and "server process environment" in response.text
    assert not constructions and not store.list(body["experiment_id"])


def test_comparison_route_is_detached_bound_read_only_and_private(workspace, monkeypatch):
    client, body, store, constructions = workspace
    assert client.get("/api/investigations/missing/comparisons/e2").status_code == 404
    gate = Event()
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: MockProvider(gate=gate))
    identifier = client.post("/api/investigations", json=body).json()["id"]
    path = f"/api/investigations/{identifier}/comparisons/e2"
    assert client.get(path).status_code == 409
    gate.set()
    job = terminal(client, identifier)
    assert client.get(path, headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert client.post(path).status_code == 405
    assert client.get(f"/api/investigations/{identifier}/comparisons/e1").status_code == 404
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: pytest.fail("Read constructed a provider"))
    response = client.get(path)
    assert response.status_code == 200
    payload = response.json()
    assert payload["investigation_id"] == identifier and payload["comparison_id"] == "e2"
    for key in ("recording_id", "experiment_id", "channel", "target"):
        assert payload[key] == job["request"][key]
    assert payload["result"] == store.export(identifier)["comparisons"]["e2"]["result"]
    detached = store.comparison(identifier, "e2")
    detached["result"]["plot"]["raw"][0] = 999999
    assert store.comparison(identifier, "e2")["result"]["plot"]["raw"][0] != 999999
    assert not any(key in payload for key in ("recipe", "private_history", "request"))
    assert "FAKE_TEST_SENTINEL_PRIVATE_KEY" not in response.text


@pytest.mark.parametrize("changes,status", [
    ({"allow_network": False}, 422), ({"allow_network": 1}, 422), ({"allow_network": "true"}, 422),
    ({"allow_network": None}, 422), ({"question": "  "}, 422), ({"question": "q" * 501}, 422),
    ({"notes": "x\x00"}, 422), ({"channel": "missing"}, 422), ({"start_s": -1.}, 422),
    ({"end_s": 121.}, 422), ({"end_s": .008}, 422), ({"end_s": 0.}, 422),
    ({"recording_id": "other"}, 409), ({"experiment_id": "missing"}, 404),
    ({"request_id": "../../secret"}, 422), ({"model": "arbitrary"}, 422),
    ({"raw": [1, 2, 3]}, 422), ({"path": "FAKE_TEST_SENTINEL_PRIVATE_KEY"}, 422),
])
def test_invalid_scope_and_consent_precede_provider(workspace, changes, status):
    client, body, store, constructions = workspace
    response = client.post("/api/investigations", json={**body, **changes})
    assert response.status_code == status
    assert "FAKE_TEST_SENTINEL_PRIVATE_KEY" not in response.text
    assert not constructions and not store.list(body["experiment_id"])


def test_all_investigation_routes_enforce_same_origin_loopback(workspace):
    client, body, _, constructions = workspace
    for route in ("/api/investigations/config", "/api/investigations?experiment_id=x", "/api/investigations/x", "/api/investigations/x/export"):
        assert client.get(route, headers={"Origin": "https://evil.invalid"}).status_code == 403
        assert client.get(route, headers={"Host": "evil.invalid"}).status_code == 403
    assert client.post("/api/investigations", json=body, headers={"Origin": "http://localhost:9999"}).status_code == 403
    assert client.options("/api/investigations", headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert client.post("/api/investigations", json=body, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert not constructions


@pytest.mark.parametrize("failed", [False, True])
def test_result_export_replay_original_comparator_and_secret_safety(workspace, monkeypatch, failed, capsys, caplog):
    client, body, store, _ = workspace
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: MockProvider(fail=failed))
    response = client.post("/api/investigations", json=body)
    assert response.status_code == 202
    identifier = response.json()["id"]
    result = terminal(client, identifier)
    assert result["status"] == ("failed" if failed else "completed")
    assert result["request"] == {**{key: value for key, value in body.items() if key != "allow_network"}, "target": "pulse_timing"}
    assert "comparisons" not in result["result"]
    assert result["result"]["context"]["evaluation"] == "original_sensitivity"
    assert result["result"]["evidence"]["e2"]["evaluation"] == "original_sensitivity"
    export = client.get(f"/api/investigations/{identifier}/export")
    assert export.status_code == 200 and export.headers["content-disposition"] == 'attachment; filename="signaltrace-investigation.json"'
    bundle = export.json()
    assert bundle["comparisons"]["e2"]["recipe"]["reference"] is None
    assert replay_investigation(bundle)["comparisons"]["e2"]["metrics"] == bundle["comparisons"]["e2"]["result"]["metrics"]
    assert result["error"] == (dict(category="provider_failure", http_status=None) if failed else None)
    listed = client.get("/api/investigations", params={"experiment_id": body["experiment_id"]}).json()
    assert listed == dict(jobs=[result])
    captured = capsys.readouterr()
    assert "FAKE_TEST_SENTINEL_PRIVATE_KEY" not in json.dumps([result, bundle, listed]) + caplog.text + captured.out + captured.err
    result["result"]["evidence"].clear()
    bundle["comparisons"].clear()
    assert store.get(identifier)["result"]["evidence"] and store.export(identifier)["comparisons"]


def test_atomic_admission_idempotency_and_source_eviction(workspace, monkeypatch):
    client, body, store, _ = workspace
    gate = Event()
    constructions = []
    def factory(**options):
        constructions.append(options)
        return MockProvider(gate=gate)
    monkeypatch.setattr(jobs_module, "MetaProvider", factory)
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda _: client.post("/api/investigations", json=body), range(4)))
        assert all(response.status_code == 202 for response in responses)
        assert len({r.json()["id"] for r in responses}) == 1
        identifier = responses[0].json()["id"]
        assert client.post("/api/investigations", json={**body, "question": "Changed?"}).status_code == 409
        assert client.post("/api/investigations", json={**body, "request_id": "other-request"}).status_code == 409
        assert client.get(f"/api/investigations/{identifier}/export").status_code == 409
        server.recordings.clear()
        server.experiments.clear()
        # Idempotent reattachment does not depend on an experiment surviving bounded eviction.
        assert client.post("/api/investigations", json=body).json()["id"] == identifier
        assert client.get("/api/investigations", params={"experiment_id": body["experiment_id"]}).status_code == 404
    finally:
        gate.set()
    assert terminal(client, identifier)["status"] == "completed"
    assert len(constructions) == 1
    assert constructions[0] == dict(allow_network=True, history_mode="stateless", request_timeout_s=90, api_key="FAKE_TEST_SENTINEL_PRIVATE_KEY")
    replay_investigation(store.export(identifier))


@pytest.mark.parametrize("case", ["short", "all_missing", "flat", "fragmented"])
def test_unavailable_http_and_direct_admission_require_no_key_provider_or_eviction(workspace, monkeypatch, case):
    from signaltrace.availability import AvailabilityError, UNAVAILABLE_MESSAGE
    client, body, store, constructions = workspace
    # Fill the bounded store first: a rejected request must preserve every completed job/bundle.
    for index in range(4):
        response = client.post("/api/investigations", json={**body, "request_id": f"retained-{index}"})
        assert response.status_code == 202
        assert terminal(client, response.json()["id"])["status"] == "completed"
    retained = store.list(body["experiment_id"])
    exports = {job["id"]: store.export(job["id"]) for job in retained}
    constructions.clear()
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY")
    t = np.arange(3750) / 125
    x = np.sin(t)
    if case == "all_missing":
        x[:] = np.nan
    elif case == "flat":
        x[:] = .75
    elif case == "fragmented":
        x[::250] = np.nan
    source = Recording("local", "ppg", t, {body["channel"]: x}, "a.u.", {})
    server.experiments[body["experiment_id"]]["recording"] = source
    request = {**body, "request_id": "unavailable", "end_s": 4. if case == "short" else 30.}
    response = client.post("/api/investigations", json=request)
    assert response.status_code == 422 and response.json() == dict(detail=UNAVAILABLE_MESSAGE)
    assert not constructions and store.list(body["experiment_id"]) == retained
    assert {job["id"]: store.export(job["id"]) for job in retained} == exports
    direct = {key: value for key, value in request.items() if key != "allow_network"}
    direct["target"] = "pulse_timing"
    with pytest.raises(AvailabilityError):
        store.submit(direct, source)
    assert not constructions and store.list(body["experiment_id"]) == retained
    # An existing request is an idempotent lookup even after its source becomes unavailable.
    assert client.post("/api/investigations", json={**body, "request_id": "retained-3"}).json() == retained[0]


def test_unavailable_direct_admission_does_not_create_a_job_or_thread(workspace, monkeypatch):
    from signaltrace.availability import AvailabilityError
    client, body, store, constructions = workspace
    monkeypatch.setattr(jobs_module, "Thread", lambda **kwargs: pytest.fail("Unavailable input created a worker"))
    source = server.experiments[body["experiment_id"]]["recording"]
    request = {key: value for key, value in body.items() if key != "allow_network"}
    request.update(target="pulse_timing", end_s=4.)
    with pytest.raises(AvailabilityError):
        store.submit(request, source)
    assert not store.list(body["experiment_id"]) and not constructions


def test_four_retained_jobs_newest_first_and_old_export_eviction(workspace):
    client, body, store, _ = workspace
    identifiers = []
    for index in range(5):
        response = client.post("/api/investigations", json={**body, "request_id": f"run-{index}"})
        assert response.status_code == 202
        identifier = response.json()["id"]
        assert terminal(client, identifier)["status"] == "completed"
        identifiers.append(identifier)
    jobs = client.get("/api/investigations", params={"experiment_id": body["experiment_id"]}).json()["jobs"]
    assert [job["id"] for job in jobs] == identifiers[:0:-1]
    assert client.get(f"/api/investigations/{identifiers[0]}").status_code == 404
    assert client.get(f"/api/investigations/{identifiers[0]}/export").status_code == 404
    assert client.get("/api/investigations/nonexistent").status_code == 404


@pytest.mark.parametrize("modality,count", [("ecg", 3750), ("ppg", 30001)])
def test_modality_and_sample_limit_preflight_never_construct_provider(workspace, modality, count):
    client, body, _, constructions = workspace
    times = np.arange(count) / 1000
    server.experiments[body["experiment_id"]]["recording"] = Recording("local", modality, times,
        {body["channel"]: np.sin(times)}, "a.u.", {})
    response = client.post("/api/investigations", json={**body, "end_s": float(times[-1] + .001)})
    assert response.status_code == 422 and not constructions


def test_provider_constructor_failure_is_safe_and_has_no_export(workspace, monkeypatch, capsys):
    client, body, _, _ = workspace
    def fail(**options):
        raise ProviderError("missing_or_invalid_credential")
    monkeypatch.setattr(jobs_module, "MetaProvider", fail)
    identifier = client.post("/api/investigations", json=body).json()["id"]
    job = terminal(client, identifier)
    assert job["status"] == "failed" and job["result"] is None
    assert job["error"] == dict(category="missing_or_invalid_credential", http_status=None)
    assert client.get(f"/api/investigations/{identifier}/export").status_code == 409
    captured = capsys.readouterr()
    assert "FAKE_TEST_SENTINEL_PRIVATE_KEY" not in json.dumps(job) + captured.out + captured.err


def test_concurrent_distinct_requests_and_other_experiment_cannot_queue(workspace, monkeypatch):
    client, body, store, _ = workspace
    gate = Event()
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: MockProvider(gate=gate))
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            responses = list(pool.map(lambda index: client.post("/api/investigations", json={**body, "request_id": f"request-{index}"}), range(4)))
        assert sorted(r.status_code for r in responses) == [202, 409, 409, 409]
        identifier = next(r.json()["id"] for r in responses if r.status_code == 202)
        experiment = client.post("/api/experiments", json=dict(recording_id=body["recording_id"], protocol=dict(
            name="Another experiment", research_question="Waveform?", task="ppg_preprocessing",
            target="waveform_sensitivity", evaluation="original_sensitivity", processing_mode="offline", notes=""))).json()
        response = client.post("/api/investigations", json={**body, "experiment_id": experiment["id"], "request_id": "other-experiment"})
        assert response.status_code == 409
        assert len(store.list(body["experiment_id"])) == 1 and not store.list(experiment["id"])
    finally:
        gate.set()
    assert terminal(client, identifier)["status"] == "completed"


def test_requirements_roundtrip_api_idempotency_import_and_report_binding(workspace):
    client, body, store, constructions = workspace
    body["requirements"] = dict(confirmed=True, method="median", criteria=dict(max_timing_shift_ms=1000, min_usable_fraction=.5))
    submitted = client.post("/api/investigations", json=body)
    assert submitted.status_code == 202
    job = terminal(client, submitted.json()["id"])
    assert job["status"] == "completed"
    assert job["result"]["requirement_assessment"]["status"] == "met"
    assert job["display_context"]["experiment"]["protocol"]["requirements"] == body["requirements"]
    assert client.post("/api/investigations", json=body).json()["id"] == job["id"]
    changed = dict(body, requirements=dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=1000)))
    assert client.post("/api/investigations", json=changed).status_code == 409
    bundle = client.get(f"/api/investigations/{job['id']}/export").json()
    imported = client.post("/api/investigations/import", json=dict(request_id="requirements-import", bundle=bundle))
    assert imported.status_code == 201
    assert imported.json()["result"]["requirement_assessment"] == job["result"]["requirement_assessment"]
    assert imported.json()["display_context"]["experiment"]["protocol"]["requirements"] == body["requirements"]
    bundle["requirement_assessment"]["comparisons"][0]["checks"][0]["value"] = 9999
    assert client.post("/api/investigations/import", json=dict(request_id="tampered-requirements", bundle=bundle)).status_code == 422


@pytest.mark.parametrize("requirements", [dict(confirmed=False, method="highpass", criteria=dict(max_timing_shift_ms=10)),
    dict(confirmed=True, method="unchanged", criteria=dict(max_timing_shift_ms=10)),
    dict(confirmed=True, method="highpass", criteria={}),
    dict(confirmed=True, method="highpass", criteria=dict(max_unmatched_candidates=True))])
def test_invalid_requirements_rejected_before_provider_construction(workspace, requirements):
    client, body, store, constructions = workspace
    assert client.post("/api/investigations", json=dict(body, requirements=requirements)).status_code == 422
    assert not constructions
