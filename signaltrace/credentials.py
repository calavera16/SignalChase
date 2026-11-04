"""Process-memory credentials. No file access, serialization or network activity."""
import os
from threading import RLock

ENVIRONMENT_CREDENTIAL = object()


def valid_credential(value):
    return (type(value) is str and 1 <= len(value) <= 4096
            and all(33 <= ord(character) <= 126 for character in value))


class Credentials:
    """A browser override; clearing also disables environment fallback until restart."""
    def __init__(self):
        self._lock = RLock()
        self._browser = None
        self._environment_enabled = True

    def snapshot(self):
        with self._lock:
            value = self._browser
            if value is None and self._environment_enabled:
                value = os.environ.get("SIGNALTRACE_META_API_KEY")
            return value if valid_credential(value) else None

    def status(self):
        with self._lock:
            configured = self.snapshot() is not None
            return dict(configured=configured, source=("browser" if self._browser is not None else
                        "environment") if configured else "none")

    def set(self, value):
        if not valid_credential(value):
            raise ValueError("Invalid credential")
        with self._lock:
            self._browser = value

    def clear(self):
        with self._lock:
            self._browser = None
            self._environment_enabled = False


def contains_credential(value, credential):
    """Catch literal secrets, including JSON-unescaped provider tool arguments."""
    if isinstance(value, str):
        return credential in value
    if isinstance(value, dict):
        return any(contains_credential(key, credential) or contains_credential(item, credential)
                   for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(contains_credential(item, credential) for item in value)
    return False
