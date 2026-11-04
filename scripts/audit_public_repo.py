"""Fail-closed, value-redacted audit of an explicitly selected publication tree."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat


FORBIDDEN_PARTS = frozenset((
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    ".signaltrace-local", "outputs", "film", "evaluation", "raw", "exports", "logs",
    "recordings", "datasets", "screenshots", "examples",
))
TEXT_SUFFIXES = frozenset((".py", ".js", ".mjs", ".css", ".html", ".md", ".txt", ".json"))
MAX_SOURCE_BYTES = 2 * 1024 * 1024
PATTERNS = (
    ("private_path", re.compile(r"(?:[A-Za-z]:[\\/]+Users[\\/]|/(?:home|Users)/)", re.I)),
    ("email_address", re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")),
    ("private_key", re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")),
    ("credential_token", re.compile(r"(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|EA[A-Za-z0-9]{40,})\b")),
    ("credential_literal", re.compile(r"(?i)\b(?:SIGNALTRACE_META_API_KEY|api[_-]?key|access[_-]?token|secret|password)[\"']?\s*[=:]\s*[\"'](?P<value>[A-Za-z0-9_+./=-]{20,})[\"']")),
    ("bearer_literal", re.compile(r"(?i)\bbearer\s+(?P<value>[A-Za-z0-9_+./=-]{20,})")),
)


class PublicationError(ValueError):
    """Carries categories and relative paths only; never source contents."""


def safe_relative(value):
    if not isinstance(value, str):
        raise PublicationError("invalid_path")
    path = PurePosixPath(value)
    parts = value.split("/")
    if (not value or "\\" in value or ":" in value or path.is_absolute()
            or any(part in ("", ".", "..") for part in parts)
            or any(part.casefold().startswith(".env") or part.casefold() in FORBIDDEN_PARTS for part in parts)):
        raise PublicationError("forbidden_path")
    return path.as_posix()


def reject_links(path):
    """Check ancestors with lstat before resolving, reading, hashing or writing."""
    for current in reversed((path, *path.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise PublicationError("linked_path")


def read_named(root, relative):
    """The filename guard runs before any content operation, including stat size."""
    relative = safe_relative(relative)
    path = root / relative
    if path.name not in ("LICENSE", ".gitignore") and path.suffix.casefold() not in TEXT_SUFFIXES:
        raise PublicationError("forbidden_file_type")
    reject_links(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise PublicationError("missing_file: " + relative) from None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise PublicationError("nonregular_file: " + relative)
    if info.st_size > MAX_SOURCE_BYTES:
        raise PublicationError("oversize_file: " + relative)
    return path.read_bytes()


def scan_content(relative, payload, private_markers=()):
    """Return category/path/line only. This is a heuristic gate, not a proof."""
    relative = safe_relative(relative)
    try:
        content = payload.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [dict(category="non_utf8", path=relative, line=0)]
    findings = []
    if "\x00" in content:
        findings.append(dict(category="binary_content", path=relative, line=0))
    markers = tuple(str(value).casefold() for value in private_markers if value)
    for number, line in enumerate(content.splitlines(), 1):
        for category, expression in PATTERNS:
            for match in expression.finditer(line):
                # Narrow, reviewable fixture convention, never a file-wide bypass.
                # Real provider-token/private-key shapes are always rejected.
                if (relative.startswith("tests/") and category in ("credential_literal", "bearer_literal")
                        and re.fullmatch(r"FAKE_TEST_[A-Za-z0-9_-]+", match.group("value"))):
                    continue
                findings.append(dict(category=category, path=relative, line=number))
        if any(marker in line.casefold() for marker in markers):
            findings.append(dict(category="private_marker", path=relative, line=number))
    return findings


def public_entries():
    try:
        from scripts.build_public_repo import FILES
    except ModuleNotFoundError:
        from build_public_repo import FILES
    return {destination for _, destination in FILES} | {"MANIFEST.json"}


def audit_tree(root, *, private_markers=(), expected=None):
    """Inventory only this public tree, skipping forbidden/unexpected content."""
    root = Path(root).absolute()
    reject_links(root)
    if not root.is_dir():
        raise PublicationError("missing_public_tree")
    expected = public_entries() if expected is None else set(expected)
    expected_dirs = {str(parent).replace("\\", "/") for value in expected
                     for parent in PurePosixPath(value).parents if str(parent) != "."}
    found, findings = set(), []

    def visit(folder, prefix=""):
        # scandir does not open file contents or follow junctions/symlinks.
        with os.scandir(folder) as inventory:
            for item in sorted(inventory, key=lambda entry: entry.name):
                relative = prefix + item.name
                try:
                    safe_relative(relative)
                except PublicationError:
                    findings.append(dict(category="forbidden_path", path=relative, line=0))
                    continue
                try:
                    reject_links(Path(item.path))
                except PublicationError:
                    findings.append(dict(category="linked_path", path=relative, line=0))
                    continue
                if item.is_dir(follow_symlinks=False):
                    if relative in expected_dirs:
                        visit(Path(item.path), relative + "/")
                    else:
                        findings.append(dict(category="unexpected_directory", path=relative, line=0))
                elif relative not in expected:
                    findings.append(dict(category="unexpected_file", path=relative, line=0))
                else:
                    found.add(relative)

    visit(root)
    for relative in sorted(expected - found):
        findings.append(dict(category="missing_file", path=relative, line=0))
    payloads = {}
    for relative in sorted(found):
        try:
            payload = read_named(root, relative)
        except PublicationError:
            findings.append(dict(category="unreadable_file", path=relative, line=0))
            continue
        payloads[relative] = payload
        findings.extend(scan_content(relative, payload, private_markers))
    if "MANIFEST.json" in payloads:
        try:
            manifest = json.loads(payloads["MANIFEST.json"])
            records = manifest["files"]
            names = [safe_relative(record["path"]) for record in records]
            if (manifest["schema"] != "signaltrace.public-manifest.v1" or
                    len(names) != len(set(names)) or set(names) != expected - {"MANIFEST.json"}):
                raise ValueError
            for record in records:
                payload = payloads.get(record["path"])
                if payload is None or record["bytes"] != len(payload) or record["sha256"] != hashlib.sha256(payload).hexdigest():
                    raise ValueError
        except (KeyError, TypeError, ValueError, PublicationError):
            findings.append(dict(category="manifest_mismatch", path="MANIFEST.json", line=0))
    return dict(ok=not findings, files=len(found), findings=findings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree", type=Path)
    parser.add_argument("--private-marker", action="append", default=[], help="Private account/name marker; never stored in the tree")
    args = parser.parse_args()
    try:
        result = audit_tree(args.tree, private_markers=args.private_marker)
    except (PublicationError, OSError):
        result = dict(ok=False, findings=[dict(category="audit_unavailable", path=".", line=0)])
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
