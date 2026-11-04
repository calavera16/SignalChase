"""Bounded in-memory investigation admission and detached public job snapshots."""
from collections import OrderedDict
from copy import deepcopy
from threading import RLock, Thread
from uuid import uuid4
from .investigation import investigate, investigation_context, ERROR_CATEGORIES
from .availability import require_available
from .meta_provider import MetaProvider
from .investigation import replay_investigation, comparison_summary, conclusion, MAX_BUNDLE_BYTES, exact, text_value
from .local_store import digest, encoded
from .credentials import ENVIRONMENT_CREDENTIAL, Credentials
from .requirements import assess_requirements, validate_requirements, comparison_policy_for_assessment

MAX_JOBS = 4


class JobError(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def public_bundle(bundle):
    return deepcopy({key: value for key, value in bundle.items() if key != "comparisons"})


def safe_error(error):
    category = error.get("category") if isinstance(error, dict) else getattr(error, "category", None)
    status = error.get("http_status") if isinstance(error, dict) else getattr(error, "http_status", None)
    return dict(category=category if isinstance(category, str) and category in ERROR_CATEGORIES else "provider_failure",
                http_status=status if type(status) is int and 100 <= status <= 599 else None)


class InvestigationJobs:
    """One foreground worker, no queue; completed results live until bounded eviction."""
    def __init__(self, storage=None):
        self._lock = RLock()
        self._jobs = OrderedDict()
        self._bundles = {}
        self._storage = storage
        if storage is not None:
            self._restore()

    def _persist(self, identifier):
        job = self._jobs[identifier]
        if self._storage is None:
            job["retention"] = "memory"
            return
        job["retention"] = "retained"
        try:
            self._storage.save("investigation", identifier, dict(job=job, bundle=self._bundles.get(identifier)))
        except (OSError, ValueError, TypeError, OverflowError):
            job["retention"] = "write_failed"

    def _restore(self):
        for identifier, saved in self._storage.load("investigation"):
            try:
                if not isinstance(saved, dict) or set(saved) != {"job", "bundle"}:
                    continue
                job, bundle = saved["job"], saved["bundle"]
                exact(job, ("id", "status", "request", "progress", "result", "error", "source", "evidence_digest", "display_context", "retention"))
                exact(job["source"], ("kind", "historical_identity", "recorded_rationale"))
                if (job["id"] != identifier or job["status"] not in ("running", "completed", "failed", "interrupted")
                        or not isinstance(job["request"], dict) or not isinstance(job["display_context"], dict)):
                    continue
                if bundle is not None:
                    validate_retained_shape(bundle)
                    if job.get("evidence_digest") != digest(bundle) or digest(job["result"]) != digest(public_bundle(bundle)):
                        continue
                    self._bundles[identifier] = bundle
                elif job["result"] is not None or job["status"] == "completed":
                    continue
                if job["status"] == "running":
                    job.update(status="interrupted", error=dict(category="interrupted", http_status=None))
                job["retention"] = "restored"
                self._jobs[identifier] = job
            except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
                continue

    def _existing(self, request):
        for job in self._jobs.values():
            if job["request"]["request_id"] == request["request_id"]:
                if {k: v for k, v in job["request"].items() if k != "target"} != {k: v for k, v in request.items() if k != "target"}:
                    raise JobError(409, "This request ID already identifies a different investigation")
                return job
        return None

    def running(self):
        with self._lock:
            return any(job["status"] == "running" for job in self._jobs.values())

    def existing(self, request):
        with self._lock:
            job = self._existing(request)
            return deepcopy(job) if job is not None else None

    def submit(self, request, recording, display_context=None, *, api_key=ENVIRONMENT_CREDENTIAL):
        # Admission and idempotency share the same lock; concurrent POSTs cannot queue work.
        with self._lock:
            existing = self._existing(request)
            if existing is not None:
                return deepcopy(existing)
            investigation_context(recording, **{key: request[key] for key in
                ("channel", "question", "notes", "target", "start_s", "end_s")}, requirements=request.get("requirements"))
            require_available(recording, request["channel"], request["start_s"], request["end_s"])
            if any(job["status"] == "running" for job in self._jobs.values()):
                raise JobError(409, "An investigation is already running; wait for it to finish before starting another")
            while len(self._jobs) >= MAX_JOBS:
                old_id, _ = self._jobs.popitem(last=False)
                self._bundles.pop(old_id, None)
            identifier = uuid4().hex
            job = dict(id=identifier, status="running", request=deepcopy(request),
                       progress=dict(rounds=0, tool_attempts=0, trace=[], evidence={}), result=None, error=None,
                       source=dict(kind="original_investigation", historical_identity=None,
                                   recorded_rationale="historical_model_proposal"), evidence_digest=None,
                       display_context=deepcopy(display_context) if display_context is not None else
                           report_context(request, recording.name, recording.unit), retention="memory")
            self._jobs[identifier] = job
            self._persist(identifier)
            # The detached recording is owned by this worker even after either source store evicts it.
            source = deepcopy(recording)
            source.__post_init__()  # NumPy deepcopy makes arrays writable; restore the recording invariant.
            if api_key is ENVIRONMENT_CREDENTIAL:
                api_key = Credentials().snapshot()
            worker = Thread(target=self._run, args=(identifier, source, deepcopy(request), api_key), daemon=True,
                            name="signaltrace-investigation")
            try:
                worker.start()
            except Exception:
                job.update(status="failed", error=dict(category="provider_failure", http_status=None))
                self._persist(identifier)
            return deepcopy(job)

    def _run(self, identifier, recording, request, api_key=ENVIRONMENT_CREDENTIAL):
        def progress(value):
            with self._lock:
                self._jobs[identifier]["progress"] = deepcopy(value)
                self._persist(identifier)
        try:
            require_available(recording, request["channel"], request["start_s"], request["end_s"])
            provider = MetaProvider(allow_network=True, history_mode="stateless", request_timeout_s=90, api_key=api_key)
            bundle = investigate(recording, provider=provider, progress=progress,
                                 **{key: request[key] for key in ("channel", "question", "notes", "target", "start_s", "end_s")}, requirements=request.get("requirements"))
            with self._lock:
                self._bundles[identifier] = deepcopy(bundle)
                self._jobs[identifier].update(status="failed" if bundle["error"] else "completed",
                    result=public_bundle(bundle), error=safe_error(bundle["error"]) if bundle["error"] else None,
                    progress=deepcopy({key: bundle[key] for key in ("rounds", "tool_attempts", "trace", "evidence")}))
                self._jobs[identifier]["evidence_digest"] = digest(bundle)
                self._jobs[identifier]["source"]["historical_identity"] = deepcopy(bundle["identity"])
                self._persist(identifier)
        except Exception as error:
            # Never print/log an exception or retain a provider, private history or credential.
            with self._lock:
                self._jobs[identifier].update(status="failed", error=safe_error(error))
                self._persist(identifier)

    def get(self, identifier):
        with self._lock:
            if identifier not in self._jobs:
                raise JobError(404, "Investigation is unavailable or was evicted from the bounded local session")
            return deepcopy(self._jobs[identifier])

    def list(self, experiment_id=None):
        with self._lock:
            return [deepcopy(job) for job in reversed(self._jobs.values())
                    if experiment_id is None or job["request"]["experiment_id"] == experiment_id]

    def import_bundle(self, request_id, bundle):
        """Explicit local import validates replay once; every later read is passive."""
        try:
            validate_retained_shape(bundle)
            fingerprint = digest(bundle)
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            raise JobError(422, "Invalid or oversized investigation bundle") from None
        with self._lock:
            for job in self._jobs.values():
                if job["request"]["request_id"] == request_id:
                    if job["source"]["kind"] != "imported_historical" or job["evidence_digest"] != fingerprint:
                        raise JobError(409, "This request ID already identifies a different investigation")
                    return deepcopy(job)
            if any(job["status"] == "running" for job in self._jobs.values()):
                raise JobError(409, "Wait for the running investigation before importing retained evidence")
            try:
                replay = replay_investigation(bundle)
                if digest(replay["comparisons"]) != digest({key: pair["result"] for key, pair in bundle["comparisons"].items()}):
                    raise ValueError("Inconsistent result types")
                for eid, result in replay["comparisons"].items():
                    if digest(comparison_summary(result)) != digest(bundle["evidence"][eid]):
                        raise ValueError("Inconsistent summary types")
                if bundle["conclusion"] is not None:
                    args = deepcopy(bundle["conclusion"])
                    if args["candidate"] is not None:
                        args["candidate"] = {key: args["candidate"][key] for key in ("comparison_id", "method")}
                    if digest(conclusion(args, bundle["evidence"], bundle["comparisons"])) != digest(bundle["conclusion"]):
                        raise ValueError("Inconsistent conclusion types")
            except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
                raise JobError(422, "Invalid or inconsistent investigation bundle") from None
            while len(self._jobs) >= MAX_JOBS:
                old_id, _ = self._jobs.popitem(last=False)
                self._bundles.pop(old_id, None)
            identifier = uuid4().hex
            context = bundle["context"]
            request = dict(request_id=request_id, experiment_id="imported-" + identifier,
                           recording_id="imported-" + identifier, channel="channel_1", target=context["target"],
                           start_s=context["window"]["start_s"], end_s=context["window"]["end_s"],
                           question=context["question"], notes=context["acquisition_notes"])
            if "requirements" in context:
                request["requirements"] = deepcopy(context["requirements"])
            job = dict(id=identifier, status="failed" if bundle["error"] else "completed", request=request,
                       progress=deepcopy({key: bundle[key] for key in ("rounds", "tool_attempts", "trace", "evidence")}),
                       result=public_bundle(bundle), error=safe_error(bundle["error"]) if bundle["error"] else None,
                       evidence_digest=fingerprint, retention="memory",
                       source=dict(kind="imported_historical", historical_identity=deepcopy(bundle["identity"]),
                                   recorded_rationale="historical_model_proposal"),
                       display_context=report_context(request, "Imported historical PPG investigation", context["unit"]))
            self._jobs[identifier], self._bundles[identifier] = job, deepcopy(bundle)
            self._persist(identifier)
            return deepcopy(job)

    def export(self, identifier):
        with self._lock:
            self.get(identifier)
            if identifier not in self._bundles:
                raise JobError(409, "This investigation has no replayable bundle yet")
            return deepcopy(self._bundles[identifier])

    def comparison(self, identifier, evidence_id):
        """Return only one retained numerical result, never its replay recipe/history."""
        with self._lock:
            if identifier not in self._jobs:
                raise JobError(404, "Investigation is unavailable or was evicted from the bounded local session")
            job = self._jobs[identifier]
            bundle = self._bundles.get(identifier)
            if bundle is None:
                raise JobError(409, "Comparison data are not available yet")
            pair = bundle.get("comparisons", {}).get(evidence_id)
            if pair is None:
                raise JobError(404, "Comparison evidence is unavailable")
            request = job["request"]
            return deepcopy(dict(investigation_id=identifier, comparison_id=evidence_id,
                recording_id=request["recording_id"], experiment_id=request["experiment_id"],
                channel=request["channel"], target=request["target"],
                unit=bundle["context"]["unit"], result=pair["result"]))


def report_context(request, name, unit):
    """Minimal report metadata; source arrays remain available only by evidence ID."""
    return dict(recording=dict(id=request["recording_id"], name=name, modality="ppg",
                               channels=[dict(name=request["channel"], unit=unit)]),
                experiment=dict(id=request["experiment_id"], recording_id=request["recording_id"],
                    protocol=dict(name="Retained Meta investigation", research_question=request["question"],
                                  task="ppg_preprocessing", target=request["target"], evaluation="original_sensitivity",
                                  processing_mode="offline", notes=request["notes"],
                                  **({"requirements": deepcopy(request["requirements"])} if request.get("requirements") is not None else {}))))


def validate_retained_shape(bundle):
    """Cheap resource/secret-field guard; numerical validation occurs only on import."""
    fields = {"schema", "context", "identity", "conclusion", "evidence",
            "comparisons", "trace", "rounds", "tool_attempts", "usage", "limitations", "error"}
    if isinstance(bundle, dict) and bundle.get("schema") == "signaltrace.investigation.v3":
        fields.add("requirement_assessment")
    if not isinstance(bundle, dict) or set(bundle) != fields:
        raise ValueError("Invalid bundle")
    if bundle["schema"] not in ("signaltrace.investigation.v1", "signaltrace.investigation.v2", "signaltrace.investigation.v3") or len(encoded(bundle)) > MAX_BUNDLE_BYTES:
        raise ValueError("Invalid bundle")
    if bundle["schema"] == "signaltrace.investigation.v3":
        context = bundle["context"]
        if not isinstance(context, dict) or validate_requirements(context.get("requirements")) is None or digest(bundle["requirement_assessment"]) != digest(
                assess_requirements(context["requirements"], bundle["evidence"], context["window"],
                    investigation_failed=bundle["error"] is not None,
                    comparison_policy=comparison_policy_for_assessment(bundle["requirement_assessment"]))):
            raise ValueError("Invalid requirement assessment")
    forbidden = {"encrypted_content", "private_history", "provider_history", "authorization", "api_key", "credentials"}
    pending = [(bundle, 0)]
    count = 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if depth > 24 or count > 3_000_000:
            raise ValueError("Invalid bundle")
        if isinstance(value, dict):
            if any(not isinstance(k, str) or len(k) > 160 or k.lower() in forbidden for k in value):
                raise ValueError("Invalid bundle")
            pending.extend((v, depth + 1) for v in value.values())
        elif isinstance(value, list):
            if len(value) > 30000:
                raise ValueError("Invalid bundle")
            pending.extend((v, depth + 1) for v in value)
        elif isinstance(value, str) and len(value) > 10000:
            raise ValueError("Invalid bundle")
