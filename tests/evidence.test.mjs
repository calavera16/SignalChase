import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  mountEvidence,
  validatedPlot,
  waveformExcerpt,
  renderWaveformExcerpt,
} from "../signaltrace/web/evidence.js";
import {
  makeManualReport,
  attachComparisonPlot,
  selectReportMethod,
  reportHTML,
  renderInvestigationFinding,
  renderReportPreview,
} from "../signaltrace/web/report.js";

function fixture() {
  const metric = {
    reference_count: 2,
    candidate_count: 2,
    matched_count: 2,
    unmatched_reference_count: 0,
    unmatched_candidate_count: 0,
    mean_absolute_shift_ms: 0,
    maximum_absolute_shift_ms: null,
    centered_normalized_rmse: 0.002,
  };
  const result = {
    id: "a",
    recording_id: "r",
    experiment_id: "x",
    channel: "ppg",
    goal: "pulse_timing",
    comparison: "original",
    window: { start_s: 0, end_s: 10 },
    parameters: { median_window_s: 2, highpass_hz: 0.35, edge_guard_s: 3 },
    metrics: Object.fromEntries(
      ["unchanged", "median", "highpass"].map((m) => [m, { ...metric }]),
    ),
    exclusions: {
      sample_count: 5,
      valid_count: 3,
      excluded_fraction: 0.4,
      nonfinite_count: 0,
      flatline_count: 0,
      gap_after_indices: [],
      valid_intervals_indices: [[1, 4]],
      too_short_segments: [],
    },
    plot: {
      times: [0, 1, 2, 8, 9],
      raw: [0, 1, 0, 2, 0],
      unchanged: [null, 1, 0, 2, null],
      median: [null, 0.5, -0.5, 1.5, null],
      highpass: [null, 0.3, -0.3, 0.8, null],
      valid_mask: [false, true, true, true, false],
    },
  };
  const snapshot = makeManualReport({
    recording: { id: "r", name: "Local", modality: "ppg" },
    experiment: {
      id: "x",
      recording_id: "r",
      protocol: { target: "pulse_timing", evaluation: "original_sensitivity" },
    },
    result,
  });
  const payload = {
    recording_id: "r",
    experiment_id: "x",
    channel: "ppg",
    target: "pulse_timing",
    comparison_id: "a",
    unit: "a.u.",
    result,
  };
  return { result, snapshot, payload };
}
test("plot attachment requires identity, exact window, parameters, metrics, exclusions and bounded samples", () => {
  const f = fixture();
  for (const mutate of [
    (p) => (p.recording_id = "stale"),
    (p) => (p.result.window.end_s = 11),
    (p) => (p.result.parameters.edge_guard_s = 4),
    (p) => (p.result.metrics.median.mean_absolute_shift_ms = 1),
    (p) => (p.result.exclusions.valid_count = 2),
    (p) => (p.result.plot.times[2] = 1),
    (p) => (p.result.plot.median[1] = "<script>"),
    (p) => (p.result.plot.valid_mask[0] = 1),
    (p) => (p.result.plot.times = Array(30001).fill(1)),
  ]) {
    const p = structuredClone(f.payload);
    mutate(p);
    assert.throws(() => validatedPlot(f.snapshot, p));
  }
  const attached = attachComparisonPlot(f.snapshot, f.payload);
  assert.ok(Object.isFrozen(attached.comparisons[0].plot.raw));
  f.result.plot.raw[1] = 999;
  assert.equal(attached.comparisons[0].plot.raw[1], 1);
});
test("method, zoom, actual sample and task table remain connected without changing full-window metrics", () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>"),
    c = dom.window.document.querySelector("main");
  const plot = validatedPlot(f.snapshot, f.payload),
    before = JSON.stringify(f);
  const ui = mountEvidence(c, {
    snapshot: f.snapshot,
    comparison: f.snapshot.comparisons[0],
    plot,
  });
  const button = (name) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === name);
  const ticks = [...c.querySelectorAll(".chart text")].map(
    (n) => n.textContent,
  );
  button("High-pass").click();
  assert.equal(button("High-pass").getAttribute("aria-pressed"), "true");
  assert.match(
    c.querySelector('[aria-current="true"]').textContent,
    /High-pass/,
  );
  assert.deepEqual(
    [...c.querySelectorAll(".chart text")].map((n) => n.textContent),
    ticks,
  );
  const slider = c.querySelector('input[type="range"]');
  slider.value = "1";
  slider.dispatchEvent(new dom.window.Event("input"));
  assert.match(
    c.querySelector("output").textContent,
    /Sample 1 · 1 s.*High-pass 0.3.*included/,
  );
  slider.value = "0";
  slider.dispatchEvent(new dom.window.Event("input"));
  assert.match(c.querySelector("output").textContent, /excluded/);
  button("Zoom in").click();
  assert.equal(slider.disabled, true);
  assert.match(c.querySelector("output").textContent, /No measured samples/);
  assert.match(c.querySelector("caption").textContent, /Full analysis window/);
  button("Full analysis window").click();
  assert.equal(slider.disabled, false);
  assert.match(c.querySelector("tbody").textContent, /not available/);
  assert.match(c.querySelectorAll("thead th")[1].textContent, /Mean timing/);
  assert.equal(JSON.stringify(f), before);
  ui.destroy();
  assert.equal(c.childElementCount, 0);
});
test("waveform target leads with shape; Meta proposal stays distinct from displayed method", () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>"),
    c = dom.window.document.querySelector("main");
  const snapshot = {
    ...f.snapshot,
    target: "waveform_sensitivity",
    candidate: { comparison_id: "a", method: "median" },
  };
  const ui = mountEvidence(c, {
    snapshot,
    comparison: snapshot.comparisons[0],
    plot: validatedPlot(f.snapshot, f.payload),
  });
  assert.match(
    c.querySelectorAll("thead th")[1].textContent,
    /Normalized waveform/,
  );
  [...c.querySelectorAll("button")]
    .find((b) => b.textContent === "High-pass")
    .click();
  assert.match(
    c.querySelector(".meta-proposal").textContent,
    /Median subtraction · Meta proposal/,
  );
  assert.match(c.querySelector(".displayed-method").textContent, /High-pass/);
  ui.destroy();
});
test("motion preference changes cancel animation and destroy removes external listeners", () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>"),
    c = dom.window.document.querySelector("main");
  let listener,
    removed = false,
    starts = 0,
    cancels = 0;
  const motion = {
    matches: false,
    addEventListener(_, fn) {
      listener = fn;
    },
    removeEventListener(_, fn) {
      removed = fn === listener;
    },
  };
  dom.window.matchMedia = () => motion;
  dom.window.HTMLElement.prototype.animate = () => {
    starts++;
    return {
      cancel() {
        cancels++;
      },
    };
  };
  const ui = mountEvidence(c, {
    snapshot: f.snapshot,
    comparison: f.snapshot.comparisons[0],
    plot: validatedPlot(f.snapshot, f.payload),
  });
  assert.equal(starts, 1);
  motion.matches = true;
  listener();
  assert.equal(cancels, 1);
  c.querySelector("button").click();
  assert.equal(starts, 1);
  ui.destroy();
  assert.ok(removed);
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  assert.equal(starts, 1);
});
test("standalone report uses full-window safe SVG and semantic table without raw JSON or active resources", () => {
  const f = fixture(),
    dom = new JSDOM();
  f.payload.unit = "<img src=x onerror=alert(1)>";
  const attached = attachComparisonPlot(f.snapshot, f.payload),
    html = reportHTML(attached, dom.window.document),
    output = new JSDOM(html).window.document;
  assert.equal(output.querySelectorAll("svg").length, 1);
  assert.equal(output.querySelectorAll("table").length, 1);
  assert.equal(output.querySelectorAll("script,img,iframe,form").length, 0);
  assert.match(
    output.querySelector("figcaption").textContent,
    /Original \(grey\).*\[0, 10\)/,
  );
  assert.match(
    output.querySelector('[http-equiv="Content-Security-Policy"]').content,
    /script-src 'none'/,
  );
  assert.ok(!html.includes('"valid_mask":'));
  assert.ok(!html.includes('"raw":'));
});

test("Graph and Measurements lead while secondary evidence tools remain explicitly reachable", () => {
  const f = fixture(),
    doc = new JSDOM("<main id='evidence-test'></main>").window.document;
  const c = doc.querySelector("main");
  const ui = mountEvidence(c, {
    snapshot: f.snapshot,
    comparison: f.snapshot.comparisons[0],
    plot: validatedPlot(f.snapshot, f.payload),
  });
  const nav = c.querySelector('[aria-label="Evidence views"]');
  assert.deepEqual(
    [...nav.querySelectorAll("button")].map((b) => b.textContent),
    ["Graph", "Measurements", "More evidence tools"],
  );
  const more = nav.querySelector("button:last-child"),
    tools = doc.getElementById(more.getAttribute("aria-controls"));
  assert.equal(tools.hidden, true);
  more.click();
  assert.equal(tools.hidden, false);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  const scope = [...tools.querySelectorAll("button")].find(
    (b) => b.textContent === "Scope & exclusions",
  );
  scope.click();
  assert.equal(scope.getAttribute("aria-pressed"), "true");
  nav.querySelector("button").click();
  assert.equal(c.querySelector(".evidence-graph-view").hidden, false);
  assert.match(
    c.querySelector(".evidence-graph-scope").textContent,
    /samples valid.*Display/,
  );
  assert.equal(
    c.querySelectorAll('.evidence-methods button[aria-pressed="true"]').length,
    1,
  );
  ui.destroy();
});

function annotatedFixture(synthetic = false) {
  const f = fixture(),
    n = 100,
    times = Array.from({ length: n }, (_, i) => i / 10);
  const detector = {
    median_window_s: 2,
    highpass_hz: 0.35,
    highpass_order: 2,
    edge_guard_s: 3,
    minimum_interior_s: 1,
    flatline_s: 0.25,
    peak_distance_s: 0.4,
    prominence_fraction: 0.15,
    match_tolerance_s: 0.15,
    gap_factor: 1.5,
    regularity_tolerance: 0.02,
  };
  Object.assign(f.result.exclusions, {
    sample_count: n,
    valid_count: 98,
    excluded_fraction: 0.02,
    valid_intervals_indices: [[1, 99]],
    parameters: detector,
  });
  f.result.plot = {
    times,
    valid_mask: times.map((_, i) => i > 0 && i < 99),
    raw: times.map((t) => 10 + Math.sin(t)),
    unchanged: times.map((t) => 10 + Math.sin(t)),
    median: times.map((t) => Math.sin(t)),
    highpass: times.map((t) => Math.sin(t) * 0.8),
    reference: synthetic ? times.map((t) => Math.cos(t)) : null,
  };
  f.result.comparison = synthetic ? "synthetic_reference" : "original";
  const a = {
    schema: "signaltrace.candidate-evidence.v1",
    comparison_id: "a",
    comparator: f.result.comparison,
    sample_count: n,
    window: { ...f.result.window },
    parameters: { ...f.result.parameters },
    detector: { ...detector },
    valid_intervals_indices: [[1, 99]],
    reference_indices: [20, 40, 60, 80],
    methods: {},
  };
  for (const method of ["unchanged", "median", "highpass"]) {
    const candidates =
      method === "median" ? [20, 40, 60, 65, 80] : [20, 40, 60, 80];
    a.methods[method] = {
      candidate_indices: candidates,
      pairs: [20, 40, 60, 80].map((i) => [i, i]),
    };
    f.result.metrics[method] = {
      ...f.result.metrics[method],
      reference_count: 4,
      candidate_count: candidates.length,
      matched_count: 4,
      unmatched_reference_count: 0,
      unmatched_candidate_count: candidates.length - 4,
      mean_absolute_shift_ms: 0,
      maximum_absolute_shift_ms: 0,
    };
  }
  f.snapshot = makeManualReport({
    recording: { id: "r", name: "Toy", modality: "ppg" },
    experiment: {
      id: "x",
      recording_id: "r",
      protocol: {
        target: "pulse_timing",
        evaluation: synthetic ? "synthetic_reference" : "original_sensitivity",
      },
    },
    result: f.result,
  });
  f.payload.candidate_evidence = a;
  return f;
}
test("candidate annotations bind detector, support, identity, counts and timing without discarding valid plots", () => {
  const f = annotatedFixture(),
    before = JSON.stringify(f);
  const attached = attachComparisonPlot(f.snapshot, f.payload),
    plot = attached.comparisons[0].plot;
  assert.equal(plot.candidate_evidence_status, "available");
  assert.ok(Object.isFrozen(plot.candidate_evidence.methods.median.pairs[0]));
  assert.equal(JSON.stringify(f), before);
  for (const mutate of [
    (p) => delete p.candidate_evidence,
    (p) => (p.candidate_evidence.comparison_id = "other"),
    (p) => (p.candidate_evidence.window.start_s = 1),
    (p) => (p.candidate_evidence.parameters.highpass_hz = 0.5),
    (p) => (p.candidate_evidence.comparator = "synthetic_reference"),
    (p) => (p.candidate_evidence.sample_count = 99),
    (p) => (p.candidate_evidence.detector.match_tolerance_s = 0.2),
    (p) => delete p.candidate_evidence.detector.gap_factor,
    (p) => (p.candidate_evidence.methods.median.candidate_indices[1] = 20),
    (p) => (p.candidate_evidence.methods.median.candidate_indices[0] = 0),
    (p) => (p.candidate_evidence.methods.median.candidate_indices[0] = 20.5),
    (p) => (p.candidate_evidence.methods.median.pairs[0] = [20, 65]),
    (p) => (p.candidate_evidence.methods.median.pairs[0] = [21, 20]),
    (p) => (p.candidate_evidence.methods.median.pairs[1] = [20, 40]),
    (p) => p.candidate_evidence.methods.median.pairs.reverse(),
    (p) => p.candidate_evidence.methods.median.pairs.pop(),
    (p) => (p.candidate_evidence.valid_intervals_indices = [[1, 98]]),
    (p) => (p.result.exclusions.valid_intervals_indices = [[2, 99]]),
    (p) => {
      p.result.plot.valid_mask[0] = true;
      p.result.plot.valid_mask[1] = false;
    },
    (p) => (p.result.plot.median[20] = null),
  ]) {
    const p = structuredClone(f.payload);
    mutate(p);
    const out = validatedPlot(f.snapshot, p);
    assert.equal(out.candidate_evidence, null);
    assert.deepEqual(out.times, f.result.plot.times);
  }
  const changed = structuredClone(f.payload);
  changed.result.metrics.median.maximum_absolute_shift_ms = 1;
  assert.throws(() => validatedPlot(f.snapshot, changed));
});
test("excerpt selects earliest actual unmatched candidate, crops display only and draws every measured sample and marker exactly", () => {
  const f = annotatedFixture(),
    plot = validatedPlot(f.snapshot, f.payload),
    before = JSON.stringify(plot);
  const e = waveformExcerpt(plot, "median");
  assert.equal(e.target, 65);
  assert.equal(e.start, 4.5);
  assert.equal(e.end, 8.5);
  const doc = new JSDOM().window.document;
  renderWaveformExcerpt(doc.body, plot, f.snapshot.comparisons[0], "median");
  const marker = doc.querySelector(
    '[data-trace="median"][data-status="unmatched"]',
  );
  assert.equal(marker.dataset.sampleIndex, "65");
  assert.equal(marker.dataset.time, "6.5");
  assert.equal(Number(marker.dataset.value), plot.median[65]);
  assert.equal(
    Number(marker.getAttribute("x")) + 4,
    70 + ((6.5 - 4.5) / 4) * 710,
  );
  assert.equal(
    doc
      .querySelector('polyline[data-trace="median"]')
      .getAttribute("points")
      .split(" ").length,
    e.last - e.first,
  );
  assert.match(
    doc.body.textContent,
    /full analysis window.*no crop redetection or rematching/,
  );
  assert.match(doc.body.textContent, /unmatched sample 65 at 6.5 s/);
  assert.equal(doc.querySelector(".finding-waveform-viewport").tabIndex, 0);
  assert.equal(JSON.stringify(plot), before);
  const matched = waveformExcerpt(plot, "highpass");
  assert.equal(matched.target, 20);
  assert.match(matched.selection, /earliest matched/);
});
test("synthetic comparator preserves exact samples and is evaluator-only; optional markers never become invented positions", () => {
  const f = annotatedFixture(true),
    plot = validatedPlot(f.snapshot, f.payload),
    doc = new JSDOM().window.document;
  assert.deepEqual(plot.reference, f.result.plot.reference);
  renderWaveformExcerpt(doc.body, plot, f.snapshot.comparisons[0], "median");
  assert.match(doc.body.textContent, /Evaluator-only synthetic reference/);
  assert.equal(
    Number(
      doc.querySelector(
        '[data-trace="synthetic_reference"][data-sample-index="60"]',
      ).dataset.value,
    ),
    f.result.plot.reference[60],
  );
  f.payload.candidate_evidence = null;
  renderWaveformExcerpt(
    doc.body,
    validatedPlot(f.snapshot, f.payload),
    f.snapshot.comparisons[0],
    "median",
  );
  assert.match(doc.body.textContent, /Candidate markers unavailable/);
  const html = reportHTML(attachComparisonPlot(f.snapshot, f.payload), doc);
  assert.doesNotMatch(html, /<script/);
});
test("gap support forbids cross-segment pairs and crop stays within the selected interval", () => {
  const f = annotatedFixture();
  f.payload.candidate_evidence.valid_intervals_indices =
    f.result.exclusions.valid_intervals_indices = [
      [1, 45],
      [50, 99],
    ];
  for (let i = 45; i < 50; i++) f.result.plot.valid_mask[i] = false;
  f.result.exclusions.valid_count = 93;
  f.result.exclusions.excluded_fraction = 0.07;
  const original = f.snapshot;
  f.snapshot = {
    ...original,
    comparisons: [
      {
        ...original.comparisons[0],
        counts: {
          ...original.comparisons[0].counts,
          valid_count: 93,
          excluded_fraction: 0.07,
          valid_interval_count: 2,
        },
      },
    ],
  };
  const valid = validatedPlot(f.snapshot, f.payload);
  assert.ok(valid.candidate_evidence);
  const e = waveformExcerpt(valid, "median");
  assert.equal(e.start, 5);
  assert.equal(e.end, 9);
  const invalid = structuredClone(f.payload);
  invalid.candidate_evidence.detector.match_tolerance_s =
    invalid.result.exclusions.parameters.match_tolerance_s = 10;
  invalid.candidate_evidence.methods.median.pairs[1] = [40, 60];
  assert.equal(validatedPlot(f.snapshot, invalid).candidate_evidence, null);
});
test("no-candidate annotations stay honest, and dense excerpts remain bounded", () => {
  const f = annotatedFixture();
  f.payload.candidate_evidence.reference_indices = [];
  for (const m of Object.keys(f.payload.candidate_evidence.methods)) {
    f.payload.candidate_evidence.methods[m] = {
      candidate_indices: [],
      pairs: [],
    };
    Object.assign(f.result.metrics[m], {
      reference_count: 0,
      candidate_count: 0,
      matched_count: 0,
      unmatched_reference_count: 0,
      unmatched_candidate_count: 0,
      mean_absolute_shift_ms: null,
      maximum_absolute_shift_ms: null,
    });
  }
  // Rebuild only the expected retained measurement summary.
  f.snapshot = {
    ...f.snapshot,
    comparisons: [
      {
        ...f.snapshot.comparisons[0],
        methods: f.snapshot.comparisons[0].methods.map((m) => ({
          ...m,
          metrics: {
            ...m.metrics,
            comparator_count: 0,
            candidate_count: 0,
            matched_count: 0,
            unmatched_comparator_count: 0,
            unmatched_candidate_count: 0,
            mean_absolute_shift_ms: null,
            maximum_absolute_shift_ms: null,
          },
        })),
      },
    ],
  };
  const plot = validatedPlot(f.snapshot, f.payload),
    doc = new JSDOM().window.document;
  assert.ok(plot.candidate_evidence);
  assert.equal(waveformExcerpt(plot, "median"), null);
  renderWaveformExcerpt(doc.body, plot, f.snapshot.comparisons[0], "median");
  assert.match(doc.body.textContent, /no candidate/);
  assert.equal(doc.querySelector("svg"), null);
  const dense = {
    ...plot,
    times: Array.from({ length: 6000 }, (_, i) => i / 10000),
    candidate_evidence: {
      ...plot.candidate_evidence,
      valid_intervals_indices: [[0, 6000]],
      methods: { median: { candidate_indices: [2000], pairs: [] } },
    },
  };
  assert.equal(waveformExcerpt(dense, "median"), null);
});

test("actual shifted pair reproduces retained mean and maximum timing, and passive reattachment preserves selected method", () => {
  const f = annotatedFixture();
  f.payload.candidate_evidence.methods.median.candidate_indices[1] = 41;
  f.payload.candidate_evidence.methods.median.pairs[1] = [40, 41];
  const shift =
    Math.abs(f.result.plot.times[41] - f.result.plot.times[40]) * 1000;
  Object.assign(f.result.metrics.median, {
    mean_absolute_shift_ms: shift / 4,
    maximum_absolute_shift_ms: shift,
  });
  f.snapshot = {
    ...f.snapshot,
    comparisons: [
      {
        ...f.snapshot.comparisons[0],
        methods: f.snapshot.comparisons[0].methods.map((m) =>
          m.method === "median"
            ? {
                ...m,
                metrics: {
                  ...m.metrics,
                  mean_absolute_shift_ms: shift / 4,
                  maximum_absolute_shift_ms: shift,
                },
              }
            : m,
        ),
      },
    ],
  };
  let attached = attachComparisonPlot(f.snapshot, f.payload);
  assert.ok(attached.comparisons[0].plot.candidate_evidence);
  attached = selectReportMethod(attached, "a", "highpass");
  const again = attachComparisonPlot(attached, f.payload);
  assert.equal(again.comparisons[0].plot.selected_method, "highpass");
  const bad = structuredClone(f.payload);
  bad.candidate_evidence.methods.median.pairs[1] = [40, 40];
  assert.equal(validatedPlot(f.snapshot, bad).candidate_evidence, null);
  const html = reportHTML(again, new JSDOM().window.document);
  assert.match(html, /min-width:660px/);
  assert.match(html, /@media print/);
});

function annotatedPair(synthetic = false) {
  const f = annotatedFixture(synthetic),
    i = annotatedFixture(synthetic);
  i.result.id =
    i.payload.comparison_id =
    i.payload.candidate_evidence.comparison_id =
      "initial";
  i.result.parameters.highpass_hz =
    i.payload.candidate_evidence.parameters.highpass_hz =
    i.payload.candidate_evidence.detector.highpass_hz =
    i.result.exclusions.parameters.highpass_hz =
      0.2;
  i.payload.candidate_evidence.methods.median.candidate_indices = [
    20, 40, 61, 70, 80,
  ];
  i.payload.candidate_evidence.methods.median.pairs[2] = [60, 61];
  const initialShift =
    (i.result.plot.times[61] - i.result.plot.times[60]) * 1000;
  Object.assign(i.result.metrics.median, {
    mean_absolute_shift_ms: initialShift / 4,
    maximum_absolute_shift_ms: initialShift,
  });
  i.result.plot.median = i.result.plot.median.map((v) => v * 0.7);
  i.snapshot = makeManualReport({
    recording: { id: "r", name: "Toy", modality: "ppg" },
    experiment: {
      id: "x",
      recording_id: "r",
      protocol: {
        target: "pulse_timing",
        evaluation: synthetic ? "synthetic_reference" : "original_sensitivity",
      },
    },
    result: i.result,
  });
  const plot = validatedPlot(f.snapshot, f.payload),
    initialPlot = validatedPlot(i.snapshot, i.payload);
  assert.ok(initialPlot.candidate_evidence);
  return {
    plot,
    initialPlot,
    comparison: f.snapshot.comparisons[0],
    initialComparison: i.snapshot.comparisons[0],
    snapshot: f.snapshot,
  };
}

test("three exact aligned traces preserve each parent's actual values, markers and method color", () => {
  const p = annotatedPair(),
    before = JSON.stringify(p),
    doc = new JSDOM().window.document;
  renderWaveformExcerpt(doc.body, p.plot, p.comparison, "median", p);
  const lines = [...doc.querySelectorAll("polyline")];
  assert.deepEqual(
    lines.map((el) => el.dataset.role),
    ["comparator", "initial", "followup"],
  );
  assert.equal(doc.querySelector("svg").getAttribute("viewBox"), "0 0 800 475");
  assert.equal(
    lines[1].getAttribute("stroke"),
    lines[2].getAttribute("stroke"),
  );
  assert.equal(lines[1].getAttribute("stroke-dasharray"), "6 4");
  assert.equal(lines[2].getAttribute("stroke-dasharray"), "");
  const excerpt = waveformExcerpt(p.plot, "median");
  for (const [role, source, key, row] of [
    ["comparator", p.plot, "raw", 0],
    ["initial", p.initialPlot, "median", 1],
    ["followup", p.plot, "median", 2],
  ]) {
    const points = doc
      .querySelector(`polyline[data-role="${role}"]`)
      .getAttribute("points")
      .split(" ");
    assert.equal(points.length, excerpt.last - excerpt.first);
    const ys = source[key].slice(excerpt.first, excerpt.last),
      min = Math.min(...ys),
      max = Math.max(...ys),
      mag = Math.max(Math.abs(min), Math.abs(max)) || 1;
    points.forEach((point, j) => {
      const index = excerpt.first + j,
        [x, y] = point.split(",").map(Number);
      assert.equal(
        x,
        70 +
          ((source.times[index] - excerpt.start) /
            (excerpt.end - excerpt.start)) *
            710,
      );
      assert.equal(
        y,
        35 +
          row * 145 +
          95 -
          ((source[key][index] / mag - min / mag) /
            (max / mag - min / mag || 1)) *
            85,
      );
    });
  }
  assert.equal(
    doc.querySelector('[data-role="initial"][data-status="unmatched"]').dataset
      .sampleIndex,
    "70",
  );
  assert.equal(
    doc.querySelector('[data-role="followup"][data-status="unmatched"]').dataset
      .sampleIndex,
    "65",
  );
  assert.equal(
    doc.querySelector(
      '[data-role="initial"][data-status="matched"][data-sample-index="61"]',
    ).dataset.time,
    "6.1",
  );
  assert.equal(
    doc.querySelector(
      '[data-role="followup"][data-status="matched"][data-sample-index="60"]',
    ).dataset.time,
    "6",
  );
  assert.equal(JSON.stringify(p), before);
});

test("shared cursor follows nearest actual sample by pointer and exact keyboard index without changing evidence", () => {
  const p = annotatedPair(),
    before = JSON.stringify(p),
    dom = new JSDOM(),
    doc = dom.window.document;
  renderWaveformExcerpt(doc.body, p.plot, p.comparison, "median", {
    ...p,
    interactive: true,
  });
  const svg = doc.querySelector("svg"),
    slider = doc.querySelector('input[type="range"]'),
    output = doc.querySelector("output");
  assert.equal(slider.value, "65");
  assert.match(
    output.textContent,
    /Sample 65.*Initial Median subtraction.*not candidate.*Follow-up Median subtraction.*unmatched/,
  );
  assert.equal(output.getAttribute("aria-live"), "off");
  svg.getBoundingClientRect = () => ({ left: 20, width: 800 });
  const clientX = 20 + 70 + ((6.56 - 4.5) / 4) * 710;
  svg.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX }));
  assert.equal(slider.value, "66");
  assert.equal(output.getAttribute("aria-live"), "off");
  assert.equal(slider.getAttribute("aria-valuetext"), output.textContent);
  assert.equal(
    doc.querySelector('[data-cursor="shared"]').dataset.sampleIndex,
    "66",
  );
  assert.equal(
    new Set(
      [...doc.querySelectorAll("[data-cursor-role]")].map((el) =>
        el.getAttribute("cx"),
      ),
    ).size,
    1,
  );
  slider.focus();
  slider.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(slider.value, "65");
  slider.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Home", cancelable: true }),
  );
  assert.equal(slider.value, slider.min);
  slider.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "End", cancelable: true }),
  );
  assert.equal(slider.value, slider.max);
  svg.dispatchEvent(
    new dom.window.MouseEvent("pointermove", { clientX: -1000 }),
  );
  assert.equal(slider.value, slider.min);
  svg.dispatchEvent(
    new dom.window.MouseEvent("pointermove", { clientX: 2000 }),
  );
  assert.equal(slider.value, slider.max);
  assert.equal(JSON.stringify(p), before);
});

test("missing or incompatible initial attachments retain an honest annotated two-trace follow-up", () => {
  const source = annotatedPair();
  for (const mutate of [
    (p) => (p.initialPlot = null),
    (p) => (p.initialPlot.candidate_evidence = null),
    (p) => (p.initialPlot.times[55] += 0.001),
    (p) => (p.initialPlot.raw[55] += 1),
    (p) => (p.initialPlot.unchanged[55] += 1),
    (p) => (p.initialPlot.valid_mask[55] = false),
    (p) => (p.initialPlot.unit = "other"),
    (p) => (p.initialComparison.window.end_s = 11),
    (p) => (p.initialComparison.parameters.edge_guard_s = 1),
    (p) => (p.initialPlot.candidate_evidence.detector.peak_distance_s = 1),
    (p) => p.initialPlot.candidate_evidence.reference_indices.pop(),
  ]) {
    const p = structuredClone(source);
    mutate(p);
    const doc = new JSDOM().window.document;
    renderWaveformExcerpt(doc.body, p.plot, p.comparison, "median", {
      ...p,
      interactive: true,
    });
    assert.equal(doc.querySelectorAll("polyline").length, 2);
    assert.equal(doc.querySelector('polyline[data-role="initial"]'), null);
    assert.match(doc.body.textContent, /Initial trace unavailable/);
    assert.match(
      doc.querySelector("output").textContent,
      /Initial unavailable/,
    );
    assert.equal(
      doc.querySelector('[data-role="followup"][data-status="unmatched"]')
        .dataset.sampleIndex,
      "65",
    );
  }
  const p = annotatedPair(true);
  p.initialPlot.reference[55] += 1;
  const doc = new JSDOM().window.document;
  renderWaveformExcerpt(doc.body, p.plot, p.comparison, "median", p);
  assert.equal(doc.querySelectorAll("polyline").length, 2);
  assert.match(doc.body.textContent, /Evaluator-only synthetic reference/);
});

function findingPairSnapshot(p) {
  return {
    ...p.snapshot,
    kind: "investigation",
    evidence_id: "finding-toy",
    status: "inconclusive",
    comparison_trace: [
      { round: 1, tool: "compare", status: "success", evidence_id: "initial" },
      { round: 2, tool: "compare", status: "success", evidence_id: "a" },
    ],
    comparisons: [
      { ...p.initialComparison, plot: p.initialPlot },
      { ...p.comparison, plot: p.plot },
    ],
  };
}

test("finding and preview refresh either attachment while preserving sample focus and selected report page", () => {
  const p = annotatedPair(),
    snapshot = findingPairSnapshot(p),
    doc = new JSDOM().window.document;
  // The controlled high-pass contrast needs a retained measurable high-pass difference.
  snapshot.comparisons[0].methods = snapshot.comparisons[0].methods.map((m) =>
    m.method === "highpass"
      ? { ...m, metrics: { ...m.metrics, centered_normalized_rmse: 0.1 } }
      : m,
  );
  snapshot.comparisons[1].methods = snapshot.comparisons[1].methods.map((m) =>
    m.method === "highpass"
      ? { ...m, metrics: { ...m.metrics, centered_normalized_rmse: 0.2 } }
      : m,
  );
  snapshot.target = "waveform_sensitivity";
  const followupOnly = {
    ...snapshot,
    comparisons: snapshot.comparisons.map((c) =>
      c.id === "initial" ? { ...c, plot: null } : c,
    ),
  };
  renderInvestigationFinding(doc.body, followupOnly, { interactive: true });
  let slider = doc.querySelector('input[type="range"]');
  assert.ok(slider);
  slider.value = "30";
  slider.dispatchEvent(new doc.defaultView.Event("input"));
  slider.focus();
  renderInvestigationFinding(doc.body, snapshot, { interactive: true });
  slider = doc.querySelector('input[type="range"]');
  assert.equal(doc.activeElement, slider);
  assert.equal(slider.value, "30");
  assert.equal(doc.querySelectorAll("polyline").length, 3);
  const preview = renderReportPreview(doc.body, followupOnly);
  assert.equal(doc.querySelectorAll(".preview-finding polyline").length, 2);
  slider = doc.querySelector('.preview-finding input[type="range"]');
  slider.focus();
  preview.updateFinding(snapshot);
  assert.equal(doc.querySelectorAll(".preview-finding polyline").length, 3);
  assert.equal(
    doc.activeElement,
    doc.querySelector('.preview-finding input[type="range"]'),
  );
  const page = doc.querySelector(".report-preview-page:not([hidden])");
  const button = [...doc.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Next"),
  );
  button.click();
  const selected = doc.querySelector(".report-preview-page:not([hidden])");
  assert.notEqual(selected, page);
  button.focus();
  preview.updateFinding({
    ...snapshot,
    comparisons: snapshot.comparisons.map((c) => ({
      ...c,
      plot: c.plot && { ...c.plot },
    })),
  });
  assert.equal(
    doc.querySelector(".report-preview-page:not([hidden])"),
    selected,
  );
  assert.equal(doc.activeElement, button);
});

test("three synthetic traces retain evaluator-only semantics and script-free export defaults to light", () => {
  const p = annotatedPair(true),
    snapshot = findingPairSnapshot(p),
    doc = new JSDOM().window.document;
  const fig = renderWaveformExcerpt(
    doc.body,
    p.plot,
    p.comparison,
    "median",
    p,
  );
  assert.equal(fig.querySelectorAll("polyline").length, 3);
  assert.match(fig.textContent, /Evaluator-only synthetic reference/);
  assert.equal(
    fig.querySelector('polyline[data-role="comparator"]').dataset.trace,
    "synthetic_reference",
  );
  const html = reportHTML(snapshot, doc, { theme: "dark" }),
    loaded = new JSDOM(html).window.document;
  assert.equal(loaded.documentElement.dataset.theme, "dark");
  assert.equal(
    loaded.querySelectorAll(
      'script,input[type="range"],[onpointermove],[onkeydown]',
    ).length,
    0,
  );
  assert.match(
    loaded.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    /script-src 'none'/,
  );
  assert.equal(
    new JSDOM(reportHTML(snapshot, doc)).window.document.documentElement.dataset
      .theme,
    "light",
  );
});
