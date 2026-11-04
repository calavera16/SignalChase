import numpy as np
import pytest
from signaltrace.core import Parameters, compare, match_peaks, peak_pairs, prepare, support, synthetic


def test_control_identity_and_exact_reference_error():
    t, ref, cases = synthetic()
    processed, mask, _ = prepare(t, cases["synthetic_control"])
    np.testing.assert_array_equal(processed["unchanged"][mask], ref[mask])
    m = compare(t, ref, processed["unchanged"], mask)
    assert m["centered_normalized_rmse"] == 0
    assert m["mean_absolute_shift_ms"] == 0
    assert m["unmatched_reference_count"] == m["unmatched_candidate_count"] == 0


def test_one_to_one_shift_misses_extras():
    m = match_peaks([1, 2, 3, 4], [1.025, 2.025, 2.05, 4.025, 5], 0.1)
    assert m["matched_count"] == 3
    assert m["unmatched_reference_count"] == 1
    assert m["unmatched_candidate_count"] == 2
    np.testing.assert_allclose(m["matched_shifts_ms"], [25, 25, 25])
    with pytest.raises(ValueError):
        match_peaks([1, 1], [1], 0.1)


def test_shifted_waveform_has_known_peak_delay():
    t, ref, _ = synthetic(duration_s=20)
    mask = (t >= 3) & (t < 17)
    result = compare(t, ref, np.roll(ref, 3), mask)
    assert result["unmatched_reference_count"] == 0
    assert result["unmatched_candidate_count"] == 0
    np.testing.assert_allclose(result["matched_shifts_ms"], 24, atol=1e-9)


def test_no_processing_across_nan_or_timestamp_gap():
    t, ref, _ = synthetic(duration_s=30)
    raw = ref.copy()
    raw[(t >= 12) & (t < 14)] = np.nan
    a, mask, details = prepare(t, raw)
    changed = raw.copy()
    changed[t >= 14] *= 100
    b, other_mask, _ = prepare(t, changed)
    for method in a:
        np.testing.assert_equal(a[method][t < 12], b[method][t < 12])
        assert np.isnan(a[method][(t >= 12) & (t < 14)]).all()
    np.testing.assert_array_equal(mask, other_mask)
    shifted_t = t.copy()
    shifted_t[t >= 15] += 3
    c, gap_mask, detail = prepare(shifted_t, ref)
    assert len(detail["gap_after_indices"]) == 1
    assert not gap_mask[(t > 12) & (t < 18)].any()
    # With two identical independent segments, changing the second cannot alter the first.
    modified = ref.copy()
    modified[t >= 15] += np.sin(t[t >= 15])*10
    d, _, _ = prepare(shifted_t, modified)
    for method in c:
        np.testing.assert_equal(c[method][t < 15], d[method][t < 15])


def test_invalid_short_missing_and_flat_samples():
    t = np.arange(100)/125
    _, mask, details = prepare(t, np.sin(t))
    assert not mask.any() and details["too_short_segments"] == [[0, 100]]
    _, mask, _ = prepare(t, np.full(100, np.nan))
    assert not mask.any()
    for bad in [t[::-1], np.zeros(100), np.r_[np.nan, t[1:]]]:
        with pytest.raises(ValueError):
            prepare(bad, np.sin(t))
    with pytest.raises(ValueError):
        prepare(t, np.full(100, np.inf))
    long_t, _, cases = synthetic()
    processed, mask, details = prepare(long_t, cases["synthetic_missing_flatline"])
    assert details["flatline_count"] >= 125
    assert not mask[(long_t >= 80) & (long_t < 81)].any()
    for y in processed.values():
        assert np.isfinite(y[mask]).all()
    assert compare(t, np.sin(t), np.sin(t), np.zeros(100, bool))["centered_normalized_rmse"] is None


def test_common_mask_and_determinism():
    t, r, cases = synthetic()
    t2, r2, cases2 = synthetic()
    np.testing.assert_array_equal(r, r2)
    for name in cases:
        np.testing.assert_equal(cases[name], cases2[name])
        ys, mask, detail = prepare(t, cases[name])
        for y in ys.values():
            assert np.isfinite(y[mask]).all()
        assert detail["valid_count"] == mask.sum()
        assert len({compare(t, r, y, mask)["reference_count"] for y in ys.values()}) == 1


def test_support_reuses_exact_segmentation_without_processing(monkeypatch):
    t, _, cases = synthetic(duration_s=100)
    p = Parameters(median_window_s=.5, highpass_hz=.1, edge_guard_s=5)
    _, expected_mask, expected_details = prepare(t, cases["synthetic_missing_flatline"], p)
    def forbidden(*args, **kwargs):
        raise AssertionError("Support must not filter or detect peaks")
    monkeypatch.setattr("signaltrace.core.signal.butter", forbidden)
    monkeypatch.setattr("signaltrace.core.signal.find_peaks", forbidden)
    monkeypatch.setattr("signaltrace.core.ndimage.median_filter", forbidden)
    mask, details = support(t, cases["synthetic_missing_flatline"], p)
    np.testing.assert_array_equal(mask, expected_mask)
    assert details == expected_details


def test_greedy_pair_indices_preserve_chronology_and_unmatched_inputs():
    assert peak_pairs([1, 2, 3, 4], [1.025, 2.025, 2.05, 4.025, 5], .1) == [(0, 0), (1, 1), (3, 3)]
    assert peak_pairs([], [1], .1) == []
    assert peak_pairs([1], [2], .1) == []
