import copy
import json
import subprocess
import sys
import numpy as np
import pytest
from signaltrace.analysis import analyze_recording, replay_recipe
from signaltrace.recordings import demo_recording, Recording


def analysis(recording=None, **opts):
    r = recording or demo_recording("synthetic_missing_flatline")
    values = dict(channel=next(iter(r.channels)), start_s=0., end_s=120., goal="pulse_timing", parameter_values={})
    values.update(opts)
    return analyze_recording(r, **values)


def test_replay_and_raw_immutability(tmp_path):
    r = demo_recording("synthetic_missing_flatline")
    original = r.channels["PPG"].copy()
    result, recipe = analysis(r)
    replayed = replay_recipe(recipe)
    assert replayed["metrics"] == result["metrics"]
    assert replayed["exclusions"] == result["exclusions"]
    np.testing.assert_equal(r.channels["PPG"], original)
    assert result["plot"]["raw"][5000] is None
    assert result["plot"]["median"][0] is None
    source, out = tmp_path / "export.json", tmp_path / "new-output-directory" / "replay.json"
    source.write_text(json.dumps(dict(recipe=recipe, result=result), allow_nan=False), encoding="utf-8")
    subprocess.run([sys.executable, "-m", "signaltrace.replay", str(source), "--output", str(out)], check=True)
    assert json.loads(out.read_text())["metrics"] == result["metrics"]
    damaged = copy.deepcopy(recipe)
    damaged["raw"][0] += .1
    with pytest.raises(ValueError, match="checksum"):
        replay_recipe(damaged)


@pytest.mark.parametrize("opts", [dict(start_s=-1.), dict(end_s=121.), dict(end_s=0.), dict(end_s=2.),
    dict(parameter_values={"median_window_s": .1}), dict(parameter_values={"edge_guard_s": 11}),
    dict(parameter_values={"highpass_hz": 2}), dict(goal="invented"), dict(channel="missing")])
def test_analysis_rejects_bad_windows_and_parameters(opts):
    with pytest.raises(ValueError):
        analysis(**opts)


def test_modality_and_sample_limit():
    r = demo_recording("synthetic_control")
    generic = Recording(r.name, "eeg", r.times, r.channels, r.unit, r.provenance)
    with pytest.raises(ValueError, match="only"):
        analysis(generic)
    t = np.arange(40_000) / 125
    large = Recording("large", "ppg", t, {"PPG": np.sin(t)}, "a.u.", {})
    with pytest.raises(ValueError, match="30,000"):
        analysis(large, end_s=320.)


def test_explicit_evaluation_requires_available_reference():
    r = demo_recording("synthetic_control")
    real = Recording("without reference", "ppg", r.times, r.channels, r.unit, {})
    with pytest.raises(ValueError, match="requires an available"):
        analysis(real, evaluation="synthetic_reference")
    with pytest.raises(ValueError, match="Unsupported evaluation"):
        analysis(r, evaluation="invented")
    legacy, _ = analysis(real)
    explicit, recipe = analysis(real, evaluation="original_sensitivity")
    assert legacy["metrics"] == explicit["metrics"]
    assert recipe["reference"] is None


def test_no_matching_across_gap():
    r = demo_recording("synthetic_control")
    selected = (r.times < 20) | (r.times >= 25)
    gap = Recording("gap", "ppg", r.times[selected], {"PPG": r.channels["PPG"][selected]}, "a.u.", {})
    result, _ = analysis(gap)
    assert len(result["exclusions"]["gap_after_indices"]) == 1
    assert len(result["exclusions"]["valid_intervals_indices"]) == 2


@pytest.mark.parametrize("fill", [np.nan, .75])
def test_missing_or_flat_windows_are_not_successful_empty_metrics(fill):
    t = np.arange(1250) / 125
    r = Recording("unusable", "ppg", t, {"PPG": np.full(len(t), fill)}, "a.u.", {})
    with pytest.raises(ValueError, match="Insufficient valid data"):
        analysis(r, end_s=10.)


@pytest.mark.parametrize("argv", [[".env", "--output", "result.json"],
    [".env.private.json", "--output", "result.json"], ["export.json", "--output", ".env.json"]])
def test_replay_rejects_secret_names_before_any_io(monkeypatch, argv):
    from pathlib import Path
    from signaltrace.replay import main
    def forbidden(*args, **kwargs):
        raise AssertionError("No file IO should occur for rejected names")
    monkeypatch.setattr(sys, "argv", ["signaltrace.replay", *argv])
    monkeypatch.setattr(Path, "stat", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    monkeypatch.setattr(Path, "write_text", forbidden)
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 2
