"""Build a new, data-free public folder from an explicit reviewed source allowlist."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    from scripts.audit_public_repo import PublicationError, audit_tree, read_named, reject_links, safe_relative, scan_content
except ModuleNotFoundError:
    from audit_public_repo import PublicationError, audit_tree, read_named, reject_links, safe_relative, scan_content


RUNTIME = (
    "__init__.py", "__main__.py", "analysis.py", "availability.py", "candidate_evidence.py",
    "core.py", "credentials.py", "experiment.py", "explanation.py", "explanation_jobs.py",
    "investigate.py", "investigation.py", "investigation_jobs.py", "local_store.py",
    "meta_provider.py", "recordings.py", "regional.py", "replay.py", "research.py", "requirements.py", "server.py",
)
WEB = ("app.css", "app.js", "chart.js", "credentials.js", "evidence.js", "findings.css", "findings.js", "index.html", "report.js", "requirements.js")
TESTS = (
    "test_analysis.py", "test_api.py", "test_availability.py", "test_candidate_evidence.py", "test_core.py",
    "test_credentials.py", "test_experiment.py", "test_explanation.py", "test_investigate_cli.py",
    "test_investigation.py", "test_investigation_jobs.py", "test_local_store.py", "test_meta_provider.py",
    "test_recordings.py", "test_regional.py", "test_research.py", "test_requirements.py", "test_publication.py",
    "requirements.test.mjs", "frontend.test.mjs", "report.test.mjs", "evidence.test.mjs", "findings.test.mjs", "credentials.test.mjs",
)
FILES = (
    ("publication/README.md", "README.md"), ("publication/LICENSE", "LICENSE"),
    ("SECURITY.md", "SECURITY.md"), ("DATA_POLICY.md", "docs/DATA_POLICY.md"),
    ("DATA_POLICY.md", "data/README.md"), ("ARCHITECTURE.md", "docs/ARCHITECTURE.md"),
    ("CONTRIBUTING.md", "CONTRIBUTING.md"), ("gitignore.txt", ".gitignore"),
    ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
    ("requirements.txt", "requirements.txt"), ("package.json", "package.json"), ("package-lock.json", "package-lock.json"),
    ("scripts/build_public_repo.py", "scripts/build_public_repo.py"),
    ("scripts/audit_public_repo.py", "scripts/audit_public_repo.py"),
) + tuple(("signaltrace/" + name, "signaltrace/" + name) for name in RUNTIME) + tuple(
    ("signaltrace/web/" + name, "signaltrace/web/" + name) for name in WEB
) + tuple(("tests/" + name, "tests/" + name) for name in TESTS)


def collect_sources(source_root, *, private_markers=(), public_layout=False):
    """Never enumerate the working source tree; read named text sources only."""
    source_root = Path(source_root).absolute()
    reject_links(source_root)
    checked, destinations = [], set()
    # Validate every path before reading any source contents.
    for origin, destination in FILES:
        origin = safe_relative(destination if public_layout else origin)
        destination = safe_relative(destination)
        if destination.casefold() in destinations:
            raise PublicationError("duplicate_destination")
        destinations.add(destination.casefold())
        reject_links(source_root / origin)
        checked.append((origin, destination))
    payloads, findings = {}, []
    for origin, destination in checked:
        payload = read_named(source_root, origin)
        findings.extend(scan_content(destination, payload, private_markers))
        payloads[destination] = payload
    return payloads, findings


def build_public_repo(source_root, output_root, *, private_markers=(), public_layout=False):
    source_root, output_root = Path(source_root).absolute(), Path(output_root).absolute()
    reject_links(source_root)
    reject_links(output_root)
    if output_root.exists():
        raise PublicationError("output_exists_select_fresh_folder")
    source_root, output_root = source_root.resolve(), output_root.resolve()
    if output_root.is_relative_to(source_root) or source_root.is_relative_to(output_root):
        raise PublicationError("output_must_be_separate_from_source")
    payloads, findings = collect_sources(source_root, private_markers=private_markers, public_layout=public_layout)
    if findings:
        # No content, exception string or absolute source path is exposed.
        return dict(ok=False, files=0, findings=findings)
    manifest = dict(schema="signaltrace.public-manifest.v1", files=[
        dict(path=name, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        for name, payload in sorted(payloads.items())
    ])
    payloads["MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    # Exclusive creation prevents accidental replacement of another prepared tree.
    output_root.mkdir(parents=True, exist_ok=False)
    for name, payload in sorted(payloads.items()):
        target = output_root / name
        reject_links(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as handle:
            handle.write(payload)
    return audit_tree(output_root, private_markers=private_markers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).absolute().parents[1])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--public-layout", action="store_true", help="Rebuild from an already prepared public tree")
    parser.add_argument("--private-marker", action="append", default=[])
    args = parser.parse_args()
    try:
        result = build_public_repo(args.source, args.output, private_markers=args.private_marker, public_layout=args.public_layout)
    except (PublicationError, OSError):
        result = dict(ok=False, files=0, findings=[dict(category="build_unavailable", path=".", line=0)])
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
