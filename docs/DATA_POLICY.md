# Data and publication policy

## Public repository boundary

The public tree contains application source, documentation, dependency manifests and small authored test fixtures. It includes a synthetic waveform generator; generated waveform files are not shipped. No recordings, saved numeric datasets, historical JSON/HTML reports, model transcripts, screenshots, waveform clips, videos, logs or private result stores are included.

User-imported CSV files, generated results and local exports remain outside the public source selection. Git-ignore rules are a convenience; the exact allowlist builder and audit provide the publication gate. Do not add personal data, credentials, participant identifiers or copied local paths to source code, fixtures or documentation.

## Optional BIDMC data

The [BIDMC PPG and Respiration Dataset v1.0.0](https://physionet.org/content/bidmc/1.0.0/) is distributed by PhysioNet under [Open Data Commons Attribution License v1.0](https://physionet.org/content/bidmc/view-license/1.0.0/). Section 3 grants database use and reproduction rights subject to Section 4 attribution conditions. The license does not waive independent rights in individual contents or privacy, personality and other applicable rights. Dataset licensing alone is not a legal assurance for every intended disclosure.

The publication decision for this project is to omit all BIDMC recordings and derivative saved exports, regardless of possible redistribution permissions. Download optional data yourself from the official dataset page only after reviewing its current terms. Preserve attribution and the dataset citation if you use it in research, reports or media. Source code does not automatically download any dataset.

The optional local demo recognizes the original `bidmc_01_Signals.csv` in `data/raw/` and validates its pinned checksum. Only use the official original file; do not publish that local directory. A missing download leaves synthetic demonstrations and CSV import available. File hashes in code validate optional inputs and are not embedded recordings.

## Local storage and Meta requests

Importing data and running numerical analysis does not authorize an external model request. An explicit investigation sends the reviewed question/context and bounded numerical summaries to Meta. The separate explanation action requires separate consent. Do not type identifying information into context. Review the provider's terms for the account and authorized use.

Local persistence and exported replay bundles may contain samples, notes and derived measurements. They are private working artifacts even if the input came from a public dataset. Inspect and manage them locally; never assume they are anonymous or safe to publish.

## Media and scientific claims

Demo films, screenshots and waveform clips live outside this clean repository. They need a separate review for dataset attribution, personal information, displayed credentials and rights to narration, music and visuals. This source-only audit does not certify those media.

Section 4.3 of the dataset license requires an associated notice for public use
of a produced work. Suggested credit for BIDMC-derived waveform media:
**Waveform data: [BIDMC PPG and Respiration Dataset v1.0.0](https://physionet.org/content/bidmc/1.0.0/),
distributed under [Open Data Commons Attribution License v1.0](https://physionet.org/content/bidmc/view-license/1.0.0/).**
Also retain the dataset page's requested research citation. This credit does not
replace a review of independent content or privacy rights.

SignalTrace measures preprocessing sensitivity. Real-recording algorithmic detections are not physiological ground truth. No clinical validity, preferred-filter accuracy, universal adaptive advantage or general model reliability is established by the public synthetic examples.
