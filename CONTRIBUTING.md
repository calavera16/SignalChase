# Contributing

Keep changes reproducible with synthetic inputs and mocked provider transport. Never commit API keys, credential files, recordings, generated numeric datasets, local exports, screenshots or identifying research notes. Use small authored fixtures only. Do not add an automatic dataset download or an external service call to local analysis.

Install the Python dependencies from `requirements.txt`, then run `python -m pytest -q`. Install frontend development dependencies with `npm ci` and run `npm test`. No live API key is needed for tests. Bind any development server to `127.0.0.1`.

Preserve the division of responsibility: numerical tools compute measurements, models select bounded tools and explain evidence, and users explicitly consent to each external investigation or separate explanation. Validate imported input, schemas and budgets. Use fixed error categories instead of echoing credentials, provider bodies or private file paths. Avoid clinical claims and distinguish algorithmic detections from ground truth.

Keep the public folder self-contained. When adding runtime files or tests, update the exact source allowlist in `scripts/build_public_repo.py` after reviewing their contents. Rebuild into a fresh separate folder and run `scripts/audit_public_repo.py` before release. Supply any known private account/name markers privately with `--private-marker`; do not hard-code personal markers into public tests or source. Review third-party attribution when adapting code or design.

For bug reports, use a minimal synthetic reproduction and a redacted error category. Follow [Security](SECURITY.md) when the issue involves credentials or private data. No push, deployment or submission is performed by the publication scripts.
