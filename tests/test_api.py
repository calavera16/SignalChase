import json
import pytest
from fastapi.testclient import TestClient
from signaltrace.server import app, recordings, analyses, experiments, MAX_BODY_BYTES
from signaltrace.replay import replay_export


@pytest.fixture
def client():
    recordings.clear()
    analyses.clear()
    experiments.clear()
    with TestClient(app, base_url="http://localhost") as c:
        yield c


def demo(client, demo_id="synthetic_control"):
    response = client.post("/api/demo", json=dict(demo_id=demo_id))
    assert response.status_code == 200
    return response.json()


def test_report_module_is_local_allowlisted_asset(client):
    response = client.get("/report.js")
    assert response.status_code == 200
    assert "makeInvestigationReport" in response.text
    assert client.get("/report.js", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.get("/report.test.mjs").status_code == 404


def request_analysis(client, recording, **kwargs):
    data = dict(recording_id=recording["recording"]["id"], channel=recording["recording"]["channels"][0]["name"],
                start_s=0., end_s=30., goal="pulse_timing", parameters={})
    data.update(kwargs)
    return client.post("/api/analyze", json=data)


def test_api_demo_analysis_export_replay(client):
    assert client.get("/api/catalog").json()["meta"] == {"connected": False}
    recording = demo(client, "synthetic_missing_flatline")
    before = json.dumps(recording["plot"])
    response = request_analysis(client, recording, end_s=120.)
    assert response.status_code == 200, response.text
    result = response.json()
    export = client.get(f"/api/analyses/{result['id']}/export")
    assert export.status_code == 200 and "attachment" in export.headers["content-disposition"]
    payload = export.json()
    assert replay_export(payload)["metrics"] == result["metrics"]
    assert replay_export(payload)["exclusions"] == result["exclusions"]
    assert json.dumps(recording["plot"]) == before


def test_import_preview_modality_gate(client):
    text = "t,x\n0,1\n8,\n16,3"
    assert client.post("/api/preview", json={"csv_text": text}).json()["columns"] == ["t", "x"]
    response = client.post("/api/import", json=dict(name="wave.csv", modality="ecg", csv_text=text,
        time_column="t", time_unit="ms", signal_columns=["x"], signal_unit="mV"))
    assert response.status_code == 200
    r = response.json()
    assert r["plot"]["times"] == [0, .008, .016]
    assert r["plot"]["channels"]["x"] == [1, None, 3]
    assert request_analysis(client, r, end_s=.016).status_code == 422


def test_security_and_private_validation_errors(client):
    assert client.get("/api/catalog", headers={"Host": "evil.example"}).status_code == 403
    for origin in ("https://evil.example", "null", "http://localhost:4567", "http://localhost/evil"):
        assert client.post("/api/preview", headers={"Origin": origin}, json={"csv_text": "x"}).status_code == 403
    assert client.get("/api/catalog", headers={"Origin": "http://localhost"}).status_code == 200
    assert client.post("/api/preview", content=b"x"*(MAX_BODY_BYTES+1)).status_code == 413
    response = client.post("/api/preview", json={"csv_text": ["PRIVATE_SAMPLE_MARKER"]})
    assert response.status_code == 422 and "PRIVATE_SAMPLE_MARKER" not in response.text
    assert client.get("/.env").status_code == 404
    assert client.get("/not-whitelisted.txt").status_code == 404
    response = client.post("/api/preview", content='{"csv_text":"PRIVATE_SAMPLE_MARKER"', headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and "PRIVATE_SAMPLE_MARKER" not in response.text


def test_window_parameter_bounds_and_eviction(client):
    r = demo(client)
    for changes in (dict(end_s=0.), dict(start_s=-1.), dict(end_s=500.), dict(parameters={"edge_guard_s": 2}),
                    dict(parameters={"highpass_hz": 10}), dict(parameters={"unexpected": 1})):
        assert request_analysis(client, r, **changes).status_code == 422
    for _ in range(8):
        demo(client)
    assert len(recordings) == 8
    assert request_analysis(client, r).status_code == 404
    assert "evicted" in request_analysis(client, r).json()["detail"]
    latest = demo(client)
    first = request_analysis(client, latest).json()["id"]
    for _ in range(16):
        assert request_analysis(client, latest).status_code == 200
    assert len(analyses) == 16
    assert client.get(f"/api/analyses/{first}/export").status_code == 404
