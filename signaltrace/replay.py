"""Recalculate a user-selected local JSON export without executing payload code."""
import argparse
import json
import platform
from copy import deepcopy
from pathlib import Path
import numpy as np
import scipy
from . import __version__
from .analysis import replay_recipe, parameters
from .research import Protocol, MAX_RUNS

MAX_EXPORT_BYTES = 64 * 1024 * 1024


def experiment_metadata(value):
    if not isinstance(value, dict) or set(value) != {"id", "protocol", "recording_id", "created_at"}:
        raise ValueError("Invalid experiment metadata")
    for key in ("id", "recording_id", "created_at"):
        if not isinstance(value[key], str) or not 1 <= len(value[key]) <= 80:
            raise ValueError("Invalid experiment identity or timestamp")
    Protocol.model_validate(value["protocol"])
    return deepcopy(value)


def replay_export(payload):
    try:
        size = len(json.dumps(payload, allow_nan=False).encode("utf-8"))
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise ValueError("Replay requires bounded finite JSON") from None
    if size > MAX_EXPORT_BYTES:
        raise ValueError("Export exceeds the 64 MiB replay limit")
    environment = dict(python=platform.python_version(), numpy=np.__version__,
                       scipy=scipy.__version__, signaltrace=__version__)
    if isinstance(payload, dict) and "schema" in payload:
        if payload["schema"] != "signaltrace.experiment.v1":
            raise ValueError("Unsupported experiment export schema")
        experiment = experiment_metadata(payload.get("experiment"))
        runs = payload.get("runs")
        if not isinstance(runs, list) or len(runs) > MAX_RUNS:
            raise ValueError("Experiment replay requires zero to eight runs")
        if any(not isinstance(run, dict) or run.get("experiment") != experiment or "schema" in run for run in runs):
            raise ValueError("Run experiment snapshot does not match the bundle")
        return dict(schema="signaltrace.experiment.v1", experiment=experiment,
                    runs=[replay_export(run) for run in runs], replay_environment=environment)
    if not isinstance(payload, dict) or "recipe" not in payload:
        raise ValueError("Expected a SignalTrace export containing a recipe")
    if "experiment" in payload:
        experiment = experiment_metadata(payload["experiment"])
        recipe = payload["recipe"]
        if not isinstance(recipe, dict) or recipe.get("goal") != experiment["protocol"]["target"]:
            raise ValueError("Recipe goal differs from the experiment target")
        uses_reference = recipe.get("reference") is not None
        if uses_reference != (experiment["protocol"]["evaluation"] == "synthetic_reference"):
            raise ValueError("Recipe comparator differs from the experiment evaluation")
        request = payload.get("request")
        if not isinstance(request, dict) or set(request) != {
                "experiment_id", "recording_id", "channel", "start_s", "end_s", "goal", "parameters"}:
            raise ValueError("Experiment run requires its exact analysis request")
        if (not isinstance(request["channel"], str) or not 1 <= len(request["channel"]) <= 120
                or any(isinstance(request[k], bool) or not isinstance(request[k], (int, float))
                       or not np.isfinite(request[k]) for k in ("start_s", "end_s"))):
            raise ValueError("Invalid experiment run request channel or window")
        if (request["experiment_id"] != experiment["id"] or request["recording_id"] != experiment["recording_id"]
                or request["goal"] != recipe.get("goal") or request["channel"] != recipe.get("channel")
                or {k: request[k] for k in ("start_s", "end_s")} != recipe.get("window")
                or parameters(request["parameters"]) != parameters(recipe.get("parameters", {}))):
            raise ValueError("Run request differs from the experiment or replay recipe")
    result = replay_recipe(payload["recipe"])
    result["replay_environment"] = environment
    if "experiment" in payload:
        result["experiment"] = experiment
        result["request"] = deepcopy(payload.get("request"))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.export.name.lower().startswith(".env") or args.export.suffix.lower() != ".json":
            raise ValueError("Replay input must be a non-secret JSON export")
        if args.output.name.lower().startswith(".env") or args.output.suffix.lower() != ".json":
            raise ValueError("Replay output must be a non-secret JSON file")
        if args.export.stat().st_size > MAX_EXPORT_BYTES:
            raise ValueError("Export exceeds the 64 MiB replay limit")
        payload = json.loads(args.export.read_text(encoding="utf-8"))
        result = replay_export(payload)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    except (ValueError, OSError, TypeError, KeyError, RecursionError) as error:
        parser.exit(2, f"Replay failed: {error}\n")


if __name__ == "__main__":
    main()
