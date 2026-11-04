import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  createApp,
  createTheme,
  formatMeasurement,
  formatExcludedPercent,
} from "../signaltrace/web/app.js";
import { drawChart, COLORS } from "../signaltrace/web/chart.js";
const html = await readFile(
  new URL("../signaltrace/web/index.html", import.meta.url),
  "utf8",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const recording = (id = "demo", channel = "ppg", modality = "ppg") => ({
  recording: {
    id,
    name: `Recording ${id}`,
    modality,
    channels: [{ name: channel, unit: "a.u." }],
    sample_count: 3,
    start_s: 0,
    end_s: 0.016,
    duration_s: 0.016,
    sample_rate_hz: 125,
    provenance: { source: "fixture" },
    has_reference: true,
  },
  inspection: {
    gap_count: 0,
    missing_by_channel: { [channel]: 0 },
    warnings: [],
  },
  plot: { times: [0, 0.008, 0.016], channels: { [channel]: [0, 1, 0] } },
});
const metrics = {
  centered_normalized_rmse: 0.12,
  reference_count: 4,
  candidate_count: 3,
  matched_count: 3,
  unmatched_reference_count: 1,
  unmatched_candidate_count: 0,
  mean_absolute_shift_ms: 8,
  maximum_absolute_shift_ms: 16,
};
const analysis = () => ({
  id: "analysis",
  recording_id: "demo",
  experiment_id: "experiment-1",
  channel: "ppg",
  goal: "pulse_timing",
  comparison: "synthetic_reference",
  window: { start_s: 0, end_s: 0.024 },
  metrics: { unchanged: metrics, median: metrics, highpass: metrics },
  exclusions: {
    excluded_fraction: 0.2,
    valid_count: 2,
    sample_count: 3,
    nonfinite_count: 0,
    flatline_count: 0,
    gap_after_indices: [],
    too_short_segments: [],
  },
  plot: {
    times: [0, 0.008, 0.016],
    raw: [0, 1, 0],
    unchanged: [null, 1, null],
    median: [null, 0.8, null],
    highpass: [null, 0.9, null],
    reference: [0, 1, 0],
    valid_mask: [false, true, false],
  },
  findings: [{ label: "Measured", detail: "Deterministic comparison" }],
  limitations: ["Nonclinical"],
});
function setup(overrides = {}, configure = () => {}) {
  const dom = new JSDOM(html, { url: "http://localhost:8765" }),
    doc = dom.window.document,
    calls = [];
  const experiments = new Map();
  let nextExperiment = 0;
  function saveRun(data, request) {
    const e = experiments.get(request.experiment_id);
    if (!e) return;
    const copy = structuredClone(data);
    copy.parameters ??= request.parameters;
    const run = {
      ...copy,
      label: data.run_label || `Run ${e.runs.length + 1}`,
      request: structuredClone(request),
      input_sha256: "fixture",
    };
    e.runs.push(run);
    e.run_count = e.runs.length;
  }
  const request = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({
      path,
      body,
      ...(path === "/api/investigations/import"
        ? { rawBody: options.body }
        : {}),
    });
    if (overrides[path]) {
      const res = await overrides[path](body, options);
      if (path === "/api/analyze" && res.ok) saveRun(await res.json(), body);
      // Accepted investigation snapshots echo the exact immutable submitted scope.
      if (path === "/api/investigations" && body && res.ok) {
        const job = await res.json();
        const { allow_network, ...savedRequest } = body;
        return response(
          structuredClone({
            ...job,
            request: { ...job.request, ...savedRequest },
          }),
        );
      }
      return res;
    }
    if (path === "/api/investigations/config")
      return response({
        available: true,
        key_configured: false,
        model: "muse-spark-1.3",
        history_mode: "stateless",
        max_rounds: 6,
        max_tool_attempts: 8,
      });
    if (path === "/api/credentials/meta")
      return response({ configured: true, source: "environment" });
    if (path.startsWith("/api/investigations?experiment_id="))
      return response({ jobs: [] });
    if (path === "/api/investigations" && !body) return response({ jobs: [] });
    if (path === "/api/explanations/config") return investigationConfig();
    if (path.startsWith("/api/explanations?investigation_id="))
      return response({ jobs: [] });
    if (path === "/api/experiments") {
      if (!body)
        return response({
          experiments: [...experiments.values()],
          storage: "memory",
        });
      const e = {
        id: `experiment-${++nextExperiment}`,
        protocol: body.protocol,
        recording_id: body.recording_id,
        run_count: 0,
        runs: [],
      };
      experiments.set(e.id, e);
      return response(structuredClone(e));
    }
    const match = path.match(/^\/api\/experiments\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const e = experiments.get(match[1]);
      if (!e) return response({ detail: "Expired" }, false);
      if (!match[2]) return response(structuredClone(e));
      if (match[2] === "recording") return response(recording(e.recording_id));
      if (match[2].startsWith("runs/") && !match[2].endsWith("/export"))
        return response(e.runs.find((r) => r.id === match[2].slice(5)));
      return response({ experiment: e });
    }
    const data =
      path === "/api/catalog"
        ? {
            meta: { connected: false },
            demos: [
              { id: "bidmc_01", label: "BIDMC" },
              { id: "synthetic_drift_noise", label: "Synthetic drift" },
            ],
          }
        : path === "/api/demo"
          ? recording()
          : path === "/api/preview"
            ? { columns: ["t", "pulse"], sample_rows: [["0", "1"]] }
            : path === "/api/import"
              ? recording("import", "pulse", body.modality)
              : path === "/api/analyze"
                ? analysis()
                : {};
    if (path === "/api/analyze") saveRun(data, body);
    return response(data);
  };
  configure(dom);
  const app = createApp(doc, request),
    $ = (id) => doc.getElementById(id);
  const submit = (id) =>
    $(id).dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  const file = async (
    name = "wave.csv",
    text = async () => "t,pulse\n0,1\n8,2\n16,1",
  ) => {
    chooseRecording({ $, app });
    Object.defineProperty($("csv-file"), "files", {
      configurable: true,
      value: [{ name, size: 50, text }],
    });
    $("csv-file").dispatchEvent(new dom.window.Event("change"));
    await tick();
  };
  return { dom, doc, app, $, calls, submit, file, experiments };
}

function themeMedia(dom, initial = false) {
  const listeners = new Set();
  const media = {
    matches: initial,
    addEventListener(name, fn) {
      assert.equal(name, "change");
      listeners.add(fn);
    },
    removeEventListener(name, fn) {
      assert.equal(name, "change");
      listeners.delete(fn);
    },
    update(matches) {
      media.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
  dom.window.matchMedia = (query) =>
    query.includes("color-scheme") ? media : null;
  return { media, listeners };
}

test("theme initializes before API work, persists locally and follows System only", () => {
  let m;
  const h = setup({}, (dom) => {
    m = themeMedia(dom, true);
  });
  const root = h.doc.documentElement,
    select = h.$("theme-preference");
  assert.equal(root.dataset.themePreference, "system");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(select.value, "system");
  assert.equal(h.calls.length, 0);
  select.focus();
  select.value = "light";
  select.dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(root.dataset.theme, "light");
  assert.equal(h.dom.window.localStorage.getItem("signaltrace.theme"), "light");
  m.media.update(true);
  assert.equal(root.dataset.theme, "light");
  assert.equal(h.doc.activeElement, select);
  select.value = "dark";
  select.dispatchEvent(new h.dom.window.Event("change"));
  m.media.update(false);
  assert.equal(root.dataset.theme, "dark");
  select.value = "system";
  select.dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(root.dataset.theme, "light");
  m.media.update(true);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(h.calls.length, 0);
  h.app.destroy();
  assert.equal(m.listeners.size, 0);
  m.media.update(false);
  select.value = "light";
  select.dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(root.dataset.theme, "dark");
});

test("theme validates stored preference and survives unavailable storage and media APIs", () => {
  for (const stored of ["dark", "light", "system", "invalid", "<script>"]) {
    const dom = new JSDOM(html, { url: "http://localhost:8765" });
    themeMedia(dom, true);
    dom.window.localStorage.setItem("signaltrace.theme", stored);
    const theme = createTheme(dom.window.document);
    assert.equal(
      dom.window.document.documentElement.dataset.theme,
      stored === "light" ? "light" : "dark",
    );
    assert.equal(
      dom.window.document.documentElement.dataset.themePreference,
      ["dark", "light", "system"].includes(stored) ? stored : "system",
    );
    theme.destroy();
    dom.window.close();
  }
  const h = setup({}, (dom) => {
    Object.defineProperty(dom.window, "localStorage", {
      get() {
        throw new Error("unavailable");
      },
    });
    dom.window.matchMedia = () => {
      throw new Error("unavailable");
    };
  });
  assert.equal(h.doc.documentElement.dataset.theme, "light");
  h.$("theme-preference").value = "dark";
  h.$("theme-preference").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.doc.documentElement.dataset.theme, "dark");
  assert.equal(h.calls.length, 0);
  h.app.destroy();
});
function chooseRecording(h) {
  if (h.app.getState().step !== "open") h.$("step-nav-open").click();
  if (h.$("source-picker").hidden) h.$("change-recording").click();
  assert.equal(h.$("csv-file").closest("[hidden]"), null);
}
function openSample(h) {
  chooseRecording(h);
  assert.equal(h.$("open-demo").closest("[hidden]"), null);
  h.$("open-demo").click();
}
async function openFixture(h) {
  await h.app.init();
  openSample(h);
  await tick();
  if (h.app.getState().view?.recording.modality === "ppg") {
    h.submit("protocol-form");
    await tick();
    h.$("continue-compare").click();
  }
}
function stageTitle(h) {
  return h.$(h.app.getState().step + "-title");
}
// Open the actual disclosure or stage; there is no hidden pane router.
function guidePane(h, id) {
  const targets = {
    history: "history-panel",
    technical: "technical-details",
    checks: "recording-checks",
    "manual-signal": "waveform-panel",
    report: "report-preview",
    exports: "export-technical",
    manual: "manual-comparison",
  };
  const target = h.$(targets[id] || id);
  assert.ok(target, `Known workspace destination: ${id}`);
  for (const parent of [target, ...ancestors(target)]) {
    if (parent.tagName === "DETAILS") parent.open = true;
    const toggle = h.$(parent.id + "-toggle");
    if (parent.hidden && toggle) toggle.click();
  }
  const stage = target.closest(".workflow-step");
  if (stage?.hidden) h.$("step-nav-" + stage.id.slice(5)).click();
}
function ancestors(node) {
  const result = [];
  while ((node = node.parentElement)) result.push(node);
  return result;
}
function sessionButton(h, id) {
  return [...h.$("session-list").querySelectorAll("button")].find(
    (b) => b.dataset.experimentId === id,
  );
}
async function forkFixture(h) {
  h.$("step-nav-open").click();
  edit(h, "experiment-name", "Second experiment");
  h.submit("protocol-form");
  await tick();
}
const response = (data, ok = true) => ({
  ok,
  status: ok ? 200 : 422,
  json: async () => data,
  blob: async () => new Blob([JSON.stringify(data)]),
});
const investigationConfig = () =>
  response({
    available: true,
    key_configured: true,
    model: "muse-spark-1.3",
    history_mode: "stateless",
    max_rounds: 6,
    max_tool_attempts: 8,
  });
function investigationJob(
  status = "running",
  conclusionStatus = "candidate",
  changes = {},
) {
  const comparison = {
    kind: "comparison",
    window: { start_s: 0, end_s: 0.024 },
    parameters: { median_window_s: 1, highpass_hz: 0.5, edge_guard_s: 3 },
    sample_count: 3,
    valid_count: 2,
    excluded_fraction: 1 / 3,
    nonfinite_count: 0,
    exact_flat_sample_count: 0,
    gap_count: 0,
    valid_interval_count: 1,
    metrics: Object.fromEntries(
      ["unchanged", "median", "highpass"].map((method) => [
        method,
        { ...metrics, comparator_count: 4, unmatched_comparator_count: 1 },
      ]),
    ),
  };
  const evidence = {
    e1: {
      kind: "inspection",
      window: { start_s: 0, end_s: 0.024 },
      sample_count: 3,
      finite_count: 3,
      missing_count: 0,
      gap_count: 0,
      missing_interval_count: 0,
    },
    e2: comparison,
  };
  const trace = [
    { round: 1, tool: "inspect", status: "success", evidence_id: "e1" },
    { round: 2, tool: "compare", status: "success", evidence_id: "e2" },
  ];
  return {
    id: "job-1",
    status,
    request: {
      request_id: "test-request",
      experiment_id: "experiment-1",
      recording_id: "demo",
      channel: "ppg",
      start_s: 0,
      end_s: 0.024,
      target: "pulse_timing",
      question: "Investigate timing",
      notes: "",
    },
    progress: { rounds: 2, tool_attempts: 2, evidence, trace },
    result:
      status === "running"
        ? null
        : {
            evidence,
            trace,
            rounds: 3,
            tool_attempts: 2,
            limitations: ["Research only"],
            conclusion:
              status === "failed"
                ? null
                : {
                    status: conclusionStatus,
                    narrative: "Review these measured changes.",
                    evidence_ids: ["e1", "e2"],
                    questions:
                      conclusionStatus === "needs_information"
                        ? ["What acquisition settings were used?"]
                        : [],
                    candidate:
                      conclusionStatus === "candidate"
                        ? { comparison_id: "e2", method: "median" }
                        : null,
                  },
          },
    error:
      status === "failed" ? { category: "transport", http_status: null } : null,
    ...changes,
  };
}
function consentInvestigation(h) {
  h.$("investigation-consent").checked = true;
  h.$("investigation-consent").dispatchEvent(new h.dom.window.Event("change"));
}
test("Meta configuration is presence-only, never submits automatically, and missing key gates consent", async () => {
  const h = setup();
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    0,
  );
  assert.equal(h.$("investigate").disabled, true);
  assert.match(h.$("investigation-config").textContent, /server process/);
  assert.equal(h.$("meta-api-key").type, "password");
  assert.equal(h.$("meta-api-key").value, "");
  h.app.destroy();
  const configured = setup({
    "/api/investigations/config": investigationConfig,
  });
  await openFixture(configured);
  assert.equal(configured.$("investigation-consent").checked, false);
  assert.equal(configured.$("investigate").disabled, true);
  assert.match(
    configured.$("meta-status").textContent,
    /connection unverified/,
  );
  assert.match(
    configured.$("investigation-config").textContent,
    /Authentication and connection have not been verified/,
  );
  assert.equal(
    configured.$("investigation-question").value,
    configured.app.getState().experiment.protocol.research_question,
  );
  assert.match(
    configured.$("investigation-disclosure").textContent,
    /Raw waveforms[\s\S]*stay local/,
  );
  assert.match(
    configured.$("investigation-disclosure").textContent,
    /original samples[\s\S]*synthetic-reference/,
  );
  assert.equal(
    configured.calls.filter((c) => c.path === "/api/investigations").length,
    0,
  );
  configured.app.destroy();
});

test("first-use setup skips offline; key save and clear refresh both Meta paths without consent or model calls", async () => {
  const source = retainedJob();
  let configured = false;
  const h = retainedSetup([source], {
    "/api/credentials/meta": (body, options) => {
      if (options.method === "PUT") {
        assert.deepEqual(body, {
          api_key: "FAKE_TEST_KEY_no_real_credential_218",
        });
        assert.equal(options.headers["x-signaltrace-request"], "1");
        configured = true;
      } else if (options.method === "DELETE") configured = false;
      return response({ configured, source: configured ? "browser" : "none" });
    },
    "/api/investigations/config": () =>
      response({ available: true, key_configured: configured }),
    "/api/explanations/config": () =>
      response({ available: true, key_configured: configured }),
  });
  await h.app.init();
  assert.equal(h.$("meta-credentials-dialog").open, true);
  h.$("meta-credentials-skip").click();
  assert.equal(h.$("meta-credentials-dialog").open, false);
  await selectRetained(h, source.id);
  assert.equal(h.$("download-report").disabled, false);
  assert.equal(h.$("explain").disabled, true);
  h.$("investigation-consent").checked = true;
  h.$("explanation-consent").checked = true;
  h.$("meta-credentials-open").click();
  h.$("meta-api-key").value = "FAKE_TEST_KEY_no_real_credential_218";
  h.submit("meta-credentials-form");
  assert.equal(h.$("meta-api-key").value, "");
  await tick();
  await tick();
  assert.match(
    h.$("investigation-config").textContent,
    /Server key configured/,
  );
  assert.match(h.$("explanation-config").textContent, /Server key configured/);
  assert.equal(h.$("investigation-consent").checked, false);
  assert.equal(h.$("explanation-consent").checked, false);
  assert.equal(h.$("explain").disabled, true);
  assert.ok(!JSON.stringify(h.app.getState()).includes("FAKE_TEST_KEY"));
  assert.ok(!h.doc.documentElement.outerHTML.includes("FAKE_TEST_KEY"));
  consentExplanation(h);
  assert.equal(h.$("explain").disabled, false);
  h.$("meta-credentials-clear").click();
  assert.equal(h.$("explain").disabled, true);
  await tick();
  await tick();
  assert.match(h.$("investigation-config").textContent, /unavailable/);
  assert.match(h.$("explanation-config").textContent, /unavailable/);
  assert.match(h.$("meta-status").textContent, /not configured/);
  assert.equal(
    h.calls.filter(
      (c) =>
        ["/api/investigations", "/api/explanations"].includes(c.path) && c.body,
    ).length,
    0,
  );
  h.app.destroy();
});
test("investigation validates question, notes and unreduced interval before POST and sends bounded fields only", async () => {
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": (body) =>
      response(
        investigationJob("completed", "inconclusive", {
          request: { ...body, target: "pulse_timing" },
        }),
      ),
  });
  await openFixture(h);
  for (const [id, value] of [
    ["investigation-question", " "],
    ["investigation-notes", "x".repeat(1001)],
    ["window-end", "0.008"],
    ["window-end", "100"],
  ]) {
    h.$("investigation-question").value = "What changes?";
    h.$("investigation-notes").value = "Local notes";
    h.$("window-end").value = "0.024";
    h.$(id).value = value;
    consentInvestigation(h);
    h.submit("investigation-form");
    assert.equal(
      h.calls.filter((c) => c.path === "/api/investigations").length,
      0,
    );
    assert.match(h.$("investigation-error").textContent, /valid interval/);
  }
  h.$("window-end").value = "0.024";
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  const body = h.calls.find((c) => c.path === "/api/investigations").body;
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      "request_id",
      "experiment_id",
      "recording_id",
      "channel",
      "start_s",
      "end_s",
      "question",
      "notes",
      "allow_network",
    ].sort(),
  );
  assert.match(body.request_id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(body.allow_network, true);
  assert.equal(h.$("investigation-consent").checked, false);
  h.app.destroy();
});
test("optional limits require researcher confirmation and bind the exact request without defaults", async () => {
  let job;
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": (body) => {
      job = investigationJob("completed", "inconclusive", {
        request: { ...body, target: "pulse_timing" },
      });
      job.result.context = { requirements: body.requirements };
      job.result.requirement_assessment = {
        status: "violated",
        next_action: "Inspect the tested setting",
        comparisons: [
          {
            comparison_id: "e2",
            method: "highpass",
            window: job.result.evidence.e2.window,
            parameters: job.result.evidence.e2.parameters,
            status: "violated",
            checks: [
              {
                metric: "max_timing_shift_ms",
                limit: 2,
                value: 16,
                status: "violated",
              },
            ],
          },
        ],
      };
      return response(job);
    },
    "/api/investigations/job-1/comparisons/e2": () =>
      response(comparisonPayload(job, "e2")),
  });
  await openFixture(h);
  const change = (id, val, type = "change") => {
    const input = h.$(id);
    if (typeof val === "boolean") input.checked = val;
    else input.value = val;
    input.dispatchEvent(new h.dom.window.Event(type));
  };
  assert.equal(h.$("requirements-options").hidden, true);
  const limitsToggle = h.$("requirements-options-toggle");
  assert.equal(limitsToggle.getAttribute("aria-expanded"), "false");
  limitsToggle.focus();
  limitsToggle.click();
  assert.equal(h.$("requirements-options").hidden, false);
  assert.equal(limitsToggle.getAttribute("aria-expanded"), "true");
  assert.match(limitsToggle.textContent, /^Hide research limits/);
  assert.equal(h.doc.activeElement, limitsToggle);
  limitsToggle.click();
  assert.equal(h.$("requirements-options").hidden, true);
  assert.equal(limitsToggle.getAttribute("aria-expanded"), "false");
  assert.equal(h.doc.activeElement, limitsToggle);
  limitsToggle.click();
  assert.equal(h.$("requirements-fields").hidden, true);
  change("requirements-enabled", true);
  change("requirements-method", "highpass");
  change("requirement-max_timing_shift_ms", "0", "input");
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, true);
  assert.match(h.$("requirements-status").textContent, /Confirm/);
  change("requirements-confirmed", true);
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, false);
  change("requirement-max_timing_shift_ms", "2", "input");
  assert.equal(h.$("requirements-confirmed").checked, false);
  assert.equal(h.$("investigation-consent").checked, false);
  change("requirements-confirmed", true);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  const body = h.calls.find((c) => c.path === "/api/investigations").body;
  assert.deepEqual(body.requirements, {
    confirmed: true,
    method: "highpass",
    criteria: { max_timing_shift_ms: 2 },
  });
  assert.equal(h.$("investigation-error").hidden, true);
  assert.match(
    h.$("investigation-requirements").textContent,
    /violate your confirmed limits/,
  );
  h.$("investigation-requirements").querySelector("a").click();
  await tick();
  assert.equal(
    h
      .$("investigation-visuals")
      .querySelector('[data-method="highpass"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  h.$("review-investigation").click();
  await tick();
  assert.equal(h.$("report-requirements").hidden, false);
  h.$("report-requirements").querySelector("a").click();
  assert.equal(
    h
      .$("report-visuals")
      .querySelector('[data-method="highpass"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  change("window-end", "0.016", "input");
  assert.equal(h.$("requirements-confirmed").checked, false);
  h.app.destroy();
});

test("pending investigation prevents duplicate clicks, polls without overlap or modal, and preserves manual evidence", async () => {
  const post = deferred(),
    poll = deferred(),
    clock = presentationHarness();
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => post.promise,
      "/api/investigations/job-1": () => poll.promise,
    },
    clock.configure,
  );
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const manual = h.app.getState().result,
    history = structuredClone(h.app.getState().runs);
  consentInvestigation(h);
  h.submit("investigation-form");
  h.submit("investigation-form");
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  clock.advance(5000);
  assert.equal(clock.opened, 0);
  assert.equal(h.$("request-activity").hidden, true);
  post.resolve(response(investigationJob()));
  await tick();
  assert.match(
    h.$("investigation-status").textContent,
    /2 \/ 6 rounds started/,
  );
  assert.equal(h.$("investigation-trace").children.length, 2);
  clock.advance(1000);
  await tick();
  clock.advance(10000);
  await tick();
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations/job-1").length,
    1,
  );
  h.$("step-nav-inspect").click();
  const focus = h.doc.activeElement;
  poll.resolve(response(investigationJob("completed")));
  await tick();
  assert.match(
    h.$("investigation-result-title").textContent,
    /Candidate for review: Median/,
  );
  assert.equal(h.doc.activeElement, focus);
  assert.equal(h.app.getState().result, manual);
  assert.deepEqual(h.app.getState().runs, history);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.opened, 0);
  h.app.destroy();
});
test("poll failure stops automatic activity and explicit refresh reconnects without resubmitting", async () => {
  const clock = presentationHarness();
  let finished = false;
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(investigationJob()),
      "/api/investigations/job-1": () => {
        if (!finished) throw new Error("private transport detail");
        return response(investigationJob("completed", "needs_information"));
      },
      "/api/investigations?experiment_id=experiment-1": () =>
        response({
          jobs: finished
            ? [investigationJob("completed", "needs_information")]
            : [],
        }),
    },
    clock.configure,
  );
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  clock.advance(1000);
  await tick();
  assert.match(
    h.$("investigation-error").textContent,
    /Status polling stopped/,
  );
  assert.doesNotMatch(
    h.$("investigation-error").textContent,
    /private transport/,
  );
  clock.advance(10000);
  await tick();
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations/job-1").length,
    1,
  );
  finished = true;
  h.$("investigation-refresh").click();
  await tick();
  assert.match(
    h.$("investigation-result-title").textContent,
    /More information needed/,
  );
  assert.match(
    h.$("investigation-questions").textContent,
    /acquisition settings/,
  );
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  assert.equal(h.$("investigation-consent").checked, false);
  h.app.destroy();
});
test("candidate content uses safe text, evidence citations focus exact local measurements, and changes label historical scope", async () => {
  const job = investigationJob("completed");
  const injected = '<img src=x onerror="globalThis.compromised=true">';
  job.result.conclusion.narrative = injected;
  job.result.conclusion.questions = [injected];
  job.result.limitations = [injected];
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.equal(h.$("investigation-narrative").textContent, injected);
  assert.equal(h.$("investigation-result").querySelector("img, script"), null);
  assert.match(
    h.$("investigation-scope").textContent,
    /\[0, 0.024\).*original samples/,
  );
  assert.match(h.$("investigation-evidence").textContent, /33.3% excluded/);
  assert.match(
    h.$("investigation-evidence").textContent,
    /Timing shift: 8 ms mean/,
  );
  assert.match(h.$("investigation-evidence").textContent, /high-pass 0.5 Hz/);
  const links = h.$("investigation-citations").querySelectorAll("a");
  assert.equal(links.length, 2);
  links[1].click();
  assert.equal(h.doc.activeElement.id, "investigation-evidence-1");
  assert.equal(h.$("investigation-historical").hidden, true);
  consentInvestigation(h);
  edit(h, "window-end", "0.016");
  assert.equal(h.$("investigation-historical").hidden, false);
  assert.equal(h.$("investigation-consent").checked, false);
  assert.match(h.$("investigation-scope").textContent, /0.024/);
  h.app.destroy();
});
test("failed job retains measured evidence, no narrative, and separate exact investigation export", async () => {
  const job = investigationJob("failed");
  const exact = {
    ...job.result,
    comparisons: { e2: { raw: [0, 1, 0], exact_recipe: true } },
  };
  job.result.conclusion = {
    narrative: "Must not show failed model narrative",
    evidence_ids: [],
    questions: [],
  };
  let exported, filename;
  const originalCreate = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    exported = blob;
    return "blob:investigation";
  };
  URL.revokeObjectURL = () => {};
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(job),
      "/api/investigations/job-1/export": () => response(exact),
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = function () {
        filename = this.download;
      };
    },
  );
  try {
    await openFixture(h);
    consentInvestigation(h);
    h.submit("investigation-form");
    await tick();
    assert.match(
      h.$("investigation-result-title").textContent,
      /failed.*partial evidence/,
    );
    assert.equal(h.$("investigation-narrative").textContent, "");
    assert.match(
      h.$("investigation-failure-detail").textContent,
      /Failure: transport.*Check connectivity/,
    );
    assert.match(h.$("investigation-evidence").textContent, /Local comparison/);
    assert.equal(h.$("export-investigation").hidden, false);
    h.$("export-investigation").click();
    await tick();
    assert.equal(filename, "signaltrace-investigation.json");
    assert.deepEqual(JSON.parse(await exported.text()), exact);
    assert.equal(
      h.calls.filter(
        (c) => c.path.includes("/experiments/") && c.path.endsWith("/export"),
      ).length,
      0,
    );
    assert.match(
      h.$("investigation-export-status").textContent,
      /offline numerical replay/,
    );
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    h.app.destroy();
  }
});
test("lost start response is never retried, refresh restores request association and accepted outcome", async () => {
  let posted;
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": (body) => {
      posted = body;
      throw new Error("lost response");
    },
    "/api/investigations?experiment_id=experiment-1": () =>
      response({
        jobs: posted
          ? [
              investigationJob("completed", "inconclusive", {
                request: { ...posted, target: "pulse_timing" },
              }),
            ]
          : [],
      }),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.match(
    h.$("investigation-error").textContent,
    /start response was lost/,
  );
  consentInvestigation(h);
  h.submit("investigation-form");
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.$("investigation-refresh").click();
  await tick();
  assert.match(h.$("investigation-result-title").textContent, /Inconclusive/);
  assert.equal(h.$("investigate").disabled, true);
  assert.equal(h.$("investigation-consent").checked, false);
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, false);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.app.destroy();
});
test("source switching detaches polling, late POST cannot attach to a replacement and reopen restores exact jobs", async () => {
  const post = deferred(),
    clock = presentationHarness();
  let saved;
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": (body) => {
        saved = investigationJob("running", "candidate", {
          request: { ...body, target: "pulse_timing" },
        });
        return post.promise;
      },
      "/api/investigations/job-1": () =>
        response(
          investigationJob("completed", "inconclusive", {
            request: saved.request,
          }),
        ),
      "/api/investigations?experiment_id=experiment-1": () =>
        response({ jobs: saved ? [saved] : [] }),
      "/api/import": () => response(recording("replacement", "pulse", "ppg")),
    },
    clock.configure,
  );
  await openFixture(h);
  const original = h.app.getState().experiment.id;
  consentInvestigation(h);
  h.submit("investigation-form");
  await h.file();
  h.submit("import-form");
  await tick();
  const focus = h.doc.activeElement;
  post.resolve(response(saved));
  await tick();
  assert.equal(h.app.getState().view.recording.id, "replacement");
  assert.equal(h.$("investigation-result").hidden, true);
  assert.equal(h.doc.activeElement, focus);
  assert.equal(clock.timers.size, 0);
  sessionButton(h, original).click();
  await tick();
  assert.equal(h.app.getState().experiment.id, original);
  assert.match(h.$("investigation-scope").textContent, /ppg.*0.024/);
  assert.equal(h.$("investigation-consent").checked, false);
  h.app.destroy();
  assert.equal(clock.timers.size, 0);
});
test("destroy stops poll timers and ignores pending status and export responses", async () => {
  const clock = presentationHarness(),
    poll = deferred();
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(investigationJob()),
      "/api/investigations/job-1": () => poll.promise,
    },
    clock.configure,
  );
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  clock.advance(1000);
  await tick();
  const before = h.$("investigation-result").textContent;
  h.app.destroy();
  poll.resolve(response(investigationJob("completed")));
  await tick();
  assert.equal(h.$("investigation-result").textContent, before);
  assert.equal(clock.timers.size, 0);
  clock.advance(10000);
  await tick();
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations/job-1").length,
    1,
  );
});
test("definite start rejection is safe, has no automatic retry and requires renewed consent", async () => {
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: "provider secret sentinel" }),
    }),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.equal(h.$("investigate").disabled, true);
  assert.equal(h.$("investigation-consent").checked, false);
  assert.doesNotMatch(h.$("investigation-error").textContent, /sentinel/);
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, false);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.app.destroy();
});

test("local availability rejection displays the exact actionable safe message without a model conclusion or automatic retry", async () => {
  const message =
    "Insufficient valid data: choose a longer window containing finite, varying segments beyond the 3-second edge guards. No Meta model request was made.";
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response({ detail: message }, false),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.equal(h.$("investigation-error").textContent, message);
  assert.equal(h.$("investigation-error").hidden, false);
  assert.equal(h.$("investigation-result").hidden, true);
  assert.equal(h.$("investigation-narrative").textContent, "");
  assert.equal(h.$("investigation-consent").checked, false);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, false);
  h.app.destroy();
});
test("definitive stale-active 404 releases the local lock with an explicit unrecoverable-outcome notice", async () => {
  const clock = presentationHarness();
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(investigationJob()),
      "/api/investigations/job-1": () => ({ ok: false, status: 404 }),
    },
    clock.configure,
  );
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.equal(h.$("investigation-consent").disabled, true);
  h.$("investigation-refresh").click();
  await tick();
  assert.match(
    h.$("investigation-status").textContent,
    /no longer retained.*outcome cannot be recovered/,
  );
  assert.equal(h.$("investigation-consent").disabled, false);
  assert.equal(h.$("investigation-result").hidden, true);
  assert.equal(h.$("investigate").disabled, true);
  consentInvestigation(h);
  assert.equal(h.$("investigate").disabled, false);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.app.destroy();
});
test("failed source replacement during status refresh cannot strand the refresh busy flag or accept its stale list", async () => {
  const list = deferred();
  let queries = 0;
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations?experiment_id=experiment-1": () =>
      ++queries === 2 ? list.promise : response({ jobs: [] }),
    "/api/demo": () =>
      queries >= 2
        ? response({ detail: "source failed" }, false)
        : response(recording()),
  });
  await openFixture(h);
  h.$("investigation-refresh").click();
  await tick();
  assert.equal(h.$("investigation-refresh").disabled, true);
  openSample(h);
  await tick();
  list.resolve(response({ jobs: [investigationJob("completed")] }));
  await tick();
  assert.equal(h.app.getState().experiment.id, "experiment-1");
  assert.equal(h.$("investigation-refresh").disabled, false);
  assert.equal(h.$("investigation-result").hidden, true);
  h.$("return-recording").click();
  h.$("step-nav-compare").click();
  h.$("investigation-refresh").click();
  await tick();
  assert.equal(h.$("investigation-refresh").getAttribute("aria-busy"), "false");
  h.app.destroy();
});
test("failed responses show allowlisted categories and diagnostics only; changing question or notes requires new consent", async () => {
  const job = investigationJob("failed");
  job.result.error = {
    category: "invalid_response",
    http_status: 200,
    response_code: "incomplete_max_output_tokens",
  };
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
  });
  await openFixture(h);
  consentInvestigation(h);
  edit(h, "investigation-notes", "Changed acquisition settings");
  assert.equal(h.$("investigation-consent").checked, false);
  consentInvestigation(h);
  edit(h, "investigation-question", "A different question?");
  assert.equal(h.$("investigation-consent").checked, false);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.match(
    h.$("investigation-failure-detail").textContent,
    /invalid_response.*HTTP 200.*incomplete_max_output_tokens/,
  );
  job.result.error = {
    category: "private exception sentinel",
    response_code: "private response sentinel",
  };
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.doesNotMatch(
    h.$("investigation-failure-detail").textContent,
    /sentinel/,
  );
  assert.match(
    h.$("investigation-failure-detail").textContent,
    /provider_failure/,
  );
  h.app.destroy();
});
test("switching source during export suppresses stale investigation download without changing local manual work", async () => {
  const clock = presentationHarness(),
    download = deferred();
  let downloaded = false;
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(investigationJob("completed")),
      "/api/investigations/job-1/export": () => download.promise,
    },
    (dom) => {
      clock.configure(dom);
      dom.window.HTMLAnchorElement.prototype.click = () => {
        downloaded = true;
      };
    },
  );
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("export-investigation").click();
  await tick();
  openSample(h);
  await tick();
  download.resolve(response({ exact: "bundle" }));
  await tick();
  assert.equal(downloaded, false);
  assert.equal(h.$("investigation-result").hidden, true);
  assert.equal(h.$("investigation-export-status").textContent, "");
  assert.equal(clock.opened, 0);
  h.app.destroy();
});
test("waveform guide follows original inspection and plotted exclusions without changing analysis", async () => {
  const source = recording();
  source.inspection.gap_count = 1;
  source.inspection.missing_by_channel.ppg = 2;
  let excluded = true;
  const h = setup({
    "/api/demo": () => response(source),
    "/api/analyze": () => {
      const data = analysis();
      if (!excluded) {
        data.exclusions.excluded_fraction = 0;
        data.exclusions.valid_count = 3;
        data.plot.valid_mask = [true, true, true];
      }
      return response(data);
    },
  });
  await openFixture(h);
  h.$("back-inspect").click();
  const toggle = h.$("waveform-guide-toggle");
  assert.equal(h.$("waveform-guide").hidden, true);
  assert.equal(
    h.doc.getElementById(toggle.getAttribute("aria-controls")),
    h.$("waveform-guide"),
  );
  toggle.focus();
  toggle.click();
  assert.equal(h.doc.activeElement, toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(h.$("waveform-guide").hidden, false);
  assert.equal(h.$("guide-exclusions").hidden, true);
  assert.match(
    h.$("guide-integrity").textContent,
    /2 missing samples.*1 timestamp gaps/,
  );
  h.$("continue-compare").click();
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("guide-exclusions").hidden, false);
  assert.match(h.$("window-label").textContent, /Analyzed:.*\[0, 0.024\) s/);
  const result = h.app.getState().result;
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(h.app.getState().result, result);
  h.$("back-inspect").click();
  assert.equal(h.$("guide-exclusions").hidden, true);
  assert.equal(h.$("legend").textContent, "Original");
  assert.match(h.$("guide-source").textContent, /without filtering/);
  h.$("continue-compare").click();
  excluded = false;
  edit(h, "median-window", "3");
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("guide-exclusions").hidden, true);
});

test("waveform guide replaces PPG comparison instructions on inspection-only sources and restores them for PPG", async () => {
  let modality = "ppg";
  const h = setup({
    "/api/demo": () => response(recording("demo", "signal", modality)),
    "/api/analyze": () => response({ ...analysis(), channel: "signal" }),
  });
  await openFixture(h);
  h.$("waveform-guide-toggle").click();
  h.submit("analysis-form");
  await tick();
  assert.match(h.$("guide-window").textContent, /Use visible window/);
  assert.equal(h.$("guide-exclusions").hidden, false);

  for (const next of ["ecg", "eeg", "other"]) {
    modality = next;
    h.$("step-nav-open").click();
    openSample(h);
    await tick();
    assert.equal(h.app.getState().view.recording.modality, next);
    assert.equal(h.app.getState().step, "inspect");
    assert.equal(h.$("waveform-guide").hidden, false);
    assert.equal(h.$("continue-compare").disabled, true);
    assert.equal(h.$("guide-exclusions").hidden, true);
    assert.match(h.$("guide-source").textContent, /inspection only/);
    assert.match(
      h.$("guide-window").textContent,
      /display controls.*comparison is unavailable/,
    );
    assert.doesNotMatch(
      h.$("guide-window").textContent,
      /Use visible window|before comparing/,
    );
    assert.equal(h.$("legend").textContent, "Original");
    assert.equal(h.app.getState().result, null);
  }

  modality = "ppg";
  h.$("step-nav-open").click();
  openSample(h);
  await tick();
  h.submit("protocol-form");
  await tick();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.$("continue-compare").disabled, false);
  assert.match(h.$("guide-window").textContent, /Use visible window/);
  assert.doesNotMatch(h.$("guide-window").textContent, /unavailable/);
  assert.doesNotMatch(h.$("guide-source").textContent, /inspection only/);
  assert.equal(h.calls.filter(({ path }) => path === "/api/analyze").length, 1);
});

for (const target of ["pulse_timing", "waveform_sensitivity"]) {
  test(`result summary uses actual ${target} values and preserves missing metrics and evidence`, async () => {
    const data = analysis();
    data.goal = target;
    data.comparison = "original_sensitivity";
    const primary =
      target === "pulse_timing"
        ? "mean_absolute_shift_ms"
        : "centered_normalized_rmse";
    data.metrics.median = { ...metrics, [primary]: null };
    data.metrics.highpass = { ...metrics, [primary]: 0 };
    const h = setup({ "/api/analyze": () => response(data) });
    await h.app.init();
    openSample(h);
    await tick();
    if (target === "waveform_sensitivity") h.$("target-waveform").click();
    h.submit("protocol-form");
    await tick();
    h.$("continue-compare").click();
    h.submit("analysis-form");
    await tick();
    const intro = h.$("results-intro").textContent;
    assert.match(intro, /median subtraction not available; high-pass 0/);
    assert.match(intro, /original samples/);
    assert.match(h.$("goal-note").textContent, /\[0, 0.024\) s/);
    assert.doesNotMatch(intro, /synthetic reference/);
    for (const method of h.$("method-comparison").children) {
      const groups = method.querySelectorAll("dl > div");
      assert.equal(groups.length, 4);
      assert.equal(groups[0].className, "target-metric");
      assert.match(
        groups[0].querySelector("dt").textContent,
        target === "pulse_timing" ? /Timing shift/ : /Waveform difference/,
      );
      assert.equal(
        groups[2].querySelector("dt").textContent,
        "Unmatched original peaks",
      );
      assert.equal(groups[2].querySelector("dd").textContent, "1");
      assert.equal(
        groups[3].querySelector("dt").textContent,
        "Unmatched method peaks",
      );
      assert.equal(groups[3].querySelector("dd").textContent, "0");
    }
    assert.deepEqual(
      JSON.parse(h.$("metric-details").textContent),
      data.metrics,
    );
    edit(h, "edge-guard", "0.5");
    assert.equal(h.$("results").hidden, true);
  });
}

test("history empty state, structured scopes and selection counts retain native focus", async () => {
  const h = setup({ "/api/analyze": uniqueAnalysis() });
  await openFixture(h);
  assert.equal(h.$("history-empty").hidden, false);
  assert.match(h.$("history-empty").textContent, /No saved runs/);
  assert.equal(
    h.$("history-selection").textContent,
    "0/2 runs selected for comparison",
  );
  for (const value of ["2", "3", "4"]) {
    edit(h, "median-window", value);
    h.submit("analysis-form");
    await tick();
  }
  assert.equal(h.$("history-empty").hidden, true);
  const rows = h.$("run-history").children;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelectorAll("dl > div").length, 4);
  assert.match(
    rows[0].querySelector("dl").textContent,
    /ppg \/ \[0, 0.024\) s/,
  );
  assert.match(
    rows[0].querySelector("dl").textContent,
    /Median 2 s.*high-pass 0.35 Hz.*edge guard 3 s/,
  );
  assert.match(
    rows[0].querySelector("dl").textContent,
    /Unchanged, median subtraction, high-pass/,
  );
  assert.equal(rows[2].classList.contains("is-current"), true);
  guidePane(h, "history");
  const checks = h.$("run-history").querySelectorAll("input");
  checks[0].focus();
  checks[0].click();
  assert.equal(h.doc.activeElement, checks[0]);
  assert.equal(
    h.$("history-selection").textContent,
    "1/2 runs selected for comparison",
  );
  checks[1].focus();
  checks[1].click();
  assert.equal(
    h.$("history-selection").textContent,
    "2/2 runs selected for comparison",
  );
  assert.equal(checks[2].disabled, true);
  assert.equal(h.$("run-comparison").hidden, false);
  assert.equal(h.$("run-history").querySelectorAll("input")[1], checks[1]);
  assert.equal(h.doc.activeElement, checks[1]);
  checks[1].click();
  assert.equal(checks[2].disabled, false);
  assert.equal(h.$("run-comparison").hidden, true);
  assert.equal(rows[2].classList.contains("is-current"), true);
});

test("invalid current inputs explain export gating while retained bundle stays downloadable", async () => {
  const h = setup({ "/api/analyze": uniqueAnalysis() });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  edit(h, "highpass", "0.5");
  assert.equal(h.app.getState().result, null);
  assert.equal(h.$("continue-export").disabled, false);
  h.$("continue-export").click();
  assert.equal(h.app.getState().step, "export");
  assert.equal(h.$("export").disabled, true);
  assert.equal(h.$("export-experiment").disabled, false);
  assert.match(
    h.$("export-summary").textContent,
    /no valid run.*bundle is still available/,
  );
  let filename;
  h.dom.window.HTMLAnchorElement.prototype.click = function () {
    filename = this.download;
  };
  h.$("export").click();
  assert.equal(filename, undefined);
  h.$("export-experiment").click();
  await tick();
  assert.equal(filename, "signaltrace-experiment.json");
  assert.match(h.$("status").textContent, /download requested/);
  h.$("back-compare").click();
  h.$("run-history").querySelector("button").click();
  await tick();
  assert.equal(h.$("export").disabled, false);
  h.$("continue-export").click();
  assert.match(h.$("export-summary").textContent, /\[0, 0.024\) s/);
  assert.doesNotMatch(h.$("export-summary").textContent, /disabled/);
});

test("initial synthetic demo, explicit analysis, complete metrics and export", async () => {
  const h = setup();
  await openFixture(h);
  assert.equal(
    h.calls.find((c) => c.path === "/api/demo").body.demo_id,
    "synthetic_drift_noise",
  );
  assert.equal(h.$("demo-select").disabled, false);
  assert.equal(h.$("window-end").value, "0.024");
  assert.equal(
    h.calls.some((c) => c.path === "/api/analyze"),
    false,
  );
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("results").hidden, false);
  assert.equal(h.$("metrics").querySelectorAll("tbody tr").length, 8);
  assert.match(h.$("exclusions").textContent, /20%/);
  assert.match(h.$("comparison-label").textContent, /evaluation only/);
  let downloaded = false;
  h.dom.window.HTMLAnchorElement.prototype.click = function () {
    downloaded = this.download === "signaltrace-analysis.json";
  };
  h.$("continue-export").click();
  h.$("export").click();
  await tick();
  assert.equal(downloaded, true);
  assert.ok(h.calls.some((c) => c.path.endsWith("/export")));
});
test("CSV mapping replaces channel safely and supports ECG inspection only", async () => {
  const h = setup();
  await openFixture(h);
  await h.file("<wave>.csv");
  assert.equal(h.$("import-name").textContent, "<wave>.csv");
  h.$("time-unit").value = "ms";
  h.$("import-modality").value = "ecg";
  h.submit("import-form");
  await tick();
  assert.equal(h.$("channel").value, "pulse");
  assert.equal(h.$("analyze").disabled, true);
  assert.match(h.$("module-note").textContent, /ECG analysis is not available/);
  assert.ok(h.$("chart").querySelector("path"));
  assert.equal(
    h.calls.find((c) => c.path === "/api/import").body.time_unit,
    "ms",
  );
  h.submit("analysis-form");
  await tick();
  assert.equal(
    h.calls.some((c) => c.path === "/api/analyze"),
    false,
  );
});
test("secret-like names are rejected before any file read", async () => {
  const h = setup();
  await openFixture(h);
  for (const name of [
    ".env.csv",
    "private_key.csv",
    "id_rsa.csv",
    "credentials.csv",
    "wave.txt",
  ]) {
    await h.file(name, () => {
      throw Error("MUST NOT READ");
    });
    assert.match(h.$("error").textContent, /non-secret CSV/);
  }
  assert.equal(
    h.calls.some((c) => c.path === "/api/preview"),
    false,
  );
});
test("analysis validation and server errors retain original input", async () => {
  const h = setup({
    "/api/analyze": () =>
      response(
        { detail: [{ loc: ["body", "start_s"], msg: "Window too short" }] },
        false,
      ),
  });
  await openFixture(h);
  h.$("window-end").value = "0";
  h.submit("analysis-form");
  await tick();
  assert.match(h.$("error").textContent, /greater/);
  assert.equal(
    h.calls.some((c) => c.path === "/api/analyze"),
    false,
  );
  h.$("window-end").value = ".024";
  h.submit("analysis-form");
  await tick();
  assert.match(h.$("error").textContent, /start_s: Window too short/);
  assert.equal(h.$("range-details").hidden, false);
  assert.equal(h.doc.activeElement, h.$("window-start"));
  assert.equal(h.$("results").hidden, true);
  assert.equal(h.app.getState().view.recording.id, "demo");
  assert.equal(h.$("analyze").disabled, false);
});
test("changed parameters discard late analysis and stale export", async () => {
  const wait = deferred(),
    h = setup({ "/api/analyze": () => wait.promise });
  await openFixture(h);
  h.submit("analysis-form");
  h.$("median-window").value = "3";
  h.$("median-window").dispatchEvent(new h.dom.window.Event("input"));
  wait.resolve(response(analysis()));
  await tick();
  assert.equal(h.app.getState().result, null);
  assert.equal(h.$("export").disabled, true);
  const download = deferred(),
    g = setup({
      "/api/experiments/experiment-1/runs/analysis/export": () =>
        download.promise,
    });
  await openFixture(g);
  g.submit("analysis-form");
  await tick();
  let clicked = false;
  g.dom.window.HTMLAnchorElement.prototype.click = () => {
    clicked = true;
  };
  g.$("export").click();
  g.$("median-window").value = "3";
  g.$("median-window").dispatchEvent(new g.dom.window.Event("input"));
  download.resolve(response({}));
  await tick();
  assert.equal(clicked, false);
});
test("cancel pending import prevents late recording replacement", async () => {
  const wait = deferred(),
    h = setup({ "/api/import": () => wait.promise });
  await openFixture(h);
  await h.file();
  h.submit("import-form");
  h.$("import-cancel").click();
  wait.resolve(response(recording("late", "different")));
  await tick();
  assert.equal(h.app.getState().view.recording.id, "demo");
  assert.equal(h.$("analyze").disabled, false);
  assert.equal(h.$("import-submit").disabled, false);
});
test("new preview survives old import and demo supersedes import without stuck flags", async () => {
  const wait = deferred(),
    h = setup({ "/api/import": () => wait.promise });
  await openFixture(h);
  await h.file("old.csv");
  h.submit("import-form");
  await h.file("new.csv");
  wait.resolve(response(recording("old", "different")));
  await tick();
  assert.equal(h.$("import-name").textContent, "new.csv");
  assert.equal(h.$("import-panel").hidden, false);
  assert.equal(h.app.getState().view.recording.id, "demo");
  const pending = deferred(),
    g = setup({ "/api/import": () => pending.promise });
  await openFixture(g);
  await g.file();
  g.submit("import-form");
  openSample(g);
  await tick();
  pending.resolve(response(recording("late", "different")));
  await tick();
  assert.equal(g.app.getState().view.recording.id, "demo");
  assert.equal(g.$("analyze").disabled, true); // Replaced PPG source needs a new protocol.
  g.submit("protocol-form");
  await tick();
  assert.equal(g.$("analyze").disabled, false);
  assert.equal(g.$("import-submit").disabled, false);
});
test("file selection supersedes pending demo; cancellation discards preview", async () => {
  const h = setup();
  await openFixture(h);
  const wait = deferred();
  const g = setup({ "/api/demo": () => wait.promise });
  const initialized = g.app.init();
  await initialized;
  openSample(g);
  await tick();
  await g.file();
  wait.resolve(response(recording("late")));
  await initialized;
  assert.equal(g.app.getState().view, null);
  assert.equal(g.$("import-panel").hidden, false);
  const reading = deferred();
  const selecting = h.file("slow.csv", () => reading.promise);
  h.$("import-cancel").click();
  reading.resolve("t,pulse\n0,1");
  await selecting;
  await tick();
  assert.equal(h.$("import-panel").hidden, true);
  assert.equal(
    h.calls.some((c) => c.path === "/api/preview"),
    false,
  );
});
test("failed import preserves CSV mapping for correction", async () => {
  const h = setup({
    "/api/import": () =>
      response({ detail: "Timestamps must increase" }, false),
  });
  await openFixture(h);
  await h.file();
  h.submit("import-form");
  await tick();
  assert.match(h.$("error").textContent, /Timestamps/);
  assert.equal(h.$("import-panel").hidden, false);
  assert.equal(h.$("time-column").value, "t");
  assert.equal(h.$("import-submit").disabled, false);
});
test("chart disconnects missing values and timestamp gaps and labels display reduction", () => {
  const h = setup(),
    container = h.$("chart");
  drawChart(
    container,
    [0, 1, 2, 3, 4, 8, 9],
    { raw: [0, 1, null, 2, 3, 4, 5] },
    0,
    9,
    "mV",
  );
  assert.equal(
    container.querySelectorAll(`path[stroke="${COLORS.raw}"]`).length,
    3,
  );
  assert.match(
    container.getAttribute("aria-label"),
    /Gaps remain disconnected/,
  );
  const times = Array.from({ length: 10000 }, (_, i) => i / 125);
  const drawn = drawChart(
    container,
    times,
    { raw: times.map(Math.sin) },
    0,
    80,
    "a.u.",
  );
  assert.equal(drawn.reduced, true);
  assert.equal(drawn.sampleCount, 10000);
});

test("chart scales finite extremes and subnormals without changing original samples", () => {
  const h = setup(),
    container = h.$("chart");
  const max = Number.MAX_VALUE,
    min = Number.MIN_VALUE;
  for (const samples of [
    [-1e308, 0, 1e308],
    [1e308, 1e308, 1e308],
    [-1e308, -1e308, -1e308],
    [-max, 0, max],
    [max, max, max],
    [-max, -max, -max],
    [max * (1 - Number.EPSILON), max, max],
    [-1e-300, 0, 1e-300],
    [-min, 0, min],
    [0, min, 2 * min],
    [min, min, min],
    [-min, -min, -min],
    [0, 0, 0],
  ]) {
    const raw = Object.freeze([...samples]);
    drawChart(container, [0, 1, 2], { raw }, 0, 2, "mV");
    assert.deepEqual(raw, samples);
    assert.doesNotMatch(container.innerHTML, /NaN|Infinity/);
    const coordinates = Array.from(
      container
        .querySelector(`path[stroke="${COLORS.raw}"]`)
        .getAttribute("d")
        .matchAll(/[ML]([^,]+),([^ ]+)/g),
      (match) => [Number(match[1]), Number(match[2])],
    );
    assert.equal(coordinates.length, 3);
    const grid = [...container.querySelectorAll('[data-grid="amplitude"]')];
    const lowerY = Math.max(
        ...grid.map((line) => Number(line.getAttribute("y1"))),
      ),
      upperY = Math.min(...grid.map((line) => Number(line.getAttribute("y1")))),
      leftX = Number(grid[0].getAttribute("x1")),
      rightX = Number(grid[0].getAttribute("x2"));
    assert.ok(
      coordinates.every(
        ([x, y]) =>
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= leftX - 0.01 &&
          x <= rightX + 0.01 &&
          y >= upperY - 0.01 &&
          y <= lowerY + 0.01,
      ),
    );
    if (samples[0] < samples[2]) {
      assert.ok(coordinates[0][1] > coordinates[2][1]);
    } else if (samples.every((v) => v === samples[0])) {
      assert.equal(new Set(coordinates.map(([, y]) => y)).size, 1);
    }
    const labels = Array.from(container.querySelectorAll("text"))
      .slice(0, 5)
      .map((node) => Number(node.textContent));
    assert.ok(labels.every(Number.isFinite));
    assert.equal(new Set(labels).size, 5);
    assert.ok(labels.every((v, i) => i === 0 || v > labels[i - 1]));
    assert.ok(labels[0] <= Math.min(...samples));
    assert.ok(labels.at(-1) >= Math.max(...samples));
    assert.match(container.getAttribute("aria-label"), /mV waveform/);
  }
});

test("overlay selection preserves analysis and a shared amplitude scale", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const result = h.app.getState().result;
  const calls = h.calls.length;
  const labels = () =>
    [...h.$("chart").querySelectorAll("text")]
      .slice(0, 5)
      .map((n) => n.textContent);
  const axis = labels();
  const change = (id) =>
    h.$(id).dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.$("plot-method").value, "median");
  assert.equal(h.$("show-reference").checked, false);
  assert.equal(h.$("legend").children.length, 2);
  assert.match(h.$("legend").textContent, /OriginalMedian subtraction/);
  assert.doesNotMatch(h.$("legend").textContent, /Unchanged|reference/);
  h.$("plot-method").value = "highpass";
  change("plot-method");
  assert.match(h.$("legend").textContent, /OriginalHigh-pass/);
  assert.deepEqual(labels(), axis);
  h.$("plot-method").value = "all";
  change("plot-method");
  assert.equal(h.$("legend").children.length, 3);
  h.$("show-reference").checked = true;
  change("show-reference");
  assert.equal(h.$("legend").children.length, 4);
  assert.match(h.$("legend").textContent, /evaluation only/);
  assert.deepEqual(labels(), axis);
  h.$("plot-method").value = "original";
  change("plot-method");
  h.$("show-reference").checked = false;
  change("show-reference");
  assert.equal(h.$("legend").children.length, 1);
  assert.equal(h.app.getState().result, result);
  assert.equal(h.$("export").disabled, false);
  assert.equal(h.calls.length, calls);
});

function longRecording() {
  const r = recording();
  r.recording.end_s = 24;
  r.recording.duration_s = 24;
  r.recording.sample_count = 25;
  r.recording.sample_rate_hz = 1;
  r.plot.times = Array.from({ length: 25 }, (_, i) => i);
  r.plot.channels.ppg = r.plot.times.map(Math.sin);
  return r;
}
function longAnalysis() {
  const r = analysis(),
    v = longRecording();
  r.window.end_s = 25;
  r.plot.times = v.plot.times;
  for (const key of ["raw", "unchanged", "median", "highpass", "reference"])
    r.plot[key] = v.plot.channels.ppg;
  r.plot.valid_mask = v.plot.times.map(() => true);
  return r;
}

test("navigation clamps, zoom keeps results, applying the view invalidates a pending export", async () => {
  const pending = deferred();
  const h = setup({
    "/api/demo": () => response(longRecording()),
    "/api/analyze": () => response(longAnalysis()),
    "/api/experiments/experiment-1/runs/analysis/export": () => pending.promise,
  });
  await openFixture(h);
  assert.equal(h.$("zoom-prev").disabled, true);
  h.$("zoom-next").click();
  assert.equal(Number(h.$("zoom-start").value), 10);
  h.$("zoom-next").click();
  assert.equal(Number(h.$("zoom-start").value), 15);
  assert.equal(h.$("zoom-next").disabled, true);
  h.$("zoom-start").value = "-10";
  h.$("zoom-apply").click();
  assert.equal(Number(h.$("zoom-start").value), 0);
  h.submit("analysis-form");
  await tick();
  const count = h.calls.length;
  const result = h.app.getState().result;
  h.$("zoom-span").value = "5";
  h.$("zoom-span").dispatchEvent(new h.dom.window.Event("change"));
  h.$("zoom-next").click();
  assert.equal(h.app.getState().result, result);
  assert.equal(h.$("export").disabled, false);
  assert.equal(h.calls.length, count);
  let downloaded = false;
  h.dom.window.HTMLAnchorElement.prototype.click = () => {
    downloaded = true;
  };
  h.$("continue-export").click();
  h.$("export").click();
  h.$("use-visible").click();
  assert.equal(h.$("window-start").value, "5");
  assert.equal(h.$("window-end").value, "10");
  assert.equal(h.app.getState().result, null);
  assert.equal(h.$("results").hidden, true);
  assert.equal(h.$("export").disabled, true);
  assert.equal(h.calls.filter((c) => c.path === "/api/analyze").length, 1);
  pending.resolve(response({}));
  await tick();
  assert.equal(downloaded, false);
  h.$("zoom-span").value = "all";
  h.$("zoom-span").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.$("zoom-prev").disabled, true);
  assert.equal(h.$("zoom-next").disabled, true);
  assert.match(h.$("display-note").textContent, /25 samples/);
  h.$("use-visible").click();
  assert.equal(h.$("window-end").value, "25");
  h.$("window-end").value = "10";
  h.$("full-window").click();
  assert.equal(h.$("window-end").value, "25");
});

test("research and developer panels retain exact evidence and current request", async () => {
  const h = setup();
  await openFixture(h);
  for (const id of [
    "parameters",
    "inspection-details",
    "developer-details",
    "technical-details",
  ])
    assert.equal(h.$(id).hidden, true);
  h.$("median-window").value = "3.5";
  h.$("median-window").dispatchEvent(new h.dom.window.Event("input"));
  assert.equal(
    JSON.parse(h.$("analysis-request").textContent).parameters.median_window_s,
    3.5,
  );
  h.$("developer-details-toggle").click();
  assert.match(
    h.$("developer-details").textContent,
    /python -m signaltrace.replay signaltrace-analysis.json --output replayed.json/,
  );
  h.submit("analysis-form");
  await tick();
  const request = h.calls.find((c) => c.path === "/api/analyze").body;
  assert.deepEqual(JSON.parse(h.$("analysis-request").textContent), request);
  assert.deepEqual(
    JSON.parse(h.$("metric-details").textContent),
    analysis().metrics,
  );
  assert.equal(h.$("method-comparison").querySelectorAll("section").length, 3);
  assert.match(
    h.$("method-comparison").textContent,
    /Unmatched reference peaks1Unmatched method peaks0/,
  );
  assert.match(h.$("method-comparison").textContent, /Waveform difference/);
  assert.match(h.$("method-comparison").textContent, /Timing shift \(ms\)/);
  assert.match(h.$("exclusion-summary").textContent, /20% excluded/);
});

test("real comparison has no reference overlay and labels change rather than accuracy", async () => {
  const result = analysis();
  result.comparison = "original";
  result.plot.reference = null;
  const h = setup({ "/api/analyze": () => response(result) });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("reference-control").hidden, true);
  assert.match(h.$("method-comparison").textContent, /Waveform difference/);
  assert.match(h.$("comparison-label").textContent, /change, not accuracy/);
  assert.doesNotMatch(h.$("legend").textContent, /reference/);
});

test("integrity attention stays visible and opens details; unsupported analysis controls stay out of the way", async () => {
  const data = recording("ecg", "lead", "ecg");
  data.inspection.gap_count = 2;
  data.inspection.missing_by_channel.lead = 3;
  data.inspection.warnings = ["Irregular sampling"];
  const h = setup({ "/api/demo": () => response(data) });
  await openFixture(h);
  guidePane(h, "checks");
  assert.equal(h.$("recording-checks").closest("[hidden]"), null);
  assert.match(h.$("integrity").textContent, /Timestamp gaps2/);
  assert.match(h.$("integrity").textContent, /missing3/);
  assert.equal(h.$("continue-compare").disabled, true);
  assert.equal(h.$("step-nav-export").disabled, true);
  h.$("inspection-details-toggle").click();
  assert.equal(h.$("inspection-details").hidden, false);
  assert.equal(h.$("analysis-form").hidden, true);
  assert.equal(h.$("use-visible").hidden, true);
  assert.match(h.$("module-note").textContent, /ECG analysis is not available/);
  assert.equal(h.$("module-note").closest("form"), null);
  const healthy = setup();
  await openFixture(healthy);
  assert.match(healthy.$("integrity").textContent, /Timestamp gaps0/);
  assert.equal(healthy.$("analysis-form").hidden, false);
});

test("recording choices and plot controls progressively reveal, with a retry path", async () => {
  const h = setup();
  assert.equal(h.$("step-open").hidden, false);
  await openFixture(h);
  assert.equal(h.$("step-open").hidden, true);
  assert.equal(h.$("channel-control").hidden, true);
  assert.match(h.$("plot-unit").textContent, /ppg/);
  assert.equal(h.$("overlay-control").hidden, true);
  assert.equal(h.$("reference-control").hidden, true);
  assert.equal(h.$("range-details").hidden, false);
  assert.equal(
    h.$("use-visible").closest("#range-details"),
    h.$("range-details"),
  );
  assert.equal(
    h.$("full-window").closest("#range-details"),
    h.$("range-details"),
  );
  assert.equal(h.$("display-details").hidden, false);
  assert.match(h.$("range-summary").textContent, /Full recording/);
  assert.equal(
    h.$("source-picker").querySelectorAll('input[type="file"]').length,
    1,
  );
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("overlay-control").hidden, false);
  assert.equal(h.$("reference-control").hidden, false);
  h.$("median-window").value = "3";
  h.$("median-window").dispatchEvent(new h.dom.window.Event("input"));
  assert.equal(h.$("overlay-control").hidden, true);
  assert.equal(h.$("reference-control").hidden, true);
  const failed = setup({
    "/api/demo": () => response({ detail: "Demo missing" }, false),
  });
  await openFixture(failed);
  assert.equal(failed.$("step-open").hidden, false);
  assert.equal(failed.$("open-demo").disabled, false);
  const multi = recording();
  multi.recording.channels.push({ name: "second", unit: "mV" });
  multi.plot.channels.second = [1, 2, 3];
  const m = setup({ "/api/demo": () => response(multi) });
  await openFixture(m);
  assert.equal(m.$("channel-control").hidden, false);
});

test("comparison validation opens hidden precision fields and focuses the invalid input", async () => {
  const h = setup();
  await openFixture(h);
  h.$("median-window").value = "99";
  h.submit("analysis-form");
  assert.equal(h.$("parameters").hidden, false);
  assert.equal(h.doc.activeElement, h.$("median-window"));
  assert.equal(
    h.calls.some((call) => call.path === "/api/analyze"),
    false,
  );
  h.$("median-window").value = "2";
  h.$("window-end").value = "0";
  h.submit("analysis-form");
  assert.equal(h.$("range-details").hidden, false);
  assert.equal(h.doc.activeElement, h.$("window-end"));
  assert.match(h.$("error").textContent, /greater than/);
  h.$("window-end").value = "";
  h.submit("analysis-form");
  assert.equal(h.$("range-details").hidden, false);
  assert.equal(h.doc.activeElement, h.$("window-end"));
  h.$("window-end").value = "999";
  h.submit("analysis-form");
  assert.equal(h.doc.activeElement, h.$("window-end"));
  assert.equal(
    h.calls.some((call) => call.path === "/api/analyze"),
    false,
  );
  h.$("full-window").click();
  h.$("window-start").value = "";
  h.$("window-start").dispatchEvent(new h.dom.window.Event("input"));
  assert.doesNotMatch(h.$("range-summary").textContent, /Full recording/);
  assert.match(h.$("range-summary").textContent, /Not set/);
});

test("explicit Compare announces busy state and focuses labelled per-method results only on completion", async () => {
  const pending = deferred(),
    h = setup({ "/api/analyze": () => pending.promise });
  await openFixture(h);
  h.$("analyze").focus();
  h.submit("analysis-form");
  assert.equal(h.$("analysis-form").getAttribute("aria-busy"), "true");
  pending.resolve(response(analysis()));
  await tick();
  assert.equal(h.$("analysis-form").getAttribute("aria-busy"), "false");
  assert.equal(h.doc.activeElement, h.$("results-title"));
  for (const section of h.$("method-comparison").querySelectorAll("section")) {
    assert.equal(
      section.getAttribute("aria-labelledby"),
      section.querySelector("h3").id,
    );
    assert.equal(section.querySelectorAll("dt").length, 4);
    assert.equal(section.querySelectorAll("dd").length, 4);
    assert.match(section.textContent, /Timing shift/);
    assert.match(section.textContent, /Unmatched reference peaks/);
  }
  guidePane(h, "manual-signal");
  h.$("plot-method").focus();
  h.$("plot-method").value = "highpass";
  h.$("plot-method").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.doc.activeElement, h.$("plot-method"));
});

test("range actions preserve exact endpoints and remain distinct from display navigation", async () => {
  const data = longRecording();
  data.recording.end_s = 24.123456789;
  const h = setup({ "/api/demo": () => response(data) });
  await openFixture(h);
  const fullEnd = String(data.recording.end_s + 1);
  h.$("zoom-start").value = "1.123456789";
  h.$("zoom-end").value = String(1.123456789 + 10);
  h.$("zoom-apply").click();
  assert.equal(h.$("window-end").value, fullEnd);
  assert.match(h.$("range-summary").textContent, /Full recording/);
  h.$("use-visible").click();
  assert.equal(h.$("window-start").value, "1.123456789");
  assert.equal(h.$("window-end").value, String(1.123456789 + 10));
  assert.match(
    h.$("range-summary").textContent,
    /1.123456789 to 11.123456789 seconds/,
  );
  assert.equal(h.$("range-details").hidden, false);
  h.$("full-window").click();
  assert.equal(h.$("window-end").value, fullEnd);
  assert.match(h.$("range-summary").textContent, /Full recording/);
  assert.equal(
    h.calls.some((call) => call.path === "/api/analyze"),
    false,
  );
});

test("narrow charts use their real width with fewer labelled ticks and preserve extreme samples", () => {
  const h = setup(),
    container = h.$("chart");
  Object.defineProperty(container, "clientHeight", { value: 360 });
  for (const width of [260, 294, 420, 800]) {
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: width,
    });
    const samples = Object.freeze([
      Number.MAX_VALUE * (1 - Number.EPSILON),
      Number.MAX_VALUE,
      Number.MAX_VALUE,
    ]);
    drawChart(container, [0, 1, 2], { raw: samples }, 0, 2, "a.u.");
    assert.equal(
      container.querySelector("svg").getAttribute("viewBox"),
      `0 0 ${width} 360`,
    );
    assert.doesNotMatch(container.innerHTML, /NaN|Infinity/);
    const ticks = [
      ...container.querySelectorAll('[data-axis="amplitude"]'),
    ].map((node) => Number(node.textContent));
    assert.equal(ticks.length, width < 480 ? 3 : 5);
    assert.equal(new Set(ticks).size, ticks.length);
    assert.ok(
      ticks.every(
        (value, i) =>
          Number.isFinite(value) && (i === 0 || value > ticks[i - 1]),
      ),
    );
    assert.ok(ticks[0] <= samples[0]);
    assert.ok(ticks.at(-1) >= samples[2]);
    if (width < 480)
      assert.ok(container.querySelectorAll("tspan").length > ticks.length);
    const coords = [
      ...container
        .querySelector(`path[stroke="${COLORS.raw}"]`)
        .getAttribute("d")
        .matchAll(/[ML]([^,]+),([^ ]+)/g),
    ].map((m) => [Number(m[1]), Number(m[2])]);
    assert.equal(coords.length, 3);
    assert.ok(coords[0][1] > coords[2][1]);
    assert.ok(
      coords.every(([x, y]) => x >= 0 && x <= width && y >= 0 && y <= 360),
    );
  }
});

test("initial setup loads catalog and session list; PPG requires explicit Start experiment", async () => {
  const h = setup();
  h.$("csv-file").focus();
  await h.app.init();
  assert.deepEqual(
    h.calls.map((c) => c.path),
    [
      "/api/investigations/config",
      "/api/credentials/meta",
      "/api/catalog",
      "/api/experiments",
    ],
  );
  assert.equal(h.doc.activeElement, h.$("csv-file"));
  assert.equal(h.app.getState().step, "open");
  for (const key of ["inspect", "compare", "export"])
    assert.equal(h.$("step-nav-" + key).disabled, true);
  openSample(h);
  await tick();
  assert.equal(h.app.getState().step, "open");
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.equal(h.$("step-nav-compare").disabled, true);
  h.submit("protocol-form");
  await tick();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.$("inspect-title").closest("[hidden]"), null);
  assert.ok(h.$("investigation-evidence-details"));
  assert.ok(h.$("detailed-report"));
});

test("import success leaves focus visible; superseded demo and cancelled import never move it", async () => {
  const h = setup();
  await openFixture(h);
  await h.file();
  h.$("import-submit").focus();
  h.submit("import-form");
  await tick();
  assert.equal(h.$("import-panel").hidden, true);
  assert.equal(h.doc.activeElement, stageTitle(h));

  const demo = deferred();
  let demoCalls = 0;
  const stale = setup({
    "/api/demo": () =>
      ++demoCalls === 1 ? response(recording()) : demo.promise,
  });
  await openFixture(stale);
  stale.$("step-nav-open").click();
  stale.$("open-demo").focus();
  openSample(stale);
  await stale.file();
  assert.equal(stale.doc.activeElement, stale.$("time-column"));
  demo.resolve(response(recording("late")));
  await tick();
  assert.equal(stale.doc.activeElement, stale.$("time-column"));
  assert.equal(stale.app.getState().view.recording.id, "demo");

  const imported = deferred(),
    cancelled = setup({ "/api/import": () => imported.promise });
  await openFixture(cancelled);
  await cancelled.file();
  cancelled.$("import-submit").focus();
  cancelled.submit("import-form");
  cancelled.$("import-cancel").click();
  assert.equal(cancelled.doc.activeElement, stageTitle(cancelled));
  imported.resolve(response(recording("late-import")));
  await tick();
  assert.equal(cancelled.doc.activeElement, stageTitle(cancelled));
  assert.equal(cancelled.app.getState().view.recording.id, "demo");
});

test("narrow long timestamps wrap without losing precision or colliding with other ticks or the time title", () => {
  const h = setup(),
    container = h.$("chart"),
    width = 294,
    height = 360;
  Object.defineProperty(container, "clientWidth", { value: width });
  Object.defineProperty(container, "clientHeight", { value: height });
  drawChart(container, [0, 5, 10], { raw: [0, 1, 0] }, 0, 10, "mV");
  const plotBottom = () =>
    Math.max(
      ...[...container.querySelectorAll('[data-grid="amplitude"]')].map(
        (line) => Number(line.getAttribute("y1")),
      ),
    );
  const ordinaryBottom = plotBottom();
  for (const duration of [10, 0.00001]) {
    const start = 1700000000.125,
      end = start + duration;
    const times = Object.freeze([start, start + duration / 2, end]);
    const raw = Object.freeze([0, 1, 0]);
    drawChart(container, times, { raw }, start, end, "mV");
    assert.doesNotMatch(container.innerHTML, /NaN|Infinity/);
    const ticks = [...container.querySelectorAll('[data-axis="time"]')];
    assert.deepEqual(
      ticks.map((tick) => Number(tick.textContent)),
      [start, end],
    );
    assert.ok(plotBottom() < ordinaryBottom);
    const boxes = ticks.map((tick) => {
      const chunks = [...tick.querySelectorAll("tspan")];
      assert.ok(chunks.length > 1);
      const textWidth =
        Math.max(...chunks.map((chunk) => chunk.textContent.length)) *
        16 *
        0.63;
      const x = Number(tick.getAttribute("x")),
        y = Number(tick.getAttribute("y"));
      const bottom =
        y +
        chunks.reduce(
          (sum, chunk) => sum + Number(chunk.getAttribute("dy")),
          0,
        );
      const left =
        tick.getAttribute("text-anchor") === "end" ? x - textWidth : x;
      return { left, right: left + textWidth, top: y - 16, bottom };
    });
    assert.ok(boxes[0].right < boxes[1].left);
    assert.ok(
      boxes.every(
        (box) => box.left >= 0 && box.right <= width && box.top > plotBottom(),
      ),
    );
    const titleY = Number(
      container.querySelector('[data-axis="time-title"]').getAttribute("y"),
    );
    assert.ok(boxes.every((box) => box.bottom + 16 < titleY));
    assert.ok(titleY < height);
    assert.deepEqual(times, [start, start + duration / 2, end]);
    assert.deepEqual(raw, [0, 1, 0]);
  }
});

test("steps preserve results and exact range while Inspect uses full original samples", async () => {
  const data = recording();
  data.recording.end_s = 30;
  data.recording.sample_rate_hz = 1;
  data.plot.times = [0, 10, 20, 30];
  data.plot.channels.ppg = [0, 1, 2, 0];
  const result = analysis();
  result.window = { start_s: 10, end_s: 20 };
  result.plot.times = [10, 15, 19];
  const h = setup({
    "/api/demo": () => response(data),
    "/api/analyze": () => response(result),
  });
  await openFixture(h);
  h.$("window-start").value = "10";
  h.$("window-end").value = "20";
  h.submit("analysis-form");
  await tick();
  const retained = h.app.getState().result,
    before = h.calls.length;
  h.$("continue-export").click();
  assert.equal(h.app.getState().step, "export");
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.equal(h.$("export-technical").hidden, true);
  guidePane(h, "exports");
  assert.equal(h.$("export").closest("[hidden]"), null);
  assert.match(h.$("export-summary").textContent, /\[10, 20\) s/);
  h.$("back-compare").click();
  h.$("back-inspect").click();
  h.$("zoom-span").value = "all";
  h.$("zoom-span").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.$("waveform-panel").parentElement.id, "inspect-waveform");
  assert.equal(h.$("legend").textContent, "Original");
  assert.match(h.$("display-note").textContent, /\[0, 31\) s/);
  assert.equal(h.$("overlay-control").hidden, true);
  h.$("back-open").click();
  h.$("continue-inspect").click();
  h.$("continue-compare").click();
  assert.equal(h.$("waveform-panel").parentElement.id, "compare-waveform");
  assert.equal(h.$("window-start").value, "10");
  assert.equal(h.$("window-end").value, "20");
  assert.equal(h.app.getState().result, retained);
  assert.equal(h.calls.length, before);
  assert.equal(h.$("step-nav-compare").getAttribute("aria-current"), "step");
  assert.equal(
    h.doc.querySelectorAll(".workflow-step:not([hidden])").length,
    1,
  );
  h.$("median-window").dispatchEvent(new h.dom.window.Event("input"));
  assert.equal(h.$("continue-export").disabled, false); // Saved bundle remains exportable.
  assert.equal(h.$("step-nav-export").disabled, false); // Saved bundle remains exportable.
});
test("late analysis after Back preserves result without navigation or hidden focus", async () => {
  const pending = deferred(),
    h = setup({ "/api/analyze": () => pending.promise });
  await openFixture(h);
  h.submit("analysis-form");
  h.$("back-inspect").click();
  pending.resolve(response(analysis()));
  await tick();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.ok(h.app.getState().result);
  assert.equal(h.$("legend").textContent, "Original");
  h.$("continue-compare").click();
  assert.equal(h.$("continue-export").disabled, false);
});
test("large panels synchronize labels and validation reveals correct step", async () => {
  const h = setup();
  await openFixture(h);
  for (const id of [
    "parameters",
    "technical-details",
    "inspection-details",
    "developer-details",
  ]) {
    const b = h.$(id + "-toggle");
    assert.equal(b.getAttribute("aria-controls"), id);
    assert.equal(b.getAttribute("aria-expanded"), "false");
    b.click();
    assert.equal(h.$(id).hidden, false);
    assert.match(b.textContent, /^Hide /);
    b.click();
    assert.equal(h.$(id).hidden, true);
    assert.match(b.textContent, /^Show /);
  }
  h.$("back-inspect").click();
  h.$("highpass").value = "9";
  h.submit("analysis-form");
  assert.equal(h.app.getState().step, "compare");
  assert.equal(h.$("parameters-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(h.doc.activeElement, h.$("highpass"));
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
});
test("pending recording replacement disables future steps and ECG success returns Inspect", async () => {
  const pending = deferred(),
    h = setup({ "/api/import": () => pending.promise });
  await openFixture(h);
  h.$("step-nav-open").click();
  await h.file();
  h.$("import-modality").value = "ecg";
  h.submit("import-form");
  for (const key of ["inspect", "compare", "export"])
    assert.equal(h.$("step-nav-" + key).disabled, true);
  h.$("step-nav-compare").click();
  assert.equal(h.app.getState().step, "open");
  pending.resolve(response(recording("new", "lead", "ecg")));
  await tick();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.equal(h.$("continue-compare").disabled, true);
  assert.equal(h.$("step-nav-compare").disabled, true);
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
});

test("expanded technical evidence clears obsolete measurements and rerun replaces them", async () => {
  let runs = 0;
  const h = setup({
    "/api/analyze": () => {
      const data = analysis();
      data.metrics = structuredClone(data.metrics);
      data.metrics.median.mean_absolute_shift_ms = ++runs === 1 ? 12345 : 67890;
      return response(data);
    },
  });
  await openFixture(h);
  assert.equal(h.$("measurement-details").hidden, true);
  h.submit("analysis-form");
  await tick();
  guidePane(h, "technical");
  assert.equal(h.$("measurement-details").closest("[hidden]"), null);
  assert.match(h.$("metric-details").textContent, /12345/);
  h.$("median-window").value = "3";
  h.$("median-window").dispatchEvent(new h.dom.window.Event("input"));
  assert.equal(h.$("technical-details").hidden, false);
  assert.equal(h.$("measurement-details").hidden, true);
  assert.equal(h.$("metrics").querySelector("tbody").textContent, "");
  assert.equal(h.$("metric-details").textContent, "");
  assert.doesNotMatch(h.$("technical-details").textContent, /12345/);
  assert.equal(h.$("limits-details").closest("[hidden]"), null);
  assert.match(h.$("limits-details").textContent, /No clinical interpretation/);
  h.submit("analysis-form");
  await tick();
  guidePane(h, "technical");
  assert.equal(h.$("measurement-details").closest("[hidden]"), null);
  assert.match(h.$("metric-details").textContent, /67890/);
  assert.doesNotMatch(h.$("technical-details").textContent, /12345/);
});

function edit(h, id, value) {
  h.$(id).value = value;
  h.$(id).dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
}
function uniqueAnalysis() {
  let n = 0;
  return (body) => {
    const data = analysis();
    data.id = `run-${++n}`;
    data.run_label = `Run ${n}`;
    data.window = { start_s: body.start_s, end_s: body.end_s };
    data.channel = body.channel;
    data.parameters = { ...body.parameters };
    data.metrics = structuredClone(data.metrics);
    data.metrics.median.mean_absolute_shift_ms = n * 11;
    return response(data);
  };
}
test("protocol controls use native radios, true reference availability and safe user text", async () => {
  const data = recording();
  data.recording.has_reference = false;
  const h = setup({ "/api/demo": () => response(data) });
  await h.app.init();
  openSample(h);
  await tick();
  assert.equal(h.$("evaluation-synthetic").disabled, true);
  assert.match(h.$("evaluation-help").textContent, /No reference/);
  assert.equal(
    h.doc.querySelectorAll('.radio-inputs input[type="radio"]').length,
    4,
  );
  assert.equal(
    h.doc.querySelectorAll("#experiment-task option:disabled").length,
    2,
  );
  h.$("experiment-name").value = "<img src=x onerror=alert(1)>";
  h.$("target-waveform").click();
  h.submit("protocol-form");
  await tick();
  assert.equal(
    h.app.getState().experiment.protocol.target,
    "waveform_sensitivity",
  );
  assert.equal(h.$("goal").value, "waveform_sensitivity");
  assert.equal(h.$("goal").type, "hidden");
  assert.match(h.$("experiment-context").textContent, /<img/);
  assert.equal(h.$("experiment-context").querySelector("img"), null);
  h.$("continue-compare").click();
  h.submit("analysis-form");
  await tick();
  assert.equal(
    h.calls.find((c) => c.path === "/api/analyze").body.goal,
    "waveform_sensitivity",
  );
  assert.equal(
    h.calls.find((c) => c.path === "/api/analyze").body.experiment_id,
    "experiment-1",
  );
});
test("changed protocol gates calculations and exports and saves a distinct immutable experiment", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const old = structuredClone(h.app.getState().experiment.protocol);
  h.$("step-nav-open").click();
  edit(h, "experiment-name", "Second question");
  assert.equal(h.app.getState().protocolDirty, true);
  assert.equal(h.$("analyze").disabled, true);
  assert.equal(h.$("export-experiment").disabled, true);
  assert.equal(h.$("step-nav-export").disabled, true);
  const count = h.calls.filter((c) => c.path === "/api/analyze").length;
  h.submit("analysis-form");
  await tick();
  assert.equal(h.calls.filter((c) => c.path === "/api/analyze").length, count);
  h.submit("protocol-form");
  await tick();
  assert.equal(h.app.getState().experiment.id, "experiment-2");
  assert.deepEqual(h.experiments.get("experiment-1").protocol, old);
  assert.equal(h.app.getState().runs.length, 0);
  assert.equal(h.$("session-list").querySelectorAll("button").length, 2);
});
test("saved history survives settings changes and View run restores exact result without calculation", async () => {
  const h = setup({ "/api/analyze": uniqueAnalysis() });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const first = structuredClone(h.app.getState().runs[0]);
  edit(h, "median-window", "3");
  h.submit("analysis-form");
  await tick();
  assert.equal(h.app.getState().runs.length, 2);
  assert.deepEqual(h.app.getState().runs[0], first);
  edit(h, "window-end", "0.016");
  assert.equal(h.app.getState().result, null);
  assert.equal(h.$("export").disabled, true);
  assert.equal(h.$("export-experiment").disabled, false);
  const n = h.calls.filter((c) => c.path === "/api/analyze").length;
  h.$("run-history").querySelector("button").click();
  await tick();
  assert.equal(h.$("median-window").value, "2");
  assert.equal(h.$("window-end").value, "0.024");
  assert.equal(h.app.getState().result.id, "run-1");
  assert.match(h.$("analysis-state").textContent, /Saved run/);
  assert.equal(h.calls.filter((c) => c.path === "/api/analyze").length, n);
});
test("two run checkboxes show actual metrics, unchanged baseline and mismatched scope warning", async () => {
  const h = setup({ "/api/analyze": uniqueAnalysis() });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  edit(h, "window-end", "0.016");
  h.submit("analysis-form");
  await tick();
  guidePane(h, "history");
  const checks = h.$("run-history").querySelectorAll('input[type="checkbox"]');
  checks[0].click();
  checks[1].focus();
  checks[1].click();
  assert.equal(h.doc.activeElement, checks[1]);
  const panel = h.$("run-comparison");
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /descriptive comparison only/);
  assert.match(panel.textContent, /Unchanged/);
  assert.match(panel.textContent, /20% excluded/);
  assert.match(panel.textContent, /high-pass 0.35 Hz/);
  assert.equal(panel.querySelectorAll("tbody tr").length, 9);
  const row = [...panel.querySelectorAll("tbody tr")].find((r) =>
    r.textContent.includes("Median subtraction / Timing shift"),
  );
  assert.deepEqual(
    [...row.querySelectorAll("td")].map((td) => td.textContent),
    ["11", "22"],
  );
  assert.match(panel.textContent, /0.016/);
  checks[1].click();
  assert.equal(panel.hidden, true);
});
test("session selector restores the retained experiment recording and frozen protocol", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  h.$("step-nav-open").click();
  edit(h, "experiment-name", "Other experiment");
  h.submit("protocol-form");
  await tick();
  h.$("step-nav-open").click();
  sessionButton(h, "experiment-1").click();
  await tick();
  assert.equal(h.app.getState().experiment.id, "experiment-1");
  assert.equal(h.app.getState().view.recording.id, "demo");
  assert.equal(h.$("experiment-name").value, "Recording demo experiment");
  assert.equal(h.app.getState().runs.length, 1);
});
test("stale experiment open cannot replace a newly selected source or move focus", async () => {
  const pending = deferred();
  const h = setup({
    "/api/experiments/experiment-1/recording": () => pending.promise,
  });
  await openFixture(h);
  h.$("step-nav-open").click();
  await forkFixture(h);
  sessionButton(h, "experiment-1").click();
  await h.file();
  h.$("time-column").focus();
  pending.resolve(response(recording("late")));
  await tick();
  assert.equal(h.app.getState().view.recording.id, "demo");
  assert.equal(h.doc.activeElement, h.$("time-column"));
});
test("stale saved run load cannot restore obsolete parameters or replace a new source", async () => {
  const pending = deferred(),
    h = setup({
      "/api/experiments/experiment-1/runs/analysis": () => pending.promise,
    });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  h.$("run-history").querySelector("button").click();
  edit(h, "median-window", "4");
  pending.resolve(response(analysis()));
  await tick();
  assert.equal(h.app.getState().result, null);
  assert.equal(h.$("median-window").value, "4");
});
test("late protocol save does not attach an experiment to a replacement recording", async () => {
  const pending = deferred(),
    h = setup({
      "/api/experiments": (body) =>
        body ? pending.promise : response({ experiments: [] }),
    });
  await h.app.init();
  openSample(h);
  await tick();
  h.submit("protocol-form");
  await h.file();
  h.submit("import-form");
  await tick();
  pending.resolve(
    response({
      id: "stale",
      recording_id: "demo",
      protocol: { name: "Old" },
      runs: [],
    }),
  );
  await tick();
  assert.equal(h.app.getState().experiment, null);
  assert.equal(h.app.getState().view.recording.id, "import");
  assert.equal(h.app.getState().step, "open");
});
test("bundle export uses experiment URL and pending downloads are discarded on draft edits", async () => {
  const pending = deferred(),
    h = setup({
      "/api/experiments/experiment-1/export": () => pending.promise,
    });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  let downloaded = false;
  h.dom.window.HTMLAnchorElement.prototype.click = () => {
    downloaded = true;
  };
  h.$("export-experiment").click();
  edit(h, "research-question", "New question");
  pending.resolve(response({}));
  await tick();
  assert.equal(downloaded, false);
  assert.ok(
    h.calls.some((c) => c.path === "/api/experiments/experiment-1/export"),
  );
});
test("late history refresh cannot populate a replaced source", async () => {
  const pending = deferred(),
    h = setup({ "/api/experiments/experiment-1": () => pending.promise });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  h.$("step-nav-open").click();
  openSample(h);
  await tick();
  pending.resolve(
    response({
      id: "experiment-1",
      protocol: { name: "Old" },
      runs: [{ id: "bad" }],
    }),
  );
  await tick();
  assert.equal(h.app.getState().experiment, null);
  assert.equal(h.$("run-history").children.length, 0);
});
test("unsaved and failed runs preserve history and eight runs prevent a ninth request", async () => {
  let fail = false;
  const next = uniqueAnalysis(),
    h = setup({
      "/api/analyze": (body) =>
        fail ? response({ detail: "Invalid interval" }, false) : next(body),
    });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  fail = true;
  edit(h, "median-window", "3");
  h.submit("analysis-form");
  await tick();
  assert.equal(h.app.getState().runs.length, 1);
  fail = false;
  for (let i = 1; i < 8; i++) {
    h.submit("analysis-form");
    await tick();
  }
  assert.equal(h.app.getState().runs.length, 8);
  assert.equal(h.$("analyze").disabled, true);
  const n = h.calls.length;
  h.submit("analysis-form");
  await tick();
  assert.equal(h.calls.length, n);
  assert.match(h.$("history-status").textContent, /Run limit reached/);
});

test("saved sessions on reload expose reachable native list buttons", async () => {
  const h = setup({
    "/api/experiments": () =>
      response({
        experiments: [
          { id: "saved", protocol: { name: "Existing" }, run_count: 2 },
        ],
      }),
  });
  await h.app.init();
  assert.equal(sessionButton(h, "saved").disabled, false);
  assert.match(sessionButton(h, "saved").textContent, /Existing.*2 runs/s);
  assert.equal(h.$("session-experiment"), null);
  assert.equal(h.$("open-experiment"), null);
});
test("successful run remains usable if the subsequent history refresh fails", async () => {
  const h = setup({
    "/api/experiments/experiment-1": () =>
      response({ detail: "Temporarily unavailable" }, false),
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.equal(h.app.getState().runs.length, 1);
  assert.equal(h.$("export").disabled, false);
  assert.equal(h.$("export-experiment").disabled, false);
  assert.equal(h.$("step-nav-export").disabled, false);
  assert.match(h.$("history-status").textContent, /Could not refresh/);
});
test("Uiverse controls retain focusable inputs, accessibility states and local MIT notices", async () => {
  const css = await readFile(
    new URL("../signaltrace/web/app.css", import.meta.url),
    "utf8",
  );
  const notices = await readFile(
    new URL("../THIRD_PARTY_NOTICES.md", import.meta.url),
    "utf8",
  );
  assert.match(css, /radio input:focus-visible/);
  assert.match(css, /forced-colors/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /rotateY/);
  assert.match(notices, /Yaya12085/);
  assert.match(notices, /ke1221/);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED/);
  const h = setup();
  h.$("protocol-details-toggle").click();
  assert.equal(
    h.$("protocol-details-toggle").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(h.$("protocol-details").hidden, false);
});

test("protocol controls cannot invalidate a pending experiment open and leave loading stuck", async () => {
  const pending = deferred(),
    h = setup({
      "/api/experiments/experiment-1/recording": () => pending.promise,
    });
  await openFixture(h);
  h.$("step-nav-open").click();
  await forkFixture(h);
  sessionButton(h, "experiment-1").click();
  assert.equal(h.$("experiment-name").disabled, true);
  assert.equal(h.$("target-waveform").disabled, true);
  // Programmatic input is ignored too; native disabled fields cannot emit user edits.
  edit(h, "experiment-name", "Attempt during loading");
  pending.resolve(response(recording()));
  await tick();
  assert.equal(h.$("experiment-name").value, "Recording demo experiment");
  assert.equal(h.$("experiment-name").disabled, false);
  assert.equal(h.$("open-demo").disabled, false);
  assert.equal(h.$("step-nav-compare").disabled, false);
  assert.equal(h.app.getState().step, "inspect");
});

test("changing parameters clears the viewed-run marker while preserving saved runs", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.match(h.$("run-history").textContent, /currently viewed/);
  edit(h, "median-window", "3");
  assert.doesNotMatch(h.$("run-history").textContent, /currently viewed/);
  assert.equal(h.app.getState().runs.length, 1);
});

test("local activity covers overlapping requests and clears after a stale failure", async () => {
  const calculation = deferred(),
    replacement = deferred();
  let replace = false;
  const h = setup({
    "/api/analyze": () => calculation.promise,
    "/api/demo": () => (replace ? replacement.promise : response(recording())),
  });
  await openFixture(h);
  assert.equal(h.$("request-activity").hidden, true);
  h.submit("analysis-form");
  assert.equal(h.$("request-activity").hidden, false);
  h.$("back-inspect").click();
  h.$("back-open").click();
  replace = true;
  openSample(h);
  replacement.resolve(response(recording("replacement")));
  await tick();
  assert.equal(
    h.$("request-activity").hidden,
    false,
    "stale calculation is still pending",
  );
  calculation.resolve(response({ detail: "Late failure" }, false));
  await tick();
  assert.equal(h.$("request-activity").hidden, true);
  assert.equal(h.app.getState().view.recording.id, "replacement");
  assert.equal(h.$("error").hidden, true, "stale failure remains suppressed");
});

test("local activity includes response parsing and clears on transport or body failure", async () => {
  const body = deferred();
  const h = setup({
    "/api/catalog": () => ({ ok: true, status: 200, json: () => body.promise }),
  });
  const initialization = h.app.init();
  await tick();
  assert.equal(h.$("request-activity").hidden, false);
  body.resolve({ meta: { connected: false }, demos: [] });
  await initialization;
  assert.equal(h.$("request-activity").hidden, true);
  for (const request of [
    () => {
      throw new Error("Transport unavailable");
    },
    () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Broken JSON");
      },
    }),
  ]) {
    const failed = setup({ "/api/catalog": request });
    await failed.app.init();
    assert.equal(failed.$("request-activity").hidden, true);
    assert.equal(failed.$("error").hidden, false);
  }
});

test("new-result motion happens once per event, never on selection or navigation", async () => {
  const animated = [];
  const h = setup({}, (dom) => {
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.Element.prototype.animate = function () {
      if (!this.id.startsWith("step-"))
        animated.push(this.id || this.dataset.runId);
      return { cancel() {}, finished: Promise.resolve() };
    };
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.deepEqual(animated, ["results", "analysis"]);
  const checkbox = h.$("run-history").querySelector("input");
  checkbox.click();
  h.$("back-inspect").click();
  h.$("continue-compare").click();
  h.$("run-history").querySelector("button").click();
  await tick();
  assert.deepEqual(animated, ["results", "analysis"]);
  assert.equal(h.doc.activeElement, stageTitle(h));
});

test("reduced motion cancels running presentation and preference changes suppress new motion", async () => {
  let listener,
    cancelled = 0,
    started = 0;
  const preference = {
    matches: false,
    addEventListener(_, callback) {
      listener = callback;
    },
    removeEventListener() {},
  };
  const h = setup({}, (dom) => {
    dom.window.matchMedia = () => preference;
    dom.window.Element.prototype.animate = function () {
      if (this.id.startsWith("step-")) return { cancel() {} };
      started++;
      return {
        cancel() {
          cancelled++;
        },
        finished: new Promise(() => {}),
      };
    };
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.equal(started, 2);
  preference.matches = true;
  listener();
  assert.equal(cancelled, 2);
  h.$("window-start").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  h.submit("analysis-form");
  await tick();
  assert.equal(started, 2);
  assert.equal(h.$("results").hidden, false);
  assert.equal(h.doc.activeElement.id, "results-title");
  h.app.destroy();
});

test("navigation and panels work immediately without animation APIs", async () => {
  const h = setup();
  assert.equal(h.dom.window.matchMedia, undefined);
  assert.equal(h.$("results").animate, undefined);
  await openFixture(h);
  for (let i = 0; i < 3; i++) {
    h.$("back-inspect").click();
    assert.equal(h.doc.activeElement, stageTitle(h));
    assert.equal(h.$("step-compare").hidden, true);
    h.$("continue-compare").click();
    assert.equal(h.doc.activeElement, stageTitle(h));
  }
  h.$("parameters-toggle").click();
  assert.equal(h.$("parameters").hidden, false);
  h.$("parameters-toggle").click();
  assert.equal(h.$("parameters").hidden, true);
  assert.equal(h.$("parameters-toggle").getAttribute("aria-expanded"), "false");
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("results").hidden, false);
  assert.equal(h.$("request-activity").hidden, true);
});

test("download activity stays pending through blob decoding and clears after failure", async () => {
  const body = deferred();
  const h = setup({
    "/api/experiments/experiment-1/runs/analysis/export": () => ({
      ok: true,
      blob: () =>
        body.promise.then(() => {
          throw new Error("Download body failed");
        }),
    }),
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  h.$("continue-export").click();
  h.$("export").click();
  await tick();
  assert.equal(h.$("request-activity").hidden, false);
  body.resolve();
  await tick();
  assert.equal(h.$("request-activity").hidden, true);
  assert.match(h.$("error").textContent, /Download body failed/);
  assert.equal(h.$("export").disabled, false);
});

// Controlled clock and native-dialog contract shim: no wall-clock delays or visual claims.
function presentationHarness() {
  const timers = new Map(),
    moves = [];
  let now = 0,
    next = 0,
    preferenceListener,
    opened = 0;
  const preference = {
    matches: false,
    addEventListener(_, fn) {
      preferenceListener = fn;
    },
    removeEventListener() {
      preferenceListener = null;
    },
  };
  return {
    timers,
    moves,
    preference,
    get opened() {
      return opened;
    },
    reduce() {
      preference.matches = true;
      preferenceListener?.();
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
    },
    configure(dom) {
      const w = dom.window;
      w.setTimeout = (fn, ms) => {
        const id = ++next;
        timers.set(id, { fn, at: now + ms });
        return id;
      };
      w.clearTimeout = (id) => timers.delete(id);
      w.matchMedia = () => preference;
      w.Element.prototype.animate = function (frames, options) {
        const move = {
          id: this.id,
          frames,
          options,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
          finished: new Promise(() => {}),
        };
        moves.push(move);
        return move;
      };
      const nativeFocus = w.HTMLElement.prototype.focus;
      w.HTMLElement.prototype.focus = function () {
        const modal = dom.window.document.querySelector("dialog[open]");
        if (!modal || modal.contains(this)) nativeFocus.call(this);
      };
      w.HTMLDialogElement.prototype.showModal = function () {
        opened++;
        this.open = true;
        this.querySelector("button").focus();
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
    },
  };
}

test("stage changes keep a stable shell without directional movement and focus immediately", async () => {
  const motion = presentationHarness(),
    h = setup({}, motion.configure);
  await openFixture(h);
  assert.equal(motion.moves.length, 0);
  h.$("back-inspect").click();
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.equal(h.$("step-compare").hidden, true);
  h.$("continue-compare").click();
  assert.equal(h.doc.activeElement, stageTitle(h));
  assert.equal(motion.moves.length, 0);
  h.app.destroy();
});

test("animation exceptions leave navigation and focus fully operational", async () => {
  const h = setup({}, (dom) => {
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.Element.prototype.animate = () => {
      throw new Error("unavailable");
    };
  });
  await openFixture(h);
  h.$("back-inspect").click();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.doc.activeElement, stageTitle(h));
});

test("fast work and navigation never flash the loading dialog", async () => {
  const clock = presentationHarness(),
    h = setup({}, clock.configure);
  await openFixture(h);
  clock.advance(1000);
  assert.equal(clock.opened, 0);
  assert.equal(clock.timers.size, 0);
  h.$("back-inspect").click();
  clock.advance(1000);
  assert.equal(clock.opened, 0);
});

test("delayed work stays modal through body decoding then closes with safe focus", async () => {
  const body = deferred(),
    clock = presentationHarness();
  const h = setup(
    { "/api/demo": () => ({ ok: true, json: () => body.promise }) },
    clock.configure,
  );
  await h.app.init();
  h.$("open-demo").focus();
  openSample(h);
  await tick();
  clock.advance(349);
  assert.equal(clock.opened, 0);
  clock.advance(1);
  assert.equal(h.$("loading-dialog").open, true);
  assert.equal(h.$("loading-title").textContent, "Opening recording");
  assert.equal(h.doc.activeElement.id, "keep-working");
  body.resolve(recording());
  await tick();
  assert.equal(h.$("loading-dialog").open, false);
  assert.equal(h.$("request-activity").hidden, true);
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
  assert.equal(clock.timers.size, 0);
});

test("Escape and Keep working dismiss presentation without cancelling requests or reopening the busy group", async () => {
  for (const escape of [true, false]) {
    const work = deferred(),
      clock = presentationHarness();
    const h = setup({ "/api/analyze": () => work.promise }, clock.configure);
    await openFixture(h);
    h.submit("analysis-form");
    clock.advance(350);
    if (escape) {
      const event = new h.dom.window.Event("cancel", { cancelable: true });
      h.$("loading-dialog").dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    } else h.$("keep-working").click();
    assert.equal(h.$("loading-dialog").open, false);
    assert.equal(h.$("request-activity").hidden, false);
    h.$("back-inspect").click();
    clock.advance(1000);
    assert.equal(clock.opened, 1);
    work.resolve(response(analysis()));
    await tick();
    assert.equal(h.app.getState().runs.length, 1);
    assert.equal(h.doc.activeElement, stageTitle(h));
    assert.equal(h.$("request-activity").hidden, true);
  }
});

test("overlap retains loading until stale failure finishes, with generic mixed-task label", async () => {
  const work = deferred(),
    opening = deferred(),
    clock = presentationHarness();
  const h = setup(
    { "/api/analyze": () => work.promise, "/api/demo": () => opening.promise },
    clock.configure,
  );
  await h.app.init();
  openSample(h);
  opening.resolve(response(recording()));
  await tick();
  h.submit("protocol-form");
  await tick();
  h.$("continue-compare").click();
  h.submit("analysis-form");
  clock.advance(350);
  h.$("keep-working").click();
  h.$("back-inspect").click();
  h.$("back-open").click();
  openSample(h);
  assert.equal(h.$("loading-title").textContent, "Working locally");
  await tick();
  assert.equal(h.$("request-activity").hidden, false);
  clock.advance(1000);
  assert.equal(clock.opened, 1);
  work.resolve(response({ detail: "Stale failure" }, false));
  await tick();
  assert.equal(h.$("request-activity").hidden, true);
  assert.equal(clock.timers.size, 0);
});

test("dialog failure falls back inline and delayed errors close the dialog", async () => {
  for (const unavailable of [true, false]) {
    const work = deferred(),
      clock = presentationHarness();
    const h = setup({ "/api/demo": () => work.promise }, clock.configure);
    await h.app.init();
    if (unavailable)
      h.$("loading-dialog").showModal = () => {
        throw new Error("unsupported");
      };
    openSample(h);
    clock.advance(350);
    assert.equal(h.$("loading-dialog").open, !unavailable);
    assert.equal(h.$("request-activity").hidden, false);
    work.resolve(response({ detail: "Cannot open" }, false));
    await tick();
    assert.equal(h.$("loading-dialog").open, false);
    assert.equal(h.$("request-activity").hidden, true);
    assert.match(h.$("error").textContent, /Cannot open/);
  }
});

test("destroy clears pending timers, active modal and motion; late work cannot reopen presentation", async () => {
  for (const shown of [false, true]) {
    const work = deferred(),
      clock = presentationHarness();
    const h = setup({ "/api/analyze": () => work.promise }, clock.configure);
    await openFixture(h);
    h.submit("analysis-form");
    if (shown) clock.advance(350);
    h.app.destroy();
    assert.equal(clock.timers.size, 0);
    assert.equal(h.$("loading-dialog").open, false);
    assert.equal(h.$("request-activity").hidden, true);
    assert.ok(clock.moves.every((move) => move.cancelled));
    assert.equal(
      h.doc.activeElement.closest("[hidden], dialog:not([open])"),
      null,
    );
    clock.advance(1000);
    work.resolve(response(analysis()));
    await tick();
    assert.equal(h.$("loading-dialog").open, false);
    assert.equal(h.$("request-activity").hidden, true);
    assert.equal(clock.timers.size, 0);
  }
});

test("modal overlap preserves newer result focus intent until the last request closes", async () => {
  const slow = deferred(),
    run = deferred(),
    clock = presentationHarness();
  let catalogCalls = 0;
  const catalog = {
    meta: { connected: false },
    demos: [{ id: "synthetic_drift_noise", label: "Synthetic" }],
  };
  const h = setup(
    {
      "/api/catalog": () =>
        ++catalogCalls === 1 ? response(catalog) : slow.promise,
      "/api/analyze": () => run.promise,
    },
    clock.configure,
  );
  await openFixture(h);
  h.$("analyze").focus();
  h.submit("analysis-form");
  const refreshing = h.app.init();
  clock.advance(350);
  run.resolve(response(analysis()));
  await tick();
  assert.equal(h.$("loading-dialog").open, true);
  assert.equal(h.doc.activeElement.id, "keep-working");
  assert.equal(h.$("results").hidden, false);
  slow.resolve(response(catalog));
  await refreshing;
  assert.equal(h.$("loading-dialog").open, false);
  assert.equal(h.doc.activeElement.id, "results-title");
});

function explorationRecording(
  times,
  channels = { ppg: times.map((_, i) => i % 3) },
  modality = "ppg",
) {
  const r = recording("exploration", Object.keys(channels)[0], modality);
  r.plot = { times, channels };
  Object.assign(r.recording, {
    channels: Object.keys(channels).map((name) => ({ name, unit: "a.u." })),
    sample_count: times.length,
    start_s: times[0],
    end_s: times.at(-1),
    duration_s: times.at(-1) - times[0],
    sample_rate_hz: 1,
  });
  r.inspection.missing_by_channel = Object.fromEntries(
    Object.entries(channels).map(([name, samples]) => [
      name,
      samples.filter((v) => !Number.isFinite(v)).length,
    ]),
  );
  return r;
}
function setDisplay(h, start, end) {
  h.$("zoom-start").value = String(start);
  h.$("zoom-end").value = String(end);
  h.$("zoom-apply").click();
}
function overviewPointer(h, type, x, id = 1) {
  const event = new h.dom.window.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(event, { clientX: x, pointerId: id, button: 0 });
  (type === "pointerdown"
    ? h.$("recording-overview")
    : h.dom.window
  ).dispatchEvent(event);
}
function overviewKey(h, key) {
  h.$("recording-overview").dispatchEvent(
    new h.dom.window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

test("located issues use backend even median, separate missing runs at gaps, and report exact observed boundaries", async () => {
  const source = explorationRecording([100, 101, 102, 104, 106.5], {
    ppg: [0, null, 1, null, null],
  });
  source.inspection.gap_count = 1;
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.$("step-nav-inspect").click();
  const rows = [...h.$("issue-list").children];
  assert.deepEqual(
    rows.map((r) => [
      r.dataset.issueType,
      r.dataset.startS,
      r.dataset.endS,
      r.dataset.sampleCount,
    ]),
    [
      ["missing", "101", "101", "1"],
      ["missing", "104", "104", "1"],
      ["gap", "104", "106.5", undefined],
      ["missing", "106.5", "106.5", "1"],
    ],
  );
  assert.match(
    h.$("issue-summary").textContent,
    /1 timestamp gaps; 3 missing samples/,
  );
  assert.match(rows[2].textContent, /No samples are observed inside/);
  const solid = explorationRecording([100, 101, 102, 104, 106.5]);
  drawChart(
    h.$("chart"),
    solid.plot.times,
    { raw: solid.plot.channels.ppg },
    100,
    107.5,
    "a.u.",
  );
  assert.equal(
    h.$("chart").querySelectorAll(`path[stroke="${COLORS.raw}"]`).length,
    2,
    "even median splits the final gap in the detailed chart",
  );
  h.app.destroy();
});

test("issue jumps include context, focus waveform, and leave analysis/results/history unchanged", async () => {
  const source = explorationRecording(
    Array.from({ length: 101 }, (_, i) => 100 + i),
  );
  source.plot.channels.ppg[50] = null;
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState(),
    calls = h.calls.length;
  const analysisRange = [h.$("window-start").value, h.$("window-end").value];
  h.$("step-nav-inspect").click();
  h.$("issue-list").querySelector("button").click();
  const after = h.app.getState();
  assert.equal(after.step, "inspect");
  assert.ok(
    after.displayedWindow.start_s < 150 && after.displayedWindow.end_s > 150,
  );
  assert.equal(h.doc.activeElement, h.$("waveform-title"));
  assert.equal(after.result, before.result);
  assert.equal(after.runs, before.runs);
  assert.deepEqual(
    [h.$("window-start").value, h.$("window-end").value],
    analysisRange,
  );
  assert.equal(h.calls.length, calls);
  h.app.destroy();
});

test("exact custom numeric ranges persist per stage; reset and presets change only the display", async () => {
  const source = explorationRecording(Array.from({ length: 101 }, (_, i) => i));
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  setDisplay(h, 11.123456789, 17.987654321);
  assert.equal(h.app.getState().displayedWindow.start_s, 11.123456789);
  assert.equal(h.app.getState().displayedWindow.end_s, 17.987654321);
  assert.equal(h.$("zoom-span").value, "custom");
  h.$("step-nav-inspect").click();
  setDisplay(h, 40, 41.25);
  h.$("step-nav-compare").click();
  assert.equal(h.app.getState().displayedWindow.end_s, 17.987654321);
  h.$("step-nav-inspect").click();
  assert.equal(h.app.getState().displayedWindow.end_s, 41.25);
  setDisplay(h, 40, 40);
  assert.match(h.$("display-error").textContent, /end after start/);
  assert.equal(h.app.getState().displayedWindow.end_s, 41.25);
  h.$("zoom-reset").click();
  assert.deepEqual(
    [
      h.app.getState().displayedWindow.start_s,
      h.app.getState().displayedWindow.end_s,
    ],
    [0, 101],
  );
  h.$("zoom-span").value = "5";
  h.$("zoom-span").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.app.getState().displayedWindow.span, 5);
  assert.deepEqual(
    [h.$("window-start").value, h.$("window-end").value],
    ["0", "101"],
  );
  assert.equal(h.calls.filter((c) => c.path === "/api/analyze").length, 0);
  h.app.destroy();
});

test("overview pointer maps its own offset rect; click relocates, reverse drag selects, keyboard has equivalent navigation", async () => {
  const source = explorationRecording(Array.from({ length: 100 }, (_, i) => i));
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.$("recording-overview").getBoundingClientRect = () => ({
    left: 200,
    width: 400,
  });
  setDisplay(h, 0, 10);
  overviewPointer(h, "pointerdown", 400);
  overviewPointer(h, "pointerup", 400);
  assert.deepEqual(
    [
      h.app.getState().displayedWindow.start_s,
      h.app.getState().displayedWindow.end_s,
    ],
    [45, 55],
  );
  overviewPointer(h, "pointerdown", 520);
  overviewPointer(h, "pointermove", 280);
  overviewPointer(h, "pointerup", 280);
  assert.deepEqual(
    [
      h.app.getState().displayedWindow.start_s,
      h.app.getState().displayedWindow.end_s,
    ],
    [20, 80],
  );
  setDisplay(h, 20, 30);
  overviewKey(h, "ArrowRight");
  assert.equal(h.app.getState().displayedWindow.start_s, 30);
  overviewKey(h, "End");
  assert.equal(h.app.getState().displayedWindow.end_s, 100);
  overviewKey(h, "Home");
  assert.equal(h.app.getState().displayedWindow.start_s, 0);
  overviewKey(h, "ArrowLeft");
  assert.equal(h.app.getState().displayedWindow.start_s, 0);
  assert.equal(h.doc.activeElement, h.$("recording-overview"));
  h.app.destroy();
});

test("overview stays full original after restricted analysis; gestures clamp and Inspect whole recording escapes restriction", async () => {
  const source = explorationRecording(Array.from({ length: 100 }, (_, i) => i));
  const h = setup({
    "/api/demo": () => response(source),
    "/api/analyze": () => {
      const a = analysis();
      a.window = { start_s: 40, end_s: 60 };
      a.plot.times = [40, 41, 42];
      return response(a);
    },
  });
  await openFixture(h);
  const path = h.$("overview-path").getAttribute("d");
  h.$("window-start").value = "40";
  h.$("window-end").value = "60";
  h.submit("analysis-form");
  await tick();
  const result = h.app.getState().result,
    calls = h.calls.length;
  assert.equal(h.$("overview-path").getAttribute("d"), path);
  assert.match(
    h.$("overview-note").textContent,
    /0 to 99 s.*Analyzed \[40, 60\)/,
  );
  assert.equal(h.$("overview-analysis").hasAttribute("hidden"), false);
  assert.equal(Number(h.$("overview-analysis").getAttribute("x")), 400);
  h.$("recording-overview").getBoundingClientRect = () => ({
    left: 25,
    width: 200,
  });
  overviewPointer(h, "pointerdown", 25);
  overviewPointer(h, "pointerup", 225);
  assert.deepEqual(
    [
      h.app.getState().displayedWindow.start_s,
      h.app.getState().displayedWindow.end_s,
    ],
    [40, 60],
  );
  setDisplay(h, 45, 50);
  overviewKey(h, "End");
  assert.equal(h.app.getState().displayedWindow.end_s, 60);
  h.$("overview-inspect").click();
  assert.equal(h.app.getState().step, "inspect");
  assert.equal(h.app.getState().displayedWindow.end_s, 100);
  assert.equal(h.app.getState().result, result);
  assert.equal(h.calls.length, calls);
  assert.deepEqual(
    [h.$("window-start").value, h.$("window-end").value],
    ["40", "60"],
  );
  h.app.destroy();
});

test("issue pagination counts all regions, channel changes reset page, and source replacement clears stale issues", async () => {
  const times = Array.from({ length: 40 }, (_, i) => 10 + i);
  let source = explorationRecording(times, {
    ppg: times.map((_, i) => (i % 2 ? null : 1)),
    clean: times.map(() => 0),
  });
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.$("step-nav-inspect").click();
  assert.equal(h.$("issue-list").children.length, 8);
  assert.match(h.$("issue-summary").textContent, /1–8 of 20/);
  h.$("issues-next").click();
  assert.match(h.$("issue-summary").textContent, /9–16 of 20/);
  h.$("issues-next").click();
  assert.equal(h.$("issue-list").children.length, 4);
  assert.equal(h.$("issues-next").disabled, true);
  h.$("channel").value = "clean";
  h.$("channel").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.$("issue-list").children.length, 0);
  assert.match(
    h.$("issue-summary").textContent,
    /No timestamp gaps or missing samples found/,
  );
  assert.doesNotMatch(h.$("issue-summary").textContent, /signal healthy/);
  h.$("channel").value = "ppg";
  h.$("channel").dispatchEvent(new h.dom.window.Event("change"));
  assert.match(h.$("issue-summary").textContent, /1–8 of 20/);
  const stale = h.$("issue-list").querySelector("button");
  source = explorationRecording([500, 501, 502], { ecg: [1, 2, 3] }, "ecg");
  h.$("step-nav-open").click();
  openSample(h);
  await tick();
  assert.equal(h.app.getState().step, "inspect");
  stale.click();
  assert.equal(h.$("issue-list").children.length, 0);
  assert.match(h.$("overview-note").textContent, /Original ecg: 500 to 502/);
  assert.equal(h.$("step-nav-compare").disabled, true);
  h.app.destroy();
});

test("missing edge samples, all missing channels, and arbitrary modalities navigate safely", async () => {
  for (const modality of ["ecg", "eeg", "other"]) {
    const source = explorationRecording(
      [12, 13, 14],
      { edge: [null, 1, null], all: [null, null, null] },
      modality,
    );
    const h = setup({ "/api/demo": () => response(source) });
    await openFixture(h);
    assert.equal(h.$("issue-list").children.length, 2);
    for (const button of h.$("issue-list").querySelectorAll("button")) {
      button.click();
      const w = h.app.getState().displayedWindow;
      assert.ok(w.start_s >= 12 && w.end_s <= 15 && w.end_s > w.start_s);
    }
    h.$("channel").value = "all";
    h.$("channel").dispatchEvent(new h.dom.window.Event("change"));
    assert.equal(h.$("issue-list").children.length, 1);
    assert.equal(h.$("issue-list").firstElementChild.dataset.sampleCount, "3");
    h.$("issue-list").querySelector("button").click();
    assert.equal(h.doc.activeElement, h.$("waveform-title"));
    assert.doesNotMatch(h.$("overview-path").getAttribute("d"), /NaN|Infinity/);
    assert.equal(
      h.calls.some((c) => c.path === "/api/analyze"),
      false,
    );
    h.app.destroy();
  }
});

test("overview cancels gestures on cancellation, resize, source loading and destroy without changing display", async () => {
  const source = explorationRecording(Array.from({ length: 100 }, (_, i) => i));
  const pending = deferred();
  let replacement = false;
  const h = setup({
    "/api/demo": () => (replacement ? pending.promise : response(source)),
  });
  await openFixture(h);
  const svg = h.$("recording-overview");
  svg.getBoundingClientRect = () => ({ left: 100, width: 200 });
  setDisplay(h, 20, 30);
  for (const cancel of [
    () => overviewPointer(h, "pointercancel", 160),
    () => h.dom.window.dispatchEvent(new h.dom.window.Event("resize")),
    () => overviewKey(h, "Escape"),
  ]) {
    overviewPointer(h, "pointerdown", 120);
    overviewPointer(h, "pointermove", 240);
    cancel();
    overviewPointer(h, "pointerup", 240);
    assert.equal(h.app.getState().displayedWindow.start_s, 20);
  }
  overviewPointer(h, "pointerdown", 120);
  replacement = true;
  h.$("step-nav-open").click();
  openSample(h);
  overviewPointer(h, "pointerup", 240);
  assert.equal(h.$("zoom-apply").disabled, true);
  assert.equal(svg.getAttribute("aria-disabled"), "true");
  pending.resolve(response(source));
  await tick();
  h.$("continue-inspect").click();
  setDisplay(h, 20, 30);
  overviewPointer(h, "pointerdown", 120);
  h.app.destroy();
  overviewPointer(h, "pointerup", 240);
  assert.equal(h.app.getState().displayedWindow.start_s, 20);
});

test("100000 samples keep overview and issue DOM bounded, retaining extrema and immutable originals", async () => {
  const times = Object.freeze(
    Array.from({ length: 100000 }, (_, i) => i / 100),
  );
  const values = times.map((_, i) =>
    i % 2 ? null : i === 50000 ? Number.MAX_VALUE : -Number.MAX_VALUE,
  );
  const source = explorationRecording(times, { ppg: Object.freeze(values) });
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  const path = h.$("overview-path").getAttribute("d");
  assert.ok(path.length < 150000);
  assert.ok((path.match(/M/g) || []).length <= 4000);
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.match(path, /,14\.000/);
  assert.match(path, /,106\.000/);
  assert.equal(h.$("recording-overview").children.length, 3);
  assert.equal(h.$("issue-list").children.length, 8);
  assert.match(
    h.$("issue-summary").textContent,
    /50000 missing samples.*of 50000/,
  );
  assert.match(
    h.$("overview-note").textContent,
    /Display-only reduction retains extrema/,
  );
  setDisplay(h, 500, 501);
  assert.equal(h.$("overview-path").getAttribute("d"), path);
  assert.equal(source.plot.channels.ppg[50000], Number.MAX_VALUE);
  h.app.destroy();
});

test("overview normalization remains finite for narrow, subnormal and opposite-extreme timestamps", async () => {
  for (const times of [
    [1e15, 1e15 + 1, 1e15 + 2],
    [-1e308, 0, 1e308],
    [0, Number.MIN_VALUE, Number.MIN_VALUE * 2],
  ]) {
    const source = explorationRecording(
      times,
      { other: [-Number.MAX_VALUE, 0, Number.MAX_VALUE] },
      "other",
    );
    const h = setup({ "/api/demo": () => response(source) });
    Object.defineProperty(h.$("chart"), "clientWidth", { value: 260 });
    await openFixture(h);
    assert.doesNotMatch(h.$("recording-overview").innerHTML, /NaN|Infinity/);
    for (const rect of h
      .$("recording-overview")
      .querySelectorAll("rect:not([hidden])")) {
      assert.ok(Number.isFinite(Number(rect.getAttribute("x"))));
      assert.ok(Number.isFinite(Number(rect.getAttribute("width"))));
    }
    h.app.destroy();
  }
});

test("even-median overview disconnects the exact backend gap and last missing jump includes its half-open endpoint", async () => {
  const source = explorationRecording([100, 101, 102, 104, 106.5]);
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.$("step-nav-inspect").click();
  assert.equal(
    h.$("chart").querySelectorAll(`path[stroke="${COLORS.raw}"]`).length,
    2,
    "the detailed original plot also disconnects the backend's even-median gap",
  );
  assert.equal(
    (h.$("overview-path").getAttribute("d").match(/M/g) || []).length,
    2,
  );
  assert.deepEqual(
    [...h.$("issue-list").children].map((r) => r.dataset.issueType),
    ["gap"],
  );
  h.app.destroy();
  const lastMissing = explorationRecording([100, 101, 102, 103], {
    ppg: [1, 2, 3, null],
  });
  lastMissing.recording.sample_rate_hz = 125;
  const g = setup({ "/api/demo": () => response(lastMissing) });
  await openFixture(g);
  g.$("step-nav-inspect").click();
  g.$("issue-list").querySelector("button").click();
  assert.ok(g.app.getState().displayedWindow.end_s > 103);
  assert.ok(g.app.getState().displayedWindow.end_s <= 103.008);
  g.app.destroy();
});

test("issue jumps retain large-offset affected timestamps inside the half-open view", async () => {
  const times = [1e16, 1e16 + 2, 1e16 + 4];
  const source = explorationRecording(times, { ecg: [1, 2, null] }, "ecg");
  source.recording.sample_rate_hz = 0.5;
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  const before = JSON.stringify(source.plot);
  const calls = h.calls.length;
  h.$("issue-list").querySelector("button").click();
  const range = h.app.getState().displayedWindow;
  assert.ok(range.start_s <= times[2]);
  assert.ok(
    range.end_s > times[2],
    "the final missing sample must be inside the half-open view",
  );
  assert.equal(range.end_s, 1e16 + 6);
  assert.ok(range.end_s <= range.upper);
  assert.match(h.$("display-note").textContent, /3 samples/);
  assert.equal(h.doc.activeElement, h.$("waveform-title"));
  assert.equal(JSON.stringify(source.plot), before);
  assert.equal(h.calls.length, calls);
  h.app.destroy();
});

test("many timestamp gaps bound overview marks and issue rows without dropping exact counts", async () => {
  let t = 100;
  const times = Array.from({ length: 100000 }, (_, i) => {
    t += i % 3 === 0 ? 10 : 1;
    return t;
  });
  const source = explorationRecording(times);
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  assert.match(h.$("issue-summary").textContent, /33333 timestamp gaps/);
  assert.equal(h.$("issue-list").children.length, 8);
  const path = h.$("overview-path").getAttribute("d");
  assert.ok(path.length < 150000);
  assert.ok((path.match(/M/g) || []).length <= 4000);
  assert.doesNotMatch(path, /NaN|Infinity/);
  h.app.destroy();
});

test("completed analysis stays display-busy during delayed history refresh, then exact numeric controls become available", async () => {
  const source = explorationRecording(Array.from({ length: 100 }, (_, i) => i));
  const history = deferred();
  let delayHistory = false;
  const h = setup({
    "/api/demo": () => response(source),
    "/api/experiments/experiment-1": () =>
      delayHistory ? history.promise : response({}),
  });
  await openFixture(h);
  delayHistory = true;
  h.submit("analysis-form");
  await tick();
  assert.ok(h.app.getState().result);
  assert.equal(h.$("zoom-apply").disabled, true);
  const old = h.app.getState().displayedWindow;
  setDisplay(h, 0.001, 0.002);
  assert.deepEqual(h.app.getState().displayedWindow, old);
  history.resolve(response(structuredClone(h.experiments.get("experiment-1"))));
  await tick();
  assert.equal(h.$("zoom-apply").disabled, false);
  setDisplay(h, 0.001, 0.002);
  assert.equal(h.app.getState().displayedWindow.start_s, 0.001);
  assert.equal(h.app.getState().displayedWindow.end_s, 0.002);
  h.app.destroy();
});

test("issue jumps explain an unavailable exclusive endpoint without exceeding finite recording limits", async () => {
  const source = explorationRecording(
    [0, 1, 2, 1e16],
    { ecg: [1, 2, 3, null] },
    "ecg",
  );
  const h = setup({ "/api/demo": () => response(source) });
  await openFixture(h);
  h.$("issue-list").querySelector('[data-issue-type="missing"] button').click();
  const range = h.app.getState().displayedWindow;
  assert.ok(Number.isFinite(range.start_s) && Number.isFinite(range.end_s));
  assert.ok(range.end_s > range.start_s);
  assert.equal(range.end_s, range.upper);
  assert.equal(range.end_s, source.plot.times.at(-1));
  assert.match(
    h.$("display-error").textContent,
    /final affected timestamp.*cannot be included.*no supported finite exclusive endpoint/,
  );
  assert.equal(h.doc.activeElement, h.$("waveform-title"));
  assert.equal(
    h.calls.some((c) => c.path === "/api/analyze"),
    false,
  );
  h.app.destroy();
});

test("opening screen has one explicit source entry and hides empty session/context/status", async () => {
  const h = setup();
  await h.app.init();
  assert.equal(h.$("open-title").textContent, "Open a recording");
  assert.equal(h.$("source-picker").hidden, false);
  for (const id of [
    "protocol-form",
    "import-panel",
    "session-resume",
    "experiment-context",
    "status",
    "continue-inspect",
    "return-recording",
    "change-recording",
  ])
    assert.equal(h.$(id).hidden, true, id);
  assert.equal(h.$("csv-file").labels[0].textContent.trim(), "Open CSV");
  assert.equal(h.$("csv-file").type, "file");
  assert.equal(
    h.calls.some((c) => c.path === "/api/demo"),
    false,
  );
  assert.equal(h.$("sample-chooser").hidden, true);
  const toggle = h.$("sample-chooser-toggle");
  assert.equal(toggle.getAttribute("aria-controls"), "sample-chooser");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(h.doc.activeElement, h.$("demo-select"));
  h.$("demo-select").value = "bidmc_01";
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(h.doc.activeElement, toggle);
  openSample(h);
  await tick();
  assert.equal(
    h.calls.find((c) => c.path === "/api/demo").body.demo_id,
    "bidmc_01",
  );
  assert.equal(h.$("source-picker").hidden, true);
  assert.equal(h.$("protocol-form").hidden, false);
  assert.equal(h.$("change-recording").hidden, false);
  assert.equal(h.doc.activeElement, stageTitle(h));
});

test("Change and Return retain an unsaved protocol draft without creating an experiment", async () => {
  const h = setup();
  await h.app.init();
  openSample(h);
  await tick();
  h.$("experiment-name").value = "My draft";
  h.$("experiment-name").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  h.$("protocol-details-toggle").click();
  h.$("protocol-notes").value = "Keep these notes";
  h.$("protocol-notes").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  const before = h.app.getState();
  h.$("change-recording").click();
  assert.equal(h.$("return-recording").closest("[hidden]"), null);
  assert.equal(h.$("source-picker").hidden, false);
  h.$("return-recording").click();
  assert.equal(h.$("protocol-form").hidden, false);
  assert.equal(h.$("experiment-name").value, "My draft");
  assert.equal(h.$("protocol-notes").value, "Keep these notes");
  assert.equal(h.$("protocol-details").hidden, false);
  assert.equal(h.app.getState().view, before.view);
  assert.equal(h.app.getState().experiment, null);
  assert.equal(
    h.calls.some((c) => c.path === "/api/experiments" && c.body),
    false,
  );
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
});

test("source chooser, cancelled mapping and failed import retain saved results until replacement succeeds", async () => {
  let fail = true;
  const h = setup({
    "/api/import": () =>
      fail
        ? response({ detail: "Fix the time unit" }, false)
        : response(recording("replacement", "pulse")),
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState();
  chooseRecording(h);
  assert.equal(h.app.getState().result, before.result);
  h.$("return-recording").click();
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.$("export").disabled, false);
  await h.file();
  assert.equal(h.$("source-picker").hidden, true);
  assert.equal(h.$("protocol-form").hidden, true);
  assert.equal(h.$("time-column").closest("[hidden]"), null);
  h.$("import-cancel").click();
  assert.equal(h.app.getState().openingView, "setup");
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.app.getState().experiment.id, before.experiment.id);
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
  await h.file();
  h.submit("import-form");
  await tick();
  assert.match(h.$("error").textContent, /Fix the time unit/);
  assert.equal(h.$("import-form").closest("[hidden]"), null);
  assert.equal(h.$("import-name").textContent, "wave.csv");
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.app.getState().experiment.id, before.experiment.id);
  assert.equal(h.$("session-resume").hidden, false);
  assert.equal(h.$("session-list").querySelectorAll("button").length, 1);
  fail = false;
  h.submit("import-form");
  await tick();
  assert.equal(h.app.getState().view.recording.id, "replacement");
  assert.equal(h.app.getState().result, null);
  assert.equal(h.app.getState().experiment, null);
  assert.equal(h.$("session-resume").hidden, false);
  h.$("guide-sessions").click();
  assert.equal(
    sessionButton(h, before.experiment.id).closest("[hidden]"),
    null,
  );
  sessionButton(h, before.experiment.id).click();
  await tick();
  assert.equal(h.app.getState().experiment.id, before.experiment.id);
  assert.equal(h.app.getState().view.recording.id, "demo");
  assert.equal(h.app.getState().runs.length, 1);
});

test("Return cancels pending sample replacement without discarding result or accepting stale completion", async () => {
  let count = 0;
  const waiting = deferred();
  const h = setup({
    "/api/demo": () =>
      ++count === 1 ? response(recording()) : waiting.promise,
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState();
  openSample(h);
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.$("step-nav-inspect").disabled, true);
  h.$("return-recording").click();
  assert.equal(h.$("protocol-form").hidden, false);
  assert.equal(h.app.getState().result, before.result);
  waiting.resolve(response(recording("obsolete")));
  await tick();
  assert.equal(h.app.getState().view, before.view);
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.$("export").disabled, false);
  assert.equal(h.doc.activeElement, stageTitle(h));
});

test("failed sample and CSV preview provide visible recovery while keeping loaded work", async () => {
  let count = 0;
  const h = setup({
    "/api/demo": () =>
      ++count === 1
        ? response(recording())
        : response({ detail: "Sample unavailable" }, false),
    "/api/preview": () => response({ detail: "Malformed CSV" }, false),
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState();
  openSample(h);
  await tick();
  assert.match(h.$("error").textContent, /Sample unavailable/);
  assert.equal(h.$("csv-file").closest("[hidden]"), null);
  assert.equal(h.$("return-recording").closest("[hidden]"), null);
  assert.equal(h.app.getState().result, before.result);
  await h.file();
  assert.match(h.$("error").textContent, /Malformed CSV/);
  assert.equal(h.$("csv-file").closest("[hidden]"), null);
  assert.equal(h.$("return-recording").closest("[hidden]"), null);
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
  h.$("return-recording").click();
  assert.equal(h.app.getState().result, before.result);
  assert.equal(h.app.getState().experiment.id, before.experiment.id);
});

test("CSV read can be cancelled from a visible surface and late reading cannot reveal mapping", async () => {
  const reading = deferred();
  const h = setup();
  await h.app.init();
  const pending = h.file("slow.csv", () => reading.promise);
  assert.equal(h.$("import-cancel").closest("[hidden]"), null);
  assert.equal(h.$("import-form").hidden, true);
  h.$("import-cancel").click();
  assert.equal(h.doc.activeElement, h.$("csv-file"));
  reading.resolve("t,pulse\n0,1");
  await pending;
  assert.equal(h.$("source-picker").hidden, false);
  assert.equal(h.$("import-panel").hidden, true);
  assert.equal(
    h.calls.some((c) => c.path === "/api/preview"),
    false,
  );
});

test("opening and returning from chooser preserves in-flight comparison; source replacement rejects its stale errors", async () => {
  const waiting = deferred();
  const h = setup({ "/api/analyze": () => waiting.promise });
  await openFixture(h);
  h.submit("analysis-form");
  chooseRecording(h);
  h.$("return-recording").click();
  waiting.resolve(response(analysis()));
  await tick();
  assert.equal(h.app.getState().result.id, "analysis");
  assert.equal(h.app.getState().step, "open");
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
  const stale = deferred();
  const g = setup({ "/api/analyze": () => stale.promise });
  await openFixture(g);
  g.submit("analysis-form");
  await g.file();
  stale.resolve(response({ detail: "obsolete analysis failure" }, false));
  await tick();
  assert.equal(g.$("error").hidden, true);
  assert.equal(g.$("time-column").closest("[hidden]"), null);
});

test("chooser presentation during delayed history refresh cannot strand comparison busy state", async () => {
  const waiting = deferred();
  let details = 0;
  const h = setup({
    "/api/experiments/experiment-1": () => {
      details++;
      return waiting.promise;
    },
  });
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  assert.equal(details, 1);
  const current = h.app.getState();
  assert.equal(current.result.id, "analysis");
  chooseRecording(h);
  h.$("return-recording").click();
  waiting.resolve(
    response({
      ...h.experiments.get("experiment-1"),
      runs: h.experiments.get("experiment-1").runs,
    }),
  );
  await tick();
  assert.equal(h.app.getState().result, current.result);
  assert.equal(h.$("analyze").disabled, false);
  h.$("continue-inspect").click();
  h.$("continue-compare").click();
  assert.equal(h.$("zoom-start").disabled, false);
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
});

test("Change recording during protocol save preserves successful save without navigating or stealing chooser focus", async () => {
  const waiting = deferred();
  let savedProtocol;
  const saved = {
    id: "saved-late",
    recording_id: "demo",
    runs: [],
    run_count: 0,
  };
  const h = setup({
    "/api/experiments": (body) => {
      if (!body)
        return response({
          experiments: savedProtocol
            ? [{ ...saved, protocol: savedProtocol }]
            : [],
          storage: "memory",
        });
      savedProtocol = body.protocol;
      return waiting.promise;
    },
  });
  await h.app.init();
  openSample(h);
  await tick();
  assert.equal(h.$("start-experiment").closest("[hidden]"), null);
  h.$("start-experiment").click();
  assert.ok(savedProtocol);
  h.$("change-recording").click();
  h.$("sample-chooser-toggle").click();
  assert.equal(h.doc.activeElement, h.$("demo-select"));
  waiting.resolve(response({ ...saved, protocol: savedProtocol }));
  await tick();
  assert.equal(h.app.getState().experiment.id, "saved-late");
  assert.equal(h.app.getState().step, "open");
  assert.equal(h.app.getState().openingView, "choice");
  assert.equal(h.$("source-picker").closest("[hidden]"), null);
  assert.equal(h.doc.activeElement, h.$("demo-select"));
  assert.equal(h.$("session-resume").hidden, false);
  h.$("return-recording").click();
  assert.equal(h.$("protocol-form").closest("[hidden]"), null);
  assert.equal(h.$("start-experiment").disabled, true);
  assert.equal(h.app.getState().protocolDirty, false);
  assert.equal(h.$("experiment-name").value, savedProtocol.name);
  h.$("continue-inspect").click();
  assert.equal(h.app.getState().step, "inspect");
});

test("non-PPG return identifies retained recording and offers explicit inspection without protocol setup", async () => {
  for (const modality of ["ecg", "eeg", "other"]) {
    const h = setup({
      "/api/demo": () =>
        response(recording(`${modality}-source`, "signal", modality)),
    });
    await h.app.init();
    openSample(h);
    await tick();
    assert.equal(h.app.getState().step, "inspect");
    const before = h.app.getState().view;
    h.$("back-open").click();
    assert.equal(h.$("open-title").textContent, "Inspect recording");
    h.$("change-recording").click();
    assert.equal(h.$("inspection-entry").hidden, true);
    h.$("return-recording").click();
    assert.equal(h.$("open-title").textContent, "Inspect recording");
    assert.equal(h.$("inspection-entry-name").closest("[hidden]"), null);
    assert.equal(
      h.$("inspection-entry-name").textContent,
      before.recording.name,
    );
    assert.match(
      h.$("inspection-entry-note").textContent,
      new RegExp(`${modality.toUpperCase()} / inspection only`),
    );
    assert.match(
      h.$("inspection-entry-note").textContent,
      /analysis is not available/,
    );
    assert.equal(h.$("protocol-form").hidden, true);
    assert.equal(h.$("continue-inspect").textContent, "Continue to Inspect");
    assert.equal(h.$("continue-inspect").closest("[hidden]"), null);
    assert.equal(h.doc.activeElement.closest("[hidden]"), null);
    assert.equal(h.app.getState().view, before);
    h.$("continue-inspect").click();
    assert.equal(h.app.getState().step, "inspect");
    assert.equal(h.$("step-nav-compare").disabled, true);
    assert.equal(
      h.calls.some(
        (c) =>
          c.path === "/api/analyze" ||
          (c.path === "/api/experiments" && c.body),
      ),
      false,
    );
  }
});

test("notebook library and recording identity remain reachable from every view without reloading current work", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState(),
    button = sessionButton(h, before.experiment.id);
  assert.equal(button.getAttribute("aria-current"), "true");
  assert.match(button.textContent, /1 run/);
  assert.equal(
    h.$("current-recording-open").textContent,
    before.view.recording.name,
  );
  for (const view of ["open", "inspect", "compare", "export"]) {
    h.$("step-nav-" + view).click();
    h.$("guide-sessions").click();
    assert.equal(button.closest("[hidden]"), null);
    assert.equal(h.$("current-recording-open").closest("[hidden]"), null);
    const count = h.calls.length;
    button.click();
    assert.equal(h.app.getState().step, "inspect");
    assert.equal(h.calls.length, count);
    assert.deepEqual(h.app.getState().result, before.result);
    assert.deepEqual(h.app.getState().runs, before.runs);
  }
  h.$("step-nav-export").click();
  h.$("current-recording-open").click();
  assert.equal(h.app.getState().step, "inspect");
  assert.deepEqual(h.app.getState().result, before.result);
});

test("current experiment selection restores setup while preserving a dirty draft and retained runs", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  h.$("step-nav-open").click();
  edit(h, "experiment-name", "Uncommitted notebook draft");
  const before = h.app.getState();
  h.$("change-recording").click();
  const count = h.calls.length;
  sessionButton(h, before.experiment.id).click();
  assert.equal(h.calls.length, count);
  assert.equal(h.app.getState().step, "open");
  assert.equal(h.$("protocol-form").hidden, false);
  assert.equal(h.$("experiment-name").value, "Uncommitted notebook draft");
  assert.equal(h.app.getState().protocolDirty, true);
  assert.deepEqual(h.app.getState().result, before.result);
  assert.deepEqual(h.app.getState().runs, before.runs);
  assert.match(
    sessionButton(h, before.experiment.id).textContent,
    /unsaved changes/,
  );
  assert.equal(h.doc.activeElement, stageTitle(h));
});

test("failed or expired list selection keeps current recording, protocol and result, clears busy and retries", async () => {
  let fail = true;
  const pending = deferred();
  const h = setup({
    "/api/experiments/experiment-1/recording": () =>
      fail ? pending.promise : response(recording("demo")),
  });
  await openFixture(h);
  await forkFixture(h);
  h.$("step-nav-compare").click();
  h.submit("analysis-form");
  await tick();
  const before = h.app.getState();
  const button = sessionButton(h, "experiment-1");
  button.focus();
  button.click();
  assert.equal(button.getAttribute("aria-busy"), "true");
  assert.equal(button.disabled, true);
  pending.resolve(response({ detail: "Expired recording" }, false));
  await tick();
  assert.deepEqual(h.app.getState().view, before.view);
  assert.deepEqual(h.app.getState().experiment, before.experiment);
  assert.deepEqual(h.app.getState().result, before.result);
  assert.equal(h.$("experiment-name").value, before.experiment.protocol.name);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "false");
  assert.equal(h.$("session-list").getAttribute("aria-busy"), "false");
  assert.match(h.$("error").textContent, /Expired recording/);
  fail = false;
  button.click();
  await tick();
  assert.equal(h.app.getState().experiment.id, "experiment-1");
  assert.equal(button.getAttribute("aria-current"), "true");
});

test("session refresh updates retained buttons without replacing keyboard focus", async () => {
  const pending = deferred();
  const h = setup({ "/api/analyze": () => pending.promise });
  await openFixture(h);
  const button = sessionButton(h, "experiment-1");
  h.submit("analysis-form");
  h.$("step-nav-inspect").click();
  h.$("guide-sessions").click();
  button.focus();
  pending.resolve(response(analysis()));
  await tick();
  assert.equal(sessionButton(h, "experiment-1"), button);
  assert.equal(h.doc.activeElement, button);
  assert.match(button.textContent, /1 run/);
});

test("session eviction moves focus to visible navigation instead of a removed library button", async () => {
  const pending = deferred();
  const h = setup({ "/api/analyze": () => pending.promise });
  await openFixture(h);
  await forkFixture(h);
  const old = sessionButton(h, "experiment-1");
  h.$("step-nav-compare").click();
  h.submit("analysis-form");
  h.$("step-nav-inspect").click();
  h.$("guide-sessions").click();
  old.focus();
  h.experiments.delete("experiment-1");
  pending.resolve(response(analysis()));
  await tick();
  assert.equal(old.isConnected, false);
  assert.equal(h.doc.activeElement, h.$("session-dialog-close"));
  assert.equal(h.doc.activeElement.closest("[hidden]"), null);
  assert.equal(h.$("session-list").querySelectorAll("button").length, 1);
});

test("narrow library defaults closed, opens by native control, and collapses with safe focus on resize", async () => {
  const h = setup({}, (dom) => {
    dom.window.innerWidth = 390;
  });
  await openFixture(h);
  h.$("guide-sessions").click();
  const toggle = h.$("session-library-toggle"),
    panel = h.$("session-library");
  assert.equal(panel.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), panel.id);
  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const button = sessionButton(h, "experiment-1");
  button.focus();
  toggle.click();
  assert.equal(h.doc.activeElement, toggle);
  h.dom.window.innerWidth = 1100;
  h.dom.window.dispatchEvent(new h.dom.window.Event("resize"));
  assert.equal(panel.hidden, false);
  button.focus();
  h.dom.window.innerWidth = 390;
  h.dom.window.dispatchEvent(new h.dom.window.Event("resize"));
  assert.equal(panel.hidden, true);
  assert.equal(h.doc.activeElement, toggle);
  h.app.destroy();
  h.dom.window.innerWidth = 1100;
  h.dom.window.dispatchEvent(new h.dom.window.Event("resize"));
  assert.equal(panel.hidden, true);
});

test("cancelled experiment selection never labels a subsequent demo as that experiment loading", async () => {
  const reopen = deferred(),
    demo = deferred();
  let deferDemo = false;
  const h = setup({
    "/api/experiments/experiment-1/recording": () => reopen.promise,
    "/api/demo": () => (deferDemo ? demo.promise : response(recording())),
  });
  await openFixture(h);
  await forkFixture(h);
  sessionButton(h, "experiment-1").click();
  assert.equal(
    sessionButton(h, "experiment-1").getAttribute("aria-busy"),
    "true",
  );
  deferDemo = true;
  openSample(h);
  assert.equal(h.$("session-list").getAttribute("aria-busy"), "false");
  assert.equal(
    sessionButton(h, "experiment-1").getAttribute("aria-busy"),
    "false",
  );
  assert.doesNotMatch(sessionButton(h, "experiment-1").textContent, /Opening/);
  demo.resolve(response(recording("replacement")));
  await tick();
  reopen.resolve(response(recording("obsolete")));
  await tick();
  assert.equal(h.app.getState().view.recording.id, "replacement");
  assert.equal(h.$("main-content").dataset.recordingId, "replacement");
  assert.equal(h.$("main-content").dataset.experimentId, undefined);
  assert.equal(h.$("main-content").dataset.resultId, undefined);
});

test("DOM identity follows only actual current recording, experiment, result and view", async () => {
  const h = setup();
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  const main = h.$("main-content"),
    state = h.app.getState();
  assert.equal(main.dataset.recordingId, state.view.recording.id);
  assert.equal(main.dataset.experimentId, state.experiment.id);
  assert.equal(main.dataset.resultId, state.result.id);
  assert.equal(main.dataset.stage, state.step);
  edit(h, "highpass", "0.5");
  assert.equal(main.dataset.resultId, undefined);
  assert.equal(main.dataset.experimentId, state.experiment.id);
});

test("measurement rounding respects resolution, sign, unavailable and finite extremes", () => {
  for (const [key, cases] of [
    [
      "mean_absolute_shift_ms",
      [
        [0, "0"],
        [-0, "0"],
        [0.099999, "<0.1"],
        [0.1, "0.1"],
        [1.24, "1.2"],
        [1.26, "1.3"],
        [2, "2"],
        [1.521126760563588, "1.5"],
        [-0.001, ">-0.1"],
        [-1.26, "-1.3"],
      ],
    ],
    [
      "centered_normalized_rmse",
      [
        [0, "0"],
        [0.000999, "<0.001"],
        [0.001, "0.001"],
        [0.8341855229029985, "0.834"],
        [0.1234, "0.123"],
        [0.1236, "0.124"],
        [0.12, "0.12"],
        [-0.0001, ">-0.001"],
      ],
    ],
  ]) {
    for (const [value, expected] of cases)
      assert.equal(formatMeasurement(value, key), expected);
    for (const value of [null, undefined, NaN, Infinity, -Infinity, "1"])
      assert.equal(formatMeasurement(value, key), "not available");
    assert.equal(
      formatMeasurement(Number.MIN_VALUE, key),
      key.endsWith("ms") ? "<0.1" : "<0.001",
    );
    assert.equal(formatMeasurement(Number.MAX_VALUE, key), "1.798e+308");
    assert.equal(formatMeasurement(-Number.MAX_VALUE, key), "-1.798e+308");
  }
});

test("excluded percentages preserve tiny values and avoid scaling overflow", () => {
  for (const [value, expected] of [
    [0, "0%"],
    [0.00001, "<0.1%"],
    [0.001, "0.1%"],
    [0.123456, "12.3%"],
    [0.2, "20%"],
    [-0.00001, ">-0.1%"],
    [Number.MAX_VALUE, "1.798e+310%"],
    [Number.MIN_VALUE, "<0.1%"],
    [null, "not available"],
    [Infinity, "not available"],
  ])
    assert.equal(formatExcludedPercent(value), expected);
});

for (const target of ["pulse_timing", "waveform_sensitivity"]) {
  test(`rounded ${target} surfaces retain precise request, evidence and download bytes`, async () => {
    const data = analysis();
    data.goal = target;
    const raw = {
      ...metrics,
      mean_absolute_shift_ms: 1.521126760563588,
      maximum_absolute_shift_ms: 2.3456789,
      centered_normalized_rmse: 0.8341855229029985,
    };
    data.metrics = {
      unchanged: { ...raw },
      median: { ...raw },
      highpass: { ...raw },
    };
    data.exclusions.excluded_fraction = 0.123456789;
    data.window = { start_s: 0.000123456789, end_s: 0.023456789123 };
    const before = structuredClone(data);
    let n = 0;
    const exportBytes = JSON.stringify({
      metrics: raw,
      window: data.window,
      exclusions: data.exclusions,
    });
    const h = setup({
      "/api/analyze": () =>
        response({ ...structuredClone(data), id: `precise-${++n}` }),
      "/api/experiments/experiment-1/runs/precise-2/export": () => ({
        ok: true,
        blob: async () => new Blob([exportBytes]),
      }),
      "/api/experiments/experiment-1/export": () => ({
        ok: true,
        blob: async () => new Blob([exportBytes]),
      }),
    });
    await h.app.init();
    openSample(h);
    await tick();
    if (target === "waveform_sensitivity") h.$("target-waveform").click();
    h.submit("protocol-form");
    await tick();
    h.$("continue-compare").click();
    edit(h, "window-start", "0.000123456789");
    edit(h, "window-end", "0.023456789123");
    edit(h, "median-window", "0.9");
    for (let i = 0; i < 2; i++) {
      h.submit("analysis-form");
      await tick();
    }
    const expected = target === "pulse_timing" ? "1.5" : "0.834";
    assert.ok(
      h
        .$("results-intro")
        .textContent.includes(`median subtraction ${expected}`),
    );
    for (const section of h.$("method-comparison").children) {
      const values = [...section.querySelectorAll("dd")].map(
        (el) => el.textContent,
      );
      assert.ok(values.includes("1.5"));
      assert.ok(values.includes("0.834"));
    }
    const tableValues = [...h.$("metrics").querySelectorAll("td")].map(
      (el) => el.textContent,
    );
    assert.ok(tableValues.includes("1.5"));
    assert.ok(tableValues.includes("0.834"));
    assert.ok(tableValues.includes("2.3"));
    for (const id of ["exclusion-summary", "exclusions", "run-history"])
      assert.ok(h.$(id).textContent.includes("12.3%"));
    for (const input of h.$("run-history").querySelectorAll("input"))
      input.click();
    assert.ok(h.$("run-comparison").textContent.includes("12.3%"));
    assert.ok(
      [...h.$("run-comparison").querySelectorAll("td")].some(
        (el) => el.textContent === expected,
      ),
    );
    assert.deepEqual(
      JSON.parse(h.$("metric-details").textContent),
      before.metrics,
    );
    assert.deepEqual(
      JSON.parse(h.$("exclusion-details").textContent),
      before.exclusions,
    );
    assert.deepEqual(h.app.getState().result.metrics, before.metrics);
    assert.deepEqual(data, before);
    for (const call of h.calls.filter((c) => c.path === "/api/analyze")) {
      assert.equal(call.body.start_s, before.window.start_s);
      assert.equal(call.body.end_s, before.window.end_s);
      assert.equal(call.body.parameters.median_window_s, 0.9);
    }
    assert.equal(h.$("window-start").value, "0.000123456789");
    assert.equal(h.$("window-end").value, "0.023456789123");
    const downloaded = [],
      originalURL = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      downloaded.push(blob);
      return "blob:precise";
    };
    const click = h.dom.window.HTMLAnchorElement.prototype.click;
    h.dom.window.HTMLAnchorElement.prototype.click = () => {};
    try {
      h.$("continue-export").click();
      h.$("export").click();
      await tick();
      h.$("export-experiment").click();
      await tick();
      assert.equal(downloaded.length, 2);
      for (const blob of downloaded)
        assert.equal(await blob.text(), exportBytes);
    } finally {
      URL.createObjectURL = originalURL;
      h.dom.window.HTMLAnchorElement.prototype.click = click;
      h.app.destroy();
    }
  });
}

for (const [value, timingText, waveformText, fraction, percentage] of [
  [0, "0", "0", 0, "0%"],
  [Number.MIN_VALUE, "<0.1", "<0.001", Number.MIN_VALUE, "<0.1%"],
  [null, "not available", "not available", null, "not available"],
  [
    Number.MAX_VALUE,
    "1.798e+308",
    "1.798e+308",
    Number.MAX_VALUE,
    "1.798e+310%",
  ],
]) {
  test(`measurement surfaces agree for ${value}`, async () => {
    let n = 0;
    const h = setup({
      "/api/analyze": () => {
        const data = analysis();
        data.id = `boundary-${++n}`;
        data.metrics = Object.fromEntries(
          ["unchanged", "median", "highpass"].map((method) => [
            method,
            {
              ...metrics,
              mean_absolute_shift_ms: value,
              maximum_absolute_shift_ms: value,
              centered_normalized_rmse: value,
            },
          ]),
        );
        data.exclusions.excluded_fraction = fraction;
        return response(data);
      },
    });
    await openFixture(h);
    for (let i = 0; i < 2; i++) {
      h.submit("analysis-form");
      await tick();
    }
    assert.ok(
      h
        .$("results-intro")
        .textContent.includes(`median subtraction ${timingText}`),
    );
    for (const section of h.$("method-comparison").children) {
      const values = [...section.querySelectorAll("dd")].map(
        (el) => el.textContent,
      );
      assert.deepEqual(values.slice(0, 2), [timingText, waveformText]);
    }
    for (const row of h.$("metrics").querySelectorAll("tbody tr")) {
      if (/timing shift/.test(row.querySelector("th").textContent))
        assert.ok(
          [...row.querySelectorAll("td")].every(
            (td) => td.textContent === timingText,
          ),
        );
      if (/Normalized waveform/.test(row.querySelector("th").textContent))
        assert.ok(
          [...row.querySelectorAll("td")].every(
            (td) => td.textContent === waveformText,
          ),
        );
    }
    for (const input of h.$("run-history").querySelectorAll("input"))
      input.click();
    for (const id of [
      "exclusion-summary",
      "exclusions",
      "run-history",
      "run-comparison",
    ])
      assert.ok(h.$(id).textContent.includes(percentage));
    const primaryRows = [
      ...h.$("run-comparison").querySelectorAll("tbody tr"),
    ].filter((row) => row.textContent.includes("Timing shift"));
    assert.equal(primaryRows.length, 3);
    for (const row of primaryRows)
      assert.ok(
        [...row.querySelectorAll("td")].every(
          (td) => td.textContent === timingText,
        ),
      );
    h.app.destroy();
  });
}

for (const [status, conclusion] of [
  ["completed", "candidate"],
  ["completed", "needs_information"],
  ["completed", "inconclusive"],
  ["failed", null],
]) {
  test(`Meta-only ${status}/${conclusion} reaches a readable report without a manual run or extra model request`, async () => {
    const h = setup({
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () =>
        response(investigationJob(status, conclusion)),
    });
    await openFixture(h);
    assert.equal(h.$("step-nav-export").disabled, true);
    assert.equal(h.$("manual-comparison").hidden, true);
    consentInvestigation(h);
    h.submit("investigation-form");
    await tick();
    assert.equal(
      h.app.getState().step,
      "compare",
      "completion leaves the researcher in control",
    );
    assert.equal(h.$("continue-export").disabled, false);
    const calls = h.calls.length;
    h.$("continue-export").click();
    assert.equal(h.app.getState().step, "export");
    assert.equal(h.$("download-report").disabled, false);
    assert.match(
      h.$("report-preview").textContent,
      /Review these measured changes|failed|transport/,
    );
    assert.match(h.$("report-scope").textContent, /Meta.*\[0, 0.024\)/);
    assert.equal(
      h.calls.length,
      calls,
      "report assembly never submits or fetches a model request",
    );
    assert.equal(h.calls.filter((c) => c.path === "/api/analyze").length, 0);
    assert.equal(
      h.calls.filter((c) => c.path === "/api/investigations").length,
      1,
    );
    h.app.destroy();
  });
}

test("manual-only readable report and HTML download use saved evidence without Meta", async () => {
  let downloaded;
  const h = setup(
    {
      "/api/analyze": (body) =>
        response({
          ...analysis(),
          experiment_id: body.experiment_id,
          comparison: "original",
          parameters: body.parameters,
        }),
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = function () {
        downloaded = { filename: this.download, href: this.href };
      };
    },
  );
  await openFixture(h);
  assert.equal(
    h.$("manual-comparison-toggle").getAttribute("aria-expanded"),
    "false",
  );
  h.$("manual-comparison-toggle").click();
  assert.equal(h.$("manual-comparison").hidden, false);
  h.submit("analysis-form");
  await tick();
  h.$("continue-export").click();
  assert.equal(h.$("download-report").disabled, false);
  assert.match(h.$("report-preview").textContent, /Meta was not used/);
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  let blob;
  URL.createObjectURL = (value) => {
    blob = value;
    return "blob:report";
  };
  URL.revokeObjectURL = () => {};
  try {
    const calls = h.calls.length;
    h.$("download-report").click();
    assert.equal(downloaded.filename, "signaltrace-report.html");
    const output = await blob.text();
    assert.match(output, /<!doctype html>/i);
    assert.match(output, /Meta was not used/);
    assert.equal(h.calls.length, calls);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    h.app.destroy();
  }
});

test("report source switching binds preview, replay URL and late downloads to the exact selected evidence", async () => {
  const pending = deferred();
  let downloads = 0;
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(investigationJob("completed")),
      "/api/analyze": (body) =>
        response({
          ...analysis(),
          comparison: "original",
          experiment_id: body.experiment_id,
          parameters: body.parameters,
        }),
      "/api/investigations/job-1/export": () => pending.promise,
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = () => {
        downloads++;
      };
    },
  );
  await openFixture(h);
  h.submit("analysis-form");
  await tick();
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("continue-export").click();
  assert.equal(h.$("report-source").options.length, 2);
  h.$("report-source").value = "investigation:job-1";
  h.$("report-source").dispatchEvent(new h.dom.window.Event("change"));
  assert.match(
    h.$("report-preview").textContent,
    /Review these measured changes/,
  );
  h.$("download-report-replay").click();
  await tick();
  assert.equal(h.calls.at(-1).path, "/api/investigations/job-1/export");
  h.$("report-source").value = "manual:analysis";
  h.$("report-source").dispatchEvent(new h.dom.window.Event("change"));
  assert.match(h.$("report-preview").textContent, /Meta was not used/);
  pending.resolve(response({ exact: "old investigation" }));
  await tick();
  assert.equal(
    downloads,
    0,
    "late data from a different report is never downloaded",
  );
  h.$("download-report-replay").click();
  await tick();
  assert.equal(
    h.calls.at(-1).path,
    "/api/experiments/experiment-1/runs/analysis/export",
  );
  assert.equal(downloads, 1);
  h.$("step-nav-open").click();
  edit(h, "research-question", "Changed saved question");
  assert.equal(h.$("step-nav-export").disabled, true);
  assert.equal(h.$("report-preview").textContent, "");
  h.app.destroy();
});

test("running or failed-without-evidence investigations cannot fabricate a report", async () => {
  for (const job of [
    investigationJob(),
    investigationJob("failed", null, { result: null }),
  ]) {
    const h = setup({
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(job),
    });
    await openFixture(h);
    consentInvestigation(h);
    h.submit("investigation-form");
    await tick();
    assert.equal(h.$("step-nav-export").disabled, true);
    assert.equal(h.$("download-report").disabled, true);
    assert.equal(h.$("report-preview").textContent, "");
    h.app.destroy();
  }
});

test("historical Meta report retains its question and interval while current inputs change, and replacement clears it", async () => {
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(investigationJob("completed")),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  const question = h.$("investigation-question").value;
  edit(h, "window-start", "0.008");
  edit(h, "investigation-question", "A new unsent question");
  h.$("continue-export").click();
  assert.match(
    h.$("report-scope").textContent,
    /Historical evidence.*current channel or interval differs/,
  );
  assert.match(h.$("report-scope").textContent, /\[0, 0.024\)/);
  assert.ok(h.$("report-preview").textContent.includes(question));
  assert.ok(
    !h.$("report-preview").textContent.includes("A new unsent question"),
  );
  const calls = h.calls.filter((c) => c.path === "/api/investigations").length;
  openSample(h);
  await tick();
  assert.equal(h.$("report-preview").textContent, "");
  assert.equal(h.$("download-report").disabled, true);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    calls,
  );
  h.app.destroy();
});

test("reviewing a selected investigation binds its own report after another report was retained", async () => {
  let posts = 0;
  const h = setup(
    {
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () =>
        response(
          investigationJob("completed", "candidate", { id: `job-${++posts}` }),
        ),
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = () => {};
    },
  );
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("review-investigation").click();
  assert.equal(h.$("report-source").value, "investigation:job-1");
  h.$("back-compare").click();
  edit(h, "window-end", "0.02");
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  assert.equal(h.$("investigation-history").value, "job-2");
  assert.equal(
    h.$("report-source").value,
    "investigation:job-1",
    "background completion preserves an existing report choice",
  );
  h.$("continue-export").click();
  assert.equal(h.$("report-source").value, "investigation:job-2");
  assert.match(h.$("report-scope").textContent, /\[0, 0.02\)/);
  assert.doesNotMatch(
    h.$("report-source").selectedOptions[0].textContent,
    /job-2/,
  );
  h.$("download-report-replay").click();
  await tick();
  assert.equal(h.calls.at(-1).path, "/api/investigations/job-2/export");
  h.$("back-compare").click();
  h.$("investigation-history").value = "job-1";
  h.$("investigation-history").dispatchEvent(new h.dom.window.Event("change"));
  h.$("review-investigation").click();
  assert.equal(h.$("report-source").value, "investigation:job-1");
  assert.match(h.$("report-scope").textContent, /\[0, 0.024\)/);
  h.app.destroy();
});

test("failed recording replacement restores the explicitly selected report for unchanged work", async () => {
  let opened = 0,
    posts = 0;
  const h = setup({
    "/api/demo": () =>
      ++opened === 1
        ? response(recording())
        : response({ detail: "Could not open sample" }, false),
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () =>
      response(
        investigationJob("completed", "candidate", { id: `job-${++posts}` }),
      ),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("continue-export").click();
  h.$("report-source").value = "investigation:job-1";
  h.$("report-source").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(h.$("report-source").value, "investigation:job-1");
  openSample(h);
  await tick();
  h.$("step-nav-export").click();
  assert.equal(h.$("report-source").value, "investigation:job-1");
  assert.equal(h.$("download-report").disabled, false);
  assert.equal(h.app.getState().view.recording.id, "demo");
  h.app.destroy();
});

function comparisonPayload(job, evidenceId) {
  const c = job.result.evidence[evidenceId];
  return {
    investigation_id: job.id,
    comparison_id: evidenceId,
    recording_id: job.request.recording_id,
    experiment_id: job.request.experiment_id,
    channel: job.request.channel,
    target: job.request.target,
    unit: "a.u.",
    result: {
      ...analysis(),
      comparison: "original",
      parameters: c.parameters,
      window: c.window,
      metrics: c.metrics,
      exclusions: {
        sample_count: 3,
        valid_count: 2,
        excluded_fraction: 1 / 3,
        nonfinite_count: 0,
        flatline_count: 0,
        gap_after_indices: [],
        valid_intervals_indices: [[1, 3]],
        too_short_segments: [],
      },
      plot: { ...analysis().plot, valid_mask: [false, true, true] },
    },
  };
}
test("comparison selection rejects late plots, gates pending HTML and keeps local interactions separate from Meta", async () => {
  const late = deferred(),
    job = investigationJob("completed");
  job.result.evidence.e3 = structuredClone(job.result.evidence.e2);
  job.result.evidence.e3.parameters.highpass_hz = 0.4;
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
    "/api/investigations/job-1/comparisons/e2": () => late.promise,
    "/api/investigations/job-1/comparisons/e3": () =>
      response(comparisonPayload(job, "e3")),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("review-investigation").click();
  assert.equal(h.$("download-report").disabled, true);
  for (const id of ["report-visuals", "investigation-visuals"]) {
    const select = h.$(id).querySelector("select");
    select.value = "e3";
    select.dispatchEvent(new h.dom.window.Event("change"));
  }
  await tick();
  assert.equal(h.$("download-report").disabled, false);
  assert.match(
    h.$("report-visuals").textContent,
    /comparison e3.*high-pass 0.4/,
  );
  const count = h.calls.length;
  const panel = h.$("report-visuals"),
    findButton = (text) =>
      [...panel.querySelectorAll("button")].find((b) => b.textContent === text);
  findButton("High-pass").click();
  findButton("Zoom in").click();
  findButton("Full analysis window").click();
  assert.equal(h.calls.length, count);
  late.resolve(response(comparisonPayload(job, "e2")));
  await tick();
  for (const id of ["report-visuals", "investigation-visuals"]) {
    assert.equal(h.$(id).querySelector("select").value, "e3");
    assert.match(h.$(id).textContent, /comparison e3/);
  }
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("/comparisons/e3")).length,
    1,
    "report and main panel share bounded local fetch cache",
  );
  h.app.destroy();
});

test("regional evidence cites exact summaries and navigates only its unchanged parent comparison plot", async () => {
  const job = investigationJob("completed");
  const parent = job.result.evidence.e2;
  job.result.evidence.e3 = structuredClone(parent);
  job.result.evidence.e3.parameters.highpass_hz = 0.4;
  job.result.conclusion.candidate.comparison_id = "e3";
  const regionalMetric = {
    reference_candidate_count: 4,
    candidate_count: 3,
    matched_pair_count: 4,
    unmatched_reference_count: 0,
    unmatched_candidate_count: 0,
    cross_boundary_pair_count: 1,
    mean_absolute_shift_ms: null,
    maximum_absolute_shift_ms: null,
    full_window_centered_normalized_rmse: 0.234567,
  };
  job.result.evidence.e4 = {
    kind: "regional_summary",
    comparison_id: "e2",
    window: parent.window,
    split_s: 0.012,
    parameters: parent.parameters,
    assignment: "original_candidate_time",
    filtering_context: "parent_full_window",
    normalization: "parent_full_window_means_and_original_std",
    regions: [
      { start_s: 0, end_s: 0.012 },
      { start_s: 0.012, end_s: 0.024 },
    ].map((window) => ({
      window,
      sample_count: 2,
      valid_count: 1,
      metrics: Object.fromEntries(
        ["unchanged", "median", "highpass"].map((m) => [
          m,
          { ...regionalMetric },
        ]),
      ),
    })),
    limitations: ['<img src="https://evil.invalid" onerror="alert(1)">'],
  };
  job.result.trace.push({
    round: 3,
    tool: "regional_summary",
    status: "success",
    evidence_id: "e4",
  });
  job.result.conclusion.evidence_ids = ["e4"];
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
    "/api/investigations/job-1/comparisons/e2": () =>
      response(comparisonPayload(job, "e2")),
    "/api/investigations/job-1/comparisons/e3": () =>
      response(comparisonPayload(job, "e3")),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  const evidence = h.$("investigation-evidence");
  assert.match(evidence.textContent, /Regional summary/);
  assert.match(evidence.textContent, /Cross-boundary matched pairs/);
  assert.match(evidence.textContent, /not available/);
  assert.match(evidence.textContent, /globally normalized/);
  assert.equal(evidence.querySelector("img,script,[onerror]"), null);
  const cite = h.$("investigation-citations").querySelector("a");
  assert.match(cite.textContent, /e4 regional summary/);
  cite.click();
  assert.equal(h.doc.activeElement.id, "investigation-evidence-3");
  const select = h
    .$("investigation-visuals")
    .querySelector('select[aria-label="Comparison evidence"]');
  assert.deepEqual(
    [...select.options].map((o) => o.value),
    ["e2", "e3"],
  );
  assert.equal(select.value, "e3");
  [...evidence.querySelectorAll("a")]
    .find((a) => /View parent comparison e2/.test(a.textContent))
    .click();
  await tick();
  assert.equal(select.value, "e2");
  assert.match(h.$("investigation-visuals").textContent, /comparison e2/);
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("/comparisons/e4")).length,
    0,
  );
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("/comparisons/e2")).length,
    1,
  );
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  assert.doesNotMatch(
    h.$("investigation-story").textContent,
    /No successful follow-up comparison/,
  );
  h.app.destroy();
});
test("late comparison response cannot attach after actual source replacement or destroy", async () => {
  const late = deferred(),
    job = investigationJob("completed");
  let opens = 0;
  const h = setup({
    "/api/demo": () =>
      response(recording(++opens === 1 ? "demo" : "replacement")),
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
    "/api/investigations/job-1/comparisons/e2": () => late.promise,
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  openSample(h);
  await tick();
  late.resolve(response(comparisonPayload(job, "e2")));
  await tick();
  assert.equal(h.app.getState().view.recording.id, "replacement");
  assert.equal(h.$("investigation-visuals").querySelector("svg"), null);
  assert.equal(h.$("report-visuals").querySelector("svg"), null);
  h.app.destroy();
});

test("investigation story exposes exact follow-up evidence, keeps concise report binding and clears on source replacement", async () => {
  const job = investigationJob("completed");
  const later = structuredClone(job.result.evidence.e2);
  later.parameters.median_window_s = 2;
  later.metrics.median.mean_absolute_shift_ms = 12;
  job.result.evidence.e3 = later;
  job.result.trace = [
    { round: 3, tool: "compare", status: "success", evidence_id: "e3" },
    ...job.result.trace,
  ];
  let opens = 0;
  const h = setup({
    "/api/demo": () =>
      response(recording(++opens === 1 ? "demo" : "replacement")),
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(job),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  const story = h.$("investigation-story");
  assert.equal(story.hidden, false);
  assert.equal(story.querySelectorAll(":scope > section").length, 5);
  assert.match(story.textContent, /Window unchanged; settings changed/);
  assert.match(story.textContent, /mean absolute timing shift: 8 → 12 ms/);
  const link = [...story.querySelectorAll("a")].find((a) =>
    a.textContent.includes("e3"),
  );
  assert.equal(link.getAttribute("href"), "#investigation-evidence-2");
  link.click();
  assert.equal(h.$("investigation-evidence-details").open, true);
  assert.ok(h.$("investigation-evidence-2"));
  h.$("review-investigation").click();
  assert.ok(h.$("report-preview").querySelector(".report-summary"));
  assert.match(h.$("report-preview").textContent, /Local comparison e3/);
  assert.match(h.$("report-preview").textContent, /12/);
  h.$("step-nav-compare").click();
  h.$("window-end").value = "0.016";
  h.$("window-end").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  assert.equal(h.$("investigation-historical").hidden, false);
  assert.match(story.textContent, /\[0, 0.024\)/);
  openSample(h);
  await tick();
  assert.equal(h.$("investigation-story").textContent, "");
  assert.equal(h.$("investigation-story").hidden, true);
  h.app.destroy();
});

test("default research question follows an unsaved target and preserves a custom or saved question", async () => {
  const h = setup();
  await h.app.init();
  openSample(h);
  await tick();
  assert.match(h.$("research-question").value, /How sensitive is pulse timing/);
  h.$("target-waveform").checked = true;
  h.$("target-waveform").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  assert.match(
    h.$("research-question").value,
    /How sensitive is waveform shape/,
  );
  h.$("research-question").value = "Does my saved custom question survive?";
  h.$("target-pulse").checked = true;
  h.$("target-pulse").dispatchEvent(
    new h.dom.window.Event("input", { bubbles: true }),
  );
  assert.equal(
    h.$("research-question").value,
    "Does my saved custom question survive?",
  );
  h.submit("protocol-form");
  await tick();
  assert.equal(
    h.$("investigation-question").value,
    "Does my saved custom question survive?",
  );
  h.app.destroy();
});

test("four coherent stages preserve canonical forms and navigation never starts analysis", async () => {
  const h = setup();
  await h.app.init();
  assert.equal(h.$("guide-tools"), null);
  assert.equal(h.doc.querySelector(".guide-footer"), null);
  openSample(h);
  await tick();
  assert.equal(h.$("research-question").closest("[hidden]"), null);
  assert.equal(h.$("target-pulse").closest("[hidden]"), null);
  assert.equal(h.$("experiment-name").form, h.$("protocol-form"));
  h.submit("protocol-form");
  await tick();
  const calls = h.calls.length;
  assert.equal(h.app.getState().step, "inspect");
  for (const id of [
    "chart",
    "recording-overview",
    "zoom-start",
    "zoom-end",
    "window-start",
    "window-end",
    "plot-unit",
  ])
    assert.equal(h.$(id).closest("[hidden]"), null, id);
  const range = [h.$("window-start").value, h.$("window-end").value];
  h.$("continue-compare").click();
  assert.equal(h.app.getState().step, "compare");
  assert.equal(h.$("channel").disabled, false);
  assert.equal(h.$("compare-channel").contains(h.$("channel")), true);
  assert.equal(h.$("window-start").closest("[hidden]"), null);
  assert.equal(h.$("chart").closest("[hidden]"), null);
  assert.equal(h.$("investigation-form").closest("[hidden]"), null);
  assert.equal(h.$("manual-comparison").hidden, true);
  assert.equal(h.$("investigate").disabled, true);
  h.$("back-inspect").click();
  assert.deepEqual([h.$("window-start").value, h.$("window-end").value], range);
  assert.equal(h.calls.length, calls);
  assert.equal(h.doc.querySelectorAll("#window-start").length, 1);
  h.app.destroy();
});

test("CSV mapping errors leave filename, columns and sample rows together for recovery", async () => {
  const h = setup();
  await h.app.init();
  await h.file();
  for (const id of [
    "import-name",
    "time-column",
    "signal-columns",
    "preview-table",
  ])
    assert.equal(h.$(id).closest("[hidden]"), null, id);
  h.$("time-column").value = "t";
  const time = [...h.$("signal-columns").querySelectorAll("input")].find(
    (input) => input.value === "t",
  );
  time.checked = true;
  const before = h.calls.length;
  h.submit("import-form");
  await tick();
  assert.match(h.$("error").textContent, /time column cannot also be a signal/);
  assert.equal(h.calls.length, before);
  assert.equal(time.closest("[hidden]"), null);
  assert.equal(h.$("preview-table").closest("[hidden]"), null);
  assert.equal(h.$("error").parentElement, h.$("import-panel"));
  time.checked = false;
  time.dispatchEvent(new h.dom.window.Event("change", { bubbles: true }));
  assert.match(
    h.$("preview-table").querySelector("th").textContent,
    /Time \(s\)/,
  );
  h.submit("import-form");
  await tick();
  assert.equal(h.app.getState().view.recording.id, "import");
  h.app.destroy();
});

test("Meta consent and actual progress share one stage, and results need no manual run", async () => {
  let terminal = false;
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations?experiment_id=experiment-1": () =>
      response({ jobs: terminal ? [investigationJob("completed")] : [] }),
    "/api/investigations": () => response(investigationJob()),
    "/api/investigations/job-1": () =>
      response(investigationJob(terminal ? "completed" : "running")),
  });
  try {
    await openFixture(h);
    assert.equal(h.$("investigate").disabled, true);
    consentInvestigation(h);
    h.submit("investigation-form");
    await tick();
    assert.equal(h.$("investigation-status").closest("[hidden]"), null);
    assert.equal(h.$("window-start").closest("[hidden]"), null);
    assert.equal(h.$("investigate").disabled, true);
    terminal = true;
    h.$("investigation-refresh").click();
    await tick();
    assert.equal(h.$("investigation-result").closest("[hidden]"), null);
    assert.equal(h.$("investigation-narrative").closest("[hidden]"), null);
    assert.equal(h.$("investigation-visuals").closest("[hidden]"), null);
    h.$("review-investigation").click();
    assert.equal(h.app.getState().step, "export");
    assert.equal(h.$("detailed-report").open, true);
    assert.ok(h.$("report-preview").textContent.length > 0);
    assert.equal(
      h.calls.filter((c) => c.path === "/api/investigations" && c.body).length,
      1,
    );
    assert.equal(h.app.getState().runs.length, 0);
  } finally {
    h.app.destroy();
  }
});

test("offline comparison is discoverable and short lists and measurements stay simultaneously readable", async () => {
  const h = setup();
  await openFixture(h);
  const before = h.calls.length;
  assert.match(h.$("manual-comparison-toggle").textContent, /offline manual/);
  h.$("manual-comparison-toggle").click();
  assert.equal(h.$("manual-comparison").closest("[hidden]"), null);
  assert.equal(h.calls.length, before);
  h.submit("analysis-form");
  await tick();
  assert.equal(h.$("results-intro").closest("[hidden]"), null);
  h.$("technical-details-toggle").click();
  assert.equal(h.$("metrics").closest("[hidden]"), null);
  assert.ok(
    [...h.$("metrics").querySelectorAll("tbody tr")].every(
      (row) => !row.hidden,
    ),
  );
  assert.equal(
    h.doc.querySelector(".row-pager,.text-pager,.detail-pager"),
    null,
  );
  assert.equal(
    h.calls.some((c) => c.path === "/api/investigations" && c.body),
    false,
  );
  h.app.destroy();
});

test("session tools preserve stage and draft, close with safe focus, and the brand preserves local work", async () => {
  const h = setup();
  await openFixture(h);
  const step = h.app.getState().step,
    question = h.$("research-question").value,
    before = h.calls.length;
  h.$("guide-sessions").click();
  assert.equal(h.$("session-dialog").hidden, false);
  assert.equal(h.app.getState().step, step);
  assert.equal(h.doc.activeElement, h.$("session-dialog-close"));
  h.$("session-dialog").dispatchEvent(
    new h.dom.window.Event("cancel", { cancelable: true }),
  );
  assert.equal(h.$("session-dialog").hidden, true);
  assert.equal(h.doc.activeElement, h.$("guide-sessions"));
  h.doc.querySelector(".brand").click();
  assert.equal(h.app.getState().step, "open");
  assert.equal(h.$("research-question").value, question);
  assert.equal(h.calls.length, before);
  h.app.destroy();
});

test("long retained narratives remain intact without fragmenting prose into pages", async () => {
  const long = investigationJob("completed"),
    short = investigationJob("completed");
  long.result.conclusion.narrative =
    "Measured sensitivity needs careful researcher review. ".repeat(30);
  short.id = "job-2";
  short.result.conclusion.narrative = "A short retained proposal.";
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations?experiment_id=experiment-1": () =>
      response({ jobs: [long, short] }),
  });
  await openFixture(h);
  assert.equal(
    h.$("investigation-narrative").textContent,
    long.result.conclusion.narrative,
  );
  assert.equal(h.doc.querySelector(".text-pager"), null);
  h.$("investigation-history").value = "job-2";
  h.$("investigation-history").dispatchEvent(new h.dom.window.Event("change"));
  assert.equal(
    h.$("investigation-narrative").textContent,
    "A short retained proposal.",
  );
  h.app.destroy();
});

test("opening outcome preview makes no invented measurements and sample remains an explicit local action", async () => {
  const h = setup();
  await h.app.init();
  const preview = h.doc.querySelector(".opening-outcome");
  assert.equal(preview.closest("[hidden]"), null);
  assert.match(
    preview.textContent,
    /Question.*Measured comparison.*Animated findings/s,
  );
  assert.match(preview.textContent, /explicit consent/);
  assert.equal(preview.querySelector("svg,canvas,img"), null);
  assert.equal(h.calls.filter((c) => c.path === "/api/demo").length, 0);
  h.$("open-demo").click();
  await tick();
  assert.equal(h.calls.filter((c) => c.path === "/api/demo").length, 1);
  assert.equal(
    h.calls.filter((c) =>
      ["/api/analyze", "/api/investigations"].includes(c.path),
    ).length,
    0,
  );
  h.app.destroy();
});

function annotatedInvestigationFixture() {
  const job = investigationJob("completed", "candidate"),
    base = job.result.evidence.e2;
  Object.assign(base, {
    sample_count: 100,
    valid_count: 98,
    excluded_fraction: 0.02,
    evaluation: "original",
  });
  for (const method of ["unchanged", "median", "highpass"])
    base.metrics[method] = {
      ...base.metrics[method],
      reference_count: 4,
      comparator_count: 4,
      candidate_count: 4,
      matched_count: 4,
      unmatched_reference_count: 0,
      unmatched_comparator_count: 0,
      unmatched_candidate_count: 0,
      mean_absolute_shift_ms: 0,
      maximum_absolute_shift_ms: 0,
    };
  job.result.evidence.e3 = structuredClone(base);
  job.result.evidence.e3.parameters.median_window_s = 2;
  job.result.evidence.e3.metrics.median.candidate_count = 5;
  job.result.evidence.e3.metrics.median.unmatched_candidate_count = 1;
  job.result.trace.push({
    round: 3,
    tool: "compare",
    status: "success",
    evidence_id: "e3",
  });
  const payload = (id) => {
    const p = comparisonPayload(job, id),
      c = job.result.evidence[id],
      n = 100;
    const detector = {
      ...c.parameters,
      highpass_order: 2,
      minimum_interior_s: 1,
      flatline_s: 0.25,
      peak_distance_s: 0.4,
      prominence_fraction: 0.15,
      match_tolerance_s: 0.15,
      gap_factor: 1.5,
      regularity_tolerance: 0.02,
    };
    const times = Array.from({ length: n }, (_, i) => i * 0.00024);
    p.result.plot = {
      times,
      raw: times.map((_, i) => 10 + Math.sin(i)),
      unchanged: times.map((_, i) => 10 + Math.sin(i)),
      median: times.map((_, i) => Math.sin(i)),
      highpass: times.map((_, i) => Math.sin(i) * 0.8),
      valid_mask: times.map((_, i) => i > 0 && i < 99),
    };
    Object.assign(p.result.exclusions, {
      sample_count: n,
      valid_count: 98,
      excluded_fraction: 0.02,
      valid_intervals_indices: [[1, 99]],
      parameters: detector,
    });
    p.candidate_evidence = {
      schema: "signaltrace.candidate-evidence.v1",
      comparison_id: id,
      comparator: "original",
      sample_count: n,
      window: { ...c.window },
      parameters: { ...c.parameters },
      detector,
      valid_intervals_indices: [[1, 99]],
      reference_indices: [20, 40, 60, 80],
      methods: Object.fromEntries(
        ["unchanged", "median", "highpass"].map((method) => [
          method,
          {
            candidate_indices:
              method === "median" && id === "e3"
                ? [20, 40, 60, 65, 80]
                : [20, 40, 60, 80],
            pairs: [20, 40, 60, 80].map((i) => [i, i]),
          },
        ]),
      ),
    };
    return p;
  };
  return { job, payload };
}
test("late summary follow-up attaches actual markers without changing selected evidence, report page or focus; export retains it", async () => {
  const f = annotatedInvestigationFixture(),
    late = deferred();
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(f.job),
    "/api/investigations/job-1/comparisons/e2": () => response(f.payload("e2")),
    "/api/investigations/job-1/comparisons/e3": () => late.promise,
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("review-investigation").click();
  await tick();
  assert.equal(
    h.$("download-report").disabled,
    true,
    "summary waveform is still loading",
  );
  guidePane(h, "report");
  const preview = h.$("report-preview"),
    page = preview.querySelector("select");
  page.value = "1";
  page.dispatchEvent(new h.dom.window.Event("change"));
  page.focus();
  const reportComparison = h
    .$("report-visuals")
    .querySelector('select[aria-label="Comparison evidence"]');
  assert.equal(reportComparison.value, "e2");
  late.resolve(response(f.payload("e3")));
  await tick();
  await tick();
  assert.equal(
    preview.querySelector("select"),
    page,
    "passive attachment retains navigation DOM",
  );
  assert.equal(page.value, "1");
  assert.equal(h.doc.activeElement, page);
  assert.equal(reportComparison.value, "e2");
  for (const id of ["investigation-finding", "report-preview"]) {
    const marker = h
      .$(id)
      .querySelector('[data-trace="median"][data-status="unmatched"]');
    assert.equal(marker.dataset.sampleIndex, "65");
    assert.equal(Number(marker.dataset.value), Math.sin(65));
    assert.match(h.$(id).textContent, /unmatched method candidates 0.*1/);
  }
  const plotSelect = h
    .$("report-visuals")
    .querySelector('select[aria-label="Comparison evidence"]');
  plotSelect.value = "e3";
  plotSelect.dispatchEvent(new h.dom.window.Event("change"));
  await tick();
  const highpass = [...h.$("report-visuals").querySelectorAll("button")].find(
    (b) => b.textContent === "High-pass",
  );
  highpass.click();
  assert.equal(highpass.getAttribute("aria-pressed"), "true");
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  let blob;
  URL.createObjectURL = (b) => {
    blob = b;
    return "blob:summary";
  };
  URL.revokeObjectURL = () => {};
  h.dom.window.HTMLAnchorElement.prototype.click = function () {};
  try {
    h.$("download-report").click();
    await tick();
    const output = new JSDOM(await blob.text()).window.document;
    assert.equal(
      output.querySelector('[data-status="unmatched"]').dataset.sampleIndex,
      "65",
    );
    assert.equal(output.querySelector("script"), null);
    assert.match(
      output.querySelector('meta[http-equiv="Content-Security-Policy"]')
        .content,
      /script-src 'none'/,
    );
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    h.app.destroy();
  }
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("/comparisons/e3")).length,
    1,
  );
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
});
test("late optional finding attachments cannot attach to a replacement source or destroyed app", async () => {
  for (const [pendingId, destroy] of [
    ["e2", false],
    ["e2", true],
    ["e3", false],
    ["e3", true],
  ]) {
    const f = annotatedInvestigationFixture(),
      late = deferred();
    if (pendingId === "e2")
      f.job.result.conclusion.candidate = {
        comparison_id: "e3",
        method: "median",
      };
    let opens = 0;
    const h = setup({
      "/api/demo": () =>
        response(recording(++opens === 1 ? "demo" : "replacement")),
      "/api/investigations/config": investigationConfig,
      "/api/investigations": () => response(f.job),
      "/api/investigations/job-1/comparisons/e2": () =>
        pendingId === "e2" ? late.promise : response(f.payload("e2")),
      "/api/investigations/job-1/comparisons/e3": () =>
        pendingId === "e3" ? late.promise : response(f.payload("e3")),
    });
    await openFixture(h);
    consentInvestigation(h);
    h.submit("investigation-form");
    await tick();
    if (destroy) h.app.destroy();
    else {
      openSample(h);
      await tick();
    }
    const previous = h.$("investigation-finding").innerHTML;
    late.resolve(response(f.payload(pendingId)));
    await tick();
    await tick();
    assert.equal(h.$("investigation-finding").innerHTML, previous);
    if (pendingId === "e3")
      assert.equal(
        h.$("investigation-finding").querySelector(".finding-waveform"),
        null,
      );
    else
      assert.equal(
        h
          .$("investigation-finding")
          .querySelector('polyline[data-role="initial"]'),
        null,
      );
    if (!destroy) h.app.destroy();
  }
});

test("both finding attachments share bounded loads while preserving selected evidence and method", async () => {
  const f = annotatedInvestigationFixture(),
    initial = deferred(),
    followup = deferred();
  f.job.result.evidence.e4 = structuredClone(f.job.result.evidence.e2);
  f.job.result.evidence.e4.parameters.highpass_hz = 0.2;
  f.job.result.trace.push({
    round: 4,
    tool: "compare",
    status: "success",
    evidence_id: "e4",
  });
  f.job.result.conclusion.candidate = {
    comparison_id: "e4",
    method: "highpass",
  };
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(f.job),
    "/api/investigations/job-1/comparisons/e2": () => initial.promise,
    "/api/investigations/job-1/comparisons/e3": () => followup.promise,
    "/api/investigations/job-1/comparisons/e4": () => response(f.payload("e4")),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("review-investigation").click();
  await tick();
  const evidence = h.$("report-visuals"),
    comparison = evidence.querySelector(
      'select[aria-label="Comparison evidence"]',
    );
  assert.equal(comparison.value, "e4");
  const selected = [...evidence.querySelectorAll("button")].find(
    (b) => b.textContent === "High-pass",
  );
  selected.click();
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  assert.equal(h.$("download-report").disabled, true);
  followup.resolve(response(f.payload("e3")));
  await tick();
  assert.equal(
    h.$("download-report").disabled,
    true,
    "initial attachment is still pending",
  );
  assert.equal(comparison.value, "e4");
  guidePane(h, "report");
  const page = h.$("report-preview").querySelector("select");
  page.value = "1";
  page.dispatchEvent(new h.dom.window.Event("change"));
  page.focus();
  initial.resolve(response(f.payload("e2")));
  await tick();
  await tick();
  assert.equal(h.$("download-report").disabled, false);
  assert.equal(comparison.value, "e4");
  assert.equal(selected.getAttribute("aria-pressed"), "true");
  assert.equal(h.doc.activeElement, page);
  assert.equal(page.value, "1");
  for (const id of ["investigation-finding", "report-preview"]) {
    assert.ok(h.$(id).querySelector('polyline[data-role="initial"]'));
    assert.ok(h.$(id).querySelector('polyline[data-role="followup"]'));
    assert.ok(h.$(id).querySelector('[data-finding-control="sample"]'));
  }
  for (const id of ["e2", "e3", "e4"])
    assert.equal(
      h.calls.filter((c) => c.path.endsWith(`/comparisons/${id}`)).length,
      1,
    );
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.app.destroy();
});

test("unavailable initial finding attachment settles export with an honest follow-up view", async () => {
  const f = annotatedInvestigationFixture();
  f.job.result.conclusion.candidate = { comparison_id: "e3", method: "median" };
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": () => response(f.job),
    "/api/investigations/job-1/comparisons/e2": () => response({}, false),
    "/api/investigations/job-1/comparisons/e3": () => response(f.payload("e3")),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  await tick();
  h.$("review-investigation").click();
  await tick();
  await tick();
  assert.equal(h.$("download-report").disabled, false);
  assert.match(
    h.$("investigation-finding").textContent,
    /Initial trace unavailable/,
  );
  assert.equal(
    h.$("investigation-finding").querySelector('polyline[data-role="initial"]'),
    null,
  );
  assert.ok(
    h
      .$("investigation-finding")
      .querySelector('polyline[data-role="followup"]'),
  );
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations").length,
    1,
  );
  h.app.destroy();
});

function retainedJob(id = "saved-job", sourceId = "saved-recording") {
  const job = investigationJob("completed", "inconclusive", { id });
  job.request = {
    ...job.request,
    recording_id: sourceId,
    experiment_id: `experiment-${id}`,
    question: "Recorded research question",
    notes: "Recorded acquisition notes",
  };
  job.evidence_digest = `digest-${id}`;
  job.retention = "restored";
  job.source = {
    kind: "original_investigation",
    recorded_rationale: "historical_model_proposal",
  };
  job.display_context = {
    recording: {
      ...recording(sourceId).recording,
      name: `Retained recording ${id}`,
    },
    experiment: {
      id: job.request.experiment_id,
      recording_id: sourceId,
      protocol: {
        name: `Retained experiment ${id}`,
        task: "pulse_timing",
        target: "pulse_timing",
        research_question: "Protocol question",
        notes: "",
        evaluation: "original",
      },
    },
  };
  return job;
}
function explanationJob(
  source,
  status = "running",
  result = null,
  id = "explanation-1",
) {
  return {
    id,
    status,
    request: {
      request_id: "explanation-request",
      investigation_id: source.id,
      evidence_digest: source.evidence_digest,
    },
    stage: status === "running" ? "requesting_meta" : "finished",
    error: status === "failed" ? { category: "invalid_plan" } : null,
    result,
    retention: "retained",
  };
}
function scopePlan(source) {
  return {
    schema: "signaltrace.explanation.v1",
    investigation_id: source.id,
    evidence_digest: source.evidence_digest,
    identity: {
      provider: "meta",
      model: "muse-spark-1.3",
      execution_mode: "live",
      history_mode: "stateless",
    },
    provenance: {
      kind: "retrospective_explanation",
      interpretation: "unverified",
      historical_import: true,
    },
    limitations: ["Research only"],
    scenes: ["scope", "scope", "uncertainty"].map((kind, i) => ({
      id: `scene-${i}`,
      kind,
      evidence_ids: [],
      comparison_id: null,
      baseline_comparison_id: null,
      method: null,
      focus: "full_window",
      caption: "Review the retained scope",
      interpretation: "The preferred filter remains unresolved.",
      binding: {
        window: {
          start_s: source.request.start_s,
          end_s: source.request.end_s,
        },
        unit: "a.u.",
        target: source.request.target,
      },
    })),
  };
}
function retainedSetup(jobs, overrides = {}, configure = () => {}) {
  const routes = {
    "/api/investigations": (body) =>
      body ? response(investigationJob()) : response({ jobs }),
    ...Object.fromEntries(
      jobs.flatMap((j) => [
        [`/api/investigations/${j.id}`, () => response(j)],
        [
          `/api/investigations/${j.id}/comparisons/e2`,
          () => response(comparisonPayload(j, "e2")),
        ],
      ]),
    ),
    ...overrides,
  };
  return setup(routes, (dom) => {
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;
    configure(dom);
  });
}
async function selectRetained(h, id) {
  h.$("retained-results-open").click();
  await tick();
  h.$("retained-results-list")
    .querySelector(`button[data-investigation-id="${id}"]`)
    .click();
  await tick();
  await tick();
}
function consentExplanation(h) {
  h.$("explanation-consent").checked = true;
  h.$("explanation-consent").dispatchEvent(new h.dom.window.Event("change"));
}
test("saved result opens without an active experiment and binds archived metadata without Meta", async () => {
  const source = retainedJob(),
    h = retainedSetup([source]);
  await h.app.init();
  await selectRetained(h, source.id);
  assert.equal(h.app.getState().step, "export");
  assert.equal(h.app.getState().view, null);
  assert.equal(h.app.getState().experiment, null);
  assert.match(
    h.$("report-preview").textContent,
    /Retained recording saved-job/,
  );
  assert.match(h.$("report-preview").textContent, /Recorded research question/);
  assert.match(
    h.$("explanation-source").textContent,
    /Recorded acquisition notes/,
  );
  assert.match(h.$("retained-results-list").textContent, /restored locally/);
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("reopening archived evidence preserves editable source and resets explanation consent on a result switch", async () => {
  const a = retainedJob("archive-a"),
    b = retainedJob("archive-b"),
    h = retainedSetup([a, b]);
  await openFixture(h);
  const current = h.app.getState().view,
    experiment = h.app.getState().experiment;
  await selectRetained(h, a.id);
  consentExplanation(h);
  assert.equal(h.$("explanation-consent").checked, true);
  await selectRetained(h, b.id);
  assert.equal(h.$("explanation-consent").checked, false);
  assert.equal(h.app.getState().view, current);
  assert.equal(h.app.getState().experiment, experiment);
  assert.match(
    h.$("report-preview").textContent,
    /Retained recording archive-b/,
  );
  assert.doesNotMatch(
    h.$("report-preview").textContent,
    /Retained recording archive-a/,
  );
  h.app.destroy();
});
test("explanation requires separate consent and sends only explicit evidence binding once", async () => {
  const source = retainedJob(),
    pending = deferred();
  const h = retainedSetup([source], {
    "/api/explanations": () => pending.promise,
  });
  await h.app.init();
  await selectRetained(h, source.id);
  h.submit("explanation-form");
  assert.equal(h.calls.filter((c) => c.path === "/api/explanations").length, 0);
  consentExplanation(h);
  h.submit("explanation-form");
  h.submit("explanation-form");
  const posts = h.calls.filter((c) => c.path === "/api/explanations");
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), [
    "allow_network",
    "evidence_digest",
    "investigation_id",
    "request_id",
  ]);
  assert.equal(posts[0].body.allow_network, true);
  assert.equal(posts[0].body.investigation_id, source.id);
  assert.equal(posts[0].body.evidence_digest, source.evidence_digest);
  assert.equal(h.$("explanation-consent").checked, false);
  pending.resolve(
    response({
      ...explanationJob(source),
      request: {
        ...explanationJob(source).request,
        request_id: posts[0].body.request_id,
      },
    }),
  );
  await tick();
  assert.match(
    h.$("explanation-status").textContent,
    /Requesting Meta explanation/,
  );
  assert.equal(h.$("detailed-report").open, true);
  h.app.destroy();
});
test("explanation status polling is nonoverlapping, stops after read failure and only explicit refresh reconnects", async () => {
  const source = retainedJob(),
    clock = presentationHarness(),
    pending = deferred();
  let readCount = 0,
    listed = [];
  const running = explanationJob(source);
  const h = retainedSetup(
    [source],
    {
      "/api/explanations": (body) => {
        running.request.request_id = body.request_id;
        listed = [running];
        return response(running);
      },
      [`/api/explanations?investigation_id=${source.id}`]: () =>
        response({ jobs: listed }),
      "/api/explanations/explanation-1": () => {
        readCount++;
        return pending.promise;
      },
    },
    clock.configure,
  );
  await h.app.init();
  await selectRetained(h, source.id);
  consentExplanation(h);
  h.submit("explanation-form");
  await tick();
  clock.advance(1000);
  await tick();
  clock.advance(5000);
  await tick();
  assert.equal(readCount, 1);
  pending.resolve(response({}, false));
  await tick();
  assert.match(
    h.$("explanation-status").textContent,
    /server explanation may still be running/,
  );
  assert.equal(clock.timers.size, 0);
  listed = [explanationJob(source, "failed")];
  h.$("explanation-refresh").click();
  await tick();
  assert.match(h.$("explanation-status").textContent, /Explanation failed/);
  assert.equal(h.$("detailed-report").open, true);
  assert.equal(h.calls.filter((c) => c.path === "/api/explanations").length, 1);
  h.app.destroy();
  assert.equal(clock.timers.size, 0);
});
test("late explanation admission stays bound to its archived source and cannot populate another result", async () => {
  const a = retainedJob("archive-a"),
    b = retainedJob("archive-b"),
    pending = deferred();
  const h = retainedSetup([a, b], {
    "/api/explanations": () => pending.promise,
  });
  await h.app.init();
  await selectRetained(h, a.id);
  consentExplanation(h);
  h.submit("explanation-form");
  await selectRetained(h, b.id);
  pending.resolve(response(explanationJob(a, "completed", scopePlan(a))));
  await tick();
  await tick();
  assert.match(
    h.$("report-preview").textContent,
    /Retained recording archive-b/,
  );
  assert.equal(h.$("findings-player").textContent, "");
  assert.equal(h.$("explanation-consent").checked, false);
  assert.equal(h.calls.filter((c) => c.path === "/api/explanations").length, 1);
  h.app.destroy();
});
test("existing no-finding explanation loads locally and preserves an open detailed report", async () => {
  const source = retainedJob(),
    saved = explanationJob(source, "completed", scopePlan(source));
  const h = retainedSetup([source], {
    [`/api/explanations?investigation_id=${source.id}`]: () =>
      response({ jobs: [saved] }),
  });
  await h.app.init();
  await selectRetained(h, source.id);
  await tick();
  assert.match(
    h.$("findings-player").textContent,
    /No supported visual finding/,
  );
  assert.equal(h.$("detailed-report").open, true);
  assert.match(
    h.$("report-preview").textContent,
    /Retrospective|retrospective/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("invalid imported plan cannot suppress the valid scientific report", async () => {
  const source = retainedJob(),
    plan = scopePlan(source);
  plan.evidence_digest = "other-source";
  const h = retainedSetup([source], {
    [`/api/explanations?investigation_id=${source.id}`]: () =>
      response({ jobs: [explanationJob(source, "completed", plan)] }),
  });
  await h.app.init();
  await selectRetained(h, source.id);
  await tick();
  assert.match(h.$("findings-player").textContent, /could not be bound/);
  assert.equal(h.$("detailed-report").open, true);
  assert.match(h.$("report-preview").textContent, /Recorded research question/);
  assert.equal(h.$("download-report").disabled, false);
  h.app.destroy();
});
test("bounded investigation import uses server-owned identity and never replaces an editable recording", async () => {
  const source = retainedJob("imported-job");
  source.source = {
    kind: "imported_historical",
    historical_identity: { provider: "meta" },
  };
  const h = retainedSetup([], {
    "/api/investigations/import": () => response(source),
  });
  await openFixture(h);
  const active = h.app.getState().view;
  h.$("retained-results-open").click();
  await tick();
  const bundle = {
    schema: "signaltrace.investigation.v2",
    identity: { provider: "meta" },
  };
  Object.defineProperty(h.$("retained-result-file"), "files", {
    configurable: true,
    value: [
      {
        name: "saved-investigation.json",
        size: 100,
        text: async () => JSON.stringify(bundle),
      },
    ],
  });
  h.$("retained-result-file").dispatchEvent(new h.dom.window.Event("change"));
  await tick();
  await tick();
  const call = h.calls.find((c) => c.path === "/api/investigations/import");
  assert.deepEqual(call.body.bundle, bundle);
  assert.equal(typeof call.body.request_id, "string");
  assert.equal(h.app.getState().view, active);
  assert.equal(h.app.getState().retainedSelection, source.id);
  assert.match(
    h.$("explanation-provenance").textContent,
    /Imported historical/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});

test("investigation import preserves original signed-zero and numeric tokens while safely escaping its generated request ID", async () => {
  const source = retainedJob("signed-zero-import"),
    requestId = 'request"\\\n,\"bundle\":null';
  const h = retainedSetup(
    [],
    { "/api/investigations/import": () => response(source) },
    (dom) => {
      Object.defineProperty(dom.window.crypto, "randomUUID", {
        configurable: true,
        value: () => requestId,
      });
    },
  );
  await h.app.init();
  h.$("retained-results-open").click();
  await tick();
  const raw =
    '  {\n "schema": "signaltrace.investigation.v2", "samples": [-0.0, 1.0, 1e-300], "nested": {"request_id":"historical"}\n }  ';
  Object.defineProperty(h.$("retained-result-file"), "files", {
    configurable: true,
    value: [
      {
        name: "signed-zero-investigation.json",
        size: raw.length,
        text: async () => raw,
      },
    ],
  });
  h.$("retained-result-file").dispatchEvent(new h.dom.window.Event("change"));
  await tick();
  await tick();
  const call = h.calls.find((c) => c.path === "/api/investigations/import");
  assert.equal(
    call.rawBody,
    `{"request_id":${JSON.stringify(requestId)},"bundle":${raw}}`,
  );
  assert.equal(call.body.request_id, requestId);
  assert.equal(Object.is(call.body.bundle.samples[0], -0), true);
  assert.deepEqual(Object.keys(call.body).sort(), ["bundle", "request_id"]);
  assert.equal(call.body.bundle.nested.request_id, "historical");
  assert.equal(h.app.getState().retainedSelection, source.id);
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("artifact inputs reject secret names, oversized and malformed files before admission", async () => {
  const h = retainedSetup([]);
  await h.app.init();
  h.$("retained-results-open").click();
  await tick();
  let reads = 0;
  for (const file of [
    {
      name: ".env.json",
      size: 100,
      text: async () => {
        reads++;
        return "{}";
      },
    },
    {
      name: "large.json",
      size: 33 * 1024 * 1024,
      text: async () => {
        reads++;
        return "{}";
      },
    },
    {
      name: "invalid.json",
      size: 100,
      text: async () => {
        reads++;
        return "{bad";
      },
    },
  ]) {
    Object.defineProperty(h.$("retained-result-file"), "files", {
      configurable: true,
      value: [file],
    });
    h.$("retained-result-file").dispatchEvent(new h.dom.window.Event("change"));
    await tick();
    assert.match(h.$("retained-results-status").textContent, /Import failed/);
  }
  assert.equal(reads, 1);
  assert.equal(
    h.calls.filter((c) => c.path === "/api/investigations/import").length,
    0,
  );
  h.app.destroy();
});
test("destroy clears explanation timers and a late poll cannot attach findings", async () => {
  const source = retainedJob(),
    clock = presentationHarness(),
    pending = deferred();
  const running = explanationJob(source);
  const h = retainedSetup(
    [source],
    {
      [`/api/explanations?investigation_id=${source.id}`]: () =>
        response({ jobs: [running] }),
      "/api/explanations/explanation-1": () => pending.promise,
    },
    clock.configure,
  );
  await h.app.init();
  await selectRetained(h, source.id);
  assert.equal(clock.timers.size, 1);
  clock.advance(1000);
  await tick();
  h.app.destroy();
  assert.equal(clock.timers.size, 0);
  pending.resolve(
    response(explanationJob(source, "completed", scopePlan(source))),
  );
  await tick();
  assert.equal(h.$("findings-player").textContent, "");
  assert.equal(clock.timers.size, 0);
});

test("lost explanation admission is reconciled by local reads and never retried", async () => {
  const source = retainedJob();
  let accepted = null,
    visible = false;
  const h = retainedSetup([source], {
    "/api/explanations": (body) => {
      accepted = {
        ...explanationJob(source, "completed", scopePlan(source)),
        request: {
          request_id: body.request_id,
          investigation_id: source.id,
          evidence_digest: source.evidence_digest,
        },
      };
      throw new Error("Lost response");
    },
    [`/api/explanations?investigation_id=${source.id}`]: () =>
      response({ jobs: visible && accepted ? [accepted] : [] }),
  });
  await h.app.init();
  await selectRetained(h, source.id);
  consentExplanation(h);
  h.submit("explanation-form");
  await tick();
  assert.match(
    h.$("explanation-status").textContent,
    /server may still be running/,
  );
  assert.equal(h.$("explain").disabled, true);
  h.submit("explanation-form");
  visible = true;
  h.$("explanation-refresh").click();
  await tick();
  await tick();
  assert.match(
    h.$("findings-player").textContent,
    /No supported visual finding/,
  );
  assert.equal(h.calls.filter((c) => c.path === "/api/explanations").length, 1);
  assert.equal(h.$("explanation-consent").checked, false);
  h.app.destroy();
});
test("missing explanation key gates generation while saved evidence and plans remain usable", async () => {
  const source = retainedJob(),
    h = retainedSetup([source], {
      "/api/explanations/config": () =>
        response({ available: true, key_configured: false }),
    });
  await h.app.init();
  await selectRetained(h, source.id);
  consentExplanation(h);
  h.submit("explanation-form");
  assert.equal(h.$("explain").disabled, true);
  assert.match(
    h.$("explanation-config").textContent,
    /configure the key privately/,
  );
  assert.equal(h.$("explanation-file").disabled, false);
  assert.equal(h.$("download-report").disabled, false);
  assert.equal(h.calls.filter((c) => c.path === "/api/explanations").length, 0);
  assert.equal(h.$("meta-api-key").type, "password");
  assert.equal(h.$("meta-api-key").value, "");
  h.app.destroy();
});
test("separate explanation artifact import and export stay local and retain investigation identity", async () => {
  const source = retainedJob(),
    saved = explanationJob(source, "completed", scopePlan(source));
  const artifact = {
    schema: "signaltrace.explanation-artifact.v1",
    evidence_digest: source.evidence_digest,
    explanation: saved.result,
  };
  let downloaded;
  const h = retainedSetup(
    [source],
    {
      "/api/explanations/import": () => response(saved),
      "/api/explanations/explanation-1/export": () => response(artifact),
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = function () {
        downloaded = this.download;
      };
    },
  );
  await h.app.init();
  await selectRetained(h, source.id);
  Object.defineProperty(h.$("explanation-file"), "files", {
    configurable: true,
    value: [
      {
        name: "saved-explanation.json",
        size: 500,
        text: async () => JSON.stringify(artifact),
      },
    ],
  });
  h.$("explanation-file").dispatchEvent(new h.dom.window.Event("change"));
  await tick();
  await tick();
  const imported = h.calls.find((c) => c.path === "/api/explanations/import");
  assert.deepEqual(Object.keys(imported.body).sort(), [
    "artifact",
    "investigation_id",
    "request_id",
  ]);
  assert.deepEqual(imported.body.artifact, artifact);
  assert.equal(imported.body.investigation_id, source.id);
  assert.equal(h.app.getState().retainedSelection, source.id);
  h.$("export-explanation").click();
  await tick();
  assert.equal(downloaded, "signaltrace-explanation.json");
  assert.match(
    h.$("explanation-status").textContent,
    /separate investigation replay JSON/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("expired saved result reports local recovery while preserving the active experiment", async () => {
  const source = retainedJob(),
    h = retainedSetup([source], {
      [`/api/investigations/${source.id}`]: () => ({
        ...response({}, false),
        status: 404,
      }),
    });
  await openFixture(h);
  const before = h.app.getState();
  await selectRetained(h, source.id);
  assert.match(
    h.$("retained-results-status").textContent,
    /unavailable or expired/,
  );
  assert.equal(h.app.getState().view, before.view);
  assert.equal(h.app.getState().experiment, before.experiment);
  assert.equal(h.app.getState().step, before.step);
  assert.equal(h.$("retained-results-dialog").open, true);
  h.app.destroy();
});
test("closing saved results during a local read preserves navigation when the response arrives", async () => {
  const source = retainedJob(),
    pending = deferred(),
    h = retainedSetup([source], {
      [`/api/investigations/${source.id}`]: () => pending.promise,
    });
  await openFixture(h);
  const before = h.app.getState();
  h.$("retained-results-open").click();
  await tick();
  h.$("retained-results-list").querySelector("button").click();
  h.$("retained-results-close").click();
  pending.resolve(response(source));
  await tick();
  assert.equal(h.app.getState().step, before.step);
  assert.equal(h.app.getState().view, before.view);
  assert.equal(h.app.getState().retainedSelection, null);
  assert.equal(h.$("retained-results-dialog").open, false);
  assert.match(
    h.$("retained-results-status").textContent,
    /Open it from Saved results/,
  );
  h.app.destroy();
});

test("authoritative saved-results refresh removes expired entries rather than advertising stale reopening", async () => {
  const source = retainedJob();
  let jobs = [source];
  const h = retainedSetup([source], {
    "/api/investigations": () => response({ jobs }),
  });
  await h.app.init();
  h.$("retained-results-open").click();
  await tick();
  assert.equal(
    h.$("retained-results-list").querySelectorAll("button").length,
    1,
  );
  jobs = [];
  h.$("retained-results-refresh").click();
  await tick();
  assert.equal(
    h.$("retained-results-list").querySelectorAll("button").length,
    0,
  );
  assert.match(
    h.$("retained-results-status").textContent,
    /No saved investigations/,
  );
  assert.doesNotMatch(
    h.$("retained-results-list").textContent,
    /retained locally|Open result/,
  );
  h.app.destroy();
});
test("expired selected result preserves its cached report with honest storage and disabled server operations", async () => {
  const source = retainedJob();
  let jobs = [source];
  const h = retainedSetup([source], {
    "/api/investigations": () => response({ jobs }),
  });
  await h.app.init();
  await selectRetained(h, source.id);
  consentExplanation(h);
  const report = h.$("report-preview").textContent;
  jobs = [];
  h.$("retained-results-open").click();
  await tick();
  assert.equal(h.app.getState().step, "export");
  assert.equal(h.$("report-preview").textContent, report);
  assert.equal(
    h.$("retained-results-list").querySelectorAll("button").length,
    0,
  );
  assert.match(
    h.$("report-scope").textContent,
    /Server copy unavailable.*cached in this browser view only/,
  );
  assert.match(
    h.$("explanation-provenance").textContent,
    /server copy unavailable; browser view only/,
  );
  assert.equal(h.$("download-report").disabled, false);
  assert.equal(h.$("download-report-replay").disabled, true);
  assert.equal(h.$("explain").disabled, true);
  assert.equal(h.$("explanation-consent").checked, false);
  jobs = [source];
  h.$("retained-results-refresh").click();
  await tick();
  assert.equal(
    h.$("retained-results-list").querySelectorAll("button").length,
    1,
  );
  assert.equal(h.$("download-report-replay").disabled, false);
  assert.doesNotMatch(
    h.$("report-scope").textContent,
    /Server copy unavailable/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("pending authoritative archive read cannot remove a newer investigation admission", async () => {
  const post = deferred(),
    list = deferred();
  const h = setup({
    "/api/investigations/config": investigationConfig,
    "/api/investigations": (body) => (body ? post.promise : list.promise),
  });
  await openFixture(h);
  consentInvestigation(h);
  h.submit("investigation-form");
  h.$("retained-results-open").click();
  post.resolve(response(investigationJob("completed")));
  await tick();
  list.resolve(response({ jobs: [] }));
  await tick();
  assert.equal(
    h.$("retained-results-list").querySelectorAll("button").length,
    1,
  );
  assert.match(
    h.$("retained-results-status").textContent,
    /Saved results loaded/,
  );
  assert.doesNotMatch(
    h.$("report-scope").textContent,
    /Server copy unavailable/,
  );
  assert.equal(
    h.calls.filter(
      (c) => c.path === "/api/investigations" && c.body?.allow_network,
    ).length,
    1,
  );
  h.app.destroy();
});

test("Results context follows archived evidence and restores the untouched editable context on return", async () => {
  const source = retainedJob("archived-context"),
    h = retainedSetup([source]);
  await openFixture(h);
  edit(h, "window-start", "0.008");
  const active = h.app.getState(),
    activeJourney = h.$("journey-context").textContent,
    activeExperiment = h.$("experiment-context").textContent;
  assert.match(activeJourney, /Recording demo/);
  assert.match(activeJourney, /\[0.008, 0.024\)/);
  await selectRetained(h, source.id);
  assert.match(
    h.$("journey-context").textContent,
    /Retained recording archived-context/,
  );
  assert.match(
    h.$("journey-context").textContent,
    /Question: Recorded research question/,
  );
  assert.match(
    h.$("journey-context").textContent,
    /Evidence interval: ppg \[0, 0.024\)/,
  );
  assert.doesNotMatch(
    h.$("journey-context").textContent,
    /Recording demo|\[0.008, 0.024\)/,
  );
  assert.equal(h.$("journey-context").hidden, false);
  assert.equal(h.$("status").hidden, true);
  assert.equal(h.$("status").textContent, "");
  assert.equal(h.app.getState().view, active.view);
  assert.equal(h.app.getState().experiment, active.experiment);
  assert.equal(h.$("window-start").value, "0.008");
  h.$("step-nav-inspect").click();
  assert.equal(h.$("journey-context").textContent, activeJourney);
  assert.equal(h.$("experiment-context").textContent, activeExperiment);
  assert.equal(h.$("experiment-context").hidden, false);
  h.$("step-nav-export").click();
  assert.match(
    h.$("journey-context").textContent,
    /Retained recording archived-context.*\[0, 0.024\)/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});
test("single archived result uses plain identity and one player heading with concise imported mocked provenance", async () => {
  const source = retainedJob("mocked-history");
  source.result.identity = {
    provider: "meta",
    model: "muse-spark-1.3",
    execution_mode: "mocked_test",
    history_mode: "stateless",
  };
  source.source = {
    kind: "imported_historical",
    historical_identity: source.result.identity,
  };
  const plan = scopePlan(source);
  plan.identity.execution_mode = "mocked_test";
  const h = retainedSetup([source], {
    [`/api/explanations?investigation_id=${source.id}`]: () =>
      response({ jobs: [explanationJob(source, "completed", plan)] }),
  });
  await h.app.init();
  await selectRetained(h, source.id);
  await tick();
  assert.equal(h.$("report-source-label").hidden, true);
  assert.equal(h.$("report-source-identity").hidden, false);
  assert.equal(
    h.$("report-source-identity").textContent,
    "Retained experiment mocked-history",
  );
  assert.equal(h.$("findings-title").hidden, true);
  assert.equal(h.$("findings-player").querySelectorAll("h3").length, 1);
  assert.match(
    h.$("explanation-provenance").textContent,
    /Imported historical evidence \(mocked test\).*Imported mocked Meta explanation/,
  );
  assert.ok(h.$("explanation-provenance").textContent.length < 180);
  assert.equal(
    h.$("explanation-provenance-detail").closest("details"),
    h.$("explanation-options"),
  );
  assert.match(
    h.$("explanation-provenance-detail").textContent,
    /original identity is an unverified claim.*unverified interpretation/,
  );
  assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  h.app.destroy();
});

test("archived report waits for comparison evidence and preserves verified plots and markers through explanation updates", async () => {
  const f = annotatedInvestigationFixture(),
    source = f.job,
    followup = deferred();
  const context = retainedJob("report-archive", "demo").display_context;
  context.experiment.id = source.request.experiment_id;
  Object.assign(source, {
    evidence_digest: "report-archive-digest",
    display_context: context,
    retention: "restored",
    source: { kind: "imported_historical" },
  });
  const saved = explanationJob(source, "completed", scopePlan(source));
  let explanations = [];
  let exportedBlob = null,
    downloads = 0;
  const h = retainedSetup(
    [source],
    {
      "/api/investigations/job-1/comparisons/e2": () =>
        response(f.payload("e2")),
      "/api/investigations/job-1/comparisons/e3": () => followup.promise,
      "/api/explanations/import": () => {
        explanations = [saved];
        return response(saved);
      },
      "/api/explanations?investigation_id=job-1": () =>
        response({ jobs: explanations }),
    },
    (dom) => {
      dom.window.HTMLAnchorElement.prototype.click = () => {
        downloads++;
      };
    },
  );
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:verified-report";
  };
  URL.revokeObjectURL = () => {};
  try {
    await h.app.init();
    await selectRetained(h, source.id);
    assert.equal(
      h.$("download-report").disabled,
      true,
      "required contrast waveform is still loading",
    );
    Object.defineProperty(h.$("explanation-file"), "files", {
      configurable: true,
      value: [
        {
          name: "mocked-explanation.json",
          size: 1000,
          text: async () =>
            JSON.stringify({
              schema: "signaltrace.explanation-artifact.v1",
              explanation: saved.result,
            }),
        },
      ],
    });
    h.$("explanation-file").dispatchEvent(new h.dom.window.Event("change"));
    await tick();
    await tick();
    assert.equal(
      h.$("download-report").disabled,
      true,
      "a completed explanation cannot bypass pending scientific evidence",
    );
    h.$("download-report").click();
    assert.equal(downloads, 0);
    followup.resolve(response(f.payload("e3")));
    await tick();
    await tick();
    assert.equal(h.$("download-report").disabled, false);
    const comparison = h
      .$("report-visuals")
      .querySelector('select[aria-label="Comparison evidence"]');
    comparison.value = "e3";
    comparison.dispatchEvent(new h.dom.window.Event("change"));
    await tick();
    const method = [...h.$("report-visuals").querySelectorAll("button")].find(
      (b) => b.textContent === "High-pass",
    );
    method.click();
    consentExplanation(h);
    h.$("explanation-refresh").click();
    await tick();
    await tick();
    assert.equal(comparison.value, "e3");
    assert.equal(method.getAttribute("aria-pressed"), "true");
    h.$("download-report").click();
    assert.equal(downloads, 1);
    const exported = new JSDOM(await exportedBlob.text()).window.document;
    assert.ok(exported.querySelectorAll("svg").length >= 3);
    assert.equal(
      exported.querySelector('[data-status="unmatched"]').dataset.sampleIndex,
      "65",
    );
    assert.match(exported.body.textContent, /Retrospective Meta explanation/);
    assert.doesNotMatch(
      exported.body.textContent,
      /Waveform plot not loaded|Candidate markers unavailable/,
    );
    assert.equal(h.calls.filter((c) => c.body?.allow_network).length, 0);
  } finally {
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    h.app.destroy();
  }
});

for (const failure of [
  {
    name: "legacy invalid response",
    error: { category: "invalid_response", http_status: 200 },
    expected: /Meta returned an explanation the app could not use/,
  },
  {
    name: "legacy invalid plan",
    error: { category: "invalid_plan", http_status: null },
    expected: /Meta's visual explanation could not be validated/,
  },
  ...[
    ["tool_shape", /Meta did not return the required visual plan/],
    ["plan_shape", /visual plan had an unsupported structure/],
    ["scene_count", /unsupported number of scenes/],
    ["scene_order", /scenes did not follow the required order/],
    ["scene_fields", /visual plan had an unsupported structure/],
    ["scene_options", /unsupported visual option/],
    [
      "evidence_reference",
      /finding could not be matched to the retained evidence/,
    ],
    ["wording_format", /captions did not meet the format or length limits/],
    ["wording_policy", /wording did not pass the explanation checks/],
    [
      "comparison_binding",
      /comparison could not be matched to the retained evidence/,
    ],
    ["contrast_binding", /settings contrast could not be validated/],
    ["focus_binding", /waveform focus could not be validated/],
    ["validation_failed", /visual explanation could not be validated/],
    ["__proto__", /visual explanation could not be validated/],
    [
      '<img src=x onerror="FAKE_TEST_PRIVATE_FAILURE_CANARY">',
      /visual explanation could not be validated/,
    ],
  ].map(([code, expected], index) => ({
    name: `plan rejection ${index}`,
    error: {
      category: "invalid_plan",
      http_status: null,
      plan_code: code,
      arguments: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
      message: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
    },
    expected,
  })),
  {
    name: "plan code with wrong category",
    error: { category: "quota", http_status: 429, plan_code: "wording_policy" },
    expected: /Meta's usage limit blocked this explanation/,
  },
  {
    name: "plan code with invalid HTTP status",
    error: {
      category: "invalid_plan",
      http_status: 200,
      plan_code: "wording_policy",
    },
    expected: /Meta's visual explanation could not be validated/,
  },
  {
    name: "response length limit",
    error: {
      category: "invalid_response",
      http_status: 200,
      response_code: "incomplete_max_output_tokens",
    },
    expected: /Meta reached the response length limit before finishing/,
  },
  {
    name: "known refusal",
    error: {
      category: "invalid_response",
      http_status: 200,
      response_code: "refusal",
    },
    expected: /Meta declined to create this explanation/,
  },
  {
    name: "unknown malicious subtype",
    error: {
      category: "invalid_response",
      http_status: 200,
      response_code: '<img src=x onerror="FAKE_TEST_PRIVATE_FAILURE_CANARY">',
      detail: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
      body: { secret: "FAKE_TEST_PRIVATE_FAILURE_CANARY" },
    },
    expected: /Meta returned an explanation the app could not use/,
  },
  {
    name: "prototype subtype",
    error: {
      category: "invalid_response",
      http_status: 200,
      response_code: "__proto__",
      message: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
    },
    expected: /Meta returned an explanation the app could not use/,
  },
  {
    name: "subtype with unrelated category",
    error: {
      category: "quota",
      http_status: 429,
      response_code: "incomplete_max_output_tokens",
      detail: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
    },
    expected: /Meta's usage limit blocked this explanation/,
  },
  {
    name: "subtype without successful response",
    error: {
      category: "invalid_response",
      http_status: 429,
      response_code: "incomplete_max_output_tokens",
    },
    expected: /Meta returned an explanation the app could not use/,
  },
  {
    name: "unknown category",
    error: {
      category: "__proto__",
      http_status: 200,
      response_code: "incomplete_max_output_tokens",
      message: "FAKE_TEST_PRIVATE_FAILURE_CANARY",
    },
    expected:
      /^Explanation failed\. The analysis and detailed report remain available/,
  },
]) {
  test(`retained explanation failure uses safe fixed copy for ${failure.name} without retrying on navigation or reopen`, async () => {
    const source = retainedJob(`failure-${failure.name.replaceAll(" ", "-")}`),
      failed = { ...explanationJob(source, "failed"), error: failure.error };
    const h = retainedSetup([source], {
      [`/api/explanations?investigation_id=${source.id}`]: () =>
        response({ jobs: [failed] }),
    });
    await h.app.init();
    await selectRetained(h, source.id);
    const message = h.$("explanation-status").textContent;
    assert.match(message, failure.expected);
    assert.match(message, /The analysis and detailed report remain available/);
    assert.match(message, /A new request requires fresh consent/);
    assert.doesNotMatch(
      message,
      /FAKE_TEST_PRIVATE_FAILURE_CANARY|__proto__|incomplete_max_output_tokens|invalid_response|<img/,
    );
    assert.equal(h.$("explanation-status").querySelector("img,script"), null);
    assert.equal(h.$("detailed-report").open, true);
    assert.equal(h.$("download-report").disabled, false);
    assert.equal(h.$("explanation-consent").checked, false);
    assert.equal(h.$("explain").disabled, true);
    h.$("step-nav-open").click();
    await selectRetained(h, source.id);
    h.$("explanation-refresh").click();
    await tick();
    assert.equal(h.$("explanation-status").textContent, message);
    assert.equal(
      h.calls.filter(
        (c) => c.path === "/api/explanations" || c.body?.allow_network,
      ).length,
      0,
    );
    h.app.destroy();
  });
}
