"""Immutable protocol and run snapshots for the bounded local experiment session."""
from copy import deepcopy
from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_EXPERIMENTS = 8
MAX_RUNS = 8


class Protocol(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    name: str = Field(min_length=1, max_length=120)
    research_question: str = Field(default="", max_length=500)
    task: Literal["ppg_preprocessing"]
    target: Literal["pulse_timing", "waveform_sensitivity"]
    evaluation: Literal["original_sensitivity", "synthetic_reference"]
    processing_mode: Literal["offline"]
    notes: str = Field(default="", max_length=1000)

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Experiment name must contain text")
        return value


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def validate_recording(protocol, recording):
    if recording.modality != "ppg":
        raise ValueError("Experiments support PPG preprocessing only")
    if protocol.evaluation == "synthetic_reference" and recording.reference is None:
        raise ValueError("Synthetic reference evaluation requires an available evaluator reference")


def metadata(experiment):
    return deepcopy({k: experiment[k] for k in ("id", "protocol", "recording_id", "created_at")})


def summary(payload):
    result = payload["result"]
    value = {k: result[k] for k in ("id", "goal", "channel", "window", "parameters", "comparison", "metrics", "exclusions")}
    value.update(created_at=payload["created_at"], label=result["run_label"], request=payload["request"],
                 input_sha256=result["provenance"]["input_sha256"])
    return deepcopy(value)


def detail(experiment, include_runs=True):
    value = metadata(experiment)
    value["run_count"] = len(experiment["runs"])
    if include_runs:
        value["runs"] = [summary(run) for run in experiment["runs"].values()]
    return value


def export_run(payload):
    return deepcopy({k: payload[k] for k in ("result", "recipe", "experiment", "request")})
