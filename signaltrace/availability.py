"""Local analysis-support preflight; no filters, providers or raw-sample reports."""
import numpy as np

from .analysis import MAX_ANALYSIS_SAMPLES
from .core import Parameters, support, validate


UNAVAILABLE_MESSAGE = (
    "Insufficient valid data: choose a longer window containing finite, varying "
    "segments beyond the 3-second edge guards. No Meta model request was made."
)


class AvailabilityError(ValueError):
    def __init__(self, report):
        super().__init__(UNAVAILABLE_MESSAGE)
        self.report = report


def check_availability(recording, channel, start_s, end_s):
    """Check the minimum supported guard, not signal quality or peak sufficiency.

    Invalid selections/sampling raise ValueError. A valid selection with no usable
    interior returns an unavailable report. Increasing a guard or changing either
    filter's settings cannot recover support absent at this minimum guard.
    """
    if recording.modality != "ppg":
        raise ValueError("Analysis is available only for user-declared PPG recordings; other modalities support generic inspection")
    if not isinstance(channel, str) or channel not in recording.channels:
        raise ValueError("Choose an existing signal channel")
    numeric = (int, float, np.integer, np.floating)
    if any(isinstance(v, (bool, np.bool_)) or not isinstance(v, numeric) or not np.isfinite(v)
           for v in (start_s, end_s)):
        raise ValueError("Analysis window must be finite, increasing and inside the recording")
    times, raw = validate(recording.times, recording.channels[channel])
    if not times[0] <= start_s < end_s:
        raise ValueError("Analysis window must be finite, increasing and inside the recording")
    limit = float(times[-1] + np.median(np.diff(times)))
    if end_s > limit + 1e-9:
        raise ValueError("Analysis window ends outside the recording")
    select = (times >= start_s) & (times < end_s)
    if not 3 <= int(select.sum()) <= MAX_ANALYSIS_SAMPLES:
        raise ValueError("Select between 3 and 30,000 samples")
    p = Parameters()
    mask, details = support(times[select], raw[select], p)
    fs = details["fs_hz"]
    guard = int(np.ceil(p.edge_guard_s * fs - 1e-9))
    minimum = 2 * guard + int(np.ceil(p.minimum_interior_s * fs - 1e-9))
    available = bool(mask.any())
    return dict(available=available, sample_count=details["sample_count"],
                valid_count=details["valid_count"], minimum_segment_samples=minimum,
                edge_guard_s=p.edge_guard_s,
                reason="supported_interior" if available else "no_valid_interior")


def require_available(recording, channel, start_s, end_s):
    report = check_availability(recording, channel, start_s, end_s)
    if not report["available"]:
        raise AvailabilityError(report)
    return report
