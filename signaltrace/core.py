"""Numerical methods. Missing/flat samples remain missing; no gap interpolation."""
from dataclasses import asdict, dataclass
import numpy as np
from scipy import signal, ndimage


@dataclass(frozen=True)
class Parameters:
    median_window_s: float = 2.0
    highpass_hz: float = 0.35
    highpass_order: int = 2
    edge_guard_s: float = 3.0
    minimum_interior_s: float = 1.0
    flatline_s: float = 0.25
    peak_distance_s: float = 0.4
    prominence_fraction: float = 0.15
    match_tolerance_s: float = 0.15
    gap_factor: float = 1.5
    regularity_tolerance: float = 0.02


def runs(mask):
    edges = np.diff(np.r_[False, mask, False].astype(int))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def validate(t, x):
    t, x = np.asarray(t, float), np.asarray(x, float)
    if t.ndim != 1 or x.ndim != 1 or len(t) != len(x) or len(t) < 3:
        raise ValueError("Time and signal must be equal one-dimensional arrays with >=3 samples")
    if not np.isfinite(t).all() or not (np.diff(t) > 0).all():
        raise ValueError("Timestamps must be finite and strictly increasing")
    if np.isinf(x).any():
        raise ValueError("Infinite signal values are invalid; use NaN for missing samples")
    return t, x


def support(t, x, p=Parameters()):
    """Find usable interiors without filtering or detecting peak candidates."""
    t, x = validate(t, x)
    dt = np.diff(t)
    nominal = float(np.median(dt))
    fs = 1 / nominal
    if not (20 <= fs <= 1000) or not (0 < p.highpass_hz < fs / 2):
        raise ValueError("Supported sampling rate is 20..1000 Hz and cutoff below Nyquist")
    gaps = np.flatnonzero(dt > p.gap_factor * nominal)
    regular = dt <= p.gap_factor * nominal
    if np.any(np.abs(dt[regular] / nominal - 1) > p.regularity_tolerance):
        raise ValueError("Within segments sampling must be regular within 2%; resampling is not performed")
    finite = np.isfinite(x)
    flat = np.zeros(len(x), bool)
    # Exact repeated runs are a conservative flatline flag, not a general artifact detector.
    equal = np.isfinite(x[:-1]) & np.isfinite(x[1:]) & (x[1:] == x[:-1])
    for a, b in runs(equal):
        if (b + 1 - a) / fs >= p.flatline_s:
            flat[a:b + 1] = True
    usable = finite & ~flat
    bounds = [0, *(gaps + 1).tolist(), len(x)]
    segments = []
    for left, right in zip(bounds[:-1], bounds[1:]):
        segments.extend((left+a, left+b) for a, b in runs(usable[left:right]))
    mask = np.zeros(len(x), bool)
    accepted, rejected = [], []
    guard = int(np.ceil(p.edge_guard_s * fs - 1e-9))
    min_len = 2 * guard + int(np.ceil(p.minimum_interior_s * fs - 1e-9))
    window = int(round(p.median_window_s * fs)) | 1
    for a, b in segments:
        if b-a < min_len:
            rejected.append([int(a), int(b)])
            continue
        accepted.append((a, b))
        mask[a+guard:b-guard] = True
    details = dict(fs_hz=fs, sample_count=len(x), valid_count=int(mask.sum()),
                   excluded_fraction=float(1-mask.mean()), nonfinite_count=int((~finite).sum()),
                   flatline_count=int(flat.sum()), gap_after_indices=gaps.tolist(),
                   accepted_segments=[[int(v) for v in s] for s in accepted], too_short_segments=rejected,
                   valid_intervals_indices=[[int(v) for v in s] for s in runs(mask)],
                   median_window_samples=window, parameters=asdict(p))
    return mask, details


def prepare(t, x, p=Parameters()):
    t, x = validate(t, x)
    mask, details = support(t, x, p)
    processed = {name: np.full(len(x), np.nan) for name in ("unchanged", "median", "highpass")}
    sos = signal.butter(p.highpass_order, p.highpass_hz, "highpass", fs=details["fs_hz"], output="sos")
    for a, b in details["accepted_segments"]:
        y = x[a:b]
        processed["unchanged"][a:b] = y
        processed["median"][a:b] = y - ndimage.median_filter(y, size=details["median_window_samples"], mode="reflect")
        processed["highpass"][a:b] = signal.sosfiltfilt(sos, y)
    return processed, mask, details


def peaks(t, x, mask, p=Parameters()):
    """Candidates within each valid interior; endpoints are not candidate peaks."""
    found = []
    fs = 1 / np.median(np.diff(t))
    for a, b in runs(mask):
        y = x[a:b]
        span = np.percentile(y, 95) - np.percentile(y, 5)
        if span <= 0:
            continue
        local, _ = signal.find_peaks(y, distance=max(1, int(np.ceil(p.peak_distance_s*fs))),
                                     prominence=p.prominence_fraction*span)
        found.extend((local+a).tolist())
    return np.asarray(found, int)


def peak_pairs(reference_times, candidate_times, tolerance_s):
    """Return chronological greedy pairs as indices into the two inputs."""
    r, c = np.asarray(reference_times), np.asarray(candidate_times)
    if np.any(np.diff(r) <= 0) or np.any(np.diff(c) <= 0):
        raise ValueError("Peak times must be strictly increasing")
    i = j = 0
    pairs = []
    while i < len(r) and j < len(c):
        delta = float(c[j]-r[i])
        if abs(delta) <= tolerance_s:
            pairs.append((i, j))
            i += 1
            j += 1
        elif delta < 0:
            j += 1
        else:
            i += 1
    return pairs


def match_peaks(reference_times, candidate_times, tolerance_s):
    """Chronological greedy one-to-one matching; neither input can be reused."""
    r, c = np.asarray(reference_times), np.asarray(candidate_times)
    shifts = [1000*float(c[j]-r[i]) for i, j in peak_pairs(r, c, tolerance_s)]
    return dict(reference_count=len(r), candidate_count=len(c), matched_count=len(shifts),
                unmatched_reference_count=len(r)-len(shifts), unmatched_candidate_count=len(c)-len(shifts),
                matched_shifts_ms=shifts,
                mean_absolute_shift_ms=float(np.mean(np.abs(shifts))) if shifts else None,
                maximum_absolute_shift_ms=float(np.max(np.abs(shifts))) if shifts else None)


def compare(t, reference, candidate, mask, p=Parameters()):
    # Match independently per contiguous valid interval, including timestamp gaps.
    totals = dict(reference_count=0, candidate_count=0, matched_count=0,
                  unmatched_reference_count=0, unmatched_candidate_count=0)
    shifts = []
    for a, b in runs(mask):
        part = np.zeros(len(mask), bool)
        part[a:b] = True
        result = match_peaks(t[peaks(t, reference, part, p)], t[peaks(t, candidate, part, p)], p.match_tolerance_s)
        for key in totals:
            totals[key] += result[key]
        shifts.extend(result["matched_shifts_ms"])
    totals.update(matched_shifts_ms=shifts,
                  mean_absolute_shift_ms=float(np.mean(np.abs(shifts))) if shifts else None,
                  maximum_absolute_shift_ms=float(np.max(np.abs(shifts))) if shifts else None)
    if mask.any():
        r, c = reference[mask], candidate[mask]
        scale = float(np.std(r))
        totals["centered_normalized_rmse"] = float(np.sqrt(np.mean(((c-c.mean())-(r-r.mean()))**2))/scale) if scale > 0 else None
    else:
        totals["centered_normalized_rmse"] = None
    return totals


def synthetic(duration_s=120, fs=125, seed=20261102):
    t = np.arange(int(duration_s*fs)) / fs
    phase = np.mod(t, 0.8)
    reference = np.exp(-0.5*((phase-0.18)/0.055)**2) + 0.25*np.exp(-0.5*((phase-0.38)/0.09)**2)
    rng = np.random.default_rng(seed)
    drifted = reference + 0.7*np.sin(2*np.pi*0.06*t) + 0.25*t/duration_s + rng.normal(0, 0.035, len(t))
    damaged = drifted.copy()
    damaged[(t >= 40) & (t < 44)] = np.nan
    damaged[(t >= 80) & (t < 81)] = 0.75
    return t, reference, {"synthetic_control": reference.copy(), "synthetic_drift_noise": drifted,
                           "synthetic_missing_flatline": damaged}
