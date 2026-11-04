import json
import httpx
import pytest
from signaltrace.meta_provider import MetaProvider, ProviderError, ENDPOINT, MODEL, MAX_RESPONSE_BYTES
from signaltrace.investigation import TOOLS


def response(**updates):
    payload = dict(id="resp_1", status="completed", model=MODEL, output=[dict(type="function_call", call_id="call_1", name="inspect",
                   arguments=json.dumps(dict(start_s=0, end_s=30)))], usage=dict(input_tokens=12, output_tokens=8, total_tokens=20))
    payload.update(updates)
    return payload


def provider(monkeypatch, handler, **options):
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "FAKE_TEST_PROVIDER_KEY_NEVER_REAL")
    return MetaProvider(allow_network=True, transport=httpx.MockTransport(handler), **options)


def request(p, **extra):
    return p.respond(instructions="repeat these rules", context={"question": "bounded"}, tools=TOOLS, **extra)


def test_wire_contract_continuation_and_no_credentials_in_result(monkeypatch):
    seen = []
    def handler(req):
        assert str(req.url) == ENDPOINT and req.method == "POST"
        assert req.headers["authorization"] == "Bearer FAKE_TEST_PROVIDER_KEY_NEVER_REAL"
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=response(id=f"resp_{len(seen)}", output=[dict(type="function_call",
                              call_id=f"call_{len(seen)}", name="inspect", arguments='{}')]))
    p = provider(monkeypatch, handler)
    assert p.provider_name == "meta" and p.model == MODEL and p.execution_mode == "mocked_test"
    first = request(p)
    assert first.response_id == "resp_1" and first.usage == dict(input_tokens=12, output_tokens=8, total_tokens=20)
    request(p, previous_response_id=first.response_id, tool_outputs=[dict(call_id="call_1", output={"evidence_id": "e1"})])
    for payload in seen:
        assert payload["model"] == MODEL and payload["store"] is True and payload["parallel_tool_calls"] is False
        assert payload["instructions"] == "repeat these rules" and payload["tools"] == TOOLS
        assert payload["max_output_tokens"] == 2048
        assert "tool_choice" not in payload  # Meta currently supports auto only.
    assert "previous_response_id" not in seen[0]
    assert seen[1]["previous_response_id"] == "resp_1"
    assert seen[1]["input"] == [dict(type="function_call_output", call_id="call_1", output='{"evidence_id": "e1"}')]
    assert "FAKE_TEST_PROVIDER_KEY_NEVER_REAL" not in repr(first)


def test_consent_and_missing_key_fail_before_network(monkeypatch):
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY", raising=False)
    with pytest.raises(ProviderError, match="network_not_authorized"):
        MetaProvider()
    with pytest.raises(ProviderError, match="missing_or_invalid_credential"):
        MetaProvider(allow_network=True)


@pytest.mark.parametrize("status,category", [(401, "authentication"), (403, "authentication"), (429, "quota"), (503, "server"),
                                           (302, "redirect_rejected"), (400, "request_rejected")])
def test_status_errors_are_safe_no_retry_no_redirect(monkeypatch, status, category):
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(status, headers={"location": "https://attacker.invalid"}, text="private-body FAKE_TEST_PROVIDER_KEY_NEVER_REAL")
    p = provider(monkeypatch, handler)
    with pytest.raises(ProviderError) as error:
        request(p)
    assert error.value.category == category and error.value.http_status == status
    assert str(error.value) == category and len(seen) == 1


def test_timeout_and_transport_exception_text_not_exposed(monkeypatch):
    for exception, category in [(httpx.ReadTimeout("private key"), "timeout"), (httpx.ConnectError("private key"), "transport")]:
        seen = []
        def handler(req):
            seen.append(req)
            raise exception
        with pytest.raises(ProviderError) as error:
            request(provider(monkeypatch, handler))
        assert str(error.value) == category and len(seen) == 1


@pytest.mark.parametrize("payload", [response(id=123), response(output=[]), response(status="incomplete"), response(status=None), response(model="other-model"), response(model=None), response(output=[{}]),
    response(output=[dict(type="function_call", call_id="bad id", name="inspect", arguments="{}")]),
    response(output=[dict(type="function_call", call_id="c", name="inspect", arguments='{"x":NaN}')]),
    response(output=[dict(type="function_call", call_id="c", name="inspect", arguments='{"x":1,"x":2}')]),
    response(output=[dict(type="function_call", call_id="c", name="inspect", arguments="[]")]),
    response(output=[dict(type="function_call", call_id="c", name="inspect", arguments="{}")]*2)])
def test_malformed_provider_json_is_safe(monkeypatch, payload):
    with pytest.raises(ProviderError, match="invalid_response"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload)))


def test_oversized_response_and_unretained_reasoning(monkeypatch):
    with pytest.raises(ProviderError, match="response_too_large"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, content=b"x"*(MAX_RESPONSE_BYTES+1))))
    payload = response()
    payload["output"].insert(0, dict(type="reasoning", summary="private-hidden-text"))
    result = request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload)))
    assert "private-hidden-text" not in repr(result)


def test_client_security_options_do_not_inherit_proxies(monkeypatch):
    import signaltrace.meta_provider as module
    original = httpx.Client
    configs = []
    def capture(**kwargs):
        configs.append(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(module.httpx, "Client", capture)
    request(provider(monkeypatch, lambda req: httpx.Response(200, json=response())))
    assert configs[0]["trust_env"] is False and configs[0]["follow_redirects"] is False
    assert configs[0]["timeout"].read == 90
    assert configs[0]["timeout"].connect == 10
    assert configs[0]["timeout"].write == configs[0]["timeout"].pool == 90


def test_default_transport_disables_environment_and_retries_without_network(monkeypatch):
    import signaltrace.meta_provider as module
    configs = []
    def transport(**kwargs):
        configs.append(kwargs)
        return httpx.MockTransport(lambda req: httpx.Response(200, json=response()))
    monkeypatch.setattr(module.httpx, "HTTPTransport", transport)
    monkeypatch.setenv("SIGNALTRACE_META_API_KEY", "fake-key")
    p = MetaProvider(allow_network=True)
    assert p.execution_mode == "live"
    request(p)
    assert configs == [dict(retries=0, trust_env=False)]


def test_stream_deadline_and_encoded_responses_fail_safely(monkeypatch):
    import signaltrace.meta_provider as module
    clock = iter([0., 91.])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    with pytest.raises(ProviderError, match="timeout"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=response())))
    monkeypatch.setattr(module.time, "monotonic", lambda: 0.)
    with pytest.raises(ProviderError, match="invalid_response"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"unread"))))


@pytest.mark.parametrize("value", [True, False, "90", None, 9.99, 180.01, float("inf"), float("nan"), 10**1000])
def test_invalid_request_timeout_rejected_before_network(monkeypatch, value):
    with pytest.raises(ProviderError, match="invalid_request_timeout"):
        provider(monkeypatch, lambda req: pytest.fail("No request"), request_timeout_s=value)


@pytest.mark.parametrize("timeout,elapsed,accepted", [(90, 30, True), (45, 44, True), (45, 46, False), (10, 11, False), (180, 179, True)])
def test_selected_elapsed_guard_and_immutable_timeout(monkeypatch, timeout, elapsed, accepted):
    import signaltrace.meta_provider as module
    clock = iter([0., elapsed, elapsed])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    seen = []
    def handler(req):
        seen.append(req)
        assert req.extensions["timeout"] == dict(connect=10., read=float(timeout), write=float(timeout), pool=float(timeout))
        return httpx.Response(200, json=response())
    p = provider(monkeypatch, handler, request_timeout_s=timeout)
    with pytest.raises(AttributeError):
        p.request_timeout_s = 30
    if accepted:
        assert request(p).response_id == "resp_1"
    else:
        with pytest.raises(ProviderError, match="timeout"):
            request(p)
    assert len(seen) == 1


def test_selected_elapsed_guard_is_checked_after_response_chunks(monkeypatch):
    import signaltrace.meta_provider as module
    clock = iter([0., 40., 46.])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(clock))
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=response())
    with pytest.raises(ProviderError, match="timeout"):
        request(provider(monkeypatch, handler, request_timeout_s=45))
    assert len(seen) == 1


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_invalid_finish_corrected_on_sixth_round_over_actual_wire(monkeypatch, history_mode):
    from signaltrace.investigation import investigate, replay_investigation, FINISH_HINTS
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        step = len(seen)
        if step == 1:
            name, args = "inspect", dict(start_s=0, end_s=30)
        elif step in (2, 3, 4):
            name, args = "compare", dict(start_s=0, end_s=30,
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.))
        else:
            name, args = "finish", dict(status="candidate", candidate=dict(comparison_id="e4", method="median"), evidence_ids=["e1", "e4"],
                narrative="Sensitivity does not justify a preference." if step == 6 else "SENTINEL_PRIVATE" * 100, questions=[])
        if step == 6:
            feedback = json.loads(payload["input"][-1]["output"])
            assert feedback["validation_code"] == "finish_narrative_too_long"
            assert feedback["correction_hint"] == FINISH_HINTS["finish_narrative_too_long"]
            assert feedback["investigation_budget"] == dict(remaining_rounds=1, remaining_tool_attempts=4,
                inspection_ids=["e1"], comparison_ids=["e2", "e3", "e4"],
                tested_settings=[dict(comparison_id=eid, window=dict(start_s=0., end_s=30.),
                    parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.))
                    for eid in ("e2", "e3", "e4")],
                regional_summary_ids=[], unresolved_settings_coverage=True,
                next_action="Completion only next round: call conclude alone using existing evidence and limitations, or finish alone for a supported candidate. No analysis calls remain.")
            assert "SENTINEL_PRIVATE" not in json.dumps(feedback)
        return httpx.Response(200, json=response(id=f"r{step}", output=[dict(type="function_call",
            call_id=f"c{step}", name=name, arguments=json.dumps(args))]))
    result = investigate(demo_recording("synthetic_drift_noise"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert len(seen) == 6 and result["error"] is None and result["conclusion"]["status"] == "candidate"
    assert result["conclusion"]["candidate"]["measurements"] == result["evidence"]["e4"]["metrics"]["median"]
    assert result["trace"][-2]["validation_code"] == "finish_narrative_too_long"
    assert "SENTINEL_PRIVATE" not in json.dumps(result)
    assert all(p["instructions"] == seen[0]["instructions"] and "tool_choice" not in p for p in seen)
    assert all(p["tools"] == TOOLS for p in seen[:5])
    assert seen[5]["tools"] == [tool for tool in TOOLS if tool["name"] in ("finish", "conclude")]
    replay_investigation(result)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_mock_wire_runs_actual_tool_loop_exports_and_replays(monkeypatch, tmp_path, history_mode):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.investigate import save_new_json, load_bundle
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        step = len(seen)
        if step == 1:
            name, args = "inspect", dict(start_s=0, end_s=30)
        elif step in (2, 3):
            previous = json.loads(payload["input"][-1]["output"])
            assert previous["evidence_id"] == f"e{step-1}"
            if step == 3:
                assert previous["observation"]["metrics"]["unchanged"]["mean_absolute_shift_ms"] == 0
            name, args = "compare", dict(start_s=0, end_s=30, parameters=dict(median_window_s=float(step), highpass_hz=.35, edge_guard_s=3.))
        else:
            name, args = "finish", dict(status="candidate", candidate=dict(comparison_id="e3", method="median"),
                evidence_ids=["e1", "e3"], narrative="Proposed for researcher review; sensitivity is not accuracy.", questions=[])
        output = [dict(type="function_call", call_id=f"c{step}", name=name, arguments=json.dumps(args))]
        if history_mode == "stateless":
            output.insert(0, dict(type="reasoning", encrypted_content="sensitive-encrypted-marker",
                                  summary=[dict(type="summary_text", text="sensitive-plaintext-marker")]))
        return httpx.Response(200, json=response(id=f"r{step}", output=output))
    p = provider(monkeypatch, handler, history_mode=history_mode)
    recording = demo_recording("synthetic_missing_flatline")
    result = investigate(recording, channel="PPG", question="Preserve pulse timing?", notes="Public demo", target="pulse_timing", start_s=0, end_s=30, provider=p)
    assert result["error"] is None and result["rounds"] == 4
    expected_identity = dict(provider="meta", model=MODEL, execution_mode="mocked_test", history_mode=history_mode)
    assert result["identity"] == expected_identity
    assert result["conclusion"]["candidate"]["comparison_id"] == "e3"
    destination = tmp_path / "investigation.json"
    save_new_json(result, destination)
    exported = load_bundle(destination)
    assert exported["identity"] == expected_identity
    replay = replay_investigation(exported)
    for value in (result, exported, replay):
        assert "sensitive-encrypted-marker" not in json.dumps(value)
        assert "sensitive-plaintext-marker" not in json.dumps(value)
    assert replay["historical_identity"] == expected_identity
    for eid in ("e2", "e3"):
        assert replay["comparisons"][eid]["metrics"] == result["comparisons"][eid]["result"]["metrics"]
    assert all(p["model"] == MODEL and p["instructions"] and p["tools"] for p in seen)
    assert all("synthetic_missing_flatline" not in json.dumps(p) and "matched_shifts_ms" not in json.dumps(p) for p in seen)


def stateless_output(step):
    return response(id=f"r{step}", output=[
        dict(type="reasoning", id="ignored", summary=[dict(type="summary_text", text="private-plaintext")],
             encrypted_content=f"opaque-encrypted-{step}", arbitrary="discard"),
        dict(type="message", role="assistant", phase="commentary", content=[
            dict(type="output_text", text="Inspect the interval.", annotations=["discard"])], arbitrary="discard"),
        dict(type="function_call", id="ignored", call_id=f"c{step}", name="inspect", arguments='{}', arbitrary="discard")])


def test_stateless_wire_preserves_order_pairing_phase_and_only_opaque_reasoning(monkeypatch):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=stateless_output(len(seen)))
    p = provider(monkeypatch, handler, history_mode="stateless")
    first = request(p)
    second = request(p, previous_response_id=first.response_id, tool_outputs=[dict(call_id="c1", output={"evidence_id": "e1"})])
    request(p, previous_response_id=second.response_id, tool_outputs=[dict(call_id="c2", output={"evidence_id": "e2"})])
    for wire in seen:
        assert wire["store"] is False and wire["include"] == ["reasoning.encrypted_content"]
        assert "previous_response_id" not in wire
        assert "private-plaintext" not in json.dumps(wire) and "discard" not in json.dumps(wire)
    assert [i.get("type", i.get("role")) for i in seen[2]["input"]] == [
        "user", "reasoning", "message", "function_call", "function_call_output",
        "reasoning", "message", "function_call", "function_call_output"]
    reasoning = seen[1]["input"][1]
    assert reasoning == dict(type="reasoning", summary=[], encrypted_content="opaque-encrypted-1")
    assert seen[1]["input"][2]["phase"] == "commentary"
    assert "opaque-encrypted" not in repr(first) + repr(second) + repr(p)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_continuations_reject_wrong_ids_outputs_and_context_before_network(monkeypatch, history_mode):
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=response())
    p = provider(monkeypatch, handler, history_mode=history_mode)
    with pytest.raises(ProviderError, match="invalid_continuation"):
        request(p, previous_response_id="resp_1", tool_outputs=[])
    request(p)
    valid = dict(call_id="call_1", output={"evidence_id": "e1"})
    bad = [dict(previous_response_id="wrong", tool_outputs=[valid]),
           dict(previous_response_id="resp_1", tool_outputs=[]),
           dict(previous_response_id="resp_1", tool_outputs=[valid, valid]),
           dict(previous_response_id="resp_1", tool_outputs=[dict(call_id="extra", output={})]),
           dict(previous_response_id="resp_1", tool_outputs=[valid, dict(call_id="extra", output={})])]
    for extra in bad:
        with pytest.raises(ProviderError, match="invalid_continuation"):
            request(p, **extra)
    with pytest.raises(ProviderError, match="invalid_continuation"):
        p.respond(instructions="changed", context={"question": "bounded"}, tools=TOOLS,
                  previous_response_id="resp_1", tool_outputs=[valid])
    assert len(seen) == 1


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_completion_phase_narrows_wire_only_and_cannot_downgrade_or_mutate_contract(monkeypatch, history_mode):
    from copy import deepcopy
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        step = len(seen)
        return httpx.Response(200, json=response(id=f"r{step}", output=[dict(type="function_call",
            call_id=f"c{step}", name="conclude", arguments="{}")]))
    p = provider(monkeypatch, handler, history_mode=history_mode)
    request(p)
    continuation = dict(previous_response_id="r1", tool_outputs=[dict(call_id="c1", output={})], completion_only=True)
    terminal_tools = [tool for tool in TOOLS if tool["name"] in ("finish", "conclude")]
    changed = deepcopy(TOOLS)
    changed[0]["description"] = "changed schema contract"
    for tools in (terminal_tools, list(reversed(TOOLS)), changed):
        with pytest.raises(ProviderError, match="invalid_continuation"):
            p.respond(instructions="repeat these rules", context={"question": "bounded"}, tools=tools, **continuation)
    for extra in (dict(instructions="changed", context={"question": "bounded"}),
                  dict(instructions="repeat these rules", context={"question": "changed"})):
        with pytest.raises(ProviderError, match="invalid_continuation"):
            p.respond(tools=TOOLS, **extra, **continuation)
    assert len(seen) == 1 and not p._completion_only
    request(p, **continuation)
    assert p._completion_only and seen[0]["tools"] == TOOLS and seen[1]["tools"] == terminal_tools
    assert p._contract == json.dumps(["repeat these rules", {"question": "bounded"}, TOOLS], allow_nan=False, sort_keys=True)
    next_outputs = dict(previous_response_id="r2", tool_outputs=[dict(call_id="c2", output={})])
    for invalid_phase in (False, None, 1, "true"):
        with pytest.raises(ProviderError, match="invalid_continuation"):
            request(p, **next_outputs, completion_only=invalid_phase)
    assert len(seen) == 2 and p._previous == "r2"
    request(p, **next_outputs, completion_only=True)
    assert seen[2]["tools"] == terminal_tools
    assert all("tool_choice" not in payload for payload in seen)
    request(p)  # A distinct run resets both history and phase.
    assert not p._completion_only and seen[-1]["tools"] == TOOLS


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("last_kind", ["analysis", "message", "malformed_terminal", "malformed_arguments"])
def test_final_wire_subset_does_not_guarantee_completion_or_allow_extra_analysis(monkeypatch, history_mode, last_kind):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        step = len(seen)
        if step == 6:
            assert payload["tools"] == [tool for tool in TOOLS if tool["name"] in ("finish", "conclude")]
            if last_kind == "message":
                output = [dict(type="message", role="assistant", content=[dict(type="output_text", text="PRIVATE_TEXT")])]
            else:
                name = "compare" if last_kind == "analysis" else "conclude"
                args = dict(start_s=0, end_s=30, parameters=dict(median_window_s=2, highpass_hz=.35, edge_guard_s=3)) if name == "compare" else {}
                output = [dict(type="function_call", call_id=f"c{step}", name=name,
                    arguments="PRIVATE_MALFORMED" if last_kind == "malformed_arguments" else json.dumps(args))]
        else:
            assert payload["tools"] == TOOLS
            output = [dict(type="function_call", call_id=f"c{step}", name="inspect", arguments=json.dumps(dict(start_s=0, end_s=30)))]
        return httpx.Response(200, json=response(id=f"r{step}", output=output))
    result = investigate(demo_recording("synthetic_drift_noise"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert len(seen) == result["rounds"] == 6 and result["tool_attempts"] == len(result["evidence"]) == 5
    assert result["conclusion"] is None and not result["comparisons"]
    assert result["error"]["category"] == ("invalid_response" if last_kind == "malformed_arguments" else "round_budget_exhausted")
    assert "PRIVATE" not in json.dumps(result) and all("tool_choice" not in payload for payload in seen)
    replay_investigation(result)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_exhausted_tool_budget_narrows_actual_wire_before_round_six(monkeypatch, history_mode):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        if len(seen) == 1:
            output = [dict(type="function_call", call_id=f"c{i}", name="inspect", arguments=json.dumps(dict(start_s=0, end_s=30))) for i in range(8)]
        else:
            assert payload["tools"] == [tool for tool in TOOLS if tool["name"] in ("finish", "conclude")]
            output = [dict(type="function_call", call_id="terminal", name="conclude", arguments=json.dumps(dict(
                status="inconclusive", evidence_ids=["e1"], narrative="Counts alone do not establish signal quality.", questions=[])))]
        return httpx.Response(200, json=response(id=f"r{len(seen)}", output=output))
    result = investigate(demo_recording("synthetic_drift_noise"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert result["error"] is None and result["tool_attempts"] == 8 and result["rounds"] == len(seen) == 2
    replay_investigation(result)


def test_stateless_failure_does_not_advance_history_and_new_initial_resets(monkeypatch):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        if len(seen) == 2:
            return httpx.Response(500, text="private body")
        return httpx.Response(200, json=stateless_output(len(seen)))
    p = provider(monkeypatch, handler, history_mode="stateless")
    request(p)
    continuation = dict(previous_response_id="r1", tool_outputs=[dict(call_id="c1", output={"evidence_id": "e1"})])
    with pytest.raises(ProviderError, match="server"):
        request(p, **continuation)
    request(p, **continuation)  # Explicit caller attempt, never automatic.
    assert seen[1] == seen[2]
    with pytest.raises(ProviderError, match="invalid_continuation"):
        request(p, **continuation)
    p.respond(instructions="new rules", context={"question": "different"}, tools=TOOLS)
    assert seen[-1]["input"] == [dict(role="user", content='{"question": "different"}')]
    assert "opaque-encrypted-1" not in json.dumps(seen[-1])


@pytest.mark.parametrize("item", [dict(type="reasoning", summary=["secret"]),
    dict(type="reasoning", encrypted_content=""), dict(type="reasoning", encrypted_content="  "),
    dict(type="reasoning", encrypted_content=123),
    dict(type="message", role="assistant", content=[dict(type="output_text", text="intermediate")]),
    dict(type="unknown", content="arbitrary")])
def test_stateless_unsupported_replay_items_fail_closed(monkeypatch, item):
    payload = response()
    payload["output"].insert(0, item)
    with pytest.raises(ProviderError, match="invalid_response"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload), history_mode="stateless"))


def test_request_history_and_cumulative_bounds_are_enforced(monkeypatch):
    import signaltrace.meta_provider as module
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=stateless_output(len(seen)))
    p = provider(monkeypatch, handler, history_mode="stateless")
    monkeypatch.setattr(module, "MAX_REQUEST_BYTES", 10)
    with pytest.raises(ProviderError, match="request_too_large"):
        request(p)
    assert not seen
    monkeypatch.setattr(module, "MAX_REQUEST_BYTES", 1024 * 1024)
    monkeypatch.setattr(module, "MAX_HISTORY_BYTES", 10)
    with pytest.raises(ProviderError, match="history_too_large"):
        request(p)
    assert p._previous is None and p._history == []
    monkeypatch.setattr(module, "MAX_HISTORY_BYTES", 768 * 1024)
    request(p)
    monkeypatch.setattr(module, "MAX_CUMULATIVE_REQUEST_BYTES", p._request_bytes + 10)
    with pytest.raises(ProviderError, match="request_too_large"):
        request(p, previous_response_id="r2", tool_outputs=[dict(call_id="c2", output={})])
    assert len(seen) == 2 and p._previous == "r2"


def test_stateless_multiple_calls_reorders_outputs_to_exact_call_order(monkeypatch):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        payload = response(id=f"r{len(seen)}")
        payload["output"] = [dict(type="function_call", call_id=f"c{len(seen)}_{i}", name="inspect", arguments='{}') for i in range(2)]
        return httpx.Response(200, json=payload)
    p = provider(monkeypatch, handler, history_mode="stateless")
    request(p)
    request(p, previous_response_id="r1", tool_outputs=[dict(call_id="c1_1", output={"n": 1}), dict(call_id="c1_0", output={"n": 0})])
    assert [i["call_id"] for i in seen[1]["input"][-2:]] == ["c1_0", "c1_1"]


def test_malformed_continuation_response_keeps_committed_history(monkeypatch):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        payload = stateless_output(len(seen))
        if len(seen) == 2:
            payload["output"][-1]["arguments"] = "malformed"
        return httpx.Response(200, json=payload)
    p = provider(monkeypatch, handler, history_mode="stateless")
    request(p)
    continuation = dict(previous_response_id="r1", tool_outputs=[dict(call_id="c1", output={})])
    with pytest.raises(ProviderError, match="invalid_response"):
        request(p, **continuation)
    assert p._previous == "r1"
    request(p, **continuation)
    assert seen[1] == seen[2]


def test_invalid_mode_and_oversized_call_id_rejected(monkeypatch):
    with pytest.raises(ProviderError, match="invalid_history_mode"):
        provider(monkeypatch, lambda req: pytest.fail("No network"), history_mode="automatic")
    payload = response()
    payload["output"][0]["call_id"] = "c" * 65
    with pytest.raises(ProviderError, match="invalid_response"):
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload)))


@pytest.mark.parametrize("reused", ["response_id", "call_id"])
def test_reused_provider_ids_cannot_advance_a_session(monkeypatch, reused):
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=response(id="r1" if reused == "response_id" else f"r{len(seen)}",
            output=[dict(type="function_call", call_id="c1" if reused == "call_id" else f"c{len(seen)}",
                         name="inspect", arguments='{}')]))
    p = provider(monkeypatch, handler, history_mode="stateless")
    request(p)
    with pytest.raises(AttributeError):
        p.history_mode = "stored"
    with pytest.raises(ProviderError, match="invalid_response"):
        request(p, previous_response_id="r1", tool_outputs=[dict(call_id="c1", output={})])
    assert p._previous == "r1" and p._pending == ("c1",)



def text_message(text="PRIVATE_NORMAL_TEXT", **extra):
    return dict(type="message", role="assistant", content=[dict(type="output_text", text=text)], **extra)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("terminal", ["finish", "conclude"])
def test_text_reply_recovers_to_grounded_finish_without_fabricated_tool_output(monkeypatch, tmp_path, history_mode, terminal):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.investigate import save_new_json, load_bundle
    from signaltrace.recordings import demo_recording
    from signaltrace.meta_provider import FINISH_REMINDER
    seen = []
    def handler(req):
        wire = json.loads(req.content)
        seen.append(wire)
        step = len(seen)
        if step == 1:
            name, args = "inspect", dict(start_s=0, end_s=30)
        elif step == 2:
            name, args = "compare", dict(start_s=0, end_s=30,
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.))
        elif step == 3:
            return httpx.Response(200, json=response(id="r3", output=[
                dict(type="reasoning", encrypted_content="PRIVATE_ENCRYPTED", summary=["PRIVATE_SUMMARY"]), text_message()]))
        else:
            assert wire["input"][-1] == dict(role="user", content=FINISH_REMINDER)
            assert "conclude" in FINISH_REMINDER and "finish" in FINISH_REMINDER and "no preferred method" in FINISH_REMINDER
            assert sum(i.get("type") == "function_call_output" for i in wire["input"]) == (2 if history_mode == "stateless" else 0)
            if history_mode == "stored":
                assert wire["previous_response_id"] == "r3" and len(wire["input"]) == 1
            else:
                assert "previous_response_id" not in wire
                assert wire["input"][-2] == text_message()
                assert wire["input"][-3] == dict(type="reasoning", summary=[], encrypted_content="PRIVATE_ENCRYPTED")
                assert "PRIVATE_SUMMARY" not in json.dumps(wire)
            name, args = terminal, dict(status="candidate" if terminal == "finish" else "inconclusive",
                evidence_ids=["e1", "e2"], narrative="Review sensitivity; preservation is unverified.", questions=[])
            if terminal == "finish":
                args["candidate"] = dict(comparison_id="e2", method="median")
        return httpx.Response(200, json=response(id=f"r{step}", output=[dict(type="function_call",
            call_id=f"c{step}", name=name, arguments=json.dumps(args))]))
    result = investigate(demo_recording("synthetic_control"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert result["error"] is None and result["rounds"] == 4 and result["tool_attempts"] == 2
    assert len(result["usage"]) == 4
    assert result["trace"][2] == dict(round=3, tool="model_message", status="error", evidence_id=None, error="finish_tool_required")
    assert all(w["instructions"] == seen[0]["instructions"] and w["tools"] == seen[0]["tools"] and "tool_choice" not in w for w in seen)
    destination = tmp_path / "bundle.json"
    save_new_json(result, destination)
    exported = load_bundle(destination)
    replay = replay_investigation(exported)
    for item in (result, exported, replay):
        assert "PRIVATE_" not in json.dumps(item)
    assert result["trace"][-1]["tool"] == terminal
    if terminal == "finish":
        assert result["conclusion"]["candidate"]["measurements"] == result["evidence"]["e2"]["metrics"]["median"]
    else:
        assert result["conclusion"]["status"] == "inconclusive" and result["conclusion"]["candidate"] is None


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_repeated_text_reply_stays_within_existing_round_budget(monkeypatch, history_mode):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=response(id=f"r{len(seen)}", output=[text_message(phase="commentary")]))
    result = investigate(demo_recording("synthetic_control"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert len(seen) == 6 and result["rounds"] == 6 and len(result["usage"]) == 6
    assert result["error"] == dict(category="round_budget_exhausted", http_status=None)
    assert result["conclusion"] is None and result["tool_attempts"] == 0 and not result["evidence"]
    assert len(result["trace"]) == 6 and all(e["tool"] == "model_message" for e in result["trace"])
    assert not any(i.get("type") == "function_call_output" for wire in seen for i in wire["input"])
    assert "PRIVATE_NORMAL_TEXT" not in json.dumps(result)
    replay_investigation(result)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("payload,code", [
    ([], "invalid_envelope"),
    (response(id="bad id"), "invalid_response_id"),
    (response(status="incomplete", incomplete_details={"reason": "max_output_tokens"}), "incomplete_max_output_tokens"),
    (response(status="incomplete", incomplete_details={"reason": "PRIVATE_REASON"}), "incomplete_other"),
    (response(status="failed"), "failed_response"),
    (response(status="in_progress"), "nonterminal_response"),
    (response(status="queued"), "nonterminal_response"),
    (response(status="cancelled"), "cancelled_response"),
    (response(status="PRIVATE_STATUS"), "unknown_status"),
    (response(model="PRIVATE_MODEL"), "model_mismatch"),
    (response(output={}), "invalid_output_shape"),
    (response(output=[dict(type="PRIVATE_TYPE")]), "unsupported_output_item"),
    (response(output=[]), "no_output"),
    (response(output=[dict(type="function_call", call_id="bad id", name="inspect", arguments="{}")]), "invalid_call_id"),
    (response(output=[dict(type="function_call", call_id="c", name="bad name", arguments="{}")]), "invalid_call_name"),
    (response(output=[dict(type="function_call", call_id="c", name="inspect", arguments="PRIVATE_ARGS")]), "malformed_arguments"),
    (response(output=[text_message(role_override="ignored", phase="final")]), "unsupported_message_phase"),
    (response(output=[dict(type="message", role="user", content=[])]), "invalid_message_shape"),
    (response(output=[dict(type="message", role="assistant", content=[dict(type="refusal", refusal="PRIVATE_REFUSAL")])]), "refusal"),
    (response(output=[dict(type="refusal", refusal="PRIVATE_REFUSAL")]), "refusal"),
    (response(output=[text_message(), *response()["output"]]), "unsupported_message_phase"),
    (response(output=[text_message(status="in_progress")]), "invalid_message_shape"),
    (response(output=[dict(type="message", role="assistant", content=[dict(type="output_text", text="ok"), {}])]), "invalid_message_shape"),
])
def test_fixed_response_codes_preserve_http_without_content_or_retry(monkeypatch, history_mode, payload, code):
    seen = []
    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=payload)
    p = provider(monkeypatch, handler, history_mode=history_mode)
    with pytest.raises(ProviderError) as error:
        request(p)
    assert error.value.category == "invalid_response" and error.value.http_status == 200
    assert error.value.response_code == code and str(error.value) == "invalid_response"
    assert "PRIVATE_" not in repr(error.value) and len(seen) == 1
    assert p._previous is None and p._history == [] and not p._message_pending


@pytest.mark.parametrize("body,code", [(b"bad JSON PRIVATE_BODY", "invalid_json"), (bytes([255]), "invalid_encoding")])
def test_json_and_encoding_codes(monkeypatch, body, code):
    with pytest.raises(ProviderError) as error:
        request(provider(monkeypatch, lambda req: httpx.Response(200, content=body)))
    assert error.value.response_code == code and error.value.http_status == 200


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_message_pending_state_rejects_outputs_contract_changes_and_stale_ids_atomically(monkeypatch, history_mode):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        output = [text_message()]
        if len(seen) == 2:
            output.append(dict(type="message", role="assistant", content=[dict(type="refusal", refusal="PRIVATE_REFUSAL")]))
        return httpx.Response(200, json=response(id=f"r{len(seen)}", output=output))
    p = provider(monkeypatch, handler, history_mode=history_mode)
    first = request(p)
    assert first.calls == () and first.message_only is True and "PRIVATE_" not in repr(first)
    for extra in (dict(previous_response_id="stale"), dict(previous_response_id="r1", tool_outputs=[dict(call_id="fake", output={})])):
        with pytest.raises(ProviderError, match="invalid_continuation"):
            request(p, **extra)
    with pytest.raises(ProviderError, match="invalid_continuation"):
        p.respond(instructions="changed", context={"question": "bounded"}, tools=TOOLS, previous_response_id="r1")
    assert len(seen) == 1
    with pytest.raises(ProviderError) as error:
        request(p, previous_response_id="r1")
    assert error.value.response_code == "refusal" and p._previous == "r1" and p._message_pending
    request(p, previous_response_id="r1")  # Explicit caller invocation after failure, never an automatic retry.
    assert seen[1] == seen[2]
    with pytest.raises(ProviderError, match="invalid_continuation"):
        request(p, previous_response_id="r1")
    request(p)  # New initial resets all private history.
    assert seen[-1]["input"] == seen[0]["input"] and p._previous == "r4"
    other = provider(monkeypatch, lambda req: pytest.fail("No network"), history_mode=history_mode)
    with pytest.raises(ProviderError, match="invalid_continuation"):
        request(other, previous_response_id="r4")


def test_response_code_constructor_allows_only_known_static_values():
    from signaltrace.meta_provider import RESPONSE_CODES
    for code in RESPONSE_CODES:
        assert ProviderError("invalid_response", 200, response_code=code).response_code == code
    for code in ("PRIVATE_ERROR", {}, [], 123):
        with pytest.raises(ValueError, match="invalid_response_code"):
            ProviderError("invalid_response", 200, response_code=code)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("phase", [None, "commentary", "omitted"])
def test_normal_text_phase_variants_are_recovered_without_leaking(monkeypatch, history_mode, phase):
    seen = []
    message = text_message(**({} if phase == "omitted" else dict(phase=phase)))
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=response(id=f"r{len(seen)}", output=[message]))
    p = provider(monkeypatch, handler, history_mode=history_mode)
    first = request(p)
    assert first.message_only
    request(p, previous_response_id="r1")
    if history_mode == "stateless":
        replayed = seen[1]["input"][-2]
        assert ("phase" in replayed) == (phase == "commentary")
        if phase == "commentary":
            assert replayed["phase"] == "commentary"
    assert "PRIVATE_" not in repr(first)


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_position_aware_message_phase_preserves_call_and_trailing_text_order(monkeypatch, history_mode):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=response(id=f"r{len(seen)}", output=[
            text_message(phase="commentary"),
            dict(type="function_call", call_id=f"c{len(seen)}", name="inspect", arguments="{}"),
            text_message(phase=None)]))
    p = provider(monkeypatch, handler, history_mode=history_mode)
    first = request(p)
    assert not first.message_only and len(first.calls) == 1
    request(p, previous_response_id="r1", tool_outputs=[dict(call_id="c1", output={})])
    if history_mode == "stateless":
        assert seen[1]["input"][1:4] == [text_message(phase="commentary"),
            dict(type="function_call", call_id="c1", name="inspect", arguments="{}"), text_message()]
    rejected = response(output=[text_message(), *response()["output"]])
    with pytest.raises(ProviderError) as error:
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=rejected), history_mode=history_mode))
    assert error.value.response_code == "unsupported_message_phase"


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_valid_finish_plus_trailing_text_accepts_only_the_structured_conclusion(monkeypatch, history_mode):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    payload = response(output=[dict(type="function_call", call_id="c1", name="finish", arguments=json.dumps(dict(
        status="inconclusive", candidate=None, evidence_ids=[], narrative="No supported proposal.", questions=[]))), text_message()])
    result = investigate(demo_recording("synthetic_control"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30,
        provider=provider(monkeypatch, lambda req: httpx.Response(200, json=payload), history_mode=history_mode))
    assert result["error"] is None and result["conclusion"]["narrative"] == "No supported proposal."
    assert "PRIVATE_" not in json.dumps(result) and len(result["trace"]) == 1
    replay_investigation(result)


def test_stateless_reasoning_without_encrypted_content_has_fixed_code(monkeypatch):
    payload = response(output=[dict(type="reasoning", summary=["PRIVATE_REASONING"]), text_message()])
    with pytest.raises(ProviderError) as error:
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload), history_mode="stateless"))
    assert error.value.response_code == "missing_encrypted_reasoning" and error.value.http_status == 200


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("payload,code", [
    (response(status="incomplete", incomplete_details={"reason": "max_output_tokens"}, output=[text_message()]), "incomplete_max_output_tokens"),
    (response(output=[text_message(), dict(type="refusal", refusal="PRIVATE_REFUSAL")]), "refusal"),
    (response(output=[text_message(), dict(type="message", role="assistant", content=[{}])]), "invalid_message_shape"),
])
def test_incomplete_refusal_and_partial_malformed_text_never_enter_recovery(monkeypatch, history_mode, payload, code):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=payload)
    result = investigate(demo_recording("synthetic_control"), channel="PPG", question="Timing?", notes="",
        target="pulse_timing", start_s=0, end_s=30, provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert len(seen) == 1 and result["error"] == dict(category="invalid_response", http_status=200, response_code=code)
    assert result["conclusion"] is None and result["trace"] == [] and result["usage"] == []
    assert "PRIVATE_" not in json.dumps(result)
    replay_investigation(result)


def test_content_encoding_diagnostic_does_not_read_body(monkeypatch):
    with pytest.raises(ProviderError) as error:
        request(provider(monkeypatch, lambda req: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"PRIVATE_BODY"))))
    assert error.value.http_status == 200 and error.value.response_code == "invalid_encoding"


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_refusal_content_cannot_hide_beside_valid_calls(monkeypatch, history_mode):
    payload = response(output=[*response()["output"], dict(type="message", role="assistant", content=[dict(type="refusal", refusal="PRIVATE_REFUSAL")])])
    with pytest.raises(ProviderError) as error:
        request(provider(monkeypatch, lambda req: httpx.Response(200, json=payload), history_mode=history_mode))
    assert error.value.response_code == "refusal"


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_regional_summary_roundtrip_over_mocked_wire_keeps_existing_caps(monkeypatch, history_mode):
    from signaltrace.investigation import investigate, replay_investigation
    from signaltrace.recordings import demo_recording
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        step = len(seen)
        assert payload["max_output_tokens"] == 2048
        assert payload["tools"] == TOOLS
        schema = next(tool["parameters"] for tool in payload["tools"] if tool["name"] == "regional_summary")
        assert set(schema["properties"]) == set(schema["required"]) == {"comparison_id", "split_s"}
        if step == 1:
            name, args = "inspect", dict(start_s=0., end_s=30.)
        elif step == 2:
            name, args = "compare", dict(start_s=0., end_s=30.,
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.))
        elif step == 3:
            name, args = "regional_summary", dict(comparison_id="e2", split_s=15.)
        else:
            previous = json.loads(payload["input"][-1]["output"])
            assert previous["observation"]["kind"] == "regional_summary"
            assert previous["observation"]["comparison_id"] == "e2"
            assert previous["investigation_budget"]["regional_summary_ids"] == ["e3"]
            assert "raw" not in previous["observation"] and "plot" not in previous["observation"]
            name, args = "conclude", dict(status="inconclusive", evidence_ids=["e1", "e2", "e3"],
                narrative="Regional sensitivity does not establish cause or preference.", questions=[])
        return httpx.Response(200, json=response(id=f"r{step}", output=[dict(type="function_call",
            call_id=f"c{step}", name=name, arguments=json.dumps(args))]))
    bundle = investigate(demo_recording("synthetic_control"), channel="PPG", question="Does sensitivity vary across this interval?",
        notes="", target="pulse_timing", start_s=0., end_s=30.,
        provider=provider(monkeypatch, handler, history_mode=history_mode))
    assert bundle["error"] is None and bundle["rounds"] == 4 and bundle["tool_attempts"] == 3
    assert replay_investigation(bundle)["regional_summaries"]["e3"] == bundle["evidence"]["e3"]


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
@pytest.mark.parametrize("configured_limit", [None, 8192])
def test_instance_output_allowance_initial_continuation_reset_and_isolation(
        monkeypatch, history_mode, configured_limit):
    import signaltrace.meta_provider as module
    seen = []
    def handler(req):
        payload = json.loads(req.content)
        seen.append(payload)
        step = len(seen)
        assert str(req.url) == ENDPOINT
        assert req.extensions["timeout"] == dict(connect=10., read=90., write=90., pool=90.)
        return httpx.Response(200, json=response(id=f"budget_resp_{step}", output=[
            dict(type="reasoning", encrypted_content="PRIVATE_OPAQUE_TEST_REASONING", summary=[]),
            dict(type="function_call", call_id=f"budget_call_{step}", name="inspect", arguments="{}")]))
    options = {} if configured_limit is None else dict(max_output_tokens=configured_limit)
    selected = provider(monkeypatch, handler, history_mode=history_mode, **options)
    ordinary = provider(monkeypatch, handler, history_mode=history_mode)
    expected = 2048 if configured_limit is None else configured_limit
    assert selected.max_output_tokens == expected and ordinary.max_output_tokens == 2048
    assert module.MAX_OUTPUT_TOKENS == 2048
    with pytest.raises(AttributeError):
        selected.max_output_tokens = 1

    first = request(selected)
    first_default = request(ordinary)
    request(selected, previous_response_id=first.response_id,
            tool_outputs=[dict(call_id=first.calls[0].call_id, output={})])
    request(ordinary, previous_response_id=first_default.response_id,
            tool_outputs=[dict(call_id=first_default.calls[0].call_id, output={})])
    request(selected)  # A new initial request resets history, never instance configuration.
    request(ordinary)
    assert [wire["max_output_tokens"] for wire in seen] == [expected, 2048, expected, 2048, expected, 2048]
    assert all(wire["store"] is (history_mode == "stored") for wire in seen)
    assert all(wire["tools"] == TOOLS and wire["parallel_tool_calls"] is False for wire in seen)
    if history_mode == "stateless":
        assert all(wire["include"] == ["reasoning.encrypted_content"] for wire in seen)
        assert all("previous_response_id" not in wire for wire in seen)
    else:
        assert seen[2]["previous_response_id"] == first.response_id
    assert len(seen[4]["input"]) == len(seen[5]["input"]) == 1
    assert selected.max_output_tokens == expected and ordinary.max_output_tokens == module.MAX_OUTPUT_TOKENS


@pytest.mark.parametrize("value", [0, -1, 1, 15, 8193, True, False, 1., 8192., "8192", None, [], {},
                                  float("nan"), float("inf")])
def test_invalid_output_allowance_is_fixed_value_error_before_any_transport(monkeypatch, value):
    monkeypatch.delenv("SIGNALTRACE_META_API_KEY", raising=False)
    transport = httpx.MockTransport(lambda req: pytest.fail("Invalid configuration contacted transport"))
    with pytest.raises(ValueError) as error:
        MetaProvider(allow_network=True, transport=transport, max_output_tokens=value)
    assert type(error.value) is ValueError and str(error.value) == "invalid_max_output_tokens"


def test_minimum_output_allowance_is_valid_and_readonly(monkeypatch):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200, json=response())
    selected = provider(monkeypatch, handler, max_output_tokens=16)
    request(selected)
    assert selected.max_output_tokens == seen[0]["max_output_tokens"] == 16
    with pytest.raises(AttributeError):
        selected.max_output_tokens = 8192


@pytest.mark.parametrize("failure", ["response_bytes", "arguments"])
def test_larger_output_allowance_keeps_existing_byte_and_argument_limits(monkeypatch, failure):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        if failure == "response_bytes":
            return httpx.Response(200, content=b"x" * (MAX_RESPONSE_BYTES + 1))
        return httpx.Response(200, json=response(output=[dict(type="function_call", call_id="oversized_args",
            name="inspect", arguments=json.dumps(dict(value="x" * 8192)))]))
    selected = provider(monkeypatch, handler, max_output_tokens=8192)
    with pytest.raises(ProviderError) as error:
        request(selected)
    assert len(seen) == 1 and seen[0]["max_output_tokens"] == 8192
    if failure == "response_bytes":
        assert error.value.category == "response_too_large"
    else:
        assert error.value.category == "invalid_response" and error.value.response_code == "malformed_arguments"


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_omitted_and_explicit_none_reasoning_have_identical_legacy_wire(monkeypatch, history_mode):
    def run(**configuration):
        seen = []
        def handler(req):
            seen.append(req.content)
            step = len(seen)
            return httpx.Response(200, json=response(id=f"parity_resp_{step}", output=[
                dict(type="reasoning", encrypted_content="PRIVATE_PARITY_REASONING", summary=[]),
                dict(type="function_call", call_id=f"parity_call_{step}", name="inspect", arguments="{}")]))
        selected = provider(monkeypatch, handler, history_mode=history_mode, **configuration)
        first = request(selected)
        request(selected, previous_response_id=first.response_id,
                tool_outputs=[dict(call_id=first.calls[0].call_id, output={})])
        request(selected)
        assert selected.reasoning_effort is None
        with pytest.raises(AttributeError):
            selected.reasoning_effort = "low"
        return seen

    omitted, explicit = run(), run(reasoning_effort=None)
    assert omitted == explicit and omitted[0] == omitted[2]
    initial = dict(model=MODEL, instructions="repeat these rules",
        input=[dict(role="user", content=json.dumps({"question": "bounded"}))],
        tools=TOOLS, max_output_tokens=2048, parallel_tool_calls=False, store=history_mode == "stored")
    if history_mode == "stateless":
        initial["include"] = ["reasoning.encrypted_content"]
    assert omitted[0] == json.dumps(initial, allow_nan=False).encode("utf-8")
    continuation = dict(initial)
    output = dict(type="function_call_output", call_id="parity_call_1", output="{}")
    if history_mode == "stored":
        continuation["input"] = [output]
        continuation["previous_response_id"] = "parity_resp_1"
    else:
        continuation["input"] = [*initial["input"],
            dict(type="reasoning", summary=[], encrypted_content="PRIVATE_PARITY_REASONING"),
            dict(type="function_call", call_id="parity_call_1", name="inspect", arguments="{}"), output]
    assert omitted[1] == json.dumps(continuation, allow_nan=False).encode("utf-8")
    for raw in omitted:
        wire = json.loads(raw)
        assert "reasoning" not in wire and "reasoning_effort" not in wire


@pytest.mark.parametrize("history_mode", ["stored", "stateless"])
def test_low_reasoning_is_nested_readonly_reset_safe_and_instance_isolated(monkeypatch, history_mode):
    seen = []
    def handler(req):
        seen.append(json.loads(req.content))
        step = len(seen)
        assert str(req.url) == ENDPOINT and req.method == "POST"
        assert req.extensions["timeout"] == dict(connect=10., read=90., write=90., pool=90.)
        return httpx.Response(200, json=response(id=f"effort_resp_{step}", output=[
            dict(type="reasoning", encrypted_content="PRIVATE_EFFORT_REASONING", summary=[]),
            dict(type="function_call", call_id=f"effort_call_{step}", name="inspect", arguments="{}")]))
    low = provider(monkeypatch, handler, history_mode=history_mode, reasoning_effort="low")
    ordinary = provider(monkeypatch, handler, history_mode=history_mode)
    assert low.reasoning_effort == "low" and ordinary.reasoning_effort is None
    with pytest.raises(AttributeError):
        low.reasoning_effort = None
    first_low, first_default = request(low), request(ordinary)
    request(low, previous_response_id=first_low.response_id,
            tool_outputs=[dict(call_id=first_low.calls[0].call_id, output={})])
    request(ordinary, previous_response_id=first_default.response_id,
            tool_outputs=[dict(call_id=first_default.calls[0].call_id, output={})])
    request(low)
    request(ordinary)
    for index, wire in enumerate(seen):
        assert "reasoning_effort" not in wire and wire["max_output_tokens"] == 2048
        assert wire["store"] is (history_mode == "stored")
        if index % 2 == 0:
            assert wire["reasoning"] == {"effort": "low"}
        else:
            assert "reasoning" not in wire
        if history_mode == "stateless":
            assert wire["include"] == ["reasoning.encrypted_content"]
    assert low.reasoning_effort == "low" and ordinary.reasoning_effort is None
    assert len(seen[4]["input"]) == len(seen[5]["input"]) == 1


@pytest.mark.parametrize("value", ["none", "minimal", "medium", "high", "LOW", " low", "low ",
                                  True, False, 0, 1, 1., [], {}, b"low",
                                  type("StringSubclass", (str,), {})("low")])
def test_invalid_reasoning_effort_is_rejected_before_credential_lookup_or_transport(monkeypatch, value):
    from types import SimpleNamespace
    import signaltrace.meta_provider as module
    def forbidden_lookup(*args, **kwargs):
        pytest.fail("Invalid reasoning configuration looked up credentials")
    monkeypatch.setattr(module, "os", SimpleNamespace(environ=SimpleNamespace(get=forbidden_lookup)))
    transport = httpx.MockTransport(lambda req: pytest.fail("Invalid reasoning configuration contacted transport"))
    with pytest.raises(ValueError) as error:
        MetaProvider(allow_network=True, transport=transport, reasoning_effort=value)
    assert type(error.value) is ValueError and str(error.value) == "invalid_reasoning_effort"


@pytest.mark.parametrize("limit_name", ["MAX_REQUEST_BYTES", "MAX_CUMULATIVE_REQUEST_BYTES"])
def test_nested_reasoning_is_counted_before_request_byte_admission(monkeypatch, limit_name):
    import signaltrace.meta_provider as module
    seen = []
    def handler(req):
        seen.append(req.content)
        return httpx.Response(200, json=response())
    request(provider(monkeypatch, handler))
    default_size = len(seen[0])
    monkeypatch.setattr(module, limit_name, default_size)
    request(provider(monkeypatch, handler))  # Unchanged default wire still fits exactly.
    low = provider(monkeypatch, handler, reasoning_effort="low")
    with pytest.raises(ProviderError, match="request_too_large"):
        request(low)
    assert len(seen) == 2 and low._request_bytes == 0



