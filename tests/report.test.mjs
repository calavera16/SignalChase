import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  makeInvestigationReport,
  makeManualReport,
  renderReport,
  renderReportPreview,
  reportHTML,
  investigationStory,
  investigationFinding,
  renderInvestigationFinding,
  renderInvestigationStory,
} from "../signaltrace/web/report.js";
function fixture() {
  const recording = {
    id: "r1",
    name: "Local PPG",
    modality: "ppg",
    plot: { raw: [912345] },
  };
  const experiment = {
    id: "x1",
    recording_id: "r1",
    protocol: {
      name: "Timing",
      task: "ppg_preprocessing",
      target: "pulse_timing",
      research_question: "Retain timing?",
      evaluation: "original_sensitivity",
    },
  };
  const comparison = {
    kind: "comparison",
    evaluation: "original_sensitivity",
    window: { start_s: 0, end_s: 30 },
    parameters: { median_window_s: 2, highpass_hz: 0.35, edge_guard_s: 3 },
    sample_count: 3750,
    valid_count: 3000,
    excluded_fraction: 0.2,
    nonfinite_count: 0,
    exact_flat_sample_count: 0,
    gap_count: 0,
    valid_interval_count: 1,
    metrics: {
      median: {
        mean_absolute_shift_ms: 0,
        maximum_absolute_shift_ms: null,
        centered_normalized_rmse: 0.0000123456789,
        matched_count: 24,
      },
    },
    raw: [912345],
  };
  const job = {
    id: "j1",
    status: "completed",
    request: {
      recording_id: "r1",
      experiment_id: "x1",
      target: "pulse_timing",
      channel: "PPG",
      start_s: 0,
      end_s: 30,
      question: "Which test next?",
      notes: "Local",
    },
    result: {
      identity: {
        provider: "meta",
        model: "muse-spark-1.3",
        execution_mode: "mocked_test",
        history_mode: "stateless",
      },
      evidence: { e2: comparison },
      conclusion: {
        status: "candidate",
        narrative: "Review median e2",
        evidence_ids: ["e2"],
        questions: [],
        candidate: {
          comparison_id: "e2",
          method: "median",
          window: comparison.window,
          parameters: comparison.parameters,
        },
      },
      comparisons: { private: [912345] },
      private_history: "PRIVATE_SENTINEL",
      error: null,
    },
  };
  const result = {
    ...comparison,
    id: "a1",
    recording_id: "r1",
    experiment_id: "x1",
    channel: "PPG",
    goal: "pulse_timing",
    comparison: "original",
    exclusions: {
      sample_count: 3750,
      valid_count: 3000,
      excluded_fraction: 0.2,
      nonfinite_count: 0,
      flatline_count: 0,
      gap_after_indices: [],
      valid_intervals_indices: [[375, 3375]],
      too_short_segments: [],
    },
  };
  return { recording, experiment, job, result };
}
test("confirmed requirement decisions survive detached report export with exact evidence and safe unknowns", () => {
  const f = fixture();
  f.job.result.context = {
    requirements: {
      confirmed: true,
      method: "median",
      criteria: { max_timing_shift_ms: 2 },
    },
  };
  f.job.result.requirement_assessment = {
    status: "not_established",
    next_action: "Review <img src=x onerror=bad()>",
    comparisons: [
      {
        comparison_id: "e2",
        method: "median",
        window: f.job.result.evidence.e2.window,
        parameters: f.job.result.evidence.e2.parameters,
        status: "not_established",
        checks: [
          {
            metric: "max_timing_shift_ms",
            limit: 2,
            value: null,
            status: "not_established",
            reason: "No matched timing evidence",
          },
        ],
      },
    ],
  };
  const s = makeInvestigationReport(f);
  f.job.result.requirement_assessment.comparisons[0].checks[0].value = 1;
  assert.equal(s.requirement_assessment.comparisons[0].checks[0].value, null);
  assert.equal(
    Object.isFrozen(s.requirement_assessment.comparisons[0].checks),
    true,
  );
  const doc = new JSDOM("<div></div>").window.document;
  const exported = reportHTML(s, doc);
  const output = new JSDOM(exported).window.document;
  const panel = output.querySelector(".requirement-decision");
  assert.match(panel.textContent, /satisfaction is not established/);
  assert.match(panel.textContent, /not available/);
  assert.match(panel.textContent, /Maximum matched-candidate timing shift/);
  assert.match(panel.textContent, /median 2 s/);
  assert.equal(panel.querySelector("img"), null);
  const link = panel.querySelector("a");
  assert.equal(
    output.querySelector(link.getAttribute("href")).textContent,
    "Comparison e2",
  );
  assert.equal(makeInvestigationReport(fixture()).requirements, null);
});

test("detached frozen snapshots preserve identity and exact numeric values without raw/private arrays", () => {
  const f = fixture(),
    s = makeInvestigationReport(f),
    before = JSON.stringify(s);
  f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = 66;
  f.job.request.question = "changed";
  f.recording.name = "changed";
  assert.equal(JSON.stringify(s), before);
  assert.ok(Object.isFrozen(s.comparisons[0].methods[0]));
  assert.equal(s.comparisons[0].methods[1].metrics.mean_absolute_shift_ms, 0);
  assert.equal(
    s.comparisons[0].methods[1].metrics.maximum_absolute_shift_ms,
    null,
  );
  assert.equal(
    s.comparisons[0].methods[1].metrics.centered_normalized_rmse,
    0.0000123456789,
  );
  assert.doesNotMatch(before, /912345|PRIVATE_SENTINEL|private_history|"raw"/);
});

function storyFixture() {
  const f = fixture();
  const initial = f.job.result.evidence.e2;
  for (const method of ["unchanged", "median", "highpass"])
    initial.metrics[method] = {
      comparator_count: 30,
      candidate_count: 30,
      matched_count: 30,
      unmatched_comparator_count: 0,
      unmatched_candidate_count: 0,
      mean_absolute_shift_ms: 0,
      maximum_absolute_shift_ms: 0,
      centered_normalized_rmse: 0,
    };
  f.job.result.evidence.e3 = structuredClone(initial);
  f.job.result.trace = [
    { round: 3, tool: "compare", status: "success", evidence_id: "e3" },
    { round: 2, tool: "compare", status: "success", evidence_id: "e2" },
  ];
  return f;
}
function addRegionalEvidence(f, id = "e4") {
  const parent = f.job.result.evidence.e2;
  const metrics = {
    reference_candidate_count: 4,
    candidate_count: 3,
    matched_pair_count: 4,
    unmatched_reference_count: 0,
    unmatched_candidate_count: 0,
    cross_boundary_pair_count: 1,
    mean_absolute_shift_ms: 8,
    maximum_absolute_shift_ms: 16,
    full_window_centered_normalized_rmse: 0.123456,
  };
  const summary = {
    kind: "regional_summary",
    comparison_id: "e2",
    window: parent.window,
    split_s: 15,
    parameters: parent.parameters,
    assignment: "original_candidate_time",
    filtering_context: "parent_full_window",
    normalization: "parent_full_window_means_and_original_std",
    regions: [
      { start_s: 0, end_s: 15 },
      { start_s: 15, end_s: 30 },
    ].map((window) => ({
      window,
      sample_count: 1875,
      valid_count: 1500,
      metrics: Object.fromEntries(
        ["unchanged", "median", "highpass"].map((m) => [m, { ...metrics }]),
      ),
    })),
    limitations: ["Descriptive summaries only"],
    raw: [912345],
    private_history: "PRIVATE_REGIONAL_SENTINEL",
  };
  summary.regions[1].metrics.highpass = {
    ...metrics,
    matched_pair_count: 0,
    mean_absolute_shift_ms: null,
    maximum_absolute_shift_ms: null,
  };
  f.job.result.evidence[id] = summary;
  f.job.result.trace ??= [
    { round: 2, tool: "compare", status: "success", evidence_id: "e2" },
  ];
  f.job.result.trace.push({
    round: 4,
    tool: "regional_summary",
    status: "success",
    evidence_id: id,
  });
  return summary;
}
const storyText = (f) => {
  const doc = new JSDOM().window.document;
  renderInvestigationStory(doc.body, makeInvestigationReport(f));
  return doc.body.textContent;
};
test("regional snapshots are detached, bounded and preserve exact parent-scoped metrics without samples", () => {
  const f = fixture(),
    source = addRegionalEvidence(f);
  const snapshot = makeInvestigationReport(f),
    saved = JSON.stringify(snapshot);
  source.regions[0].metrics.median.matched_pair_count = 99;
  source.regions[0].window.start_s = 12;
  assert.equal(JSON.stringify(snapshot), saved);
  assert.equal(snapshot.comparisons.length, 1);
  const r = snapshot.regional_summaries[0];
  assert.equal(r.comparison_id, "e2");
  assert.equal(
    r.regions[0].methods[1].metrics.full_window_centered_normalized_rmse,
    0.123456,
  );
  assert.equal(r.regions[0].methods[1].metrics.cross_boundary_pair_count, 1);
  assert.equal(r.regions[1].methods[2].metrics.mean_absolute_shift_ms, null);
  assert.ok(Object.isFrozen(r.regions[0].methods[1].metrics));
  assert.doesNotMatch(saved, /912345|PRIVATE_REGIONAL_SENTINEL|"raw"/);
});

test("regional follow-ups keep the five-stage chronology and do not claim absent follow-up or numerical usefulness", () => {
  const f = storyFixture();
  addRegionalEvidence(f);
  // Regional summary occurs before a second settings contrast, despite insertion order.
  f.job.result.trace.find((e) => e.evidence_id === "e4").round = 3;
  f.job.result.trace.find((e) => e.evidence_id === "e3").round = 4;
  const s = makeInvestigationReport(f),
    story = investigationStory(s);
  assert.equal(story.stages.length, 5);
  assert.deepEqual(
    story.stages[2].checks.map((c) => c.id),
    ["e4", "e3"],
  );
  assert.deepEqual(
    story.stages[3].checks.map((c) => c.id),
    ["e4", "e3"],
  );
  assert.match(storyText(f), /Round 3.*parent comparison e2/);
  assert.match(storyText(f), /Globally normalized waveform RMSE/);
  assert.match(
    storyText(f),
    /Numerical differences alone do not establish consequential usefulness/,
  );
  delete f.job.result.evidence.e3;
  const regionalOnlyFollowup = storyText(f);
  assert.doesNotMatch(
    regionalOnlyFollowup,
    /No successful follow-up|No added comparison evidence|only one successful comparison is available/,
  );
  assert.match(regionalOnlyFollowup, /do not test another parameter setting/);
});

test("repeated comparison conclusions stay scoped when regional follow-ups retain different measurements", () => {
  const f = storyFixture();
  const regional = addRegionalEvidence(f);
  regional.regions[1].metrics.median.mean_absolute_shift_ms = 32;
  regional.regions[1].metrics.median.maximum_absolute_shift_ms = 48;
  regional.regions[1].metrics.median.full_window_centered_normalized_rmse = 0.456;
  const story = investigationStory(makeInvestigationReport(f));
  const ending = story.stages[4].paragraphs.join("\n");
  assert.match(
    ending,
    /additional comparison tests add no measured difference/,
  );
  assert.match(ending, /Useful added information from those comparison tests/);
  assert.doesNotMatch(
    ending,
    /The follow-ups add no measured difference|Useful added information beyond the initial comparison is not demonstrated/,
  );
  assert.match(
    ending,
    /Regional summaries describe how retained measurements are distributed/,
  );
  const regionalCheck = story.stages[3].checks
    .find((c) => c.id === "e4")
    .paragraphs.join("\n");
  assert.match(
    regionalCheck,
    /Mean \/ maximum absolute timing shift 8 \/ 16 ms/,
  );
  assert.match(
    regionalCheck,
    /Mean \/ maximum absolute timing shift 32 \/ 48 ms/,
  );
  assert.match(
    regionalCheck,
    /Numerical differences alone do not establish consequential usefulness/,
  );
});

test("regional citations and full HTML export retain scopes, counts, null metrics and safe parent anchors", () => {
  const f = fixture(),
    attack = '</script><img src="https://evil.invalid" onerror="alert(1)">';
  const source = addRegionalEvidence(f, attack);
  source.limitations = [attack];
  f.job.result.conclusion.evidence_ids = [attack];
  const s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  const loaded = new JSDOM(reportHTML(s, doc)).window.document;
  const region = loaded.getElementById("report-evidence-1").parentElement;
  assert.match(region.textContent, /\[0, 15\).*\[15, 30\)/s);
  assert.match(
    region.textContent,
    /assigned by original time|original\/comparator candidate time/,
  );
  assert.match(region.textContent, /Cross-boundary matched pairs/);
  assert.match(
    region.textContent,
    /parent full-window means and original standard deviation/,
  );
  assert.match(region.textContent, /not available/);
  assert.match(region.textContent, /do not re-filter, re-detect or rematch/);
  assert.equal(
    region.querySelector("a").getAttribute("href"),
    "#report-evidence-0",
  );
  assert.ok(
    [...loaded.querySelectorAll("a")].every((a) =>
      loaded.querySelector(a.getAttribute("href")),
    ),
  );
  assert.equal(
    loaded.querySelector("script,img,iframe,[src],[onclick],[onerror]"),
    null,
  );
  assert.ok(loaded.body.textContent.includes(attack));
  renderReportPreview(doc.body, s);
  assert.match(doc.body.textContent, /Regional summary/);
  assert.match(doc.body.textContent, /Cross-boundary matched pairs/);
});

test("historical snapshots without regional fields continue to render and export", () => {
  const s = { ...makeInvestigationReport(fixture()) };
  delete s.regional_summaries;
  delete s.evidence_trace;
  const doc = new JSDOM().window.document;
  assert.doesNotThrow(() => renderReportPreview(doc.body, s));
  assert.doesNotThrow(() => reportHTML(s, doc));
});
test("story orders successful comparisons by trace and distinguishes repeated identical checks from added evidence", () => {
  const f = storyFixture();
  // Deliberately reverse evidence insertion order and duplicate one trace entry.
  f.job.result.evidence = {
    e3: f.job.result.evidence.e3,
    e2: f.job.result.evidence.e2,
  };
  f.job.result.trace.push({
    round: 4,
    tool: "compare",
    status: "success",
    evidence_id: "e3",
  });
  const story = investigationStory(makeInvestigationReport(f));
  assert.equal(story.stages[1].checks[0].id, "e2");
  assert.deepEqual(
    story.stages[2].checks.map((c) => c.id),
    ["e3"],
  );
  assert.match(storyText(f), /Repeated window and settings/);
  assert.match(storyText(f), /No material measured difference/);
  assert.match(
    storyText(f),
    /metrics and support counts are identical for the same interval and settings/,
  );
  assert.match(storyText(f), /add no measured difference/);
  // Same measured evidence with different scope is not an independently replicated test.
  f.job.result.evidence.e3.window = { start_s: 10, end_s: 20 };
  assert.match(storyText(f), /Window changed; settings unchanged/);
  assert.match(storyText(f), /do not isolate a cause/);
  assert.match(
    storyText(f),
    /metrics and support counts are identical, but intervals or settings differ/,
  );
  assert.match(
    storyText(f),
    /Equal counts do not establish identical candidate\/sample support/,
  );
  assert.doesNotMatch(
    storyText(f),
    /metrics and support are identical|counts are identical for the same interval/,
  );
  f.job.result.evidence.e3.window = structuredClone(
    f.job.result.evidence.e2.window,
  );
  f.job.result.evidence.e3.parameters.median_window_s = 1;
  assert.match(storyText(f), /Window unchanged; settings changed/);
  assert.match(
    storyText(f),
    /Equal counts do not establish identical candidate\/sample support/,
  );
});

test("story labels exact differences below displayed precision without displaying an identical rounded transition or claiming useful added value", () => {
  const f = storyFixture();
  f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = 8;
  f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = 8.0001;
  const text = storyText(f);
  assert.match(
    text,
    /exact values differ below displayed precision \(both display 8 ms\)/,
  );
  assert.match(text, /useful follow-up finding is not established/);
  assert.doesNotMatch(text, /8 → 8 ms|add descriptive measurement information/);
});

test("computation roundoff never becomes added value, a newly nonzero shift or a nonredundant check", () => {
  for (const [before, after] of [
    [8, 8 + 1e-12],
    [8.000000000000558, 7.999999999999995],
    [0, 1e-12],
  ]) {
    const f = storyFixture();
    f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = before;
    f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = after;
    const snapshot = makeInvestigationReport(f),
      text = storyText(f);
    assert.match(text, /No change beyond the numerical roundoff tolerance/);
    assert.match(
      text,
      /metrics are equivalent within that tolerance and support counts are identical/,
    );
    assert.match(
      text,
      /add no measured difference beyond the numerical roundoff tolerance/,
    );
    assert.match(text, /not a scientific or clinical significance threshold/);
    assert.doesNotMatch(
      text,
      /add descriptive measurement information|nonzero timing summary is present|8 → 8 ms/,
    );
    assert.equal(
      snapshot.comparisons[0].methods[1].metrics.mean_absolute_shift_ms,
      before,
    );
    assert.equal(
      snapshot.comparisons[1].methods[1].metrics.mean_absolute_shift_ms,
      after,
    );
  }
  const f = storyFixture();
  f.experiment.protocol.target = f.job.request.target = "waveform_sensitivity";
  f.job.result.evidence.e3.metrics.median.centered_normalized_rmse = 1e-14;
  assert.match(storyText(f), /metrics are equivalent within that tolerance/);
  f.job.result.evidence.e3.metrics.median.centered_normalized_rmse = 1e-5;
  f.job.result.evidence.e2.metrics.median.centered_normalized_rmse = 2e-5;
  assert.match(storyText(f), /exact values differ below displayed precision/);
  assert.doesNotMatch(storyText(f), /add descriptive measurement information/);
});
test("story exposes same-window recipe sensitivity and all follow-ups with exact support, without model-intent or localization claims", () => {
  const f = storyFixture();
  f.job.result.evidence.e3.parameters.median_window_s = 1;
  f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = 10.634;
  f.job.result.evidence.e3.metrics.median.maximum_absolute_shift_ms = 40;
  const e4 = structuredClone(f.job.result.evidence.e3);
  e4.window = { start_s: 15, end_s: 20 };
  e4.valid_count = 450;
  e4.sample_count = 625;
  e4.excluded_fraction = 0.28;
  e4.metrics.median.matched_count = 5;
  e4.metrics.median.unmatched_comparator_count = 2;
  f.job.result.evidence.e4 = e4;
  f.job.result.trace.push({
    round: 4,
    tool: "compare",
    status: "success",
    evidence_id: "e4",
  });
  const text = storyText(f);
  assert.match(text, /Window unchanged; settings changed/);
  assert.match(text, /median window 1 s/);
  assert.match(
    text,
    /Median subtraction mean absolute timing shift: 0 → 10.6 ms/,
  );
  assert.match(text, /450 of 625 samples usable; 28% excluded/);
  assert.match(text, /5 matched, 2 unmatched original/);
  assert.match(text, /reason for selecting each test was not recorded/);
  assert.match(text, /not localization or accuracy/);
  assert.match(text, /do not locate changes within a window/);
  assert.deepEqual(
    investigationStory(makeInvestigationReport(f)).stages[2].checks.map(
      (c) => c.id,
    ),
    ["e3", "e4"],
  );
});
test("story never turns zero matches, missing, negative or nonfinite timing into a zero effect", () => {
  for (const change of [
    (m) => {
      m.matched_count = 0;
    },
    (m) => {
      m.mean_absolute_shift_ms = null;
      m.maximum_absolute_shift_ms = null;
    },
    (m) => {
      m.mean_absolute_shift_ms = -1;
      m.maximum_absolute_shift_ms = Infinity;
    },
  ]) {
    const f = storyFixture();
    for (const item of Object.values(f.job.result.evidence))
      for (const m of Object.values(item.metrics)) change(m);
    const text = storyText(f);
    assert.match(text, /timing shift not available \/ not available ms/);
    assert.match(text, /cannot establish a zero effect/);
    assert.doesNotMatch(
      text,
      /No material measured difference|add no measured difference|newly detected/,
    );
  }
});
test("story labels absent and incomplete trace order instead of inventing chronology", () => {
  const f = storyFixture();
  f.job.result.trace = [
    { round: 2, tool: "compare", status: "error", evidence_id: "e3" },
  ];
  assert.match(
    storyText(f),
    /Trace unavailable: retained evidence order is the fallback/,
  );
  f.job.result.trace = [
    { round: 3, tool: "compare", status: "success", evidence_id: "e3" },
  ];
  assert.match(storyText(f), /Order incomplete/);
  assert.match(storyText(f), /not a verified initial model choice/);
  assert.equal(
    investigationStory(makeInvestigationReport(f)).stages[1].checks[0].id,
    "e3",
  );
});
test("story has explicit no-follow-up, inconclusive and partial-failure outcomes; failed reports discard stale model conclusions", () => {
  const f = fixture();
  assert.match(storyText(f), /No successful follow-up comparison/);
  assert.match(storyText(f), /Added value is unproven/);
  f.job.result.conclusion.status = "inconclusive";
  assert.match(storyText(f), /Meta ended inconclusively/);
  f.job.status = "failed";
  const snapshot = makeInvestigationReport(f);
  assert.equal(snapshot.proposal, "");
  assert.equal(snapshot.candidate, null);
  assert.deepEqual(snapshot.citations, []);
  assert.match(
    storyText(f),
    /Run failed: retained comparisons are partial evidence/,
  );
  f.job.result.evidence = {};
  assert.match(
    storyText(f),
    /no measured preprocessing sensitivity can be established/,
  );
});
test("waveform story uses shape measurements and preview/export share all five stages with safe evidence links", () => {
  const f = storyFixture();
  f.experiment.protocol.target = f.job.request.target = "waveform_sensitivity";
  f.job.result.evidence.e3.metrics.median.centered_normalized_rmse = 0.6;
  const s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  renderReport(doc.body, s);
  const exported = new JSDOM(reportHTML(s, doc)).window.document;
  assert.equal(
    exported.querySelector(".investigation-story").textContent,
    doc.querySelector(".investigation-story").textContent,
  );
  assert.equal(
    exported.querySelectorAll(".investigation-story > section").length,
    5,
  );
  assert.match(
    exported.querySelector(".investigation-story").textContent,
    /normalized waveform difference: 0 → 0.6/,
  );
  assert.doesNotMatch(
    exported.querySelector(".investigation-story").textContent,
    /mean \/ maximum absolute timing shift/,
  );
  for (const link of exported.querySelectorAll(".investigation-story a"))
    assert.ok(exported.querySelector(link.getAttribute("href")));
  assert.equal(exported.querySelector("script"), null);
});
test("reports reject missing, active and mismatched evidence with fixed errors", () => {
  for (const alter of [
    (f) => (f.recording.id = "other"),
    (f) => (f.experiment.recording_id = "other"),
    (f) => (f.job.request.experiment_id = "other"),
    (f) => (f.job.request.recording_id = "other"),
    (f) => (f.job.request.target = "waveform_sensitivity"),
    (f) => (f.job.status = "running"),
    (f) => (f.job.result = null),
  ]) {
    const f = fixture();
    alter(f);
    assert.throws(
      () => makeInvestigationReport(f),
      /^Error: Report evidence is missing or belongs to a different source or experiment\.$/,
    );
  }
  for (const alter of [
    (f) => (f.result.experiment_id = "other"),
    (f) => (f.result.recording_id = "other"),
    (f) => (f.result.comparison = "synthetic_reference"),
    (f) => (f.result.goal = "waveform_sensitivity"),
  ]) {
    const f = fixture();
    alter(f);
    assert.throws(() => makeManualReport(f));
  }
});
test("terminal outcomes and failed partial evidence never become a completed recommendation", () => {
  for (const status of ["candidate", "needs_information", "inconclusive"]) {
    const f = fixture();
    f.job.result.conclusion.status = status;
    f.job.result.conclusion.questions = ["Need acquisition units?"];
    const s = makeInvestigationReport(f);
    assert.equal(s.status, status);
    assert.deepEqual(s.questions, ["Need acquisition units?"]);
  }
  const f = fixture();
  f.job.status = "failed";
  f.job.result.conclusion = null;
  f.job.result.error = { category: "timeout", raw: "SECRET" };
  const s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  renderReport(doc.body, s);
  assert.equal(s.status, "failed");
  assert.equal(s.comparisons.length, 1);
  assert.match(doc.body.textContent, /partial evidence/);
  assert.doesNotMatch(doc.body.textContent, /SECRET/);
  f.job.result.evidence = {};
  assert.match(
    reportHTML(makeInvestigationReport(f), doc),
    /No successful comparison/,
  );
});
test("manual report explicitly excludes Meta and distinguishes unavailable metrics from zero", () => {
  const f = fixture(),
    s = makeManualReport(f),
    doc = new JSDOM().window.document;
  renderReport(doc.body, s);
  assert.equal(s.kind, "manual");
  assert.match(doc.body.textContent, /Meta was not used/);
  const headings = [...doc.querySelectorAll("thead th")].map(
    (cell) => cell.textContent,
  );
  const median = [...doc.querySelectorAll("tbody tr")].find(
    (row) => row.querySelector("th").textContent === "Median subtraction",
  );
  const cells = [...median.children].map((cell) => cell.textContent);
  assert.equal(cells[headings.indexOf("Mean timing shift (ms)")], "0");
  assert.equal(
    cells[headings.indexOf("Maximum timing shift (ms)")],
    "not available",
  );
  assert.equal(
    cells[headings.indexOf("Normalized waveform difference")],
    "<0.001",
  );
});
test("standalone and preview share safe content; hostile values never create active resources", () => {
  const f = fixture(),
    attack =
      '</style></script><script>window.pwned=1</script><img src="https://evil.invalid"><a href="javascript:alert(1)">x</a>';
  f.recording.name = attack;
  f.job.request.question = attack;
  f.job.result.conclusion.narrative = attack;
  f.job.result.conclusion.evidence_ids = [attack];
  f.job.result.evidence = { [attack]: f.job.result.evidence.e2 };
  const s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  renderReport(doc.body, s);
  const html = reportHTML(s, doc),
    loaded = new JSDOM(html).window.document;
  assert.equal(loaded.body.textContent, doc.body.textContent);
  assert.equal(
    loaded.querySelectorAll(
      "script,img,iframe,form,link,object,embed,video,audio",
    ).length,
    0,
  );
  assert.equal(loaded.querySelectorAll("[src],[action],[style]").length, 0);
  for (const link of loaded.querySelectorAll("a")) {
    assert.match(link.getAttribute("href"), /^#report-evidence-\d+$/);
    assert.ok(loaded.querySelector(link.getAttribute("href")));
  }
  assert.match(
    loaded.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    /default-src 'none'.*connect-src 'none'.*form-action 'none'/,
  );
  assert.match(loaded.querySelector("style").textContent, /1\.25rem\/1\.6/);
  assert.equal(loaded.querySelectorAll("style").length, 1);
  for (const item of loaded.querySelectorAll("[id]"))
    assert.match(item.id, /^report-evidence-\d+$/);
  assert.ok(loaded.body.textContent.includes(attack));
});

test("concise report preview groups scope and measured methods into named pages without changing complete output", () => {
  const f = fixture(),
    s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  const before = JSON.stringify(s),
    complete = reportHTML(s, doc);
  renderReportPreview(doc.body, s);
  const pages = [...doc.querySelectorAll(".report-preview-page")];
  assert.ok(pages.length >= 4 && pages.length <= 6);
  assert.equal(pages.filter((p) => !p.hidden).length, 1);
  assert.match(
    pages[0].textContent,
    /Question used.*Which test next\?.*Local PPG.*Pulse timing/,
  );
  for (const p of pages) {
    assert.ok(p.querySelector("h2"));
    assert.ok(p.children.length > 1);
  }
  const table = doc.querySelector(".preview-metrics-table");
  assert.equal(table.querySelectorAll("tr").length, 4);
  assert.equal(table.querySelectorAll("thead th").length, 4);
  assert.match(table.textContent, /not available/);
  assert.match(table.textContent, /<0.001/);
  const select = doc.querySelector(".report-section-nav select");
  select.value = String(pages.length - 1);
  select.dispatchEvent(new doc.defaultView.Event("change"));
  assert.equal(pages.at(-1).hidden, false);
  assert.equal(
    doc.querySelector(".report-section-nav button:last-child").disabled,
    true,
  );
  assert.equal(JSON.stringify(s), before);
  assert.equal(reportHTML(s, doc), complete);
});

test("concise preview pages long model prose safely and retains the exact full narrative", () => {
  const f = fixture();
  const attack = '<img src="https://invalid.example"><script>throw 1</script>';
  f.job.result.conclusion.narrative = (attack + " measured evidence ").repeat(
    20,
  );
  const s = makeInvestigationReport(f),
    doc = new JSDOM().window.document;
  renderReportPreview(doc.body, s);
  const proposalPages = [
    ...doc.querySelectorAll(".report-preview-page"),
  ].filter((p) =>
    p.querySelector("h2").textContent.startsWith("Unverified Meta proposal"),
  );
  assert.ok(proposalPages.length > 1);
  const text = proposalPages
    .map((p) => p.querySelector("p").textContent)
    .join("");
  assert.equal(text, s.proposal);
  assert.ok(
    proposalPages.every((p) => p.querySelector("p").textContent.length <= 650),
  );
  assert.equal(doc.querySelectorAll("script,img,iframe,[src]").length, 0);
  assert.ok(doc.body.textContent.includes(attack));
});

function contrastFixture() {
  const f = storyFixture();
  f.job.result.evidence.e3.parameters.median_window_s = 4;
  f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = 4.985507;
  f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = 0.115942;
  return f;
}
test("finding derives a precise chronological one-setting contrast with equal support counts and exact evidence links", () => {
  const f = contrastFixture();
  // Deliberately non-demo IDs: the retained trace, never a case ID, drives the summary.
  f.job.result.evidence.alpha = f.job.result.evidence.e2;
  f.job.result.evidence.beta = f.job.result.evidence.e3;
  delete f.job.result.evidence.e2;
  delete f.job.result.evidence.e3;
  f.job.result.trace[0].evidence_id = "beta";
  f.job.result.trace[1].evidence_id = "alpha";
  const snapshot = makeInvestigationReport(f),
    before = JSON.stringify(snapshot);
  const finding = investigationFinding(snapshot);
  assert.equal(finding.contrast.before, "4.99");
  assert.equal(finding.contrast.after, "0.12");
  assert.deepEqual(finding.evidence, ["alpha", "beta"]);
  assert.match(finding.detail, /Only median window changes: 2 to 4 s/);
  assert.match(
    finding.detail,
    /equal support counts: 3000 valid samples, 30 matched/,
  );
  assert.match(
    finding.detail,
    /Equal counts do not establish identical candidate\/sample support/,
  );
  assert.match(finding.detail, /high-pass cutoff 0.35 Hz; edge guard 3 s/);
  const doc = new JSDOM().window.document;
  renderReport(doc.body, snapshot);
  for (const link of doc.querySelectorAll(".investigation-finding a"))
    assert.ok(doc.querySelector(link.getAttribute("href")));
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(snapshot.proposal, f.job.result.conclusion.narrative);
});
test("finding falls back honestly for unknown chronology, changed support, scope, multiple parameters and unavailable timing", () => {
  for (const alter of [
    (f) => {
      f.job.result.trace = [];
    },
    (f) => {
      f.job.result.evidence.e3.valid_count -= 1;
    },
    (f) => {
      f.job.result.evidence.e3.window.end_s = 40;
    },
    (f) => {
      f.job.result.evidence.e3.parameters.highpass_hz = 1;
    },
    (f) => {
      f.job.result.evidence.e3.metrics.median.matched_count = 0;
    },
    (f) => {
      f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = null;
    },
    (f) => {
      f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = Infinity;
    },
  ]) {
    const f = contrastFixture();
    alter(f);
    const result = investigationFinding(makeInvestigationReport(f));
    assert.equal(result.contrast, null);
    assert.match(result.title, /not established/);
  }
});

test("finding leads with consistent candidate increases and decreases and retains timing context and evidence anchors", () => {
  for (const [beforeCount, afterCount] of [
    [30, 34],
    [34, 30],
  ]) {
    const f = storyFixture();
    f.job.result.evidence.e3.parameters.highpass_hz = 1;
    for (const [id, count, mean] of [
      ["e2", beforeCount, 1.176470588],
      ["e3", afterCount, 1],
    ]) {
      Object.assign(f.job.result.evidence[id].metrics.highpass, {
        candidate_count: count,
        unmatched_candidate_count: count - 30,
        mean_absolute_shift_ms: mean,
        maximum_absolute_shift_ms: 8,
      });
    }
    const snapshot = makeInvestigationReport(f);
    const finding = investigationFinding(snapshot);
    assert.equal(
      finding.title,
      "Candidate counts differ across the tested settings",
    );
    assert.match(finding.contrast.label, /method candidates$/);
    assert.equal(finding.contrast.before, String(beforeCount - 30));
    assert.equal(finding.contrast.after, String(afterCount - 30));
    assert.deepEqual(finding.evidence, ["e2", "e3"]);
    assert.match(finding.detail, /Only high-pass cutoff changes: 0.35 to 1 Hz/);
    assert.match(
      finding.detail,
      /equal sample-summary counts: 3000 valid samples/,
    );
    assert.match(finding.detail, /Original candidates 30 to 30/);
    assert.match(finding.detail, /matched candidates 30 to 30/);
    assert.ok(
      finding.detail.includes(
        `unmatched method candidates ${beforeCount - 30} to ${afterCount - 30}`,
      ),
    );
    assert.match(
      finding.detail,
      /Matched-candidate mean absolute timing shift 1.18 to 1 ms/,
    );
    assert.match(finding.detail, /Maximum absolute timing shift 8 to 8 ms/);
    assert.match(
      finding.detail,
      /do not identify which candidates changed or whether matched pairs are identical/,
    );
    assert.doesNotMatch(
      finding.title + finding.detail + finding.note,
      /false beats|better filter|negligible|clinically meaningful|same matches/i,
    );
    const doc = new JSDOM().window.document;
    renderReport(doc.body, snapshot);
    assert.deepEqual(
      [...doc.querySelectorAll(".finding-contrast dd")].map(
        (el) => el.textContent,
      ),
      [String(beforeCount - 30), String(afterCount - 30)],
    );
    assert.deepEqual(
      [
        ...new Set(
          [...doc.querySelectorAll(".investigation-finding a")].map((el) =>
            el.getAttribute("href"),
          ),
        ),
      ],
      ["#report-evidence-0", "#report-evidence-1"],
    );
    for (const link of doc.querySelectorAll(".investigation-finding a"))
      assert.ok(doc.querySelector(link.getAttribute("href")));
    renderReportPreview(doc.body, snapshot);
    assert.match(
      doc.querySelector(".preview-finding").textContent,
      /Candidate counts differ/,
    );
  }
});

test("finding distinguishes unmatched original changes from method and matched counts", () => {
  const f = contrastFixture();
  Object.assign(f.job.result.evidence.e3.metrics.median, {
    matched_count: 28,
    unmatched_comparator_count: 2,
    unmatched_candidate_count: 2,
  });
  const finding = investigationFinding(makeInvestigationReport(f));
  assert.match(finding.contrast.label, /unmatched method candidates$/);
  assert.equal(finding.contrast.before, "0");
  assert.equal(finding.contrast.after, "2");
  assert.match(
    finding.detail,
    /method candidates 30 to 30; matched candidates 30 to 28/,
  );
  assert.match(
    finding.detail,
    /unmatched original candidates 0 to 2; unmatched method candidates 0 to 2/,
  );
});

test("candidate-count evidence remains visible with unchanged timing and omits unavailable maximum timing", () => {
  const f = contrastFixture();
  for (const id of ["e2", "e3"])
    Object.assign(f.job.result.evidence[id].metrics.median, {
      mean_absolute_shift_ms: 1,
      maximum_absolute_shift_ms: null,
    });
  Object.assign(f.job.result.evidence.e3.metrics.median, {
    candidate_count: 34,
    unmatched_candidate_count: 4,
  });
  const finding = investigationFinding(makeInvestigationReport(f));
  assert.match(finding.title, /Candidate counts differ/);
  assert.equal(finding.contrast.before, "0");
  assert.equal(finding.contrast.after, "4");
  assert.match(finding.detail, /mean absolute timing shift 1 to 1 ms/);
  assert.doesNotMatch(finding.detail, /Maximum absolute timing shift/);
});

test("finding rejects missing, invalid or inconsistent candidate support on either side", () => {
  for (const id of ["e2", "e3"])
    for (const key of [
      "comparator_count",
      "candidate_count",
      "matched_count",
      "unmatched_comparator_count",
      "unmatched_candidate_count",
    ])
      for (const value of [undefined, null, -1, 0.5, Infinity, 99]) {
        const f = contrastFixture();
        f.job.result.evidence[id].metrics.median[key] = value;
        assert.equal(
          investigationFinding(makeInvestigationReport(f)).contrast,
          null,
          `${id}.${key}=${value}`,
        );
      }
});

test("candidate contrast still requires matched timing and the same comparator and sample summary", () => {
  for (const alter of [
    (f) => {
      f.job.result.evidence.e3.evaluation = "synthetic_reference";
    },
    (f) => {
      f.job.result.evidence.e3.valid_count -= 1;
    },
    (f) => {
      f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = null;
    },
    (f) => {
      f.job.result.evidence.e3.metrics.median.matched_count = 0;
      f.job.result.evidence.e3.metrics.median.unmatched_comparator_count = 30;
      f.job.result.evidence.e3.metrics.median.unmatched_candidate_count = 34;
    },
  ]) {
    const f = contrastFixture();
    Object.assign(f.job.result.evidence.e3.metrics.median, {
      candidate_count: 34,
      unmatched_candidate_count: 4,
    });
    alter(f);
    assert.equal(
      investigationFinding(makeInvestigationReport(f)).contrast,
      null,
    );
  }
});
test("finding keeps inconclusive and failed status separate from descriptive facts; waveform target uses shape", () => {
  for (const status of ["inconclusive", "needs_information"]) {
    const f = contrastFixture();
    f.job.result.conclusion.status = status;
    const s = makeInvestigationReport(f);
    assert.equal(s.status, status);
    assert.ok(investigationFinding(s).contrast);
  }
  const f = contrastFixture();
  f.job.status = "failed";
  let s = makeInvestigationReport(f);
  assert.equal(s.status, "failed");
  assert.equal(s.proposal, "");
  assert.ok(investigationFinding(s).contrast);
  f.job.status = "completed";
  f.experiment.protocol.target = f.job.request.target = "waveform_sensitivity";
  f.job.result.evidence.e2.metrics.median.centered_normalized_rmse = 0.125;
  f.job.result.evidence.e3.metrics.median.centered_normalized_rmse = 0.375;
  s = makeInvestigationReport(f);
  const finding = investigationFinding(s);
  assert.equal(finding.contrast.before, "0.125");
  assert.equal(finding.contrast.after, "0.375");
  assert.match(finding.contrast.label, /normalized waveform difference/);
  assert.doesNotMatch(finding.contrast.label, /timing/);
});
test("finding does not call roundoff or identical displayed values a new difference", () => {
  for (const after of [8, 8 + 1e-12, 8.0001]) {
    const f = contrastFixture();
    f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = 8;
    f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = after;
    const result = investigationFinding(makeInvestigationReport(f));
    assert.match(result.title, /do not establish a new difference/);
    assert.equal(result.contrast.before, result.contrast.after);
  }
});

test("prominent computed finding leads with actual inconclusive or failed partial-evidence outcome in full report and preview", () => {
  for (const status of ["inconclusive", "failed"]) {
    const f = contrastFixture();
    if (status === "failed") f.job.status = "failed";
    else f.job.result.conclusion.status = status;
    const s = makeInvestigationReport(f),
      before = JSON.stringify(s);
    const doc = new JSDOM().window.document;
    renderReport(doc.body, s);
    const full = doc.querySelector(".investigation-finding");
    assert.equal(full.firstElementChild.className, "finding-outcome");
    const expected =
      status === "failed"
        ? /Outcome: Run failed.*partial evidence only/
        : /Outcome: Setting sensitivity detected; preferred filter unresolved/;
    assert.match(full.firstElementChild.textContent, expected);
    assert.ok(
      full.querySelector(".finding-contrast"),
      "measured facts remain visible despite bounded status",
    );
    renderReportPreview(doc.body, s);
    const preview = doc.querySelector(".preview-finding");
    assert.equal(preview.firstElementChild.className, "finding-outcome");
    assert.match(preview.firstElementChild.textContent, expected);
    assert.doesNotMatch(
      preview.firstElementChild.textContent,
      /completed|ready/,
    );
    assert.equal(JSON.stringify(s), before);
    assert.equal(s.status, status);
  }
});

test("at-a-glance leads with a short scoped sentence and two zero-based semantic figures before support details", () => {
  const snapshot = makeInvestigationReport(contrastFixture());
  const doc = new JSDOM().window.document;
  renderInvestigationFinding(doc.body, snapshot);
  const summary = doc.querySelector(".finding-summary");
  assert.match(
    summary.textContent,
    /Median subtraction 2.*4 s: mean matched timing shift 4.99.*0.12 ms/,
  );
  assert.ok(summary.textContent.length < 200);
  const charts = doc.querySelector(".finding-charts");
  const figures = charts.querySelectorAll("figure");
  assert.equal(figures.length, 2);
  assert.match(
    figures[0].querySelector("figcaption").textContent,
    /Unmatched method candidates/,
  );
  assert.match(figures[1].textContent, /4.99 ms/);
  const bars = figures[1].querySelectorAll(".finding-bar");
  assert.equal(bars[0].style.width, "100%");
  assert.ok(
    Math.abs(parseFloat(bars[1].style.width) - (0.115942 / 4.985507) * 100) <
      1e-8,
  );
  assert.equal(bars[0].parentElement.getAttribute("aria-hidden"), "true");
  const details = doc.querySelector(".finding-scope");
  assert.equal(details.open, false);
  assert.equal(
    details.querySelector("summary").textContent,
    "Comparison scope and support",
  );
  assert.ok(charts.compareDocumentPosition(details) & 4);
  assert.match(details.textContent, /Equal counts do not establish identical/);
  for (const figure of figures)
    assert.equal(figure.querySelectorAll("a").length, 2);
});

test("visual zero, missing timing and extreme finite values do not invent visible effects", () => {
  for (const value of [0, 1e308]) {
    const f = contrastFixture();
    f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = value;
    f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = value;
    const doc = new JSDOM().window.document;
    renderInvestigationFinding(doc.body, makeInvestigationReport(f));
    for (const bar of doc.querySelectorAll(
      ".finding-charts figure:last-child .finding-bar",
    ))
      assert.equal(bar.style.width, value ? "100%" : "0%");
    assert.doesNotMatch(doc.body.innerHTML, /NaN|Infinity/);
  }
  const f = contrastFixture();
  f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms = null;
  const doc = new JSDOM().window.document;
  renderInvestigationFinding(doc.body, makeInvestigationReport(f));
  assert.equal(doc.querySelectorAll("figure").length, 0);
  assert.match(doc.body.textContent, /not established/);
});

test("visual evidence links invoke workspace callbacks and navigate preview comparison sections", () => {
  const snapshot = makeInvestigationReport(contrastFixture());
  const doc = new JSDOM().window.document;
  const calls = [];
  renderInvestigationFinding(doc.body, snapshot, {
    evidenceHref: (id) => `#local-${id}`,
    onEvidence: (id) => calls.push(id),
  });
  const link = doc.querySelector("figure a");
  assert.equal(link.getAttribute("href"), "#local-e2");
  link.click();
  assert.deepEqual(calls, ["e2"]);
  renderReportPreview(doc.body, snapshot);
  const previewLink = doc.querySelector(".preview-finding figure a");
  const target = doc.querySelector(previewLink.getAttribute("href"));
  assert.ok(target.hidden);
  previewLink.click();
  assert.equal(target.hidden, false);
  assert.equal(doc.querySelector(".report-preview-page").hidden, true);
});

test("regional summary visuals require bound parent scope, contiguous partitions and consistent counts", () => {
  const f = contrastFixture();
  f.job.result.evidence.e3.metrics.median.candidate_count = 34;
  f.job.result.evidence.e3.metrics.median.unmatched_candidate_count = 4;
  const snapshot = structuredClone(makeInvestigationReport(f));
  const parent = snapshot.comparisons.find((c) => c.id === "e3");
  snapshot.regional_summaries = [
    {
      id: "region-toy",
      comparison_id: parent.id,
      window: { ...parent.window },
      parameters: { ...parent.parameters },
      split_s: 15,
      assignment: "original_candidate_time",
      filtering_context: "parent_full_window",
      normalization: "parent_full_window_means_and_original_std",
      regions: [3, 1].map((unmatched, index) => ({
        window: { start_s: index * 15, end_s: (index + 1) * 15 },
        sample_count: 1875,
        valid_count: 1500,
        methods: [
          {
            method: "median",
            metrics: {
              reference_candidate_count: 15,
              candidate_count: 15 + unmatched,
              matched_pair_count: 15,
              unmatched_reference_count: 0,
              unmatched_candidate_count: unmatched,
              cross_boundary_pair_count: 0,
            },
          },
        ],
      })),
      limitations: [],
    },
  ];
  const before = JSON.stringify(snapshot);
  const doc = new JSDOM().window.document;
  renderReport(doc.body, snapshot);
  const finding = doc.querySelector(".investigation-finding");
  assert.match(
    finding.querySelector(".finding-summary").textContent,
    /Median subtraction 2.*4 s: unmatched method candidates 0.*4/,
  );
  assert.equal(finding.querySelectorAll("figure").length, 3);
  const region = finding.querySelectorAll("figure")[2];
  assert.match(region.textContent, /3 unmatched method candidates/);
  assert.match(region.textContent, /1 unmatched method candidates/);
  for (const link of finding.querySelectorAll("a"))
    assert.ok(doc.querySelector(link.getAttribute("href")));
  // Parent totals remain 34 method / 30 matched / 4 unmatched in every case.
  // Cross-boundary counts are outbound, assigned by original-candidate time.
  for (const [candidateCounts, outbound, expectedFigures] of [
    [[0, 34], [0, 0], 2], // Unmatched candidates exceed the local total.
    [[17, 17], [0, 0], 2], // Plausible totals, impossible local match allocation.
    [[16, 18], [1, 0], 2], // Some outbound crossing, insufficient to explain allocation.
    [[17, 17], [1, 0], 3], // First region sends one match; second receives it.
    [[19, 15], [0, 1], 3], // Reverse: first receives, second sends one match.
  ]) {
    const variant = structuredClone(snapshot);
    variant.regional_summaries[0].regions.forEach((r, i) => {
      r.methods[0].metrics.candidate_count = candidateCounts[i];
      r.methods[0].metrics.cross_boundary_pair_count = outbound[i];
    });
    renderInvestigationFinding(doc.body, variant);
    assert.equal(
      doc.querySelectorAll("figure").length,
      expectedFigures,
      `candidate totals ${candidateCounts}; outbound crossings ${outbound}`,
    );
    if (expectedFigures === 2)
      assert.match(doc.body.textContent, /Regional distribution unavailable/);
    else assert.match(doc.body.textContent, /3 unmatched method candidates/);
  }
  for (const alter of [
    (r) => {
      r.comparison_id = "unrelated";
    },
    (r) => {
      r.parameters.highpass_hz = 99;
    },
    (r) => {
      r.regions[0].window.end_s -= 1;
    },
    (r) => {
      r.regions[0].methods.find(
        (m) => m.method === "median",
      ).metrics.unmatched_candidate_count += 1;
    },
    (r) => {
      r.regions[0].sample_count += 1;
    },
  ]) {
    const invalid = structuredClone(snapshot);
    for (const r of invalid.regional_summaries) alter(r);
    renderInvestigationFinding(doc.body, invalid);
    assert.equal(doc.querySelectorAll("figure").length, 2);
    assert.match(doc.body.textContent, /Regional distribution unavailable/);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test("setting sensitivity outcome requires a controlled measured difference and an inconclusive terminal state", () => {
  for (const status of [
    "inconclusive",
    "needs_information",
    "candidate",
    "failed",
  ])
    for (const variant of ["changed", "identical", "missing", "uncontrolled"]) {
      const f = contrastFixture();
      if (status === "failed") f.job.status = "failed";
      else f.job.result.conclusion.status = status;
      if (variant === "identical")
        f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms =
          f.job.result.evidence.e2.metrics.median.mean_absolute_shift_ms;
      if (variant === "missing")
        f.job.result.evidence.e3.metrics.median.mean_absolute_shift_ms = null;
      if (variant === "uncontrolled")
        f.job.result.evidence.e3.parameters.highpass_hz = 0.7;
      const doc = new JSDOM().window.document;
      renderInvestigationFinding(doc.body, makeInvestigationReport(f));
      assert.equal(
        doc
          .querySelector(".finding-outcome")
          .textContent.includes(
            "Setting sensitivity detected; preferred filter unresolved",
          ),
        status === "inconclusive" && variant === "changed",
      );
    }
});
test("unmatched-method overview uses its own zero baseline and keeps matched totals secondary", () => {
  const f = contrastFixture();
  Object.assign(f.job.result.evidence.e3.metrics.median, {
    candidate_count: 34,
    unmatched_candidate_count: 4,
  });
  const doc = new JSDOM().window.document;
  renderInvestigationFinding(doc.body, makeInvestigationReport(f));
  const figure = doc.querySelector(".finding-charts figure");
  assert.match(
    figure.querySelector("figcaption").textContent,
    /Unmatched method candidates/,
  );
  assert.deepEqual(
    [...figure.querySelectorAll(".finding-bar")].map((b) => b.style.width),
    ["0%", "100%"],
  );
  assert.match(
    doc.querySelector(".finding-summary").textContent,
    /unmatched method candidates 0.*4/,
  );
  assert.match(
    doc.querySelector(".finding-support").textContent,
    /Matched candidates 30 to 30; method candidates 30 to 34/,
  );
});

test("standalone themes share plot variables, validate preference and force legible light printing", () => {
  const snapshot = makeInvestigationReport(contrastFixture()),
    doc = new JSDOM().window.document;
  for (const [requested, resolved] of [
    [undefined, "light"],
    ["light", "light"],
    ["dark", "dark"],
    ["system", "light"],
    ["<script>", "light"],
  ]) {
    const loaded = new JSDOM(reportHTML(snapshot, doc, { theme: requested }))
      .window.document;
    assert.equal(loaded.documentElement.dataset.theme, resolved);
    const css = loaded.querySelector("style").textContent;
    for (const key of [
      "plot-bg",
      "plot-text",
      "plot-axis",
      "plot-grid",
      "plot-exclusion",
      "trace-raw",
      "trace-unchanged",
      "trace-median",
      "trace-highpass",
      "trace-reference",
      "marker-unmatched",
    ])
      assert.match(css, new RegExp(`--${key}:`));
    assert.match(
      css,
      /@media print\{:root,:root\[data-theme=dark\]\{--canvas:#f6f8fa;--surface:#ffffff/,
    );
    assert.equal(loaded.querySelectorAll("script,link,iframe,img").length, 0);
  }
  const contrast = (a, b) => {
    const lum = (hex) =>
      hex
        .match(/[a-f0-9]{2}/gi)
        .map((v) => parseInt(v, 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    const x = lum(a),
      y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const css = new JSDOM(
    reportHTML(snapshot, doc),
  ).window.document.querySelector("style").textContent;
  const themes = [
    ...css.matchAll(/(?:^:root|:root\[data-theme=dark\])\{([^}]+)}/g),
  ].slice(0, 2);
  assert.equal(themes.length, 2);
  for (const [, properties] of themes) {
    const colors = Object.fromEntries(
      [...properties.matchAll(/--([a-z-]+):(#(?:[a-f0-9]{6}))/g)].map(
        ([, k, v]) => [k, v],
      ),
    );
    for (const key of [
      "trace-raw",
      "trace-unchanged",
      "trace-median",
      "trace-highpass",
      "trace-reference",
      "plot-axis",
      "marker-unmatched",
    ])
      assert.ok(
        contrast(colors[key], colors["plot-bg"]) >= 3,
        `${key} contrast`,
      );
    assert.ok(contrast(colors["plot-text"], colors["plot-bg"]) >= 4.5);
    assert.ok(contrast(colors.secondary, colors.surface) >= 4.5);
  }
});
test("print rules keep table words and rows intact and reveal closed disclosure bodies without changing screen type or evidence", () => {
  const snapshot = makeInvestigationReport(contrastFixture()),
    before = JSON.stringify(snapshot),
    document = new JSDOM().window.document;
  const loaded = new JSDOM(reportHTML(snapshot, document)).window.document;
  const rules = [...loaded.styleSheets[0].cssRules],
    screen = rules.filter((r) => r.selectorText),
    print = rules
      .filter((r) => r.media?.mediaText === "print")
      .flatMap((r) => [...r.cssRules]);
  const style = (group, selector) =>
    group.filter((r) => r.selectorText === selector).at(-1)?.style;
  assert.equal(
    style(screen, ".evidence-table").getPropertyValue("font-size"),
    "1rem",
  );
  assert.equal(
    style(screen, ".evidence-table th,.evidence-table td").getPropertyValue(
      "padding",
    ),
    "0.5rem",
  );
  assert.equal(
    style(print, ".evidence-table").getPropertyValue("overflow-wrap"),
    "normal",
  );
  assert.equal(
    style(print, ".evidence-table").getPropertyValue("word-break"),
    "normal",
  );
  const cells = style(print, ".evidence-table th,.evidence-table td");
  assert.equal(cells.getPropertyValue("padding"), "3pt 4pt");
  assert.equal(cells.getPropertyValue("word-break"), "normal");
  assert.equal(cells.getPropertyValue("hyphens"), "none");
  const rows = style(print, ".evidence-table tr");
  assert.equal(rows.getPropertyValue("break-inside"), "avoid");
  assert.equal(rows.getPropertyValue("page-break-inside"), "avoid");
  const disclosure = style(print, ".readable-report details::details-content");
  assert.equal(disclosure.getPropertyValue("display"), "block");
  assert.equal(disclosure.getPropertyValue("content-visibility"), "visible");
  assert.equal(
    style(print, ".readable-report details>:not(summary)").getPropertyValue(
      "display",
    ),
    "block",
  );
  const details = loaded.querySelector("details");
  assert.ok(
    details && !details.open && details.children.length > 1,
    "screen disclosure stays closed, with its existing evidence body retained for print",
  );
  assert.match(
    loaded.querySelector(".evidence-table").textContent,
    /Unchanged/,
  );
  assert.match(
    loaded.querySelector(".evidence-table").textContent,
    /Comparator candidates/,
  );
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(loaded.querySelectorAll("script,link,iframe").length, 0);
  assert.match(
    loaded.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
    /script-src 'none'/,
  );
});
