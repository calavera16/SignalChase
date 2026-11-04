"""Same-origin loopback workspace API with explicit opt-in investigation jobs."""
import os
from ipaddress import ip_address
from collections import OrderedDict
from copy import deepcopy
from pathlib import Path
from threading import RLock
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from .recordings import parse_csv, import_recording, demo_recording, MODALITIES, MAX_CSV_BYTES
from .analysis import analyze_recording
from .candidate_evidence import candidate_evidence, CandidateEvidenceError
from .research import Protocol, MAX_EXPERIMENTS, MAX_RUNS, timestamp, validate_recording, metadata, detail, export_run
from .investigation import investigation_context, MAX_ROUNDS, MAX_TOOLS
from .availability import require_available, AvailabilityError
from .investigation_jobs import InvestigationJobs, JobError
from .investigation_jobs import report_context
from .investigation import MAX_BUNDLE_BYTES
from .requirements import validate_requirements
from .explanation_jobs import ExplanationJobs
from .local_store import LocalStore
from .meta_provider import MODEL, finite_json
from .credentials import Credentials

MAX_BODY_BYTES = 4 * 1024 * 1024
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class LocalBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        original_send = send
        response_started = False
        async def safe_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (b"cache-control", b"no-store"), (b"pragma", b"no-cache"),
                    (b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"),
                    (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
                ]
            await original_send(message)
        send = safe_send
        raw_headers = scope.get("headers", [])
        headers = dict(raw_headers)
        guarded = {b"host", b"origin", b"content-type", b"content-length", b"sec-fetch-site", b"x-signaltrace-request"}
        if any(sum(name == item for item, _ in raw_headers) > 1 for name in guarded):
            return await JSONResponse({"detail": "Ambiguous request headers"}, 400)(scope, receive, send)
        peer = (scope.get("client") or ("",))[0]
        try:
            local_peer = ip_address(peer).is_loopback
        except ValueError:
            # Starlette's in-process TestClient has no TCP peer.
            local_peer = peer == "testclient"
        if not local_peer:
            return await JSONResponse({"detail": "Only loopback clients are accepted"}, 403)(scope, receive, send)
        host = headers.get(b"host", b"").decode("latin1")
        try:
            parsed = urlsplit("http://" + host)
            valid_host = (parsed.hostname in LOCAL_HOSTS and not parsed.username and not parsed.password
                          and not parsed.path and not parsed.query and not parsed.fragment
                          and host.lower() in {parsed.hostname, f"{parsed.hostname}:{parsed.port}", "[::1]", f"[::1]:{parsed.port}"})
            port = parsed.port
        except ValueError:
            valid_host = False
        if not valid_host:
            return await JSONResponse({"detail": "Only a loopback Host is accepted"}, 403)(scope, receive, send)
        origin = headers.get(b"origin")
        if origin:
            try:
                o = urlsplit(origin.decode("latin1"))
                valid_origin = o.scheme in ("http", "https") and o.hostname == parsed.hostname and (o.port or (443 if o.scheme == "https" else 80)) == (port or (443 if scope.get("scheme") == "https" else 80)) and o.scheme == scope.get("scheme", "http") and not o.path and not o.query and not o.fragment and not o.username and not o.password
            except ValueError:
                valid_origin = False
            if not valid_origin:
                return await JSONResponse({"detail": "Cross-origin requests are not accepted"}, 403)(scope, receive, send)
        if headers.get(b"sec-fetch-site", b"").lower() == b"cross-site":
            return await JSONResponse({"detail": "Cross-site requests are not accepted"}, 403)(scope, receive, send)
        credential_route = scope.get("path") == "/api/credentials/meta"
        if credential_route and scope.get("query_string"):
            return await JSONResponse({"detail": "Credential routes do not accept query parameters"}, 400)(scope, receive, send)
        if credential_route and scope["method"] in ("PUT", "DELETE"):
            if not origin or headers.get(b"x-signaltrace-request") != b"1":
                return await JSONResponse({"detail": "Same-origin credential request header required"}, 403)(scope, receive, send)
            if headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() != b"application/json":
                return await JSONResponse({"detail": "JSON content type required"}, 415)(scope, receive, send)
        body = bytearray()
        import_body = scope.get("path") == "/api/investigations/import"
        body_limit = 8192 if credential_route else MAX_BUNDLE_BYTES + 64 * 1024 if import_body else MAX_BODY_BYTES
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > body_limit:
                return await JSONResponse({"detail": "Request body exceeds its bounded size limit"}, 413)(scope, receive, send)
            if not message.get("more_body", False):
                break
        if body and (credential_route or scope.get("path") in ("/api/investigations/import", "/api/explanations/import")):
            try:
                finite_json(body.decode("utf-8"))
            except (ValueError, UnicodeError, RecursionError, OverflowError):
                return await JSONResponse({"detail": "Invalid JSON import"}, 422)(scope, receive, send)
        delivered = False
        async def buffered_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()
        try:
            await self.app(scope, buffered_receive, send)
        except Exception:
            # Do not rethrow to the web server: unhandled tracebacks can contain
            # user input, provider details or credentials. No exception logging.
            if not response_started:
                await JSONResponse({"detail": "Local request failed"}, 500)(scope, buffered_receive, send)


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PreviewInput(Input):
    csv_text: str = Field(max_length=MAX_CSV_BYTES)


class ImportInput(PreviewInput):
    name: str = Field(min_length=1, max_length=160)
    modality: Literal["ppg", "ecg", "eeg", "other"]
    time_column: str = Field(max_length=120)
    time_unit: Literal["s", "ms"]
    signal_columns: list[str] = Field(min_length=1, max_length=8)
    signal_unit: str = Field(min_length=1, max_length=24)


class DemoInput(Input):
    demo_id: str = Field(max_length=80)


class ParameterInput(Input):
    median_window_s: float = Field(default=2, ge=.5, le=5, allow_inf_nan=False)
    highpass_hz: float = Field(default=.35, ge=.1, le=1, allow_inf_nan=False)
    edge_guard_s: float = Field(default=3, ge=3, le=10, allow_inf_nan=False)


class AnalysisInput(Input):
    experiment_id: str | None = Field(default=None, max_length=80)
    recording_id: str = Field(max_length=80)
    channel: str = Field(max_length=120)
    start_s: float = Field(allow_inf_nan=False)
    end_s: float = Field(allow_inf_nan=False)
    goal: Literal["pulse_timing", "waveform_sensitivity"]
    parameters: ParameterInput = Field(default_factory=ParameterInput)


class ExperimentInput(Input):
    recording_id: str = Field(min_length=1, max_length=80)
    protocol: Protocol


class InvestigationInput(Input):
    request_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    experiment_id: str = Field(min_length=1, max_length=80)
    recording_id: str = Field(min_length=1, max_length=80)
    channel: str = Field(min_length=1, max_length=120)
    start_s: float = Field(allow_inf_nan=False)
    end_s: float = Field(allow_inf_nan=False)
    question: str = Field(min_length=1, max_length=500)
    notes: str = Field(max_length=1000)
    requirements: dict | None = None
    allow_network: Literal[True]

    @field_validator("requirements", mode="before")
    @classmethod
    def confirmed_requirements(cls, value):
        return validate_requirements(value)

    @field_validator("allow_network", mode="before")
    @classmethod
    def explicit_consent(cls, value):
        if value is not True:
            raise ValueError("Explicit boolean consent is required")
        return value


class InvestigationImportInput(Input):
    request_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    bundle: dict


class ExplanationInput(Input):
    request_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    investigation_id: str = Field(min_length=1, max_length=80)
    evidence_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    allow_network: Literal[True]

    @field_validator("allow_network", mode="before")
    @classmethod
    def explicit_consent(cls, value):
        if value is not True:
            raise ValueError("Explicit boolean consent is required")
        return value


class ExplanationImportInput(Input):
    request_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    investigation_id: str = Field(min_length=1, max_length=80)
    artifact: dict


app = FastAPI(title="SignalTrace", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LocalBoundary)
recordings = OrderedDict()
analyses = OrderedDict()
experiments = OrderedDict()
store_lock = RLock()
credentials = Credentials()
local_store = LocalStore(directory=os.environ.get("SIGNALTRACE_LOCAL_STORE_DIR") or None)
investigation_jobs = InvestigationJobs(storage=local_store)
explanation_jobs = ExplanationJobs(storage=local_store)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, error):
    # Pydantic's input/context fields can contain complete CSVs or sample arrays. Never return or log them.
    return JSONResponse({"detail": "Invalid request fields; check required values, supported choices and parameter bounds"}, 422)


@app.exception_handler(ValueError)
async def invalid_value(request, error):
    return JSONResponse({"detail": "Invalid local input or unavailable resource"}, 422)


@app.exception_handler(JobError)
async def invalid_job(request, error):
    return JSONResponse({"detail": error.detail}, error.status)


@app.get("/api/credentials/meta")
def credential_status():
    return credentials.status()


@app.put("/api/credentials/meta")
async def set_credential(request: Request):
    try:
        value = finite_json((await request.body()).decode("utf-8"))
        if type(value) is not dict or set(value) != {"api_key"}:
            raise ValueError("Invalid credential fields")
        with store_lock:
            if investigation_jobs.running() or explanation_jobs.running():
                raise HTTPException(409, "Wait for running Meta jobs before changing the key")
            credentials.set(value["api_key"])
            return credentials.status()
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        raise HTTPException(422, "Invalid API key; use 1 to 4096 visible ASCII characters with no spaces") from None


@app.delete("/api/credentials/meta")
async def clear_credential(request: Request):
    body = await request.body()
    if body:
        try:
            if finite_json(body.decode("utf-8")) != {}:
                raise ValueError("Unexpected fields")
        except (ValueError, UnicodeError, RecursionError, OverflowError):
            raise HTTPException(422, "Clear-key request must be empty") from None
    with store_lock:
        if investigation_jobs.running() or explanation_jobs.running():
            raise HTTPException(409, "Wait for running Meta jobs before clearing the key")
        credentials.clear()
        return credentials.status()


@app.get("/api/investigations/config")
def investigation_config():
    # Presence only. Reading configuration never constructs a provider or touches credential files.
    return dict(available=True, key_configured=credentials.status()["configured"],
                model=MODEL, history_mode="stateless", max_rounds=MAX_ROUNDS, max_tool_attempts=MAX_TOOLS)


@app.post("/api/investigations", status_code=202)
def start_investigation(body: InvestigationInput):
    request = body.model_dump(exclude={"allow_network"}, exclude_none=True)
    existing = investigation_jobs.existing(request)
    if existing is not None:
        return existing
    with store_lock:
        experiment = get(experiments, body.experiment_id)
        if body.recording_id != experiment["recording_id"]:
            raise HTTPException(409, "Recording does not match the saved experiment")
        request["target"] = experiment["protocol"]["target"]
        try:
            investigation_context(experiment["recording"],
                **{key: request[key] for key in ("channel", "question", "notes", "target", "start_s", "end_s")}, requirements=request.get("requirements"))
            require_available(experiment["recording"], body.channel, body.start_s, body.end_s)
        except AvailabilityError as error:
            raise HTTPException(422, str(error)) from None
        except (ValueError, TypeError, KeyError, OverflowError):
            raise HTTPException(422, "Select a valid PPG channel and interval containing 3..30000 samples; check question and notes") from None
        key = credentials.snapshot()
        if key is None:
            raise HTTPException(503, "Set a Meta API key in the local workspace or server process environment before requesting an investigation")
        context = report_context(request, experiment["recording"].name, experiment["recording"].unit)
        context["experiment"]["protocol"] = deepcopy(experiment["protocol"])
        if request.get("requirements") is not None:
            context["experiment"]["protocol"]["requirements"] = deepcopy(request["requirements"])
        return investigation_jobs.submit(request, experiment["recording"], context, api_key=key)


@app.get("/api/investigations")
def list_investigations(experiment_id: str | None = None):
    with store_lock:
        if experiment_id is not None:
            get(experiments, experiment_id)
        return dict(jobs=investigation_jobs.list(experiment_id))


@app.post("/api/investigations/import", status_code=201)
def import_investigation(body: InvestigationImportInput):
    return investigation_jobs.import_bundle(body.request_id, body.bundle)


@app.get("/api/explanations/config")
def explanation_config():
    return dict(available=True, key_configured=credentials.status()["configured"],
                model=MODEL, history_mode="stateless", max_model_calls=1)


@app.post("/api/explanations", status_code=202)
def start_explanation(body: ExplanationInput):
    request = body.model_dump(exclude={"allow_network"})
    existing = explanation_jobs.existing(request)
    if existing is not None:
        return existing
    job = investigation_jobs.get(body.investigation_id)
    if job.get("evidence_digest") != body.evidence_digest:
        raise HTTPException(409, "Retained evidence does not match this explanation request")
    bundle = investigation_jobs.export(body.investigation_id)
    with store_lock:
        key = credentials.snapshot()
        if key is None:
            raise HTTPException(503, "Set a Meta API key in the local workspace or server process environment before requesting an explanation")
        return explanation_jobs.submit(request, bundle, api_key=key)


@app.get("/api/explanations")
def list_explanations(investigation_id: str | None = None):
    return dict(jobs=explanation_jobs.list(investigation_id))


@app.post("/api/explanations/import", status_code=201)
def import_explanation(body: ExplanationImportInput):
    job = investigation_jobs.get(body.investigation_id)
    bundle = investigation_jobs.export(body.investigation_id)
    request = dict(request_id=body.request_id, investigation_id=body.investigation_id, evidence_digest=job["evidence_digest"])
    return explanation_jobs.import_artifact(request, body.artifact, bundle)


@app.get("/api/explanations/{identifier}")
def get_explanation(identifier: str):
    return explanation_jobs.get(identifier)


@app.get("/api/explanations/{identifier}/export")
def export_explanation(identifier: str):
    return JSONResponse(explanation_jobs.export(identifier),
        headers={"Content-Disposition": 'attachment; filename="signaltrace-explanation.json"'})


@app.get("/api/investigations/{identifier}")
def get_investigation(identifier: str):
    return investigation_jobs.get(identifier)


@app.get("/api/investigations/{identifier}/export")
def export_investigation(identifier: str):
    return JSONResponse(investigation_jobs.export(identifier),
        headers={"Content-Disposition": 'attachment; filename="signaltrace-investigation.json"'})


@app.get("/api/investigations/{identifier}/comparisons/{evidence_id}")
def get_investigation_comparison(identifier: str, evidence_id: str):
    payload = investigation_jobs.comparison(identifier, evidence_id)
    try:
        annotation = candidate_evidence(evidence_id, payload.get("result"))
    except CandidateEvidenceError:
        annotation = None
    # The stored/cached result and exported replay bundle remain untouched.
    return {**payload, "candidate_evidence": annotation,
            "candidate_evidence_status": "available" if annotation is not None else "unavailable"}


def put(store, value, capacity):
    identifier = uuid4().hex
    with store_lock:
        store[identifier] = value
        while len(store) > capacity:
            store.popitem(last=False)
    return identifier


def get(store, identifier):
    with store_lock:
        if identifier not in store:
            raise HTTPException(404, "Item is unavailable or was evicted from the bounded local session; open the recording or rerun analysis")
        return store[identifier]


@app.get("/api/catalog")
def catalog():
    demos = [("synthetic_control", "Synthetic control"),
             ("synthetic_drift_noise", "Synthetic drift + noise"),
             ("synthetic_missing_flatline", "Synthetic missing + flatline")]
    if (Path(__file__).resolve().parent.parent / "data" / "raw" / "bidmc_01_Signals.csv").is_file():
        demos.append(("bidmc_01", "BIDMC record 01 - first 60 s"))
    return dict(modalities=[dict(id=m, label=m.upper() if m != "other" else "Other waveform", analysis_supported=m == "ppg") for m in MODALITIES],
                demos=[dict(id=k, label=v, modality="ppg") for k, v in demos],
                meta=dict(connected=False))


@app.post("/api/preview")
def preview(body: PreviewInput):
    columns, rows = parse_csv(body.csv_text)
    return dict(columns=columns, sample_rows=rows[:5])


@app.post("/api/import")
def import_csv(body: ImportInput):
    recording = import_recording(**body.model_dump())
    identifier = put(recordings, recording, 8)
    return recording.view(identifier)


@app.post("/api/demo")
def demo(body: DemoInput):
    recording = demo_recording(body.demo_id)
    identifier = put(recordings, recording, 8)
    return recording.view(identifier)


@app.post("/api/analyze")
def analyze(body: AnalysisInput):
    if body.experiment_id is not None:
        # Hold one lock through calculation and snapshot insertion: concurrent ninth runs,
        # experiment eviction and readers cannot observe a partial or discarded commit.
        with store_lock:
            experiment = get(experiments, body.experiment_id)
            if body.recording_id != experiment["recording_id"]:
                raise HTTPException(409, "Recording does not match the saved experiment")
            protocol = Protocol(**experiment["protocol"])
            if body.goal != protocol.target:
                raise HTTPException(409, "Analysis goal does not match the saved experiment target")
            validate_recording(protocol, experiment["recording"])
            if len(experiment["runs"]) >= MAX_RUNS:
                raise HTTPException(409, "This experiment already has eight runs; create a new experiment to continue")
            result, recipe = analyze_recording(experiment["recording"], body.channel, body.start_s, body.end_s,
                                               body.goal, body.parameters.model_dump(), evaluation=protocol.evaluation)
            identifier = uuid4().hex
            result.update(id=identifier, recording_id=body.recording_id, channel=body.channel,
                          experiment_id=body.experiment_id, run_label=f"Run {len(experiment['runs']) + 1}")
            payload = deepcopy(dict(result=result, recipe=recipe, experiment=metadata(experiment),
                                    request=body.model_dump(), created_at=timestamp()))
            experiment["runs"][identifier] = payload
            # Legacy export endpoint remains usable for experiment results too.
            analyses[identifier] = export_run(payload)
            while len(analyses) > 16:
                analyses.popitem(last=False)
            return deepcopy(result)
    recording = get(recordings, body.recording_id)
    result, recipe = analyze_recording(recording, body.channel, body.start_s, body.end_s, body.goal, body.parameters.model_dump())
    result.update(recording_id=body.recording_id, channel=body.channel)
    identifier = put(analyses, dict(result=result, recipe=recipe), 16)
    result["id"] = identifier
    return result


@app.post("/api/experiments")
def create_experiment(body: ExperimentInput):
    with store_lock:
        recording = recordings.get(body.recording_id)
        if recording is None:
            # Reopening a retained experiment must also permit saving a new protocol
            # after ordinary source eviction. IDs still resolve only to bounded memory.
            recording = next((e["recording"] for e in experiments.values()
                              if e["recording_id"] == body.recording_id), None)
        if recording is None:
            raise HTTPException(404, "Recording is unavailable or was evicted from the bounded local session; open it again")
        validate_recording(body.protocol, recording)
        identifier = uuid4().hex
        experiment = dict(id=identifier, protocol=body.protocol.model_dump(), recording_id=body.recording_id,
                          recording=recording, created_at=timestamp(), runs=OrderedDict())
        experiments[identifier] = experiment
        while len(experiments) > MAX_EXPERIMENTS:
            experiments.popitem(last=False)
        return detail(experiment)


@app.get("/api/experiments")
def list_experiments():
    with store_lock:
        return dict(experiments=[detail(e, False) for e in reversed(experiments.values())], storage="memory")


@app.get("/api/experiments/{identifier}")
def get_experiment(identifier: str):
    with store_lock:
        return detail(get(experiments, identifier))


@app.get("/api/experiments/{identifier}/recording")
def experiment_recording(identifier: str):
    with store_lock:
        experiment = get(experiments, identifier)
        return deepcopy(experiment["recording"].view(experiment["recording_id"]))


@app.get("/api/experiments/{identifier}/runs/{run_id}")
def get_run(identifier: str, run_id: str):
    with store_lock:
        return deepcopy(get(get(experiments, identifier)["runs"], run_id)["result"])


@app.get("/api/experiments/{identifier}/runs/{run_id}/export")
def export_experiment_run(identifier: str, run_id: str):
    with store_lock:
        payload = export_run(get(get(experiments, identifier)["runs"], run_id))
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="signaltrace-run.json"'})


@app.get("/api/experiments/{identifier}/export")
def export_experiment(identifier: str):
    with store_lock:
        experiment = get(experiments, identifier)
        payload = dict(schema="signaltrace.experiment.v1", experiment=metadata(experiment),
                       runs=[export_run(run) for run in experiment["runs"].values()])
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="signaltrace-experiment.json"'})


@app.get("/api/analyses/{identifier}/export")
def export_analysis(identifier: str):
    payload = get(analyses, identifier)
    return JSONResponse(payload, headers={"Content-Disposition": 'attachment; filename="signaltrace-analysis.json"'})


web = Path(__file__).resolve().parent / "web"


@app.get("/")
def workspace():
    path = web / "index.html"
    if not path.is_file():
        raise HTTPException(404, "Workspace assets are unavailable")
    return FileResponse(path)


@app.get("/{asset}")
def workspace_asset(asset: str):
    if asset not in {"index.html", "app.css", "app.js", "chart.js", "report.js", "evidence.js", "requirements.js", "findings.js", "findings.css", "credentials.js"} or not (web / asset).is_file():
        raise HTTPException(404, "Asset is unavailable")
    return FileResponse(web / asset)
