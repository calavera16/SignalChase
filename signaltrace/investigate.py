"""Opt-in bundled-demo investigations and offline numerical replay."""
import argparse
import json
import os
import re
import stat
from pathlib import Path, PureWindowsPath
from .investigation import investigate, investigation_context, replay_investigation, MAX_BUNDLE_BYTES
from .availability import require_available, AvailabilityError
from .meta_provider import MetaProvider, ProviderError, finite_json, HISTORY_MODES, DEFAULT_REQUEST_TIMEOUT_S, request_timeout
from .recordings import demo_recording

DEMOS = ("synthetic_control", "synthetic_drift_noise", "synthetic_missing_flatline", "bidmc_01")


def timeout_argument(value):
    try:
        return request_timeout(float(value))
    except (ValueError, OverflowError, ProviderError):
        raise argparse.ArgumentTypeError("Use a finite timeout from 10 to 180 seconds") from None


def checked_path(value):
    raw = os.fspath(value)
    if not isinstance(raw, str):
        raise ValueError("Use an ordinary JSON path")
    windows = raw.replace("/", "\\")
    # Windows interprets these namespaces and colons before ordinary file lookup.
    # Only an absolute drive prefix may contain a colon; streams are never files.
    without_drive = windows[2:] if re.match(r"^[A-Za-z]:\\", windows) else windows
    if (windows.startswith(("\\\\?\\", "\\\\.\\", "\\??\\", "\\\\??\\")) or
            ":" in without_drive or any(ord(char) < 32 for char in raw)):
        raise ValueError("Use an ordinary JSON path")
    names = PureWindowsPath(raw)
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    reserved.update(f"{prefix}{digit}" for prefix in ("COM", "LPT") for digit in "123456789¹²³")
    # Check names before any filesystem operation, including ancestor stat calls.
    components = names.parts[1:] if names.anchor else names.parts
    if (names.suffix.lower() != ".json" or any(part.lower().startswith(".env") or
            any(token in part.lower() for token in ("secret", "credential", "private_key", "id_rsa")) for part in names.parts) or
            any(part.split(".", 1)[0].rstrip(" ").upper() in reserved or
                (part not in (".", "..") and part.endswith((" ", "."))) for part in components)):
        raise ValueError("Use a non-secret JSON path")
    path = Path(raw)
    absolute = path.absolute()
    # Walk root first, using non-following metadata, so an ancestor reparse point
    # is rejected before looking up anything through it. Reject every reparse tag.
    for component in (*reversed(absolute.parents), absolute):
        try:
            metadata = component.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(metadata.st_mode) or
                getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise ValueError("Filesystem links are not supported")
    return absolute


def save_new_json(value, destination):
    path = checked_path(destination)
    encoded = json.dumps(value, indent=2, allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_BUNDLE_BYTES:
        raise ValueError("Export exceeds the size limit")
    # No mkdir or replacement: user selects an existing, ordinary parent directory.
    with path.open("xb") as stream:
        stream.write(encoded)


def load_bundle(source):
    path = checked_path(source)
    if not path.is_file() or path.stat().st_size > MAX_BUNDLE_BYTES:
        raise ValueError("Replay input exceeds the size limit or is not a file")
    with path.open("rb") as stream:
        encoded = stream.read(MAX_BUNDLE_BYTES + 1)
    if len(encoded) > MAX_BUNDLE_BYTES:
        raise ValueError("Replay input exceeds the size limit")
    return finite_json(encoded.decode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="Print configuration guidance without reading a key or making a request")
    live = commands.add_parser("live", help="Actual Meta run: sends question, notes and bounded numeric summaries to Meta")
    live.add_argument("--demo", choices=DEMOS, required=True)
    live.add_argument("--target", choices=("pulse_timing", "waveform_sensitivity"), required=True)
    live.add_argument("--question", required=True)
    live.add_argument("--notes", default="")
    live.add_argument("--start", type=float, required=True)
    live.add_argument("--end", type=float, required=True)
    live.add_argument("--allow-network", action="store_true")
    live.add_argument("--history-mode", choices=HISTORY_MODES, default="stored",
                      help="stored (default): server history; stateless: explicit encrypted history replay")
    live.add_argument("--request-timeout-seconds", type=timeout_argument, default=DEFAULT_REQUEST_TIMEOUT_S,
                      help="Network-operation inactivity timeout and elapsed guard, 10..180 seconds (default 90); no automatic retry")
    live.add_argument("--output", required=True)
    replay = commands.add_parser("replay", help="Offline numerical replay; does not contact a model")
    replay.add_argument("bundle")
    replay.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    if args.command == "check":
        print("No network request made. Set SIGNALTRACE_META_API_KEY privately in the process environment.")
        print("Live use requires the live command and --allow-network. No .env files are loaded.")
        return 0
    try:
        output = checked_path(args.output)
        if output.exists() or not output.parent.is_dir():
            raise ValueError("Output must be a new JSON file in an existing directory")
        if args.command == "replay":
            result = replay_investigation(load_bundle(args.bundle))
            save_new_json(result, output)
            print("Offline numerical replay saved; historical model proposal was not revalidated.")
            return 0
        recording = demo_recording(args.demo)
        channel = next(iter(recording.channels))
        investigation_context(recording, channel=channel, question=args.question, notes=args.notes,
                              target=args.target, start_s=args.start, end_s=args.end)
        require_available(recording, channel, args.start, args.end)
        # Local scope/support checks precede construction; valid runs still require consent/key.
        provider = MetaProvider(allow_network=args.allow_network, history_mode=args.history_mode,
                                request_timeout_s=args.request_timeout_seconds)
        print(f"Starting Live Meta investigation: history mode {args.history_mode}; "
              f"network-operation timeout {args.request_timeout_seconds:g}s; at most 6 rounds and 8 tool attempts.")
        result = investigate(recording, channel=channel, question=args.question, notes=args.notes,
                             target=args.target, start_s=args.start, end_s=args.end, provider=provider)
        save_new_json(result, output)
        if result["error"]:
            status = result["error"]["http_status"]
            stage = "initial" if result["rounds"] == 1 else "continuation"
            print(f"Live Meta investigation failed: {result['error']['category']} "
                  f"(HTTP {status if status is not None else 'unavailable'}; round {result['rounds']}; "
                  f"{stage}; history mode {args.history_mode}). "
                  f"Partial local evidence saved: {len(result['evidence'])} observation(s).")
            if "response_code" in result["error"]:
                print(f"Provider response validation: {result['error']['response_code']}. "
                      "No conclusion was accepted. Use this fixed code to diagnose the response; "
                      "no automatic retry or token-limit change occurred.")
            if result["error"]["category"] in ("round_budget_exhausted", "tool_budget_exhausted"):
                last_event = result["trace"][-1] if result["trace"] else {}
                rejected = last_event.get("validation_code")
                if rejected:
                    print(f"Local finish validation rejected the proposal: {rejected}. "
                          "The budget ended without an accepted conclusion; this is not a provider HTTP failure.")
                elif last_event.get("tool") == "model_message":
                    print("A normal text reply was received, but the required finish tool was not produced "
                          "within the round budget. No conclusion was accepted.")
            if status is not None and status >= 500:
                print("Meta returned a server error; its cause is unknown. No automatic retry or mode switch occurred. "
                      + ("See README for the explicit stateless mode and its observed limits; "
                         "use a new output filename for any deliberate later run."
                         if args.history_mode == "stored" else
                         "Stop repeated identical runs; use the captured stage and HTTP status for support or diagnosis."))
            return 2
        print(f"Live Meta investigation saved: {result['conclusion']['status']}. Narrative is an unverified model proposal.")
        return 0
    except AvailabilityError as error:
        parser.exit(2, f"Investigation unavailable: {error}\n")
    except ProviderError as error:
        parser.exit(2, f"Investigation failed: {error.category}\n")
    except (ValueError, OSError, TypeError, KeyError, UnicodeError, RecursionError, OverflowError):
        parser.exit(2, "Investigation failed: invalid input, unavailable demo, or unsafe/unavailable JSON path.\n")


if __name__ == "__main__":
    raise SystemExit(main())
