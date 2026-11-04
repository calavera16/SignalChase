import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  validateFindingsPlan,
  prepareFindings,
  findingsFrame,
  findingsLayout,
  renderFindingsFrame,
  mountFindings,
} from "../signaltrace/web/findings.js";
import {
  makeInvestigationReport,
  attachExplanationReport,
  reportHTML,
  renderReportPreview,
} from "../signaltrace/web/report.js";

// Small mocked detector output tests renderer geometry, not physiological validity.
export function findingsFixture() {
  const recording = {
      id: "r",
      name: "Mocked renderer fixture",
      modality: "ppg",
      channels: [{ name: "PPG", unit: "a.u." }],
    },
    experiment = {
      id: "x",
      recording_id: "r",
      protocol: {
        name: "Sensitivity",
        target: "pulse_timing",
        evaluation: "original_sensitivity",
        task: "ppg_preprocessing",
      },
    };
  const window = { start_s: 0, end_s: 8 },
    metrics = {
      comparator_count: 3,
      candidate_count: 3,
      matched_count: 3,
      unmatched_comparator_count: 0,
      unmatched_candidate_count: 0,
      mean_absolute_shift_ms: 0,
      maximum_absolute_shift_ms: 0,
      centered_normalized_rmse: 0.1,
    };
  const evidence = {},
    payloads = {};
  for (const [id, cutoff] of [
    ["e2", 0.35],
    ["e3", 1],
  ]) {
    const parameters = {
      median_window_s: 2,
      highpass_hz: cutoff,
      edge_guard_s: 0,
    };
    const detector = {
      ...parameters,
      highpass_order: 2,
      minimum_interior_s: 0,
      flatline_s: 1,
      peak_distance_s: 0.1,
      prominence_fraction: 0.2,
      match_tolerance_s: 0.1,
      gap_factor: 1.5,
      regularity_tolerance: 0.01,
    };
    const ms = Object.fromEntries(
      ["unchanged", "median", "highpass"].map((m) => [
        m,
        {
          ...metrics,
          ...(id === "e3" && m === "highpass"
            ? { candidate_count: 4, unmatched_candidate_count: 1 }
            : {}),
        },
      ]),
    );
    evidence[id] = {
      kind: "comparison",
      evaluation: "original_sensitivity",
      window: { ...window },
      parameters: { ...parameters },
      sample_count: 8,
      valid_count: 8,
      excluded_fraction: 0,
      nonfinite_count: 0,
      exact_flat_sample_count: 0,
      gap_count: 0,
      valid_interval_count: 1,
      metrics: ms,
    };
    const raw = [0, 1, 0, 1, 0, 1, 0, 0],
      times = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = {
      window: { ...window },
      parameters: { ...parameters },
      goal: "pulse_timing",
      comparison: "original",
      metrics: Object.fromEntries(
        Object.entries(ms).map(([m, metric]) => {
          const { comparator_count, unmatched_comparator_count, ...rest } =
            metric;
          return [
            m,
            {
              ...rest,
              reference_count: comparator_count,
              unmatched_reference_count: unmatched_comparator_count,
            },
          ];
        }),
      ),
      exclusions: {
        sample_count: 8,
        valid_count: 8,
        excluded_fraction: 0,
        nonfinite_count: 0,
        flatline_count: 0,
        gap_after_indices: [],
        valid_intervals_indices: [[0, 8]],
        too_short_segments: [],
        parameters: detector,
      },
      plot: {
        times,
        raw,
        unchanged: [...raw],
        median: raw.map((v) => v - 0.2),
        highpass: [0, 0.6, 0, 0.6, 0, 0.6, id === "e3" ? 0.3 : 0, 0],
        valid_mask: Array(8).fill(true),
      },
    };
    const annotations = {
      schema: "signaltrace.candidate-evidence.v1",
      comparison_id: id,
      sample_count: 8,
      comparator: "original",
      window: { ...window },
      parameters: { ...parameters },
      detector,
      valid_intervals_indices: [[0, 8]],
      reference_indices: [1, 3, 5],
      methods: Object.fromEntries(
        ["unchanged", "median", "highpass"].map((m) => [
          m,
          {
            candidate_indices:
              id === "e3" && m === "highpass" ? [1, 3, 5, 6] : [1, 3, 5],
            pairs: [
              [1, 1],
              [3, 3],
              [5, 5],
            ],
          },
        ]),
      ),
    };
    payloads[id] = {
      recording_id: "r",
      experiment_id: "x",
      investigation_id: "j",
      channel: "PPG",
      target: "pulse_timing",
      comparison_id: id,
      unit: "a.u.",
      result,
      candidate_evidence: annotations,
    };
  }
  const job = {
    id: "j",
    status: "completed",
    evidence_digest: "digest-mocked-fixture",
    request: {
      recording_id: "r",
      experiment_id: "x",
      target: "pulse_timing",
      channel: "PPG",
      start_s: 0,
      end_s: 8,
      question: "Sensitivity?",
    },
    display_context: { recording, experiment },
    result: {
      identity: {
        provider: "meta",
        model: "mock",
        execution_mode: "mocked_test",
      },
      evidence,
      conclusion: {
        status: "inconclusive",
        narrative: "Recorded rationale stays unchanged.",
        evidence_ids: ["e2", "e3"],
      },
    },
  };
  const generic = (kind, id) => ({
    id,
    kind,
    evidence_ids: [],
    comparison_id: null,
    baseline_comparison_id: null,
    method: null,
    focus: "full_window",
    caption:
      kind === "scope"
        ? "Follow the same recording"
        : "Review what remains unresolved",
    interpretation: "A mocked explanation of retained sensitivity evidence.",
    binding: { window: { ...window }, unit: "a.u.", target: "pulse_timing" },
  });
  const bound = (kind, id, focus = "full_window") => ({
    id,
    kind,
    evidence_ids: ["e3"],
    comparison_id: "e3",
    baseline_comparison_id: null,
    method: "highpass",
    focus,
    caption:
      kind === "settings_contrast"
        ? "A tested setting changes candidate matching"
        : "Follow a selected unmatched candidate",
    interpretation:
      "This is a descriptive sensitivity finding, requiring researcher review.",
    binding: {
      window: { ...window },
      unit: "a.u.",
      target: "pulse_timing",
      comparison_id: "e3",
      method: "highpass",
      parameters: { ...evidence.e3.parameters },
      metrics: { ...evidence.e3.metrics.highpass },
    },
  });
  const contrast = bound("settings_contrast", "contrast");
  contrast.baseline_comparison_id = "e2";
  contrast.evidence_ids = ["e2", "e3"];
  Object.assign(contrast.binding, {
    baseline_comparison_id: "e2",
    baseline_parameters: { ...evidence.e2.parameters },
    baseline_metrics: { ...evidence.e2.metrics.highpass },
    changed_parameter: "highpass_hz",
  });
  const focus = bound("candidate_focus", "focus", "first_unmatched");
  focus.binding.focus = {
    strategy: "first_unmatched",
    comparison_id: "e3",
    method: "highpass",
    sample_index: 6,
    time_s: 6,
    start_s: 4,
    end_s: 8,
  };
  const plan = {
    schema: "signaltrace.explanation.v1",
    investigation_id: "j",
    evidence_digest: job.evidence_digest,
    identity: {
      provider: "meta",
      model: "mock",
      execution_mode: "mocked_test",
    },
    provenance: { kind: "retrospective_explanation" },
    scenes: [
      generic("scope", "scope"),
      contrast,
      focus,
      generic("uncertainty", "limits"),
    ],
    limitations: ["Mocked renderer fixture, not a clinical finding."],
  };
  return {
    recording,
    experiment,
    job,
    plan,
    payloads,
    loadComparison: async (id) => structuredClone(payloads[id]),
  };
}
function canvasContext() {
  const log = [];
  const ctx = new Proxy(
    { log, measureText: (s) => ({ width: String(s).length * 11 }) },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => log.push([key, ...args]);
      },
      set(target, key, value) {
        target[key] = value;
        log.push([key, value]);
        return true;
      },
    },
  );
  return ctx;
}
function playerFixture(options = {}) {
  const f = findingsFixture(),
    dom = new JSDOM("<main></main>", { pretendToBeVisual: true }),
    container = dom.window.document.querySelector("main"),
    context = canvasContext(),
    exportCanvas = dom.window.document.createElement("canvas"),
    exportContext = canvasContext();
  exportCanvas.getContext = () => exportContext;
  const ui = mountFindings(container, {
    ...f,
    context,
    createExportCanvas: () => exportCanvas,
    ...options,
  });
  return { ...f, dom, container, context, exportCanvas, exportContext, ui };
}
test("accepted scene binding is detached and validates job, digest, evidence, method, exact values and tested contrast", () => {
  const f = findingsFixture(),
    before = JSON.stringify(f.plan),
    accepted = validateFindingsPlan(f.job, f.plan);
  assert.ok(Object.isFrozen(accepted.scenes[1].binding.metrics));
  assert.equal(JSON.stringify(f.plan), before);
  for (const alter of [
    (p) => (p.investigation_id = "old"),
    (p) => (p.evidence_digest = "old"),
    (p) => (p.scenes[1].evidence_ids = ["unrelated"]),
    (p) => (p.scenes[1].comparison_id = "e2"),
    (p) => (p.scenes[1].binding.parameters.highpass_hz = 0.8),
    (p) => (p.scenes[1].binding.metrics.unmatched_candidate_count = 9),
    (p) => (p.scenes[1].binding.baseline_parameters.highpass_hz = 0.4),
    (p) => (p.scenes[1].binding.changed_parameter = "median_window_s"),
    (p) => (p.scenes[2].binding.focus.method = "median"),
    (p) => (p.scenes[2].binding.unit = "mV"),
    (p) => (p.scenes[2].id = "scope"),
    (p) => (p.scenes[1].caption = "x".repeat(91)),
    (p) => (p.scenes[1].method = "unknown"),
  ]) {
    const p = structuredClone(f.plan);
    alter(p);
    assert.throws(() => validateFindingsPlan(f.job, p));
  }
});
test("preparation binds actual retained samples, own annotations and first unmatched focus rather than trusting stored coordinates", async () => {
  const f = findingsFixture(),
    prepared = await prepareFindings(f);
  assert.equal(prepared.scenes[2].plot.times[6], 6);
  assert.equal(prepared.scenes[2].plot.highpass[6], 0.3);
  assert.deepEqual(
    prepared.scenes[2].plot.candidate_evidence.methods.highpass
      .candidate_indices,
    [1, 3, 5, 6],
  );
  for (const alter of [
    (f) => (f.plan.scenes[2].binding.focus.sample_index = 5),
    (f) => (f.plan.scenes[2].binding.focus.time_s = 6.1),
    (f) => {
      f.plan.scenes[2].binding.focus.start_s = 3.5;
      f.plan.scenes[2].binding.focus.end_s = 7.5;
    },
    (f) => (f.payloads.e2.result.plot.raw[2] = 99),
    (f) => f.payloads.e3.candidate_evidence.methods.highpass.pairs.push([5, 6]),
    (f) => (f.payloads.e3.investigation_id = "old"),
    (f) => (f.payloads.e3.result.plot.times[6] = 5),
  ]) {
    const next = findingsFixture();
    alter(next);
    await assert.rejects(prepareFindings(next));
  }
  const snapshot = structuredClone(makeInvestigationReport(f));
  snapshot.comparisons[1].parameters.highpass_hz = 999;
  await assert.rejects(prepareFindings({ ...f, snapshot }));
});
test("seek state and rendered commands are identical after forward, repeated and reverse seeks; only camera coordinates interpolate", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    t = prepared.scenes[2].start + 4;
  const ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, t);
  const expected = structuredClone(ctx.log);
  renderFindingsFrame(ctx, prepared, prepared.duration);
  renderFindingsFrame(ctx, prepared, 0);
  ctx.log.length = 0;
  renderFindingsFrame(ctx, prepared, t);
  assert.deepEqual(ctx.log, expected);
  assert.deepEqual(findingsFrame(prepared, t).camera, { start_s: 4, end_s: 8 });
  assert.equal(
    findingsFrame(prepared, prepared.scenes[2].start).camera.start_s,
    4,
  );
  assert.ok(
    ctx.log.some(
      ([key, s]) =>
        key === "fillText" && String(s).includes("actual sample 6 at 6 s"),
    ),
  );
  assert.ok(
    ctx.log.some(
      ([key, s]) =>
        key === "fillText" && String(s).includes("Dashed High-pass"),
    ),
  );
  assert.equal(prepared.scenes[2].plot.highpass[6], 0.3);
  assert.equal(prepared.scenes[1].binding.parameters.highpass_hz, 1);
});
test("compact composition uses CSS-pixel typography, exact shared sample geometry and deterministic reverse seeking", async () => {
  assert.deepEqual(findingsLayout(350, 2), {
    composition: "compact",
    logicalWidth: 350,
    logicalHeight: 720,
    width: 700,
    height: 1440,
  });
  assert.equal(findingsLayout(960).composition, "landscape");
  const prepared = await prepareFindings(findingsFixture()),
    t = prepared.scenes[2].start + 4,
    ctx = canvasContext(),
    before = JSON.stringify(prepared);
  const options = {
    width: 350,
    height: 720,
    layout: "compact",
    logicalWidth: 350,
    logicalHeight: 720,
  };
  renderFindingsFrame(ctx, prepared, t, options);
  const expected = structuredClone(ctx.log),
    fonts = ctx.log
      .filter(([k]) => k === "font")
      .map(([, v]) => Number(v.match(/ (\d+)px/)[1]));
  assert.ok(fonts.length > 0 && Math.min(...fonts) >= 12);
  for (const label of [
    "Original",
    "Tested outputs",
    "a.u.; shared y scale",
    "Candidates are not verified heartbeats",
  ])
    assert.ok(
      ctx.log.some(([k, v]) => k === "fillText" && v === label),
      label,
    );
  // The unmatched square is the actual sample at six seconds, halfway across [4,8).
  const marker = ctx.log.find(
    ([k, x, y, w, h]) => k === "rect" && w === 6.4 && h === 6.4,
  );
  assert.ok(marker);
  assert.equal((marker[1] + 3.2 - 64) / (350 - 14 - 64), 0.5);
  assert.ok(
    ctx.log
      .filter(([k, v]) => k === "fillText" && v)
      .every(([, v, x, y]) => x >= 0 && x <= 350 && y >= 0 && y <= 720),
  );
  renderFindingsFrame(ctx, prepared, 0, options);
  renderFindingsFrame(ctx, prepared, prepared.duration, options);
  ctx.log.length = 0;
  renderFindingsFrame(ctx, prepared, t, options);
  assert.deepEqual(ctx.log, expected);
  assert.equal(JSON.stringify(prepared), before);
});
test("container resize changes composition at the same playhead and disconnects its observer on destroy", async () => {
  let resize,
    disconnected = 0;
  class Observer {
    constructor(callback) {
      resize = callback;
    }
    observe() {}
    disconnect() {
      disconnected++;
    }
  }
  const f = playerFixture({ ResizeObserver: Observer });
  await f.ui.ready;
  const picture = f.container.querySelector("canvas"),
    viewport = f.container.querySelector(".findings-picture-viewport");
  f.ui.seek(11);
  viewport.getBoundingClientRect = () => ({ width: 350 });
  resize();
  assert.equal(picture.width, 350);
  assert.equal(picture.height, 720);
  assert.equal(f.ui.getState().composition, "compact");
  assert.equal(f.ui.getState().time, 11);
  f.ui.play();
  viewport.getBoundingClientRect = () => ({ width: 1000 });
  resize();
  assert.equal(f.ui.getState().composition, "landscape");
  assert.equal(picture.width, 1000);
  assert.equal(picture.height, 563);
  assert.equal(f.ui.getState().time, 11);
  assert.equal(f.ui.getState().playing, true);
  f.ui.destroy();
  assert.equal(disconnected, 1);
  f.container.textContent = "Different result";
  resize();
  assert.equal(f.container.textContent, "Different result");
  f.dom.window.close();
});
test("a resolved theme change repaints a paused frame in place, without a new comparison or playhead change", async () => {
  let loads = 0;
  const f = findingsFixture(),
    dom = new JSDOM("<main></main>", { pretendToBeVisual: true }),
    container = dom.window.document.querySelector("main"),
    context = canvasContext();
  container.style.setProperty("--plot-bg", "#161b22");
  const ui = mountFindings(container, {
    ...f,
    context,
    loadComparison: async (id) => {
      loads++;
      return structuredClone(f.payloads[id]);
    },
  });
  await ui.ready;
  ui.seek(11.5);
  const before = ui.getState(),
    canvas = container.querySelector("canvas"),
    dimensions = [canvas.width, canvas.height];
  context.log.length = 0;
  container.style.setProperty("--plot-bg", "#ffffff");
  dom.window.document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  assert.deepEqual(ui.getState(), before);
  assert.deepEqual([canvas.width, canvas.height], dimensions);
  assert.equal(loads, 2);
  const firstColor = context.log.find(([k]) => k === "fillStyle");
  assert.deepEqual(firstColor, ["fillStyle", "#ffffff"]);
  assert.ok(context.log.some(([k]) => k === "fillRect"));
  ui.destroy();
  context.log.length = 0;
  container.style.setProperty("--plot-bg", "#000000");
  dom.window.document.documentElement.dataset.theme = "dark";
  await Promise.resolve();
  assert.deepEqual(context.log, []);
  dom.window.close();
});

function updateToyMetric(f, id, updates) {
  const summary = f.job.result.evidence[id].metrics.highpass;
  Object.assign(summary, updates);
  for (const [key, value] of Object.entries(updates))
    f.payloads[id].result.metrics.highpass[
      {
        comparator_count: "reference_count",
        unmatched_comparator_count: "unmatched_reference_count",
      }[key] || key
    ] = value;
  for (const s of f.plan.scenes) {
    if (s.comparison_id === id) s.binding.metrics = structuredClone(summary);
    if (s.baseline_comparison_id === id)
      s.binding.baseline_metrics = structuredClone(summary);
  }
}
const drawnLabels = (ctx) =>
  ctx.log
    .filter(([key]) => key === "fillText")
    .map(([, value]) => String(value));

test("the original-only opening teaches purpose, axes and actual peaks in the same verified excerpt", async () => {
  const f = findingsFixture(),
    original = JSON.stringify(f.plan),
    prepared = await prepareFindings(f),
    scene = prepared.scenes[0];
  assert.ok(prepared.duration >= 32 && prepared.duration <= 38);
  assert.match(
    findingsFrame(prepared, 0).guide.headline,
    /Does filtering change the peaks/,
  );
  assert.deepEqual(findingsFrame(prepared, 0.5).camera, {
    start_s: 0,
    end_s: 8,
  });
  assert.deepEqual(findingsFrame(prepared, 3).camera, { start_s: 4, end_s: 8 });
  assert.deepEqual(scene.teachingFocus, {
    comparison_id: "e3",
    start_s: 4,
    end_s: 8,
  });
  const ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, 6);
  assert.ok(drawnLabels(ctx).some((s) => s.includes("Original")));
  assert.ok(
    !drawnLabels(ctx).some((s) =>
      /Initial High-pass|Follow-up High-pass/.test(s),
    ),
  );
  assert.ok(findingsFrame(prepared, 6).scanTime >= 5);
  assert.equal(JSON.stringify(f.plan), original);
  const contrast = prepared.scenes[1];
  assert.deepEqual(findingsFrame(prepared, contrast.start).camera, {
    start_s: 4,
    end_s: 8,
  });
  assert.deepEqual(findingsFrame(prepared, contrast.start + 2.5).camera, {
    start_s: 4,
    end_s: 8,
  });
  const noFocus = findingsFixture();
  noFocus.plan.scenes = noFocus.plan.scenes.filter(
    (s) => s.kind !== "candidate_focus",
  );
  const overview = await prepareFindings(noFocus);
  assert.equal(overview.scenes[0].teachingFocus, null);
  assert.deepEqual(findingsFrame(overview, 4).camera, { start_s: 0, end_s: 8 });
});

test("tested traces reveal sequentially while tested values and retained samples remain exact", async () => {
  const f = findingsFixture(),
    original = JSON.stringify(f.plan),
    prepared = await prepareFindings(f),
    contrast = prepared.scenes[1];
  const initial = findingsFrame(prepared, contrast.start + 2),
    changing = findingsFrame(prepared, contrast.start + 3.2),
    settled = findingsFrame(prepared, contrast.start + 5);
  assert.equal(initial.initialReveal, 1);
  assert.equal(initial.followupReveal, 0);
  assert.equal(initial.settingSide, "initial");
  assert.equal(changing.settingSide, "followup");
  assert.ok(changing.followupReveal > 0 && changing.followupReveal < 1);
  assert.equal(settled.followupReveal, 1);
  const ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, contrast.start + 3.2);
  assert.ok(drawnLabels(ctx).some((s) => s.includes("Solid High-pass 1 Hz")));
  assert.equal(contrast.binding.baseline_parameters.highpass_hz, 0.35);
  assert.equal(contrast.binding.parameters.highpass_hz, 1);
  assert.equal(JSON.stringify(f.plan), original);
  assert.deepEqual(contrast.plot.highpass, f.payloads.e3.result.plot.highpass);
});

test("unmatched spotlights visit only retained candidate coordinates and disclose full measured counts", async () => {
  const f = findingsFixture();
  // Mocked detector output tests retained geometry; it is not physiological validation.
  f.payloads.e3.candidate_evidence.methods.highpass.candidate_indices = [
    0, 1, 2, 3, 5, 6,
  ];
  updateToyMetric(f, "e3", {
    candidate_count: 6,
    unmatched_candidate_count: 3,
  });
  f.plan.scenes = f.plan.scenes.filter((s) => s.kind !== "candidate_focus");
  const prepared = await prepareFindings(f),
    scene = prepared.scenes[1];
  assert.ok(scene.plot.candidate_evidence);
  const frames = [7.05, 7.92, 8.8].map((at) =>
    findingsFrame(prepared, scene.start + at),
  );
  assert.deepEqual(
    frames.map((v) => v.spotlightCount),
    [1, 2, 3],
  );
  assert.deepEqual(
    frames.map((v) => v.spotlightIndex),
    [0, 2, 6],
  );
  assert.ok(
    frames.every(
      (v) => v.scene.binding.metrics.unmatched_candidate_count === 3,
    ),
  );
  assert.equal(findingsFrame(prepared, scene.start + 10.5).spotlightIndex, 0);
});

test("the earliest actual sample stays under the locator through the delayed closeup", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    scene = prepared.scenes[2];
  const before = findingsFrame(prepared, scene.start + 0.8),
    moving = findingsFrame(prepared, scene.start + 2.2),
    landed = findingsFrame(prepared, scene.start + 4);
  assert.deepEqual(before.camera, { start_s: 4, end_s: 8 });
  assert.deepEqual(moving.camera, { start_s: 4, end_s: 8 });
  assert.deepEqual(before.matchPair, {
    reference_index: 5,
    candidate_index: 5,
  });
  assert.ok(before.matchLinkProgress > 0);
  assert.deepEqual(landed.camera, { start_s: 4, end_s: 8 });
  for (const frame of [before, moving, landed])
    assert.equal(frame.locatorTime, 6);
  assert.match(
    findingsFrame(prepared, scene.start + 5).guide.headline,
    /no recorded original match/,
  );
});

test("reversed settings and zero unmatched candidates do not imply an improvement or invent a spotlight", async () => {
  const f = findingsFixture(),
    c = f.plan.scenes[1];
  c.comparison_id = "e2";
  c.baseline_comparison_id = "e3";
  Object.assign(c.binding, {
    comparison_id: "e2",
    baseline_comparison_id: "e3",
    parameters: structuredClone(f.job.result.evidence.e2.parameters),
    baseline_parameters: structuredClone(f.job.result.evidence.e3.parameters),
    metrics: structuredClone(f.job.result.evidence.e2.metrics.highpass),
    baseline_metrics: structuredClone(
      f.job.result.evidence.e3.metrics.highpass,
    ),
  });
  f.plan.scenes = [f.plan.scenes[0], c, f.plan.scenes[3]];
  const prepared = await prepareFindings(f),
    contrast = prepared.scenes[1],
    frame = findingsFrame(prepared, contrast.start + 7);
  assert.equal(frame.spotlightCount, 0);
  assert.equal(frame.spotlightIndex, null);
  assert.equal(
    frame.scene.binding.baseline_metrics.unmatched_candidate_count,
    1,
  );
  assert.equal(frame.scene.binding.metrics.unmatched_candidate_count, 0);
  assert.equal(
    findingsFrame(prepared, contrast.start + 3).settingSide,
    "followup",
  );
  assert.match(
    findingsFrame(prepared, prepared.scenes[2].start + 0.5).guide.headline,
    /detected-peak count/,
  );
});

test("ending distinguishes total-count changes, matching-only changes and equal measured summaries", async () => {
  const matching = findingsFixture();
  matching.plan.scenes = matching.plan.scenes.filter(
    (s) => s.kind !== "candidate_focus",
  );
  matching.payloads.e3.candidate_evidence.methods.highpass.candidate_indices = [
    1, 3, 6,
  ];
  matching.payloads.e3.candidate_evidence.methods.highpass.pairs = [
    [1, 1],
    [3, 3],
  ];
  updateToyMetric(matching, "e3", {
    candidate_count: 3,
    matched_count: 2,
    unmatched_comparator_count: 1,
    unmatched_candidate_count: 1,
  });
  const prepared = await prepareFindings(matching),
    end = findingsFrame(prepared, prepared.scenes.at(-1).start + 0.5);
  assert.match(end.guide.headline, /Matching changed/);
  assert.ok(!end.guide.headline.includes("how many"));
  const unchanged = findingsFixture();
  unchanged.plan.scenes = unchanged.plan.scenes.filter(
    (s) => s.kind !== "candidate_focus",
  );
  unchanged.payloads.e3.candidate_evidence.methods.highpass = structuredClone(
    unchanged.payloads.e2.candidate_evidence.methods.highpass,
  );
  updateToyMetric(
    unchanged,
    "e3",
    structuredClone(unchanged.job.result.evidence.e2.metrics.highpass),
  );
  const same = await prepareFindings(unchanged);
  assert.match(
    findingsFrame(same, same.scenes.at(-1).start + 0.5).guide.headline,
    /same measured summaries/,
  );
  assert.equal(findingsFrame(same, same.scenes[1].start + 7).spotlightCount, 0);
});

test("reduced motion starts with the purpose and visits every instructional phase", async () => {
  const fixture = playerFixture({ reducedMotion: true });
  await fixture.ui.ready;
  const prepared = await prepareFindings(fixture),
    visited = [];
  for (let n = 0; n < 20; n++) {
    const frame = findingsFrame(prepared, fixture.ui.getState().time, {
      reducedMotion: true,
    });
    if (!visited.includes(frame.guide.key)) visited.push(frame.guide.key);
    if (frame.scene.kind === "candidate_focus")
      assert.ok(frame.camera.start_s === 0 || frame.camera.start_s === 4);
    const previous = fixture.ui.getState().time;
    fixture.ui.step();
    if (fixture.ui.getState().time === previous) break;
  }
  assert.equal(visited[0], "scope:0");
  assert.deepEqual(
    visited,
    prepared.scenes.flatMap((s) =>
      s.beats.map((_, phase) => s.id + ":" + phase),
    ),
  );
  fixture.ui.destroy();
  fixture.dom.window.close();
});

test("guide labels remain distinct from exact original Meta captions and interpretations", async () => {
  const f = playerFixture();
  await f.ui.ready;
  const original = JSON.stringify(f.plan);
  assert.match(
    f.container.querySelector(".findings-caption").textContent,
    /Does filtering change/,
  );
  assert.match(
    f.container.querySelector(".findings-guide-source").textContent,
    /SignalTrace guide/,
  );
  assert.ok(
    f.container
      .querySelector("details")
      .textContent.includes(f.plan.scenes[0].caption),
  );
  assert.ok(
    f.container
      .querySelector("details")
      .textContent.includes(f.plan.scenes[0].interpretation),
  );
  assert.equal(JSON.stringify(f.plan), original);
  f.ui.destroy();
  f.dom.window.close();
});

test("waveform target and evaluator-only reference retain their own honest teaching language", async () => {
  const f = findingsFixture();
  f.job.request.target = f.experiment.protocol.target = "waveform_sensitivity";
  for (const s of f.plan.scenes) s.binding.target = "waveform_sensitivity";
  for (const payload of Object.values(f.payloads)) {
    payload.target = payload.result.goal = "waveform_sensitivity";
    payload.result.comparison = "synthetic_reference";
    payload.result.plot.reference = [...payload.result.plot.raw];
    payload.candidate_evidence.comparator = "synthetic_reference";
  }
  f.experiment.protocol.evaluation = "synthetic_reference";
  for (const e of Object.values(f.job.result.evidence))
    e.evaluation = "synthetic_reference";
  const prepared = await prepareFindings(f),
    opening = findingsFrame(prepared, 0);
  assert.match(opening.guide.headline, /waveform shape/);
  assert.match(opening.guide.detail, /Evaluator-only synthetic reference/);
  const focus = findingsFrame(prepared, prepared.scenes[2].start + 5);
  assert.match(focus.guide.headline, /no recorded reference match/);
  const referenceCanvas = canvasContext();
  renderFindingsFrame(referenceCanvas, prepared, prepared.scenes[2].start + 5);
  assert.ok(
    drawnLabels(referenceCanvas).some((s) =>
      s.includes("Evaluator-only synthetic reference"),
    ),
  );
  assert.ok(!focus.guide.headline.includes("original"));
});

test("every compact instructional frame remains bounded, deterministic and numerically immutable", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    original = JSON.stringify(prepared);
  const options = {
    width: 350,
    height: 720,
    layout: "compact",
    logicalWidth: 350,
    logicalHeight: 720,
  };
  for (const scene of prepared.scenes)
    for (const beat of scene.beats) {
      const ctx = canvasContext();
      renderFindingsFrame(ctx, prepared, beat.settled, options);
      assert.ok(
        ctx.log.every((line) =>
          line.every((v) => typeof v !== "number" || Number.isFinite(v)),
        ),
      );
      assert.ok(
        ctx.log
          .filter(([key]) => key === "fillText")
          .every(([, , x, y]) => x >= 0 && x <= 350 && y >= 0 && y <= 720),
      );
      const expected = structuredClone(ctx.log);
      renderFindingsFrame(ctx, prepared, 0, options);
      ctx.log.length = 0;
      renderFindingsFrame(ctx, prepared, beat.settled, options);
      assert.deepEqual(ctx.log, expected);
    }
  assert.equal(JSON.stringify(prepared), original);
});

test("scope peak teaching uses neutral circles even when that original candidate is unmatched later", async () => {
  const f = findingsFixture();
  f.plan.scenes = f.plan.scenes.filter((s) => s.kind !== "candidate_focus");
  f.payloads.e3.candidate_evidence.methods.highpass.pairs = [
    [3, 3],
    [5, 5],
  ];
  updateToyMetric(f, "e3", {
    matched_count: 2,
    unmatched_comparator_count: 1,
    unmatched_candidate_count: 2,
  });
  const prepared = await prepareFindings(f),
    ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, 6);
  assert.ok(ctx.log.some(([key]) => key === "arc"));
  assert.ok(
    !ctx.log.some(([key, x, y, w, h]) => key === "rect" && w === 8 && h === 8),
  );
  assert.ok(drawnLabels(ctx).some((s) => s.startsWith("Original signal")));
  assert.ok(!drawnLabels(ctx).some((s) => s.startsWith("High-pass")));
  assert.match(
    findingsFrame(prepared, 6).guide.headline,
    /recorded peak candidates/,
  );
});

test("the short guide limits reading load while preserving exact Meta wording", async () => {
  const f = findingsFixture(),
    original = JSON.stringify(f.plan),
    prepared = await prepareFindings(f);
  const words = prepared.scenes
    .flatMap((s) =>
      s.beats.map((beat) => findingsFrame(prepared, beat.settled).guide),
    )
    .reduce(
      (n, guide) =>
        n +
        [guide.headline, guide.detail].filter(Boolean).join(" ").split(/\s+/)
          .length,
      0,
    );
  assert.ok(words <= 155);
  assert.equal(JSON.stringify(f.plan), original);
});

for (const reducedMotion of [false, true]) {
  test(
    "zero-unmatched guide states the measured result while positive, missing and empty marker branches stay distinct; reduced=" +
      reducedMotion,
    async () => {
      async function finalGuide(f) {
        f.plan.scenes = f.plan.scenes.filter(
          (s) => s.kind !== "candidate_focus",
        );
        const prepared = await prepareFindings(f),
          scene = prepared.scenes[1],
          at = scene.start + scene.duration * 0.95;
        const frame = findingsFrame(prepared, at, { reducedMotion }),
          ctx = canvasContext();
        renderFindingsFrame(ctx, prepared, at, { reducedMotion });
        assert.ok(drawnLabels(ctx).includes(frame.guide.headline));
        return frame;
      }
      const zero = findingsFixture();
      zero.payloads.e3.candidate_evidence.methods.highpass = structuredClone(
        zero.payloads.e2.candidate_evidence.methods.highpass,
      );
      updateToyMetric(
        zero,
        "e3",
        structuredClone(zero.job.result.evidence.e2.metrics.highpass),
      );
      const original = JSON.stringify({
        plan: zero.plan,
        evidence: zero.job.result.evidence,
      });
      const noUnmatched = await finalGuide(zero);
      assert.equal(noUnmatched.markerState, "available");
      assert.equal(
        noUnmatched.scene.binding.baseline_metrics.unmatched_candidate_count,
        0,
      );
      assert.equal(
        noUnmatched.scene.binding.metrics.unmatched_candidate_count,
        0,
      );
      assert.equal(
        noUnmatched.guide.headline,
        "No unmatched candidates in this comparison.",
      );
      assert.equal(
        JSON.stringify(zero.job.result.evidence),
        JSON.stringify(JSON.parse(original).evidence),
      );
      assert.ok(!noUnmatched.guide.headline.includes("better"));

      const positive = await finalGuide(findingsFixture());
      assert.equal(positive.scene.binding.metrics.unmatched_candidate_count, 1);
      assert.equal(
        positive.guide.headline,
        "Yellow squares have no recorded original match.",
      );

      const missing = findingsFixture();
      for (const payload of Object.values(missing.payloads))
        delete payload.candidate_evidence;
      const unavailable = await finalGuide(missing);
      assert.equal(unavailable.markerState, "unavailable");
      assert.equal(
        unavailable.guide.headline,
        "Read the measured candidate counts below.",
      );

      const empty = findingsFixture();
      empty.payloads.e3.candidate_evidence.methods.highpass = {
        candidate_indices: [],
        pairs: [],
      };
      updateToyMetric(empty, "e3", {
        candidate_count: 0,
        matched_count: 0,
        unmatched_candidate_count: 0,
        unmatched_comparator_count: 3,
        mean_absolute_shift_ms: null,
        maximum_absolute_shift_ms: null,
      });
      const noVisible = await finalGuide(empty);
      assert.equal(noVisible.markerState, "empty");
      assert.equal(
        noVisible.guide.headline,
        "The full-window counts remain available below.",
      );
    },
  );
}

for (const method of ["median", "highpass"]) {
  for (const reducedMotion of [false, true]) {
    test(
      "cross-method recipe contrast labels the actual plotted method; method=" +
        method +
        " reduced=" +
        reducedMotion,
      async () => {
        const f = findingsFixture(),
          scene = f.plan.scenes[1];
        if (method === "highpass") {
          // A valid reciprocal recipe contrast changes median window, while plotted high-pass is identical.
          Object.assign(f.job.result.evidence.e3.parameters, {
            median_window_s: 4,
            highpass_hz: 0.35,
          });
          Object.assign(f.payloads.e3.result.parameters, {
            median_window_s: 4,
            highpass_hz: 0.35,
          });
          Object.assign(f.payloads.e3.candidate_evidence.parameters, {
            median_window_s: 4,
            highpass_hz: 0.35,
          });
          Object.assign(f.payloads.e3.candidate_evidence.detector, {
            median_window_s: 4,
            highpass_hz: 0.35,
          });
          Object.assign(f.payloads.e3.result.exclusions.parameters, {
            median_window_s: 4,
            highpass_hz: 0.35,
          });
          f.payloads.e3.result.plot.highpass = [
            ...f.payloads.e2.result.plot.highpass,
          ];
          f.payloads.e3.candidate_evidence.methods.highpass = structuredClone(
            f.payloads.e2.candidate_evidence.methods.highpass,
          );
          updateToyMetric(
            f,
            "e3",
            structuredClone(f.job.result.evidence.e2.metrics.highpass),
          );
        }
        scene.method = scene.binding.method = method;
        scene.binding.parameters = structuredClone(
          f.job.result.evidence.e3.parameters,
        );
        scene.binding.metrics = structuredClone(
          f.job.result.evidence.e3.metrics[method],
        );
        scene.binding.baseline_metrics = structuredClone(
          f.job.result.evidence.e2.metrics[method],
        );
        scene.binding.changed_parameter =
          method === "median" ? "highpass_hz" : "median_window_s";
        f.plan.scenes = [f.plan.scenes[0], scene, f.plan.scenes[3]];
        const original = JSON.stringify({
          plan: f.plan,
          evidence: f.job.result.evidence,
          payloads: f.payloads,
        });
        assert.doesNotThrow(() => validateFindingsPlan(f.job, f.plan));
        const prepared = await prepareFindings(f),
          comparison = prepared.scenes[1];
        assert.equal(prepared.status, "ready");
        assert.deepEqual(
          comparison.plot[method],
          comparison.baseline.plot[method],
        );
        const selectedLabel =
          method === "median" ? "Median window 2 s" : "High-pass 0.35 Hz";
        const otherLabel = method === "median" ? "High-pass" : "Median window";
        for (const at of [1, 3, 5, 8, 10]) {
          const ctx = canvasContext();
          renderFindingsFrame(ctx, prepared, comparison.start + at, {
            reducedMotion,
          });
          const labels = drawnLabels(ctx),
            legend = labels.find((v) => v.startsWith("Dashed "));
          assert.ok(
            legend &&
              legend.includes(selectedLabel) &&
              !legend.includes(otherLabel),
          );
          const pipeline = labels.find((v) => v.startsWith("Signal →"));
          if (at < 7) {
            assert.equal(
              pipeline,
              "Signal → " + selectedLabel + " → peak finder",
            );
            assert.ok(!pipeline.includes(otherLabel));
          }
        }
        const settingBeat = findingsFrame(prepared, comparison.start + 3).guide;
        assert.match(settingBeat.headline, /another recipe parameter/);
        assert.ok(settingBeat.detail.startsWith("Recipe: " + otherLabel));
        const outputBeat = findingsFrame(prepared, comparison.start + 5).guide;
        assert.match(outputBeat.headline, /setting is unchanged/);
        assert.ok(
          outputBeat.headline.includes(
            method === "median" ? "Median" : "High-pass",
          ),
        );
        assert.equal(
          JSON.stringify({
            plan: f.plan,
            evidence: f.job.result.evidence,
            payloads: f.payloads,
          }),
          original,
        );
      },
    );
  }
}

for (const comparator of ["original", "synthetic_reference"]) {
  for (const reducedMotion of [false, true]) {
    test(
      "accepted unchanged-method metrics render as unfiltered comparison, not high-pass; comparator=" +
        comparator +
        " reduced=" +
        reducedMotion,
      async () => {
        const f = findingsFixture();
        for (const [id, payload] of Object.entries(f.payloads)) {
          f.job.result.evidence[id].metrics.unchanged.centered_normalized_rmse =
            0;
          payload.result.metrics.unchanged.centered_normalized_rmse = 0;
          if (comparator === "synthetic_reference") {
            payload.result.comparison = "synthetic_reference";
            payload.result.plot.reference = [...payload.result.plot.raw];
            payload.candidate_evidence.comparator = "synthetic_reference";
            f.job.result.evidence[id].evaluation = "synthetic_reference";
          }
        }
        if (comparator === "synthetic_reference")
          f.experiment.protocol.evaluation = "synthetic_reference";
        const evidence = f.job.result.evidence.e2;
        const metrics = {
          id: "unchanged-metrics",
          kind: "metrics",
          evidence_ids: ["e2"],
          comparison_id: "e2",
          baseline_comparison_id: null,
          method: "unchanged",
          focus: "full_window",
          caption: "Review the unchanged comparison",
          interpretation:
            "The unchanged method remains a comparison condition.",
          binding: {
            window: structuredClone(evidence.window),
            unit: "a.u.",
            target: "pulse_timing",
            comparison_id: "e2",
            method: "unchanged",
            parameters: structuredClone(evidence.parameters),
            metrics: structuredClone(evidence.metrics.unchanged),
            focus: null,
          },
        };
        f.plan.scenes = [f.plan.scenes[0], metrics, f.plan.scenes[3]];
        const originalPlan = JSON.stringify(f.plan),
          originalEvidence = JSON.stringify(f.job.result.evidence);
        assert.doesNotThrow(() => validateFindingsPlan(f.job, f.plan));
        const prepared = await prepareFindings(f);
        assert.equal(prepared.status, "ready");
        assert.equal(prepared.scenes[1].method, "unchanged");
        assert.deepEqual(
          prepared.scenes[1].plot.unchanged,
          f.payloads.e2.result.plot.unchanged,
        );
        for (const scene of prepared.scenes)
          for (const beat of scene.beats) {
            const ctx = canvasContext();
            renderFindingsFrame(ctx, prepared, beat.settled, { reducedMotion });
            const labels = drawnLabels(ctx).join(" ");
            assert.ok(
              !/High-pass|Median window|before and after filtering|Does filtering change/.test(
                labels,
              ),
            );
            if (scene.kind === "metrics") {
              assert.match(labels, /Unchanged signal/);
              assert.match(labels, /no filter/);
              assert.match(
                labels,
                comparator === "original"
                  ? /Unchanged versus original/
                  : /Unchanged versus evaluator-only reference/,
              );
              if (findingsFrame(prepared, beat.settled).guide.phase === 0) {
                if (comparator === "original")
                  assert.match(
                    labels,
                    /Zero difference from the original is by construction/,
                  );
                else assert.ok(!labels.includes("by construction"));
              }
            }
          }
        assert.equal(JSON.stringify(f.plan), originalPlan);
        assert.equal(JSON.stringify(f.job.result.evidence), originalEvidence);
      },
    );
  }
}

test("unchanged-method contrast pipeline explicitly bypasses filtering", async () => {
  const f = findingsFixture(),
    scene = f.plan.scenes[1];
  scene.method = scene.binding.method = "unchanged";
  scene.binding.metrics = structuredClone(
    f.job.result.evidence.e3.metrics.unchanged,
  );
  scene.binding.baseline_metrics = structuredClone(
    f.job.result.evidence.e2.metrics.unchanged,
  );
  f.plan.scenes = [f.plan.scenes[0], scene, f.plan.scenes[3]];
  const prepared = await prepareFindings(f),
    ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, prepared.scenes[1].start + 3);
  const labels = drawnLabels(ctx).join(" ");
  assert.match(labels, /Signal → no filter → peak finder/);
  assert.match(labels, /Unchanged signal/);
  assert.ok(!labels.includes("High-pass") && !labels.includes("Median window"));
});

for (const reducedMotion of [false, true]) {
  test(
    "two compatible candidate-focus scenes retain their own method and on-screen excerpt; reduced=" +
      reducedMotion,
    async () => {
      const f = findingsFixture();
      const metric = f.job.result.evidence.e3.metrics.median;
      Object.assign(metric, {
        candidate_count: 4,
        unmatched_candidate_count: 1,
      });
      Object.assign(f.payloads.e3.result.metrics.median, {
        candidate_count: 4,
        unmatched_candidate_count: 1,
      });
      f.payloads.e3.candidate_evidence.methods.median.candidate_indices = [
        1, 2, 3, 5,
      ];
      const median = structuredClone(f.plan.scenes[2]);
      median.id = "median-focus";
      median.method = "median";
      median.binding.method = "median";
      median.binding.metrics = structuredClone(metric);
      Object.assign(median.binding.focus, {
        method: "median",
        sample_index: 2,
        time_s: 2,
        start_s: 0,
        end_s: 4,
      });
      f.plan.scenes.splice(3, 0, median);
      const original = JSON.stringify(f.plan),
        prepared = await prepareFindings(f);
      const focuses = prepared.scenes.filter(
        (s) => s.kind === "candidate_focus",
      );
      assert.deepEqual(
        focuses.map((s) => ({ method: s.method, view: s.view })),
        [
          { method: "highpass", view: { start_s: 4, end_s: 8 } },
          { method: "median", view: { start_s: 0, end_s: 4 } },
        ],
      );
      for (const scene of focuses) {
        for (const offset of [0, 0.3, 1.5, 4, 7, scene.duration - 0.05]) {
          const frame = findingsFrame(
            prepared,
            scene.start + Math.min(offset, scene.duration - 0.01),
            { reducedMotion },
          );
          assert.deepEqual(frame.camera, scene.view);
          assert.equal(frame.scene.method, scene.binding.focus.method);
          assert.ok(
            frame.locatorTime >= frame.camera.start_s &&
              frame.locatorTime < frame.camera.end_s,
          );
        }
        const ctx = canvasContext();
        renderFindingsFrame(ctx, prepared, scene.start + scene.duration * 0.6, {
          reducedMotion,
          width: 350,
          height: 720,
          layout: "compact",
          logicalWidth: 350,
          logicalHeight: 720,
        });
        const marker = ctx.log.find(
          ([key, , , w, h]) => key === "rect" && w === 6.4 && h === 6.4,
        );
        assert.ok(marker);
        const center = marker[1] + 3.2;
        assert.ok(center >= 64 && center <= 336);
        assert.ok(
          drawnLabels(ctx).some((s) =>
            s.includes(scene.method === "median" ? "Median" : "High-pass"),
          ),
        );
      }
      assert.equal(JSON.stringify(f.plan), original);
    },
  );
}

test("rendered initial-only state contains no solid follow-up path or reading band before detection replay", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    scene = prepared.scenes[1];
  const initial = canvasContext(),
    revealed = canvasContext(),
    scanning = canvasContext();
  renderFindingsFrame(initial, prepared, scene.start + 1);
  renderFindingsFrame(revealed, prepared, scene.start + 5);
  renderFindingsFrame(scanning, prepared, scene.start + 8);
  function solidOutputPaths(ctx) {
    let color,
      width,
      dash = [],
      points = 0,
      count = 0;
    for (const [operation, ...args] of ctx.log) {
      if (operation === "strokeStyle") color = args[0];
      if (operation === "lineWidth") width = args[0];
      if (operation === "setLineDash") dash = args[0];
      if (operation === "beginPath") points = 0;
      if (operation === "lineTo") points++;
      if (
        operation === "stroke" &&
        color === "#006c9a" &&
        width > 2.5 &&
        dash.length === 0 &&
        points >= 2
      )
        count++;
    }
    return count;
  }
  assert.equal(solidOutputPaths(initial), 0);
  assert.ok(solidOutputPaths(revealed) > 0);
  assert.ok(!initial.log.some(([key, , , w]) => key === "rect" && w === 104));
  assert.ok(!revealed.log.some(([key, , , w]) => key === "rect" && w === 104));
  assert.ok(scanning.log.some(([key, , , w]) => key === "rect" && w === 104));
});

test("compact context separates full scope from excerpt without replacement-character separators", async () => {
  const prepared = await prepareFindings(findingsFixture());
  for (const scene of prepared.scenes)
    for (const beat of scene.beats) {
      const ctx = canvasContext();
      renderFindingsFrame(ctx, prepared, beat.settled, {
        width: 320,
        height: 720,
        layout: "compact",
        logicalWidth: 320,
        logicalHeight: 720,
      });
      const labels = drawnLabels(ctx);
      assert.ok(labels.some((s) => s.startsWith("Full analysis 0")));
      assert.ok(labels.includes("Box: excerpt"));
      assert.ok(!labels.some((s) => s.includes(" ? ")));
      const overview = labels.find((s) => s.startsWith("Full analysis"));
      assert.ok(!overview.includes("shaded") && overview.length < 30);
    }
});

test("after the unmatched proof arrives, the unrelated scanning band stops and only its yellow locator remains", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    scene = prepared.scenes[2];
  const approaching = canvasContext(),
    settled = canvasContext();
  renderFindingsFrame(approaching, prepared, scene.start + 3.5);
  renderFindingsFrame(settled, prepared, scene.start + 6);
  assert.ok(
    approaching.log.some(([key, x, y, w]) => key === "rect" && w === 104),
  );
  assert.ok(!settled.log.some(([key, x, y, w]) => key === "rect" && w === 104));
  assert.equal(
    findingsFrame(prepared, scene.start + 6).scanTime,
    scene.binding.focus.time_s,
  );
  assert.equal(
    findingsFrame(prepared, scene.start + 9).scanTime,
    scene.binding.focus.time_s,
  );
});

for (const reducedMotion of [false, true]) {
  test(
    "legacy marker-unavailable scope never invents circles or a locator; reduced=" +
      reducedMotion,
    async () => {
      const f = findingsFixture();
      f.plan.scenes = f.plan.scenes.filter((s) => s.kind !== "candidate_focus");
      for (const p of Object.values(f.payloads)) delete p.candidate_evidence;
      const prepared = await prepareFindings(f),
        beat = prepared.scenes[0].beats.at(-1).settled;
      const frame = findingsFrame(prepared, beat, { reducedMotion }),
        ctx = canvasContext();
      assert.equal(frame.markerState, "unavailable");
      assert.equal(frame.scanTime, null);
      assert.equal(frame.locatorTime, null);
      assert.match(frame.guide.headline, /unavailable/);
      assert.ok(!frame.guide.headline.includes("Circles"));
      renderFindingsFrame(ctx, prepared, beat, { reducedMotion });
      assert.ok(!ctx.log.some(([key]) => key === "arc"));
      assert.ok(
        drawnLabels(ctx).some((s) =>
          s.includes("Candidate markers unavailable"),
        ),
      );
    },
  );
  test(
    "present empty annotations differ from unavailable markers; reduced=" +
      reducedMotion,
    async () => {
      const f = findingsFixture();
      f.plan.scenes = f.plan.scenes.filter((s) => s.kind !== "candidate_focus");
      for (const [id, payload] of Object.entries(f.payloads)) {
        payload.candidate_evidence.reference_indices = [];
        for (const method of ["unchanged", "median", "highpass"]) {
          payload.candidate_evidence.methods[method] = {
            candidate_indices: [],
            pairs: [],
          };
          const summary = f.job.result.evidence[id].metrics[method];
          Object.assign(summary, {
            comparator_count: 0,
            candidate_count: 0,
            matched_count: 0,
            unmatched_comparator_count: 0,
            unmatched_candidate_count: 0,
            mean_absolute_shift_ms: null,
            maximum_absolute_shift_ms: null,
          });
          const { comparator_count, unmatched_comparator_count, ...rest } =
            summary;
          Object.assign(payload.result.metrics[method], rest, {
            reference_count: comparator_count,
            unmatched_reference_count: unmatched_comparator_count,
          });
        }
        updateToyMetric(f, id, f.job.result.evidence[id].metrics.highpass);
      }
      const prepared = await prepareFindings(f),
        beat = prepared.scenes[0].beats.at(-1).settled;
      const frame = findingsFrame(prepared, beat, { reducedMotion }),
        ctx = canvasContext();
      assert.equal(frame.markerState, "empty");
      assert.equal(frame.scanTime, null);
      assert.equal(frame.locatorTime, null);
      assert.match(frame.guide.headline, /No detector candidates/);
      assert.ok(!frame.guide.headline.includes("unavailable"));
      renderFindingsFrame(ctx, prepared, beat, { reducedMotion });
      assert.ok(!ctx.log.some(([key]) => key === "arc"));
    },
  );
}

test("one shared processed lane overlays only tested outputs while actual scan stamps candidates", async () => {
  const f = findingsFixture(),
    original = JSON.stringify(f.plan),
    prepared = await prepareFindings(f),
    s = prepared.scenes[1];
  const early = canvasContext(),
    late = canvasContext();
  renderFindingsFrame(early, prepared, s.start + 7.05);
  renderFindingsFrame(late, prepared, s.start + 10.5);
  assert.equal(
    drawnLabels(late).filter((v) => v.startsWith("Tested outputs")).length,
    1,
  );
  assert.ok(drawnLabels(late).some((v) => v.includes("Dashed High-pass")));
  assert.ok(
    late.log.filter(([key]) => key === "arc").length >
      early.log.filter(([key]) => key === "arc").length,
  );
  assert.equal(JSON.stringify(f.plan), original);
  const motion = findingsFrame(prepared, s.start + 3);
  assert.ok(motion.followupReveal > 0 && motion.followupReveal < 1);
  assert.equal(motion.settingSide, "followup");
});

test("only a real saved pair connects; the unmatched candidate remains unlinked as the reading cursor moves", async () => {
  const prepared = await prepareFindings(findingsFixture()),
    scene = prepared.scenes[2];
  const pairFrame = findingsFrame(prepared, scene.start + 0.8);
  assert.deepEqual(pairFrame.matchPair, {
    reference_index: 5,
    candidate_index: 5,
  });
  assert.ok(pairFrame.matchLinkProgress > 0);
  assert.ok(
    scene.plot.candidate_evidence.methods.highpass.pairs.some(
      ([a, b]) =>
        a === pairFrame.matchPair.reference_index &&
        b === pairFrame.matchPair.candidate_index,
    ),
  );
  const target = scene.binding.focus.sample_index;
  assert.ok(
    !scene.plot.candidate_evidence.methods.highpass.pairs.some(
      ([, b]) => b === target,
    ),
  );
  const unmatched = findingsFrame(prepared, scene.start + 4);
  assert.equal(unmatched.matchLinkProgress, 0);
  assert.equal(unmatched.locatorTime, scene.plot.times[target]);
  const moving = [2.3, 3.2, 4.3].map(
    (at) => findingsFrame(prepared, scene.start + at).scanIndex,
  );
  assert.ok(new Set(moving).size > 1);
  assert.ok(
    [5, 6, 7, 8, 9].every(
      (at) => findingsFrame(prepared, scene.start + at).scanIndex === target,
    ),
  );
  assert.ok(
    moving.every(
      (i) =>
        Number.isInteger(i) &&
        scene.plot.times[i] >= scene.view.start_s &&
        scene.plot.times[i] < scene.view.end_s,
    ),
  );
});

test("native context path retains every sample and gaps, reuses across moving views, and evicts resized assets", async () => {
  const before = globalThis.Path2D,
    paths = [];
  class Path {
    constructor() {
      this.commands = [];
      paths.push(this);
    }
    moveTo(...args) {
      this.commands.push(["moveTo", ...args]);
    }
    lineTo(...args) {
      this.commands.push(["lineTo", ...args]);
    }
  }
  globalThis.Path2D = Path;
  try {
    const f = findingsFixture();
    for (const payload of Object.values(f.payloads))
      payload.result.plot.times[7] = 7.9;
    const prepared = await prepareFindings(f),
      ctx = canvasContext();
    for (let i = 0; i < 40; i++)
      renderFindingsFrame(ctx, prepared, (i / 40) * prepared.duration);
    assert.equal(paths.length, 1);
    assert.equal(paths[0].commands.length, 8);
    assert.equal(
      paths[0].commands.at(-1)[0],
      "moveTo",
      "the genuine timestamp gap remains disconnected",
    );
    for (let i = 0; i < 9; i++)
      renderFindingsFrame(ctx, prepared, 5, {
        width: 350 + i * 5,
        height: 720,
        layout: "compact",
        logicalWidth: 350 + i * 5,
        logicalHeight: 720,
      });
    const count = paths.length;
    renderFindingsFrame(ctx, prepared, 5, {
      width: 350,
      height: 720,
      layout: "compact",
      logicalWidth: 350,
      logicalHeight: 720,
    });
    assert.equal(
      paths.length,
      count + 1,
      "the oldest width was evicted from the eight-asset cache",
    );
  } finally {
    if (before === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = before;
  }
});

test("export renders one capture surface per tick and releases a final-frame cancellation timer", async () => {
  const f = playerFixture();
  await f.ui.ready;
  const win = f.dom.window;
  let tick,
    now = 0,
    stops = 0,
    tracks = 0;
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      stops++;
      this.state = "inactive";
      this.onstop?.();
    }
  }
  Object.defineProperty(win, "MediaRecorder", { value: Recorder });
  Object.defineProperty(win.performance, "now", { value: () => now });
  win.setInterval = (fn) => {
    tick = fn;
    return 1;
  };
  win.clearInterval = () => {};
  f.exportCanvas.captureStream = (fps) => {
    assert.equal(fps, 24);
    return {
      getTracks: () => [
        {
          stop() {
            tracks++;
          },
        },
      ],
    };
  };
  f.context.log.length = 0;
  const promise = f.ui.exportVideo();
  f.exportContext.log.length = 0;
  now = 1000;
  tick();
  assert.equal(
    f.context.log.length,
    0,
    "paused responsive canvas is not rendered again during capture",
  );
  assert.ok(f.exportContext.log.some(([key]) => key === "stroke"));
  assert.match(
    f.container.querySelector(".findings-export").textContent,
    /playback is paused/,
  );
  now = 50000;
  tick();
  assert.equal(stops, 0, "final picture is drawn before recorder stop");
  f.ui.cancelExport();
  assert.equal((await promise).status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stops, 1);
  assert.equal(tracks, 1);
  f.ui.destroy();
  win.close();
});

test("plot gaps and exclusions never join signal samples or become repaired measurements", async () => {
  const f = findingsFixture();
  for (const id of ["e2", "e3"]) {
    const p = f.payloads[id],
      e = f.job.result.evidence[id];
    p.result.plot.times = [0, 1, 2, 3, 4, 5, 6, 7.9];
    p.result.plot.raw[7] = null;
    p.result.plot.unchanged[7] = null;
    p.result.plot.median[7] = null;
    p.result.plot.highpass[7] = null;
    p.result.plot.valid_mask[7] = false;
    p.result.exclusions.valid_count = 7;
    p.result.exclusions.excluded_fraction = 0.125;
    p.result.exclusions.valid_intervals_indices = [[0, 7]];
    e.valid_count = 7;
    e.excluded_fraction = 0.125;
    p.candidate_evidence.valid_intervals_indices = [[0, 7]];
  }
  const prepared = await prepareFindings(f),
    ctx = canvasContext();
  renderFindingsFrame(ctx, prepared, 8.4);
  assert.ok(ctx.log.some(([key]) => key === "fillRect"));
  for (const args of ctx.log)
    assert.ok(args.every((v) => typeof v !== "number" || Number.isFinite(v)));
  assert.equal(prepared.scenes[2].plot.raw[7], null);
  assert.equal(prepared.scenes[2].plot.times[7], 7.9);
});
test("player starts paused, keyboard-native seek and evidence actions work, reduced motion steps into settled pictures", async () => {
  const calls = [],
    f = playerFixture({
      reducedMotion: true,
      onEvidence: (id) => calls.push(id),
    });
  assert.equal((await f.ui.ready).status, "ready");
  assert.equal(f.ui.getState().playing, false);
  f.ui.play();
  assert.equal(f.ui.getState().playing, false);
  assert.equal(
    findingsFrame(await prepareFindings(f), f.ui.getState().time).scene.id,
    "scope",
  );
  const slider = f.container.querySelector('input[type="range"]');
  slider.value = "11";
  slider.dispatchEvent(new f.dom.window.Event("input"));
  assert.equal(f.ui.getState().time, 11);
  [...f.container.querySelectorAll("button")]
    .find((b) => b.textContent === "Inspect this evidence")
    .click();
  assert.deepEqual(calls, ["e3"]);
  assert.match(
    f.container.querySelector("details").textContent,
    /Unverified Meta interpretation/,
  );
  f.ui.destroy();
  assert.equal(f.container.childElementCount, 0);
  f.dom.window.close();
  const timedPlan = findingsFixture().plan;
  timedPlan.scenes[2].kind = "metrics";
  timedPlan.scenes[2].focus = "full_window";
  timedPlan.scenes[2].binding.focus = null;
  const timed = playerFixture({ plan: timedPlan });
  await timed.ui.ready;
  const exactDuration = timed.ui.getState().duration;
  assert.equal(exactDuration, 29.400000000000002);
  assert.equal(
    timed.container.querySelector("output").textContent,
    "0 / 29.4 s",
  );
  assert.equal(
    timed.container.querySelector('input[type="range"]').max,
    String(exactDuration),
  );
  timed.ui.seek(4.26);
  assert.equal(timed.ui.getState().time, 4.26);
  assert.equal(
    timed.container.querySelector("output").textContent,
    "4.3 / 29.4 s",
  );
  timed.ui.seek(exactDuration);
  assert.equal(timed.ui.getState().time, exactDuration);
  assert.equal(
    timed.container.querySelector("output").textContent,
    "29.4 / 29.4 s",
  );
  timed.ui.destroy();
  timed.dom.window.close();
});
test("no supported finding, invalid plan, and failed or missing evidence leave a report fallback", async () => {
  const f = findingsFixture();
  f.plan.scenes = [
    f.plan.scenes[0],
    structuredClone(f.plan.scenes[3]),
    f.plan.scenes[3],
  ];
  f.plan.scenes[1].id = "limit-extra";
  let loads = 0;
  const dom = new JSDOM("<main></main>"),
    container = dom.window.document.querySelector("main"),
    ui = mountFindings(container, {
      ...f,
      context: canvasContext(),
      loadComparison: async () => {
        loads++;
        throw new Error();
      },
    });
  assert.equal((await ui.ready).status, "no_findings");
  assert.equal(loads, 0);
  assert.match(container.textContent, /No supported visual finding/);
  ui.destroy();
  const invalid = playerFixture({ plan: { schema: "wrong" } });
  assert.equal((await invalid.ui.ready).status, "invalid");
  assert.equal(invalid.container.querySelector("canvas").hidden, true);
  invalid.ui.destroy();
  invalid.dom.window.close();
  const missing = playerFixture({
    loadComparison: async () => {
      throw new Error("not retained");
    },
  });
  assert.equal((await missing.ui.ready).status, "invalid");
  missing.ui.destroy();
  missing.dom.window.close();
  dom.window.close();
});
test("empty evidence supports the server's two-scene no-finding plan", async () => {
  const f = findingsFixture();
  f.job.result.evidence = {};
  f.plan.scenes = [f.plan.scenes[0], f.plan.scenes[3]];
  const prepared = await prepareFindings(f);
  assert.equal(prepared.status, "no_findings");
});
test("destroy aborts loading and ignores a late comparison without repopulating a changed source", async () => {
  const pending = [],
    states = [];
  const f = playerFixture({
    loadComparison: (id, { signal }) =>
      new Promise((resolve) => pending.push({ id, signal, resolve })),
    onState: (s) => states.push(s),
  });
  f.ui.destroy();
  assert.ok(pending.every((p) => p.signal.aborted));
  f.container.textContent = "Different source";
  for (const p of pending) p.resolve(f.payloads[p.id]);
  assert.equal((await f.ui.ready).status, "destroyed");
  assert.equal(f.container.textContent, "Different source");
  assert.deepEqual(states, []);
  f.dom.window.close();
});
test("video export reports unsupported APIs honestly", async () => {
  const f = playerFixture();
  await f.ui.ready;
  assert.equal((await f.ui.exportVideo()).status, "unavailable");
  assert.match(f.container.textContent, /Video export is unavailable/);
  f.ui.destroy();
  f.dom.window.close();
});
test("successful mocked recording returns an honestly named WebM and releases download URLs on destroy", async () => {
  let interval,
    now = 0,
    stopped = 0,
    revoked = 0,
    recordedMime;
  const f = playerFixture();
  await f.ui.ready;
  const win = f.dom.window;
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor(stream, options) {
      this.state = "inactive";
      recordedMime = options.mimeType;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new win.Blob(["mocked recording bytes"], { type: recordedMime }),
      });
      this.onstop?.();
    }
  }
  // This checks export plumbing with a mock, not media decoding or visual quality.
  Object.defineProperty(win, "MediaRecorder", { value: Recorder });
  Object.defineProperty(win.performance, "now", { value: () => now });
  win.setInterval = (callback) => {
    interval = callback;
    return 4;
  };
  win.clearInterval = () => {};
  win.URL.createObjectURL = () => "blob:mocked-video";
  win.URL.revokeObjectURL = () => {
    revoked++;
  };
  const viewport = f.container.querySelector(".findings-picture-viewport");
  viewport.getBoundingClientRect = () => ({ width: 350 });
  win.dispatchEvent(new win.Event("resize"));
  assert.equal(f.container.querySelector("canvas").width, 350);
  f.exportCanvas.captureStream = () => ({
    getTracks: () => [
      {
        stop() {
          stopped++;
        },
      },
    ],
  });
  f.container.style.setProperty("--plot-bg", "#161b22");
  const promise = f.ui.exportVideo();
  assert.equal(f.exportCanvas.width, 1280);
  assert.equal(f.exportCanvas.height, 720);
  viewport.getBoundingClientRect = () => ({ width: 420 });
  win.dispatchEvent(new win.Event("resize"));
  assert.equal(f.container.querySelector("canvas").width, 420);
  assert.equal(f.exportCanvas.width, 1280);
  assert.equal(f.exportCanvas.height, 720);
  f.container.style.setProperty("--plot-bg", "#ffffff");
  win.document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  f.exportContext.log.length = 0;
  now = 50000;
  interval();
  const result = await promise;
  assert.equal(result.status, "completed");
  assert.ok(result.blob.size > 0);
  assert.equal(result.blob.type, "video/webm;codecs=vp9");
  assert.equal(
    f.container.querySelector("a").download,
    "signaltrace-findings-j.webm",
  );
  assert.equal(stopped, 1);
  assert.ok(
    f.exportContext.log.some(
      ([k, x, y, w, h]) => k === "fillRect" && w === 1280 && h === 720,
    ),
  );
  assert.deepEqual(
    f.exportContext.log.find(([k]) => k === "fillStyle"),
    ["fillStyle", "#161b22"],
    "export keeps its admission palette after the live player changes theme",
  );
  assert.ok(
    f.exportContext.log.some(
      ([k, x, y]) => k === "scale" && x === 1 && y === 1,
    ),
  );
  f.ui.destroy();
  assert.equal(revoked, 1);
  win.close();
});
test("media-recorder asynchronous error and object URL failure stop tracks and restore playback", async () => {
  for (const failure of ["recorder", "url"]) {
    let instance,
      interval,
      now = 0,
      stopped = 0;
    const f = playerFixture();
    await f.ui.ready;
    const win = f.dom.window;
    class Recorder {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        instance = this;
        this.state = "inactive";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new win.Blob(["mock"]) });
        this.onstop?.();
      }
    }
    Object.defineProperty(win, "MediaRecorder", { value: Recorder });
    Object.defineProperty(win.performance, "now", { value: () => now });
    win.setInterval = (fn) => {
      interval = fn;
      return 1;
    };
    win.clearInterval = () => {};
    win.URL.createObjectURL = () => {
      throw new Error("URL unavailable");
    };
    f.exportCanvas.captureStream = () => ({
      getTracks: () => [
        {
          stop() {
            stopped++;
          },
        },
      ],
    });
    const promise = f.ui.exportVideo();
    if (failure === "recorder") instance.onerror();
    else {
      now = 50000;
      interval();
    }
    assert.equal((await promise).status, "failed");
    assert.equal(stopped, 1);
    assert.equal(f.ui.getState().exporting, false);
    f.ui.destroy();
    win.close();
  }
});
test("visibility changes pause playback and cancel export instead of silently producing a truncated hidden-tab movie", async () => {
  const f = playerFixture();
  await f.ui.ready;
  f.ui.play();
  assert.equal(f.ui.getState().playing, true);
  Object.defineProperty(f.dom.window.document, "hidden", {
    value: true,
    configurable: true,
  });
  f.dom.window.document.dispatchEvent(
    new f.dom.window.Event("visibilitychange"),
  );
  assert.equal(f.ui.getState().playing, false);
  assert.equal((await f.ui.exportVideo()).status, "unavailable");
  assert.match(f.container.textContent, /Keep this tab visible/);
  f.ui.destroy();
  f.dom.window.close();
});
test("live reduced-motion preference settles the picture and listener teardown is complete", async () => {
  const f = findingsFixture(),
    dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  let listener,
    removed = 0;
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener(type, callback) {
      listener = callback;
    },
    removeEventListener(type, callback) {
      assert.equal(callback, listener);
      removed++;
    },
  });
  const ui = mountFindings(dom.window.document.querySelector("main"), {
    ...f,
    context: canvasContext(),
  });
  await ui.ready;
  ui.play();
  assert.equal(ui.getState().playing, true);
  listener({ matches: true });
  assert.equal(ui.getState().playing, false);
  assert.equal(ui.getState().reducedMotion, true);
  ui.destroy();
  assert.equal(ui.getState().status, "destroyed");
  assert.equal(removed, 1);
  dom.window.close();
});
test("imported historical explanation is marked as historical in both player provenance and detached report", async () => {
  const f = findingsFixture();
  f.plan.provenance = { kind: "imported_historical_explanation" };
  const doc = new JSDOM("<main></main>");
  const ui = mountFindings(doc.window.document.querySelector("main"), {
    ...f,
    context: canvasContext(),
  });
  await ui.ready;
  assert.match(
    doc.window.document.querySelector("details").textContent,
    /Imported historical explanation/,
  );
  const attached = attachExplanationReport(makeInvestigationReport(f), f.plan);
  assert.equal(attached.explanation.historical_import, true);
  ui.destroy();
  doc.window.close();
});
test("video cancellation and constructor failure release all capture tracks and restore playback", async () => {
  for (const fails of [false, true]) {
    let stopped = 0,
      recorderStopped = 0;
    class Recorder {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        if (fails) throw new Error("unsupported capture");
        this.state = "inactive";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        recorderStopped++;
        this.onstop?.();
      }
    }
    const f = playerFixture({ MediaRecorder: Recorder });
    await f.ui.ready;
    f.exportCanvas.captureStream = () => ({
      getTracks: () => [
        {
          stop() {
            stopped++;
          },
        },
      ],
    });
    const result = f.ui.exportVideo();
    if (!fails) f.ui.cancelExport();
    assert.equal((await result).status, fails ? "failed" : "cancelled");
    assert.equal(stopped, 1);
    assert.equal(f.ui.getState().exporting, false);
    assert.equal(
      f.container.querySelector('input[type="range"]').disabled,
      false,
    );
    if (!fails) assert.equal(recorderStopped, 1);
    f.ui.destroy();
    f.dom.window.close();
  }
});
test("destroy cancels an active export and does not leak track or download URL", async () => {
  let stopped = 0;
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }
  const f = playerFixture({ MediaRecorder: Recorder });
  await f.ui.ready;
  f.exportCanvas.captureStream = () => ({
    getTracks: () => [
      {
        stop() {
          stopped++;
        },
      },
    ],
  });
  const promise = f.ui.exportVideo();
  f.ui.destroy();
  assert.equal((await promise).status, "cancelled");
  assert.equal(stopped, 1);
  assert.equal(f.container.childElementCount, 0);
  f.dom.window.close();
});
test("separate retrospective explanation attaches to static report without changing original narrative, numbers or script-free CSP", () => {
  const f = findingsFixture(),
    snapshot = makeInvestigationReport(f),
    before = JSON.stringify(snapshot),
    report = attachExplanationReport(snapshot, f.plan);
  assert.equal(report.proposal, snapshot.proposal);
  assert.deepEqual(report.comparisons, snapshot.comparisons);
  assert.equal(JSON.stringify(snapshot), before);
  const dom = new JSDOM(),
    doc = new JSDOM(reportHTML(report, dom.window.document)).window.document;
  assert.match(
    doc.querySelector(".retrospective-explanation").textContent,
    /later explanation.*unverified/,
  );
  assert.match(doc.body.textContent, /Recorded rationale stays unchanged/);
  assert.equal(
    doc.querySelectorAll("script,link,iframe,video,canvas").length,
    0,
  );
  assert.match(
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    /script-src 'none'/,
  );
  for (const link of doc.querySelectorAll(".retrospective-explanation a"))
    assert.ok(doc.querySelector(link.getAttribute("href")));
  renderReportPreview(dom.window.document.body, report);
  const preview = dom.window.document.querySelector(
    ".retrospective-explanation a",
  );
  preview.click();
  assert.equal(
    dom.window.document.querySelector(preview.getAttribute("href")).hidden,
    false,
  );
  for (const alter of [
    (p) => (p.evidence_digest = "old"),
    (p) => (p.scenes[1].binding.metrics.unmatched_candidate_count = 99),
    (p) => (p.scenes[1].binding.parameters.highpass_hz = 99),
    (p) => (p.scenes[2].evidence_ids = ["other"]),
    (p) => (p.investigation_id = "old"),
  ]) {
    const p = structuredClone(f.plan);
    alter(p);
    assert.throws(() => attachExplanationReport(snapshot, p));
  }
  dom.window.close();
});
