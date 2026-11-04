"""Experiment API snapshots, retention, comparator and portable replay contracts."""
import copy
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from signaltrace.server import app, recordings, analyses, experiments, get_run, get_experiment
from signaltrace.replay import replay_export


@pytest.fixture
def client():
    recordings.clear()
    analyses.clear()
    experiments.clear()
    with TestClient(app, base_url="http://localhost") as client:
        yield client


def protocol(**updates):
    value = dict(name="Pulse timing", research_question="Does preprocessing shift candidates?",
                 task="ppg_preprocessing", target="pulse_timing", evaluation="original_sensitivity",
                 processing_mode="offline", notes="Offline research")
    value.update(updates)
    return value


def source(client):
    return client.post("/api/demo", json={"demo_id": "synthetic_drift_noise"}).json()["recording"]["id"]


def create(client, recording_id=None, **updates):
    return client.post("/api/experiments", json=dict(recording_id=recording_id or source(client), protocol=protocol(**updates)))


def run(client, experiment, **updates):
    request = dict(experiment_id=experiment["id"], recording_id=experiment["recording_id"], channel="PPG",
                   start_s=0., end_s=30., goal=experiment["protocol"]["target"], parameters={})
    request.update(updates)
    return client.post("/api/analyze", json=request)


@pytest.mark.parametrize("updates", [dict(name=" "), dict(name="x"*121), dict(research_question="x"*501),
    dict(notes="x"*1001), dict(task="sleep"), dict(target="hrv"), dict(evaluation="accuracy"),
    dict(processing_mode="live"), dict(name=5), dict(unexpected="value")])
def test_protocol_bounds(client, updates):
    assert create(client, **updates).status_code == 422
    assert not experiments


def test_source_identity_reference_and_target_gates(client):
    e = create(client).json()
    assert run(client, e, recording_id=source(client)).status_code == 409
    assert run(client, e, goal="waveform_sensitivity").status_code == 409
    assert run(client, e, end_s=1.).status_code == 422
    assert get_experiment(e["id"])["run_count"] == 0
    imported = dict(name="local.csv", modality="ppg", csv_text="t,x\n0,1\n1,2\n2,3", time_column="t",
                    time_unit="s", signal_columns=["x"], signal_unit="a.u.")
    rid = client.post("/api/import", json=imported).json()["recording"]["id"]
    assert create(client, rid, evaluation="synthetic_reference").status_code == 422
    assert create(client, rid).status_code == 200
    imported["modality"] = "ecg"
    rid = client.post("/api/import", json=imported).json()["recording"]["id"]
    assert create(client, rid).status_code == 422


def test_comparator_and_immutable_snapshots(client, tmp_path):
    rid = source(client)
    e = create(client, rid).json()
    result = run(client, e).json()
    assert result["comparison"] == "original"
    assert result["plot"]["reference"] is None
    second = run(client, e, parameters={"median_window_s": 3.}, start_s=10., end_s=40.).json()
    root = f"/api/experiments/{e['id']}"
    assert client.get(f"{root}/runs/{result['id']}").json() == result
    assert second["id"] != result["id"]
    # Even direct callers cannot mutate retained API snapshots.
    changed = get_run(e["id"], result["id"])
    changed["plot"]["raw"][0] = 999
    changed["parameters"]["median_window_s"] = 5
    changed_detail = get_experiment(e["id"])
    changed_detail["protocol"]["name"] = "changed"
    changed_detail["runs"][0]["metrics"].clear()
    assert get_run(e["id"], result["id"]) == result
    info = client.get(root).json()
    assert info["protocol"] == e["protocol"]
    assert info["run_count"] == 2
    assert "plot" not in info["runs"][0]
    assert info["runs"][0]["input_sha256"] == result["provenance"]["input_sha256"]
    individual = client.get(f"{root}/runs/{result['id']}/export").json()
    assert individual == client.get(f"/api/analyses/{result['id']}/export").json()
    assert individual["recipe"]["reference"] is None
    replay = replay_export(individual)
    assert replay["metrics"] == result["metrics"]
    assert replay["experiment"]["protocol"] == e["protocol"]
    assert replay["request"] == individual["request"]
    bundle = client.get(f"{root}/export").json()
    replay = replay_export(bundle)
    assert [r["metrics"] for r in replay["runs"]] == [result["metrics"], second["metrics"]]
    assert [r["exclusions"] for r in replay["runs"]] == [result["exclusions"], second["exclusions"]]
    assert replay["experiment"] == bundle["experiment"]
    path, output = tmp_path / "bundle.json", tmp_path / "replayed.json"
    path.write_text(json.dumps(bundle), encoding="utf-8")
    subprocess.run([sys.executable, "-m", "signaltrace.replay", str(path), "--output", str(output)], check=True)
    assert json.loads(output.read_text())["runs"][1]["metrics"] == second["metrics"]
    oracle = create(client, rid, evaluation="synthetic_reference").json()
    evaluated = run(client, oracle).json()
    assert evaluated["comparison"] == "synthetic_reference"
    assert evaluated["metrics"] != result["metrics"]
    assert evaluated["provenance"]["input_sha256"] != result["provenance"]["input_sha256"]
    assert run(client, e, evaluation="synthetic_reference").status_code == 422


def test_pinned_recording_and_bounded_experiments(client):
    e = create(client).json()
    original = client.get(f"/api/experiments/{e['id']}/recording").json()
    pinned = experiments[e["id"]]["recording"]
    assert pinned is recordings[e["recording_id"]]
    for _ in range(8):
        source(client)
    assert e["recording_id"] not in recordings
    assert client.get(f"/api/experiments/{e['id']}/recording").json() == original
    assert run(client, e).status_code == 200
    fork = create(client, e["recording_id"], name="Revised protocol").json()
    assert fork["id"] != e["id"]
    assert experiments[fork["id"]]["recording"] is pinned
    assert run(client, fork).status_code == 200
    assert get_experiment(e["id"])["protocol"] == e["protocol"]
    created = [create(client).json() for _ in range(8)]
    listing = client.get("/api/experiments").json()
    assert listing["storage"] == "memory"
    assert len(experiments) == len(listing["experiments"]) == 8
    assert [v["id"] for v in listing["experiments"]] == [v["id"] for v in reversed(created)]
    assert client.get(f"/api/experiments/{e['id']}").status_code == 404
    assert run(client, e).status_code == 404


def test_run_cap_atomic_under_concurrent_requests(client):
    e = create(client).json()
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: run(client, e), range(10)))
    assert sorted(r.status_code for r in responses) == [200]*8 + [409]*2
    info = get_experiment(e["id"])
    assert info["run_count"] == 8
    assert [r["label"] for r in info["runs"]] == [f"Run {n}" for n in range(1, 9)]
    assert len({r["id"] for r in info["runs"]}) == 8
    first = info["runs"][0]["id"]
    # Global result eviction cannot remove an experiment's retained run.
    other = create(client).json()
    for _ in range(8):
        assert run(client, other).status_code == 200
    third = create(client).json()
    assert run(client, third).status_code == 200
    assert first not in analyses
    assert client.get(f"/api/experiments/{e['id']}/runs/{first}").status_code == 200
    assert client.get(f"/api/experiments/{other['id']}/runs/{first}").status_code == 404


def test_bundle_rejects_invalid_structure_and_comparator(client, monkeypatch):
    e = create(client).json()
    run(client, e)
    bundle = client.get(f"/api/experiments/{e['id']}/export").json()
    mutations = [lambda b: b.update(schema="unknown"), lambda b: b.update(runs=b["runs"]*9),
                 lambda b: b.update(runs={}), lambda b: b["runs"][0]["experiment"].update(id="other"),
                 lambda b: b["runs"][0].update(schema="signaltrace.experiment.v1")]
    for mutate in mutations:
        bad = copy.deepcopy(bundle)
        mutate(bad)
        with pytest.raises(ValueError):
            replay_export(bad)
    mismatched = copy.deepcopy(bundle["runs"][0])
    mismatched["request"]["start_s"] = 4.
    with pytest.raises(ValueError, match="request differs"):
        replay_export(mismatched)
    individual = bundle["runs"][0]
    individual["experiment"]["protocol"]["evaluation"] = "synthetic_reference"
    with pytest.raises(ValueError, match="comparator"):
        replay_export(individual)
    monkeypatch.setattr("signaltrace.replay.MAX_EXPORT_BYTES", 20)
    with pytest.raises(ValueError, match="64 MiB"):
        replay_export(bundle)


def test_empty_bundle_is_explicit_empty_replay(client):
    e = create(client).json()
    bundle = client.get(f"/api/experiments/{e['id']}/export").json()
    assert replay_export(bundle)["runs"] == []


def test_concurrent_creates_keep_capacity_and_unique_ids(client):
    rid = source(client)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda i: create(client, rid, name=f"Experiment {i}"), range(12)))
    assert all(r.status_code == 200 for r in responses)
    ids = {r.json()["id"] for r in responses}
    assert len(ids) == 12
    assert len(experiments) == 8
    assert set(experiments) <= ids
