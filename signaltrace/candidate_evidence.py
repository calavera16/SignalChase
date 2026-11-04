"""Bounded candidate annotations reconstructed from retained comparison samples.

This read-only presentation helper never prepares, filters or crops a waveform.
It fails closed when retained support or measurements disagree with this detector.
"""
from copy import deepcopy
from dataclasses import asdict

import numpy as np

from .analysis import MAX_ANALYSIS_SAMPLES, parameters
from .core import Parameters, peak_pairs, peaks, runs, support, validate


METHODS = ("unchanged", "median", "highpass")


class CandidateEvidenceError(ValueError):
    """Recognized invalid annotation input; the original plot remains usable."""


def _number(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and np.isfinite(value))


def _array(value, count=None, *, times=False):
    if (not isinstance(value, list) or not 3 <= len(value) <= MAX_ANALYSIS_SAMPLES
            or (count is not None and len(value) != count)):
        raise CandidateEvidenceError("Invalid retained sample arrays")
    if any(not _number(v) and not (v is None and not times) for v in value):
        raise CandidateEvidenceError("Invalid retained sample values")
    return np.asarray([np.nan if v is None else v for v in value], float)


def _same_metadata(actual, expected):
    """Reject bool-as-integer substitutions as well as altered support metadata."""
    if isinstance(expected, dict):
        return (isinstance(actual, dict) and actual.keys() == expected.keys()
                and all(_same_metadata(actual[k], v) for k, v in expected.items()))
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(_same_metadata(a, b) for a, b in zip(actual, expected)))
    if isinstance(expected, int):
        return isinstance(actual, int) and not isinstance(actual, bool) and actual == expected
    return _number(actual) and actual == expected


def _same_timing(actual, expected):
    return (actual is None if expected is None else
            _number(actual) and abs(actual - expected) <= 1e-9)


def _check_metrics(metric, reference_indices, candidate_indices, pairs, t, reference, values, mask):
    required = {"reference_count", "candidate_count", "matched_count", "unmatched_reference_count",
                "unmatched_candidate_count", "matched_shifts_ms", "mean_absolute_shift_ms",
                "maximum_absolute_shift_ms", "centered_normalized_rmse"}
    if not isinstance(metric, dict) or not required <= metric.keys():
        raise CandidateEvidenceError("Invalid retained candidate metrics")
    counts = dict(reference_count=len(reference_indices), candidate_count=len(candidate_indices),
                  matched_count=len(pairs), unmatched_reference_count=len(reference_indices)-len(pairs),
                  unmatched_candidate_count=len(candidate_indices)-len(pairs))
    if any(not _same_metadata(metric.get(k), v) for k, v in counts.items()):
        raise CandidateEvidenceError("Retained candidate counts disagree")
    shifts = [1000*float(t[j]-t[i]) for i, j in pairs]
    retained_shifts = metric.get("matched_shifts_ms")
    if (not isinstance(retained_shifts, list) or len(retained_shifts) != len(shifts)
            or any(not _same_timing(a, b) for a, b in zip(retained_shifts, shifts))):
        raise CandidateEvidenceError("Retained candidate timing disagrees")
    mean = float(np.mean(np.abs(shifts))) if shifts else None
    maximum = float(np.max(np.abs(shifts))) if shifts else None
    if (not _same_timing(metric.get("mean_absolute_shift_ms"), mean)
            or not _same_timing(metric.get("maximum_absolute_shift_ms"), maximum)):
        raise CandidateEvidenceError("Retained candidate timing disagrees")
    r, c = reference[mask], values[mask]
    scale = float(np.std(r))
    rmse = float(np.sqrt(np.mean(((c-c.mean())-(r-r.mean()))**2))/scale) if scale > 0 else None
    if not _same_timing(metric.get("centered_normalized_rmse"), rmse):
        raise CandidateEvidenceError("Retained waveform metric disagrees")


def candidate_evidence(comparison_id, result):
    """Return sample-index markers only after reproducing the parent accounting."""
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            return _candidate_evidence(comparison_id, result)
    except CandidateEvidenceError:
        raise
    except (KeyError, TypeError, ValueError, OverflowError, FloatingPointError):
        # Neither input values nor incidental NumPy/core messages leave this helper.
        raise CandidateEvidenceError("Invalid retained annotation input") from None


def _candidate_evidence(comparison_id, result):
    if not isinstance(comparison_id, str) or not 1 <= len(comparison_id) <= 160:
        raise CandidateEvidenceError("Invalid comparison identity")
    if not isinstance(result, dict):
        raise CandidateEvidenceError("Invalid retained comparison")
    window = result.get("window")
    if (not isinstance(window, dict) or set(window) != {"start_s", "end_s"}
            or not all(_number(v) for v in window.values()) or window["start_s"] >= window["end_s"]):
        raise CandidateEvidenceError("Invalid retained comparison window")
    opts = parameters(result.get("parameters"))
    if not _same_metadata(result["parameters"], opts):
        raise CandidateEvidenceError("Invalid retained analysis parameters")
    p = Parameters(**opts)
    detector = asdict(p)
    plot = result.get("plot")
    if not isinstance(plot, dict):
        raise CandidateEvidenceError("Missing retained comparison plot")
    t = _array(plot.get("times"), times=True)
    raw = _array(plot.get("raw"), len(t))
    validate(t, raw)
    if not window["start_s"] <= t[0] <= t[-1] < window["end_s"]:
        raise CandidateEvidenceError("Invalid retained comparison window")
    mask_values = plot.get("valid_mask")
    if (not isinstance(mask_values, list) or len(mask_values) != len(t)
            or any(not isinstance(v, bool) for v in mask_values)):
        raise CandidateEvidenceError("Invalid retained valid mask")
    mask = np.asarray(mask_values, bool)
    # Support detection is deterministic and performs no filtering or peak finding.
    expected_mask, details = support(t, raw, p)
    if (not mask.any() or not np.array_equal(mask, expected_mask)
            or not _same_metadata(result.get("exclusions"), details)):
        raise CandidateEvidenceError("Retained support metadata disagrees")
    provenance = result.get("provenance")
    if (not isinstance(provenance, dict) or
            ("deterministic_core_parameters" in provenance and not _same_metadata(
                provenance["deterministic_core_parameters"], detector))):
        raise CandidateEvidenceError("Retained detector metadata disagrees")
    comparator = result.get("comparison")
    if comparator == "original" and plot.get("reference") is None:
        reference = raw
    elif comparator == "synthetic_reference":
        reference = _array(plot.get("reference"), len(t))
    else:
        raise CandidateEvidenceError("Invalid retained comparator")
    processed = {name: _array(plot.get(name), len(t)) for name in METHODS}
    if any(not np.isfinite(v[mask]).all() for v in (reference, *processed.values())):
        raise CandidateEvidenceError("Invalid retained valid sample support")
    if (any(not np.isnan(v[~mask]).all() for v in processed.values())
            or not np.array_equal(processed["unchanged"][mask], raw[mask])):
        raise CandidateEvidenceError("Invalid retained processing support")
    intervals = runs(mask)
    reference_indices = []
    methods = {name: dict(candidate_indices=[], pairs=[]) for name in METHODS}
    for a, b in intervals:
        part = np.zeros(len(mask), bool)
        part[a:b] = True
        refs = peaks(t, reference, part, p)
        reference_indices.extend(refs.tolist())
        for name, values in processed.items():
            candidates = peaks(t, values, part, p)
            methods[name]["candidate_indices"].extend(candidates.tolist())
            methods[name]["pairs"].extend(
                [[int(refs[i]), int(candidates[j])]
                 for i, j in peak_pairs(t[refs], t[candidates], p.match_tolerance_s)])
    metrics = result.get("metrics")
    if not isinstance(metrics, dict):
        raise CandidateEvidenceError("Missing retained comparison metrics")
    for name, annotation in methods.items():
        _check_metrics(metrics.get(name), reference_indices, annotation["candidate_indices"],
                       annotation["pairs"], t, reference, processed[name], mask)
    return dict(schema="signaltrace.candidate-evidence.v1", comparison_id=comparison_id,
                comparator=comparator, sample_count=len(t), window=deepcopy(window), parameters=opts,
                detector=detector, valid_intervals_indices=[[int(a), int(b)] for a, b in intervals],
                reference_indices=reference_indices, methods=methods)
