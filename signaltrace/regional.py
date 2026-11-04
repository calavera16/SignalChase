"""Describe adjacent regions of one retained full-window comparison."""
from copy import deepcopy

import numpy as np

from .analysis import MAX_ANALYSIS_SAMPLES, parameters
from .core import Parameters, peak_pairs, peaks, runs, validate


METHODS = ("unchanged", "median", "highpass")
LIMITATIONS = [
    "Descriptive regional sensitivity only; no causal, significance, accuracy or best-method inference.",
    "Filtering, candidate detection and greedy matching use the parent full window and its valid segments; regions are not independently filtered or rematched.",
    "Matched pairs belong to the original/comparator candidate's region; crossing pairs can make matched-pair counts differ from regional candidate counts.",
    "Waveform error uses parent full-window means and original/comparator standard deviation, not separately recentered regional windows.",
    "Missing matches have unavailable timing metrics, not zero shift; absent valid support has unavailable waveform error.",
    "Peak candidates are algorithmic maxima, not annotated heartbeats; exclusions do not establish signal quality.",
]


def _finite_number(value):
    return (not isinstance(value, (bool, np.bool_)) and
            isinstance(value, (int, float, np.integer, np.floating)) and np.isfinite(value))


def regional_summary(comparison_id, result, split_s):
    """Reuse parent processing, assigning full-window matches by reference time.

    No per-sample or per-candidate arrays leave this function. Each pair is formed
    once within its parent's contiguous valid interval, before any regional split.
    """
    if not isinstance(comparison_id, str) or not comparison_id or len(comparison_id) > 160:
        raise ValueError("Choose an existing successful comparison")
    if not isinstance(result, dict):
        raise ValueError("Regional summary requires a validated parent comparison")
    window = result.get("window")
    if (not isinstance(window, dict) or set(window) != {"start_s", "end_s"} or
            not all(_finite_number(v) for v in window.values()) or
            not _finite_number(split_s) or not window["start_s"] < split_s < window["end_s"]):
        raise ValueError("Regional split must be finite and strictly inside the parent window")
    opts = parameters(result.get("parameters", {}))
    p = Parameters(**opts)
    plot = result.get("plot")
    if not isinstance(plot, dict):
        raise ValueError("Regional summary requires the retained parent plot")
    try:
        t, raw = validate(plot["times"], plot["raw"])
        mask_values = plot["valid_mask"]
        if (not isinstance(mask_values, (list, np.ndarray)) or len(mask_values) != len(t) or
                any(not isinstance(v, (bool, np.bool_)) for v in mask_values)):
            raise ValueError("Invalid parent valid mask")
        mask = np.asarray(mask_values, bool)
        reference = raw if plot.get("reference") is None else np.asarray(plot["reference"], float)
        processed = {method: np.asarray(plot[method], float) for method in METHODS}
    except (KeyError, TypeError, OverflowError):
        raise ValueError("Regional summary requires the retained parent plot") from None
    if (len(t) > MAX_ANALYSIS_SAMPLES or not window["start_s"] <= t[0] <= t[-1] < window["end_s"] or
            any(v.shape != t.shape or not np.isfinite(v[mask]).all()
                for v in (reference, *processed.values()))):
        raise ValueError("Invalid parent plot samples or support")
    split_s = float(split_s)
    region_masks = [t < split_s, t >= split_s]
    if any(int(region.sum()) < 3 for region in region_masks):
        raise ValueError("Each region must contain at least three original samples")
    regions = [dict(window=dict(start_s=float(left), end_s=float(right)),
                    sample_count=int(region.sum()), valid_count=int((region & mask).sum()), metrics={})
               for left, right, region in zip((window["start_s"], split_s),
                                              (split_s, window["end_s"]), region_masks)]
    # Detection and pairing use only complete parent interiors, never split masks.
    detected = []
    for a, b in runs(mask):
        part = np.zeros(len(mask), bool)
        part[a:b] = True
        reference_indices = peaks(t, reference, part, p)
        candidates = {method: peaks(t, values, part, p) for method, values in processed.items()}
        detected.append((reference_indices, candidates))
    for method, values in processed.items():
        counts = [dict(reference_candidate_count=0, candidate_count=0, matched_pair_count=0,
                       unmatched_reference_count=0, unmatched_candidate_count=0,
                       cross_boundary_pair_count=0) for _ in regions]
        shifts = [[], []]
        for reference_indices, candidates in detected:
            candidate_indices = candidates[method]
            reference_times, candidate_times = t[reference_indices], t[candidate_indices]
            pairs = peak_pairs(reference_times, candidate_times, p.match_tolerance_s)
            matched_reference, matched_candidates = set(), set()
            for i, j in pairs:
                region = int(reference_times[i] >= split_s)
                counts[region]["matched_pair_count"] += 1
                counts[region]["cross_boundary_pair_count"] += int(region != int(candidate_times[j] >= split_s))
                shifts[region].append(1000*float(candidate_times[j]-reference_times[i]))
                matched_reference.add(i)
                matched_candidates.add(j)
            for i, timestamp in enumerate(reference_times):
                region = int(timestamp >= split_s)
                counts[region]["reference_candidate_count"] += 1
                counts[region]["unmatched_reference_count"] += int(i not in matched_reference)
            for j, timestamp in enumerate(candidate_times):
                region = int(timestamp >= split_s)
                counts[region]["candidate_count"] += 1
                counts[region]["unmatched_candidate_count"] += int(j not in matched_candidates)
        scale = float(np.std(reference[mask])) if mask.any() else 0.
        squared_residual = None
        if mask.any() and scale > 0:
            r, c = reference[mask], values[mask]
            squared_residual = ((c-c.mean())-(r-r.mean()))**2
        for index, region in enumerate(region_masks):
            timing = shifts[index]
            metric = counts[index]
            metric["mean_absolute_shift_ms"] = float(np.mean(np.abs(timing))) if timing else None
            metric["maximum_absolute_shift_ms"] = float(np.max(np.abs(timing))) if timing else None
            regional_valid = region[mask]
            metric["full_window_centered_normalized_rmse"] = (
                float(np.sqrt(np.mean(squared_residual[regional_valid])))/scale
                if squared_residual is not None and regional_valid.any() else None)
            regions[index]["metrics"][method] = metric
    return dict(kind="regional_summary", comparison_id=comparison_id, window=deepcopy(window),
                split_s=split_s, parameters=deepcopy(opts), assignment="original_candidate_time",
                filtering_context="parent_full_window",
                normalization="parent_full_window_means_and_original_std", regions=regions,
                limitations=list(LIMITATIONS))
