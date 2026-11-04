"""Explicit one-shot retrospective explanation jobs; no queue or retry."""
from collections import OrderedDict
from copy import deepcopy
from threading import RLock, Thread
from uuid import uuid4
from .explanation import explain, validate_artifact, ExplanationError, PLAN_CODES
from .investigation import ERROR_CATEGORIES
from .investigation_jobs import JobError
from .local_store import digest, encoded
from .credentials import ENVIRONMENT_CREDENTIAL, Credentials
from .meta_provider import MetaProvider, RESPONSE_CODES

MAX_JOBS = 4
EXPLANATION_MAX_OUTPUT_TOKENS = 8192
EXPLANATION_REASONING_EFFORT = "low"
ERRORS = set(ERROR_CATEGORIES) | {"invalid_plan", "source_changed", "invalid_provider", "interrupted"}


def public_error(error):
    field = error.get if isinstance(error, dict) else lambda key: getattr(error, key, None)
    category, status, code = (field(key) for key in ("category", "http_status", "response_code"))
    value = dict(category=category if isinstance(category, str) and category in ERRORS else "provider_failure",
                 http_status=status if type(status) is int and 100 <= status <= 599 else None)
    if (value["category"] == "invalid_response" and value["http_status"] == 200
            and isinstance(code, str) and code in RESPONSE_CODES):
        value["response_code"] = code
    plan_code = field("plan_code")
    if (value["category"] == "invalid_plan" and status is None
            and isinstance(plan_code, str) and plan_code in PLAN_CODES):
        value["plan_code"] = plan_code
    return value


class ExplanationJobs:
    def __init__(self, storage=None):
        self._lock = RLock()
        self._jobs = OrderedDict()
        self._storage = storage
        if storage is not None:
            for identifier, job in storage.load("explanation"):
                try:
                    if (set(job) != {"id", "status", "request", "stage", "error", "result", "retention"}
                            or job["id"] != identifier or job["status"] not in ("running", "completed", "failed", "interrupted")):
                        continue
                    if job["status"] == "running":
                        job.update(status="interrupted", stage="finished", error=dict(category="interrupted", http_status=None))
                    elif job["error"] is not None:
                        # Accept legacy two-field records; never surface arbitrary stored diagnostics.
                        job["error"] = public_error(job["error"])
                    job["retention"] = "restored"
                    self._jobs[identifier] = job
                except (ValueError, KeyError, TypeError):
                    continue

    def _persist(self, identifier):
        job = self._jobs[identifier]
        if self._storage is None:
            job["retention"] = "memory"
            return
        job["retention"] = "retained"
        try:
            self._storage.save("explanation", identifier, job)
        except (OSError, ValueError, TypeError, OverflowError):
            job["retention"] = "write_failed"

    def _existing(self, request):
        for job in self._jobs.values():
            if job["request"]["request_id"] == request["request_id"]:
                if job["request"] != request:
                    raise JobError(409, "This request ID already identifies a different explanation")
                return job
        return None

    def running(self):
        with self._lock:
            return any(job["status"] == "running" for job in self._jobs.values())

    def existing(self, request):
        with self._lock:
            job = self._existing(request)
            return deepcopy(job) if job is not None else None

    def _admit(self, request):
        if any(job["status"] == "running" for job in self._jobs.values()):
            raise JobError(409, "An explanation is already running; wait for it to finish")
        while len(self._jobs) >= MAX_JOBS:
            self._jobs.popitem(last=False)
        identifier = uuid4().hex
        job = dict(id=identifier, status="running", request=deepcopy(request), stage="requesting_meta",
                   error=None, result=None, retention="memory")
        self._jobs[identifier] = job
        return job

    def submit(self, request, bundle, *, api_key=ENVIRONMENT_CREDENTIAL):
        with self._lock:
            existing = self._existing(request)
            if existing is not None:
                return deepcopy(existing)
            if digest(bundle) != request["evidence_digest"]:
                raise JobError(409, "Retained evidence does not match this explanation request")
            job = self._admit(request)
            identifier = job["id"]
            self._persist(identifier)
            if api_key is ENVIRONMENT_CREDENTIAL:
                api_key = Credentials().snapshot()
            worker = Thread(target=self._run, args=(identifier, deepcopy(bundle), api_key), daemon=True, name="signaltrace-explanation")
            try:
                worker.start()
            except Exception:
                job.update(status="failed", stage="finished", error=dict(category="provider_failure", http_status=None))
                self._persist(identifier)
            return deepcopy(job)

    def _run(self, identifier, bundle, api_key=ENVIRONMENT_CREDENTIAL):
        def progress(stage):
            with self._lock:
                self._jobs[identifier]["stage"] = stage
                self._persist(identifier)
        try:
            request = self.get(identifier)["request"]
            provider = MetaProvider(allow_network=True, history_mode="stateless", request_timeout_s=90,
                                    max_output_tokens=EXPLANATION_MAX_OUTPUT_TOKENS,
                                    reasoning_effort=EXPLANATION_REASONING_EFFORT, api_key=api_key)
            plan = explain(bundle, investigation_id=request["investigation_id"], evidence_digest=request["evidence_digest"],
                           provider=provider, progress=progress)
            with self._lock:
                self._jobs[identifier].update(status="completed", stage="finished", result=plan)
                self._persist(identifier)
        except Exception as error:
            with self._lock:
                self._jobs[identifier].update(status="failed", stage="finished", error=public_error(error))
                self._persist(identifier)

    def get(self, identifier):
        with self._lock:
            if identifier not in self._jobs:
                raise JobError(404, "Explanation is unavailable or was evicted from bounded local retention")
            return deepcopy(self._jobs[identifier])

    def list(self, investigation_id=None):
        with self._lock:
            return [deepcopy(job) for job in reversed(self._jobs.values())
                    if investigation_id is None or job["request"]["investigation_id"] == investigation_id]

    def export(self, identifier):
        job = self.get(identifier)
        if job["result"] is None:
            raise JobError(409, "This explanation has no validated scene plan")
        return dict(schema="signaltrace.explanation-artifact.v1", explanation=job["result"])

    def import_artifact(self, request, artifact, bundle):
        # Artifact digest also binds idempotency; importing changed wording must be explicit.
        bound_request = {**request, "artifact_digest": digest(artifact)}
        with self._lock:
            existing = self._existing(bound_request)
            if existing is not None:
                return deepcopy(existing)
            if len(encoded(artifact)) > 64 * 1024:
                raise JobError(422, "Explanation artifact exceeds its size limit")
            try:
                plan = validate_artifact(artifact, bundle, request["investigation_id"], request["evidence_digest"])
            except ExplanationError:
                raise JobError(422, "Invalid explanation artifact or evidence binding") from None
            job = self._admit(bound_request)
            job.update(status="completed", stage="finished", result=plan)
            self._persist(job["id"])
            return deepcopy(job)
