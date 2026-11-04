"""Candidate markers use retained full-window arrays, never filtered excerpts."""
from copy import deepcopy
from dataclasses import asdict
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from signaltrace import server
from signaltrace.analysis import MAX_ANALYSIS_SAMPLES, calculate
from signaltrace.candidate_evidence import CandidateEvidenceError, METHODS, candidate_evidence
from signaltrace.core import Parameters, compare, support, synthetic
from signaltrace.investigation_jobs import JobError


def toy_result(*, synthetic_reference=False):
    t, reference, cases = synthetic(duration_s=30, fs=100)
    return calculate(t, cases["synthetic_drift_noise"], reference if synthetic_reference else None,
                     goal="pulse_timing", window=dict(start_s=0., end_s=30.),
                     parameter_values={}, provenance={})


def retained_plot(t, raw, candidate, reference=None):
    """A valid retained detector result, without requiring filtering in a fixture."""
    p = Parameters()
    mask, details = support(t, raw, p)
    processed = {"unchanged": raw, "median": candidate, "highpass": candidate}
    evaluation = raw if reference is None else reference
    finite = lambda values: [float(v) if np.isfinite(v) else None for v in values]
    return dict(comparison="original" if reference is None else "synthetic_reference",
                window=dict(start_s=float(t[0]), end_s=float(t[-1]+.01)),
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.),
                exclusions=details, provenance=dict(deterministic_core_parameters=asdict(p)),
                plot=dict(times=t.tolist(), raw=finite(raw), reference=None if reference is None else finite(reference),
                          valid_mask=mask.tolist(),
                          **{k: finite(np.where(mask, v, np.nan)) for k, v in processed.items()}),
                metrics={k: compare(t, evaluation, v, mask, p) for k, v in processed.items()})


def assert_reconciles(parent, annotation):
    t = np.asarray(parent["plot"]["times"])
    refs = annotation["reference_indices"]
    intervals = annotation["valid_intervals_indices"]
    assert refs == sorted(set(refs))
    for name, method in annotation["methods"].items():
        candidates, pairs = method["candidate_indices"], method["pairs"]
        metric = parent["metrics"][name]
        assert candidates == sorted(set(candidates))
        assert len(refs) == metric["reference_count"]
        assert len(candidates) == metric["candidate_count"]
        assert len(pairs) == metric["matched_count"]
        assert len(refs)-len(pairs) == metric["unmatched_reference_count"]
        assert len(candidates)-len(pairs) == metric["unmatched_candidate_count"]
        assert [i for i, j in pairs] == sorted(set(i for i, j in pairs))
        assert [j for i, j in pairs] == sorted(set(j for i, j in pairs))
        for i, j in pairs:
            assert i in refs and j in candidates
            assert abs(t[j]-t[i]) <= annotation["detector"]["match_tolerance_s"]
            assert any(a <= i < b and a <= j < b for a, b in intervals)
        shifts = [1000*float(t[j]-t[i]) for i, j in pairs]
        assert shifts == metric["matched_shifts_ms"]
        assert (float(np.mean(np.abs(shifts))) if shifts else None) == metric["mean_absolute_shift_ms"]
        assert (float(np.max(np.abs(shifts))) if shifts else None) == metric["maximum_absolute_shift_ms"]


@pytest.mark.parametrize("synthetic_reference", [False, True])
def test_full_parent_counts_shifts_and_comparator_reproduce_without_filtering(monkeypatch, synthetic_reference):
    parent = toy_result(synthetic_reference=synthetic_reference)
    before = deepcopy(parent)

    def forbidden(*args, **kwargs):
        pytest.fail("Candidate annotations must not filter or prepare samples")

    monkeypatch.setattr("signaltrace.core.prepare", forbidden)
    monkeypatch.setattr("signaltrace.core.signal.sosfiltfilt", forbidden)
    monkeypatch.setattr("signaltrace.core.ndimage.median_filter", forbidden)
    annotation = candidate_evidence("e3", parent)
    assert annotation["schema"] == "signaltrace.candidate-evidence.v1"
    assert annotation["comparison_id"] == "e3"
    assert annotation["comparator"] == ("synthetic_reference" if synthetic_reference else "original")
    assert annotation["sample_count"] == len(parent["plot"]["times"])
    assert annotation["parameters"] == parent["parameters"]
    assert annotation["detector"] == parent["exclusions"]["parameters"]
    assert annotation["valid_intervals_indices"] == parent["exclusions"]["valid_intervals_indices"]
    assert set(annotation) == {"schema", "comparison_id", "comparator", "sample_count", "window", "parameters",
                               "detector", "valid_intervals_indices", "reference_indices", "methods"}
    assert_reconciles(parent, annotation)
    assert parent == before
    annotation["window"]["start_s"] = 999
    assert parent == before
    json.dumps(annotation, allow_nan=False)


def test_synthetic_reference_indices_follow_evaluator_only_comparator():
    t = np.arange(2000)/100
    wave = lambda centers: .001*t + sum(np.exp(-((t-center)/.05)**2) for center in centers)
    raw, reference = wave([4., 6., 8., 10., 12., 14.]), wave([4.08, 6.08, 8.08, 10.08, 12.08, 14.08])
    parent = retained_plot(t, raw, raw, reference)
    annotation = candidate_evidence("e2", parent)
    assert annotation["reference_indices"] == [408, 608, 808, 1008, 1208, 1408]
    assert annotation["methods"]["unchanged"]["candidate_indices"] == [400, 600, 800, 1000, 1200, 1400]
    assert_reconciles(parent, annotation)


def test_missing_flat_and_timestamp_gap_support_never_pairs_across_segments():
    t, reference, cases = synthetic(duration_s=100, fs=100)
    t[6000:] += .5
    parent = calculate(t, cases["synthetic_missing_flatline"], None, goal="pulse_timing",
                       window=dict(start_s=0., end_s=100.5), parameter_values={}, provenance={})
    annotation = candidate_evidence("e4", parent)
    assert len(annotation["valid_intervals_indices"]) == 4
    assert parent["exclusions"]["nonfinite_count"] > 0
    assert parent["exclusions"]["flatline_count"] > 0
    assert parent["exclusions"]["gap_after_indices"] == [5999]
    assert_reconciles(parent, annotation)
    for method in METHODS:
        assert all(parent["plot"]["valid_mask"][i] for i in annotation["methods"][method]["candidate_indices"])


def test_missing_matches_keep_unavailable_timing_and_flat_candidates_are_empty():
    t = np.arange(2000)/100
    parent = retained_plot(t, np.sin(2*np.pi*t), np.ones(len(t)))
    annotation = candidate_evidence("e2", parent)
    assert annotation["reference_indices"]
    for name in ("median", "highpass"):
        assert annotation["methods"][name] == dict(candidate_indices=[], pairs=[])
        assert parent["metrics"][name]["mean_absolute_shift_ms"] is None
        assert parent["metrics"][name]["maximum_absolute_shift_ms"] is None
    assert_reconciles(parent, annotation)
    parent["metrics"]["median"]["mean_absolute_shift_ms"] = 0
    with pytest.raises(CandidateEvidenceError, match="timing disagrees"):
        candidate_evidence("e2", parent)
    del parent["metrics"]["median"]["mean_absolute_shift_ms"]
    with pytest.raises(CandidateEvidenceError, match="Invalid retained candidate metrics"):
        candidate_evidence("e2", parent)


def change(parent, path, value):
    obj = parent
    for key in path[:-1]:
        obj = obj[key]
    obj[path[-1]] = value


@pytest.mark.parametrize("path,value", [
    (("window", "start_s"), True), (("window", "end_s"), 20.),
    (("parameters", "highpass_hz"), True), (("parameters", "highpass_hz"), 1.),
    (("comparison",), "SENTINEL_PRIVATE_INPUT"), (("plot", "reference"), [0.]*3000),
    (("plot", "times", 10), .0), (("plot", "times", 10), True),
    (("plot", "raw", 400), float("inf")), (("plot", "raw", 400), "SENTINEL_PRIVATE_INPUT"),
    (("plot", "raw", 400), None), (("plot", "valid_mask", 400), 1),
    (("plot", "valid_mask", 400), False), (("plot", "median", 400), None),
    (("plot", "unchanged", 400), 99.), (("plot", "median", 0), 0.),
    (("exclusions", "sample_count"), 2999), (("exclusions", "valid_count"), True),
    (("exclusions", "valid_intervals_indices"), [[300, 2699]]),
    (("exclusions", "parameters", "prominence_fraction"), .2),
    (("metrics", "median", "candidate_count"), True),
    (("metrics", "median", "matched_count"), 0),
    (("metrics", "median", "unmatched_reference_count"), 100),
    (("metrics", "median", "unmatched_candidate_count"), 100),
    (("metrics", "median", "matched_shifts_ms"), []),
    (("metrics", "median", "mean_absolute_shift_ms"), 999.),
    (("metrics", "median", "maximum_absolute_shift_ms"), 999.),
    (("metrics", "median", "centered_normalized_rmse"), 999.),
    (("provenance",), {"deterministic_core_parameters": {}}),
])
def test_rejects_corrupt_binding_support_or_metrics_with_safe_categories(path, value):
    parent = toy_result()
    change(parent, path, value)
    with pytest.raises(CandidateEvidenceError) as exc:
        candidate_evidence("e2", parent)
    assert "SENTINEL_PRIVATE_INPUT" not in str(exc.value)


@pytest.mark.parametrize("comparison_id", [None, False, "", "x"*161])
def test_rejects_invalid_identity(comparison_id):
    with pytest.raises(CandidateEvidenceError):
        candidate_evidence(comparison_id, toy_result())


@pytest.mark.parametrize("field", ["times", "raw", "median", "highpass", "unchanged", "reference"])
def test_arrays_are_bounded_before_detection(field, monkeypatch):
    parent = toy_result(synthetic_reference=True)
    parent["plot"][field] = [0.]*(MAX_ANALYSIS_SAMPLES+1)
    monkeypatch.setattr("signaltrace.candidate_evidence.peaks", lambda *args: pytest.fail("Unbounded detector input"))
    with pytest.raises(CandidateEvidenceError):
        candidate_evidence("e2", parent)


def test_rejects_all_flat_or_empty_valid_support():
    t = np.arange(2000)/100
    parent = retained_plot(t, np.ones(len(t)), np.ones(len(t)))
    with pytest.raises(CandidateEvidenceError, match="support metadata disagrees"):
        candidate_evidence("e2", parent)


@pytest.mark.parametrize("invalid", [False, True])
def test_existing_endpoint_attaches_annotations_without_mutating_store_or_result(monkeypatch, invalid):
    parent = toy_result()
    if invalid:
        parent["metrics"]["highpass"]["matched_count"] += 1
    stored = dict(investigation_id="job", comparison_id="e2", result=parent,
                  recording_id="recording", experiment_id="experiment", channel="PPG", target="pulse_timing")
    before = deepcopy(stored)

    class RetainedStore:
        def comparison(self, identifier, evidence_id):
            assert identifier == "job" and evidence_id == "e2"
            return stored

    monkeypatch.setattr(server, "investigation_jobs", RetainedStore())
    with TestClient(server.app, base_url="http://localhost") as client:
        response = client.get("/api/investigations/job/comparisons/e2")
        assert response.status_code == 200
        payload = response.json()
        assert payload["result"] == parent
        assert payload["candidate_evidence_status"] == ("unavailable" if invalid else "available")
        if invalid:
            assert payload["candidate_evidence"] is None
        else:
            assert_reconciles(parent, payload["candidate_evidence"])
        assert client.get("/api/investigations/job/comparisons/e2", headers={"Origin": "https://evil.invalid"}).status_code == 403
    assert stored == before


def test_endpoint_preserves_missing_comparison_error_and_does_not_swallow_programming_errors(monkeypatch):
    class MissingStore:
        def comparison(self, identifier, evidence_id):
            raise JobError(404, "Unavailable comparison")

    monkeypatch.setattr(server, "investigation_jobs", MissingStore())
    with TestClient(server.app, base_url="http://localhost") as client:
        assert client.get("/api/investigations/job/comparisons/e2").status_code == 404

    monkeypatch.setattr(server.investigation_jobs, "comparison", lambda *args: dict(result={}))
    def bug(*args):
        raise RuntimeError("Programming error")
    monkeypatch.setattr(server, "candidate_evidence", bug)
    with pytest.raises(RuntimeError, match="Programming error"):
        server.get_investigation_comparison("job", "e2")
