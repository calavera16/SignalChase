"""Bounded recording ingestion. Input samples and genuine time gaps are preserved."""
import csv
import hashlib
import io
from dataclasses import dataclass
from pathlib import Path
import numpy as np
from .core import synthetic

MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 32
MODALITIES = ("ppg", "ecg", "eeg", "other")


def parse_csv(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_CSV_BYTES:
        raise ValueError("CSV text must be at most 2 MiB")
    try:
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        headers = next(reader)
        headers = [h.strip() for h in headers]
        if not headers or len(headers) > MAX_COLUMNS or any(not h or len(h) > 120 for h in headers):
            raise ValueError("Provide 1..32 nonblank column names of at most 120 characters")
        if len(set(headers)) != len(headers):
            raise ValueError("Duplicate column names are not supported")
        rows = []
        for row in reader:
            if len(row) != len(headers):
                raise ValueError("Every CSV row must have the same number of cells as its header")
            if any(len(cell) > 1024 for cell in row):
                raise ValueError("CSV cells must be at most 1024 characters")
            rows.append(row)
            if len(rows) > MAX_ROWS:
                raise ValueError("CSV exceeds 100,000 data rows")
        return headers, rows
    except (csv.Error, StopIteration):
        raise ValueError("CSV is empty or malformed") from None


def validate_name(name):
    if not isinstance(name, str) or not name.strip() or len(name) > 160:
        raise ValueError("Provide a file name of 1..160 characters")
    lower = name.lower()
    if "/" in name or "\\" in name or any(c in name for c in ("\x00", "\r", "\n")):
        raise ValueError("Use a file name, not a path")
    if lower.startswith(".env") or any(s in lower for s in ("secret", "credential", "private_key", "id_rsa")):
        raise ValueError("Secret-like files cannot be imported")
    if not lower.endswith(".csv"):
        raise ValueError("Only CSV files can be imported")


def finite_list(values):
    return [float(v) if np.isfinite(v) else None for v in values]


@dataclass(frozen=True)
class Recording:
    name: str
    modality: str
    times: np.ndarray
    channels: dict
    unit: str
    provenance: dict
    reference: np.ndarray | None = None

    def __post_init__(self):
        for arr in [self.times, *self.channels.values(), self.reference]:
            if arr is not None:
                arr.setflags(write=False)

    def view(self, identifier):
        dt = np.diff(self.times)
        nominal = float(np.median(dt))
        gaps = int(np.sum(dt > 1.5 * nominal))
        missing = {k: int(np.sum(~np.isfinite(v))) for k, v in self.channels.items()}
        warnings = []
        if gaps:
            warnings.append(f"{gaps} timestamp gap(s) preserved; no resampling performed.")
        if any(missing.values()):
            warnings.append("Missing signal samples are preserved and excluded during PPG analysis.")
        if np.any(np.abs(dt[dt <= 1.5 * nominal] / nominal - 1) > .02):
            warnings.append("Irregular sampling: PPG analysis requires regular segments within 2%.")
        if self.modality != "ppg":
            warnings.append("Generic inspection only; this modality has no processing module.")
        return dict(recording=dict(id=identifier, name=self.name, modality=self.modality,
                    has_reference=self.reference is not None,
                    channels=[dict(name=k, unit=self.unit) for k in self.channels], sample_count=len(self.times),
                    start_s=float(self.times[0]), end_s=float(self.times[-1]),
                    duration_s=float(self.times[-1]-self.times[0]), sample_rate_hz=1/nominal,
                    provenance=self.provenance),
                    inspection=dict(warnings=warnings, gap_count=gaps, missing_by_channel=missing),
                    plot=dict(times=self.times.tolist(), channels={k: finite_list(v) for k, v in self.channels.items()}))


def import_recording(name, modality, csv_text, time_column, time_unit, signal_columns, signal_unit):
    validate_name(name)
    if modality not in MODALITIES or time_unit not in ("s", "ms"):
        raise ValueError("Choose a supported modality and an explicit time unit (s or ms)")
    if not isinstance(signal_unit, str) or not signal_unit.strip() or len(signal_unit) > 24 or any(ord(c) < 32 for c in signal_unit):
        raise ValueError("Signal unit must be a nonblank label of at most 24 characters")
    headers, rows = parse_csv(csv_text)
    if len(rows) < 3:
        raise ValueError("At least three data rows are required")
    if not 1 <= len(signal_columns) <= 8 or len(set(signal_columns)) != len(signal_columns):
        raise ValueError("Choose 1..8 distinct signal columns")
    if time_column not in headers or any(c not in headers or c == time_column for c in signal_columns):
        raise ValueError("Select an existing time column and distinct existing signal columns")
    def numeric(column, missing=False):
        values = []
        for row in rows:
            cell = row[headers.index(column)].strip()
            try:
                value = np.nan if missing and not cell else float(cell)
            except ValueError:
                raise ValueError("Selected columns contain malformed numeric cells") from None
            if np.isinf(value) or (not missing and not np.isfinite(value)):
                raise ValueError("Time must be finite; infinite signal values are not supported")
            values.append(value)
        return np.asarray(values, dtype=float)
    times = numeric(time_column) / (1000 if time_unit == "ms" else 1)
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        delta = np.diff(times)
        safe_time = (np.all(delta > 0) and np.isfinite(delta).all() and
                     np.isfinite(times[-1] - times[0]) and np.isfinite(1 / np.median(delta)))
    if not safe_time:
        raise ValueError("Timestamps must be finite and strictly increasing; duplicates are not repaired")
    channels = {c: numeric(c, True) for c in signal_columns}
    return Recording(name, modality, times, channels, signal_unit,
                     dict(source="local_csv", original_csv_sha256=hashlib.sha256(csv_text.encode()).hexdigest(),
                          declared_time_unit=time_unit, time_column=time_column,
                          amplitude_conversion="none", timestamp_repair="none"))


def demo_recording(identifier):
    if identifier in ("synthetic_control", "synthetic_drift_noise", "synthetic_missing_flatline"):
        t, reference, cases = synthetic()
        return Recording(identifier, "ppg", t, {"PPG": cases[identifier]}, "a.u.",
                         dict(source="synthetic", seed=20261102, duration_s=120,
                              reference_use="evaluation_only"), reference)
    if identifier != "bidmc_01":
        raise ValueError("Unknown demo recording")
    path = Path(__file__).resolve().parent.parent / "data" / "raw" / "bidmc_01_Signals.csv"
    if not path.is_file():
        raise ValueError("BIDMC local source is not installed. See data/README.md for the verified download, or open a synthetic demo / import CSV")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != "21495169cc36e82352d8e12cc6430927946d02d240b030715088d02396ea2d5c":
        raise ValueError("Bundled BIDMC source checksum mismatch")
    data = np.genfromtxt(path, delimiter=",", names=True, autostrip=True)
    select = data["Time_s"] < 60
    return Recording("BIDMC record 01 — first 60 s", "ppg", data["Time_s"][select],
                     {"PLETH": data["PLETH"][select]}, "a.u.",
                     dict(source="BIDMC PPG and Respiration Dataset v1.0.0 / PhysioNet", record="01",
                          file_sha256=digest, selected_window="first 60 s; original timestamps preserved",
                          license="ODC Attribution v1.0", url="https://physionet.org/content/bidmc/1.0.0/"))
