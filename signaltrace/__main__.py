import argparse
from .experiment import run

parser = argparse.ArgumentParser(description="Offline PPG preprocessing sensitivity; no AI/API required")
parser.add_argument("--output", default="outputs/first-experiment")
parser.add_argument("--data", default="data/raw/bidmc_01_Signals.csv")
parser.add_argument("--duration", type=float, default=120)
parser.add_argument("--seed", type=int, default=20261102)
parser.add_argument("--synthetic-only", action="store_true")
args = parser.parse_args()
report = run(args.output, args.data, args.duration, args.seed, args.synthetic_only)
for case in report["cases"]:
    print(case["name"], "excluded", round(case["exclusions"]["excluded_fraction"], 4))
    for method, metrics in case["metrics"].items():
        print(" ", method, "RMSE", metrics["centered_normalized_rmse"], "mean |shift| ms", metrics["mean_absolute_shift_ms"],
              "unmatched", metrics["unmatched_reference_count"], metrics["unmatched_candidate_count"])
print("Report:", args.output + "/report.html")
