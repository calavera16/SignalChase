import json
from signaltrace.experiment import run


def test_exports_reproducible_finite_json(tmp_path):
    first = run(tmp_path/"a", duration=90, synthetic_only=True)
    second = run(tmp_path/"b", duration=90, synthetic_only=True)
    assert first == second
    exported = json.loads((tmp_path/"a"/"report.json").read_text())
    assert exported == first
    assert len(exported["cases"]) == 3
    assert "NaN" not in (tmp_path/"a"/"report.json").read_text()
    assert (tmp_path/"a"/"report.html").exists()
    assert len(list((tmp_path/"a").glob("*.png"))) == 3
