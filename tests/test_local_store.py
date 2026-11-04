"""Temporary-directory-only checks of retention, interruption and hostile inputs."""
from copy import deepcopy
import json
import os
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4
import pytest
from types import SimpleNamespace
from signaltrace.local_store import LocalStore, digest, MAX_RECORDS
from signaltrace.investigation_jobs import InvestigationJobs, JobError
from test_explanation import bundle


def browser_roundtrip(value):
    if not shutil.which("node"):
        pytest.skip("Node is required for the real browser JSON serialization regression")
    result = subprocess.run(["node", "-e", "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8'))))"],
                            input=json.dumps(value), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


@pytest.fixture
def regional_bundle():
    from test_explanation import InvestigationProvider
    from signaltrace.investigation import investigate
    from signaltrace.meta_provider import ProviderResponse, ToolCall
    from signaltrace.recordings import demo_recording
    class RegionalProvider(InvestigationProvider):
        def respond(self, **kwargs):
            if self.round < 3:
                return super().respond(**kwargs)
            self.round += 1
            if self.round == 4:
                name, arguments = "regional_summary", dict(comparison_id="e3", split_s=15.)
            else:
                name, arguments = "conclude", dict(status="inconclusive", evidence_ids=["e1", "e2", "e3", "e4"],
                    narrative="Tested settings and regions differ; preferred method remains unresolved.", questions=[])
            return ProviderResponse(f"resp_{self.round}", (ToolCall(f"call_{self.round}", name, arguments),))
    recording = demo_recording("synthetic_drift_noise")
    return investigate(recording, channel="PPG", question="Does the setting affect timing?", notes="",
                       target="pulse_timing", start_s=0., end_s=30., provider=RegionalProvider())


def test_canonical_numeric_digest_preserves_bool_and_actual_number_changes():
    assert digest(dict(value=[1., -0., .125])) == digest(dict(value=[1, 0, .125]))
    assert digest(dict(value=False)) != digest(dict(value=0))
    assert digest(dict(value=True)) != digest(dict(value=1))
    assert digest(dict(value=.125)) != digest(dict(value=.125000000000001))


def test_real_browser_roundtrip_import_and_export_standalone_replay(regional_bundle, tmp_path):
    from signaltrace.investigation import replay_investigation
    from signaltrace.explanation import explain, validate_artifact
    from test_explanation import ExplanationProvider
    original = deepcopy(regional_bundle)
    parsed = browser_roundtrip(original)
    assert parsed == original and type(parsed["context"]["window"]["start_s"]) is int
    assert digest(parsed) == digest(original)
    store = InvestigationJobs(LocalStore(tmp_path))
    job = store.import_bundle("browser-transport", parsed)
    exported = store.export(job["id"])
    assert exported == original and exported == parsed
    replay = replay_investigation(exported)
    assert replay["comparisons"]["e3"] == exported["comparisons"]["e3"]["result"]
    plan = explain(original, investigation_id="original-id", evidence_digest=digest(original), provider=ExplanationProvider())
    artifact = browser_roundtrip(dict(schema="signaltrace.explanation-artifact.v1", explanation=plan))
    imported = validate_artifact(artifact, exported, job["id"], job["evidence_digest"])
    assert imported["investigation_id"] == job["id"] and imported["scenes"] == plan["scenes"]


def test_browser_roundtrip_changed_regional_measurement_and_bool_still_reject(regional_bundle):
    from signaltrace.investigation import replay_investigation
    parsed = browser_roundtrip(regional_bundle)
    changed = deepcopy(parsed)
    changed["evidence"]["e4"]["split_s"] += .25
    with pytest.raises(ValueError):
        replay_investigation(changed)
    boolean = deepcopy(parsed)
    assert boolean["evidence"]["e4"]["regions"][0]["metrics"]["unchanged"]["unmatched_candidate_count"] == 0
    boolean["evidence"]["e4"]["regions"][0]["metrics"]["unchanged"]["unmatched_candidate_count"] = False
    with pytest.raises(ValueError):
        replay_investigation(boolean)
    changed_result = deepcopy(parsed)
    changed_result["comparisons"]["e3"]["result"]["metrics"]["highpass"]["matched_count"] += 1
    with pytest.raises(JobError):
        InvestigationJobs().import_bundle("changed-measurement", changed_result)


def test_signed_zero_sample_changes_still_require_original_checksum(bundle):
    from signaltrace.analysis import checksum, replay_recipe
    import numpy as np
    recipe = deepcopy(bundle["comparisons"]["e2"]["recipe"])
    recipe["raw"][0] = -0.
    recipe["input_sha256"] = checksum(np.asarray(recipe["times"], float), np.asarray(recipe["raw"], float), None)
    replay_recipe(recipe)
    recipe["raw"][0] = 0
    with pytest.raises(ValueError, match="checksum"):
        replay_recipe(recipe)


def test_atomic_records_corruption_count_and_unknown_files(tmp_path):
    store = LocalStore(tmp_path)
    ids = [uuid4().hex for _ in range(MAX_RECORDS + 1)]
    for index, identifier in enumerate(ids):
        store.save("investigation", identifier, dict(sequence=index))
    loaded = store.load("investigation")
    assert [identifier for identifier, _ in loaded] == ids[1:]
    assert len(list(tmp_path.glob("investigation-*.json"))) == MAX_RECORDS
    # Incomplete temporary writes, unrelated files and corrupt records are ignored.
    (tmp_path / ".pending-interrupted").write_text("unfinished")
    (tmp_path / "unrelated.txt").write_text("test fixture deliberately not read")
    (tmp_path / "investigation-not-an-id.json").write_text("{}")
    last = tmp_path / f"investigation-{ids[-1]}.json"
    value = json.loads(last.read_text())
    value["payload"]["sequence"] = 999
    last.write_text(json.dumps(value))
    assert len(store.load("investigation")) == MAX_RECORDS - 1


def test_failed_replace_preserves_last_committed_record(tmp_path, monkeypatch):
    store = LocalStore(tmp_path)
    identifier = uuid4().hex
    store.save("explanation", identifier, dict(value="original"))
    monkeypatch.setattr(os, "replace", lambda *args: (_ for _ in ()).throw(OSError("private path")))
    with pytest.raises(OSError):
        store.save("explanation", identifier, dict(value="replacement"))
    assert store.load("explanation") == [(identifier, dict(value="original"))]
    assert not list(tmp_path.glob(".pending-*"))


@pytest.mark.parametrize("identifier", ["../../outside", ".env", "a" * 31, "a" * 33, "Z" * 32])
def test_no_client_paths_or_malformed_record_names(tmp_path, identifier):
    with pytest.raises(ValueError):
        LocalStore(tmp_path).save("investigation", identifier, {})
    assert not list(tmp_path.iterdir())


def test_limits_duplicate_json_and_nonfinite_records(tmp_path, monkeypatch):
    import signaltrace.local_store as module
    monkeypatch.setattr(module, "MAX_RECORD_BYTES", 1024)
    store = LocalStore(tmp_path)
    with pytest.raises(ValueError):
        store.save("investigation", uuid4().hex, dict(value="x" * 1024))
    with pytest.raises(ValueError):
        store.save("investigation", uuid4().hex, dict(value=float("nan")))
    identifier = uuid4().hex
    path = tmp_path / f"investigation-{identifier}.json"
    path.write_text('{"schema":"one","schema":"two"}')
    assert not store.load("investigation")


def test_symlink_directory_and_record_never_followed(tmp_path):
    target, alias = tmp_path / "target", tmp_path / "alias"
    target.mkdir()
    try:
        alias.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("Symlink creation unavailable for this user")
    with pytest.raises(OSError):
        LocalStore(alias).save("investigation", uuid4().hex, {})
    assert not LocalStore(alias).load("investigation")
    identifier = uuid4().hex
    (target / "outside.json").write_text("private")
    (target / f"investigation-{identifier}.json").symlink_to(target / "outside.json")
    assert not LocalStore(target).load("investigation")
    with pytest.raises(OSError):
        LocalStore(target).save("investigation", identifier, {})


def test_windows_reparse_attribute_is_rejected_without_following_target():
    from signaltrace.local_store import _linked
    class FakeJunction:
        def lstat(self):
            return SimpleNamespace(st_file_attributes=0x400)
        def is_symlink(self):
            return False
    assert _linked(FakeJunction())


def test_import_retains_original_restart_and_source_bound_report(bundle, tmp_path, monkeypatch):
    import signaltrace.investigation_jobs as module
    store = InvestigationJobs(LocalStore(tmp_path))
    original = deepcopy(bundle)
    job = store.import_bundle("historical", bundle)
    assert job["source"]["kind"] == "imported_historical"
    assert job["source"]["historical_identity"] == bundle["identity"]
    assert job["evidence_digest"] == digest(bundle)
    assert store.export(job["id"]) == original == bundle
    monkeypatch.setattr(module, "replay_investigation", lambda *args: pytest.fail("Restore/read recomputed evidence"))
    monkeypatch.setattr(module, "MetaProvider", lambda **kwargs: pytest.fail("Restore/read called provider"))
    restored = InvestigationJobs(LocalStore(tmp_path))
    recovered = restored.get(job["id"])
    assert recovered["retention"] == "restored" and recovered["result"] == job["result"]
    assert recovered["display_context"] == job["display_context"]
    assert restored.export(job["id"]) == bundle
    assert restored.comparison(job["id"], "e2")["result"] == bundle["comparisons"]["e2"]["result"]
    assert restored.import_bundle("historical", bundle)["id"] == job["id"]
    with pytest.raises(JobError) as error:
        restored.import_bundle("historical", {**bundle, "context": {**bundle["context"], "question": "Different?"}})
    assert error.value.status == 409


@pytest.mark.parametrize("mutation", [
    lambda b: b["comparisons"]["e2"]["result"]["metrics"]["highpass"].update(matched_count=999999),
    lambda b: b["comparisons"]["e2"]["result"]["plot"]["raw"].__setitem__(0, 999.),
    lambda b: b["evidence"]["e2"]["metrics"]["unchanged"].update(unmatched_candidate_count=False),
    lambda b: b["comparisons"]["e2"]["recipe"]["provenance"].update(private_history="never-store"),
    lambda b: b.update(credential="never-store"),
])
def test_hostile_import_rejected_before_storage(bundle, tmp_path, mutation):
    store = InvestigationJobs(LocalStore(tmp_path))
    mutation(bundle)
    with pytest.raises(JobError) as error:
        store.import_bundle("hostile", bundle)
    assert error.value.status == 422
    assert not store.list() and not list(tmp_path.iterdir())


def test_partial_bundle_remains_failed_and_replayable(bundle, tmp_path):
    # Remove the successful conclusion/round and represent a genuine provider failure.
    value = deepcopy(bundle)
    value["conclusion"] = None
    value["error"] = dict(category="provider_failure", http_status=None)
    value["trace"].pop()
    value["usage"].pop()
    job = InvestigationJobs(LocalStore(tmp_path)).import_bundle("partial", value)
    assert job["status"] == "failed" and job["result"]["evidence"]
    restored = InvestigationJobs(LocalStore(tmp_path))
    assert restored.export(job["id"]) == value and restored.get(job["id"])["status"] == "failed"


def test_interrupted_recovery_and_retention_failure_are_honest(bundle, tmp_path, monkeypatch):
    storage = LocalStore(tmp_path)
    store = InvestigationJobs(storage)
    job = store.import_bundle("retained", bundle)
    store._jobs[job["id"]].update(status="running")
    store._persist(job["id"])
    restored = InvestigationJobs(storage).get(job["id"])
    assert restored["status"] == "interrupted" and restored["error"]["category"] == "interrupted"
    store._jobs[job["id"]]["status"] = "completed"
    monkeypatch.setattr(storage, "save", lambda *args: (_ for _ in ()).throw(OSError("private detail")))
    second = store.import_bundle("another", bundle)
    assert second["retention"] == "write_failed" and second["result"] == job["result"]

