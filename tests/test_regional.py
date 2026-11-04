from copy import deepcopy
import json

import numpy as np
import pytest

from signaltrace.analysis import calculate
from signaltrace.core import Parameters, compare, synthetic
from signaltrace.regional import LIMITATIONS, METHODS, regional_summary


def parent_plot(t, reference, candidate, mask):
    p = Parameters()
    values = {"unchanged": reference, "median": candidate, "highpass": candidate}
    return dict(window=dict(start_s=float(t[0]), end_s=float(t[-1]+np.median(np.diff(t)))),
                parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.),
                plot=dict(times=t.tolist(), raw=reference.tolist(), reference=None,
                          valid_mask=mask.tolist(), **{k: v.tolist() for k, v in values.items()}),
                metrics={k: compare(t, reference, v, mask, p) for k, v in values.items()})


def assert_reconciles(parent, summary):
    regions = summary["regions"]
    assert sum(r["sample_count"] for r in regions) == len(parent["plot"]["times"])
    assert sum(r["valid_count"] for r in regions) == sum(parent["plot"]["valid_mask"])
    for method in METHODS:
        original = parent["metrics"][method]
        metrics = [r["metrics"][method] for r in regions]
        for regional_key, parent_key in (("reference_candidate_count", "reference_count"),
                                         ("candidate_count", "candidate_count"),
                                         ("matched_pair_count", "matched_count"),
                                         ("unmatched_reference_count", "unmatched_reference_count"),
                                         ("unmatched_candidate_count", "unmatched_candidate_count")):
            assert sum(m[regional_key] for m in metrics) == original[parent_key]
        count = sum(m["matched_pair_count"] for m in metrics)
        if count:
            weighted_mean = sum(m["mean_absolute_shift_ms"]*m["matched_pair_count"]
                                for m in metrics if m["matched_pair_count"]) / count
            assert weighted_mean == pytest.approx(original["mean_absolute_shift_ms"], abs=1e-12)
            assert max(m["maximum_absolute_shift_ms"] for m in metrics if m["matched_pair_count"]) == original["maximum_absolute_shift_ms"]
        valid = sum(r["valid_count"] for r in regions)
        if valid and original["centered_normalized_rmse"] is not None:
            mse = sum(r["valid_count"] * r["metrics"][method]["full_window_centered_normalized_rmse"]**2
                      for r in regions if r["valid_count"]) / valid
            assert np.sqrt(mse) == pytest.approx(original["centered_normalized_rmse"], abs=1e-12)


def test_crossing_pairs_assigned_by_original_time_and_boundary_peak_retained(monkeypatch):
    t = np.arange(1000)/100
    wave = lambda centers: sum(np.exp(-((t-center)/.035)**2) for center in centers)
    reference, candidate = wave([2., 3.98, 6.]), wave([4.02, 6.04, 8.])
    parent = parent_plot(t, reference, candidate, (t >= 1) & (t < 9))
    before = deepcopy(parent)
    def forbidden(*args, **kwargs):
        raise AssertionError("Regional summaries must never filter")
    monkeypatch.setattr("signaltrace.core.signal.sosfiltfilt", forbidden)
    monkeypatch.setattr("signaltrace.core.ndimage.median_filter", forbidden)
    summary = regional_summary("e2", parent, 4.)
    left, right = [r["metrics"]["median"] for r in summary["regions"]]
    assert left["matched_pair_count"] == 1 and left["candidate_count"] == 0
    assert left["cross_boundary_pair_count"] == 1
    assert left["unmatched_reference_count"] == 1
    assert right["matched_pair_count"] == 1 and right["candidate_count"] == 3
    assert right["unmatched_candidate_count"] == 1
    assert_reconciles(parent, summary)
    assert parent == before
    # A reference exactly on the split belongs to the right half-open region.
    boundary = regional_summary("e2", parent, 3.98)
    assert boundary["regions"][1]["metrics"]["median"]["matched_pair_count"] == 2


@pytest.mark.parametrize("reference_present", [False, True])
def test_real_processed_parent_counts_and_global_rmse_reconcile(reference_present):
    t, reference, cases = synthetic(duration_s=100)
    parent = calculate(t, cases["synthetic_missing_flatline"], reference if reference_present else None,
                       goal="pulse_timing", window=dict(start_s=0., end_s=100.),
                       parameter_values={}, provenance={})
    summary = regional_summary("e7", parent, 43.5)
    assert_reconciles(parent, summary)
    assert set(summary) == {"kind", "comparison_id", "window", "split_s", "parameters", "assignment",
                            "filtering_context", "normalization", "regions", "limitations"}
    assert summary["assignment"] == "original_candidate_time"
    assert summary["filtering_context"] == "parent_full_window"
    assert summary["normalization"] == "parent_full_window_means_and_original_std"
    assert summary["limitations"] == LIMITATIONS
    assert all(set(r) == {"window", "sample_count", "valid_count", "metrics"} for r in summary["regions"])
    assert "matched_shifts_ms" not in json.dumps(summary, allow_nan=False)


def test_missing_support_no_matches_and_global_centering():
    t = np.arange(1000)/100
    reference = np.sin(2*np.pi*t)
    # No candidate maxima, yet a finite waveform metric remains meaningful.
    candidate = t.copy()
    mask = t >= 5
    parent = parent_plot(t, reference, candidate, mask)
    summary = regional_summary("e2", parent, 4.)
    for method in METHODS:
        metric = summary["regions"][0]["metrics"][method]
        assert metric["mean_absolute_shift_ms"] is None
        assert metric["maximum_absolute_shift_ms"] is None
        assert metric["full_window_centered_normalized_rmse"] is None
    metric = summary["regions"][1]["metrics"]["median"]
    assert metric["matched_pair_count"] == 0 and metric["unmatched_reference_count"] > 0
    assert metric["mean_absolute_shift_ms"] is None and metric["maximum_absolute_shift_ms"] is None
    assert metric["full_window_centered_normalized_rmse"] > 0
    assert_reconciles(parent, summary)
    # Regional offsets stay visible because means are taken from the full parent.
    parent = parent_plot(t, reference, reference+(t >= 5)*2, np.ones(len(t), bool))
    summary = regional_summary("e2", parent, 5.)
    assert summary["regions"][0]["metrics"]["median"]["full_window_centered_normalized_rmse"] > 1
    assert_reconciles(parent, summary)


def test_no_pairing_across_parent_excluded_segments():
    t = np.arange(1000)/100
    reference = np.exp(-((t-4.95)/.01)**2)
    candidate = np.exp(-((t-5.05)/.01)**2)
    mask = (t < 4.99) | (t > 5.01)
    summary = regional_summary("e2", parent_plot(t, reference, candidate, mask), 5.)
    assert sum(r["metrics"]["median"]["matched_pair_count"] for r in summary["regions"]) == 0


@pytest.mark.parametrize("split", [False, None, "5", float("nan"), float("inf"), -1., 0., 10., .01, 9.99])
def test_strict_split_and_minimum_original_samples(split):
    t = np.arange(1000)/100
    parent = parent_plot(t, np.sin(t), np.sin(t), np.ones(len(t), bool))
    with pytest.raises(ValueError):
        regional_summary("e2", parent, split)
