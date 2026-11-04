import numpy as np
import pytest
from signaltrace.recordings import import_recording, parse_csv, demo_recording, MAX_ROWS


def imported(text="time,ppg\n0,1\n8,\n24,NaN", **kwargs):
    opts = dict(name="record.csv", modality="ppg", csv_text=text, time_column="time",
                time_unit="ms", signal_columns=["ppg"], signal_unit="a.u.")
    opts.update(kwargs)
    return import_recording(**opts)


def test_mapping_missing_conversion_and_gap_preserved():
    r = imported()
    np.testing.assert_equal(r.times, [0, .008, .024])
    assert np.isnan(r.channels["ppg"][1:]).all()
    assert not r.times.flags.writeable and not r.channels["ppg"].flags.writeable
    assert r.view("x")["inspection"]["missing_by_channel"] == {"ppg": 2}
    r = imported("time,ppg\n0,1\n8,2\n16,3\n40,4")
    assert r.view("x")["inspection"]["gap_count"] == 1


def test_reference_availability_is_explicit_without_oracle_samples():
    synthetic_view = demo_recording("synthetic_control").view("synthetic")
    assert synthetic_view["recording"]["has_reference"] is True
    assert imported().view("local")["recording"]["has_reference"] is False
    assert "reference" not in synthetic_view["plot"]


@pytest.mark.parametrize("text", ["", "t,t\n1,2", "t,\n1,2", "t,x\n1", 't,x\n1,"unterminated',
                                    "time,ppg\n0,1\n0,2\n8,3", "time,ppg\n0,1\n-1,2\n8,3",
                                    "time,ppg\nNaN,1\n8,2\n16,3", "time,ppg\n0,Inf\n8,2\n16,3",
                                    "time,ppg\n0,no\n8,2\n16,3"])
def test_invalid_csv_rejected(text):
    with pytest.raises(ValueError):
        imported(text)


def test_quoted_csv_and_bounds():
    assert parse_csv('time,"channel,a"\n0,"one,two"')[0] == ["time", "channel,a"]
    for text in ("t,x\n" + "0,1\n" * (MAX_ROWS+1), "a," * 32 + "b\n", "a,b\n0," + "x" * 1025):
        with pytest.raises(ValueError):
            parse_csv(text)
    with pytest.raises(ValueError, match="2 MiB"):
        parse_csv("界" * 700_000)


@pytest.mark.parametrize("name", [".env", ".env.csv", "secrets.csv", "dir/a.csv", "test.txt", "credentials.csv"])
def test_disallowed_names(name):
    with pytest.raises(ValueError):
        imported(name=name)


def test_all_demos():
    for identifier in ("synthetic_control", "synthetic_drift_noise", "synthetic_missing_flatline"):
        r = demo_recording(identifier)
        assert r.modality == "ppg" and len(r.times) >= 7500


def test_optional_installed_bidmc_demo():
    from pathlib import Path
    source = Path(__file__).resolve().parent.parent / "data" / "raw" / "bidmc_01_Signals.csv"
    if not source.is_file():
        pytest.skip("Optional local BIDMC download is not installed")
    r = demo_recording("bidmc_01")
    assert len(r.times) == 7500
    assert r.provenance["file_sha256"] == "21495169cc36e82352d8e12cc6430927946d02d240b030715088d02396ea2d5c"


@pytest.mark.parametrize("text", ["time,ppg\n0,1\n5e-324,2\n1e-323,3", "time,ppg\n-1e308,1\n0,2\n1e308,3"])
def test_derived_timestamp_overflow_rejected(text):
    with pytest.raises(ValueError, match="Timestamps"):
        imported(text, time_unit="s")


def test_missing_bundled_source_is_actionable(monkeypatch):
    from pathlib import Path
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    with pytest.raises(ValueError, match="not installed"):
        demo_recording("bidmc_01")
