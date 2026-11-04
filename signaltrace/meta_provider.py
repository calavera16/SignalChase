"""Opt-in, bounded Meta Responses transport. Never loads credential files."""
import json
import math
import os
import re
import time
from dataclasses import dataclass, field
import httpx
from .credentials import ENVIRONMENT_CREDENTIAL, valid_credential, contains_credential

ENDPOINT = "https://api.meta.ai/v1/responses"
MODEL = "muse-spark-1.3"
MAX_RESPONSE_BYTES = 256 * 1024
MAX_OUTPUT_TOKENS = 2048
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
CALL_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
HISTORY_MODES = ("stored", "stateless")
MAX_REQUEST_BYTES = 1024 * 1024
MAX_HISTORY_BYTES = 768 * 1024
MAX_CUMULATIVE_REQUEST_BYTES = 4 * 1024 * 1024
DEFAULT_REQUEST_TIMEOUT_S = 90.0
RESPONSE_CODES = frozenset((
    "invalid_encoding", "invalid_json", "invalid_envelope", "invalid_response_id",
    "incomplete_max_output_tokens", "incomplete_other", "failed_response", "cancelled_response", "nonterminal_response",
    "unknown_status", "model_mismatch", "invalid_output_shape", "unsupported_output_item",
    "invalid_call_id", "invalid_call_name", "malformed_arguments", "missing_encrypted_reasoning",
    "invalid_message_shape", "unsupported_message_phase", "refusal", "no_output",
))
FINISH_REMINDER = ("End with a structured tool call alone. Use conclude for inconclusive sensitivity findings with "
                   "no preferred method, or needs_information with a question; omit candidate. Use finish for a "
                   "supported candidate proposal. Cite observed evidence; do not invent evidence or measurements.")


def request_timeout(value):
    """Validate a numeric timeout without accepting booleans or coercing strings."""
    if type(value) not in (int, float) or not 10 <= value <= 180 or not math.isfinite(value):
        raise ProviderError("invalid_request_timeout")
    return float(value)


class ProviderError(Exception):
    """Fixed public category; never contains a body, credential or exception text."""
    def __init__(self, category, http_status=None, *, response_code=None):
        if response_code is not None and (not isinstance(response_code, str) or response_code not in RESPONSE_CODES):
            raise ValueError("invalid_response_code")
        self.category = category
        self.http_status = http_status
        self.response_code = response_code
        super().__init__(category)


@dataclass(frozen=True)
class ToolCall:
    call_id: str
    name: str
    arguments: dict


@dataclass(frozen=True)
class ProviderResponse:
    response_id: str
    calls: tuple
    usage: dict = field(default_factory=dict)
    message_only: bool = False


def finite_json(text):
    """Reject duplicate object keys and nonfinite JSON extension literals."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    def reject(value):
        raise ValueError("Nonfinite JSON")
    return json.loads(text, object_pairs_hook=pairs, parse_constant=reject)


class MetaProvider:
    provider_name = "meta"
    model = MODEL
    execution_mode = "live"

    def __init__(self, *, allow_network=False, transport=None, history_mode="stored",
                 request_timeout_s=DEFAULT_REQUEST_TIMEOUT_S, max_output_tokens=MAX_OUTPUT_TOKENS,
                 reasoning_effort=None, api_key=ENVIRONMENT_CREDENTIAL):
        if allow_network is not True:
            raise ProviderError("network_not_authorized")
        if history_mode not in HISTORY_MODES:
            raise ProviderError("invalid_history_mode")
        if type(max_output_tokens) is not int or not 16 <= max_output_tokens <= 8192:
            raise ValueError("invalid_max_output_tokens")
        if reasoning_effort is not None and (type(reasoning_effort) is not str or reasoning_effort != "low"):
            raise ValueError("invalid_reasoning_effort")
        self._reasoning_effort = reasoning_effort
        self._max_output_tokens = max_output_tokens
        self._request_timeout_s = request_timeout(request_timeout_s)
        key = os.environ.get("SIGNALTRACE_META_API_KEY") if api_key is ENVIRONMENT_CREDENTIAL else api_key
        if not valid_credential(key):
            raise ProviderError("missing_or_invalid_credential")
        self._key = key
        self._transport = transport
        self._history_mode = history_mode
        self._reset()
        # Injected transports can fabricate every response, including model IDs.
        self.execution_mode = "mocked_test" if transport is not None else "live"

    @property
    def history_mode(self):
        return self._history_mode

    @property
    def request_timeout_s(self):
        return self._request_timeout_s

    @property
    def max_output_tokens(self):
        return self._max_output_tokens

    @property
    def reasoning_effort(self):
        return self._reasoning_effort

    def _reset(self):
        # Opaque encrypted reasoning exists only in this private, ephemeral history.
        self._history = []
        self._previous = None
        self._pending = ()
        self._message_pending = False
        self._contract = None
        self._completion_only = False
        self._response_ids = set()
        self._call_ids = set()
        self._request_bytes = 0

    def respond(self, *, instructions, context, tools, previous_response_id=None, tool_outputs=(),
                completion_only=False):
        initial = previous_response_id is None
        if initial:
            self._reset()
        try:
            if type(completion_only) is not bool or (self._completion_only and not completion_only):
                raise ProviderError("invalid_continuation")
            contract = json.dumps([instructions, context, tools], allow_nan=False, sort_keys=True)
            # Always lock the complete base contract. Only this explicit,
            # monotonic phase may narrow the actual wire allowlist.
            wire_tools = tools
            if completion_only:
                if not isinstance(tools, (list, tuple)) or any(not isinstance(tool, dict) for tool in tools):
                    raise ProviderError("invalid_continuation")
                wire_tools = [tool for tool in tools if tool.get("name") in ("finish", "conclude")]
                if {tool["name"] for tool in wire_tools} != {"finish", "conclude"} or len(wire_tools) != 2:
                    raise ProviderError("invalid_continuation")
            if initial:
                if tool_outputs:
                    raise ProviderError("invalid_continuation")
                inputs = [dict(role="user", content=json.dumps(context, allow_nan=False))]
            else:
                if (not isinstance(previous_response_id, str) or not IDENTIFIER.fullmatch(previous_response_id)
                        or previous_response_id != self._previous or not (self._pending or self._message_pending) or contract != self._contract
                        or not isinstance(tool_outputs, (list, tuple))):
                    raise ProviderError("invalid_continuation")
                outputs = {}
                for item in tool_outputs:
                    if (not isinstance(item, dict) or set(item) != {"call_id", "output"}
                            or not isinstance(item["call_id"], str) or item["call_id"] in outputs):
                        raise ProviderError("invalid_continuation")
                    outputs[item["call_id"]] = item["output"]
                if set(outputs) != set(self._pending):
                    raise ProviderError("invalid_continuation")
                inputs = ([dict(role="user", content=FINISH_REMINDER)] if self._message_pending else
                          [dict(type="function_call_output", call_id=cid,
                                output=json.dumps(outputs[cid], allow_nan=False)) for cid in self._pending])
                if self.history_mode == "stateless":
                    inputs = self._history + inputs
            payload = dict(model=MODEL, instructions=instructions, input=inputs, tools=wire_tools,
                           max_output_tokens=self.max_output_tokens, parallel_tool_calls=False,
                           store=self.history_mode == "stored")
            if self.history_mode == "stateless":
                payload["include"] = ["reasoning.encrypted_content"]
            elif not initial:
                payload["previous_response_id"] = previous_response_id
            if self.reasoning_effort is not None:
                payload["reasoning"] = dict(effort=self.reasoning_effort)
            encoded = json.dumps(payload, allow_nan=False).encode("utf-8")
            if len(encoded) > MAX_REQUEST_BYTES or self._request_bytes + len(encoded) > MAX_CUMULATIVE_REQUEST_BYTES:
                raise ProviderError("request_too_large")
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
            raise ProviderError("invalid_continuation") from None
        # Count actual attempts, including failed requests; never retry automatically.
        self._request_bytes += len(encoded)
        try:
            # A new client owns no inherited session headers, cookies, proxies or retries.
            # HTTPX limits inactivity per operation. The elapsed guard is checked
            # after headers and chunks; it cannot interrupt a blocked operation.
            deadline = time.monotonic() + self.request_timeout_s
            with httpx.Client(transport=self._transport if self._transport is not None else httpx.HTTPTransport(retries=0, trust_env=False),
                              timeout=httpx.Timeout(self.request_timeout_s, connect=10.0),
                              follow_redirects=False, trust_env=False) as client:
                with client.stream("POST", ENDPOINT, headers={"Authorization": f"Bearer {self._key}", "Accept-Encoding": "identity",
                                                            "Content-Type": "application/json"}, content=encoded) as response:
                    if time.monotonic() > deadline:
                        raise ProviderError("timeout")
                    if response.status_code != 200:
                        status = response.status_code
                        category = ("authentication" if status in (401, 403) else "quota" if status == 429 else
                                    "redirect_rejected" if 300 <= status < 400 else "server" if status >= 500 else "request_rejected")
                        raise ProviderError(category, status)
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise ProviderError("invalid_response", 200, response_code="invalid_encoding")
                    body = bytearray()
                    for chunk in response.iter_bytes(chunk_size=8192):
                        if time.monotonic() > deadline:
                            raise ProviderError("timeout")
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise ProviderError("response_too_large", 200)
        except ProviderError:
            raise
        except httpx.TimeoutException:
            raise ProviderError("timeout") from None
        except Exception:
            # Transport implementations must never expose raw exception messages.
            raise ProviderError("transport") from None
        def invalid(code):
            raise ProviderError("invalid_response", 200, response_code=code)

        try:
            decoded = body.decode("utf-8")
        except UnicodeError:
            invalid("invalid_encoding")
        try:
            value = finite_json(decoded)
            # A provider must not be able to reflect its Authorization header into
            # tool arguments, IDs, metadata or persisted scientific artifacts.
            if contains_credential(value, self._key):
                raise ProviderError("invalid_response", 200, response_code="invalid_envelope")
        except (ValueError, TypeError, RecursionError, OverflowError):
            invalid("invalid_json")
        try:
            if not isinstance(value, dict):
                invalid("invalid_envelope")
            if (not isinstance(value.get("id"), str) or not IDENTIFIER.fullmatch(value["id"])
                    or value["id"] in self._response_ids):
                invalid("invalid_response_id")
            status = value.get("status")
            if status != "completed":
                if status == "incomplete":
                    details = value.get("incomplete_details")
                    code = ("incomplete_max_output_tokens" if isinstance(details, dict)
                            and details.get("reason") == "max_output_tokens" else "incomplete_other")
                elif status == "failed":
                    code = "failed_response"
                elif status == "cancelled":
                    code = "cancelled_response"
                elif status in ("in_progress", "queued"):
                    code = "nonterminal_response"
                else:
                    code = "unknown_status"
                invalid(code)
            if value.get("model") != MODEL:
                invalid("model_mismatch")
            output = value.get("output")
            if not isinstance(output, list) or len(output) > 16:
                invalid("invalid_output_shape")
            calls, replay, messages = [], [], 0
            for index, item in enumerate(output):
                if not isinstance(item, dict):
                    invalid("invalid_output_shape")
                kind = item.get("type")
                if kind != "function_call":
                    before_call = any(isinstance(later, dict) and later.get("type") == "function_call"
                                      for later in output[index + 1:])
                    clean = self._replay_item(item, before_call=before_call, stateless=self.history_mode == "stateless")
                    if kind == "message":
                        messages += 1
                    if self.history_mode == "stateless":
                        replay.append(clean)
                    continue
                call_id, name, arguments = item.get("call_id"), item.get("name"), item.get("arguments")
                if "status" in item and item["status"] != "completed":
                    invalid("invalid_output_shape")
                if (not isinstance(call_id, str) or not CALL_IDENTIFIER.fullmatch(call_id)
                        or call_id in self._call_ids or any(c.call_id == call_id for c in calls)):
                    invalid("invalid_call_id")
                if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
                    invalid("invalid_call_name")
                if not isinstance(arguments, str) or len(arguments) > 8192:
                    invalid("malformed_arguments")
                try:
                    parsed_arguments = finite_json(arguments)
                except (ValueError, TypeError, RecursionError, OverflowError):
                    invalid("malformed_arguments")
                if contains_credential(parsed_arguments, self._key):
                    invalid("invalid_envelope")
                if not isinstance(parsed_arguments, dict):
                    invalid("malformed_arguments")
                calls.append(ToolCall(call_id, name, parsed_arguments))
                if self.history_mode == "stateless":
                    replay.append(dict(type="function_call", call_id=call_id, name=name, arguments=arguments))
            if len(calls) > 9:
                invalid("invalid_output_shape")
            if not calls and not messages:
                invalid("no_output")
            usage = {}
            raw_usage = value.get("usage", {})
            if isinstance(raw_usage, dict):
                for key in ("input_tokens", "output_tokens", "total_tokens"):
                    v = raw_usage.get(key)
                    if type(v) is int and 0 <= v <= 10**9:
                        usage[key] = v
            history = inputs + replay if self.history_mode == "stateless" else []
            if len(json.dumps(history, allow_nan=False).encode("utf-8")) > MAX_HISTORY_BYTES:
                raise ProviderError("history_too_large", 200)
            # Commit all protocol state only after the entire response validates.
            self._history = history
            self._previous = value["id"]
            self._pending = tuple(call.call_id for call in calls)
            self._message_pending = not calls
            self._contract = contract
            self._completion_only = completion_only
            self._response_ids.add(value["id"])
            self._call_ids.update(self._pending)
            return ProviderResponse(value["id"], tuple(calls), usage, message_only=not calls)
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
            invalid("invalid_output_shape")

    @staticmethod
    def _replay_item(item, *, before_call, stateless):
        """Validate all output; retain only allowlisted ephemeral protocol fields."""
        def invalid(code):
            raise ProviderError("invalid_response", 200, response_code=code)
        if item.get("type") == "reasoning":
            # Stored responses need not include encrypted content; summaries are discarded.
            if not stateless:
                return None
            encrypted = item.get("encrypted_content")
            if (not isinstance(encrypted, str) or not encrypted.strip() or len(encrypted) > MAX_RESPONSE_BYTES
                    or any(ord(c) < 32 for c in encrypted)):
                invalid("missing_encrypted_reasoning")
            return dict(type="reasoning", summary=[], encrypted_content=encrypted)
        if item.get("type") == "refusal":
            invalid("refusal")
        if item.get("type") == "message":
            content = item.get("content")
            if (item.get("role") != "assistant" or not isinstance(content, list) or not 1 <= len(content) <= 16
                    or ("status" in item and item["status"] != "completed")):
                invalid("invalid_message_shape")
            if any(isinstance(part, dict) and part.get("type") == "refusal" for part in content):
                invalid("refusal")
            phase = item.get("phase")
            if (before_call and phase != "commentary") or (not before_call and phase not in (None, "commentary")):
                invalid("unsupported_message_phase")
            clean = []
            for part in content:
                if (not isinstance(part, dict) or part.get("type") != "output_text"
                        or not isinstance(part.get("text"), str) or not part["text"].strip()):
                    invalid("invalid_message_shape")
                try:
                    part["text"].encode("utf-8")
                except UnicodeError:
                    invalid("invalid_encoding")
                clean.append(dict(type="output_text", text=part["text"]))
            result = dict(type="message", role="assistant", content=clean)
            if phase is not None:
                result["phase"] = phase
            return result
        invalid("unsupported_output_item")
