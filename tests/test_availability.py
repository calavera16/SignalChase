import json

import numpy as np
import pytest

from signaltrace.availability import AvailabilityError, UNAVAILABLE_MESSAGE, check_availability, require_available
from signaltrace.core import Parameters, support
from signaltrace.recordings import Recording


def recording(sample_count=1250, raw=None, times=None, modality="ppg"):
    t = np.arange(sample_count)/125 if times is None else times
    x = np.sin(2*np.pi*t) if raw is None else raw
    return Recording("local", modality, t, {"PPG": x}, "a.u.", {})


@pytest.mark.parametrize("kind", ["short", "missing", "flat", "fragmented"])
def test_unavailable_is_local_bounded_and_actionable(kind, monkeypatch):
    n = 500 if kind == "short" else 1500
    raw = np.full(n, np.nan) if kind == "missing" else np.zeros(n) if kind == "flat" else None
    times = np.arange(n)/125
    if kind == "fragmented":
        times[750:] += 2
    source = recording(n, raw, times)
    def forbidden(*args, **kwargs):
        raise AssertionError("Availability must not run filters or detection")
    monkeypatch.setattr("signaltrace.core.signal.butter", forbidden)
    monkeypatch.setattr("signaltrace.core.signal.find_peaks", forbidden)
    report = check_availability(source, "PPG", 0., float(times[-1]+.008))
    assert report == dict(available=False, sample_count=n, valid_count=0,
                          minimum_segment_samples=875, edge_guard_s=3., reason="no_valid_interior")
    assert len(json.dumps(report)) < 300
    with pytest.raises(AvailabilityError) as failure:
        require_available(source, "PPG", 0., float(times[-1]+.008))
    assert str(failure.value) == UNAVAILABLE_MESSAGE
    assert failure.value.report == report


def test_minimum_segment_boundary_and_larger_guards():
    below = recording(874)
    assert not check_availability(below, "PPG", 0, 874/125)["available"]
    exact = recording(875)
    report = require_available(exact, "PPG", 0, 7)
    assert report["sample_count"] == 875 and report["valid_count"] == 125
    # The minimum guard establishes availability, not availability of every setting.
    mask, _ = support(exact.times, exact.channels["PPG"], Parameters(edge_guard_s=5))
    assert not mask.any()


@pytest.mark.parametrize("channel,start,end,modality", [
    ("missing", 0, 10, "ppg"), ("PPG", False, 10, "ppg"),
    ("PPG", 0, float("nan"), "ppg"), ("PPG", -1, 10, "ppg"),
    ("PPG", 0, 11, "ppg"), ("PPG", 2, 2, "ppg"),
    ("PPG", 0, .008, "ppg"), ("PPG", 0, 10, "ecg"),
])
def test_invalid_input_is_not_unavailable(channel, start, end, modality):
    with pytest.raises(ValueError) as failure:
        check_availability(recording(modality=modality), channel, start, end)
    assert not isinstance(failure.value, AvailabilityError)


def test_invalid_sampling_and_excessive_selection_raise():
    times = np.arange(1250)/125
    times[400] += .001
    with pytest.raises(ValueError, match="regular"):
        check_availability(recording(times=times), "PPG", 0, 10)
    with pytest.raises(ValueError, match="30,000"):
        check_availability(recording(30001), "PPG", 0, 30001/125)
