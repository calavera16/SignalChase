"""Actual local evidence, mocked Meta selection and private transport boundaries."""
from copy import deepcopy
import json
import time
from threading import Event
import httpx
import pytest
from fastapi.testclient import TestClient
from signaltrace import server, explanation_jobs as jobs_module
from signaltrace.explanation import explain, validate_scenes, validate_artifact, ExplanationError, TOOLS
from signaltrace.explanation_jobs import ExplanationJobs
from signaltrace.investigation import investigate
from signaltrace.investigation_jobs import InvestigationJobs, JobError
from signaltrace.local_store import LocalStore, digest
from signaltrace.meta_provider import MODEL, ENDPOINT, MetaProvider, ProviderResponse, ToolCall
from signaltrace.recordings import demo_recording


class InvestigationProvider:
    provider_name, model, execution_mode, history_mode = "meta", MODEL, "mocked_test", "stateless"
    def __init__(self):
        self.round = 0

    def respond(self, **kwargs):
        self.round += 1
        if self.round == 1:
            name, arguments = "inspect", dict(start_s=0., end_s=30.)
        elif self.round in (2, 3):
            name, arguments = "compare", dict(start_s=0., end_s=30., parameters=dict(
                median_window_s=2., highpass_hz=.35 if self.round == 2 else 1., edge_guard_s=3.))
        else:
            name, arguments = "conclude", dict(status="inconclusive", evidence_ids=["e1", "e2", "e3"],
                narrative="Tested settings differ; preferred method remains unresolved.", questions=[])
        return ProviderResponse(f"resp_{self.round}", (ToolCall(f"call_{self.round}", name, arguments),))


@pytest.fixture
def bundle():
    recording = demo_recording("synthetic_drift_noise")
    return investigate(recording, channel=next(iter(recording.channels)), question="Does the setting affect timing?",
        notes="Unknown acquisition.", target="pulse_timing", start_s=0., end_s=30., provider=InvestigationProvider())


def scene(kind, cid=None, baseline=None, method=None, focus="full_window", ids=None):
    return dict(kind=kind, evidence_ids=ids if ids is not None else [v for v in (cid, baseline) if v],
                comparison_id=cid, baseline_comparison_id=baseline, method=method, focus=focus,
                caption="Measured sensitivity" if cid else "Research scope",
                interpretation="This comparison informs timing sensitivity; preference remains unresolved.")


def arguments():
    return dict(scenes=[scene("scope"), scene("settings_contrast", "e3", "e2", "highpass"), scene("uncertainty")])


class ExplanationProvider:
    provider_name, model, execution_mode, history_mode = "meta", MODEL, "mocked_test", "stateless"
    def __init__(self, value=None, gate=None, error=None):
        self.value, self.gate, self.error = value or arguments(), gate, error
        self.requests = []

    def respond(self, **request):
        self.requests.append(request)
        if self.gate:
            assert self.gate.wait(5)
        if self.error:
            raise self.error
        return ProviderResponse("resp_explanation", (ToolCall("call_explanation", "compose_explanation", self.value),),
                                usage=dict(input_tokens=20, output_tokens=30))


def test_real_evidence_binding_and_outbound_summary_only(bundle):
    provider = ExplanationProvider()
    result = explain(bundle, investigation_id="retained", evidence_digest=digest(bundle), provider=provider)
    binding = result["scenes"][1]["binding"]
    assert binding["metrics"] == bundle["evidence"]["e3"]["metrics"]["highpass"]
    assert binding["baseline_metrics"] == bundle["evidence"]["e2"]["metrics"]["highpass"]
    assert binding["changed_parameter"] == "highpass_hz"
    assert binding["parameters"]["highpass_hz"] == 1.
    assert result["identity"]["execution_mode"] == "mocked_test"
    outbound = json.dumps(provider.requests)
    for forbidden in ("synthetic_drift_noise", "provenance", "input_sha256", '"plot"', '"raw"', '"times"', '"recipe"'):
        assert forbidden not in outbound
    assert len(provider.requests) == 1 and provider.requests[0]["tools"] == TOOLS


def test_exact_focus_is_first_actual_unmatched_candidate(bundle):
    from signaltrace.candidate_evidence import candidate_evidence
    chosen = None
    for cid, pair in bundle["comparisons"].items():
        annotation = candidate_evidence(cid, pair["result"])
        for method, values in annotation["methods"].items():
            unmatched = sorted(set(values["candidate_indices"]) - {p[1] for p in values["pairs"]})
            if unmatched:
                chosen = cid, method, unmatched[0]
                break
        if chosen:
            break
    assert chosen, "Toy input must exercise actual unmatched candidates"
    cid, method, index = chosen
    value = dict(scenes=[scene("scope"), scene("candidate_focus", cid, method=method, focus="first_unmatched"), scene("uncertainty")])
    plan = validate_scenes(value, bundle)
    focus = plan[1]["binding"]["focus"]
    assert focus["sample_index"] == index and focus["time_s"] == bundle["comparisons"][cid]["result"]["plot"]["times"][index]
    assert focus["comparison_id"] == cid and focus["method"] == method
    assert focus["start_s"] <= focus["time_s"] < focus["end_s"] and focus["end_s"] - focus["start_s"] <= 4 + 1e-9


@pytest.mark.parametrize("change", [
    lambda v: v["scenes"][1].update(comparison_id="e999"),
    lambda v: v["scenes"][1].update(evidence_ids=["e3"]),
    lambda v: v["scenes"][1].update(baseline_comparison_id="e3"),
    lambda v: v["scenes"][1].update(method="invented"),
    lambda v: v["scenes"][1].update(focus="made_up"),
    lambda v: v["scenes"][1].update(caption="Four candidates at 19.936 s"),
    lambda v: v["scenes"][1].update(interpretation="This is the best filter"),
    lambda v: v["scenes"][1].update(interpretation="This diagnoses arrhythmia"),
    lambda v: v["scenes"][1].update(time_s=19.936),
    lambda v: v["scenes"][0].update(evidence_ids=["e1", "e1"]),
    lambda v: v["scenes"].pop(),
])
def test_invalid_or_overclaiming_plans_fail_closed(bundle, change):
    value = arguments()
    change(value)
    with pytest.raises(ExplanationError, match="invalid_plan"):
        validate_scenes(value, bundle)


def test_support_contrast_and_missing_annotation_checks(bundle):
    value = arguments()
    for mutation in (lambda b: b["comparisons"]["e2"]["result"]["plot"]["valid_mask"].__setitem__(0, True),
                     lambda b: b["comparisons"]["e2"]["result"]["plot"]["raw"].__setitem__(0, 1234.),
                     lambda b: b["comparisons"]["e2"]["recipe"].update(input_sha256="other")):
        changed = deepcopy(bundle)
        mutation(changed)
        with pytest.raises(ExplanationError):
            validate_scenes(value, changed)
    invalid_focus = dict(scenes=[scene("scope"), scene("candidate_focus", "e2", method="unchanged", focus="first_unmatched"), scene("uncertainty")])
    with pytest.raises(ExplanationError):
        validate_scenes(invalid_focus, bundle)


def test_no_comparison_can_use_two_honest_scenes(bundle):
    value = deepcopy(bundle)
    value["comparisons"], value["evidence"] = {}, {}
    assert len(validate_scenes(dict(scenes=[scene("scope"), scene("uncertainty")]), value)) == 2


def test_artifact_import_preserves_original_and_rebinds_only_matching_evidence(bundle):
    plan = explain(bundle, investigation_id="old", evidence_digest=digest(bundle), provider=ExplanationProvider())
    artifact = dict(schema="signaltrace.explanation-artifact.v1", explanation=plan)
    imported = validate_artifact(artifact, bundle, "new-import-id", digest(bundle))
    assert imported["investigation_id"] == "new-import-id"
    assert imported["provenance"]["kind"] == "imported_historical_explanation"
    assert plan["investigation_id"] == "old"
    corrupt = deepcopy(artifact)
    corrupt["explanation"]["scenes"][1]["binding"]["metrics"]["matched_count"] = 999
    with pytest.raises(ExplanationError):
        validate_artifact(corrupt, bundle, "new", digest(bundle))
    with pytest.raises(ExplanationError):
        validate_artifact(artifact, bundle, "new", "a" * 64)


def test_real_adapter_one_mocked_request_fixed_endpoint_no_history_leak(bundle, monkeypatch):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-test-only-key")
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        assert str(request.url) == ENDPOINT
        return httpx.Response(200, json=dict(id="resp_plan", status="completed", model=MODEL, output=[
            dict(type="reasoning", encrypted_content="opaque-private", summary=[]),
            dict(type="function_call", name="compose_explanation", call_id="plan_call", arguments=json.dumps(arguments()))]))
    provider = MetaProvider(allow_network=True, history_mode="stateless", transport=httpx.MockTransport(handler))
    result = explain(bundle, investigation_id="saved", evidence_digest=digest(bundle), provider=provider)
    assert len(seen) == 1 and seen[0]["store"] is False and seen[0]["max_output_tokens"] == 2048
    assert seen[0]["tools"] == TOOLS
    assert "opaque-private" not in json.dumps(result) and "fake-test-only-key" not in json.dumps(result)


def wait_job(store, identifier):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        job = store.get(identifier)
        if job["status"] != "running":
            return job
        time.sleep(.01)
    pytest.fail("Mock job did not finish")


def test_jobs_idempotency_concurrency_restart_and_no_provider_reads(bundle, tmp_path, monkeypatch):
    storage = LocalStore(tmp_path)
    store = ExplanationJobs(storage)
    gate = Event()
    provider = ExplanationProvider(gate=gate)
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **kwargs: provider)
    request = dict(request_id="one", investigation_id="saved", evidence_digest=digest(bundle))
    first = store.submit(request, bundle)
    try:
        assert store.submit(request, bundle)["id"] == first["id"]
        with pytest.raises(JobError):
            store.submit({**request, "request_id": "other"}, bundle)
        with pytest.raises(JobError):
            store.submit({**request, "investigation_id": "wrong"}, bundle)
        assert ExplanationJobs(storage).get(first["id"])["status"] == "interrupted"
    finally:
        gate.set()
    job = wait_job(store, first["id"])
    assert job["status"] == "completed" and len(provider.requests) == 1
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **kwargs: pytest.fail("Read created provider"))
    restored = ExplanationJobs(storage)
    assert restored.get(first["id"])["result"] == job["result"]
    artifact = restored.export(first["id"])
    imported = restored.import_artifact({**request, "request_id": "imported"}, artifact, bundle)
    assert imported["result"]["provenance"]["kind"] == "imported_historical_explanation"
    assert restored.import_artifact({**request, "request_id": "imported"}, artifact, bundle)["id"] == imported["id"]


@pytest.mark.parametrize("error", [RuntimeError("SENTINEL_PRIVATE_RESPONSE"), ExplanationError()])
def test_failure_has_no_retry_or_unvalidated_plan_and_preserves_source(bundle, monkeypatch, error):
    provider = ExplanationProvider(error=error)
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **kwargs: provider)
    store = ExplanationJobs()
    before = deepcopy(bundle)
    job = store.submit(dict(request_id="fail", investigation_id="saved", evidence_digest=digest(bundle)), bundle)
    final = wait_job(store, job["id"])
    assert final["status"] == "failed" and final["result"] is None and len(provider.requests) == 1
    assert "SENTINEL_PRIVATE_RESPONSE" not in json.dumps(final) and bundle == before


def test_http_explicit_consent_digest_import_export_and_archived_context(bundle, tmp_path, monkeypatch):
    storage = LocalStore(tmp_path)
    investigations = InvestigationJobs(storage)
    explanations = ExplanationJobs(storage)
    monkeypatch.setattr(server, "investigation_jobs", investigations)
    monkeypatch.setattr(server, "explanation_jobs", explanations)
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-test-only-key")
    provider = ExplanationProvider()
    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **kwargs: provider)
    with TestClient(server.app, base_url="http://localhost") as client:
        response = client.post("/api/investigations/import", json=dict(request_id="restore", bundle=bundle))
        assert response.status_code == 201, response.text
        job = response.json()
        assert job["source"]["kind"] == "imported_historical" and job["retention"] == "retained"
        assert job["display_context"]["recording"]["id"] == job["request"]["recording_id"]
        assert job["display_context"]["experiment"]["id"] == job["request"]["experiment_id"]
        assert client.get("/api/investigations").json()["jobs"][0]["id"] == job["id"]
        assert client.post("/api/investigations/import", json=dict(request_id="restore", bundle=bundle)).json()["id"] == job["id"]
        request = dict(request_id="explain", investigation_id=job["id"], evidence_digest=job["evidence_digest"], allow_network=True)
        for consent in (False, 1, "true", None):
            assert client.post("/api/explanations", json={**request, "allow_network": consent}).status_code == 422
        assert client.post("/api/explanations", json={**request, "evidence_digest": "a" * 64}).status_code == 409
        assert not provider.requests
        response = client.post("/api/explanations", json=request)
        assert response.status_code == 202
        final = wait_job(explanations, response.json()["id"])
        assert final["status"] == "completed"
        assert client.get(f'/api/explanations/{final["id"]}/export').status_code == 200
        assert client.get(f'/api/investigations/{job["id"]}/export').json() == bundle
        assert client.get("/api/explanations", params={"investigation_id": job["id"]}).json()["jobs"][0]["id"] == final["id"]
        monkeypatch.delenv("SIGNALTRACE_META_API_KEY")
        assert client.post("/api/explanations", json=request).json()["id"] == final["id"]
        assert client.post("/api/explanations", json={**request, "request_id": "no-key"}).status_code == 503
        artifact = explanations.export(final["id"])
        assert client.post("/api/explanations/import", json=dict(request_id="local-story", investigation_id=job["id"], artifact=artifact)).status_code == 201
        assert client.get("/api/explanations", headers={"Origin": "https://evil.invalid"}).status_code == 403
        assert client.post("/api/explanations", json=request, headers={"Host": "evil.invalid"}).status_code == 403
        assert client.post("/api/investigations/import", content='{"request_id":"a","request_id":"b","bundle":{}}').status_code == 422


@pytest.mark.parametrize("payload,expected", [
    (dict(id="mock_incomplete", status="incomplete", model=MODEL,
          incomplete_details=dict(reason="max_output_tokens"), private_body="PRIVATE_MOCK_RESPONSE"),
     dict(category="invalid_response", http_status=200, response_code="incomplete_max_output_tokens")),
    (dict(id="mock_malformed", status="completed", model=MODEL, output=[
        dict(type="function_call", name="compose_explanation", call_id="mock_call",
             arguments='{"PRIVATE_MOCK_RESPONSE":')]),
     dict(category="invalid_response", http_status=200, response_code="malformed_arguments")),
    (dict(id="mock_refusal", status="completed", model=MODEL,
          output=[dict(type="refusal", refusal="PRIVATE_MOCK_RESPONSE")]),
     dict(category="invalid_response", http_status=200, response_code="refusal")),
    (dict(id="mock_reasoning", status="completed", model=MODEL, output=[
        dict(type="reasoning", summary="PRIVATE_MOCK_RESPONSE"),
        dict(type="function_call", name="compose_explanation", call_id="mock_call",
             arguments=json.dumps(arguments()))]),
     dict(category="invalid_response", http_status=200, response_code="missing_encrypted_reasoning")),
    ("PRIVATE_MOCK_RESPONSE invalid JSON",
     dict(category="invalid_response", http_status=200, response_code="invalid_json")),
])
def test_real_adapter_failure_subtype_survives_safe_job_http_and_storage(
        bundle, tmp_path, monkeypatch, caplog, capsys, payload, expected):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_DIAGNOSTIC_KEY")
    before = deepcopy(bundle)
    attempts = []

    def handler(request):
        attempts.append(request.method)
        assert str(request.url) == ENDPOINT
        assert request.headers["authorization"] == "Bearer FAKE_TEST_DIAGNOSTIC_KEY"
        return (httpx.Response(200, json=payload) if isinstance(payload, dict) else
                httpx.Response(200, content=payload.encode()))

    # Exercise the real parser/transport class through the actual detached job path.
    monkeypatch.setattr(jobs_module, "MetaProvider",
        lambda **options: MetaProvider(**options, transport=httpx.MockTransport(handler)))
    storage = LocalStore(tmp_path)
    store = ExplanationJobs(storage)
    request = dict(request_id="diagnose", investigation_id="retained", evidence_digest=digest(bundle))
    admitted = store.submit(request, bundle)
    final = wait_job(store, admitted["id"])
    assert final["status"] == "failed" and final["result"] is None and final["error"] == expected
    assert attempts == ["POST"] and bundle == before
    assert store.submit(request, bundle)["id"] == admitted["id"] and attempts == ["POST"]
    with pytest.raises(JobError):
        store.export(admitted["id"])

    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: pytest.fail("Restore/read requested Meta"))
    restored = ExplanationJobs(storage)
    assert restored.get(admitted["id"])["error"] == expected
    assert restored.existing(request)["id"] == admitted["id"]
    assert restored.list("retained")[0]["error"] == expected
    monkeypatch.setattr(server, "explanation_jobs", restored)
    with TestClient(server.app, base_url="http://localhost") as client:
        response = client.get(f'/api/explanations/{admitted["id"]}')
        assert response.status_code == 200 and response.json()["error"] == expected
        visible = response.text

    # Diagnostics never become an artifact or rewrite the investigation bundle.
    plan = explain(bundle, investigation_id="retained", evidence_digest=digest(bundle), provider=ExplanationProvider())
    artifact = dict(schema="signaltrace.explanation-artifact.v1", explanation=plan)
    imported = restored.import_artifact({**request, "request_id": "local-artifact"}, artifact, bundle)
    assert imported["status"] == "completed" and imported["error"] is None
    assert restored.export(imported["id"])["explanation"]["scenes"] == plan["scenes"]
    on_disk = "".join(path.read_text(encoding="utf-8") for path in tmp_path.glob("explanation-*.json"))
    captured = capsys.readouterr()
    all_public = json.dumps([final, restored.list(), artifact]) + visible + on_disk + caplog.text + captured.out + captured.err
    assert "PRIVATE_MOCK_RESPONSE" not in all_public
    assert "FAKE_TEST_DIAGNOSTIC_KEY" not in all_public
    assert "mock_incomplete" not in all_public and "mock_malformed" not in all_public


@pytest.mark.parametrize("error,expected", [
    (dict(category="invalid_response", http_status=200),
     dict(category="invalid_response", http_status=200)),
    (dict(category="invalid_response", http_status=200, response_code="incomplete_max_output_tokens"),
     dict(category="invalid_response", http_status=200, response_code="incomplete_max_output_tokens")),
    (dict(category="invalid_response", http_status=200, response_code="PRIVATE_MOCK_RESPONSE"),
     dict(category="invalid_response", http_status=200)),
    (dict(category="invalid_response", http_status=200, response_code={"private": "PRIVATE_MOCK_RESPONSE"}),
     dict(category="invalid_response", http_status=200)),
    (dict(category="invalid_response", http_status=429, response_code="invalid_json"),
     dict(category="invalid_response", http_status=429)),
    (dict(category="quota", http_status=429, response_code="invalid_json", body="PRIVATE_MOCK_RESPONSE"),
     dict(category="quota", http_status=429)),
    (dict(category="invalid_plan", http_status=None, response_code="invalid_json"),
     dict(category="invalid_plan", http_status=None)),
    (dict(category="PRIVATE_MOCK_RESPONSE", http_status=True, response_code="invalid_json"),
     dict(category="provider_failure", http_status=None)),
])
def test_restored_error_diagnostics_accept_legacy_and_only_fixed_appropriate_codes(
        tmp_path, error, expected):
    from uuid import uuid4
    storage = LocalStore(tmp_path)
    identifier = uuid4().hex
    job = dict(id=identifier, status="failed",
               request=dict(request_id="legacy", investigation_id="saved", evidence_digest="a" * 64),
               stage="finished", error=error, result=None, retention="retained")
    storage.save("explanation", identifier, job)
    restored = ExplanationJobs(storage)
    assert restored.get(identifier)["error"] == expected
    assert "PRIVATE_MOCK_RESPONSE" not in json.dumps(restored.list())
    assert jobs_module.public_error(error) == expected


def test_real_adapter_http_failure_keeps_legacy_error_shape_and_never_retries(bundle, monkeypatch):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_DIAGNOSTIC_KEY")
    attempts = []
    def handler(request):
        attempts.append(request.method)
        return httpx.Response(429, text="PRIVATE_MOCK_RESPONSE")
    monkeypatch.setattr(jobs_module, "MetaProvider",
        lambda **options: MetaProvider(**options, transport=httpx.MockTransport(handler)))
    store = ExplanationJobs()
    job = store.submit(dict(request_id="quota", investigation_id="saved", evidence_digest=digest(bundle)), bundle)
    final = wait_job(store, job["id"])
    assert final["error"] == dict(category="quota", http_status=429)
    assert final["status"] == "failed" and final["result"] is None and attempts == ["POST"]
    assert "PRIVATE_MOCK_RESPONSE" not in json.dumps(final)


def test_real_explanation_job_uses_single_bounded_allowance_and_local_reads_stay_local(
        bundle, tmp_path, monkeypatch, caplog, capsys):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_OUTPUT_BUDGET_KEY")
    attempts, constructions = [], []
    original = deepcopy(bundle)
    def handler(request):
        wire = json.loads(request.content)
        attempts.append(wire)
        assert str(request.url) == ENDPOINT and request.method == "POST"
        assert request.extensions["timeout"] == dict(connect=10., read=90., write=90., pool=90.)
        assert wire["model"] == MODEL and wire["max_output_tokens"] == 8192
        assert wire["reasoning"] == dict(effort="low") and "reasoning_effort" not in wire
        assert wire["store"] is False and wire["include"] == ["reasoning.encrypted_content"]
        assert wire["parallel_tool_calls"] is False and wire["tools"] == TOOLS
        assert "previous_response_id" not in wire and "tool_choice" not in wire
        return httpx.Response(200, json=dict(id="budget_completed", status="completed", model=MODEL, output=[
            dict(type="reasoning", encrypted_content="PRIVATE_BUDGET_REASONING", summary=[]),
            dict(type="function_call", name="compose_explanation", call_id="budget_plan",
                 arguments=json.dumps(arguments()))]))

    def factory(**options):
        constructions.append(options)
        return MetaProvider(**options, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(jobs_module, "MetaProvider", factory)
    storage = LocalStore(tmp_path)
    store = ExplanationJobs(storage)
    request = dict(request_id="bounded-success", investigation_id="saved", evidence_digest=digest(bundle))
    job = store.submit(request, bundle)
    final = wait_job(store, job["id"])
    assert final["status"] == "completed" and final["error"] is None
    assert constructions == [dict(allow_network=True, history_mode="stateless", request_timeout_s=90,
                                  max_output_tokens=jobs_module.EXPLANATION_MAX_OUTPUT_TOKENS,
                                  reasoning_effort=jobs_module.EXPLANATION_REASONING_EFFORT, api_key="FAKE_TEST_OUTPUT_BUDGET_KEY")]
    assert jobs_module.EXPLANATION_REASONING_EFFORT == "low"
    assert jobs_module.EXPLANATION_MAX_OUTPUT_TOKENS == 8192 and len(attempts) == 1
    assert final["result"]["identity"]["execution_mode"] == "mocked_test"
    artifact = store.export(job["id"])
    assert validate_artifact(artifact, bundle, "restored", digest(bundle))["scenes"] == final["result"]["scenes"]
    assert store.submit(request, bundle)["id"] == job["id"] and store.existing(request)["id"] == job["id"]

    monkeypatch.setattr(jobs_module, "MetaProvider", lambda **options: pytest.fail("Local operation called Meta"))
    restored = ExplanationJobs(storage)
    assert restored.get(job["id"])["result"] == final["result"] and restored.list()[0]["id"] == job["id"]
    imported = restored.import_artifact({**request, "request_id": "imported-budget-plan"}, artifact, bundle)
    assert imported["status"] == "completed" and imported["error"] is None
    assert restored.export(imported["id"])["explanation"]["scenes"] == final["result"]["scenes"]
    assert restored.import_artifact({**request, "request_id": "imported-budget-plan"}, artifact, bundle)["id"] == imported["id"]
    assert len(attempts) == 1 and bundle == original
    on_disk = "".join(path.read_text(encoding="utf-8") for path in tmp_path.glob("explanation-*.json"))
    captured = capsys.readouterr()
    public = json.dumps(restored.list()) + on_disk + caplog.text + captured.out + captured.err
    assert "PRIVATE_BUDGET_REASONING" not in public and "FAKE_TEST_OUTPUT_BUDGET_KEY" not in public


def test_explanation_incomplete_output_rejects_valid_looking_partial_plan_and_keeps_diagnostic(
        bundle, tmp_path, monkeypatch):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_OUTPUT_BUDGET_KEY")
    attempts = []
    def handler(request):
        wire = json.loads(request.content)
        attempts.append(wire)
        assert wire["max_output_tokens"] == 8192 and wire["tools"] == TOOLS
        assert wire["reasoning"] == dict(effort="low")
        return httpx.Response(200, json=dict(id="budget_partial", status="incomplete", model=MODEL,
            incomplete_details=dict(reason="max_output_tokens"), output=[
                dict(type="function_call", name="compose_explanation", call_id="partial_plan",
                     arguments=json.dumps(arguments()))]))
    monkeypatch.setattr(jobs_module, "MetaProvider",
        lambda **options: MetaProvider(**options, transport=httpx.MockTransport(handler)))
    storage = LocalStore(tmp_path)
    store = ExplanationJobs(storage)
    request = dict(request_id="bounded-incomplete", investigation_id="saved", evidence_digest=digest(bundle))
    job = store.submit(request, bundle)
    final = wait_job(store, job["id"])
    expected = dict(category="invalid_response", http_status=200, response_code="incomplete_max_output_tokens")
    assert final["status"] == "failed" and final["result"] is None and final["error"] == expected
    assert len(attempts) == 1 and store.submit(request, bundle)["id"] == job["id"]
    assert ExplanationJobs(storage).get(job["id"])["error"] == expected
    with pytest.raises(JobError):
        store.export(job["id"])
    assert "partial_plan" not in json.dumps(final) and len(attempts) == 1


@pytest.mark.parametrize("has_comparisons", [False, True])
@pytest.mark.parametrize("count", [1, 2, 3, 4, 5, 6])
def test_scene_count_policy_remains_conditional(bundle, has_comparisons, count):
    retained = deepcopy(bundle)
    if not has_comparisons:
        retained["comparisons"], retained["evidence"] = {}, {}
    scenes = [scene("scope") for _ in range(count - 1)] + [scene("uncertainty")]
    accepted = (3 if has_comparisons else 2) <= count <= 5
    if accepted:
        assert len(validate_scenes(dict(scenes=scenes), retained)) == count
    else:
        with pytest.raises(ExplanationError) as error:
            validate_scenes(dict(scenes=scenes), retained)
        assert error.value.plan_code == "scene_count"


def test_prompt_clarifies_existing_rules_and_safe_example_is_accepted(bundle):
    from signaltrace.explanation import INSTRUCTIONS, wording
    assert "No-finding/partial evidence can use only scope and uncertainty" not in INSTRUCTIONS
    assert "If retained comparisons exist, use three to five scenes" in INSTRUCTIONS
    assert "Only when no comparisons exist may you use two to five scenes" in INSTRUCTIONS
    assert "Negating or qualifying those words does not make them" in INSTRUCTIONS
    safe = "Setting preference remains unresolved."
    assert safe in INSTRUCTIONS and wording(safe, 90) == safe
    value = arguments()
    for selected in value["scenes"]:
        selected["caption"] = safe
        selected["interpretation"] = safe
    assert len(validate_scenes(value, bundle)) == 3


@pytest.mark.parametrize("text", [
    "Not the best choice.", "Not optimal.", "No diagnosis.", "No clinical assertion.",
    "Not a heartbeat.", "No heartbeats.", "No arrhythmia claim.", "Not healthy.",
    "No disease claim.", "No SNR claim.", "No cause established.", "No causal assertion.",
    "Not an artifact.", "Not artifacts.", "At 19.936 s.", "At \u0661 s.",
    "https://example.invalid", "http://example.invalid", "<caption>", "caption>",
])
def test_existing_wording_policy_including_negated_mentions_still_rejects(text):
    from signaltrace.explanation import wording
    with pytest.raises(ExplanationError) as error:
        wording(text, 240)
    assert error.value.plan_code == "wording_policy"


@pytest.mark.parametrize("code", [
    "tool_shape", "plan_shape", "scene_count", "scene_order", "scene_fields", "scene_options",
    "evidence_reference", "wording_format", "wording_policy", "comparison_binding",
    "contrast_binding", "focus_binding", "validation_failed",
])
def test_real_adapter_plan_codes_survive_job_storage_http_without_rejected_content(
        bundle, tmp_path, monkeypatch, caplog, capsys, code):
    from signaltrace import explanation as explanation_module
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-plan-diagnostic-key")
    args = arguments()
    for selected in args["scenes"]:
        selected["caption"] = "PRIVATE_REJECTED_PLAN"
    tool = "compose_explanation"
    if code == "tool_shape":
        tool = "PRIVATE_REJECTED_TOOL"
    elif code == "plan_shape":
        args = dict(unexpected="PRIVATE_REJECTED_PLAN")
    elif code == "scene_count":
        args["scenes"] = [args["scenes"][0], args["scenes"][-1]]
    elif code == "scene_order":
        args["scenes"][0]["kind"] = "metrics"
    elif code == "scene_fields":
        args["scenes"][1]["private"] = "PRIVATE_REJECTED_PLAN"
    elif code == "scene_options":
        args["scenes"][1]["kind"] = "PRIVATE_REJECTED_PLAN"
    elif code == "evidence_reference":
        args["scenes"][1]["evidence_ids"] = ["PRIVATE_REJECTED_PLAN"]
    elif code == "wording_format":
        args["scenes"][0]["caption"] = None
    elif code == "wording_policy":
        args["scenes"][0]["caption"] = "Not the best filter PRIVATE_REJECTED_PLAN"
    elif code == "comparison_binding":
        args["scenes"][1]["comparison_id"] = "e1"
    elif code == "contrast_binding":
        args["scenes"][1]["baseline_comparison_id"] = "e3"
    elif code == "focus_binding":
        args["scenes"][1].update(kind="candidate_focus", baseline_comparison_id=None,
                                 method="unchanged", focus="first_unmatched")
    elif code == "validation_failed":
        # Exercise the unexpected-local-validation guard after a real parsed response.
        # This fault does not assert any cause for the discarded live response.
        def unexpected_local_validation(*values):
            raise TypeError("PRIVATE_REJECTED_PLAN")
        monkeypatch.setattr(explanation_module, "wording", unexpected_local_validation)

    attempts = []
    def handler(request):
        wire = json.loads(request.content)
        attempts.append(wire)
        assert wire["max_output_tokens"] == 8192 and wire["tools"] == TOOLS
        assert request.extensions["timeout"]["read"] == 90.
        return httpx.Response(200, json=dict(id="discarded_provider_id", status="completed", model=MODEL, output=[
            dict(type="reasoning", encrypted_content="PRIVATE_PLAN_REASONING", summary=[]),
            dict(type="function_call", name=tool, call_id="discarded_call_id", arguments=json.dumps(args))]))
    monkeypatch.setattr(jobs_module, "MetaProvider",
        lambda **options: MetaProvider(**options, transport=httpx.MockTransport(handler)))

    investigations = InvestigationJobs()
    source = investigations.import_bundle("plan-diagnostic-source", bundle)
    original_export = investigations.export(source["id"])
    storage = LocalStore(tmp_path)
    store = ExplanationJobs(storage)
    request = dict(request_id="plan-diagnostic", investigation_id=source["id"], evidence_digest=source["evidence_digest"])
    admitted = store.submit(request, bundle)
    final = wait_job(store, admitted["id"])
    expected = dict(category="invalid_plan", http_status=None, plan_code=code)
    assert final["status"] == "failed" and final["result"] is None and final["error"] == expected
    assert len(attempts) == 1 and store.submit(request, bundle)["id"] == admitted["id"]
    with pytest.raises(JobError):
        store.export(admitted["id"])
    restored = ExplanationJobs(storage)
    assert restored.get(admitted["id"])["error"] == expected
    monkeypatch.setattr(server, "explanation_jobs", restored)
    monkeypatch.setattr(server, "investigation_jobs", investigations)
    with TestClient(server.app, base_url="http://localhost") as client:
        response = client.get(f'/api/explanations/{admitted["id"]}')
        assert response.status_code == 200 and response.json()["error"] == expected
        assert client.get(f'/api/investigations/{source["id"]}/export').json() == original_export
        visible = response.text
    assert investigations.export(source["id"]) == original_export == bundle and len(attempts) == 1
    disk = "".join(path.read_text(encoding="utf-8") for path in tmp_path.glob("explanation-*.json"))
    captured = capsys.readouterr()
    public = json.dumps([final, restored.list()]) + visible + disk + caplog.text + captured.out + captured.err
    for private in ("PRIVATE_REJECTED_PLAN", "PRIVATE_REJECTED_TOOL", "PRIVATE_PLAN_REASONING",
                    "fake-plan-diagnostic-key", "discarded_provider_id", "discarded_call_id"):
        assert private not in public


@pytest.mark.parametrize("code", [None, "PRIVATE_PLAN_CODE", True, 1, [], {}, "invalid_json"])
def test_explanation_error_strips_unknown_or_malformed_plan_codes(code):
    error = ExplanationError(plan_code=code)
    assert error.plan_code is None
    assert jobs_module.public_error(error) == dict(category="invalid_plan", http_status=None)
    assert str(error) == "invalid_plan"


@pytest.mark.parametrize("error,expected", [
    (dict(category="invalid_plan", http_status=None, plan_code="scene_count"),
     dict(category="invalid_plan", http_status=None, plan_code="scene_count")),
    (dict(category="invalid_plan", http_status=None, plan_code="PRIVATE_PLAN_CODE"),
     dict(category="invalid_plan", http_status=None)),
    (dict(category="invalid_plan", http_status=None, plan_code={"private": "PRIVATE_PLAN_CODE"}),
     dict(category="invalid_plan", http_status=None)),
    (dict(category="invalid_plan", http_status=200, plan_code="scene_count"),
     dict(category="invalid_plan", http_status=200)),
    (dict(category="invalid_plan", http_status=True, plan_code="scene_count"),
     dict(category="invalid_plan", http_status=None)),
    (dict(category="invalid_response", http_status=200, response_code="invalid_json", plan_code="scene_count"),
     dict(category="invalid_response", http_status=200, response_code="invalid_json")),
    (dict(category="source_changed", http_status=None, plan_code="scene_count"),
     dict(category="source_changed", http_status=None)),
    (dict(category="invalid_plan", http_status=None, plan_code="scene_count", response_code="invalid_json",
          raw_arguments="PRIVATE_PLAN_CODE"),
     dict(category="invalid_plan", http_status=None, plan_code="scene_count")),
    (dict(category="invalid_plan", http_status=None),
     dict(category="invalid_plan", http_status=None)),
])
def test_plan_diagnostic_restoration_keeps_only_fixed_properly_scoped_codes(tmp_path, error, expected):
    from uuid import uuid4
    storage = LocalStore(tmp_path)
    identifier = uuid4().hex
    storage.save("explanation", identifier, dict(id=identifier, status="failed",
        request=dict(request_id="stored-plan-code", investigation_id="source", evidence_digest="a" * 64),
        stage="finished", error=error, result=None, retention="retained"))
    restored = ExplanationJobs(storage)
    assert restored.get(identifier)["error"] == jobs_module.public_error(error) == expected
    assert "PRIVATE_PLAN_CODE" not in json.dumps(restored.list())
    assert jobs_module.public_error(ExplanationError()) == dict(category="invalid_plan", http_status=None)
    assert ExplanationError("source_changed", plan_code="scene_count").plan_code is None


def test_specific_plan_code_survives_nested_and_artifact_value_error_guards(bundle, monkeypatch):
    from signaltrace import explanation as module
    failure = ExplanationError(plan_code="focus_binding")
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(module, "exact", fail)
    with pytest.raises(ExplanationError) as scene_error:
        validate_scenes(arguments(), bundle)
    assert scene_error.value is failure
    with pytest.raises(ExplanationError) as artifact_error:
        validate_artifact({}, bundle, "source", digest(bundle))
    assert artifact_error.value is failure







def test_requirements_summary_reaches_explanation_without_raw_samples():
    recording = demo_recording("synthetic_drift_noise")
    requirements = dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=1000))
    bundle = investigate(recording, channel=next(iter(recording.channels)), question="Check confirmed timing limit",
        notes="Unknown acquisition.", target="pulse_timing", start_s=0., end_s=30.,
        provider=InvestigationProvider(), requirements=requirements)
    provider = ExplanationProvider()
    plan = explain(bundle, investigation_id="requirements", evidence_digest=digest(bundle), provider=provider)
    context = provider.requests[0]["context"]
    assert context["context"]["requirements"] == requirements
    assert context["requirement_assessment"] == bundle["requirement_assessment"]
    assert '"raw"' not in json.dumps(context) and '"times"' not in json.dumps(context)
    assert plan["evidence_digest"] == digest(bundle)
