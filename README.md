# SignalTrace

A local research workspace for investigating how PPG preprocessing choices affect measured signal features.

SignalTrace combines deterministic numerical analysis with optional, explicitly consented Meta investigations. Researchers inspect a recording, compare preprocessing settings, review measurements and explore an animated findings view alongside a detailed report. The model chooses bounded investigation steps and explains validated evidence; numerical tools compute measurements.

## Run locally

Use Python 3.11 or later. From the repository root:

```sh
python -m venv .venv
# Activate the environment using your shell's activation command.
python -m pip install -r requirements.txt
python -m uvicorn signaltrace.server:app --host 127.0.0.1 --port 8767 --no-access-log
```

Open `http://127.0.0.1:8767`. Start with a synthetic demonstration; no dataset, API key or network request is required for local analysis. CSV imports stay in the local application. This server is designed for a single trusted local user. Keep it bound to loopback.

For a reproducible offline experiment that generates synthetic results locally:

```sh
python -m signaltrace --synthetic-only --output outputs/synthetic-check
```

Generated reports and samples are private working files and are excluded from publication.

## Optional Meta API access

Enter your own Meta API key in the first-use setup panel. The password field is cleared immediately on submission; the server retains the key only in process memory. Saving it does not test connectivity or make a model request. It is not saved in browser storage or a credential file, and status responses expose only whether a credential is configured. Clear key removes the browser credential and disables environment fallback until server restart. An environment-provided `SIGNALTRACE_META_API_KEY` is also supported for local development; no credential file is loaded by the application.

Connecting a key does not start an investigation. Each investigation and each separate explanation requires its own explicit consent. The application sends the reviewed research context and bounded numerical summaries to the Meta Responses API; it does not send raw waveform arrays through that investigation path. Review free-text context before consent because you can inadvertently type identifying information into it. Meta's current API terms and processing practices govern requests you authorize.

Use a key with access to `muse-spark-1.3` through `https://api.meta.ai/v1/responses`. Account access, API availability, permissions and charges are controlled by Meta. Never paste a key into a recording, research note, issue, screenshot or exported report. See [Security](SECURITY.md) for the local trust boundary and credential lifecycle.

## What is implemented

- CSV recording inspection, preserved timestamps, missing samples and gaps.
- A PPG preprocessing module with controlled parameter comparisons, detected-candidate timing and count measurements, explicit support exclusions and optional measurement limits.
- Bounded Meta investigation tools, evidence-linked conclusions and a separately consented explanation path.
- Animated findings, detailed reports, local result persistence and deterministic numerical replay.
- Synthetic controls and mocked provider tests that work without a key or downloaded recordings.

Generic inspection of other waveform modalities does not imply ECG, EEG or other modality-specific analysis. Candidate peaks are algorithmic detections. A setting difference does not establish physiological accuracy, a universally preferred filter or downstream benefit. This is research software, not a clinical device or diagnostic service. The public tree carries no historical live results and makes no model-superiority claim.

## Data and provenance

This repository contains source code and small authored test fixtures. It contains no real PPG recordings, stored numeric datasets, historical investigation exports, screenshots, demo videos or private local results. Synthetic waveforms are generated at runtime.

Optional BIDMC dataset use requires a separate manual download and compliance with its attribution and other applicable terms. There is no automatic download. See [Data policy](docs/DATA_POLICY.md) for official source links and the distinction between dataset licensing and individual privacy/content rights. Film and other media outside this repository require their own provenance review.

## Development and checks

Python tests use synthetic inputs and mock transports. The optional downloaded-dataset test skips when the source is absent.

```sh
python -m pytest -q
npm ci
npm test
```

Node.js must satisfy the locked development dependencies' engine requirements: `^22.22.2 || ^24.15.0 || >=26.0.0`. Node and npm are used for frontend tests; the application serves its frontend assets locally without a frontend build.

See [Architecture](docs/ARCHITECTURE.md), [Contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Publication gate

`scripts/build_public_repo.py` reads an exact source allowlist into a fresh separate directory. It rejects linked files, scans selected text for credential and private-path patterns, and writes a deterministic filename/size/SHA-256 manifest. It never copies an entire working directory. It refuses to overwrite an existing target.

The exported repository can reproduce its own clean layout:

```sh
python scripts/build_public_repo.py --public-layout --output ../SignalTrace-clean-copy
python scripts/audit_public_repo.py ../SignalTrace-clean-copy
```

Use `--private-marker` for account/name markers known only to the preparer; markers are never written to the manifest. The auditor rejects unexpected paths and does not open forbidden files, including environment files. Heuristic scanning and tests cannot prove that no secret exists; review changes and run the gate again before any public release. No Git initialization, remote configuration, push or submission is performed by these commands.

## License

SignalTrace source is provided under the [MIT License](LICENSE). Third-party components retain their own notices and terms. This software license does not license external recordings or media.
