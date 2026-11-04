"""Publication gates use synthetic source fixtures and never inspect real secrets."""
import hashlib
import json
import os
from pathlib import Path

import pytest

from scripts import audit_public_repo as audit
from scripts import build_public_repo as builder


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "working"
    for origin, _ in builder.FILES:
        path = root / origin
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Authored synthetic source fixture\n", encoding="utf-8")
    return root


def test_selection_is_exact_data_free_and_includes_license():
    destinations = {destination for _, destination in builder.FILES}
    assert {"LICENSE", "README.md", "SECURITY.md", ".gitignore", "docs/DATA_POLICY.md",
            "signaltrace/credentials.py", "signaltrace/web/credentials.js",
            "tests/test_credentials.py", "tests/credentials.test.mjs"} <= destinations
    assert "scripts/package_submission.py" not in destinations
    assert not any(name.startswith(("outputs/", "film/", "evaluation/", "examples/")) for name in destinations)
    assert {name for name in destinations if name.startswith("data/")} == {"data/README.md"}
    assert not any(Path(name).suffix in {".csv", ".npy", ".mp4", ".png"} for name in destinations)


def test_fresh_build_manifest_and_rebuild_are_deterministic(source, tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    assert builder.build_public_repo(source, first)["ok"]
    assert builder.build_public_repo(first, second, public_layout=True)["ok"]
    assert (first / "MANIFEST.json").read_bytes() == (second / "MANIFEST.json").read_bytes()
    manifest = json.loads((first / "MANIFEST.json").read_bytes())
    for record in manifest["files"]:
        assert set(record) == {"path", "bytes", "sha256"}
        payload = (first / record["path"]).read_bytes()
        assert record["sha256"] == hashlib.sha256(payload).hexdigest()
        assert record["bytes"] == len(payload)
    with pytest.raises(audit.PublicationError, match="output_exists"):
        builder.build_public_repo(source, first)


def test_source_canary_fails_before_any_output_and_is_not_reported(source, tmp_path):
    # An obvious test placeholder is forbidden as a runtime-source credential.
    canary = "FAKE_TEST_PUBLICATION_CANARY_1234567890"
    (source / "signaltrace/core.py").write_text("api_key = '" + canary + "'\n")
    output = tmp_path / "blocked"
    result = builder.build_public_repo(source, output)
    assert not result["ok"] and not output.exists()
    assert canary not in json.dumps(result)
    assert {item["category"] for item in result["findings"]} == {"credential_literal"}
    assert all(set(item) == {"category", "path", "line"} for item in result["findings"])


@pytest.mark.parametrize("relative", [".env", ".env.local", "nested/.env.production", "../outside.py",
                                      "a/../outside.py", "a//b.py", ".git/config", "data/raw/a.csv"])
def test_forbidden_filename_rejected_before_open(source, relative, monkeypatch):
    def never_read(_):
        raise AssertionError("A forbidden file must never be opened")
    monkeypatch.setattr(Path, "read_bytes", never_read)
    with pytest.raises(audit.PublicationError):
        audit.read_named(source, relative)


def test_unlisted_env_is_never_read_or_copied(source, tmp_path, monkeypatch):
    # This temporary sentinel is fabricated. It is never read, hashed or copied.
    (source / ".env").write_text("fabricated publication test sentinel")
    original = Path.read_bytes
    def guarded(path):
        if path.name.startswith(".env"):
            raise AssertionError("Environment sentinel was opened")
        return original(path)
    monkeypatch.setattr(Path, "read_bytes", guarded)
    output = tmp_path / "public"
    assert builder.build_public_repo(source, output)["ok"]
    assert not (output / ".env").exists()
    (output / ".env.local").write_text("another fabricated sentinel")
    result = audit.audit_tree(output)
    assert not result["ok"]
    assert dict(category="forbidden_path", path=".env.local", line=0) in result["findings"]


def test_unexpected_artifact_rejected_without_open(source, tmp_path, monkeypatch):
    output = tmp_path / "public"
    assert builder.build_public_repo(source, output)["ok"]
    artifact = output / "accidental.json"
    artifact.write_text("private content must not be opened")
    original = Path.read_bytes
    def guarded(path):
        if path == artifact:
            raise AssertionError("Unexpected artifact was opened")
        return original(path)
    monkeypatch.setattr(Path, "read_bytes", guarded)
    result = audit.audit_tree(output)
    assert dict(category="unexpected_file", path="accidental.json", line=0) in result["findings"]


def test_manifest_tampering_and_missing_file_fail(source, tmp_path):
    output = tmp_path / "public"
    assert builder.build_public_repo(source, output)["ok"]
    (output / "README.md").write_text("changed")
    result = audit.audit_tree(output)
    assert any(item["category"] == "manifest_mismatch" for item in result["findings"])
    (output / "README.md").unlink()
    result = audit.audit_tree(output)
    assert dict(category="missing_file", path="README.md", line=0) in result["findings"]


def test_private_markers_and_home_paths_are_redacted(source, tmp_path):
    marker = "PRIVATE_TEST_ACCOUNT_" + "123"
    private_path = "C:" + "/" + "Users" + "/" + marker + "/file.py"
    (source / "signaltrace/core.py").write_text(private_path)
    result = builder.build_public_repo(source, tmp_path / "blocked", private_markers=(marker,))
    assert not result["ok"]
    assert {item["category"] for item in result["findings"]} == {"private_path", "private_marker"}
    assert marker not in json.dumps(result) and private_path not in json.dumps(result)


def test_obvious_test_placeholder_exception_is_per_match_and_test_only():
    placeholder = b'api_key = "FAKE_TEST_PUBLICATION_PLACEHOLDER"'
    assert not audit.scan_content("tests/test_example.py", placeholder)
    assert audit.scan_content("signaltrace/example.py", placeholder)
    # Opaque values are never exempt, even in tests. Both assignments are scanned.
    opaque = b'\napi_key = "012345678901234567890123456789"'
    findings = audit.scan_content("tests/test_example.py", placeholder + opaque)
    assert findings == [dict(category="credential_literal", path="tests/test_example.py", line=2)]


def test_json_and_environment_credential_literals_are_detected():
    opaque = "012345678901234567890123456789"
    for source in ('{"api_key": "' + opaque + '"}', 'SIGNALTRACE_META_API_KEY = "' + opaque + '"'):
        assert audit.scan_content("signaltrace/example.py", source.encode())


def test_source_and_destination_overlap_rejected_before_write(source):
    with pytest.raises(audit.PublicationError, match="separate"):
        builder.build_public_repo(source, source / "public")


def test_linked_source_is_rejected_without_read(source, tmp_path, monkeypatch):
    target = source / "signaltrace/core.py"
    target.unlink()
    outside = tmp_path / "outside.py"
    outside.write_text("must not be inspected")
    try:
        target.symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation is unavailable for this local test account")
    original = Path.read_bytes
    def guarded(path):
        if path == outside or path == target:
            raise AssertionError("Symlink target was read")
        return original(path)
    monkeypatch.setattr(Path, "read_bytes", guarded)
    with pytest.raises(audit.PublicationError, match="linked"):
        builder.build_public_repo(source, tmp_path / "blocked")


def test_hardlinked_source_rejected(source, tmp_path):
    target = source / "signaltrace/core.py"
    outside = tmp_path / "outside.py"
    target.unlink()
    outside.write_text("must not be inspected")
    try:
        os.link(outside, target)
    except OSError:
        pytest.skip("Hardlink creation is unavailable")
    with pytest.raises(audit.PublicationError, match="nonregular"):
        builder.build_public_repo(source, tmp_path / "blocked")


def test_reparse_ancestor_rejected_before_read(tmp_path, monkeypatch):
    class FakeInfo:
        st_mode = 0o040755
        st_file_attributes = 0x400
    original = Path.lstat
    candidate = tmp_path / "junction"
    def fake(path):
        return FakeInfo() if path == candidate else original(path)
    monkeypatch.setattr(Path, "lstat", fake)
    with pytest.raises(audit.PublicationError, match="linked"):
        audit.reject_links(candidate / "child.py")
