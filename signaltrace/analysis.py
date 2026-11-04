"""Deterministic PPG comparisons and portable, bounded replay recipes."""
import hashlib
import json
import platform
from dataclasses import asdict
import numpy as np
import scipy
from . import __version__
from .core import Parameters, prepare, compare
from .recordings import finite_list

MAX_ANALYSIS_SAMPLES = 30_000
LIMITATIONS = [
    "Research inspection only; no clinical or diagnostic interpretation.",
    "PPG peak candidates are algorithmic maxima, not annotated heartbeats.",
    "Fixed baselines are not optimal filters; neither goal automatically ranks a winner.",
    "Median subtraction and forward/backward high-pass filtering are offline and use future samples.",
    "The edge guard is a heuristic and does not prove all filter transients are absent.",
    "Missing samples, exact flat runs and short segments are excluded, never repaired. Other artifacts may remain.",
    "Real-data differences measure sensitivity against the original, not accuracy.",
    "Synthetic references are evaluation-only oracle data and must not be supplied to a future model.",
    "No Meta model is connected; findings are deterministic numerical summaries.",
]


def parameters(values):
    if not isinstance(values, dict) or set(values) - {"median_window_s", "highpass_hz", "edge_guard_s"}:
        raise ValueError("Unsupported analysis parameters")
    defaults = dict(median_window_s=2., highpass_hz=.35, edge_guard_s=3.)
    for key, low, high in (("median_window_s", .5, 5), ("highpass_hz", .1, 1), ("edge_guard_s", 3, 10)):
        v = values.get(key, defaults[key])
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or not low <= v <= high:
            raise ValueError(f"{key} must be between {low} and {high}")
        defaults[key] = float(v)
    return defaults


def checksum(times, raw, reference):
    data = dict(times=finite_list(times), raw=finite_list(raw), reference=None if reference is None else finite_list(reference))
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def calculate(times, raw, reference, *, goal, window, parameter_values, provenance):
    if goal not in ("pulse_timing", "waveform_sensitivity"):
        raise ValueError("Choose pulse_timing or waveform_sensitivity")
    if not 3 <= len(times) <= MAX_ANALYSIS_SAMPLES:
        raise ValueError("Select between 3 and 30,000 samples")
    opts = parameters(parameter_values)
    p = Parameters(**opts)
    with np.errstate(over="raise", invalid="raise", divide="raise"):
        try:
            processed, mask, details = prepare(times, raw, p)
            if not mask.any():
                raise ValueError("Insufficient valid data: choose a longer window with finite, varying segments beyond the edge guards")
            evaluation = raw if reference is None else reference
            if not np.isfinite(evaluation[mask]).all():
                raise ValueError("Reference must be finite throughout the shared valid interior")
            metrics = {name: compare(times, evaluation, y, mask, p) for name, y in processed.items()}
        except (FloatingPointError, OverflowError):
            raise ValueError("Signal magnitude exceeds safe numerical processing limits") from None
    # Boundary samples remain available in raw, but all displayed processing outputs use the common mask.
    plot = dict(times=times.tolist(), raw=finite_list(raw), reference=None if reference is None else finite_list(reference),
                valid_mask=mask.tolist())
    plot.update({name: finite_list(np.where(mask, y, np.nan)) for name, y in processed.items()})
    result = dict(goal=goal, comparison="original" if reference is None else "synthetic_reference", window=window,
                  parameters=opts, exclusions=details, metrics=metrics, plot=plot,
                  findings=[dict(id="shared_interior", label="Common valid interior",
                      detail=f"{details['valid_count']} of {len(times)} selected samples contribute to all methods; {details['excluded_fraction']:.1%} excluded."),
                      dict(id="comparison", label="Evaluation reference" if reference is not None else "Sensitivity comparison",
                           detail="All methods are compared with the evaluator-only synthetic reference." if reference is not None else
                                  "All methods are compared with the original waveform; differences do not establish accuracy.")],
                  provenance=provenance, limitations=LIMITATIONS)
    try:
        json.dumps(result, allow_nan=False)
    except (ValueError, OverflowError):
        raise ValueError("Signal magnitude produced nonfinite metrics; choose a numerically bounded recording") from None
    return result


def analyze_recording(recording, channel, start_s, end_s, goal, parameter_values, evaluation=None):
    if recording.modality != "ppg":
        raise ValueError("Analysis is available only for user-declared PPG recordings; other modalities support generic inspection")
    if channel not in recording.channels:
        raise ValueError("Choose an existing signal channel")
    if not np.isfinite([start_s, end_s]).all() or not recording.times[0] <= start_s < end_s:
        raise ValueError("Analysis window must be finite, increasing and inside the recording")
    # An endpoint one nominal sample beyond the last timestamp makes a full half-open selection possible.
    limit = float(recording.times[-1] + np.median(np.diff(recording.times)))
    if end_s > limit + 1e-9:
        raise ValueError("Analysis window ends outside the recording")
    select = (recording.times >= start_s) & (recording.times < end_s)
    t, raw = recording.times[select], recording.channels[channel][select]
    if evaluation not in (None, "original_sensitivity", "synthetic_reference"):
        raise ValueError("Unsupported evaluation comparator")
    if evaluation == "synthetic_reference" and recording.reference is None:
        raise ValueError("Synthetic reference evaluation requires an available evaluator reference")
    reference = None if recording.reference is None or evaluation == "original_sensitivity" else recording.reference[select]
    window = dict(start_s=float(start_s), end_s=float(end_s))
    provenance = dict(source=recording.provenance, input_sha256=checksum(t, raw, reference),
                      versions=dict(python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__, signaltrace=__version__),
                      deterministic_core_parameters=asdict(Parameters(**parameters(parameter_values))))
    result = calculate(t, raw, reference, goal=goal, window=window, parameter_values=parameter_values, provenance=provenance)
    recipe = dict(schema="signaltrace.analysis.v1", modality="ppg", channel=channel, unit=recording.unit,
                  name=recording.name, goal=goal, window=window, parameters=result["parameters"],
                  times=finite_list(t), raw=finite_list(raw), reference=None if reference is None else finite_list(reference),
                  provenance=provenance, input_sha256=checksum(t, raw, reference))
    return result, recipe


def replay_recipe(recipe):
    if not isinstance(recipe, dict) or recipe.get("schema") != "signaltrace.analysis.v1" or recipe.get("modality") != "ppg":
        raise ValueError("Unsupported replay schema or modality")
    arrays = {}
    for key in ("times", "raw", "reference"):
        value = recipe.get(key)
        if value is None and key == "reference":
            arrays[key] = None
            continue
        if not isinstance(value, list) or not 3 <= len(value) <= MAX_ANALYSIS_SAMPLES:
            raise ValueError("Replay arrays must contain 3..30,000 samples")
        if any(isinstance(v, bool) or (v is not None and not isinstance(v, (float, int))) or
               (v is None and key == "times") for v in value):
            raise ValueError("Replay arrays must contain numbers (null allowed only for signal samples)")
        try:
            arr = np.asarray([np.nan if v is None else v for v in value], float)
        except (ValueError, OverflowError):
            raise ValueError("Invalid replay numeric magnitude") from None
        if np.isinf(arr).any():
            raise ValueError("Infinite replay values are not supported")
        arrays[key] = arr
    t, raw, ref = arrays["times"], arrays["raw"], arrays["reference"]
    if len(t) != len(raw) or (ref is not None and len(ref) != len(t)):
        raise ValueError("Replay arrays must have equal lengths")
    if checksum(t, raw, ref) != recipe.get("input_sha256"):
        raise ValueError("Replay input checksum mismatch")
    window = recipe.get("window")
    if not isinstance(window, dict) or set(window) != {"start_s", "end_s"}:
        raise ValueError("Replay requires an explicit window")
    if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not np.isfinite(v) for v in window.values()):
        raise ValueError("Replay window must be finite")
    if not window["start_s"] <= t[0] <= t[-1] < window["end_s"]:
        raise ValueError("Replay samples must lie in the half-open recipe window")
    provenance = recipe.get("provenance", {})
    if not isinstance(provenance, dict):
        raise ValueError("Invalid replay provenance")
    current_core = asdict(Parameters(**parameters(recipe.get("parameters", {}))))
    if provenance.get("deterministic_core_parameters") != current_core:
        raise ValueError("Replay core parameters differ from this implementation")
    return calculate(t, raw, ref, goal=recipe.get("goal"), window=window,
                     parameter_values=recipe.get("parameters", {}), provenance=provenance)
