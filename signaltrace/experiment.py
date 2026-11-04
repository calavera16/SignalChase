"""Reproducible offline experiment and self-contained report writer."""
import hashlib
import html
import json
import platform
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import scipy
from . import __version__
from .core import Parameters, compare, prepare, runs, synthetic, validate

LIMITATIONS = (
    "This is an offline numerical feasibility experiment, not a clinical tool or an AI system. "
    "Presets are fixed baselines, not optimal filters. All methods use identical valid interiors. "
    "Median subtraction and forward/backward high-pass filtering use future samples. "
    "A 3 s guard reduces boundary effects but does not prove their absence. "
    "Exact flat runs are flagged; other clipping and motion artifacts may remain undetected. "
    "Missing or flat samples are excluded, never repaired or interpolated. "
    "Synthetic truth is evaluator-only; the real recording has no beat/artifact ground truth. "
    "Real-data differences are sensitivity, not accuracy. No physiological or diagnostic interpretation, "
    "held-out generalization, model benefit or user-study result is established."
)


def array_digest(t, x):
    # Canonical little-endian float64 representation; normalize all NaNs.
    values = np.column_stack((t, x)).astype("<f8")
    values[np.isnan(values)] = np.nan
    return hashlib.sha256(values.tobytes()).hexdigest()


def analyze(name, t, raw, reference=None, p=Parameters(), identity=None):
    processed, mask, details = prepare(t, raw, p)
    evaluation = raw if reference is None else reference
    metrics = {method: compare(t, evaluation, y, mask, p) for method, y in processed.items()}
    result = dict(name=name, kind="real_sensitivity" if reference is None else "synthetic_accuracy",
                  input_sha256=array_digest(t, raw), identity=identity,
                  window_start_s=float(t[0]), window_end_s=float(t[-1]),
                  window_selection="Synthetic: first CLI duration (default 120 s). Real: fixed first 60 s; CSV timestamps become duplicated after 100 s, so the originally contemplated 120 s window fails validation. No real metrics were computed before selecting 60 s.",
                  exclusions=details, metrics=metrics)
    return result, processed, mask


def plot_case(out, name, t, raw, processed, mask, reference):
    fig, axes = plt.subplots(2, 1, figsize=(13, 7), layout="constrained")
    for ax in axes:
        ax.plot(t, raw, color="0.6", lw=0.7, label="raw (preserved)")
        if reference is not None:
            ax.plot(t, reference, color="black", lw=0.8, ls="--", label="known reference")
        for method, y in processed.items():
            ax.plot(t, y, lw=0.8, alpha=0.85, label=method)
        for a, b in runs(~mask):
            ax.axvspan(t[a], t[b-1], color="red", alpha=0.12)
        ax.set_ylabel("Signal (arbitrary units)")
        ax.grid(alpha=0.15)
    axes[0].set_title(name + " — shared axes; red shading = excluded from every metric")
    axes[0].legend(ncol=3, fontsize=8)
    axes[1].set_xlim(20, min(30, t[-1]))
    axes[1].set_title("Fixed 20–30 s zoom, selected before results")
    axes[1].set_xlabel("Time (s)")
    fig.savefig(out / f"{name}.png", dpi=140)
    plt.close(fig)


def write_html(out, report):
    parts = ["<!doctype html><html lang='en'><meta charset='utf-8'><title>SignalTrace feasibility</title>",
             "<style>body{font:16px system-ui;max-width:1200px;margin:40px auto;padding:0 20px;color:#18212d}"
             "table{border-collapse:collapse;width:100%}td,th{padding:9px;border:1px solid #ccd;text-align:left}"
             "img{width:100%}small{color:#465}pre{white-space:pre-wrap}</style>",
             "<h1>Does preprocessing change the signal we measure?</h1>",
             "<p>We compare the original signal with two fixed ways to remove slow baseline changes. "
             "Removing drift can also move or remove detected peaks. The tables retain missing and extra candidates; "
             "a small timing error alone does not demonstrate improvement. Counts apply only to the shared "
             "valid interiors: zero unmatched candidates does not mean missing intervals were recovered.</p>",
             "<p><strong>No AI is connected.</strong> These measurements establish a reproducible numerical baseline.</p>",
             "<h2>Methods and interpretation</h2><p>Unchanged preserves input samples. Median subtracts a 2 s "
             "rolling median (odd rounded window, reflected edges). High-pass uses a second-order 0.35 Hz "
             "Butterworth filter applied forward and backward (effective magnitude response squared). "
             "Both are offline and noncausal. Each finite contiguous segment is processed independently. "
             "Segments need at least 7 s, with 3 s excluded at each edge. No filtering or matching crosses gaps.</p>",
             "<p>Peak candidates are local maxima at least 0.4 s apart with prominence at least 15% of the "
             "segment's 95th–5th percentile range. These are algorithmic candidates, not annotated heartbeats. "
             "Chronological greedy one-to-one matches allow ±150 ms within each shared interior. "
             "Signed per-match shifts are available in JSON. Waveform error centers both signals independently "
             "and divides RMSE by reference standard deviation; it does not fit gain or time shifts. "
             "For real data the reference is the unchanged recording.</p>"]
    for case in report["cases"]:
        comparison_label = "change vs original" if case["kind"] == "real_sensitivity" else "error vs known reference"
        parts += [f"<h2>{html.escape(case['name'])}</h2>",
                  f"<p><strong>{comparison_label}</strong>; excluded {case['exclusions']['excluded_fraction']:.1%}; "
                  f"{case['exclusions']['nonfinite_count']} nonfinite samples; "
                  f"{case['exclusions']['flatline_count']} exact flatline samples; "
                  f"{len(case['exclusions']['too_short_segments'])} short segments excluded.</p>",
                  f"<table><tr><th>Method</th><th>Centered normalized waveform {comparison_label} (RMSE)</th>"
                  "<th>Ref / candidate / matched</th><th>Unmatched ref / candidate</th><th>Mean |shift| ms</th></tr>"]
        for method, m in case["metrics"].items():
            def fmt(v):
                return "unavailable" if v is None else f"{v:.4f}"
            parts += [f"<tr><td>{method}</td><td>{fmt(m['centered_normalized_rmse'])}</td>"
                      f"<td>{m['reference_count']} / {m['candidate_count']} / {m['matched_count']}</td>"
                      f"<td>{m['unmatched_reference_count']} / {m['unmatched_candidate_count']}</td>"
                      f"<td>{fmt(m['mean_absolute_shift_ms'])}</td></tr>"]
        parts += [f"</table><img src='{case['name']}.png' alt='Raw and processed signal with excluded intervals'>"]
    parts += ["<h2>Limitations</h2><p>"+html.escape(LIMITATIONS)+"</p>",
              "<h2>Data attribution and reproducibility</h2><p>BIDMC PPG and Respiration Dataset v1.0.0, "
              "record 01, PhysioNet. Pimentel MAF et al., Toward a robust estimation of respiratory rate "
              "from pulse oximeters, IEEE Transactions on Biomedical Engineering 64(8), 2017. "
              "<a href='https://physionet.org/content/bidmc/1.0.0/'>Dataset and citation</a>; "
              "<a href='https://physionet.org/files/bidmc/1.0.0/LICENSE'>ODC Attribution v1.0</a>. "
              "Only time and PLETH are selected; original downloaded bytes are retained. "
              "See report.json for exact identity, source metadata, parameters and every matched shift.</p>",
              "<p>The real window is the first 60 s. An initial attempt to validate 120 s failed because "
              "the publisher CSV rounds timestamps after 100 s, creating duplicates. The 60 s selection "
              "preceded computation of real metrics; this was a source-format adjustment, not preregistration. "
              "Raw timestamps were preserved and no reconstruction was performed.</p>",
              "<pre>"+html.escape(json.dumps(report["configuration"], indent=2))+"</pre></html>"]
    (out/"report.html").write_text("\n".join(parts), encoding="utf-8")


def run(output="outputs/first-experiment", data="data/raw/bidmc_01_Signals.csv", duration=120, seed=20261102, synthetic_only=False):
    if not (90 <= duration <= 480):
        raise ValueError("Duration must be 90..480 s so all predeclared synthetic cases and zoom are present")
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    p = Parameters()
    t, reference, cases = synthetic(duration, seed=seed)
    report = dict(configuration=dict(synthetic_duration_s=duration, real_duration_s=60, seed=seed, parameters=p.__dict__,
                  versions=dict(python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__,
                                matplotlib=matplotlib.__version__, signaltrace=__version__)),
                  limitations=LIMITATIONS, cases=[])
    for name, raw in cases.items():
        result, processed, mask = analyze(name, t, raw, reference, p)
        report["cases"].append(result)
        plot_case(out, name, t, raw, processed, mask, reference)
    if not synthetic_only:
        path = Path(data)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        expected = "21495169cc36e82352d8e12cc6430927946d02d240b030715088d02396ea2d5c"
        if digest != expected:
            raise ValueError("BIDMC source checksum mismatch; refuse unidentified input")
        source = json.loads((path.parent.parent/"source.json").read_text(encoding="utf-8-sig"))
        csv = np.genfromtxt(path, delimiter=",", names=True, autostrip=True)
        attempted = csv["Time_s"] < 120
        attempted_t = csv["Time_s"][attempted]
        validation = dict(attempted_window_s=120, selected_window_s=60,
                          duplicate_timestamp_count=int(np.sum(np.diff(attempted_t) == 0)))
        try:
            validate(attempted_t, csv["PLETH"][attempted])
            validation["status"] = "valid"
        except ValueError as error:
            validation.update(status="rejected", reason=str(error))
        report["configuration"]["real_source_window_validation"] = validation
        selected = csv["Time_s"] < 60
        rt, rx = csv["Time_s"][selected], csv["PLETH"][selected]
        result, processed, mask = analyze("bidmc_01", rt, rx, p=p, identity=dict(file_sha256=digest, provenance=source))
        report["cases"].append(result)
        plot_case(out, "bidmc_01", rt, rx, processed, mask, None)
    (out/"report.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    write_html(out, report)
    return report
