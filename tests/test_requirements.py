from copy import deepcopy
import pytest
from signaltrace.requirements import validate_requirements, assess_requirements

WINDOW = dict(start_s=0., end_s=30.)


def requirements(**criteria):
    return dict(confirmed=True, method="highpass", criteria=criteria or dict(max_timing_shift_ms=10.))


def evidence(**metrics):
    measured = dict(matched_count=5, mean_absolute_shift_ms=1., maximum_absolute_shift_ms=12.,
                    unmatched_candidate_count=1, unmatched_comparator_count=2, centered_normalized_rmse=.1)
    measured.update(metrics)
    return {"e2": dict(kind="comparison", evaluation="original_sensitivity", window=deepcopy(WINDOW),
        parameters=dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.),
        sample_count=100, valid_count=80, metrics=dict(highpass=measured, unchanged=dict(maximum_absolute_shift_ms=0.)))}


@pytest.mark.parametrize("value", [
    {}, dict(confirmed=False, method="highpass", criteria=dict(max_timing_shift_ms=10)),
    dict(confirmed=1, method="highpass", criteria=dict(max_timing_shift_ms=10)),
    dict(confirmed=True, method="unchanged", criteria=dict(max_timing_shift_ms=10)),
    dict(confirmed=True, method="highpass", criteria={}),
    requirements(max_timing_shift_ms=True), requirements(max_timing_shift_ms=-1),
    requirements(max_timing_shift_ms=float("inf")), requirements(max_timing_shift_ms=float("nan")),
    requirements(max_unmatched_candidates=2.), requirements(min_usable_fraction=1.01),
    requirements(automatic_threshold=5),
])
def test_reject_unconfirmed_implicit_or_invalid_limits(value):
    with pytest.raises(ValueError):
        validate_requirements(value)


def test_maximum_not_mean_and_unchanged_cannot_win():
    result = assess_requirements(requirements(max_timing_shift_ms=10), evidence(), WINDOW)
    assert result["status"] == "violated"
    assert result["comparisons"][0]["checks"][0]["value"] == 12
    assert result["met_comparison_ids"] == []
    assert result["comparisons"][0]["method"] == "highpass"


def test_conjunction_counts_both_sides_and_derives_usable_fraction():
    result = assess_requirements(requirements(max_timing_shift_ms=12, max_unmatched_candidates=2,
        min_usable_fraction=.8, max_waveform_difference=.1), evidence(), WINDOW)
    checks = {check["metric"]: check for check in result["comparisons"][0]["checks"]}
    assert checks["max_unmatched_candidates"]["value"] == 3
    assert checks["min_usable_fraction"]["value"] == .8
    assert result["status"] == "violated"


def test_failed_settings_retained_when_one_exact_recipe_passes():
    items = evidence()
    items["e3"] = deepcopy(items["e2"])
    items["e3"]["parameters"]["highpass_hz"] = .5
    items["e3"]["metrics"]["highpass"]["maximum_absolute_shift_ms"] = 8
    result = assess_requirements(requirements(), items, WINDOW)
    assert result["status"] == "met" and result["met_comparison_ids"] == ["e3"]
    assert [row["status"] for row in result["comparisons"]] == ["violated", "met"]
    assert assess_requirements(requirements(), items, WINDOW, investigation_failed=True)["status"] == "not_established"


def test_unavailable_never_zero_and_subwindows_ineligible():
    result = assess_requirements(requirements(), evidence(maximum_absolute_shift_ms=None), WINDOW)
    assert result["status"] == "not_established"
    assert result["comparisons"][0]["checks"][0]["value"] is None
    items = evidence(maximum_absolute_shift_ms=0)
    items["e2"]["window"]["end_s"] = 20
    result = assess_requirements(requirements(), items, WINDOW)
    assert result["status"] == "not_established" and result["met_comparison_ids"] == []
    assert result["comparisons"][0]["status"] == "not_established"


def test_usable_fraction_requires_trustworthy_counts_and_no_matches_unknown_timing():
    items = evidence(matched_count=0, maximum_absolute_shift_ms=0)
    items["e2"]["valid_count"] = None
    result = assess_requirements(requirements(max_timing_shift_ms=1, min_usable_fraction=.1), items, WINDOW)
    assert all(check["status"] == "not_established" and check["value"] is None
               for check in result["comparisons"][0]["checks"])


@pytest.mark.parametrize("value,status", [
    (23.999999999999, "met"),
    (24., "met"),
    (24.00000000000091, "met"),
    (24.000001, "violated"),
    (None, "not_established"),
])
def test_versioned_timing_roundoff_retains_exact_values(value, status):
    result = assess_requirements(requirements(max_timing_shift_ms=24),
                                 evidence(maximum_absolute_shift_ms=value), WINDOW)
    assert result["status"] == status
    assert result["comparison_policy"] == "float_roundoff_v1"
    assert result["comparisons"][0]["checks"][0]["value"] == value


def test_roundoff_fraction_waveform_and_exact_candidate_counts():
    items = evidence(centered_normalized_rmse=.10000000000000002)
    result = assess_requirements(requirements(min_usable_fraction=.8000000000000001,
        max_waveform_difference=.1, max_unmatched_candidates=3), items, WINDOW)
    assert result["status"] == "met"
    assert assess_requirements(requirements(max_unmatched_candidates=2), items, WINDOW)["status"] == "violated"
    assert assess_requirements(requirements(min_usable_fraction=.800001), items, WINDOW)["status"] == "violated"
    assert assess_requirements(requirements(max_waveform_difference=.099999), items, WINDOW)["status"] == "violated"


def test_legacy_policy_is_strict_with_original_shape_and_unknown_rejected():
    result = assess_requirements(requirements(max_timing_shift_ms=24),
        evidence(maximum_absolute_shift_ms=24.00000000000091), WINDOW, comparison_policy="strict_legacy")
    assert result["status"] == "violated"
    assert set(result) == {"status", "comparisons", "met_comparison_ids", "next_action", "limitations"}
    with pytest.raises(ValueError):
        assess_requirements(requirements(), evidence(), WINDOW, comparison_policy="unreviewed")
