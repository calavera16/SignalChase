import { validatedPlot, METHODS } from "./evidence.js";
import { makeInvestigationReport } from "./report.js";

// The picture is a pure function of retained evidence and time. No model, detector,
// filter, generated code or transport is invoked by playback or video export.
const PARAMS = ["median_window_s", "highpass_hz", "edge_guard_s"];
const METHOD_PARAMETER = { median: "median_window_s", highpass: "highpass_hz" };
const KINDS = [
  "scope",
  "settings_contrast",
  "candidate_focus",
  "metrics",
  "uncertainty",
];
const DURATIONS = {
  scope: 6.6,
  settings_contrast: 11,
  candidate_focus: 11,
  metrics: 5.8,
  uncertainty: 6,
};
const BEATS = {
  scope: [0, 2, 4.2],
  settings_contrast: [0, 2.1, 4.6, 7, 9.3],
  candidate_focus: [0, 2.2, 4.7, 7.6],
  metrics: [0, 2.6],
  uncertainty: [0, 3],
};
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const equal = (a, b) => {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
};
const exact = (a, b, keys) => keys.every((k) => equal(a?.[k], b?.[k]));
const require = (
  ok,
  reason = "Explanation does not match retained evidence.",
) => {
  if (!ok) throw new Error(reason);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (v) => {
  const x = clamp(v, 0, 1);
  return x * x * (3 - 2 * x);
};
const freeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const methodMetrics = (c, method) => c?.metrics?.[method];
const windowKeys = ["start_s", "end_s"];

export function validateFindingsPlan(job, plan) {
  const evidence = job?.result?.evidence;
  require(
    ["completed", "failed"].includes(job?.status) &&
      evidence &&
      typeof evidence === "object",
  );
  require(
    typeof job.evidence_digest === "string" && job.evidence_digest.length > 0,
  );
  require(
    plan?.schema === "signaltrace.explanation.v1" &&
      plan.investigation_id === job.id &&
      plan.evidence_digest === job.evidence_digest,
  );
  const hasComparisons = Object.values(evidence).some(
    (e) => e?.kind === "comparison",
  );
  require(
    Array.isArray(plan.scenes) &&
      plan.scenes.length >= (hasComparisons ? 3 : 2) &&
      plan.scenes.length <= 5,
  );
  require(
    plan.scenes[0].kind === "scope" &&
      plan.scenes.at(-1).kind === "uncertainty",
  );
  const ids = new Set();
  const scenes = plan.scenes.map((s) => {
    require(
      typeof s.id === "string" &&
        s.id.length > 0 &&
        s.id.length <= 100 &&
        !ids.has(s.id),
    );
    ids.add(s.id);
    require(
      KINDS.includes(s.kind) &&
        ["full_window", "first_unmatched"].includes(s.focus),
    );
    if (["scope", "uncertainty"].includes(s.kind))
      require(
        s.comparison_id === null &&
          s.baseline_comparison_id === null &&
          s.method === null &&
          s.focus === "full_window",
      );
    if (s.kind === "candidate_focus")
      require(
        s.focus === "first_unmatched" && s.baseline_comparison_id === null,
      );
    if (s.kind === "settings_contrast") require(s.focus === "full_window");
    if (s.kind === "metrics")
      require(s.focus === "full_window" && s.baseline_comparison_id === null);
    require(
      typeof s.caption === "string" &&
        s.caption.trim() &&
        s.caption.length <= 90,
    );
    require(
      typeof s.interpretation === "string" &&
        s.interpretation.trim() &&
        s.interpretation.length <= 240,
    );
    require(
      Array.isArray(s.evidence_ids) &&
        s.evidence_ids.length <= 8 &&
        new Set(s.evidence_ids).size === s.evidence_ids.length &&
        s.evidence_ids.every(
          (id) => typeof id === "string" && Object.hasOwn(evidence, id),
        ),
    );
    require(
      s.evidence_ids.length > 0 || ["scope", "uncertainty"].includes(s.kind),
    );
    const b = s.binding,
      c = s.comparison_id === null ? null : evidence[s.comparison_id];
    require(
      b &&
        typeof b.unit === "string" &&
        b.unit.length <= 24 &&
        b.target === job.request.target,
    );
    const metadataUnit = job.display_context?.recording?.channels?.find(
      (v) => v.name === job.request.channel,
    )?.unit;
    if (metadataUnit) require(b.unit === metadataUnit);
    require(
      finite(b.window?.start_s) &&
        finite(b.window?.end_s) &&
        b.window.end_s > b.window.start_s,
    );
    if (s.comparison_id !== null) {
      require(
        c?.kind === "comparison" &&
          s.evidence_ids.includes(s.comparison_id) &&
          Object.hasOwn(METHODS, s.method),
      );
      require(
        b.comparison_id === s.comparison_id &&
          b.method === s.method &&
          exact(b.window, c.window, windowKeys) &&
          exact(b.parameters, c.parameters, PARAMS),
      );
      require(equal(b.metrics, methodMetrics(c, s.method)));
    } else {
      require(
        ["scope", "uncertainty"].includes(s.kind) &&
          s.method === null &&
          s.baseline_comparison_id === null &&
          s.focus === "full_window",
      );
      require(
        exact(
          b.window,
          { start_s: job.request.start_s, end_s: job.request.end_s },
          windowKeys,
        ),
      );
    }
    if (s.kind === "settings_contrast" || s.baseline_comparison_id !== null) {
      const before = evidence[s.baseline_comparison_id];
      require(
        c &&
          before?.kind === "comparison" &&
          s.baseline_comparison_id !== s.comparison_id &&
          s.evidence_ids.includes(s.baseline_comparison_id),
      );
      require(
        exact(before.window, c.window, windowKeys) &&
          before.evaluation === c.evaluation,
      );
      const changed = PARAMS.filter(
        (k) => before.parameters?.[k] !== c.parameters?.[k],
      );
      require(
        changed.length === 1 &&
          b.changed_parameter === changed[0] &&
          b.baseline_comparison_id === s.baseline_comparison_id,
      );
      require(
        exact(b.baseline_parameters, before.parameters, PARAMS) &&
          equal(b.baseline_metrics, methodMetrics(before, s.method)),
      );
    }
    if (s.focus === "first_unmatched") {
      const f = b.focus;
      require(
        c &&
          f?.strategy === "first_unmatched" &&
          f.comparison_id === s.comparison_id &&
          f.method === s.method &&
          Number.isInteger(f.sample_index) &&
          f.sample_index >= 0 &&
          finite(f.time_s) &&
          finite(f.start_s) &&
          finite(f.end_s),
      );
      require(
        f.start_s >= c.window.start_s &&
          f.end_s <= c.window.end_s &&
          f.end_s > f.start_s &&
          f.end_s - f.start_s <= 4 + 1e-10 &&
          f.time_s >= f.start_s &&
          f.time_s < f.end_s,
      );
    } else require(!b.focus);
    const binding = {
      window: { start_s: b.window.start_s, end_s: b.window.end_s },
      unit: b.unit,
      target: b.target,
      focus:
        s.focus === "first_unmatched"
          ? Object.fromEntries(
              [
                "strategy",
                "comparison_id",
                "method",
                "sample_index",
                "time_s",
                "start_s",
                "end_s",
              ].map((k) => [k, b.focus[k]]),
            )
          : null,
    };
    if (c)
      Object.assign(binding, {
        comparison_id: s.comparison_id,
        parameters: Object.fromEntries(PARAMS.map((k) => [k, b.parameters[k]])),
        metrics: structuredClone(methodMetrics(c, s.method)),
        method: s.method,
      });
    if (s.baseline_comparison_id !== null)
      Object.assign(binding, {
        baseline_comparison_id: s.baseline_comparison_id,
        baseline_parameters: Object.fromEntries(
          PARAMS.map((k) => [k, b.baseline_parameters[k]]),
        ),
        baseline_metrics: structuredClone(b.baseline_metrics),
        changed_parameter: b.changed_parameter,
      });
    return {
      id: s.id,
      kind: s.kind,
      evidence_ids: [...s.evidence_ids],
      comparison_id: s.comparison_id,
      baseline_comparison_id: s.baseline_comparison_id,
      method: s.method,
      focus: s.focus,
      caption: s.caption,
      interpretation: s.interpretation,
      binding,
    };
  });
  return freeze({
    schema: plan.schema,
    investigation_id: plan.investigation_id,
    evidence_digest: plan.evidence_digest,
    identity: publicIdentity(plan.identity),
    provenance: publicProvenance(plan.provenance),
    limitations: (Array.isArray(plan.limitations) ? plan.limitations : [])
      .filter((s) => typeof s === "string")
      .slice(0, 12)
      .map((s) => s.slice(0, 400)),
    scenes,
  });
}
function publicIdentity(i) {
  return Object.fromEntries(
    ["provider", "model", "execution_mode", "history_mode"]
      .filter((k) => typeof i?.[k] === "string")
      .map((k) => [k, i[k].slice(0, 160)]),
  );
}
function publicProvenance(p) {
  return {
    ...Object.fromEntries(
      ["kind", "source", "interpretation", "historical_import"]
        .filter(
          (k) => typeof p?.[k] === "string" || typeof p?.[k] === "boolean",
        )
        .map((k) => [k, typeof p[k] === "string" ? p[k].slice(0, 240) : p[k]]),
    ),
    historical_import:
      p?.kind === "imported_historical_explanation" ||
      p?.historical_import === true,
  };
}
function snapshotFor(job, supplied) {
  if (supplied) {
    require(
      supplied.kind === "investigation" &&
        supplied.evidence_id === job.id &&
        supplied.source_id === job.request.recording_id &&
        supplied.experiment_id === job.request.experiment_id &&
        supplied.target === job.request.target &&
        supplied.channel === job.request.channel,
    );
    return supplied;
  }
  const ctx = job.display_context;
  require(ctx?.recording &&
    ctx.experiment, "Retained source context is unavailable. Open the detailed report.");
  return makeInvestigationReport({
    recording: ctx.recording,
    experiment: ctx.experiment,
    job,
  });
}
function comparisonCompatible(a, b, pa, pb, method) {
  require(
    exact(a.window, b.window, windowKeys) &&
      a.comparator === b.comparator &&
      pa.unit === pb.unit,
  );
  for (const key of ["times", "raw", "unchanged", "reference", "valid_mask"])
    require(equal(
      pa[key],
      pb[key],
    ), "Tested comparisons do not share identical retained source samples.");
  require(
    equal(
      pa.candidate_evidence?.reference_indices,
      pb.candidate_evidence?.reference_indices,
    ),
  );
  if (pa.candidate_evidence && pb.candidate_evidence) {
    const changed = PARAMS.filter((k) => a.parameters[k] !== b.parameters[k]);
    require(
      Object.keys(pa.candidate_evidence.detector).every(
        (k) =>
          changed.includes(k) ||
          pa.candidate_evidence.detector[k] ===
            pb.candidate_evidence.detector[k],
      ),
    );
  }
  require(Array.isArray(pa[method]) && Array.isArray(pb[method]));
}
function verifyFocus(scene, plot) {
  if (scene.focus !== "first_unmatched") return;
  const a = plot.candidate_evidence,
    f = scene.binding.focus,
    m = a?.methods?.[scene.method];
  require(m, "Verified candidate markers are unavailable for the selected focus.");
  const matched = new Set(m.pairs.map((p) => p[1])),
    first = m.candidate_indices.find((i) => !matched.has(i));
  require(first === f.sample_index &&
    plot.times[first] === f.time_s &&
    plot.valid_mask[
      first
    ], "Selected focus does not match the actual first unmatched candidate.");
  // Server owns the clamped four-second camera window, never generated coordinates.
  const width = Math.min(4, a.window.end_s - a.window.start_s);
  const start = Math.max(
    a.window.start_s,
    Math.min(a.window.end_s - width, f.time_s - width / 2),
  );
  require(
    Math.abs(f.start_s - start) <= 1e-9 &&
      Math.abs(f.end_s - (start + width)) <= 1e-9,
  );
}

export async function prepareFindings({
  job,
  plan,
  loadComparison,
  snapshot,
  signal,
}) {
  const accepted = validateFindingsPlan(job, plan),
    snap = snapshotFor(job, snapshot);
  const supported = accepted.scenes.some(
    (s) => !["scope", "uncertainty"].includes(s.kind),
  );
  if (!supported)
    return freeze({
      status: "no_findings",
      plan: accepted,
      snapshot: snap,
      scenes: [],
      duration: 0,
    });
  require(typeof loadComparison ===
    "function", "Comparison data loader unavailable.");
  const requested = [
    ...new Set(
      accepted.scenes
        .flatMap((s) => [s.comparison_id, s.baseline_comparison_id])
        .filter(Boolean),
    ),
  ];
  require(requested.length >
    0, "The explanation has no supported visual evidence.");
  const plots = {},
    summaries = {};
  await Promise.all(
    requested.map(async (id) => {
      if (signal?.aborted) throw new Error("Playback loading cancelled.");
      const payload = await loadComparison(id, { signal });
      if (signal?.aborted) throw new Error("Playback loading cancelled.");
      plots[id] = validatedPlot(snap, payload);
      const steps = plots[id].times
        .slice(1)
        .map((t, i) => t - plots[id].times[i])
        .sort((a, b) => a - b);
      plots[id].nominal_step = steps[Math.floor(steps.length / 2)] || Infinity;
      summaries[id] = snap.comparisons.find((c) => c.id === id);
      require(summaries[id]);
      if (summaries[id].comparator === "synthetic_reference")
        require(Array.isArray(
          plots[id].reference,
        ), "The evaluator-only reference samples are unavailable.");
      // A caller-provided report must still agree with this job's evidence.
      require(
        exact(
          summaries[id].parameters,
          job.result.evidence[id].parameters,
          PARAMS,
        ) &&
          exact(
            summaries[id].window,
            job.result.evidence[id].window,
            windowKeys,
          ),
      );
      for (const m of summaries[id].methods)
        require(equal(m.metrics, job.result.evidence[id].metrics?.[m.method]));
    }),
  );
  let cursor = 0,
    previous = null;
  const anchor = accepted.scenes.find((s) => s.comparison_id);
  const pace = Math.min(
    1,
    38 / accepted.scenes.reduce((n, s) => n + DURATIONS[s.kind], 0),
  );
  const scenes = accepted.scenes.map((s) => {
    const id = s.comparison_id || anchor.comparison_id,
      method = s.method || anchor.method;
    const plot = plots[id],
      comparison = summaries[id];
    require(plot.unit === s.binding.unit);
    verifyFocus(s, plot);
    if (s.baseline_comparison_id)
      comparisonCompatible(
        comparison,
        summaries[s.baseline_comparison_id],
        plot,
        plots[s.baseline_comparison_id],
        method,
      );
    let view =
      s.focus === "first_unmatched"
        ? { start_s: s.binding.focus.start_s, end_s: s.binding.focus.end_s }
        : comparison.window;
    // Reuse only the already accepted, verified focus excerpt to teach the original trace.
    // A display window does not change the full analysis interval or its matching.
    const teachingFocus = accepted.scenes.find(
      (v) =>
        v.kind === "candidate_focus" &&
        v.binding.focus &&
        exact(
          summaries[v.comparison_id].window,
          comparison.window,
          windowKeys,
        ) &&
        equal(plots[v.comparison_id].times, plot.times) &&
        equal(plots[v.comparison_id].raw, plot.raw) &&
        equal(plots[v.comparison_id].reference, plot.reference),
    );
    const ownsFocus =
      s.focus === "first_unmatched" || s.kind === "candidate_focus";
    if (teachingFocus && !ownsFocus)
      view = {
        start_s: teachingFocus.binding.focus.start_s,
        end_s: teachingFocus.binding.focus.end_s,
      };
    const previousView = ownsFocus ? view : previous?.view || comparison.window;
    const item = {
      ...s,
      comparison,
      plot,
      method,
      baseline: s.baseline_comparison_id
        ? {
            comparison: summaries[s.baseline_comparison_id],
            plot: plots[s.baseline_comparison_id],
          }
        : null,
      view: { ...view },
      teachingFocus:
        s.kind === "scope" && teachingFocus
          ? { comparison_id: teachingFocus.comparison_id, ...view }
          : null,
      previousView: { ...previousView },
      start: cursor,
      duration: DURATIONS[s.kind] * pace,
      beats: BEATS[s.kind].map((at, i, times) => ({
        at: cursor + at * pace,
        settled:
          cursor +
          Math.min(
            DURATIONS[s.kind] - 0.1,
            at + (times[i + 1] ? (times[i + 1] - at) * 0.65 : 0.8),
          ) *
            pace,
      })),
    };
    cursor += item.duration;
    previous = item;
    return item;
  });
  return freeze({
    status: "ready",
    plan: accepted,
    snapshot: snap,
    scenes,
    duration: cursor,
  });
}

const annotationCache = new WeakMap();
const rangeCache = new WeakMap();
function lowerBound(times, value) {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function sampleRange(plot, view) {
  let cache = rangeCache.get(plot);
  if (!cache) {
    cache = new Map();
    rangeCache.set(plot, cache);
  }
  const key = view.start_s + ":" + view.end_s;
  if (cache.has(key)) return cache.get(key);
  const first = lowerBound(plot.times, view.start_s),
    end = lowerBound(plot.times, view.end_s);
  const indices = Array.from({ length: end - first }, (_, i) => first + i);
  cache.set(key, indices);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return indices;
}
function annotationInfo(plot, method) {
  let cache = annotationCache.get(plot);
  if (!cache) {
    cache = new Map();
    annotationCache.set(plot, cache);
  }
  if (cache.has(method)) return cache.get(method);
  const a = plot.candidate_evidence,
    m = a?.methods?.[method];
  if (!m) {
    cache.set(method, null);
    return null;
  }
  const byCandidate = new Map(
    m.pairs.map(([reference, candidate]) => [candidate, reference]),
  );
  const info = {
    reference: a.reference_indices,
    candidates: m.candidate_indices,
    pairs: m.pairs,
    byCandidate,
    matchedReference: new Set(m.pairs.map(([i]) => i)),
    unmatched: m.candidate_indices.filter((i) => !byCandidate.has(i)),
  };
  cache.set(method, info);
  return info;
}
function unmatchedIndices(plot, method) {
  return annotationInfo(plot, method)?.unmatched || [];
}
function visibleAnnotation(scene, view = scene.view) {
  const info = annotationInfo(scene.plot, scene.method);
  if (!info) return { info: null, references: [], candidates: [], pairs: [] };
  const within = (i) =>
    scene.plot.times[i] >= view.start_s && scene.plot.times[i] < view.end_s;
  return {
    info,
    references: info.reference.filter(within),
    candidates: info.candidates.filter(within),
    pairs: info.pairs.filter(([a, b]) => within(a) && within(b)),
  };
}
function scanSample(plot, view, progress) {
  const indices = sampleRange(plot, view);
  if (!indices.length) return null;
  return indices[
    Math.min(
      indices.length - 1,
      Math.floor(clamp(progress, 0, 1) * indices.length),
    )
  ];
}
function matchExample(scene) {
  const matches = visibleAnnotation(scene).pairs;
  const target = scene.binding.focus?.time_s;
  if (!matches.length) return null;
  return matches.reduce((best, pair) => {
    const rank = (p) =>
      finite(target)
        ? Math.abs(scene.plot.times[p[1]] - target) +
          (scene.plot.times[p[1]] > target ? 1e6 : 0)
        : p[1];
    return !best || rank(pair) < rank(best) ? pair : best;
  }, null);
}
export function findingsFrame(prepared, time, { reducedMotion = false } = {}) {
  require(prepared?.status === "ready");
  const t = clamp(finite(time) ? time : 0, 0, prepared.duration);
  const scene =
    prepared.scenes.find((s) => t < s.start + s.duration) ||
    prepared.scenes.at(-1);
  const local = clamp(t - scene.start, 0, scene.duration),
    progress = local / scene.duration,
    beat = progress * DURATIONS[scene.kind];
  const transition = scene.kind === "scope" ? (beat - 0.8) / 1.8 : beat / 1.2;
  const mix = reducedMotion
    ? scene.kind !== "scope" || beat >= 2
      ? 1
      : 0
    : ease(transition);
  const camera = {
    start_s:
      scene.previousView.start_s +
      (scene.view.start_s - scene.previousView.start_s) * mix,
    end_s:
      scene.previousView.end_s +
      (scene.view.end_s - scene.previousView.end_s) * mix,
  };
  const reveal = (start, length) =>
    reducedMotion ? (beat >= start ? 1 : 0) : ease((beat - start) / length);
  const initialReveal =
    scene.kind === "scope"
      ? 0
      : scene.kind === "settings_contrast"
        ? reveal(0.25, 1.5)
        : 1;
  const followupReveal =
    scene.kind === "scope"
      ? 0
      : scene.kind === "settings_contrast"
        ? reveal(2.1, 2.5)
        : 1;
  const visible = visibleAnnotation(scene);
  const scopeCandidates =
    scene.comparison.comparator === "synthetic_reference"
      ? annotationInfo(scene.plot, "unchanged")?.candidates.filter(
          (i) =>
            scene.plot.times[i] >= scene.view.start_s &&
            scene.plot.times[i] < scene.view.end_s,
        ) || []
      : visible.references;
  const markerState = !visible.info
    ? "unavailable"
    : (scene.kind === "scope" ? scopeCandidates : visible.candidates).length
      ? "available"
      : "empty";
  const matchPair =
    scene.kind === "candidate_focus" ? matchExample(scene) : null;
  let scanIndex = null;
  if (markerState === "available") {
    if (scene.kind === "scope")
      scanIndex = scanSample(
        scene.plot,
        scene.view,
        reducedMotion ? 1 : (beat - 3.7) / 2.6,
      );
    else if (scene.kind === "settings_contrast")
      scanIndex = scanSample(
        scene.plot,
        scene.view,
        reducedMotion ? 1 : (beat - 6.7) / 3.4,
      );
    else if (scene.kind === "candidate_focus") {
      if (beat < 2.2)
        scanIndex = matchPair?.[1] ?? scene.binding.focus.sample_index;
      else if (beat < 4.7) {
        const from = matchPair?.[1] ?? sampleRange(scene.plot, scene.view)[0];
        const target = scene.binding.focus.sample_index;
        scanIndex = reducedMotion
          ? target
          : Math.round(from + (target - from) * ease((beat - 2.2) / 2.5));
      } else scanIndex = scene.binding.focus.sample_index;
    } else
      scanIndex = scanSample(
        scene.plot,
        scene.view,
        reducedMotion ? 1 : beat / scene.duration,
      );
  }
  const unmatched = visible.info?.unmatched || [];
  const spotlightCount =
    scene.kind === "settings_contrast"
      ? Math.min(
          unmatched.length,
          beat < 7
            ? 0
            : reducedMotion
              ? unmatched.length
              : Math.floor(((beat - 7) / 2.6) * unmatched.length) + 1,
        )
      : unmatched.length;
  const contextRank =
    scene.kind === "candidate_focus" && beat >= 7.6
      ? Math.min(unmatched.length - 1, Math.floor((beat - 7.6) / 0.65))
      : 0;
  const spotlightIndex = spotlightCount
    ? unmatched[
        scene.kind === "candidate_focus" && beat >= 7.6
          ? Math.max(0, contextRank)
          : scene.kind === "settings_contrast" && beat < 9.5
            ? spotlightCount - 1
            : 0
      ]
    : null;
  const guide = guideFor(prepared, scene, beat, markerState, matchPair);
  return {
    time: t,
    scene,
    local,
    progress,
    beat,
    guide,
    camera,
    markerState,
    markers: markerState === "available",
    scanIndex,
    scanTime: scanIndex === null ? null : scene.plot.times[scanIndex],
    locatorTime:
      markerState === "available"
        ? (scene.binding.focus?.time_s ?? null)
        : null,
    matchPair: matchPair
      ? { reference_index: matchPair[0], candidate_index: matchPair[1] }
      : null,
    matchLinkProgress:
      scene.kind === "candidate_focus" && beat < 2.2
        ? reducedMotion
          ? 1
          : ease(beat / 1.2)
        : 0,
    rawReveal: 1,
    initialReveal,
    followupReveal,
    reveal: followupReveal,
    overlayMix:
      scene.kind === "scope"
        ? 0
        : scene.kind === "settings_contrast"
          ? reveal(0, 0.9)
          : 1,
    spotlightCount,
    spotlightIndex,
    settingSide:
      scene.kind === "settings_contrast" && beat < 2.1 ? "initial" : "followup",
  };
}
function guideFor(prepared, scene, beat, markerState, matchPair) {
  const phase = BEATS[scene.kind].findLastIndex((at) => beat >= at),
    b = scene.binding,
    reference = scene.comparison.comparator === "synthetic_reference",
    comparator = reference ? "reference" : "original",
    unchanged = scene.method === "unchanged",
    otherRecipeParameter =
      scene.kind === "settings_contrast" &&
      !unchanged &&
      b.changed_parameter !== METHOD_PARAMETER[scene.method],
    contrast =
      scene.kind === "settings_contrast"
        ? scene
        : prepared.scenes.find(
            (s) => s.kind === "settings_contrast" && s.method === scene.method,
          );
  let headline,
    detail = "";
  if (scene.kind === "scope") {
    headline = [
      unchanged
        ? "What does the unchanged comparison show?"
        : b.target === "waveform_sensitivity"
          ? "Does filtering change the recorded waveform shape?"
          : "Does filtering change the peaks we detect?",
      "Height is signal amplitude; time runs across.",
      markerState === "unavailable"
        ? "Candidate markers are unavailable for this recording."
        : markerState === "empty"
          ? "No detector candidates fall in this displayed interval."
          : "The scan reveals recorded peak candidates.",
    ][phase];
    if (phase === 0)
      detail = unchanged
        ? reference
          ? "No filter is applied; the reference is evaluator-only."
          : "The signal is compared with itself; no filter is applied."
        : reference
          ? "Evaluator-only synthetic reference."
          : "We compare detected peaks before and after filtering.";
  } else if (scene.kind === "settings_contrast") {
    headline = [
      unchanged
        ? "Dashed: the initial unchanged output."
        : "Dashed: the first tested filtered output.",
      unchanged
        ? "Change the comparison's tested setting."
        : otherRecipeParameter
          ? "Change another recipe parameter."
          : "Change one tested filter setting.",
      unchanged
        ? "The unchanged method still applies no filter."
        : otherRecipeParameter
          ? "The plotted " + METHODS[scene.method] + " setting is unchanged."
          : "Filtering can change which peaks the detector selects.",
      markerState === "unavailable"
        ? "Candidate markers are unavailable; measurements remain."
        : markerState === "empty"
          ? "No detector candidates fall in this displayed interval."
          : unchanged
            ? "Replay peak detection on the unchanged signal."
            : "Replay peak detection on the saved output.",
      markerState === "unavailable"
        ? "Read the measured candidate counts below."
        : markerState === "empty"
          ? "The full-window counts remain available below."
          : b.metrics.unmatched_candidate_count === 0
            ? "No unmatched candidates in this comparison."
            : "Yellow squares have no recorded " + comparator + " match.",
    ][phase];
    if (phase === 1)
      detail = unchanged
        ? "No filter is applied by this method."
        : otherRecipeParameter
          ? "Recipe: " +
            settingLabel(
              b.changed_parameter,
              b.baseline_parameters[b.changed_parameter],
            ) +
            " → " +
            settingLabel(
              b.changed_parameter,
              b.parameters[b.changed_parameter],
            ) +
            "."
          : "Same recording. Two tested settings.";
  } else if (scene.kind === "candidate_focus") {
    headline = [
      matchPair
        ? "This pair is a recorded match."
        : "Compare the recorded detector candidates.",
      "Follow this candidate back to the " + comparator + ".",
      "This candidate has no recorded " + comparator + " match.",
      "One example here; all unmatched locations are above.",
    ][phase];
    if (phase === 2)
      detail = "A detector candidate is not a verified heartbeat.";
  } else if (scene.kind === "metrics") {
    headline = [
      unchanged
        ? "Compare the unchanged signal with the " + comparator + "."
        : "Compare the measured sensitivity.",
      "Use only the valid signal regions.",
    ][phase];
    if (unchanged && phase === 0)
      detail = reference
        ? "No filter is applied; the reference is evaluator-only."
        : "Zero difference from the original is by construction.";
  } else {
    const before = contrast?.binding.baseline_metrics,
      after = contrast?.binding.metrics;
    const detectedChanged =
      before && before.candidate_count !== after.candidate_count;
    const matchingChanged =
      before &&
      before.unmatched_candidate_count !== after.unmatched_candidate_count;
    const anyDifference = before && !equal(before, after);
    headline =
      phase === 0
        ? detectedChanged
          ? "This setting changed the detected-peak count."
          : matchingChanged
            ? "Matching changed between the tested settings."
            : anyDifference
              ? "The tested settings give different measured results."
              : contrast
                ? "These settings have the same measured summaries."
                : "These measurements describe the tested comparison."
        : unchanged
          ? "An unchanged comparison cannot establish a better filter."
          : "Which setting is better remains unresolved.";
    if (phase === 0 && (detectedChanged || matchingChanged))
      detail = "Timing measurements use the matched candidate pairs.";
  }
  return {
    source: "SignalTrace guide",
    phase,
    key: scene.id + ":" + phase,
    headline,
    detail,
  };
}

const DEFAULT_COLORS = {
  bg: "#ffffff",
  text: "#202b38",
  secondary: "#425164",
  grid: "#d1d9e0",
  exclusion: "#e7ebf0",
  raw: "#526174",
  method: "#006c9a",
  unmatched: "#996400",
};
const precision = (v) =>
  !finite(v) ? "unavailable" : String(Number(v.toPrecision(6)));
const axisPrecision = (v) =>
  !finite(v)
    ? "unavailable"
    : v !== 0 && (Math.abs(v) < 0.001 || Math.abs(v) >= 1e5)
      ? v.toExponential(2).replace(/\.00e/, "e")
      : String(Number(v.toFixed(3)));
function axisLabels(scale) {
  const values = [0, 0.5, 1].map(
    (q) => (scale.low + (scale.high - scale.low) * q) * scale.magnitude,
  );
  const labels = values.map(axisPrecision);
  if (new Set(labels).size === labels.length) return { labels, offset: null };
  // Very narrow ranges use an explicit offset rather than identical rounded ticks.
  const offset = values[1];
  return { labels: values.map((v) => axisPrecision(v - offset)), offset };
}
const settingLabel = (key, v) =>
  `${{ median_window_s: "Median window", highpass_hz: "High-pass", edge_guard_s: "Edge guard" }[key]} ${v} ${key === "highpass_hz" ? "Hz" : "s"}`;
function text(
  ctx,
  str,
  x,
  y,
  { size = 20, color, align = "left", weight = 400 } = {},
) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
}
function wrapped(ctx, str, x, y, width, style = {}) {
  const words = str.split(/\s+/),
    lines = [];
  let line = "";
  ctx.font = `${style.weight || 400} ${style.size || 20}px system-ui, sans-serif`;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) =>
    text(ctx, l, x, y + i * (style.size || 20) * 1.3, style),
  );
  return lines.length;
}
function scaleFor(arrays, indices) {
  let low = Infinity,
    high = -Infinity;
  for (const a of arrays)
    for (const i of indices)
      if (finite(a[i])) {
        low = Math.min(low, a[i]);
        high = Math.max(high, a[i]);
      }
  if (!finite(low)) return { low: 0, high: 1, magnitude: 1 };
  const magnitude = Math.max(Math.abs(low), Math.abs(high)) || 1;
  low /= magnitude;
  high /= magnitude;
  const pad = Math.max(
    (high - low) * 0.08,
    Number.EPSILON * 8,
    high === low ? 0.5 : 0,
  );
  return { low: low - pad, high: high + pad, magnitude };
}

// CSS width, not device pixels, selects the composition. Compact typography is
// drawn at its displayed size; export always selects the fixed landscape frame.
export function findingsLayout(cssWidth = 1280, devicePixelRatio = 1) {
  const available =
    finite(cssWidth) && cssWidth > 0 ? Math.round(cssWidth) : 1280;
  const compact = available < 960;
  const ratio = clamp(finite(devicePixelRatio) ? devicePixelRatio : 1, 1, 2);
  const logicalWidth = compact ? available : 1280;
  const logicalHeight = 720;
  const displayHeight = compact ? logicalHeight : (available * 720) / 1280;
  return {
    composition: compact ? "compact" : "landscape",
    logicalWidth,
    logicalHeight,
    width: Math.max(1, Math.round(available * ratio)),
    height: Math.max(1, Math.round(displayHeight * ratio)),
  };
}

const contextPathCache = new WeakMap();
function signalPath(ctx, plot, values, indices, x, y, color, width, dash = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let running = false;
  for (const i of indices) {
    if (!finite(values[i])) {
      running = false;
      continue;
    }
    const gap =
      i > 0 && plot.times[i] - plot.times[i - 1] > plot.nominal_step * 1.5;
    if (!running || gap) ctx.moveTo(x(plot.times[i]), y(values[i]));
    else ctx.lineTo(x(plot.times[i]), y(values[i]));
    running = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawContext(ctx, prepared, scene, frame, box, colors, compact) {
  let cache = contextPathCache.get(prepared);
  if (!cache) {
    cache = new Map();
    contextPathCache.set(prepared, cache);
  }
  const p = scene.plot,
    window = scene.comparison.window;
  const key = scene.comparison.id + ":" + box.width + ":" + box.height;
  let geometry = cache.get(key);
  if (!geometry) {
    const indices = sampleRange(p, window),
      scale = scaleFor([p.raw], indices);
    const commands = [];
    let running = false;
    for (const i of indices) {
      if (!finite(p.raw[i])) {
        running = false;
        continue;
      }
      const gap = i > 0 && p.times[i] - p.times[i - 1] > p.nominal_step * 1.5;
      commands.push([
        !running || gap ? "moveTo" : "lineTo",
        ((p.times[i] - window.start_s) / (window.end_s - window.start_s)) *
          box.width,
        box.height -
          ((p.raw[i] / scale.magnitude - scale.low) /
            (scale.high - scale.low)) *
            box.height,
      ]);
      running = true;
    }
    let path = null;
    if (typeof globalThis.Path2D === "function") {
      path = new globalThis.Path2D();
      for (const [operation, x, y] of commands) path[operation](x, y);
    }
    const exclusions = [];
    let excludedStart = null;
    for (let j = 0; j <= indices.length; j++) {
      const i = indices[j];
      if (j < indices.length && !p.valid_mask[i]) {
        if (excludedStart === null) excludedStart = i;
      } else if (excludedStart !== null) {
        exclusions.push([
          p.times[excludedStart],
          j < indices.length ? p.times[i] : window.end_s,
        ]);
        excludedStart = null;
      }
    }
    geometry = { commands: path ? null : commands, path, exclusions };
    cache.set(key, geometry);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  ctx.save();
  ctx.translate(box.x, box.y);
  for (const [start, end] of geometry.exclusions) {
    ctx.fillStyle = colors.exclusion;
    ctx.fillRect(
      ((start - window.start_s) / (window.end_s - window.start_s)) * box.width,
      0,
      ((end - start) / (window.end_s - window.start_s)) * box.width,
      box.height,
    );
  }
  ctx.strokeStyle = colors.raw;
  ctx.lineWidth = 0.85;
  if (geometry.path) ctx.stroke(geometry.path);
  else {
    ctx.beginPath();
    for (const [operation, x, y] of geometry.commands) ctx[operation](x, y);
    ctx.stroke();
  }
  const x = (t) =>
    ((t - window.start_s) / (window.end_s - window.start_s)) * box.width;
  const focusLeft = x(frame.camera.start_s),
    focusRight = x(frame.camera.end_s);
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = colors.method;
  ctx.fillRect(focusLeft, 0, focusRight - focusLeft, box.height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.method;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(focusLeft, 0, focusRight - focusLeft, box.height);
  const initialContext =
    scene.kind === "settings_contrast" &&
    frame.settingSide === "initial" &&
    scene.baseline;
  const all = unmatchedIndices(
    initialContext ? scene.baseline.plot : p,
    scene.method,
  );
  const shown =
    scene.kind === "scope"
      ? 0
      : initialContext
        ? frame.initialReveal >= 0.8
          ? all.length
          : 0
        : scene.kind === "settings_contrast"
          ? frame.spotlightCount
          : all.length;
  for (let rank = 0; rank < shown; rank++) {
    const xx = x(p.times[all[rank]]);
    ctx.fillStyle = colors.unmatched;
    ctx.fillRect(xx - 2.5, box.height - 6, 5, 6);
    if (all[rank] === frame.spotlightIndex) {
      ctx.strokeStyle = colors.unmatched;
      ctx.lineWidth = 1.7;
      ctx.strokeRect(xx - 6, box.height - 10, 12, 14);
    }
  }
  ctx.restore();
  text(
    ctx,
    "Full analysis " + window.start_s + "–" + window.end_s + " s",
    box.x,
    box.y - 8,
    { size: compact ? 12 : 16, color: colors.secondary },
  );
  text(
    ctx,
    compact ? "Box: excerpt" : "Shaded box: displayed excerpt",
    box.x,
    box.y + box.height + 17,
    { size: compact ? 12 : 15, color: colors.secondary },
  );
  if (shown)
    text(
      ctx,
      (initialContext ? "Initial: " : "") +
        shown +
        " / " +
        all.length +
        (compact ? " unmatched" : " unmatched locations"),
      box.x + box.width,
      box.y + box.height + 17,
      { size: compact ? 12 : 15, color: colors.unmatched, align: "right" },
    );
}
export function renderFindingsFrame(
  ctx,
  prepared,
  time,
  {
    width = 1280,
    height = 720,
    colors = DEFAULT_COLORS,
    reducedMotion = false,
    layout = "landscape",
    logicalWidth = width,
    logicalHeight = 720,
  } = {},
) {
  const f = findingsFrame(prepared, time, { reducedMotion }),
    s = f.scene,
    p = s.plot,
    c = { ...DEFAULT_COLORS, ...colors },
    compact = layout === "compact",
    pictureWidth = compact ? logicalWidth : 1280,
    pictureHeight = compact ? logicalHeight : 720;
  ctx.save();
  ctx.scale(width / pictureWidth, height / pictureHeight);
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, pictureWidth, pictureHeight);
  const headSize = compact ? 18 : 30;
  const headLines = wrapped(
    ctx,
    f.guide.headline,
    pictureWidth / 2,
    compact ? 25 : 39,
    pictureWidth - (compact ? 24 : 110),
    { size: headSize, color: c.text, align: "center", weight: 600 },
  );
  const detailY = (compact ? 25 : 39) + headLines * headSize * 1.22 + 5;
  const detailLines = wrapped(
    ctx,
    f.guide.detail,
    pictureWidth / 2,
    detailY,
    pictureWidth - (compact ? 26 : 150),
    { size: compact ? 13 : 19, color: c.secondary, align: "center" },
  );
  const headerBottom = detailY + detailLines * (compact ? 17 : 25);
  const left = compact ? 64 : 113,
    right = compact ? pictureWidth - 14 : 1227;
  const stripTop = Math.max(compact ? 133 : 119, headerBottom + 25) + 24;
  const stripHeight = compact ? 35 : 43;
  drawContext(
    ctx,
    prepared,
    s,
    f,
    { x: left, y: stripTop, width: right - left, height: stripHeight },
    c,
    compact,
  );
  const top = stripTop + stripHeight + (compact ? 43 : 44),
    bottom = pictureHeight - (compact ? 111 : 100);
  const visible = sampleRange(p, f.camera),
    x = (t) =>
      left +
      ((t - f.camera.start_s) / (f.camera.end_s - f.camera.start_s)) *
        (right - left);
  let baseline = s.baseline;
  if (!baseline)
    baseline = prepared.scenes.find(
      (v) =>
        v.comparison_id === s.comparison.id &&
        v.method === s.method &&
        v.baseline,
    )?.baseline;
  const reference = s.comparison.comparator === "synthetic_reference";
  const original = {
    label: "Original",
    values: p.raw,
    method: "raw",
    kind: "original",
  };
  const shapeMix = f.overlayMix;
  const originalFraction = 1 - shapeMix * (reference ? 0.82 : 0.73);
  const rows = [
    { ...original, top, height: (bottom - top) * originalFraction },
  ];
  if (reference && shapeMix > 0.1)
    rows.push({
      label: "Evaluator-only synthetic reference",
      values: p.reference,
      method: "reference",
      kind: "reference",
      top: top + (bottom - top) * originalFraction,
      height: (bottom - top) * 0.18 * shapeMix,
    });
  if (shapeMix > 0.1)
    rows.push({
      label: s.method === "unchanged" ? "Unchanged signal" : "Tested outputs",
      kind: "processed",
      top:
        top +
        (bottom - top) * (originalFraction + (reference ? 0.18 * shapeMix : 0)),
      height:
        (bottom - top) *
        (1 - originalFraction - (reference ? 0.18 * shapeMix : 0)),
    });
  const processedScale = scaleFor(
    [p[s.method], ...(baseline ? [baseline.plot[s.method]] : [])],
    visible,
  );
  const geometries = {};
  for (const row of rows) {
    if (row.height < 58) continue;
    const sc =
        row.kind === "processed"
          ? processedScale
          : scaleFor([row.values], visible),
      axis = axisLabels(sc);
    const labelsHeight = compact ? 38 : 25,
      yTop = row.top + labelsHeight,
      h = Math.max(10, row.height - labelsHeight - 18);
    const y = (value) =>
      yTop + h - ((value / sc.magnitude - sc.low) / (sc.high - sc.low)) * h;
    geometries[row.kind] = { y, yTop, h };
    if (compact) {
      text(ctx, row.label, 12, row.top + 13, {
        size: 14,
        color: c.text,
        weight: row.kind === "processed" ? 600 : 400,
      });
      text(
        ctx,
        p.unit +
          "; " +
          (row.kind === "processed" ? "shared" : "own") +
          " y scale",
        12,
        row.top + 29,
        { size: 12, color: c.secondary },
      );
    } else
      text(
        ctx,
        row.label +
          " · " +
          p.unit +
          (row.kind === "processed" ? " (shared scale)" : " (own scale)"),
        left,
        row.top + 15,
        {
          size: 17,
          color: c.text,
          weight: row.kind === "processed" ? 600 : 400,
        },
      );
    for (const q of [0, 0.5, 1]) {
      const yy = yTop + h - q * h;
      ctx.beginPath();
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 0.8;
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      text(ctx, axis.labels[Math.round(q * 2)], left - 7, yy + 4, {
        size: compact ? 12 : 15,
        color: c.secondary,
        align: "right",
      });
    }
    if (axis.offset !== null)
      text(ctx, "offset " + axis.offset, right, row.top + 14, {
        size: 12,
        color: c.secondary,
        align: "right",
      });
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, yTop, right - left, h);
    ctx.clip();
    let excludedStart = null;
    for (let j = 0; j <= visible.length; j++) {
      const i = visible[j];
      if (j < visible.length && !p.valid_mask[i]) {
        if (excludedStart === null) excludedStart = i;
      } else if (excludedStart !== null) {
        const end =
          j < visible.length
            ? p.times[i]
            : Math.min(f.camera.end_s, s.comparison.window.end_s);
        ctx.fillStyle = c.exclusion;
        ctx.fillRect(
          x(p.times[excludedStart]),
          yTop,
          Math.max(1, x(end) - x(p.times[excludedStart])),
          h,
        );
        excludedStart = null;
      }
    }
    if (row.kind !== "processed")
      signalPath(ctx, p, row.values, visible, x, y, c.raw, compact ? 1.7 : 2);
    else {
      if (baseline && f.initialReveal > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, yTop, (right - left) * f.initialReveal, h);
        ctx.clip();
        signalPath(
          ctx,
          baseline.plot,
          baseline.plot[s.method],
          visible,
          x,
          y,
          c.method,
          compact ? 1.7 : 2.1,
          [6, 5],
        );
        ctx.restore();
      }
      if (f.followupReveal > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, yTop, (right - left) * f.followupReveal, h);
        ctx.clip();
        signalPath(
          ctx,
          p,
          p[s.method],
          visible,
          x,
          y,
          c.method,
          compact ? 2.3 : 2.8,
        );
        ctx.restore();
      }
    }
    const info = annotationInfo(p, s.method);
    const scopeInfo = reference ? annotationInfo(p, "unchanged") : info;
    let indices =
      row.kind === "processed"
        ? info?.candidates
        : row.kind === "reference"
          ? info?.reference
          : scopeInfo?.[reference ? "candidates" : "reference"];
    if (indices)
      for (const i of indices) {
        if (p.times[i] < f.camera.start_s || p.times[i] >= f.camera.end_s)
          continue;
        const isProcessed = row.kind === "processed";
        if (
          s.kind === "scope" &&
          (!f.markers || f.scanTime === null || p.times[i] > f.scanTime)
        )
          continue;
        if (
          isProcessed &&
          (f.followupReveal <= 0 ||
            (s.kind === "settings_contrast" &&
              (f.beat < 7 || p.times[i] > f.scanTime)))
        )
          continue;
        if (!finite(isProcessed ? p[s.method][i] : row.values[i])) continue;
        const paired = !isProcessed || info.byCandidate.has(i);
        const xx = x(p.times[i]),
          yy = y(isProcessed ? p[s.method][i] : row.values[i]),
          r = compact ? 3.2 : 4;
        ctx.strokeStyle = paired
          ? isProcessed
            ? c.method
            : c.raw
          : c.unmatched;
        ctx.fillStyle = paired ? c.bg : c.unmatched;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        if (paired) ctx.arc(xx, yy, r, 0, Math.PI * 2);
        else ctx.rect(xx - r, yy - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
      }
    if (
      f.scanTime !== null &&
      !(s.kind === "candidate_focus" && f.beat >= 4.7) &&
      ((row.kind === "processed" &&
        f.followupReveal > 0 &&
        (s.kind !== "settings_contrast" || f.beat >= 7)) ||
        s.kind === "scope")
    ) {
      const xx = x(f.scanTime);
      ctx.strokeStyle = c.method;
      ctx.lineWidth = compact ? 1.4 : 2;
      ctx.beginPath();
      ctx.moveTo(xx, yTop);
      ctx.lineTo(xx, yTop + h);
      ctx.stroke();
      if (row.kind === "processed") {
        // A moving reading band reveals the exact saved output, not a newly calculated signal.
        ctx.save();
        ctx.beginPath();
        ctx.rect(xx - (compact ? 22 : 52), yTop, compact ? 44 : 104, h);
        ctx.clip();
        signalPath(
          ctx,
          p,
          p[s.method],
          visible,
          x,
          y,
          c.method,
          compact ? 3.4 : 4.3,
        );
        ctx.restore();
      }
    }
    const target = s.binding.focus?.sample_index;
    if (row.kind === "processed" && target !== undefined && f.beat >= 4.7) {
      const xx = x(p.times[target]),
        yy = y(p[s.method][target]),
        growth = reducedMotion ? 1 : ease((f.beat - 2.2) / 1.1);
      ctx.strokeStyle = c.unmatched;
      ctx.lineWidth = 2.3;
      ctx.beginPath();
      ctx.arc(xx, yy, 7 + (compact ? 5 : 9) * growth, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (s.kind !== "scope") {
    // The plotted method's setting is distinct from another parameter changed in the recipe.
    const key = METHOD_PARAMETER[s.method];
    const before = baseline
      ? s.method === "unchanged"
        ? "Unchanged signal (no filter)"
        : settingLabel(key, baseline.comparison.parameters[key])
      : null;
    const after =
      s.method === "unchanged"
        ? "Unchanged signal (no filter)"
        : settingLabel(key, s.comparison.parameters[key]);
    const legendY = top - (compact ? 6 : 10);
    const legend =
      (before ? "Dashed " + before + " · " : "") + "Solid " + after;
    wrapped(ctx, legend, pictureWidth / 2, legendY, pictureWidth - 24, {
      size: compact ? 12 : 17,
      color: c.method,
      align: "center",
    });
    if (s.kind === "settings_contrast" && f.beat >= 0.4 && f.beat < 7) {
      const current = f.settingSide === "initial" && before ? before : after;
      text(
        ctx,
        s.method === "unchanged"
          ? "Signal → no filter → peak finder"
          : "Signal → " + current + " → peak finder",
        pictureWidth / 2,
        stripTop - 28,
        { size: compact ? 12 : 16, color: c.secondary, align: "center" },
      );
    }
  }
  const originalGeometry = geometries[reference ? "reference" : "original"],
    processedGeometry = geometries.processed;
  if (
    f.matchPair &&
    originalGeometry &&
    processedGeometry &&
    f.matchLinkProgress > 0
  ) {
    const a = f.matchPair.reference_index,
      b = f.matchPair.candidate_index,
      ax = x(p.times[a]),
      ay = originalGeometry.y(reference ? p.reference[a] : p.raw[a]),
      bx = x(p.times[b]),
      by = processedGeometry.y(p[s.method][b]);
    ctx.strokeStyle = c.method;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
      ax + (bx - ax) * f.matchLinkProgress,
      ay + (by - ay) * f.matchLinkProgress,
    );
    ctx.stroke();
  }
  if (
    f.locatorTime !== null &&
    originalGeometry &&
    processedGeometry &&
    f.beat >= 4.7
  ) {
    const xx = x(f.locatorTime),
      yy = processedGeometry.y(p[s.method][s.binding.focus.sample_index]);
    ctx.strokeStyle = c.unmatched;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xx, originalGeometry.yTop);
    ctx.lineTo(xx, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    // No original marker/connector is invented at an unmatched candidate's time.
  }
  text(
    ctx,
    String(Number(f.camera.start_s.toFixed(3))) + " s",
    left,
    bottom + 12,
    { size: compact ? 12 : 17, color: c.secondary },
  );
  text(
    ctx,
    String(Number(f.camera.end_s.toFixed(3))) + " s",
    right,
    bottom + 12,
    { size: compact ? 12 : 17, color: c.secondary, align: "right" },
  );
  text(ctx, "Displayed time (s)", (left + right) / 2, bottom + 12, {
    size: compact ? 12 : 15,
    color: c.secondary,
    align: "center",
  });
  const contrast =
    s.kind === "settings_contrast"
      ? s
      : prepared.scenes.find(
          (v) => v.kind === "settings_contrast" && v.method === s.method,
        );
  let canonical =
    s.kind === "scope"
      ? "Original signal · recorded samples"
      : contrast
        ? "Full-window unmatched candidates: " +
          contrast.binding.baseline_metrics.unmatched_candidate_count +
          " → " +
          contrast.binding.metrics.unmatched_candidate_count
        : s.method === "unchanged"
          ? "Unchanged versus " +
            (reference ? "evaluator-only reference" : "original") +
            " (no filter)"
          : "Measured " + METHODS[s.method] + " sensitivity";
  if (s.kind === "candidate_focus")
    canonical =
      "One example · actual sample " +
      s.binding.focus.sample_index +
      " at " +
      s.binding.focus.time_s +
      " s";
  if (s.kind === "uncertainty" && f.guide.phase === 1)
    canonical = "Preferred filter unresolved";
  wrapped(
    ctx,
    canonical,
    pictureWidth / 2,
    pictureHeight - (compact ? 74 : 61),
    pictureWidth - 24,
    { size: compact ? 14 : 21, color: c.text, align: "center", weight: 500 },
  );
  const legend =
    f.markerState === "unavailable"
      ? "Candidate markers unavailable"
      : f.markerState === "empty"
        ? "No detector candidates in this displayed interval"
        : s.kind === "scope"
          ? "Circles: recorded detector candidates"
          : compact
            ? "Circle: candidate · Square: no match"
            : "Circle: detected candidate · Yellow square: no recorded match";
  text(ctx, legend, pictureWidth / 2, pictureHeight - 35, {
    size: compact ? 12 : 16,
    color: c.secondary,
    align: "center",
  });
  text(
    ctx,
    "Candidates are not verified heartbeats",
    pictureWidth / 2,
    pictureHeight - 14,
    { size: compact ? 12 : 16, color: c.secondary, align: "center" },
  );
  ctx.restore();
  return f;
}

function node(parent, tag, content) {
  const e = parent.ownerDocument.createElement(tag);
  if (content !== undefined) e.textContent = content;
  parent.append(e);
  return e;
}
function colorsFor(container, method) {
  const w = container.ownerDocument.defaultView,
    style = w?.getComputedStyle(container);
  const get = (name, fallback) =>
    style?.getPropertyValue(name).trim() || fallback;
  return {
    bg: get("--plot-bg", DEFAULT_COLORS.bg),
    text: get("--text", DEFAULT_COLORS.text),
    secondary: get("--secondary", DEFAULT_COLORS.secondary),
    grid: get("--plot-grid", DEFAULT_COLORS.grid),
    exclusion: get("--plot-exclusion", DEFAULT_COLORS.exclusion),
    raw: get("--trace-raw", DEFAULT_COLORS.raw),
    method: get(`--trace-${method}`, DEFAULT_COLORS.method),
    unmatched: get("--marker-unmatched", DEFAULT_COLORS.unmatched),
  };
}

export function mountFindings(container, options = {}) {
  const { job, plan, loadComparison, onEvidence, onState } = options,
    doc = container.ownerDocument,
    win = doc.defaultView;
  const abort = new AbortController(),
    media = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reduced = options.reducedMotion ?? media?.matches ?? false;
  let destroyed = false,
    prepared = null,
    time = 0,
    playing = false,
    raf = null,
    last = null,
    state = "loading",
    exportSession = null,
    downloadURL = null,
    pictureLayout = findingsLayout();
  container.replaceChildren();
  container.classList.add("findings-player");
  container.dataset.composition = pictureLayout.composition;
  const title = node(container, "h3", "Animated findings"),
    status = node(container, "p", "Loading verified local evidence…");
  status.className = "findings-status";
  status.setAttribute("role", "status");
  const pictureViewport = node(container, "div");
  pictureViewport.className = "findings-picture-viewport";
  pictureViewport.tabIndex = 0;
  pictureViewport.setAttribute("role", "region");
  pictureViewport.setAttribute(
    "aria-label",
    "Measured findings picture. Use Full screen to enlarge the waveform; caption and controls follow.",
  );
  const canvas = node(pictureViewport, "canvas");
  canvas.width = 1280;
  canvas.height = 720;
  canvas.hidden = true;
  canvas.className = "findings-picture";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Measured waveform findings; use the caption, exact scope and playback controls below.",
  );
  const controls = node(container, "div");
  controls.className = "findings-controls";
  controls.hidden = true;
  const play = node(
    controls,
    "button",
    reduced ? "Step through findings" : "Play findings",
  );
  play.type = "button";
  const previous = node(controls, "button", "Previous finding"),
    next = node(controls, "button", "Next finding"),
    replay = node(controls, "button", "Replay");
  for (const b of [previous, next, replay]) b.type = "button";
  const label = node(controls, "label", "Video position"),
    seek = node(label, "input");
  seek.type = "range";
  seek.min = "0";
  seek.step = "0.05";
  seek.value = "0";
  seek.setAttribute("aria-label", "Video position in seconds");
  const clock = node(controls, "output", "0 s");
  const caption = node(container, "p");
  caption.className = "findings-caption";
  caption.setAttribute("aria-live", "polite");
  const guideSource = node(
    container,
    "p",
    "SignalTrace guide · labels from verified evidence",
  );
  guideSource.className = "findings-guide-source";
  const scope = node(container, "p");
  scope.className = "findings-scope";
  const evidenceButton = node(container, "button", "Inspect this evidence");
  evidenceButton.type = "button";
  evidenceButton.hidden = true;
  const interpretation = node(container, "details");
  interpretation.hidden = true;
  node(interpretation, "summary", "Meta interpretation and provenance");
  const interpretationText = node(interpretation, "p"),
    provenance = node(interpretation, "p");
  const exportControls = node(container, "div");
  exportControls.className = "findings-export";
  exportControls.hidden = true;
  const exportButton = node(
      exportControls,
      "button",
      "Download findings video",
    ),
    cancelButton = node(exportControls, "button", "Cancel video export");
  exportButton.type = "button";
  cancelButton.type = "button";
  cancelButton.hidden = true;
  const exportStatus = node(exportControls, "p");
  exportStatus.setAttribute("role", "status");
  const download = node(exportControls, "a", "Save playable WebM video");
  download.hidden = true;
  const enlargeButton = node(controls, "button", "Full screen");
  enlargeButton.type = "button";
  enlargeButton.setAttribute(
    "aria-label",
    "Enlarge findings player to full screen",
  );
  let ctx = options.context;
  if (!ctx)
    try {
      ctx = canvas.getContext?.("2d");
    } catch {
      ctx = null;
    }
  const rAF =
    options.requestAnimationFrame ||
    win?.requestAnimationFrame?.bind(win) ||
    ((fn) => win.setTimeout(() => fn(Date.now()), 33));
  const cAF =
    options.cancelAnimationFrame ||
    win?.cancelAnimationFrame?.bind(win) ||
    win?.clearTimeout?.bind(win);
  const setState = (value) => {
    state = value;
    if (!destroyed)
      onState?.({ status: value, duration: prepared?.duration || 0 });
  };
  function resizePicture() {
    if (destroyed) return;
    const measured =
      pictureViewport.getBoundingClientRect?.().width ||
      pictureViewport.clientWidth ||
      container.clientWidth ||
      1280;
    const next = findingsLayout(measured, win?.devicePixelRatio || 1);
    if (
      equal(pictureLayout, next) &&
      canvas.width === next.width &&
      canvas.height === next.height
    )
      return;
    pictureLayout = next;
    canvas.width = next.width;
    canvas.height = next.height;
    canvas.style.aspectRatio = `${next.logicalWidth} / ${next.logicalHeight}`;
    container.dataset.composition = next.composition;
    draw();
  }
  function draw() {
    if (prepared?.status !== "ready" || destroyed || !ctx) return;
    const f = renderFindingsFrame(ctx, prepared, time, {
      reducedMotion: reduced,
      colors: colorsFor(container, findingsFrame(prepared, time).scene.method),
      width: canvas.width,
      height: canvas.height,
      layout: pictureLayout.composition,
      logicalWidth: pictureLayout.logicalWidth,
      logicalHeight: pictureLayout.logicalHeight,
    });
    seek.value = String(time);
    clock.textContent = `${Number(time.toFixed(1))} / ${Number(prepared.duration.toFixed(1))} s`;
    seek.setAttribute(
      "aria-valuetext",
      `${Number(time.toFixed(1))} seconds: ${f.scene.caption}`,
    );
    const guideCaption = [f.guide.headline, f.guide.detail]
      .filter(Boolean)
      .join(" ");
    if (caption.textContent !== guideCaption)
      caption.textContent = guideCaption;
    scope.textContent = `${METHODS[f.scene.method]} · full analysis [${f.scene.comparison.window.start_s}, ${f.scene.comparison.window.end_s}) s · display [${Number(f.camera.start_s.toFixed(3))}, ${Number(f.camera.end_s.toFixed(3))}) s · ${f.scene.plot.unit}`;
    interpretationText.textContent = `Original Meta caption: ${f.scene.caption} Unverified Meta interpretation: ${f.scene.interpretation}`;
    provenance.textContent = `SignalTrace guide labels explain plot reading and verified measurements; original Meta wording is preserved above. Retrospective explanation by ${prepared.plan.identity.provider || "Meta"} / ${prepared.plan.identity.model || "model not recorded"}. Separate from the investigation's recorded rationale. ${prepared.plan.provenance.historical_import ? "Imported historical explanation. " : ""}Numeric labels and sample coordinates come from validated local evidence. Axis labels are rounded for display; precision is not accuracy. Full-window matching is unchanged by display zoom.${f.scene.binding.focus ? ` Selected example: actual sample ${f.scene.binding.focus.sample_index} at ${f.scene.binding.focus.time_s} s; one unmatched candidate, not the complete unmatched set.` : ""}`;
    evidenceButton.hidden = !f.scene.comparison_id;
  }
  function pause() {
    playing = false;
    last = null;
    if (raf !== null) cAF?.(raf);
    raf = null;
    play.textContent = reduced ? "Step through findings" : "Play findings";
  }
  function tick(timestamp) {
    if (!playing || destroyed) return;
    if (last !== null)
      time = Math.min(prepared.duration, time + (timestamp - last) / 1000);
    last = timestamp;
    draw();
    if (time >= prepared.duration) {
      pause();
      return;
    }
    raf = rAF(tick);
  }
  function start() {
    if (prepared?.status !== "ready" || destroyed || exportSession) return;
    if (reduced) {
      step(1);
      return;
    }
    if (time >= prepared.duration) time = 0;
    playing = true;
    last = null;
    play.textContent = "Pause";
    raf = rAF(tick);
  }
  function seekTo(value) {
    if (prepared?.status !== "ready" || destroyed || exportSession) return;
    pause();
    time = clamp(Number(value) || 0, 0, prepared.duration);
    draw();
  }
  function step(direction = 1) {
    if (prepared?.status !== "ready" || destroyed || exportSession) return;
    if (reduced) {
      const stops = prepared.scenes.flatMap((s) =>
        s.beats.map((beat) => beat.settled),
      );
      const target =
        direction > 0
          ? stops.find((at) => at > time + 0.05)
          : stops.findLast((at) => at < time - 0.05);
      seekTo(target ?? (direction > 0 ? prepared.duration : 0));
      return;
    }
    const f = findingsFrame(prepared, time),
      i = prepared.scenes.indexOf(f.scene),
      target =
        prepared.scenes[clamp(i + direction, 0, prepared.scenes.length - 1)];
    seekTo(target.start);
  }
  function cancelExport() {
    if (exportSession) exportSession.cancel();
  }
  async function exportVideo() {
    if (prepared?.status !== "ready" || destroyed)
      return { status: "unavailable" };
    if (exportSession) return { status: "busy" };
    if (doc.hidden) {
      exportStatus.textContent =
        "Keep this tab visible while exporting the findings video.";
      return { status: "unavailable" };
    }
    const Recorder = options.MediaRecorder || win?.MediaRecorder;
    const mime = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((v) => Recorder?.isTypeSupported?.(v));
    // The capture surface never changes with player width, zoom or orientation.
    const exportCanvas =
      options.createExportCanvas?.() || doc.createElement("canvas");
    exportCanvas.width = 1280;
    exportCanvas.height = 720;
    let exportContext;
    try {
      exportContext = options.exportContext || exportCanvas.getContext?.("2d");
    } catch {
      exportContext = null;
    }
    if (
      !ctx ||
      !exportContext ||
      typeof exportCanvas.captureStream !== "function" ||
      !Recorder ||
      !mime
    ) {
      exportStatus.textContent =
        "Video export is unavailable in this browser. Playback and the detailed report remain available.";
      return { status: "unavailable" };
    }
    pause();
    const saved = time;
    // Keep one resolved appearance for the whole recording even when the user
    // changes the live player's theme while capture is in progress.
    const exportPalettes = Object.fromEntries(
      Object.keys(METHODS).map((method) => [
        method,
        colorsFor(container, method),
      ]),
    );
    exportButton.disabled = true;
    cancelButton.hidden = false;
    play.disabled = true;
    seek.disabled = true;
    previous.disabled = true;
    next.disabled = true;
    replay.disabled = true;
    download.hidden = true;
    let stream,
      recorder,
      timer,
      timeout,
      finalFrameTimer,
      finished = false,
      cancelled = false,
      failed = false,
      complete = false,
      resolveResult;
    const chunks = [];
    const promise = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const finish = (value) => {
      if (finished) return;
      finished = true;
      win.clearInterval(timer);
      win.clearTimeout(timeout);
      win.clearTimeout(finalFrameTimer);
      for (const track of stream?.getTracks?.() || []) track.stop();
      exportCanvas.width = 0;
      exportCanvas.height = 0;
      exportSession = null;
      exportButton.disabled = false;
      cancelButton.hidden = true;
      play.disabled = false;
      seek.disabled = false;
      previous.disabled = false;
      next.disabled = false;
      replay.disabled = false;
      if (!destroyed) {
        time = saved;
        draw();
        exportStatus.textContent =
          value.status === "completed"
            ? "Playable video ready. Export used only loaded local evidence."
            : value.status === "cancelled"
              ? "Video export cancelled."
              : "Video export failed. Playback and the detailed report remain available.";
      }
      resolveResult(value);
    };
    exportSession = {
      cancel() {
        cancelled = true;
        try {
          if (recorder?.state !== "inactive") recorder?.stop();
        } catch {}
        finish({ status: "cancelled" });
      },
    };
    const drawExport = () =>
      renderFindingsFrame(exportContext, prepared, time, {
        width: 1280,
        height: 720,
        layout: "landscape",
        reducedMotion: reduced,
        colors: exportPalettes[findingsFrame(prepared, time).scene.method],
      });
    try {
      stream = exportCanvas.captureStream(24);
      recorder = new Recorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 3500000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data?.size && !cancelled) {
          chunks.push(event.data);
          if (chunks.reduce((n, b) => n + b.size, 0) > 32 * 1024 * 1024) {
            failed = true;
            try {
              recorder.stop();
            } catch {}
            finish({ status: "failed" });
          }
        }
      };
      recorder.onerror = () => {
        failed = true;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {}
        finish({ status: "failed" });
      };
      recorder.onstop = () => {
        if (finished) return;
        if (cancelled) {
          finish({ status: "cancelled" });
          return;
        }
        if (failed || !complete) {
          finish({ status: "failed" });
          return;
        }
        try {
          const blob = new win.Blob(chunks, { type: mime });
          if (!blob.size) {
            finish({ status: "failed" });
            return;
          }
          if (downloadURL) win.URL.revokeObjectURL(downloadURL);
          downloadURL = win.URL.createObjectURL(blob);
          download.href = downloadURL;
          download.download = `signaltrace-findings-${String(job.id)
            .replace(/[^a-z0-9_-]/gi, "")
            .slice(0, 64)}.webm`;
          download.hidden = false;
          finish({ status: "completed", blob, url: downloadURL });
        } catch {
          finish({ status: "failed" });
        }
      };
      time = 0;
      drawExport();
      recorder.start(250);
      if (finished) return promise;
      const started = win.performance.now();
      let lastProgressBucket = -1;
      exportStatus.textContent =
        "Rendering playable video locally. Keep this tab visible…";
      timer = win.setInterval(() => {
        if (destroyed) {
          cancelExport();
          return;
        }
        time = Math.min(
          prepared.duration,
          (win.performance.now() - started) / 1000,
        );
        try {
          drawExport();
          const bucket = Math.floor(time * 4);
          if (bucket !== lastProgressBucket) {
            lastProgressBucket = bucket;
            exportStatus.textContent = `Exporting locally; playback is paused. ${time.toFixed(1)} / ${prepared.duration.toFixed(1)} s. Keep this tab visible.`;
          }
          if (time >= prepared.duration) {
            win.clearInterval(timer);
            complete = true;
            // Give automatic canvas capture one frame interval to retain the final picture.
            finalFrameTimer = win.setTimeout(() => {
              if (finished) return;
              try {
                recorder.stop();
              } catch {
                failed = true;
                finish({ status: "failed" });
              }
            }, 1000 / 24);
          }
        } catch {
          failed = true;
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch {}
          finish({ status: "failed" });
        }
      }, 1000 / 24);
      timeout = win.setTimeout(
        () => {
          failed = true;
          try {
            if (recorder.state !== "inactive") recorder.stop();
          } catch {}
          finish({ status: "failed" });
        },
        (prepared.duration + 8) * 1000,
      );
    } catch {
      failed = true;
      try {
        if (recorder?.state !== "inactive") recorder?.stop();
      } catch {}
      finish({ status: "failed" });
    }
    return promise;
  }
  play.addEventListener("click", () => (playing ? pause() : start()));
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  replay.addEventListener("click", () => {
    seekTo(0);
    if (!reduced) start();
  });
  seek.addEventListener("input", () => seekTo(seek.value));
  evidenceButton.addEventListener("click", () => {
    if (prepared && !destroyed) {
      const scene = findingsFrame(prepared, time).scene;
      onEvidence?.(scene.comparison_id, scene);
    }
  });
  exportButton.addEventListener("click", () => {
    void exportVideo();
  });
  cancelButton.addEventListener("click", cancelExport);
  enlargeButton.addEventListener("click", async () => {
    try {
      if (doc.fullscreenElement === container) {
        await doc.exitFullscreen();
      } else if (typeof container.requestFullscreen === "function") {
        await container.requestFullscreen();
      } else {
        status.textContent =
          "Full screen is unavailable in this browser. Use browser zoom to inspect the picture.";
      }
    } catch {
      status.textContent =
        "Full screen is unavailable. Playback and evidence controls remain available.";
    }
  });
  const fullscreenChange = () => {
    enlargeButton.textContent =
      doc.fullscreenElement === container ? "Exit full screen" : "Full screen";
    resizePicture();
  };
  doc.addEventListener("fullscreenchange", fullscreenChange);
  const visibilityChange = () => {
    if (doc.hidden) {
      pause();
      cancelExport();
    }
  };
  const motionChange = (event) => {
    if (options.reducedMotion !== undefined) return;
    reduced = event.matches;
    pause();
    if (prepared?.status === "ready") {
      if (reduced) {
        const frame = findingsFrame(prepared, time);
        time = frame.scene.beats[frame.guide.phase].settled;
      }
      draw();
    }
  };
  doc.addEventListener("visibilitychange", visibilityChange);
  media?.addEventListener?.("change", motionChange);
  const Observer = options.ResizeObserver || win?.ResizeObserver;
  const resizeObserver =
    typeof Observer === "function" ? new Observer(resizePicture) : null;
  if (resizeObserver) resizeObserver.observe(pictureViewport);
  else win?.addEventListener("resize", resizePicture);
  const ThemeObserver = options.MutationObserver || win?.MutationObserver;
  const themeObserver =
    typeof ThemeObserver === "function"
      ? new ThemeObserver(() => draw())
      : null;
  themeObserver?.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const ready = prepareFindings({ ...options, signal: abort.signal })
    .then((value) => {
      if (destroyed) return { status: "destroyed" };
      prepared = value;
      if (value.status === "no_findings") {
        status.textContent =
          "No supported visual finding was selected. Review the retained evidence in the detailed report.";
        caption.textContent = value.plan.scenes.at(-1).caption;
        setState("no_findings");
        return { status: "no_findings" };
      }
      if (!ctx) {
        status.textContent =
          "The findings picture is unavailable in this browser. Open the detailed report.";
        setState("unavailable");
        return { status: "unavailable" };
      }
      status.textContent = reduced
        ? "Reduced motion: use Previous and Next finding to inspect measured evidence."
        : "Ready. Play a short explanation of the measured evidence.";
      canvas.hidden = false;
      controls.hidden = false;
      exportControls.hidden = false;
      interpretation.hidden = false;
      seek.max = String(prepared.duration);
      time = reduced ? prepared.scenes[0].beats[0].settled : 0;
      resizePicture();
      draw();
      setState("ready");
      return { status: "ready", duration: prepared.duration };
    })
    .catch(() => {
      if (destroyed) return { status: "destroyed" };
      status.textContent =
        "The explanation could not be bound to verified local evidence. Open the detailed report; no replacement finding was invented.";
      setState("invalid");
      return { status: "invalid" };
    });
  return {
    ready,
    play: start,
    pause,
    seek: seekTo,
    step,
    exportVideo,
    cancelExport,
    getState: () => ({
      status: state,
      time,
      playing,
      reducedMotion: reduced,
      duration: prepared?.duration || 0,
      exporting: !!exportSession,
      composition: pictureLayout.composition,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      state = "destroyed";
      pause();
      abort.abort();
      cancelExport();
      doc.removeEventListener("visibilitychange", visibilityChange);
      media?.removeEventListener?.("change", motionChange);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (!resizeObserver) win?.removeEventListener("resize", resizePicture);
      doc.removeEventListener("fullscreenchange", fullscreenChange);
      if (doc.fullscreenElement === container)
        void doc.exitFullscreen?.().catch(() => {});
      if (downloadURL) win.URL.revokeObjectURL(downloadURL);
      downloadURL = null;
      prepared = null;
      container.replaceChildren();
      container.classList.remove("findings-player");
      delete container.dataset.composition;
    },
  };
}
