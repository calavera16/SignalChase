import copy
import json
import numpy as np
import pytest
from signaltrace.investigation import investigate, replay_investigation, TOOLS
from signaltrace.meta_provider import ProviderResponse, ToolCall, MODEL
from signaltrace.recordings import demo_recording, Recording


class ScriptedProvider:
    provider_name = "scripted_test"
    model = "mock_contract_only"
    execution_mode = "mocked_test"

    def __init__(self, scripts):
        self.scripts = iter(scripts)
        self.requests = []

    def respond(self, **request):
        self.requests.append(copy.deepcopy(request))
        value = next(self.scripts)
        return value(request) if callable(value) else value


def call(name, args, identifier="c1", response_id="r1"):
    return ProviderResponse(response_id, (ToolCall(identifier, name, args),), {"input_tokens": 10})


def inspect(identifier="c1", response_id="r1", **window):
    return call("inspect", dict(start_s=0., end_s=30., **window), identifier, response_id)


def compare(identifier="c2", response_id="r2", **options):
    params = dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.)
    params.update(options)
    return call("compare", dict(start_s=0., end_s=30., parameters=params), identifier, response_id)


def finish(status="candidate", ids=None, candidate=None, identifier="c4", response_id="r4", questions=None):
    if ids is None:
        ids = ["e1", "e3"] if status == "candidate" else []
    if candidate is None and status == "candidate":
        candidate = dict(comparison_id="e3", method="median")
    return call("finish", dict(status=status, evidence_ids=ids, candidate=candidate,
        narrative="Proposed sensitivity comparison; preservation is unverified.", questions=questions or []), identifier, response_id)


def conclude(status="inconclusive", ids=None, questions=None, identifier="c4", response_id="r4"):
    return call("conclude", dict(status=status, evidence_ids=ids or [],
        narrative="Measured sensitivity does not establish a preferred method.", questions=questions or []), identifier, response_id)


def run(provider, recording=None, **options):
    recording = recording or demo_recording("synthetic_drift_noise")
    args = dict(channel=next(iter(recording.channels)), question="How sensitive is pulse timing to these settings?",
                notes="Acquired at rest; preserve event timing.", target="pulse_timing", start_s=0., end_s=30.)
    args.update(options)
    return investigate(recording, provider=provider, **args)


def successful_provider():
    def adaptive(request):
        observation = request["tool_outputs"][0]["output"]["observation"]
        assert observation["metrics"]["unchanged"]["mean_absolute_shift_ms"] == 0
        return compare("c3", "r3", median_window_s=3., highpass_hz=.5)
    return ScriptedProvider([inspect(), compare(), adaptive, finish()])


def test_progress_is_detached_safe_and_callback_failure_cannot_change_engine():
    expected = run(successful_provider())
    events = []
    def observer(value):
        events.append(copy.deepcopy(value))
        value["evidence"].clear()
        value["trace"].append({"private": "mutation"})
        raise RuntimeError("PRIVATE_OBSERVER_FAILURE")
    actual = run(successful_provider(), progress=observer)
    assert actual == expected
    assert len(events) == actual["rounds"] + actual["tool_attempts"] + 1
    assert events[0] == dict(rounds=1, tool_attempts=0, trace=[], evidence={})
    assert events[-1]["trace"][-1]["tool"] == "finish"
    assert all(set(event) == {"rounds", "tool_attempts", "trace", "evidence"} for event in events)
    serialized = json.dumps(events)
    for forbidden in ('"raw"', '"times"', '"arguments"', '"narrative"', '"context"', "PRIVATE_OBSERVER_FAILURE"):
        assert forbidden not in serialized
    replay_investigation(actual)


@pytest.mark.parametrize("update,code", [
    (lambda a: None, "finish_invalid_object"),
    (lambda a: {k: v for k, v in a.items() if k != "questions"}, "finish_missing_fields"),
    (lambda a: {**a, "measurements": "SENTINEL_PRIVATE"}, "finish_extra_fields"),
    (lambda a: {**a, "status": "SENTINEL_PRIVATE"}, "finish_invalid_status"),
    (lambda a: {**a, "narrative": 1}, "finish_narrative_type"),
    (lambda a: {**a, "narrative": "  "}, "finish_narrative_empty"),
    (lambda a: {**a, "narrative": "SENTINEL_PRIVATE" * 100}, "finish_narrative_too_long"),
    (lambda a: {**a, "narrative": "SENTINEL_PRIVATE\x01"}, "finish_narrative_characters"),
    (lambda a: {**a, "evidence_ids": [1]}, "finish_evidence_type"),
    (lambda a: {**a, "evidence_ids": "e1"}, "finish_evidence_type"),
    (lambda a: {**a, "evidence_ids": ["e1"] * 9}, "finish_evidence_type"),
    (lambda a: {**a, "evidence_ids": ["e1", "e1"]}, "finish_evidence_duplicate"),
    (lambda a: {**a, "evidence_ids": ["SENTINEL_PRIVATE"]}, "finish_evidence_unknown"),
    (lambda a: {**a, "questions": "SENTINEL_PRIVATE"}, "finish_invalid_questions"),
    (lambda a: {**a, "questions": ["why"] * 4}, "finish_invalid_questions"),
    (lambda a: {**a, "questions": [""]}, "finish_invalid_questions"),
    (lambda a: {**a, "questions": ["SENTINEL_PRIVATE" * 30]}, "finish_invalid_questions"),
    (lambda a: {**a, "questions": ["bad\x01"]}, "finish_invalid_questions"),
    (lambda a: {**a, "status": "needs_information", "candidate": None}, "finish_question_required"),
    (lambda a: {**a, "candidate": None}, "finish_candidate_required"),
    (lambda a: {**a, "status": "inconclusive"}, "finish_candidate_must_be_null"),
    (lambda a: {**a, "candidate": "SENTINEL_PRIVATE"}, "finish_candidate_shape"),
    (lambda a: {**a, "candidate": {**a["candidate"], "extra": 1}}, "finish_candidate_shape"),
    (lambda a: {**a, "candidate": dict(comparison_id="e2", method="SENTINEL_PRIVATE")}, "finish_candidate_method"),
    (lambda a: {**a, "candidate": dict(comparison_id="SENTINEL_PRIVATE", method="median")}, "finish_comparison_unknown"),
    (lambda a: {**a, "evidence_ids": ["e1"]}, "finish_comparison_not_cited"),
    (lambda a: {**a, "evidence_ids": ["e2"]}, "finish_inspection_not_cited"),
])
def test_finish_errors_are_actionable_static_and_do_not_leak(update, code):
    from signaltrace.investigation import FINISH_HINTS
    args = dict(status="candidate", candidate=dict(comparison_id="e2", method="median"),
        evidence_ids=["e1", "e2"], narrative="Sensitivity proposal only.", questions=[])
    provider = ScriptedProvider([inspect(), compare(), call("finish", update(args), "bad", "bad_response"),
        finish("inconclusive", identifier="fixed", response_id="fixed_response")])
    result = run(provider)
    event = result["trace"][2]
    feedback = provider.requests[3]["tool_outputs"][0]["output"]
    assert event["validation_code"] == feedback["validation_code"] == code
    assert feedback["correction_hint"] == FINISH_HINTS[code]
    assert result["error"] is None and result["conclusion"]["status"] == "inconclusive"
    assert "SENTINEL_PRIVATE" not in json.dumps(result) + json.dumps(feedback)
    replay_investigation(result)
    legacy = copy.deepcopy(result)
    del legacy["trace"][2]["validation_code"]
    replay_investigation(legacy)


@pytest.mark.parametrize("target,mutation", [
    ("pulse_timing", lambda s: s.__setitem__("valid_count", 0)),
    ("pulse_timing", lambda s: s["metrics"]["median"].__setitem__("matched_count", 0)),
    ("waveform_sensitivity", lambda s: s["metrics"]["median"].__setitem__("centered_normalized_rmse", None)),
])
def test_finish_unusable_measurements_remain_rejected(target, mutation):
    from signaltrace.investigation import conclusion, FinishValidationError
    result = run(successful_provider(), target=target)
    mutation(result["evidence"]["e3"])
    with pytest.raises(FinishValidationError, match="^finish_unusable_measurement$"):
        conclusion(dict(status="candidate", candidate=dict(comparison_id="e3", method="median"),
            evidence_ids=["e1", "e3"], narrative="Proposal only.", questions=[]), result["evidence"], result["comparisons"])


@pytest.mark.parametrize("code,tool,status", [("SENTINEL_PRIVATE", "finish", "error"),
    (None, "finish", "error"), ([], "finish", "error"), ("finish_narrative_empty", "inspect", "error"),
    ("finish_narrative_empty", "finish", "success")])
def test_replay_rejects_unknown_or_misplaced_validation_codes(code, tool, status):
    bundle = run(ScriptedProvider([call("finish", {}, f"c{i}", f"r{i}") for i in range(6)]))
    assert bundle["error"]["category"] == "round_budget_exhausted" and bundle["conclusion"] is None
    replay_investigation(bundle)
    bundle["trace"][0].update(validation_code=code, tool=tool, status=status)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_finish_narrative_and_question_bounds_accept_exact_limits():
    args = dict(status="needs_information", candidate=None, evidence_ids=[], narrative="n" * 1200,
                questions=["q" * 300] * 3)
    result = run(ScriptedProvider([call("finish", args)]))
    assert result["error"] is None and result["conclusion"]["narrative"] == args["narrative"]


def test_bounded_adaptive_investigation_actual_evidence_replay_and_immutability():
    recording = demo_recording("synthetic_drift_noise")
    original = recording.channels["PPG"].copy()
    provider = successful_provider()
    result = run(provider, recording)
    assert result["error"] is None
    assert result["conclusion"]["status"] == "candidate"
    assert result["rounds"] == 4 and result["tool_attempts"] == 3
    proposed = result["conclusion"]["candidate"]
    assert proposed["measurements"] == result["evidence"]["e3"]["metrics"]["median"]
    assert result["comparisons"]["e2"]["recipe"]["reference"] is None
    assert result["comparisons"]["e3"]["recipe"]["parameters"]["median_window_s"] == 3
    replay = replay_investigation(json.loads(json.dumps(result, allow_nan=False)))
    for eid in ("e2", "e3"):
        assert replay["comparisons"][eid]["metrics"] == result["comparisons"][eid]["result"]["metrics"]
    assert replay["historical_conclusion"] == result["conclusion"]
    assert "not revalidated" in replay["label"]
    np.testing.assert_equal(recording.channels["PPG"], original)
    assert provider.requests[0]["context"]["target"] == "pulse_timing"
    assert "Acquired at rest" in provider.requests[0]["context"]["acquisition_notes"]
    assert provider.requests[0]["context"]["question"].startswith("How sensitive")
    assert provider.requests[1]["previous_response_id"] == "r1"


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_optional_history_identity_preserved_and_legacy_identity_accepted(history_mode):
    provider = successful_provider()
    provider.history_mode = history_mode
    bundle = run(provider)
    assert bundle["identity"]["history_mode"] == history_mode
    assert replay_investigation(bundle)["historical_identity"]["history_mode"] == history_mode
    del bundle["identity"]["history_mode"]
    assert "history_mode" not in replay_investigation(bundle)["historical_identity"]


@pytest.mark.parametrize("history_mode", [None, 1, {}, [], "auto", "STATELESS"])
def test_engine_and_replay_reject_malformed_history_identity(history_mode):
    provider = successful_provider()
    provider.history_mode = history_mode
    with pytest.raises(ValueError):
        run(provider)
    bundle = run(successful_provider())
    bundle["identity"]["history_mode"] = history_mode
    with pytest.raises(ValueError):
        replay_investigation(bundle)


@pytest.mark.parametrize("demo", ["synthetic_control", "synthetic_drift_noise", "synthetic_missing_flatline", "bidmc_01"])
def test_outbound_summaries_do_not_leak_references_names_arrays_or_metadata(demo):
    try:
        recording = demo_recording(demo)
    except ValueError:
        pytest.skip("Verified optional BIDMC source absent")
    provider = ScriptedProvider([inspect(), compare(), finish(ids=["e1", "e2"], candidate=dict(comparison_id="e2", method="highpass"))])
    result = run(provider, recording)
    assert result["conclusion"]["status"] == "candidate"
    outbound = json.dumps(provider.requests)
    for forbidden in (demo, recording.name, "synthetic_reference", "provenance", "sha256", "matched_shifts_ms", "reference_count", '"raw"', '"plot"', '"times"', '"reference"'):
        assert forbidden not in outbound
    for request in provider.requests:
        assert request["context"]["evaluation"] == "original_sensitivity"
    assert result["comparisons"]["e2"]["result"]["comparison"] == "original"


@pytest.mark.parametrize("options", [dict(target="sleep"), dict(question=""), dict(question="q"*501), dict(notes="n"*1001),
    dict(start_s=-1), dict(end_s=31), dict(start_s=True), dict(end_s=float("nan")), dict(channel="../../.env")])
def test_invalid_inputs_never_contact_provider(options):
    provider = ScriptedProvider([])
    if options == dict(end_s=31):
        options = dict(end_s=121)
    with pytest.raises(ValueError):
        run(provider, **options)
    assert not provider.requests


@pytest.mark.parametrize("identity", [
    dict(provider="meta", model="other", execution_mode="mocked_test"),
    dict(provider="meta", model="other", execution_mode="live"),
    dict(provider="other", model=MODEL, execution_mode="mocked_test"),
    dict(provider="other", model=MODEL, execution_mode="live"),
    dict(provider="other", model="other", execution_mode="live"),
    dict(provider="meta", model=MODEL, execution_mode="invented"),
])
def test_engine_and_replay_reject_forged_provider_model_combinations(identity):
    provider = ScriptedProvider([])
    provider.provider_name, provider.model, provider.execution_mode = (identity[k] for k in ("provider", "model", "execution_mode"))
    with pytest.raises(ValueError):
        run(provider)
    assert not provider.requests
    bundle = run(successful_provider())
    bundle["identity"] = identity
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("mode", ["live", "mocked_test"])
def test_meta_identity_modes_are_preserved_by_engine_and_replay(mode):
    provider = ScriptedProvider([finish(status="inconclusive")])
    provider.provider_name, provider.model, provider.execution_mode = "meta", MODEL, mode
    bundle = run(provider)
    assert bundle["identity"] == dict(provider="meta", model=MODEL, execution_mode=mode)
    assert replay_investigation(bundle)["historical_identity"] == bundle["identity"]


@pytest.mark.parametrize("bad", [
    call("open_file", {"path": ".env"}),
    call("inspect", dict(start_s=0, end_s=30, path=".env")),
    call("inspect", dict(start_s=-1, end_s=30)),
    call("inspect", dict(start_s=0, end_s=float("nan"))),
    compare(highpass_hz=99),
    call("compare", dict(start_s=0, end_s=30, parameters={"code": "exec"})),
    finish(ids=["forged"], candidate=dict(comparison_id="forged", method="median")),
    finish(ids=[], candidate=dict(comparison_id="e1", method="median")),
    call("finish", dict(status="candidate", evidence_ids=[], candidate=None, narrative="fake", questions=[], measurements={"rmse": 0})),
])
def test_tool_errors_and_forged_conclusions_cannot_succeed(bad):
    provider = ScriptedProvider([bad] * 6)
    result = run(provider)
    assert result["conclusion"] is None and result["error"]
    assert not result["evidence"]
    assert ".env" not in json.dumps(result)


def test_duplicate_ids_and_mixed_finish_are_terminal_without_dispatch():
    mixed = ProviderResponse("r1", (ToolCall("a", "inspect", dict(start_s=0, end_s=30)),
                                   ToolCall("b", "finish", {})))
    result = run(ScriptedProvider([mixed]))
    assert result["error"]["category"] == "mixed_finish_calls" and not result["evidence"]
    duplicate = ProviderResponse("r1", (ToolCall("same", "inspect", {}), ToolCall("same", "compare", {})))
    assert run(ScriptedProvider([duplicate]))["error"]["category"] == "invalid_call_id"
    assert run(ScriptedProvider([inspect(), call("inspect", dict(start_s=0, end_s=30), "c1", "r2")]))["error"]["category"] == "invalid_call_id"


def test_budget_exhaustion_cannot_be_overridden_by_later_finish():
    batch = tuple(ToolCall(f"c{i}", "inspect", dict(start_s=0, end_s=30)) for i in range(9))
    provider = ScriptedProvider([ProviderResponse("r1", batch), finish()])
    result = run(provider)
    assert result["error"]["category"] == "tool_budget_exhausted"
    assert result["tool_attempts"] == 8 and len(result["evidence"]) == 8
    assert result["conclusion"] is None and len(provider.requests) == 1
    provider = ScriptedProvider([inspect(f"c{i}", f"r{i}") for i in range(6)] + [finish()])
    result = run(provider)
    assert result["rounds"] == 6 and result["error"]["category"] == "round_budget_exhausted"
    assert result["conclusion"] is None and len(provider.requests) == 6


@pytest.mark.parametrize("response", [None, {}, ProviderResponse("bad id", ()), ProviderResponse("r", ())])
def test_malformed_response_never_success(response):
    assert run(ScriptedProvider([response]))["error"]["category"] == "invalid_response"


@pytest.mark.parametrize("fill", [np.nan, .75])
def test_no_valid_interior_cannot_support_candidate(fill):
    from signaltrace.availability import AvailabilityError, UNAVAILABLE_MESSAGE
    t = np.arange(3750) / 125
    recording = Recording("local", "ppg", t, {"x": np.full(len(t), fill)}, "a.u.", {})
    provider = ScriptedProvider([inspect(), compare(), finish(ids=["e1", "e2"], candidate=dict(comparison_id="e2", method="median"))])
    with pytest.raises(AvailabilityError) as error:
        run(provider, recording)
    assert str(error.value) == UNAVAILABLE_MESSAGE
    assert error.value.report["valid_count"] == 0 and not provider.requests


def test_information_request_and_inconclusive_are_honest_terminal_states():
    for status, questions in [("needs_information", ["What acquisition motion was observed?"]), ("inconclusive", [])]:
        result = run(ScriptedProvider([finish(status=status, questions=questions)]))
        assert result["conclusion"]["status"] == status and result["error"] is None
        assert not result["comparisons"]
        replay_investigation(result)


def test_inspection_bounds_missing_summary_and_no_valid_statistics():
    t = np.arange(3750) / 125
    raw = np.sin(t)
    raw[:1250:10] = np.nan
    recording = Recording("not-sent", "ppg", t, {"not-sent-channel": raw}, "a.u.", {})
    result = run(ScriptedProvider([inspect(), finish(status="inconclusive", ids=["e1"])]), recording)
    obs = result["evidence"]["e1"]
    assert obs["missing_interval_count"] == 125 and len(obs["missing_intervals"]) == 8
    assert obs["missing_intervals_truncated"]
    replay_investigation(result)


@pytest.mark.parametrize("mutate", [
    lambda b: b["comparisons"]["e2"]["recipe"]["raw"].__setitem__(0, 100),
    lambda b: b["comparisons"]["e2"]["recipe"].__setitem__("reference", [0]*3750),
    lambda b: b["evidence"]["e2"]["metrics"]["median"].__setitem__("matched_count", 999),
    lambda b: b["conclusion"]["candidate"]["measurements"].__setitem__("matched_count", 999),
    lambda b: b["conclusion"]["evidence_ids"].append("nonexistent"),
    lambda b: b["comparisons"].__setitem__("forged", b["comparisons"]["e2"]),
    lambda b: b.__setitem__("rounds", 99),
    lambda b: b["context"].__setitem__("target", "sleep"),
    lambda b: b["identity"].__setitem__("execution_mode", "invented"),
    lambda b: b["identity"].__setitem__("provider", "meta"),
    lambda b: b["identity"].__setitem__("reasoning", "unrecorded"),
    lambda b: b["usage"].__setitem__(0, {"input_tokens": True}),
    lambda b: b.__setitem__("limitations", []),
    lambda b: b["trace"].pop(),
    lambda b: b["trace"][-1].__setitem__("status", "error"),
    lambda b: b.__setitem__("error", {"category": "private-body", "http_status": None}),
    lambda b: b.__setitem__("tool_attempts", 0),
])
def test_replay_rejects_inconsistent_or_tampered_bundles(mutate):
    bundle = run(successful_provider())
    mutate(bundle)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_tool_schemas_fixed_and_strict():
    assert [tool["name"] for tool in TOOLS] == ["inspect", "compare", "regional_summary", "finish", "conclude"]
    assert all(tool["strict"] and tool["parameters"]["additionalProperties"] is False for tool in TOOLS)
    schema = TOOLS[-1]["parameters"]
    assert set(schema["properties"]) == set(schema["required"]) == {"status", "evidence_ids", "narrative", "questions"}
    assert schema["properties"]["status"]["enum"] == ["inconclusive", "needs_information"]


def test_conclude_sensitivity_findings_replay_without_candidate_and_with_detached_progress():
    events = []
    def observer(event):
        events.append(copy.deepcopy(event))
        event["trace"].clear()
    provider = ScriptedProvider([inspect(), compare(), compare("c3", "r3", highpass_hz=.5), conclude(ids=["e1", "e2", "e3"])])
    bundle = run(provider, progress=observer)
    assert bundle["error"] is None and bundle["conclusion"]["status"] == "inconclusive"
    assert bundle["conclusion"]["candidate"] is None and bundle["rounds"] == 4 and bundle["tool_attempts"] == 3
    assert bundle["trace"][-1] == dict(round=4, tool="conclude", status="success", evidence_id=None)
    assert events[-1]["trace"][-1]["tool"] == "conclude"
    replay = replay_investigation(json.loads(json.dumps(bundle, allow_nan=False)))
    assert replay["historical_conclusion"] == bundle["conclusion"]
    assert set(replay["comparisons"]) == {"e2", "e3"}
    outbound = json.dumps(provider.requests)
    for forbidden in ("synthetic_drift_noise", "synthetic_reference", "provenance", "sha256", '"raw"', '"times"', '"reference"'):
        assert forbidden not in outbound


@pytest.mark.parametrize("status,questions", [("inconclusive", []), ("needs_information", ["What preservation criterion should guide review?"])])
def test_conclude_allows_honest_noncomparison_outcomes(status, questions):
    bundle = run(ScriptedProvider([conclude(status, questions=questions)]))
    assert bundle["error"] is None and bundle["conclusion"]["candidate"] is None
    assert bundle["conclusion"]["questions"] == questions and bundle["tool_attempts"] == 0
    replay_investigation(bundle)


@pytest.mark.parametrize("update,code", [
    (lambda a: None, "conclude_invalid_object"),
    (lambda a: {k: v for k, v in a.items() if k != "questions"}, "conclude_missing_fields"),
    (lambda a: {**a, "candidate": None}, "conclude_extra_fields"),
    (lambda a: {**a, "candidate": {"comparison_id": "e2", "method": "median"}}, "conclude_extra_fields"),
    (lambda a: {**a, "measurements": "SENTINEL_PRIVATE"}, "conclude_extra_fields"),
    (lambda a: {**a, "status": "candidate"}, "conclude_invalid_status"),
    (lambda a: {**a, "status": "SENTINEL_PRIVATE"}, "conclude_invalid_status"),
    (lambda a: {**a, "status": ["inconclusive"]}, "conclude_invalid_status"),
    (lambda a: {**a, "status": "needs_information"}, "finish_question_required"),
    (lambda a: {**a, "evidence_ids": ["SENTINEL_PRIVATE"]}, "finish_evidence_unknown"),
    (lambda a: {**a, "evidence_ids": ["e1", "e1"]}, "finish_evidence_duplicate"),
    (lambda a: {**a, "narrative": "SENTINEL_PRIVATE" * 100}, "finish_narrative_too_long"),
    (lambda a: {**a, "questions": ["SENTINEL_PRIVATE" * 30]}, "finish_invalid_questions"),
])
def test_conclude_rejections_are_static_correctable_and_replayable(update, code):
    from signaltrace.investigation import VALIDATION_HINTS
    args = conclude().calls[0].arguments
    provider = ScriptedProvider([inspect(), compare(), call("conclude", update(args), "bad", "bad_response"),
                                 conclude(ids=["e1", "e2"], identifier="fixed", response_id="fixed_response")])
    bundle = run(provider)
    feedback = provider.requests[-1]["tool_outputs"][0]["output"]
    assert feedback["validation_code"] == bundle["trace"][2]["validation_code"] == code
    assert feedback["correction_hint"] == VALIDATION_HINTS[code]
    assert bundle["conclusion"]["candidate"] is None and bundle["tool_attempts"] == 2
    assert "SENTINEL_PRIVATE" not in json.dumps(bundle) + json.dumps(feedback)
    replay_investigation(bundle)


def test_failed_conclude_replays_without_counting_terminal_attempts():
    bundle = run(ScriptedProvider([call("conclude", {}, f"c{i}", f"r{i}") for i in range(6)]))
    assert bundle["conclusion"] is None and bundle["tool_attempts"] == 0
    assert bundle["error"]["category"] == "round_budget_exhausted"
    assert all(event["tool"] == "conclude" and event["validation_code"] == "conclude_missing_fields" for event in bundle["trace"])
    replay_investigation(bundle)


@pytest.mark.parametrize("code", ["SENTINEL_PRIVATE", None, [], "finish_candidate_must_be_null", "finish_invalid_status"])
def test_failed_conclude_replay_rejects_unknown_or_impossible_validation_codes(code):
    bundle = run(ScriptedProvider([call("conclude", {}, f"c{i}", f"r{i}") for i in range(6)]))
    bundle["trace"][0]["validation_code"] = code
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("other", ["finish", "conclude", "inspect", "compare"])
def test_conclude_mixed_calls_fail_before_dispatch(other):
    response = ProviderResponse("r1", (ToolCall("a", "conclude", conclude().calls[0].arguments), ToolCall("b", other, {})))
    bundle = run(ScriptedProvider([response]))
    assert bundle["error"]["category"] == "mixed_finish_calls"
    assert bundle["trace"] == [] and bundle["tool_attempts"] == 0 and bundle["conclusion"] is None
    replay_investigation(bundle)


@pytest.mark.parametrize("terminal", [lambda: conclude(identifier="terminal"), lambda: finish(status="inconclusive", identifier="terminal")])
def test_terminal_still_allowed_after_exactly_eight_tool_attempts(terminal):
    batch = tuple(ToolCall(f"c{i}", "inspect", dict(start_s=0, end_s=30)) for i in range(8))
    provider = ScriptedProvider([ProviderResponse("batch", batch), terminal()])
    bundle = run(provider)
    assert bundle["error"] is None and bundle["tool_attempts"] == 8 and bundle["rounds"] == 2
    assert [request["completion_only"] for request in provider.requests] == [False, True]
    assert "Completion only next round" in provider.requests[-1]["tool_outputs"][0]["output"]["investigation_budget"]["next_action"]
    replay_investigation(bundle)


@pytest.mark.parametrize("terminal", [lambda: conclude(identifier="terminal", response_id="terminal_response"),
    lambda: finish(status="inconclusive", identifier="terminal", response_id="terminal_response")])
def test_sixth_round_reserves_completion_with_immutable_base_contract(terminal):
    provider = ScriptedProvider([inspect(f"c{i}", f"r{i}") for i in range(5)] + [terminal()])
    bundle = run(provider)
    assert bundle["error"] is None and bundle["rounds"] == 6 and bundle["tool_attempts"] == 5
    assert [req["completion_only"] for req in provider.requests] == [False] * 5 + [True]
    assert all(req["tools"] == TOOLS and req["context"] == provider.requests[0]["context"]
               and req["instructions"] == provider.requests[0]["instructions"] for req in provider.requests)
    assert "Completion only next round" in provider.requests[-1]["tool_outputs"][0]["output"]["investigation_budget"]["next_action"]
    replay_investigation(bundle)


@pytest.mark.parametrize("last", [lambda: compare("last", "last_response"),
    lambda: call("unknown", {}, "last", "last_response"),
    lambda: call("conclude", {}, "last", "last_response"),
    lambda: ProviderResponse("last_response", (), message_only=True)])
def test_completion_phase_cannot_execute_analysis_or_fabricate_a_conclusion(last):
    provider = ScriptedProvider([inspect(f"c{i}", f"r{i}") for i in range(5)] + [last()])
    bundle = run(provider)
    assert bundle["conclusion"] is None and bundle["error"]["category"] == "round_budget_exhausted"
    assert len(provider.requests) == 6 and bundle["tool_attempts"] == 5
    assert len(bundle["evidence"]) == 5 and bundle["comparisons"] == {}
    assert provider.requests[-1]["completion_only"] is True
    if bundle["trace"][-1]["tool"] in ("compare", "unsupported"):
        assert bundle["trace"][-1]["error"] == "completion_only_tool_required"
    replay_investigation(bundle)


def test_depleted_budget_rejects_provider_ignoring_completion_phase_without_execution():
    batch = tuple(ToolCall(f"c{i}", "inspect", dict(start_s=0, end_s=30)) for i in range(8))
    provider = ScriptedProvider([ProviderResponse("batch", batch), compare("last", "last_response")])
    bundle = run(provider)
    assert bundle["conclusion"] is None and bundle["error"]["category"] == "tool_budget_exhausted"
    assert bundle["tool_attempts"] == len(bundle["evidence"]) == 8 and not bundle["comparisons"]
    assert provider.requests[-1]["completion_only"] is True and len(provider.requests) == 2
    assert bundle["trace"][-1]["error"] == "completion_only_tool_required"
    replay_investigation(bundle)


def test_early_conclusion_does_not_wait_for_reserved_round():
    provider = ScriptedProvider([conclude()])
    bundle = run(provider)
    assert bundle["error"] is None and bundle["rounds"] == 1 and bundle["tool_attempts"] == 0
    assert provider.requests[0]["completion_only"] is False
    replay_investigation(bundle)


def test_historical_v1_round_six_comparison_and_narrative_replay_unchanged():
    # Existing exports predate completion_only; replay must retain their history.
    bundle = run(successful_provider())
    bundle["schema"] = "signaltrace.investigation.v1"
    bundle["trace"] = bundle["trace"][:-1]
    bundle["trace"][-1]["round"] = 6
    bundle.update(rounds=6, conclusion=None, error=dict(category="round_budget_exhausted", http_status=None))
    bundle["usage"] += [{}] * (6 - len(bundle["usage"]))
    before = copy.deepcopy(bundle)
    replay = replay_investigation(bundle)
    assert bundle == before and set(replay["comparisons"]) == {"e2", "e3"}
    historical = run(successful_provider())
    historical["schema"] = "signaltrace.investigation.v1"
    historical["conclusion"]["narrative"] = "Historical narrative about beats is retained, not revalidated."
    assert replay_investigation(historical)["historical_conclusion"]["narrative"] == historical["conclusion"]["narrative"]


@pytest.mark.parametrize("change", [lambda b: b["trace"][-1].update(round=4),
    lambda b: b["trace"][-1].update(status="success"),
    lambda b: b["trace"][-1].update(tool="finish"),
    lambda b: b["trace"][-1].update(evidence_id="e1"),
    lambda b: b.update(tool_attempts=6),
    lambda b: b["error"].update(category="tool_budget_exhausted")])
def test_completion_denial_replay_rejects_tampering(change):
    bundle = run(ScriptedProvider([inspect(f"c{i}", f"r{i}") for i in range(6)]))
    replay_investigation(bundle)
    change(bundle)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("change", [
    lambda b: b["conclusion"].update(status="candidate"),
    lambda b: b["conclusion"].update(candidate={"comparison_id": "e2", "method": "median"}),
    lambda b: b["trace"][-1].update(evidence_id="e1"),
    lambda b: b["trace"][-1].update(validation_code="conclude_invalid_status"),
    lambda b: b["trace"].insert(-1, dict(round=4, tool="finish", status="error", evidence_id=None)),
    lambda b: b.update(tool_attempts=4),
])
def test_conclude_replay_rejects_tampered_conclusions_and_traces(change):
    bundle = run(ScriptedProvider([inspect(), compare(), compare("c3", "r3"), conclude(ids=["e1", "e2", "e3"])]))
    change(bundle)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_candidate_finish_cannot_be_relabeled_as_successful_conclude():
    bundle = run(successful_provider())
    bundle["trace"][-1]["tool"] = "conclude"
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_invalid_requests_count_toward_budget_and_valid_subset_stays_scoped():
    calls = tuple(ToolCall(f"c{i}", "unknown", {"path": "../../.env"}) for i in range(9))
    result = run(ScriptedProvider([ProviderResponse("r1", calls)]))
    assert result["tool_attempts"] == 8 and result["error"]["category"] == "tool_budget_exhausted"
    assert not result["evidence"] and ".env" not in json.dumps(result)
    replay_investigation(result)
    result = run(ScriptedProvider([call("inspect", dict(start_s=10, end_s=20)), finish(status="inconclusive", ids=["e1"])]))
    assert result["evidence"]["e1"]["sample_count"] == 1250
    assert result["evidence"]["e1"]["window"] == dict(start_s=10, end_s=20)


@pytest.mark.parametrize("flag,calls", [(False, ()), (True, (ToolCall("c", "inspect", {}),)), (1, ()), (None, ())])
def test_engine_requires_explicit_consistent_message_only_boolean(flag, calls):
    result = run(ScriptedProvider([ProviderResponse("r1", calls, message_only=flag)]))
    assert result["error"]["category"] == "invalid_response" and result["conclusion"] is None
    assert result["trace"] == [] and result["tool_attempts"] == 0
    replay_investigation(result)


def message_bundle():
    return run(ScriptedProvider([ProviderResponse(f"r{i}", (), {"output_tokens": 2}, message_only=True) for i in range(6)]))


@pytest.mark.parametrize("change", [
    lambda b: b["trace"][0].update(status="success"),
    lambda b: b["trace"][0].update(error="PRIVATE_ERROR"),
    lambda b: b["trace"][0].update(evidence_id="e1"),
    lambda b: b["trace"][0].update(validation_code="finish_narrative_empty"),
    lambda b: b["trace"][0].update(content="PRIVATE_TEXT"),
    lambda b: b["trace"].insert(0, copy.deepcopy(b["trace"][0])),
    lambda b: b.update(tool_attempts=1),
])
def test_replay_rejects_tampered_model_message_trace(change):
    bundle = message_bundle()
    replay_investigation(bundle)
    change(bundle)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_response_diagnostics_roundtrip_and_legacy_error_compatibility():
    from signaltrace.meta_provider import ProviderError, RESPONSE_CODES
    class Failed(ScriptedProvider):
        def respond(self, **kwargs):
            raise ProviderError("invalid_response", 200, response_code=self.code)
    for code in RESPONSE_CODES:
        provider = Failed([])
        provider.code = code
        bundle = run(provider)
        assert bundle["error"] == dict(category="invalid_response", http_status=200, response_code=code)
        replay_investigation(bundle)
        del bundle["error"]["response_code"]
        replay_investigation(bundle)


@pytest.mark.parametrize("code,category,status", [("PRIVATE_CODE", "invalid_response", 200),
    (None, "invalid_response", 200), ({}, "invalid_response", 200),
    ("invalid_json", "server", 200), ("invalid_json", "invalid_response", None),
    ("invalid_json", "invalid_response", 500), ("invalid_json", "invalid_response", True)])
def test_replay_rejects_unknown_or_misplaced_response_codes(code, category, status):
    bundle = message_bundle()
    bundle["error"] = dict(category=category, http_status=status, response_code=code)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def regional_provider():
    def contrast(request):
        budget = request["tool_outputs"][0]["output"]["investigation_budget"]
        assert budget["unresolved_settings_coverage"] is True
        return compare("contrast", "contrast_response", median_window_s=1.5)
    def region(request):
        budget = request["tool_outputs"][0]["output"]["investigation_budget"]
        assert budget["unresolved_settings_coverage"] is False
        assert [item["comparison_id"] for item in budget["tested_settings"]] == ["e2", "e3"]
        return call("regional_summary", dict(comparison_id="e3", split_s=15.), "region", "region_response")
    def end(request):
        budget = request["tool_outputs"][0]["output"]["investigation_budget"]
        assert budget["regional_summary_ids"] == ["e4"]
        return conclude(ids=["e1", "e2", "e3", "e4"], identifier="end", response_id="end_response")
    return ScriptedProvider([inspect(), compare(), contrast, region, end])


def test_v2_informative_contrast_regional_evidence_and_replay_are_detached():
    provider = regional_provider()
    bundle = run(provider)
    assert bundle["schema"] == "signaltrace.investigation.v2"
    assert bundle["error"] is None and bundle["rounds"] == 5 and bundle["tool_attempts"] == 4
    assert list(bundle["comparisons"]) == ["e2", "e3"]
    assert bundle["trace"][3]["tool"] == "regional_summary"
    region = bundle["evidence"]["e4"]
    assert region["kind"] == "regional_summary" and region["comparison_id"] == "e3"
    assert region["window"] == bundle["evidence"]["e3"]["window"]
    before = copy.deepcopy(bundle)
    replay = replay_investigation(bundle)
    assert replay["schema"] == "signaltrace.investigation-replay.v2"
    assert replay["regional_summaries"] == {"e4": region} and bundle == before
    replay["regional_summaries"]["e4"]["regions"][0]["valid_count"] = -1
    assert bundle == before
    outbound = json.dumps(provider.requests)
    assert '"regional_summary"' in outbound
    assert all(token not in outbound for token in ('"raw"', '"times"', '"matched_shifts_ms"'))
    assert bundle["evidence"]["e2"]["parameters"]["highpass_hz"] == bundle["evidence"]["e3"]["parameters"]["highpass_hz"]


@pytest.mark.parametrize("mutate", [
    lambda b: b["evidence"]["e4"].update(comparison_id="missing"),
    lambda b: b["evidence"]["e4"].update(comparison_id="e1"),
    lambda b: b["evidence"]["e4"].update(comparison_id="e2"),
    lambda b: b["evidence"]["e4"].update(split_s=True),
    lambda b: b["evidence"]["e4"].update(split_s=0.),
    lambda b: b["evidence"]["e4"].update(split_s=30.),
    lambda b: b["evidence"]["e4"].update(assignment="candidate_time"),
    lambda b: b["evidence"]["e4"].update(filtering_context="refiltered_region"),
    lambda b: b["evidence"]["e4"].update(normalization="regional_means"),
    lambda b: b["evidence"]["e4"].update(extra="forged"),
    lambda b: b["evidence"]["e4"]["regions"][0].update(valid_count=99999),
    lambda b: b["evidence"]["e4"]["regions"][0]["metrics"]["median"].update(mean_absolute_shift_ms=999.),
    lambda b: b["evidence"]["e4"]["regions"][0]["metrics"]["median"].update(cross_boundary_pair_count=True),
    lambda b: b["trace"][2].update(tool="regional_summary"),
    lambda b: b["trace"].__setitem__(slice(2, 4), list(reversed(b["trace"][2:4]))),
    lambda b: b.update(evidence={key: b["evidence"][key] for key in ("e1", "e2", "e4", "e3")}),
    lambda b: b.update(schema="signaltrace.investigation.v1"),
    lambda b: b["comparisons"].update(e4=b["comparisons"]["e3"]),
])
def test_v2_replay_rejects_forged_regional_evidence_dependencies_and_policy(mutate):
    bundle = run(regional_provider())
    mutate(bundle)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("arguments", [dict(comparison_id="e1", split_s=15.),
    dict(comparison_id="absent", split_s=15.), dict(comparison_id="e2", split_s=0.),
    dict(comparison_id="e2", split_s=30.), dict(comparison_id="e2", split_s=True),
    dict(comparison_id="e2", split_s=.001), dict(comparison_id="e2", split_s=15., extra="PRIVATE")])
def test_invalid_regional_tool_is_bounded_and_counts_an_attempt(arguments):
    provider = ScriptedProvider([inspect(), compare(), call("regional_summary", arguments, "region", "region_response"),
                                 conclude(identifier="end", response_id="end_response")])
    bundle = run(provider)
    assert bundle["tool_attempts"] == 3 and list(bundle["evidence"]) == ["e1", "e2"]
    assert bundle["trace"][2]["error"] == "invalid_or_unavailable_tool_request"
    assert "PRIVATE" not in json.dumps(bundle) + json.dumps(provider.requests[-1]["tool_outputs"])
    replay_investigation(bundle)


def test_regional_summary_cannot_be_candidate_comparison():
    from signaltrace.investigation import conclusion, FinishValidationError
    bundle = run(regional_provider())
    with pytest.raises(FinishValidationError, match="finish_comparison_unknown"):
        conclusion(dict(status="candidate", candidate=dict(comparison_id="e4", method="median"),
            evidence_ids=["e1", "e4"], narrative="Proposal only.", questions=[]), bundle["evidence"], bundle["comparisons"])


def test_v2_replay_rejects_analysis_in_reserved_round_but_v1_retains_history():
    bundle = run(successful_provider())
    bundle["trace"] = bundle["trace"][:-1]
    bundle["trace"][-1]["round"] = 6
    bundle.update(rounds=6, conclusion=None, error=dict(category="round_budget_exhausted", http_status=None))
    bundle["usage"] += [{}] * (6-len(bundle["usage"]))
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)
    bundle["schema"] = "signaltrace.investigation.v1"
    replay = replay_investigation(bundle)
    assert replay["schema"] == "signaltrace.investigation-replay.v1" and "regional_summaries" not in replay


@pytest.mark.parametrize("exhaustion", ["tools", "rounds"])
def test_completion_only_denies_regional_summary_before_dispatch(monkeypatch, exhaustion):
    import signaltrace.investigation as module
    monkeypatch.setattr(module, "regional_summary", lambda *args: pytest.fail("Completion-only phase dispatched analysis"))
    if exhaustion == "tools":
        responses = [ProviderResponse("r1", tuple(ToolCall(f"c{i}", "inspect", dict(start_s=0., end_s=30.)) for i in range(8)))]
    else:
        responses = [inspect(f"c{i}", f"r{i}") for i in range(5)]
    responses += [call("regional_summary", dict(comparison_id="e1", split_s=15.), "region", "region_response")]
    bundle = run(ScriptedProvider(responses))
    assert bundle["trace"][-1]["tool"] == "regional_summary"
    assert bundle["trace"][-1]["error"] == "completion_only_tool_required"
    assert bundle["tool_attempts"] == (8 if exhaustion == "tools" else 5)
    replay_investigation(bundle)


@pytest.mark.parametrize("case", ["short", "all_missing", "flat", "fragmented"])
def test_unavailable_direct_run_makes_zero_provider_requests(case):
    from signaltrace.availability import AvailabilityError
    t = np.arange(3750) / 125
    x = np.sin(t)
    if case == "all_missing":
        x[:] = np.nan
    elif case == "flat":
        x[:] = .7
    elif case == "fragmented":
        x[::250] = np.nan
    recording = Recording("local", "ppg", t, {"x": x}, "a.u.", {})
    class Untouched:
        def __getattribute__(self, name):
            pytest.fail("Unavailable run inspected or called the provider")
    with pytest.raises(AvailabilityError):
        run(Untouched(), recording, end_s=4. if case == "short" else 30.)


def test_minimum_supported_window_still_reaches_provider_without_quality_claim():
    provider = ScriptedProvider([conclude()])
    bundle = run(provider, end_s=8.)
    assert len(provider.requests) == 1 and bundle["error"] is None
    assert bundle["context"]["sample_count"] == 1000 and not bundle["evidence"]
    replay_investigation(bundle)


def test_historical_v1_unavailable_inspection_replays_without_new_admission_gate():
    from signaltrace.investigation import inspect_summary
    t = np.arange(3750) / 125
    recording = Recording("local", "ppg", t, {"x": np.full(len(t), np.nan)}, "a.u.", {})
    bundle = run(ScriptedProvider([inspect(), conclude(ids=["e1"])]))
    bundle["schema"] = "signaltrace.investigation.v1"
    bundle["evidence"]["e1"] = inspect_summary(recording, "x", dict(start_s=0., end_s=30.))
    before = copy.deepcopy(bundle)
    replay = replay_investigation(bundle)
    assert replay["schema"] == "signaltrace.investigation-replay.v1" and bundle == before
    assert replay["historical_conclusion"] == before["conclusion"] and not replay["comparisons"]


@pytest.mark.parametrize("delay_terminal", [False, True])
def test_v2_replay_rejects_claimed_post_completion_round_and_unobserved_response(delay_terminal):
    bundle = run(regional_provider())
    assert bundle["rounds"] == bundle["trace"][-1]["round"] == 5
    bundle["rounds"] = 6
    bundle["usage"].append({})
    if delay_terminal:
        bundle["trace"][-1]["round"] = 6
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("prior_rounds", [0, 1, 5])
@pytest.mark.parametrize("failure", ["provider", "envelope", "call_id", "mixed_terminal"])
def test_v2_round_chronology_preserves_real_final_provider_and_response_failures(prior_rounds, failure):
    from signaltrace.meta_provider import ProviderError
    responses = [inspect(f"c{i}", f"r{i}") for i in range(prior_rounds)]
    if failure == "provider":
        def failed(request):
            raise ProviderError("server", 503)
        final = failed
    elif failure == "envelope":
        final = None
    elif failure == "call_id":
        final = ProviderResponse("failure_response", (ToolCall("invalid id", "inspect", {}),))
    else:
        final = ProviderResponse("failure_response", (
            ToolCall("analysis_call", "inspect", dict(start_s=0., end_s=30.)),
            ToolCall("terminal_call", "conclude", dict(status="inconclusive", evidence_ids=[], narrative="No preference.", questions=[]))))
    bundle = run(ScriptedProvider([*responses, final]))
    assert bundle["rounds"] == prior_rounds+1 and bundle["conclusion"] is None
    assert len(bundle["trace"]) == prior_rounds
    assert len(bundle["usage"]) == prior_rounds + (failure == "mixed_terminal")
    assert bundle["error"]["category"] == dict(provider="server", envelope="invalid_response",
        call_id="invalid_call_id", mixed_terminal="mixed_finish_calls")[failure]
    before = copy.deepcopy(bundle)
    replay_investigation(bundle)
    assert bundle == before


def test_v2_error_bundle_rejects_skipped_earlier_response_round():
    from signaltrace.meta_provider import ProviderError
    def failed(request):
        raise ProviderError("timeout")
    bundle = run(ScriptedProvider([inspect(), failed]))
    replay_investigation(bundle)
    bundle["rounds"] = 3
    bundle["usage"].append({})
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_v1_historical_round_metadata_remains_unchanged_by_v2_chronology_checks():
    bundle = run(successful_provider())
    bundle["schema"] = "signaltrace.investigation.v1"
    bundle["rounds"] = 6
    bundle["usage"] += [{}] * (6-len(bundle["usage"]))
    before = copy.deepcopy(bundle)
    assert replay_investigation(bundle)["historical_conclusion"] == before["conclusion"]
    assert bundle == before


@pytest.mark.parametrize("category", ["tool_budget_exhausted", "round_budget_exhausted", "mixed_finish_calls"])
def test_v2_replay_rejects_engine_error_category_forged_at_provider_boundary(category):
    # Exact residual reviewer case: only e1/round1 is retained, then an
    # untraced second round falsely claims an engine budget/dispatch failure.
    bundle = run(regional_provider())
    bundle.update(evidence={"e1": bundle["evidence"]["e1"]}, comparisons={},
        trace=bundle["trace"][:1], rounds=2, usage=[{}], tool_attempts=1,
        conclusion=None, error=dict(category=category, http_status=None))
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)
    bundle["schema"] = "signaltrace.investigation.v1"
    replay_investigation(bundle)


@pytest.mark.parametrize("category", ["tool_budget_exhausted", "round_budget_exhausted", "mixed_finish_calls"])
@pytest.mark.parametrize("prior_rounds", [0, 1, 5])
def test_provider_cannot_emit_engine_only_error_categories(category, prior_rounds):
    from signaltrace.meta_provider import ProviderError
    def failed(request):
        raise ProviderError(category)
    provider = ScriptedProvider([*[inspect(f"c{i}", f"r{i}") for i in range(prior_rounds)], failed])
    bundle = run(provider)
    assert bundle["error"] == dict(category="provider_failure", http_status=None)
    assert bundle["rounds"] == prior_rounds+1 and len(bundle["usage"]) == prior_rounds
    replay_investigation(bundle)


@pytest.mark.parametrize("category", ["server", "provider_failure", "invalid_response", "invalid_call_id", "mixed_finish_calls"])
def test_v2_replay_rejects_pre_dispatch_category_with_dispatched_final_response(category):
    bundle = message_bundle()
    bundle["error"] = dict(category=category, http_status=None)
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_v2_tool_budget_requires_actual_denial_after_eighth_attempt():
    calls = tuple(ToolCall(f"c{i}", "inspect", dict(start_s=0., end_s=30.)) for i in range(8))
    bundle = run(ScriptedProvider([ProviderResponse("r1", calls),
                                  conclude(identifier="end", response_id="end_response")]))
    bundle.update(trace=bundle["trace"][:-1], rounds=1, usage=bundle["usage"][:1],
                  conclusion=None, error=dict(category="tool_budget_exhausted", http_status=None))
    assert bundle["tool_attempts"] == 8 and bundle["trace"][-1]["status"] == "success"
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_v2_round_budget_requires_sixth_response_not_early_model_messages():
    bundle = message_bundle()
    bundle.update(rounds=2, usage=bundle["usage"][:2], trace=bundle["trace"][:2])
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


@pytest.mark.parametrize("category", ["tool_budget_exhausted", "round_budget_exhausted", "mixed_finish_calls"])
def test_v2_engine_only_failure_cannot_claim_provider_http_status(category):
    if category == "mixed_finish_calls":
        response = ProviderResponse("r1", (ToolCall("c1", "inspect", dict(start_s=0., end_s=30.)),
            ToolCall("c2", "conclude", {})))
        bundle = run(ScriptedProvider([response]))
    elif category == "tool_budget_exhausted":
        calls = tuple(ToolCall(f"c{i}", "unknown", {}) for i in range(9))
        bundle = run(ScriptedProvider([ProviderResponse("r1", calls)]))
    else:
        bundle = message_bundle()
    replay_investigation(bundle)
    assert bundle["error"]["category"] == category
    bundle["error"]["http_status"] = 503
    with pytest.raises(ValueError, match="Invalid or inconsistent"):
        replay_investigation(bundle)


def test_confirmed_requirements_adaptive_guidance_and_v3_replay_integrity():
    requirements = dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=0., min_usable_fraction=.5))
    provider = ScriptedProvider([inspect(), compare(), conclude(ids=["e1", "e2"], identifier="c3", response_id="r3")])
    bundle = run(provider, requirements=requirements)
    assert bundle["schema"] == "signaltrace.investigation.v3"
    assert bundle["context"]["requirements"] == requirements
    assessment = bundle["requirement_assessment"]
    assert assessment["comparisons"][0]["comparison_id"] == "e2"
    assert assessment["comparisons"][0]["method"] == "highpass"
    guidance = provider.requests[2]["tool_outputs"][0]["output"]["investigation_budget"]
    assert guidance["requirement_assessment"] == assessment
    assert "remaining_requirement_checks" in guidance
    assert replay_investigation(bundle)["requirement_assessment"] == assessment
    altered = copy.deepcopy(bundle)
    altered["requirement_assessment"]["status"] = "not_established" if assessment["status"] != "not_established" else "met"
    with pytest.raises(ValueError):
        replay_investigation(altered)
    altered = copy.deepcopy(bundle)
    altered["context"]["requirements"]["criteria"]["min_usable_fraction"] = .999
    with pytest.raises(ValueError):
        replay_investigation(altered)


def test_requirement_failure_retains_measurements_without_certifying_pass():
    from signaltrace.meta_provider import ProviderError
    def fail(request):
        raise ProviderError("timeout")
    provider = ScriptedProvider([inspect(), compare(), fail])
    bundle = run(provider, requirements=dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=1000)))
    assert bundle["error"]["category"] == "timeout"
    assert bundle["requirement_assessment"]["status"] == "not_established"
    assert len(bundle["requirement_assessment"]["comparisons"]) == 1
    replay_investigation(bundle)


def test_requirement_candidate_wrong_method_is_rejected_with_correction_hint():
    provider = ScriptedProvider([inspect(), compare(),
        finish(ids=["e1", "e2"], candidate=dict(comparison_id="e2", method="unchanged"), identifier="c3", response_id="r3"),
        conclude(ids=["e1", "e2"])])
    bundle = run(provider, requirements=dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=1000)))
    assert bundle["error"] is None
    assert bundle["conclusion"]["candidate"] is None
    correction = provider.requests[3]["tool_outputs"][0]["output"]
    assert correction["validation_code"] == "finish_requirement_method"
    assert "researcher-confirmed" in correction["correction_hint"]
    replay_investigation(bundle)


def test_v3_policy_replay_retains_legacy_assessment_and_rejects_unknown():
    from signaltrace.requirements import assess_requirements
    from signaltrace.investigation_jobs import validate_retained_shape
    provider = ScriptedProvider([inspect(), compare(), conclude(ids=["e1", "e2"], identifier="c3", response_id="r3")])
    bundle = run(provider, requirements=dict(confirmed=True, method="highpass", criteria=dict(max_timing_shift_ms=24)))
    assert bundle["requirement_assessment"]["comparison_policy"] == "float_roundoff_v1"
    validate_retained_shape(bundle)
    assert replay_investigation(bundle)["requirement_assessment"] == bundle["requirement_assessment"]
    legacy = copy.deepcopy(bundle)
    legacy["requirement_assessment"] = assess_requirements(legacy["context"]["requirements"], legacy["evidence"],
        legacy["context"]["window"], comparison_policy="strict_legacy")
    assert "comparison_policy" not in legacy["requirement_assessment"]
    validate_retained_shape(legacy)
    assert replay_investigation(legacy)["requirement_assessment"] == legacy["requirement_assessment"]
    altered = copy.deepcopy(bundle)
    altered["requirement_assessment"]["comparison_policy"] = "unreviewed"
    with pytest.raises(ValueError):
        replay_investigation(altered)
    with pytest.raises(ValueError):
        validate_retained_shape(altered)
