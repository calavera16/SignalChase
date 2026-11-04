# Security

SignalTrace is a loopback-only research application for one trusted local user. It has no multi-user authentication or tenant isolation. Do not expose the server to a network, reverse proxy, shared computer session or public hosting service.

## Credentials

The first-use panel sends a user-entered Meta API key to the same local origin. The local server keeps it in process memory. The frontend clears the password field and does not store the key in cookies, local storage or session storage. Credential API responses return configuration status only. Provider requests use the key only for authentication to the fixed Meta endpoint; redirects are not followed.

`GET /api/credentials/meta` returns status. `PUT` accepts only an `api_key` field. `PUT` and `DELETE` require `x-signaltrace-request: 1`, strict request validation and the application's local-origin guards. Validation/provider failures use fixed public error categories rather than echoing request bodies or credentials. Browser disconnection disables environment fallback until restart; a restart clears browser-entered credentials. An already running request can retain its credential snapshot until it finishes. Disconnecting does not revoke a key at Meta.

No credential file is read. A deliberately configured process environment variable can supply a local developer key. Keep credentials out of exports, input files, notes, screen recordings, shell history and bug reports. Memory-only handling reduces persistence; it cannot protect against a compromised browser, OS, debugger, malicious extension or privileged local process. Revoke an exposed key through its provider.

## Consent and local data

Connecting a key triggers no model request. Investigation and explanation operations each require explicit consent. The model path sends research context and bounded summaries; free-text context can itself be sensitive. Do not enter identifying or unauthorized information. Local raw CSVs remain local during these operations. The browser receives waveform data for local plots.

The local result store and user exports can contain recording samples, notes, numerical results and model output. They are private artifacts, not anonymized release material. Result retention is bounded but is not encryption. Model output is untrusted: local schemas, allowed tools, finite-number validation and evidence binding constrain its use; the application does not execute model-generated code.

## Release checks

The public builder copies exact named source files into a fresh separate directory. Raw datasets, saved numeric data, historical reports, media, local stores, dependency trees, Git metadata, credential files and unrelated documentation are excluded. The audit checks the exact expected file set, regular-file status, links/reparse points, UTF-8 text, manifest checksums, common credential patterns, email-like strings and private home-path markers. Additional private names can be supplied through `--private-marker` without publishing them.

Forbidden and unexpected filenames are rejected before content is opened. Audit findings contain only category, relative path and line number. In test source only, individual credential-assignment and bearer matches may use an obvious `FAKE_TEST_` placeholder containing letters, digits, underscores and hyphens. This is not a file-wide exemption: other credential matches on the same line, recognizable provider-token formats and private-key headers still fail. Do not extend the source allowlist without reviewing the new file. This is defense in depth, not a mathematical guarantee or a substitute for reviewing release contents and dependencies.

## Reporting an issue

Do not include keys, recordings, exports or identifying data in a public issue. Share a minimal synthetic reproduction and redacted error category. No dedicated private disclosure channel is configured in this repository; the maintainer should configure one before inviting sensitive reports. Do not publish a credential while trying to demonstrate a vulnerability.
