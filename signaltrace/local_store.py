"""Bounded, server-owned atomic local result records. Never loads credentials."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from threading import RLock
from uuid import uuid4
from .meta_provider import finite_json

MAX_RECORD_BYTES = 34 * 1024 * 1024
MAX_STORE_BYTES = 128 * 1024 * 1024
MAX_RECORDS = 4
KINDS = ("investigation", "explanation")
NAME = re.compile(r"(investigation|explanation)-[a-f0-9]{32}\.json\Z")


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(encoded(_canonical_numbers(value))).hexdigest()


def _canonical_numbers(value):
    """JSON transports do not preserve integral float syntax or signed zero.

    Only numerically identical finite floats are normalized. Booleans retain
    their JSON type, so false cannot stand in for a zero measurement/count.
    Original payloads and their scientific replay checksums remain untouched.
    """
    if isinstance(value, dict):
        return {key: _canonical_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canonical_numbers(item) for item in value]
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("Nonfinite digest value")
        if value.is_integer():
            return int(value)
    return value


class LocalStore:
    def __init__(self, directory=None):
        self.directory = (Path(directory) if directory is not None else Path(__file__).resolve().parent.parent / ".signaltrace-local").absolute()
        self._lock = RLock()

    def _directory(self, create=False):
        for path in (self.directory, *self.directory.parents):
            if _linked(path):
                raise OSError("Local result storage unavailable")
        if create:
            self.directory.mkdir(parents=True, exist_ok=True)
        if self.directory.exists() and not self.directory.is_dir():
            raise OSError("Local result storage unavailable")

    def _path(self, kind, identifier):
        name = f"{kind}-{identifier}.json"
        if kind not in KINDS or not NAME.fullmatch(name):
            raise ValueError("Invalid local record identity")
        path = self.directory / name
        if _linked(path):
            raise OSError("Local result storage unavailable")
        return path

    def _files(self):
        return [p for p in self.directory.iterdir() if NAME.fullmatch(p.name) and not _linked(p) and p.is_file()]

    def save(self, kind, identifier, payload):
        with self._lock:
            self._directory(create=True)
            path = self._path(kind, identifier)
            data = encoded(dict(schema="signaltrace.local-record.v1", kind=kind, id=identifier,
                                digest=digest(payload), payload=payload))
            if len(data) > MAX_RECORD_BYTES:
                raise ValueError("Local result exceeds retention limit")
            files = self._files()
            # Windows/filesystems may give consecutive replacements identical mtimes.
            # Give committed records a distinct monotonic ordering for bounded eviction.
            stamp = max(time.time_ns(), max((p.stat().st_mtime_ns for p in files), default=0) + 1_000_000)
            same = sorted((p for p in files if p.name.startswith(kind + "-") and p != path), key=lambda p: p.stat().st_mtime_ns)
            remove = same[:max(0, len(same) + 1 - MAX_RECORDS)]
            retained = [p for p in files if p != path and p not in remove]
            if sum(p.stat().st_size for p in retained) + len(data) > MAX_STORE_BYTES:
                raise ValueError("Local result storage limit reached")
            temp = self.directory / (".pending-" + uuid4().hex)
            try:
                # Exclusive creation; a failed replacement preserves the last committed result.
                with temp.open("xb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp, path)
                os.utime(path, ns=(stamp, stamp))
                for old in remove:
                    old.unlink(missing_ok=True)
            finally:
                temp.unlink(missing_ok=True)

    def load(self, kind):
        if kind not in KINDS:
            raise ValueError("Invalid local record kind")
        with self._lock:
            try:
                self._directory()
                if not self.directory.exists():
                    return []
                files = sorted(self._files(), key=lambda p: p.stat().st_mtime_ns)
                if sum(p.stat().st_size for p in files) > MAX_STORE_BYTES:
                    return []
            except OSError:
                return []
            values = []
            for path in files:
                if not path.name.startswith(kind + "-"):
                    continue
                try:
                    if path.stat().st_size > MAX_RECORD_BYTES:
                        continue
                    with path.open("rb") as handle:
                        raw = handle.read(MAX_RECORD_BYTES + 1)
                    if len(raw) > MAX_RECORD_BYTES:
                        continue
                    value = finite_json(raw.decode("utf-8"))
                    if (set(value) != {"schema", "kind", "id", "digest", "payload"}
                            or value["schema"] != "signaltrace.local-record.v1" or value["kind"] != kind
                            or self._path(kind, value["id"]) != path or value["digest"] != digest(value["payload"])):
                        continue
                    values.append((value["id"], value["payload"]))
                except (OSError, ValueError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError):
                    continue
            return values[-MAX_RECORDS:]

    def remove(self, kind, identifier):
        with self._lock:
            self._directory()
            self._path(kind, identifier).unlink(missing_ok=True)


def _linked(path):
    try:
        metadata = path.lstat()
        return path.is_symlink() or bool(getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
    except FileNotFoundError:
        return False
