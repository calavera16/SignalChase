import {
  validatedPlot,
  staticEvidenceChart,
  evidenceTable,
  renderWaveformExcerpt,
} from "./evidence.js";
import {
  requirementSnapshot,
  renderRequirementDecision,
} from "./requirements.js";
// Local, detached report assembly. No provider or transport belongs here.
const FAILURE =
  "Report evidence is missing or belongs to a different source or experiment.";
const METHODS = {
  unchanged: "Unchanged",
  median: "Median subtraction",
  highpass: "High-pass",
};
const METRICS = {
  comparator_count: "Comparator candidates",
  candidate_count: "Method candidates",
  matched_count: "Matched candidates",
  unmatched_comparator_count: "Unmatched comparator candidates",
  unmatched_candidate_count: "Unmatched method candidates",
  mean_absolute_shift_ms: "Mean absolute timing shift (ms)",
  maximum_absolute_shift_ms: "Maximum absolute timing shift (ms)",
  centered_normalized_rmse: "Normalized waveform difference",
};
const REGIONAL_METRICS = {
  reference_candidate_count: "Original candidates",
  candidate_count: "Method candidates",
  matched_pair_count: "Matched pairs (assigned by original time)",
  unmatched_reference_count: "Unmatched original candidates",
  unmatched_candidate_count: "Unmatched method candidates",
  cross_boundary_pair_count: "Cross-boundary matched pairs",
  mean_absolute_shift_ms: "Mean absolute timing shift (ms)",
  maximum_absolute_shift_ms: "Maximum absolute timing shift (ms)",
  full_window_centered_normalized_rmse:
    "Waveform RMSE (parent full-window means and original standard deviation)",
};
const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const string = (value) => (typeof value === "string" ? value : "");
const numbers = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, numeric(value?.[key])]));
const windowOf = (value) => numbers(value, ["start_s", "end_s"]);
const params = (value) =>
  numbers(value, ["median_window_s", "highpass_hz", "edge_guard_s"]);
const texts = (value) =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === "string").slice(0, 32)
    : [];
const freeze = (value) => {
  if (Object.isFrozen(value)) return value;
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function base(recording, experiment, kind) {
  if (
    !recording?.id ||
    !experiment?.id ||
    experiment.recording_id !== recording.id ||
    !experiment.protocol
  )
    throw new Error(FAILURE);
  return {
    schema: "signaltrace.readable-report.v1",
    kind,
    source_id: string(recording.id),
    source_name: string(recording.name),
    modality: string(recording.modality),
    experiment_id: string(experiment.id),
    experiment_name: string(experiment.protocol.name),
    task: string(experiment.protocol.task),
    target: string(experiment.protocol.target),
    question: string(experiment.protocol.research_question),
    notes: string(experiment.protocol.notes),
    comparisons: [],
    inspections: [],
    regional_summaries: [],
    limitations: [
      "Research inspection only; no diagnosis or clinical interpretation.",
      "Candidate peaks are algorithmic maxima, not annotated heartbeats. Timing agreement does not establish physiological accuracy.",
      "Differences against the original measure sensitivity. No automatic best-filter ranking, true SNR or downstream classification benefit is established.",
      "Offline filters use future samples. Boundary guards are heuristic; missing, flat and short segments are excluded rather than repaired.",
      "This readable summary is assembled locally without another model call. Download matching replay data for full reproducible numerical inputs.",
    ],
  };
}
function comparison(id, item, manual = false) {
  const ex = manual ? item.exclusions : item;
  return {
    id: string(id),
    window: windowOf(item.window),
    parameters: params(item.parameters),
    comparator: manual ? string(item.comparison) : string(item.evaluation),
    counts: {
      ...numbers(ex, [
        "sample_count",
        "valid_count",
        "excluded_fraction",
        "nonfinite_count",
      ]),
      exact_flat_sample_count: numeric(
        manual ? ex?.flatline_count : ex?.exact_flat_sample_count,
      ),
      gap_count: manual
        ? Array.isArray(ex?.gap_after_indices)
          ? ex.gap_after_indices.length
          : null
        : numeric(ex?.gap_count),
      valid_interval_count: manual
        ? Array.isArray(ex?.valid_intervals_indices)
          ? ex.valid_intervals_indices.length
          : null
        : numeric(ex?.valid_interval_count),
      too_short_segment_count: manual
        ? Array.isArray(ex?.too_short_segments)
          ? ex.too_short_segments.length
          : null
        : null,
    },
    methods: Object.entries(METHODS).map(([method, label]) => {
      const m = item.metrics?.[method];
      return {
        method,
        label,
        metrics: {
          ...numbers(m, Object.keys(METRICS)),
          comparator_count: numeric(
            manual ? m?.reference_count : m?.comparator_count,
          ),
          unmatched_comparator_count: numeric(
            manual
              ? m?.unmatched_reference_count
              : m?.unmatched_comparator_count,
          ),
        },
      };
    }),
  };
}
// Explicit detached allowlist: no samples, peaks, arbitrary policies or private fields.
export function regionalSummarySnapshot(id, item) {
  return freeze({
    id: string(id),
    kind: "regional_summary",
    comparison_id: string(item.comparison_id),
    window: windowOf(item.window),
    split_s: numeric(item.split_s),
    parameters: params(item.parameters),
    assignment: string(item.assignment),
    filtering_context: string(item.filtering_context),
    normalization: string(item.normalization),
    regions: (Array.isArray(item.regions) ? item.regions : [])
      .slice(0, 2)
      .map((r) => ({
        window: windowOf(r.window),
        ...numbers(r, ["sample_count", "valid_count"]),
        methods: Object.entries(METHODS).map(([method, label]) => ({
          method,
          label,
          metrics: numbers(r.metrics?.[method], Object.keys(REGIONAL_METRICS)),
        })),
      })),
    limitations: texts(item.limitations),
  });
}
export function makeInvestigationReport({ recording, experiment, job }) {
  const s = base(recording, experiment, "investigation"),
    request = job?.request,
    bundle = job?.result;
  if (
    !["completed", "failed"].includes(job?.status) ||
    !bundle ||
    request?.recording_id !== recording.id ||
    request?.experiment_id !== experiment.id ||
    request?.target !== experiment.protocol.target
  )
    throw new Error(FAILURE);
  s.evidence_id = string(job.id);
  s.evidence_digest = string(job.evidence_digest);
  s.status =
    job.status === "failed"
      ? "failed"
      : string(bundle.conclusion?.status) || "inconclusive";
  s.question = string(request.question);
  s.notes = string(request.notes);
  s.channel = string(request.channel);
  s.unit = string(recording.channels?.find((c) => c.name === s.channel)?.unit);
  s.window = windowOf({ start_s: request.start_s, end_s: request.end_s });
  s.comparator = "original_sensitivity";
  Object.assign(
    s,
    requirementSnapshot(
      bundle.context?.requirements ?? request.requirements,
      bundle.requirement_assessment,
    ),
  );
  s.model = Object.fromEntries(
    ["provider", "model", "execution_mode", "history_mode"].map((key) => [
      key,
      string(bundle.identity?.[key]),
    ]),
  );
  s.rounds = numeric(bundle.rounds);
  s.tool_attempts = numeric(bundle.tool_attempts);
  const conclusion = job.status === "completed" ? bundle.conclusion : null;
  s.proposal = string(conclusion?.narrative);
  s.questions = texts(conclusion?.questions);
  s.citations = texts(conclusion?.evidence_ids);
  const candidate = conclusion?.candidate;
  s.candidate = candidate
    ? {
        comparison_id: string(candidate.comparison_id),
        method: string(candidate.method),
        window: windowOf(candidate.window),
        parameters: params(candidate.parameters),
      }
    : null;
  // Copy only the bounded, known summary fields; never copy a bundle/request wholesale.
  for (const [id, item] of Object.entries(bundle.evidence || {}).slice(0, 8)) {
    if (item?.kind === "comparison") s.comparisons.push(comparison(id, item));
    if (item?.kind === "regional_summary")
      s.regional_summaries.push(regionalSummarySnapshot(id, item));
    if (item?.kind === "inspection")
      s.inspections.push({
        id: string(id),
        window: windowOf(item.window),
        counts: numbers(item, [
          "sample_count",
          "finite_count",
          "missing_count",
          "gap_count",
          "missing_interval_count",
        ]),
        statistics: numbers(item.statistics, [
          "minimum",
          "maximum",
          "mean",
          "standard_deviation",
        ]),
      });
  }
  // Retain only public ordering fields, never model messages or arbitrary trace data.
  s.comparison_trace = (Array.isArray(bundle.trace) ? bundle.trace : [])
    .filter(
      (event) =>
        event?.tool === "compare" &&
        event.status === "success" &&
        Number.isInteger(event.round) &&
        event.round > 0 &&
        s.comparisons.some((c) => c.id === event.evidence_id),
    )
    .map((event) => ({
      round: event.round,
      evidence_id: string(event.evidence_id),
    }));
  s.evidence_trace = (Array.isArray(bundle.trace) ? bundle.trace : [])
    .filter(
      (event) =>
        event?.status === "success" &&
        Number.isInteger(event.round) &&
        event.round > 0 &&
        ((event.tool === "compare" &&
          s.comparisons.some((c) => c.id === event.evidence_id)) ||
          (event.tool === "regional_summary" &&
            s.regional_summaries.some((r) => r.id === event.evidence_id))),
    )
    .map((event) => ({
      round: event.round,
      tool: event.tool,
      evidence_id: string(event.evidence_id),
    }));
  const category = bundle.error?.category || job.error?.category;
  const safe = [
    "network_not_authorized",
    "missing_or_invalid_credential",
    "authentication",
    "quota",
    "server",
    "redirect_rejected",
    "request_rejected",
    "response_too_large",
    "timeout",
    "transport",
    "invalid_response",
    "provider_failure",
    "invalid_call_id",
    "mixed_finish_calls",
    "tool_budget_exhausted",
    "round_budget_exhausted",
    "invalid_history_mode",
    "invalid_continuation",
    "request_too_large",
    "history_too_large",
    "invalid_request_timeout",
  ];
  s.error_code = category
    ? safe.includes(category)
      ? category
      : "provider_failure"
    : null;
  return freeze(s);
}
export function makeManualReport({ recording, experiment, result }) {
  const s = base(recording, experiment, "manual");
  if (
    !result?.id ||
    result.recording_id !== recording.id ||
    result.experiment_id !== experiment.id ||
    result.goal !== experiment.protocol.target
  )
    throw new Error(FAILURE);
  const expected =
    experiment.protocol.evaluation === "synthetic_reference"
      ? "synthetic_reference"
      : "original";
  if (result.comparison !== expected) throw new Error(FAILURE);
  s.evidence_id = string(result.id);
  s.status = "completed";
  s.channel = string(result.channel);
  s.unit = string(recording.channels?.find((c) => c.name === s.channel)?.unit);
  s.window = windowOf(result.window);
  s.comparator = string(result.comparison);
  s.model = null;
  s.questions = [];
  s.citations = [];
  s.proposal = "";
  s.comparisons.push(comparison(result.id, result, true));
  return freeze(s);
}
export function attachComparisonPlot(snapshot, payload) {
  const plot = validatedPlot(snapshot, payload);
  const selected = snapshot.comparisons.find(
    (c) => c.id === payload.comparison_id,
  )?.plot?.selected_method;
  if (METHODS[selected]) plot.selected_method = selected;
  return freeze({
    ...snapshot,
    comparisons: snapshot.comparisons.map((c) =>
      c.id === payload.comparison_id ? { ...c, plot } : c,
    ),
  });
}
// Optional retrospective interpretation is detached from the scientific report.
// Rendering never overwrites the investigation's original proposal or metrics.
export function attachExplanationReport(snapshot, plan) {
  const reject = () => {
    throw new Error("Explanation belongs to different report evidence");
  };
  if (
    snapshot.kind !== "investigation" ||
    !snapshot.evidence_digest ||
    plan?.schema !== "signaltrace.explanation.v1" ||
    plan.investigation_id !== snapshot.evidence_id ||
    plan.evidence_digest !== snapshot.evidence_digest ||
    !Array.isArray(plan.scenes) ||
    plan.scenes.length < (snapshot.comparisons.length ? 3 : 2) ||
    plan.scenes.length > 5
  )
    reject();
  const all = reportEvidence(snapshot),
    seen = new Set();
  const equivalent = (a, b) =>
    a === b ||
    (!!a &&
      !!b &&
      typeof a === "object" &&
      typeof b === "object" &&
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (k) => Object.hasOwn(b, k) && equivalent(a[k], b[k]),
      ));
  const scenes = plan.scenes.map((scene) => {
    if (
      typeof scene.id !== "string" ||
      !scene.id ||
      seen.has(scene.id) ||
      ![
        "scope",
        "settings_contrast",
        "candidate_focus",
        "metrics",
        "uncertainty",
      ].includes(scene.kind) ||
      typeof scene.caption !== "string" ||
      !scene.caption.trim() ||
      scene.caption.length > 90 ||
      typeof scene.interpretation !== "string" ||
      !scene.interpretation.trim() ||
      scene.interpretation.length > 240 ||
      !Array.isArray(scene.evidence_ids) ||
      new Set(scene.evidence_ids).size !== scene.evidence_ids.length ||
      !scene.evidence_ids.every((id) => all.some((e) => e.id === id))
    )
      reject();
    seen.add(scene.id);
    const b = scene.binding,
      c = snapshot.comparisons.find((v) => v.id === scene.comparison_id);
    if (
      !b ||
      b.target !== snapshot.target ||
      (snapshot.unit && b.unit !== snapshot.unit)
    )
      reject();
    if (scene.comparison_id !== null) {
      const m = c?.methods.find((v) => v.method === scene.method);
      if (
        !m ||
        !scene.evidence_ids.includes(c.id) ||
        b.comparison_id !== c.id ||
        b.method !== scene.method ||
        !equivalent(b.window, c.window) ||
        !equivalent(b.parameters, c.parameters) ||
        !equivalent(b.metrics, m.metrics)
      )
        reject();
    } else if (
      !["scope", "uncertainty"].includes(scene.kind) ||
      scene.method !== null ||
      scene.baseline_comparison_id !== null ||
      !equivalent(b.window, snapshot.window)
    )
      reject();
    if (
      scene.kind === "settings_contrast" ||
      scene.baseline_comparison_id !== null
    ) {
      const before = snapshot.comparisons.find(
          (v) => v.id === scene.baseline_comparison_id,
        ),
        m = before?.methods.find((v) => v.method === scene.method),
        changed = Object.keys(c?.parameters || {}).filter(
          (k) => c.parameters[k] !== before?.parameters[k],
        );
      if (
        !before ||
        !c ||
        before.id === c.id ||
        !scene.evidence_ids.includes(before.id) ||
        changed.length !== 1 ||
        b.changed_parameter !== changed[0] ||
        !equivalent(before.window, c.window) ||
        before.comparator !== c.comparator ||
        !equivalent(b.baseline_parameters, before.parameters) ||
        !equivalent(b.baseline_metrics, m?.metrics)
      )
        reject();
    }
    return {
      id: scene.id,
      kind: scene.kind,
      caption: scene.caption,
      interpretation: scene.interpretation,
      evidence_ids: [...scene.evidence_ids],
    };
  });
  return freeze({
    ...snapshot,
    explanation: {
      schema: plan.schema,
      investigation_id: plan.investigation_id,
      evidence_digest: plan.evidence_digest,
      identity: Object.fromEntries(
        ["provider", "model", "execution_mode"].map((k) => [
          k,
          string(plan.identity?.[k]).slice(0, 160),
        ]),
      ),
      historical_import:
        plan.provenance?.historical_import === true ||
        plan.provenance?.kind === "imported_historical_explanation",
      scenes,
    },
  });
}
function renderExplanation(parent, s, { evidenceHref, onEvidence } = {}) {
  if (!s.explanation) return;
  const wrap = section(parent, "Retrospective Meta explanation");
  wrap.className = "retrospective-explanation";
  element(
    wrap,
    "p",
    `This later explanation is unverified model interpretation, separate from the investigation's recorded rationale. Numeric measurements remain in the original evidence below.${s.explanation.historical_import ? " Imported historical explanation." : ""}`,
  );
  fields(wrap, {
    Provider: s.explanation.identity.provider,
    Model: s.explanation.identity.model,
    "Execution mode": s.explanation.identity.execution_mode,
    "Evidence digest": s.explanation.evidence_digest,
  });
  for (const scene of s.explanation.scenes) {
    element(wrap, "h3", scene.caption);
    element(wrap, "p", `Unverified interpretation: ${scene.interpretation}`);
    const references = element(wrap, "p", "Evidence: ");
    if (!scene.evidence_ids.length)
      element(references, "span", "requested scope / limitations");
    for (const id of scene.evidence_ids) {
      const link = element(references, "a", ` ${id} `);
      link.setAttribute(
        "href",
        evidenceHref?.(id) ||
          `#report-evidence-${reportEvidence(s).findIndex((e) => e.id === id)}`,
      );
      if (onEvidence)
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onEvidence(id);
        });
    }
  }
}
export function selectReportMethod(snapshot, comparisonId, method) {
  if (!METHODS[method]) return snapshot;
  return freeze({
    ...snapshot,
    comparisons: snapshot.comparisons.map((c) =>
      c.id === comparisonId && c.plot
        ? { ...c, plot: { ...c.plot, selected_method: method } }
        : c,
    ),
  });
}
const show = (value) =>
  value === null || value === undefined || value === ""
    ? "not available"
    : String(value);
function measurement(value, key) {
  if (value === null || value === undefined) return "not available";
  if (!key.includes("shift") && !key.endsWith("centered_normalized_rmse"))
    return show(value);
  if (value === 0) return "0";
  const digits = key.endsWith("centered_normalized_rmse") ? 3 : 1,
    resolution = 10 ** -digits;
  if (Math.abs(value) < resolution)
    return `${value < 0 ? ">-" : "<"}${resolution}`;
  if (Math.abs(value) >= 1e6) return value.toExponential(3);
  return String(Number(value.toFixed(digits)));
}
const interval = (window) =>
  `[${show(window?.start_s)}, ${show(window?.end_s)}) s`;
function element(parent, tag, content) {
  const e = parent.ownerDocument.createElement(tag);
  if (content !== undefined) e.textContent = content;
  parent.append(e);
  return e;
}
function fields(parent, values) {
  const dl = element(parent, "dl");
  for (const [key, value] of Object.entries(values)) {
    element(dl, "dt", key);
    element(dl, "dd", show(value));
  }
}
function section(parent, title) {
  const s = element(parent, "section");
  element(s, "h2", title);
  return s;
}
const reportEvidence = (s) => [
  ...s.inspections,
  ...s.comparisons,
  ...(s.regional_summaries || []),
];
const regionalScope = (r) =>
  `Regional summary of parent comparison ${r.comparison_id}, full interval ${interval(r.window)}, split at ${show(r.split_s)} s. Parent recipe: median ${show(r.parameters.median_window_s)} s; high-pass ${show(r.parameters.highpass_hz)} Hz; edge guard ${show(r.parameters.edge_guard_s)} s.`;
const regionalPolicy =
  "Filtering, candidate detection and one-to-one matching were performed on the parent full window before the split; these regions do not re-filter, re-detect or rematch. Matched pairs are assigned by original/comparator candidate time; unmatched candidates by their own time. A pair crossing the split is counted explicitly, so matched-pair counts can differ from method candidate counts in a region.";
const regionalNormalization =
  "Waveform RMSE uses the parent full-window means and original standard deviation on the parent valid mask, with squared residuals averaged within each region. It is globally normalized, not separately recentered or normalized within a region. No matches means timing is not available, never a measured zero.";
const regionalLimits =
  "Regional differences are descriptive sensitivity measurements. Numerical differences alone do not establish consequential usefulness, a cause, physiological accuracy or a best filter.";
const regionalMeasurement = (metrics, key) =>
  measurement(
    key.includes("shift") && !(metrics.matched_pair_count > 0)
      ? null
      : metrics[key],
    key,
  );
export function renderRegionalSummary(
  container,
  summary,
  { parentHref, onParent } = {},
) {
  element(container, "p", regionalScope(summary));
  if (parentHref) {
    const link = element(
      container,
      "a",
      `View parent comparison ${summary.comparison_id} (full-window plot)`,
    );
    link.setAttribute("href", parentHref);
    if (onParent)
      link.addEventListener("click", (event) => {
        event.preventDefault();
        onParent(summary.comparison_id);
      });
  }
  element(container, "p", regionalPolicy);
  element(container, "p", regionalNormalization);
  for (const [index, r] of summary.regions.entries()) {
    element(container, "h4", `Region ${index + 1}: ${interval(r.window)}`);
    element(
      container,
      "p",
      `${show(r.valid_count)} of ${show(r.sample_count)} original samples contribute on the parent valid mask.`,
    );
    const wrap = element(container, "div");
    wrap.className = "evidence-table-scroll";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute(
      "aria-label",
      `Region ${index + 1} exact method measurements`,
    );
    const table = element(wrap, "table");
    table.className = "evidence-table";
    element(
      table,
      "caption",
      `Region ${index + 1} measurements from unchanged parent processing`,
    );
    const head = element(element(table, "thead"), "tr");
    element(head, "th", "Measurement").scope = "col";
    for (const m of r.methods) element(head, "th", m.label).scope = "col";
    const body = element(table, "tbody");
    for (const [key, label] of Object.entries(REGIONAL_METRICS)) {
      const row = element(body, "tr");
      element(row, "th", label).scope = "row";
      for (const m of r.methods)
        element(row, "td", regionalMeasurement(m.metrics, key));
    }
  }
  element(container, "p", regionalLimits);
  for (const limit of summary.limitations) element(container, "p", limit);
  return container;
}
const targetLabel = (value) =>
  ({
    pulse_timing: "Pulse timing",
    waveform_sensitivity: "Waveform shape sensitivity",
  })[value] || "Not available";
const comparatorLabel = (value) =>
  value === "synthetic_reference"
    ? "Evaluator-only synthetic reference"
    : "Original waveform (sensitivity comparison)";
const outcomeLabel = (value) =>
  ({
    candidate: "Proposal ready for researcher review",
    needs_information: "More information needed",
    inconclusive: "No supported proposal",
    failed: "Run failed — partial evidence only",
    completed: "Manual measurements ready for review",
  })[value] || "No supported conclusion";
function percent(value) {
  return value === null
    ? "not available"
    : `${measurement(value * 100, "shift")}%`;
}
const nonnegative = (v) => numeric(v) !== null && v >= 0;
const validCount = (v) => Number.isInteger(v) && v >= 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Presentation classification only: absorb computation roundoff, never alter evidence.
// Absolute floors: 1e-9 ms for timing, 1e-12 for normalized shape; relative: 1e-12.
// These are not scientific, physiological or clinical significance thresholds.
function beyondRoundoff(a, b, key) {
  const absolute = key === "centered_normalized_rmse" ? 1e-12 : 1e-9;
  return (
    Math.abs(a - b) >
    Math.max(absolute, 1e-12 * Math.max(Math.abs(a), Math.abs(b)))
  );
}
function equivalentMetrics(a, b) {
  return a.methods.every(
    (item, i) =>
      item.method === b.methods[i]?.method &&
      Object.keys(METRICS).every((key) =>
        key.endsWith("count")
          ? item.metrics[key] === b.methods[i].metrics[key]
          : !beyondRoundoff(item.metrics[key], b.methods[i].metrics[key], key),
      ),
  );
}
function storyScope(c) {
  return `Interval ${interval(c.window)}; median window ${show(c.parameters.median_window_s)} s, high-pass ${show(c.parameters.highpass_hz)} Hz, edge guard ${show(c.parameters.edge_guard_s)} s.`;
}
function storySupport(c) {
  const count = (v) => (validCount(v) ? String(v) : "not available");
  const excluded = c.counts.excluded_fraction;
  return `${count(c.counts.valid_count)} of ${count(c.counts.sample_count)} samples usable; ${nonnegative(excluded) && excluded <= 1 ? percent(excluded) : "not available"} excluded.`;
}
function storyMetric(c, method, target) {
  const m = c.methods.find((item) => item.method === method)?.metrics || {};
  const timing = validCount(m.matched_count) && m.matched_count > 0;
  const value = (v, key) =>
    nonnegative(v) ? measurement(v, key) : "not available";
  const count = (v) => (validCount(v) ? String(v) : "not available");
  const measured =
    target === "waveform_sensitivity"
      ? `normalized waveform difference ${value(m.centered_normalized_rmse, "centered_normalized_rmse")}`
      : `mean / maximum absolute timing shift ${timing ? value(m.mean_absolute_shift_ms, "shift") : "not available"} / ${timing ? value(m.maximum_absolute_shift_ms, "shift") : "not available"} ms`;
  return `${METHODS[method]}: ${measured}; ${count(m.matched_count)} matched, ${count(m.unmatched_comparator_count)} unmatched original / ${count(m.unmatched_candidate_count)} unmatched method candidates.`;
}
function measuredValues(c, target) {
  return ["median", "highpass"].flatMap((method) => {
    const m = c.methods.find((item) => item.method === method)?.metrics || {};
    const keys =
      target === "waveform_sensitivity"
        ? ["centered_normalized_rmse"]
        : ["mean_absolute_shift_ms", "maximum_absolute_shift_ms"];
    return keys.map((key) =>
      target !== "waveform_sensitivity" &&
      (!validCount(m.matched_count) || m.matched_count === 0)
        ? null
        : nonnegative(m[key])
          ? m[key]
          : null,
    );
  });
}
function measurementChanges(initial, followup, target) {
  const before = measuredValues(initial, target),
    after = measuredValues(followup, target);
  const keys =
    target === "waveform_sensitivity"
      ? ["normalized waveform difference"]
      : ["mean absolute timing shift", "maximum absolute timing shift"];
  return ["median", "highpass"].flatMap((method, m) =>
    keys.flatMap((key, k) => {
      const i = m * keys.length + k;
      const formatKey =
        target === "waveform_sensitivity"
          ? "centered_normalized_rmse"
          : "shift";
      if (
        before[i] === null ||
        after[i] === null ||
        !beyondRoundoff(before[i], after[i], formatKey)
      )
        return [];
      const beforeText = measurement(before[i], formatKey),
        afterText = measurement(after[i], formatKey),
        unit = target === "pulse_timing" ? " ms" : "";
      if (beforeText === afterText)
        return [
          `${METHODS[method]} ${key}: exact values differ below displayed precision (both display ${beforeText}${unit}). Review exact evidence; this difference alone does not establish a meaningful change.`,
        ];
      return [
        `${METHODS[method]} ${key}: ${beforeText} → ${afterText}${unit}.`,
      ];
    }),
  );
}
function completeEvidence(c) {
  return (
    Object.values(c.window).every(nonnegative) &&
    c.window.end_s > c.window.start_s &&
    Object.values(c.parameters).every(nonnegative) &&
    [
      c.counts.sample_count,
      c.counts.valid_count,
      c.counts.nonfinite_count,
      c.counts.exact_flat_sample_count,
      c.counts.gap_count,
      c.counts.valid_interval_count,
    ].every(validCount) &&
    nonnegative(c.counts.excluded_fraction) &&
    c.counts.excluded_fraction <= 1 &&
    c.methods.every(
      (m) =>
        Object.values(m.metrics).every(nonnegative) &&
        [
          m.metrics.matched_count,
          m.metrics.comparator_count,
          m.metrics.candidate_count,
          m.metrics.unmatched_comparator_count,
          m.metrics.unmatched_candidate_count,
        ].every(validCount) &&
        m.metrics.matched_count > 0,
    )
  );
}
// Deterministic reading aid shared by the workspace and the script-free report.
// No model intent, scientific significance or within-window localization is inferred.
export function investigationStory(snapshot) {
  const comparisons = snapshot.comparisons;
  const regional = snapshot.regional_summaries || [];
  const ordered = [];
  for (const event of [...(snapshot.comparison_trace || [])].sort(
    (a, b) => a.round - b.round,
  )) {
    const c = comparisons.find((item) => item.id === event.evidence_id);
    if (c && !ordered.includes(c)) ordered.push(c);
  }
  const traced = ordered.length;
  for (const c of comparisons) if (!ordered.includes(c)) ordered.push(c);
  const chronologyKnown = traced === comparisons.length && traced > 0;
  const ordering = chronologyKnown
    ? "Order: successful comparison trace, by round; calls in the same round retain trace order."
    : traced
      ? "Order incomplete: traced successful comparisons come first by round, then untraced comparisons in retained evidence order. The true initial test and follow-up order cannot be verified."
      : "Trace unavailable: retained evidence order is the fallback. The true initial test and follow-up order cannot be verified.";
  const initial = ordered[0];
  const followups = ordered.slice(1);
  const stages = [
    {
      title: "Research question",
      paragraphs: [snapshot.question || "No research question was retained."],
      checks: [],
    },
    {
      title: "Initial evidence",
      paragraphs: [ordering],
      checks: initial
        ? [
            {
              id: initial.id,
              paragraphs: [
                storyScope(initial),
                storySupport(initial),
                ...["median", "highpass"].map((m) =>
                  storyMetric(initial, m, snapshot.target),
                ),
              ],
            },
          ]
        : [],
    },
    { title: "Follow-up check", paragraphs: [], checks: [] },
    { title: "New evidence", paragraphs: [], checks: [] },
    { title: "Conclusion and limits", paragraphs: [], checks: [] },
  ];
  const initialStage = stages[1],
    followStage = stages[2],
    newStage = stages[3],
    end = stages[4];
  if (!initial) {
    initialStage.paragraphs.push("No successful comparison was retained.");
    followStage.paragraphs.push(
      "No successful follow-up comparison is available.",
    );
    newStage.paragraphs.push("No new comparison evidence is available.");
    end.paragraphs.push(
      "Inconclusive: no measured preprocessing sensitivity can be established.",
    );
  } else {
    initialStage.paragraphs.push(
      "A window-level aggregate leaves the distribution of changes within that window open. It does not establish what happens in other intervals or with other settings.",
    );
    if (!followups.length && !regional.length) {
      followStage.paragraphs.push(
        "No successful follow-up comparison was retained. Inspections or attempted calls alone do not add a second preprocessing comparison.",
      );
      newStage.paragraphs.push(
        "No added comparison evidence: the initial open question remains unresolved.",
      );
      end.paragraphs.push(
        "Added value is unproven for this run: only one successful comparison is available.",
      );
    } else if (followups.length) {
      followStage.paragraphs.push(
        "These are the actual retained tests. Meta's reason for selecting each test was not recorded.",
      );
      let changedMeasurements = 0,
        subprecisionChanges = 0,
        newlyAvailable = 0,
        equivalentChecks = 0;
      for (const c of followups) {
        const sameScope =
          same(c.window, initial.window) &&
          same(c.parameters, initial.parameters);
        followStage.checks.push({
          id: c.id,
          paragraphs: [
            storyScope(c),
            sameScope
              ? "Repeated window and settings; this does not test another interval or recipe."
              : `${same(c.window, initial.window) ? "Window unchanged" : "Window changed"}; ${same(c.parameters, initial.parameters) ? "settings unchanged" : "settings changed"} relative to ${initial.id}.`,
          ],
        });
        const before = measuredValues(initial, snapshot.target),
          after = measuredValues(c, snapshot.target);
        const formatKey =
          snapshot.target === "waveform_sensitivity"
            ? "centered_normalized_rmse"
            : "shift";
        const delta = after.some(
          (v, i) =>
            v !== null &&
            before[i] !== null &&
            beyondRoundoff(v, before[i], formatKey),
        );
        const displayedDelta = after.some(
          (v, i) =>
            v !== null &&
            before[i] !== null &&
            beyondRoundoff(v, before[i], formatKey) &&
            measurement(v, formatKey) !== measurement(before[i], formatKey),
        );
        const added = after.some((v, i) => v !== null && before[i] === null);
        const equivalent =
          completeEvidence(initial) &&
          completeEvidence(c) &&
          same(initial.counts, c.counts) &&
          equivalentMetrics(initial, c);
        const exact = equivalent && same(initial.methods, c.methods);
        changedMeasurements += Number(displayedDelta);
        subprecisionChanges += Number(delta && !displayedDelta);
        newlyAvailable += Number(added);
        equivalentChecks += Number(equivalent);
        const assessment = exact
          ? sameScope
            ? "No material measured difference in the retained numerical summaries: exact metrics and support counts are identical for the same interval and settings."
            : "No material measured difference in the retained numerical summaries: exact metrics and support counts are identical, but intervals or settings differ. Equal counts do not establish identical candidate/sample support."
          : equivalent
            ? `No change beyond the numerical roundoff tolerance is established: metrics are equivalent within that tolerance and support counts are identical. ${sameScope ? "The interval and settings are unchanged." : "Intervals or settings differ; equal counts do not establish identical candidate/sample support."}`
            : delta
              ? displayedDelta
                ? "At least one available target measurement differs from the first retained comparison."
                : "Exact target measurements differ below displayed precision; the displayed summaries do not establish meaningful added information."
              : added
                ? "At least one target measurement is newly available; its initial value was unavailable."
                : "No new target difference is established from the available measurements; missing values are not zero effects.";
        const positive =
          snapshot.target === "pulse_timing" &&
          after.some(
            (v, i) =>
              v !== null &&
              v > 0 &&
              before[i] === 0 &&
              beyondRoundoff(v, 0, formatKey),
          );
        newStage.checks.push({
          id: c.id,
          paragraphs: [
            assessment,
            ...measurementChanges(initial, c, snapshot.target),
            ...(positive
              ? [
                  "A nonzero timing summary is present where the initial summary was zero; this is scoped sensitivity evidence, not localization or accuracy.",
                ]
              : []),
            storySupport(c),
            ...["median", "highpass"].map((m) =>
              storyMetric(c, m, snapshot.target),
            ),
            ...(!sameScope
              ? [
                  "Changing the interval or settings changes the comparison scope and may change candidate/sample support. These summaries do not isolate a cause or establish scientific significance.",
                ]
              : []),
          ],
        });
      }
      end.paragraphs.push(
        changedMeasurements || newlyAvailable
          ? regional.length
            ? "The additional comparison tests add descriptive measurement information. Researcher review is needed to decide whether those tests resolve the question."
            : "The retained tests add descriptive measurement information. Researcher review is needed to decide whether it resolves the question."
          : subprecisionChanges
            ? regional.length
              ? "Exact target values in the additional comparison tests differ below displayed precision. A useful finding from those comparison tests is not established by these differences alone."
              : "Exact target values differ below displayed precision. A useful follow-up finding is not established by these differences alone."
            : equivalentChecks === followups.length
              ? regional.length
                ? "The additional comparison tests add no measured difference beyond the numerical roundoff tolerance in their retained summaries. Useful added information from those comparison tests beyond the initial comparison is not demonstrated."
                : "The follow-ups add no measured difference beyond the numerical roundoff tolerance in the retained summaries. Useful added information beyond the initial comparison is not demonstrated."
              : regional.length
                ? "Inconclusive added value from the additional comparison tests: those tests do not establish a new target difference from their available summaries."
                : "Inconclusive added value: the follow-ups do not establish a new target difference from the available summaries.",
      );
    }
    if (measuredValues(initial, snapshot.target).every((v) => v === null))
      end.paragraphs.push(
        "Initial target measurements are unavailable. Zero matched candidates or missing/invalid metrics cannot establish a zero effect.",
      );
  }
  if (regional.length) {
    const trace = snapshot.evidence_trace || [];
    const all = [...comparisons, ...regional];
    const known = all.every((c) =>
      trace.some((event) => event.evidence_id === c.id),
    );
    initialStage.paragraphs[0] = known
      ? "Order: successful comparison and regional-summary trace, by round; calls in the same round retain trace order."
      : "Order incomplete: regional and comparison chronology cannot be fully verified from retained trace. Untraced checks retain evidence order.";
    followStage.paragraphs.push(
      "Regional follow-ups inspect retained parent processing. They add no new filter setting or independently filtered subwindow. The model's reason for selecting each check was not recorded.",
    );
    for (const r of regional) {
      const event = trace.find((e) => e.evidence_id === r.id);
      followStage.checks.push({
        id: r.id,
        kind: "regional_summary",
        paragraphs: [
          `${event ? `Round ${event.round}. ` : "Round unavailable. "}${regionalScope(r)}`,
          regionalPolicy,
        ],
      });
      newStage.checks.push({
        id: r.id,
        kind: "regional_summary",
        paragraphs: [
          ...r.regions.flatMap((region, i) => [
            `Region ${i + 1} ${interval(region.window)}: ${show(region.valid_count)} / ${show(region.sample_count)} usable samples.`,
            ...region.methods.map(
              (m) =>
                `${m.label}: ${show(m.metrics.matched_pair_count)} matched pairs, ${show(m.metrics.reference_candidate_count)} original / ${show(m.metrics.candidate_count)} method candidates; ${show(m.metrics.unmatched_reference_count)} unmatched original / ${show(m.metrics.unmatched_candidate_count)} unmatched method; ${show(m.metrics.cross_boundary_pair_count)} cross-boundary pairs. Mean / maximum absolute timing shift ${regionalMeasurement(m.metrics, "mean_absolute_shift_ms")} / ${regionalMeasurement(m.metrics, "maximum_absolute_shift_ms")} ms. Globally normalized waveform RMSE ${regionalMeasurement(m.metrics, "full_window_centered_normalized_rmse")}.`,
            ),
          ]),
          regionalNormalization,
          regionalLimits,
        ],
      });
    }
    // Keep comparison contrasts and regional checks in the actual tool chronology.
    const order = [...trace]
      .sort((a, b) => a.round - b.round)
      .map((e) => e.evidence_id);
    const rank = (id) =>
      order.includes(id)
        ? order.indexOf(id)
        : order.length + all.findIndex((c) => c.id === id);
    for (const stage of [followStage, newStage])
      stage.checks.sort((a, b) => rank(a.id) - rank(b.id));
    end.paragraphs.push(
      "Regional summaries describe how retained measurements are distributed across adjacent regions with the parent processing fixed. Whether that information resolves the research question requires researcher review; regional summaries do not test another parameter setting.",
    );
  }
  if (!chronologyKnown && comparisons.length > 1)
    end.paragraphs.push(
      "Chronology is uncertain; comparisons above are relative to the first displayed retained test, not a verified initial model choice.",
    );
  if (snapshot.status === "failed")
    end.paragraphs.unshift(
      "Run failed: retained comparisons are partial evidence. No completed model conclusion is accepted.",
    );
  else if (["inconclusive", "needs_information"].includes(snapshot.status))
    end.paragraphs.unshift(
      snapshot.status === "needs_information"
        ? "Meta requested more information; no candidate was accepted."
        : "Meta ended inconclusively; no candidate was accepted.",
    );
  end.paragraphs.push(
    "Change and equivalence descriptions allow computation roundoff only: absolute tolerance 1e-9 ms for timing or 1e-12 for normalized waveform difference, or relative tolerance 1e-12, whichever is larger. Counts must match exactly. This is not a scientific or clinical significance threshold; exact evidence is retained.",
    regional.length
      ? "Timing uses matched algorithmic candidates, not verified heartbeats. Regional summaries partition parent measurements; they do not locate a physiological cause or prove generalization. Model proposals remain unverified."
      : "Timing uses matched algorithmic candidates, not verified heartbeats. Aggregate summaries alone do not locate changes within a window or prove generalization across this recording. Model proposals remain unverified.",
  );
  return freeze({ stages });
}
// A bounded headline from retained measurements, never a model interpretation.
export function investigationFinding(snapshot) {
  const comparisons = snapshot.comparisons || [];
  const ids = [];
  for (const event of [...(snapshot.comparison_trace || [])].sort(
    (a, b) => a.round - b.round,
  )) {
    if (
      comparisons.some((c) => c.id === event.evidence_id) &&
      !ids.includes(event.evidence_id)
    )
      ids.push(event.evidence_id);
  }
  const fallback = (reason) => ({
    title: "A controlled numerical contrast is not established",
    detail: reason,
    evidence: comparisons.map((c) => c.id),
    contrast: null,
  });
  if (ids.length !== comparisons.length || ids.length < 2)
    return fallback(
      "Two comparisons with complete successful trace order are required. Review the retained evidence; missing measurements are not zero effects.",
    );
  const initial = comparisons.find((c) => c.id === ids[0]);
  for (const id of ids.slice(1)) {
    const later = comparisons.find((c) => c.id === id);
    const changed = Object.keys(initial.parameters).filter(
      (key) => initial.parameters[key] !== later.parameters[key],
    );
    if (
      numeric(initial.window.start_s) === null ||
      numeric(initial.window.end_s) === null ||
      initial.window.end_s <= initial.window.start_s ||
      !same(initial.window, later.window) ||
      initial.comparator !== later.comparator ||
      changed.length !== 1 ||
      !Object.values(initial.parameters).every(nonnegative) ||
      !Object.values(later.parameters).every(nonnegative)
    )
      continue;
    const parameter = changed[0];
    const method =
      parameter === "median_window_s"
        ? "median"
        : parameter === "highpass_hz"
          ? "highpass"
          : null;
    if (!method) continue;
    const a = initial.methods.find((m) => m.method === method)?.metrics;
    const b = later.methods.find((m) => m.method === method)?.metrics;
    const key =
      snapshot.target === "waveform_sensitivity"
        ? "centered_normalized_rmse"
        : "mean_absolute_shift_ms";
    if (!a || !b || !nonnegative(a[key]) || !nonnegative(b[key])) continue;
    const supportKeys = [
      "comparator_count",
      "candidate_count",
      "matched_count",
      "unmatched_comparator_count",
      "unmatched_candidate_count",
    ];
    if (
      !same(initial.counts, later.counts) ||
      !Object.entries(initial.counts)
        .filter(([key]) => key !== "too_short_segment_count")
        .every(([, value]) => nonnegative(value)) ||
      ![
        "sample_count",
        "valid_count",
        "nonfinite_count",
        "exact_flat_sample_count",
        "gap_count",
        "valid_interval_count",
      ].every((key) => validCount(initial.counts[key])) ||
      initial.counts.valid_count <= 0 ||
      initial.counts.valid_count > initial.counts.sample_count ||
      initial.counts.excluded_fraction > 1 ||
      ![a, b].every(
        (metrics) =>
          supportKeys.every((k) => validCount(metrics[k])) &&
          metrics.comparator_count ===
            metrics.matched_count + metrics.unmatched_comparator_count &&
          metrics.candidate_count ===
            metrics.matched_count + metrics.unmatched_candidate_count,
      ) ||
      (key.includes("shift") && (a.matched_count <= 0 || b.matched_count <= 0))
    )
      continue;
    const digits = key.includes("shift") ? 2 : 3;
    const format = (v) =>
      v === 0
        ? "0"
        : v < 10 ** -digits
          ? `<${10 ** -digits}`
          : Math.abs(v) >= 1e6
            ? v.toExponential(3)
            : String(Number(v.toFixed(digits)));
    const before = format(a[key]),
      after = format(b[key]);
    const changedValue = beyondRoundoff(a[key], b[key], key);
    const visibleChange = changedValue && before !== after;
    const label =
      parameter === "median_window_s" ? "Median window" : "High-pass cutoff";
    const unit = parameter === "median_window_s" ? "s" : "Hz";
    const changedSupport = supportKeys.some((k) => a[k] !== b[k]);
    const countKey = [
      "unmatched_candidate_count",
      "unmatched_comparator_count",
      "candidate_count",
      "matched_count",
      "comparator_count",
    ].find((k) => a[k] !== b[k]);
    const countLabels = {
      candidate_count: "method candidates",
      unmatched_comparator_count: "unmatched original candidates",
      unmatched_candidate_count: "unmatched method candidates",
      matched_count: "matched candidates",
      comparator_count: "original candidates",
    };
    const supportDetail = changedSupport
      ? `Same interval; equal sample-summary counts: ${initial.counts.valid_count} valid samples. Original candidates ${a.comparator_count} to ${b.comparator_count}; method candidates ${a.candidate_count} to ${b.candidate_count}; matched candidates ${a.matched_count} to ${b.matched_count}; unmatched original candidates ${a.unmatched_comparator_count} to ${b.unmatched_comparator_count}; unmatched method candidates ${a.unmatched_candidate_count} to ${b.unmatched_candidate_count}. ${key.includes("shift") ? `Matched-candidate mean absolute timing shift ${before} to ${after} ms.${[a.maximum_absolute_shift_ms, b.maximum_absolute_shift_ms].every(nonnegative) ? ` Maximum absolute timing shift ${format(a.maximum_absolute_shift_ms)} to ${format(b.maximum_absolute_shift_ms)} ms.` : ""}` : `Normalized waveform difference ${before} to ${after}.`} Equal counts do not establish identical candidate/sample support; these summaries do not identify which candidates changed or whether matched pairs are identical.`
      : `Same interval; equal support counts: ${initial.counts.valid_count} valid samples, ${a.matched_count} matched candidates. Equal counts do not establish identical candidate/sample support.`;
    return {
      title: changedSupport
        ? "Candidate counts differ across the tested settings"
        : visibleChange
          ? "Measured sensitivity differs across the tested settings"
          : "These displayed measurements do not establish a new difference",
      detail: `${interval(initial.window)}; ${initial.comparator === "synthetic_reference" ? "synthetic-reference comparator" : "original-waveform comparator"}. Only ${label.toLowerCase()} changes: ${initial.parameters[parameter]} to ${later.parameters[parameter]} ${unit}. Other settings: ${Object.entries(
        initial.parameters,
      )
        .filter(([k]) => k !== parameter)
        .map(
          ([k, v]) =>
            `${k === "median_window_s" ? "median window" : k === "highpass_hz" ? "high-pass cutoff" : "edge guard"} ${v} ${k === "highpass_hz" ? "Hz" : "s"}`,
        )
        .join("; ")}. ${supportDetail}`,
      summary: `${METHODS[method]} ${initial.parameters[parameter]}\u2192${later.parameters[parameter]} ${unit}: ${a.unmatched_candidate_count !== b.unmatched_candidate_count ? `unmatched method candidates ${a.unmatched_candidate_count}\u2192${b.unmatched_candidate_count}` : a.unmatched_comparator_count !== b.unmatched_comparator_count ? `unmatched ${initial.comparator === "synthetic_reference" ? "synthetic-reference" : "original"} candidates ${a.unmatched_comparator_count}\u2192${b.unmatched_comparator_count}` : key.includes("shift") ? `mean matched timing shift ${overviewNumber(a[key], key)}\u2192${overviewNumber(b[key], key)} ms` : `normalized waveform difference ${before}\u2192${after}`}.`,
      supportSummary: `Matched candidates ${a.matched_count} to ${b.matched_count}; method candidates ${a.candidate_count} to ${b.candidate_count}; unmatched ${initial.comparator === "synthetic_reference" ? "synthetic-reference" : "original"} candidates ${a.unmatched_comparator_count} to ${b.unmatched_comparator_count}. ${key.includes("shift") ? `Mean absolute matched timing shift ${overviewNumber(a[key], key)} to ${overviewNumber(b[key], key)} ms; maximum ${overviewNumber(a.maximum_absolute_shift_ms, key)} to ${overviewNumber(b.maximum_absolute_shift_ms, key)} ms.` : `Normalized waveform difference ${before} to ${after}.`}`,
      settingSensitivity: changedSupport || changedValue,
      visual: { method, key, parameter, unit, before: a, after: b },
      evidence: [initial.id, later.id],
      contrast: {
        label: `${METHODS[method]} / ${changedSupport ? countLabels[countKey] : key.includes("shift") ? "mean absolute detected timing shift (ms)" : "normalized waveform difference"}`,
        before: changedSupport ? String(a[countKey]) : before,
        after: changedSupport ? String(b[countKey]) : after,
        beforeLabel: `${initial.id} / ${initial.parameters[parameter]} ${unit}`,
        afterLabel: `${later.id} / ${later.parameters[parameter]} ${unit}`,
      },
      note:
        !changedSupport && changedValue && !visibleChange
          ? "Exact values differ below displayed precision. Review exact evidence; meaningful change is unproven."
          : "Descriptive sensitivity only; this does not establish accuracy, a cause or a best filter.",
    };
  }
  return fallback(
    "The retained evidence does not establish a one-setting median or high-pass contrast on the same interval with equal sample-summary counts, consistent candidate counts and usable target measurements. Review the exact scopes separately.",
  );
}
const overviewNumber = (value, key) => {
  if (key.includes("shift") && value >= 0.01 && value < 1e6)
    return value.toFixed(2);
  return measurement(value, key);
};
// Semantic bars have exact text equivalents; each figure shares a zero baseline.
function findingFigure(
  parent,
  title,
  rows,
  { maximum, scaleLabel = maximum, unit = "", link },
) {
  const figure = element(parent, "figure");
  figure.className = "finding-figure";
  element(figure, "figcaption", title);
  element(figure, "p", `Shared scale: 0-${scaleLabel}${unit}.`).className =
    "finding-scale";
  for (const row of rows) {
    const block = element(figure, "div");
    block.className = "finding-chart-row";
    element(block, "p", row.label);
    const track = element(block, "div");
    track.className = "finding-track";
    track.setAttribute("aria-hidden", "true");
    for (const [index, value] of row.values.entries()) {
      const bar = element(track, "span");
      bar.className = index ? "finding-bar finding-unmatched" : "finding-bar";
      bar.dataset.value = String(value);
      bar.style.width = `${maximum > 0 ? (value / maximum) * 100 : 0}%`;
    }
    element(block, "p", row.text).className = "finding-chart-value";
  }
  link(figure);
  return figure;
}
function findingRegion(snapshot, finding) {
  const parent = snapshot.comparisons.find((c) => c.id === finding.evidence[1]);
  const method = finding.visual.method;
  return (snapshot.regional_summaries || []).find((r) => {
    if (
      r.comparison_id !== parent.id ||
      !same(r.window, parent.window) ||
      !same(r.parameters, parent.parameters) ||
      r.assignment !== "original_candidate_time" ||
      r.filtering_context !== "parent_full_window" ||
      r.normalization !== "parent_full_window_means_and_original_std" ||
      r.regions.length !== 2 ||
      !numeric(r.split_s) ||
      !(r.split_s > parent.window.start_s && r.split_s < parent.window.end_s) ||
      !same(r.regions[0].window, {
        start_s: parent.window.start_s,
        end_s: r.split_s,
      }) ||
      !same(r.regions[1].window, {
        start_s: r.split_s,
        end_s: parent.window.end_s,
      })
    )
      return false;
    const metrics = r.regions.map(
      (region) => region.methods.find((m) => m.method === method)?.metrics,
    );
    if (
      !r.regions.every(
        (region) =>
          validCount(region.sample_count) &&
          validCount(region.valid_count) &&
          region.valid_count <= region.sample_count,
      ) ||
      r.regions.reduce((n, region) => n + region.sample_count, 0) !==
        parent.counts.sample_count ||
      r.regions.reduce((n, region) => n + region.valid_count, 0) !==
        parent.counts.valid_count ||
      !metrics.every(
        (m) =>
          m &&
          [
            "reference_candidate_count",
            "candidate_count",
            "matched_pair_count",
            "unmatched_reference_count",
            "unmatched_candidate_count",
            "cross_boundary_pair_count",
          ].every((key) => validCount(m[key])) &&
          m.reference_candidate_count ===
            m.matched_pair_count + m.unmatched_reference_count &&
          m.cross_boundary_pair_count <= m.matched_pair_count &&
          m.unmatched_candidate_count <= m.candidate_count,
      )
    )
      return false;
    // Cross-boundary pairs are outbound from their original-time region.
    // The other region contributes inbound method candidates, not new matches.
    if (
      !metrics.every(
        (m, i) =>
          m.candidate_count - m.unmatched_candidate_count ===
          m.matched_pair_count -
            m.cross_boundary_pair_count +
            metrics[1 - i].cross_boundary_pair_count,
      )
    )
      return false;
    const counts = {
      reference_candidate_count: "comparator_count",
      candidate_count: "candidate_count",
      matched_pair_count: "matched_count",
      unmatched_reference_count: "unmatched_comparator_count",
      unmatched_candidate_count: "unmatched_candidate_count",
    };
    return Object.entries(counts).every(
      ([regional, total]) =>
        metrics.reduce((n, m) => n + m[regional], 0) ===
        finding.visual.after[total],
    );
  });
}
export function renderInvestigationFinding(
  container,
  snapshot,
  { evidenceHref, onEvidence, interactive = false } = {},
) {
  const doc = container.ownerDocument,
    active = doc.activeElement;
  const focused = container.contains(active)
    ? {
        tag: active.tagName,
        href: active.getAttribute("href"),
        text: active.textContent,
        control: active.dataset.findingControl,
      }
    : null;
  const inspectedSample = container.querySelector(
    '[data-finding-control="sample"]',
  )?.value;
  const openDetails = new Set(
    [...container.querySelectorAll("details[open]")].map(
      (d) => d.querySelector("summary")?.textContent,
    ),
  );
  container.replaceChildren();
  container.classList.add("investigation-finding");
  const finding = investigationFinding(snapshot);
  const links = (parent, ids = finding.evidence) => {
    const group = element(parent, "div");
    group.className = "finding-evidence";
    for (const id of ids) {
      const index = reportEvidence(snapshot).findIndex((c) => c.id === id);
      const link = element(group, "a", `${id} / exact evidence`);
      link.setAttribute(
        "href",
        evidenceHref ? evidenceHref(id) : `#report-evidence-${index}`,
      );
      if (onEvidence)
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onEvidence(id);
        });
    }
  };
  element(
    container,
    "p",
    `Outcome: ${snapshot.status === "inconclusive" && finding.settingSensitivity ? "Setting sensitivity detected; preferred filter unresolved" : outcomeLabel(snapshot.status)}`,
  ).className = "finding-outcome";
  element(container, "h3", "At a glance");
  element(container, "p", finding.summary || finding.title).className =
    "finding-summary";
  element(
    container,
    "p",
    `${snapshot.source_name || snapshot.source_id} / ${snapshot.channel} / ${interval(snapshot.window)}`,
  ).className = "finding-source";
  if (finding.supportSummary)
    element(container, "p", finding.supportSummary).className =
      "finding-source finding-support";
  if (finding.visual) {
    const visual = finding.visual;
    const sides = ["before", "after"];
    const charts = element(container, "div");
    charts.className = "finding-charts";
    const followup = snapshot.comparisons.find(
      (c) => c.id === finding.evidence[1],
    );
    const initial = snapshot.comparisons.find(
      (c) => c.id === finding.evidence[0],
    );
    const waveform = renderWaveformExcerpt(
      container,
      followup?.plot,
      followup,
      visual.method,
      { initialPlot: initial?.plot, initialComparison: initial, interactive },
    );
    if (waveform) {
      if (inspectedSample !== undefined)
        waveform.restoreSample?.(Number(inspectedSample));
      links(
        waveform,
        initial?.plot ? [initial.id, followup.id] : [followup.id],
      );
    }
    const maximum = Math.max(
      visual.before[visual.key],
      visual.after[visual.key],
    );
    findingFigure(
      charts,
      "Unmatched method candidates",
      sides.map((side) => ({
        label: finding.contrast[`${side}Label`],
        values: [visual[side].unmatched_candidate_count],
        text: `${visual[side].unmatched_candidate_count} unmatched method candidates`,
      })),
      {
        maximum: Math.max(
          ...sides.map((side) => visual[side].unmatched_candidate_count),
        ),
        unit: " candidates",
        link: links,
      },
    );
    findingFigure(
      charts,
      visual.key.includes("shift")
        ? "Mean absolute matched timing shift"
        : "Normalized waveform difference",
      sides.map((side) => ({
        label: finding.contrast[`${side}Label`],
        values: [visual[side][visual.key]],
        text: `${overviewNumber(visual[side][visual.key], visual.key)}${visual.key.includes("shift") ? " ms" : " (unitless)"}`,
      })),
      {
        maximum,
        scaleLabel: overviewNumber(maximum, visual.key),
        unit: visual.key.includes("shift") ? " ms" : " (unitless)",
        link: links,
      },
    );
    if (sides.some((side) => visual[side].unmatched_comparator_count > 0))
      element(
        charts,
        "p",
        `Unmatched original candidates: ${visual.before.unmatched_comparator_count} before / ${visual.after.unmatched_comparator_count} after. Original totals: ${visual.before.comparator_count} / ${visual.after.comparator_count}.`,
      ).className = "finding-source";
    const region = findingRegion(snapshot, finding);
    if (region) {
      const rows = region.regions.map((r) => {
        const value = r.methods.find((m) => m.method === visual.method).metrics
          .unmatched_candidate_count;
        return {
          label: interval(r.window),
          values: [0, value],
          text: `${value} unmatched method candidates`,
        };
      });
      findingFigure(
        container,
        `Unmatched method candidates by region / ${region.comparison_id}`,
        rows,
        {
          maximum: Math.max(...rows.map((r) => r.values[1])),
          unit: " candidates",
          link: (p) => links(p, [region.id, region.comparison_id]),
        },
      );
    } else
      element(
        container,
        "p",
        "Regional distribution unavailable for this contrast; no within-window localization is shown.",
      ).className = "finding-source";
  }
  element(
    container,
    "p",
    "Computed from retained local evidence. Candidates are algorithmic maxima, not verified heartbeats; sensitivity does not establish accuracy or a best filter.",
  ).className = "finding-source";
  const scope = element(container, "details");
  scope.className = "finding-scope";
  element(scope, "summary", "Comparison scope and support");
  element(scope, "p", finding.title);
  element(scope, "p", finding.detail);
  if (finding.contrast) {
    element(scope, "p", finding.contrast.label);
    const contrast = element(scope, "dl");
    contrast.className = "finding-contrast";
    for (const side of ["before", "after"]) {
      const group = element(contrast, "div");
      element(group, "dt", finding.contrast[`${side}Label`]);
      element(group, "dd", finding.contrast[side]);
    }
  }
  if (finding.note) element(scope, "p", finding.note);
  links(scope);
  for (const d of container.querySelectorAll("details"))
    if (openDetails.has(d.querySelector("summary")?.textContent)) d.open = true;
  if (focused) {
    const replacement = [
      ...container.querySelectorAll("a,summary,button,input,[tabindex]"),
    ].find(
      (el) =>
        el.tagName === focused.tag &&
        (focused.control
          ? el.dataset.findingControl === focused.control
          : focused.href
            ? el.getAttribute("href") === focused.href
            : el.textContent === focused.text),
    );
    replacement?.focus({ preventScroll: true });
  }
  return container;
}
export function renderInvestigationStory(
  container,
  snapshot,
  { evidenceHref, onEvidence } = {},
) {
  container.replaceChildren();
  container.classList.add("investigation-story");
  for (const [index, stage] of investigationStory(snapshot).stages.entries()) {
    const block = element(container, "section");
    element(block, "h3", `${index + 1}. ${stage.title}`);
    for (const p of stage.paragraphs) element(block, "p", p);
    for (const check of stage.checks) {
      const item = element(block, "div");
      item.className = "story-check";
      const index = reportEvidence(snapshot).findIndex(
        (c) => c.id === check.id,
      );
      const link = element(
        item,
        "a",
        `${check.kind === "regional_summary" ? "Regional summary" : "Comparison"} ${check.id} — exact evidence`,
      );
      link.setAttribute(
        "href",
        evidenceHref ? evidenceHref(check.id) : `#report-evidence-${index}`,
      );
      if (onEvidence)
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onEvidence(check.id);
        });
      for (const p of check.paragraphs) element(item, "p", p);
    }
  }
  return container;
}
// Concise, local reading surface. The complete standalone report below is unchanged.
export function renderReportPreview(container, s) {
  container.replaceChildren();
  const article = element(container, "article");
  article.className = "readable-report report-summary";
  const nav = element(article, "nav");
  nav.className = "report-section-nav";
  nav.setAttribute("aria-label", "Report sections");
  const prev = element(nav, "button", "Previous section"),
    label = element(nav, "label", "Report section"),
    select = element(label, "select"),
    next = element(nav, "button", "Next section");
  prev.type = next.type = "button";
  prev.className = next.className = "secondary";
  const pages = [];
  const page = (name) => {
    const p = element(article, "section");
    p.className = "report-preview-page";
    element(p, "h2", name);
    const option = element(select, "option", name);
    option.value = String(pages.length);
    pages.push(p);
    return p;
  };
  const chunks = (text, max = 650) => {
    const result = [];
    let remaining = String(text || "");
    while (remaining.length > max) {
      const space = remaining.lastIndexOf(" ", max),
        cut = space > max / 2 ? space + 1 : max;
      result.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) result.push(remaining);
    return result;
  };
  const overview = page("Question, scope and outcome");
  if (s.kind === "investigation") {
    const summary = element(overview, "div");
    summary.className = "preview-finding";
    const navigation = {
      interactive: true,
      evidenceHref: (id) =>
        `#preview-evidence-${reportEvidence(s).findIndex((c) => c.id === id)}`,
      onEvidence: (id) => {
        const target = article.querySelector(
          `#preview-evidence-${reportEvidence(s).findIndex((c) => c.id === id)}`,
        );
        const index = pages.indexOf(target);
        if (index >= 0) {
          current = index;
          showPage();
        }
      },
    };
    const decision = element(overview, "section");
    summary.before(decision);
    renderRequirementDecision(decision, s, navigation);
    const findingPlots = (snapshot) =>
      investigationFinding(snapshot)
        .evidence.slice(0, 2)
        .map((id) => snapshot.comparisons.find((c) => c.id === id)?.plot);
    let currentFindingPlots = findingPlots(s);
    renderInvestigationFinding(summary, s, navigation);
    article.updateFinding = (next) => {
      if (
        next.source_id !== s.source_id ||
        next.experiment_id !== s.experiment_id ||
        next.evidence_id !== s.evidence_id
      )
        return;
      const plots = findingPlots(next);
      if (
        plots.length === currentFindingPlots.length &&
        plots.every((plot, i) => plot === currentFindingPlots[i])
      )
        return;
      currentFindingPlots = plots;
      renderInvestigationFinding(summary, next, navigation);
    };
  }
  const overviewColumns = element(overview, "div");
  overviewColumns.className = "preview-overview";
  const question = element(overviewColumns, "div");
  element(question, "h3", "Question used");
  element(question, "p", s.question || "No question was recorded.");
  const scope = element(overviewColumns, "div");
  if (s.kind !== "investigation") element(scope, "p", outcomeLabel(s.status));
  fields(scope, {
    Recording: s.source_name,
    Target: targetLabel(s.target),
    Channel: s.channel,
    Interval: interval(s.window),
    Comparator: comparatorLabel(s.comparator),
  });
  element(
    overview,
    "p",
    s.kind === "manual"
      ? "Manual numerical comparison. Meta was not used."
      : `Meta (${s.model?.model || "identity unavailable"}) planned bounded tests. SignalTrace calculated measurements locally. The model proposal is unverified.`,
  ).className = "preview-note";
  for (const [index, text] of chunks(s.proposal).entries()) {
    const p = page(
      `Unverified Meta proposal${index ? ` · continued ${index + 1}` : ""}`,
    );
    element(p, "p", text);
    if (s.candidate && index === 0)
      element(
        p,
        "p",
        `Proposed method: ${METHODS[s.candidate.method] || "unavailable"}; comparison ${s.candidate.comparison_id}, ${interval(s.candidate.window)}. A proposal is not a proven best method.`,
      ).className = "preview-note";
  }
  if (s.kind === "investigation" && !s.proposal) {
    const p = page("Investigation outcome and next review");
    element(
      p,
      "p",
      s.status === "failed"
        ? "The investigation failed. Retained numerical evidence is partial; no completed model recommendation is available."
        : "No accepted model proposal is available. Review the retained evidence and questions before choosing another test.",
    );
  }
  if (s.explanation)
    renderExplanation(page("Retrospective Meta explanation"), s, {
      evidenceHref: (id) =>
        `#preview-evidence-${reportEvidence(s).findIndex((e) => e.id === id)}`,
      onEvidence: (id) => {
        const target = article.querySelector(
            `#preview-evidence-${reportEvidence(s).findIndex((e) => e.id === id)}`,
          ),
          index = pages.indexOf(target);
        if (index >= 0) {
          current = index;
          showPage();
        }
      },
    });
  for (const text of chunks(s.questions.join("\n\n")))
    element(page("Questions for researcher review"), "p", text);
  for (const c of s.comparisons) {
    const p = page(`Local comparison ${c.id}`);
    p.id = `preview-evidence-${reportEvidence(s).findIndex((item) => item.id === c.id)}`;
    element(
      p,
      "p",
      `${comparatorLabel(c.comparator)} · ${interval(c.window)} · ${show(c.counts.valid_count)} / ${show(c.counts.sample_count)} samples usable · ${percent(c.counts.excluded_fraction)} excluded.`,
    ).className = "preview-note";
    element(
      p,
      "p",
      `Median ${show(c.parameters.median_window_s)} s; high-pass ${show(c.parameters.highpass_hz)} Hz; boundary guard ${show(c.parameters.edge_guard_s)} s.`,
    ).className = "preview-note";
    const table = element(p, "table");
    table.className = "preview-metrics-table";
    const timing = ["mean_absolute_shift_ms", "Mean timing shift (ms)"],
      maximum = ["maximum_absolute_shift_ms", "Maximum timing shift (ms)"],
      shape = ["centered_normalized_rmse", "Normalized waveform difference"];
    const metrics =
      s.target === "waveform_sensitivity"
        ? [shape, timing, maximum]
        : [timing, maximum, shape];
    const head = element(element(table, "thead"), "tr");
    for (const text of ["Method", ...metrics.map((m) => m[1])])
      element(head, "th", text).scope = "col";
    const body = element(table, "tbody");
    for (const method of c.methods) {
      const row = element(body, "tr");
      element(
        row,
        "th",
        `${method.label}${s.candidate?.comparison_id === c.id && s.candidate.method === method.method ? " · Meta proposal" : ""}`,
      ).scope = "row";
      for (const [key] of metrics)
        element(row, "td", measurement(method.metrics[key], key));
    }
    element(
      p,
      "p",
      "Sensitivity is not physiological accuracy or a best-filter ranking. Exact matching counts and exclusions are available in the evidence views and complete report.",
    ).className = "preview-note";
  }
  for (const summary of s.regional_summaries || []) {
    const p = page(`Regional summary ${summary.id}`);
    p.id = `preview-evidence-${reportEvidence(s).findIndex((item) => item.id === summary.id)}`;
    renderRegionalSummary(p, summary);
  }
  if (!s.comparisons.length)
    element(
      page("Retained local evidence"),
      "p",
      `No successful comparison was retained. ${s.inspections.length} local inspection summaries remain in the complete report. No timing or morphology conclusion is supported.`,
    );
  for (const text of chunks(s.notes))
    element(page("Notes used for this run"), "p", text);
  const limitPage = page("Limits and reproducibility");
  element(
    limitPage,
    "p",
    "Research inspection only. Candidate peaks are not verified heartbeats. Sensitivity does not establish physiological accuracy, true SNR or a best filter.",
  );
  element(
    limitPage,
    "p",
    "Offline filters use future samples. Boundary guards are heuristic; missing, flat and short segments are excluded. The complete report retains every research limitation and matching replay data retains exact numerical inputs.",
  );
  fields(limitPage, {
    "Source ID": s.source_id,
    "Experiment ID": s.experiment_id,
    "Evidence/run ID": s.evidence_id,
  });
  let current = 0;
  const showPage = () => {
    pages.forEach((p, index) => {
      p.hidden = index !== current;
    });
    select.value = String(current);
    prev.disabled = current === 0;
    next.disabled = current === pages.length - 1;
  };
  prev.addEventListener("click", () => {
    current--;
    showPage();
  });
  next.addEventListener("click", () => {
    current++;
    showPage();
  });
  select.addEventListener("change", () => {
    current = Number(select.value);
    showPage();
  });
  showPage();
  return article;
}

export function renderReport(container, snapshot, { omitPlots = false } = {}) {
  container.replaceChildren();
  const s = snapshot,
    article = element(container, "article");
  article.className = "readable-report";
  element(article, "h1", "SignalTrace investigation report");
  if (s.requirements)
    renderRequirementDecision(element(article, "section"), s, {
      evidenceHref: (id) =>
        `#report-evidence-${reportEvidence(s).findIndex((c) => c.id === id)}`,
    });
  element(
    article,
    "p",
    s.kind === "manual"
      ? "Manual numerical comparison. Meta was not used."
      : "Meta-directed investigation. The model proposal below is unverified; local numerical measurements are reported separately.",
  );
  if (s.kind !== "investigation")
    element(article, "h2", outcomeLabel(s.status));
  if (s.kind === "investigation")
    renderInvestigationFinding(element(article, "div"), s);
  if (s.kind === "investigation")
    renderInvestigationStory(element(article, "div"), s);
  if (s.proposal)
    element(article, "p", `Unverified model proposal: ${s.proposal}`);
  if (s.candidate)
    element(
      article,
      "p",
      `Unverified proposal: ${METHODS[s.candidate.method] || "method unavailable"} over ${interval(s.candidate.window)}, based on comparison ${s.candidate.comparison_id}.`,
    );
  for (const question of s.questions)
    element(article, "p", `Meta asks: ${question}`);
  const scope = section(article, "1. Question and exact scope");
  fields(scope, {
    Recording: s.source_name,
    "Declared modality": s.modality.toUpperCase(),
    Experiment: s.experiment_name,
    Task: "Offline PPG preprocessing comparison",
    Target: targetLabel(s.target),
    "Question used": s.question,
    "Notes used": s.notes,
    Channel: s.channel,
    "Requested interval": interval(s.window),
    Comparator: comparatorLabel(s.comparator),
  });
  if (s.model) {
    const model = section(article, "2. Meta role and unverified proposal");
    element(
      model,
      "p",
      "Meta selected bounded tests and interpreted their summaries. SignalTrace computed the measurements locally. This report does not verify the narrative or recommend a universal filter.",
    );
    fields(model, {
      Provider: s.model.provider,
      Model: s.model.model,
      "Execution mode":
        s.model.execution_mode === "mocked_test"
          ? "Mocked software test"
          : s.model.execution_mode,
    });
    if (!s.proposal)
      element(model, "p", "No accepted model conclusion is available.");
    const citations = element(model, "p", "Cited local evidence: ");
    const all = reportEvidence(s);
    for (const id of s.citations) {
      const index = all.findIndex((item) => item.id === id);
      if (index >= 0) {
        const link = element(citations, "a", ` ${id} `);
        link.setAttribute("href", `#report-evidence-${index}`);
      } else element(citations, "span", ` ${id} (unavailable) `);
    }
    if (!s.citations.length) element(citations, "span", "none");
    if (s.error_code)
      element(
        model,
        "p",
        `Run failed; retained measurements are partial evidence, not a completed recommendation. Safe error code: ${s.error_code}.`,
      );
  }
  renderExplanation(article, s);
  const evidence = section(
    article,
    `${s.model ? "3" : "2"}. Locally computed evidence`,
  );
  element(
    evidence,
    "p",
    "Timing shifts are shown to 0.1 ms and normalized waveform difference to 0.001; smaller nonzero values show a bound. Zero means a measured zero; not available means the metric was not available. The snapshot and matching replay data retain precise measurements. Normalized waveform difference has no physical unit.",
  );
  for (const [index, inspection] of s.inspections.entries()) {
    const p = element(evidence, "section");
    const heading = element(p, "h3", `Inspection ${inspection.id}`);
    heading.id = `report-evidence-${index}`;
    element(
      p,
      "p",
      `Interval ${interval(inspection.window)}. ${show(inspection.counts.finite_count)} of ${show(inspection.counts.sample_count)} samples are finite; ${show(inspection.counts.missing_count)} missing samples, ${show(inspection.counts.gap_count)} timestamp gaps and ${show(inspection.counts.missing_interval_count)} missing intervals.`,
    );
    fields(p, {
      Minimum: inspection.statistics.minimum,
      Maximum: inspection.statistics.maximum,
      Mean: inspection.statistics.mean,
      "Standard deviation": inspection.statistics.standard_deviation,
    });
  }
  if (!s.comparisons.length)
    element(
      evidence,
      "p",
      "No successful comparison was retained. No timing or morphology conclusion can be drawn from this report.",
    );
  for (const [index, c] of s.comparisons.entries()) {
    const block = element(evidence, "section");
    const heading = element(block, "h3", `Comparison ${c.id}`);
    heading.id = `report-evidence-${s.inspections.length + index}`;
    fields(block, {
      "Exact interval": interval(c.window),
      Comparator: comparatorLabel(c.comparator),
      "Median window (s)": c.parameters.median_window_s,
      "High-pass cutoff (Hz)": c.parameters.highpass_hz,
      "Edge guard (s)": c.parameters.edge_guard_s,
    });
    element(
      block,
      "p",
      `${show(c.counts.valid_count)} of ${show(c.counts.sample_count)} selected samples contribute; ${percent(c.counts.excluded_fraction)} excluded. Nonfinite: ${show(c.counts.nonfinite_count)}; exact-flat: ${show(c.counts.exact_flat_sample_count)}; gaps: ${show(c.counts.gap_count)}; retained intervals: ${show(c.counts.valid_interval_count)}; too-short segments: ${show(c.counts.too_short_segment_count)}.`,
    );
    const proposed =
      s.candidate?.comparison_id === c.id ? s.candidate.method : null;
    const plottedMethod = METHODS[c.plot?.selected_method]
      ? c.plot.selected_method
      : METHODS[proposed]
        ? proposed
        : "median";
    if (!omitPlots) {
      if (c.plot) {
        element(
          block,
          "p",
          `Full-window original + ${METHODS[plottedMethod]} overlay in ${c.plot.unit}. Shading marks exclusions. Source: ${s.kind === "manual" ? "manual comparison; Meta was not used" : `Meta investigation ${s.evidence_id}, comparison ${c.id}`}.`,
        );
        staticEvidenceChart(block, c.plot, c, plottedMethod);
      } else
        element(
          block,
          "p",
          "Waveform plot not loaded for this comparison. Numerical measurements below remain available.",
        );
    }
    const tableWrap = element(block, "div");
    tableWrap.className = "evidence-table-scroll";
    tableWrap.tabIndex = 0;
    tableWrap.setAttribute("role", "region");
    tableWrap.setAttribute(
      "aria-label",
      "All method measurements; scroll horizontally for all columns",
    );
    evidenceTable(tableWrap, c, s.target, proposed);
  }
  for (const [index, summary] of (s.regional_summaries || []).entries()) {
    const block = element(evidence, "section");
    const heading = element(block, "h3", `Regional summary ${summary.id}`);
    heading.id = `report-evidence-${s.inspections.length + s.comparisons.length + index}`;
    const parentIndex = reportEvidence(s).findIndex(
      (c) => c.id === summary.comparison_id && s.comparisons.includes(c),
    );
    renderRegionalSummary(block, summary, {
      parentHref:
        parentIndex >= 0 ? `#report-evidence-${parentIndex}` : undefined,
    });
    if (parentIndex < 0)
      element(
        block,
        "p",
        "Parent comparison unavailable; no regional plot is substituted.",
      );
  }
  const questions = section(article, "Questions and next review");
  if (s.questions.length)
    for (const question of s.questions) element(questions, "p", question);
  else
    element(
      questions,
      "p",
      "Review the exact scope, exclusions and evidence before choosing another test. No additional model questions were retained.",
    );
  const limits = section(article, "Limits and reproducibility");
  for (const limit of s.limitations) element(limits, "p", limit);
  fields(limits, {
    "Source ID": s.source_id,
    "Experiment ID": s.experiment_id,
    "Evidence/run ID": s.evidence_id,
  });
  if (s.model)
    fields(limits, {
      "History mode": s.model.history_mode,
      Rounds: s.rounds,
      "Tool attempts": s.tool_attempts,
    });
  return article;
}
const LIGHT_THEME = `--canvas:#f6f8fa;--surface:#ffffff;--raised:#edf0f4;--text:#202b38;--secondary:#425164;--muted:#586576;--line:#d1d9e0;--control-border:#7b8797;--accent:#215e89;--focus:#986100;--plot-bg:#ffffff;--plot-grid:#d1d9e0;--plot-axis:#6d7a89;--plot-text:#425164;--plot-exclusion:#e7ebf0;--trace-raw:#526174;--trace-unchanged:#955781;--trace-median:#996400;--trace-highpass:#006c9a;--trace-reference:#007658;--marker-matched:#526174;--marker-unmatched:#996400;`;
const DARK_THEME = `--canvas:#0d1117;--surface:#161b22;--raised:#1e2430;--text:#e6edf3;--secondary:#a8b3bf;--muted:#8b949e;--line:#30363d;--control-border:#758293;--accent:#79c0ff;--focus:#e69f00;--plot-bg:#161b22;--plot-grid:#30363d;--plot-axis:#758293;--plot-text:#a8b3bf;--plot-exclusion:#30363d;--trace-raw:#a8b3bf;--trace-unchanged:#cc79a7;--trace-median:#e69f00;--trace-highpass:#56b4e9;--trace-reference:#009e73;--marker-matched:#a8b3bf;--marker-unmatched:#e69f00;`;
const STYLES = `:root{${LIGHT_THEME}font-size:100%;color-scheme:light}:root[data-theme=dark]{${DARK_THEME}color-scheme:dark}body{margin:0;padding:2rem;color:var(--text);background:var(--surface);font:1.25rem/1.6 system-ui,sans-serif}a{color:var(--accent)}.readable-report{max-width:72ch;margin:auto;overflow-wrap:anywhere}.readable-report h1{font-size:2.25rem;line-height:1.2}.readable-report h2{font-size:1.6rem;line-height:1.3;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line)}.readable-report h3{font-size:1.35rem;color:var(--text)}.readable-report dl{display:grid;grid-template-columns:minmax(10rem,1fr) minmax(0,2fr);gap:.5rem 1rem}.readable-report dt{font-weight:600}.readable-report dd{margin:0;white-space:pre-wrap}.readable-report p{white-space:pre-wrap}@media(max-width:40rem){body{padding:1rem}.readable-report dl{display:block}.readable-report dd{margin-bottom:1rem}}@media print{:root,:root[data-theme=dark]{${LIGHT_THEME}color-scheme:light}body{padding:0;color:var(--text);background:#fff}.readable-report{max-width:none}.readable-report h1,.readable-report h2,.readable-report h3{break-after:avoid}.readable-report dl{break-inside:avoid}}`;
// Printed tables fit A4 without breaking scientific labels in the middle of a
// word. Closed disclosures need content-visibility as well as display in current
// Chromium; direct-child display also covers engines using the older UA rule.
const PRINT_REFINEMENTS = `@media print{.evidence-table{overflow-wrap:normal;word-break:normal;hyphens:none;table-layout:auto}.evidence-table th,.evidence-table td{padding:3pt 4pt;overflow-wrap:normal;word-break:normal;hyphens:none;vertical-align:top}.evidence-table tr{break-inside:avoid;page-break-inside:avoid}.evidence-table thead{display:table-header-group}.readable-report details::details-content{display:block;content-visibility:visible;height:auto;block-size:auto}.readable-report details>:not(summary){display:block;content-visibility:visible}}`;

export function reportHTML(snapshot, document, { theme = "light" } = {}) {
  const output = document.implementation.createHTMLDocument(
    "SignalTrace readable report",
  );
  output.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  const meta = output.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute(
    "content",
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
  );
  output.head.prepend(meta);
  const charset = output.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  output.head.prepend(charset);
  const viewport = output.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  output.head.append(viewport);
  element(
    output.head,
    "style",
    STYLES +
      `.finding-waveform-viewport{overflow-x:auto;max-width:100%}.finding-waveform svg{display:block;width:100%;min-width:660px;height:auto;font:14px system-ui,sans-serif}.finding-waveform details{font-size:.875rem}@media print{.finding-waveform-viewport{overflow:visible}.finding-waveform svg{min-width:0}.finding-waveform details::details-content{display:block}}` +
      `.finding-charts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.finding-figure{margin:12px 0;padding:12px 0;border-top:1px solid var(--line);min-width:0;break-inside:avoid}.finding-figure figcaption{font-weight:600;font-size:1rem}.finding-figure .finding-scale,.finding-figure .finding-chart-row p{font-size:.875rem;margin:4px 0;line-height:1.35}.finding-scale{color:var(--secondary)}.finding-chart-row{margin:10px 0}.finding-track{display:flex;width:100%;height:10px;border-left:1px solid var(--plot-axis);background:var(--raised)}.finding-bar{display:block;height:100%;background:var(--trace-raw);flex:none}.finding-unmatched{background:var(--marker-unmatched)}.finding-chart-value{font-variant-numeric:tabular-nums}.finding-summary{font-size:1.125rem;font-weight:600;line-height:1.45}.finding-outcome{font-size:1rem;font-weight:600}.finding-figure .finding-evidence{gap:12px;font-size:.875rem;margin-top:8px;display:flex;flex-wrap:wrap}.finding-scope{margin-top:12px}.finding-scope summary{cursor:pointer;font-weight:600}.finding-source{font-size:.875rem;color:var(--secondary)}.finding-figure a{color:var(--accent)}@media(max-width:55rem){.finding-charts{grid-template-columns:minmax(0,1fr)}}@media print{.finding-charts{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.finding-track,.finding-bar{print-color-adjust:exact;-webkit-print-color-adjust:exact}.finding-scope::details-content{display:block}}` +
      `.finding-contrast{display:flex;gap:2rem}.finding-contrast dd{font-size:2rem;margin:0;font-variant-numeric:tabular-nums}.finding-evidence{display:flex;gap:1rem;flex-wrap:wrap}.investigation-finding{padding:0}.evidence-chart{height:25rem;width:100%}.evidence-chart svg{width:100%;height:100%}.chart text{font-size:1rem}.evidence-table-scroll{overflow-x:auto}.evidence-table{border-collapse:collapse;font-size:1rem;width:100%}.evidence-table caption{text-align:left;font-weight:600}.evidence-table th,.evidence-table td{padding:.5rem;text-align:left;border-bottom:1px solid var(--line)}.meta-proposal{background:var(--raised)}@media print{.evidence-table{font-size:9pt}.evidence-table-scroll{overflow:visible}.evidence-chart{break-inside:avoid}}` +
      PRINT_REFINEMENTS,
  );
  renderReport(output.body, snapshot);
  return "<!doctype html>\n" + output.documentElement.outerHTML;
}
