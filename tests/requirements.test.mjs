import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  parseRequirements,
  requirementSnapshot,
  renderRequirementDecision,
} from "../signaltrace/web/requirements.js";

const request = (criteria = { max_timing_shift_ms: "0" }) => ({
  enabled: true,
  confirmed: true,
  method: "highpass",
  criteria,
});
test("explicit optional limits preserve zero, omit blanks and require confirmation", () => {
  assert.deepEqual(parseRequirements().requirements, null);
  assert.deepEqual(
    parseRequirements(
      request({ max_timing_shift_ms: "0", min_usable_fraction: " " }),
    ).requirements,
    {
      confirmed: true,
      method: "highpass",
      criteria: { max_timing_shift_ms: 0 },
    },
  );
  for (const overrides of [
    { confirmed: false },
    { method: "unchanged" },
    { method: "toString" },
    { criteria: null },
    { criteria: {} },
  ])
    assert.ok(parseRequirements({ ...request(), ...overrides }).error);
  for (const criteria of [
    { max_timing_shift_ms: "Infinity" },
    { max_unmatched_candidates: "1.1" },
    { min_usable_fraction: "1.01" },
    { max_waveform_difference: "-1" },
  ])
    assert.ok(parseRequirements(request(criteria)).error);
});
test("legacy has no invented requirement verdict; missing measurements remain unknown", () => {
  assert.deepEqual(requirementSnapshot(), {
    requirements: null,
    requirement_assessment: null,
  });
  const req = parseRequirements(request()).requirements;
  const s = requirementSnapshot(req, {
    status: "met",
    comparisons: [
      {
        comparison_id: "e1",
        method: "highpass",
        status: "met",
        checks: [
          {
            metric: "max_timing_shift_ms",
            limit: 0,
            value: null,
            status: "met",
          },
        ],
      },
    ],
  });
  assert.equal(s.requirement_assessment.status, "not_established");
  assert.equal(s.requirement_assessment.comparisons[0].checks[0].value, null);
  assert.equal(
    s.requirement_assessment.comparisons[0].checks[0].status,
    "not_established",
  );
});
test("decision preserves exact observed values, evidence navigation, unknowns and text escaping", () => {
  const req = parseRequirements(request()).requirements;
  const s = {
    ...requirementSnapshot(req, {
      status: "violated",
      next_action: "Review <script>unsafe</script>",
      comparisons: [
        {
          comparison_id: "e1",
          method: "highpass",
          status: "violated",
          window: { start_s: 0, end_s: 30 },
          parameters: { highpass_hz: 0.5, median_window_s: 2, edge_guard_s: 3 },
          checks: [
            {
              metric: "max_timing_shift_ms",
              limit: 0,
              value: 0.000123,
              status: "violated",
              reason: "<img src=x>",
            },
          ],
        },
      ],
    }),
    comparisons: [{ id: "e1" }],
  };
  const dom = new JSDOM("<section></section>"),
    el = dom.window.document.querySelector("section");
  let selected;
  renderRequirementDecision(el, s, {
    evidenceHref: () => "#evidence",
    onEvidence: (id) => {
      selected = id;
    },
  });
  assert.match(el.textContent, /0\.000123 ms/);
  assert.match(el.textContent, /\[0, 30\) s/);
  assert.match(el.textContent, /not physiological accuracy/);
  assert.equal(el.querySelector("img, script"), null);
  el.querySelector("a").click();
  assert.equal(selected, "e1");
  renderRequirementDecision(el, null);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
});

test("roundoff policy is retained without recomputing verdicts; display trims arithmetic noise only", () => {
  const req = parseRequirements(
    request({ max_timing_shift_ms: 24 }),
  ).requirements;
  const assessment = (observed, decision, policy = "float_roundoff_v1") => ({
    comparison_policy: policy,
    status: decision,
    comparisons: [
      {
        comparison_id: "e1",
        method: "highpass",
        status: decision,
        checks: [
          {
            metric: "max_timing_shift_ms",
            limit: 24,
            value: observed,
            status: decision,
          },
        ],
      },
    ],
  });
  const el = new JSDOM("<section></section>").window.document.querySelector(
    "section",
  );
  const s = requirementSnapshot(req, assessment(24.00000000000091, "met"));
  renderRequirementDecision(el, s);
  assert.equal(s.requirement_assessment.comparison_policy, "float_roundoff_v1");
  assert.equal(
    s.requirement_assessment.comparisons[0].checks[0].value,
    24.00000000000091,
  );
  assert.equal(s.requirement_assessment.status, "met");
  assert.equal(
    el.querySelector("tbody tr td:nth-child(3)").textContent,
    "24 ms",
  );
  assert.equal(
    el.querySelector("tbody tr td:nth-child(3)").title,
    "24.00000000000091",
  );
  assert.match(el.textContent, /arithmetic roundoff only/);
  assert.match(el.textContent, /counts remain exact/);
  const failed = requirementSnapshot(req, assessment(24.0001, "violated"));
  renderRequirementDecision(el, failed);
  assert.equal(failed.requirement_assessment.status, "violated");
  assert.match(el.textContent, /24\.0001 ms/);
  assert.match(el.textContent, /Violated/);
  const tiny = requirementSnapshot(req, assessment(1e-30, "met"));
  renderRequirementDecision(el, tiny);
  assert.match(
    el.querySelector("tbody tr td:nth-child(3)").textContent,
    /1e-30 ms/,
  );
  const legacy = assessment(24, "met");
  delete legacy.comparison_policy;
  assert.equal(
    Object.hasOwn(
      requirementSnapshot(req, legacy).requirement_assessment,
      "comparison_policy",
    ),
    false,
  );
  renderRequirementDecision(
    el,
    requirementSnapshot(req, assessment(24, "met", "future_policy")),
  );
  assert.equal(el.dataset.status, "not_established");
  assert.match(el.textContent, /policy is unsupported/);
  assert.doesNotMatch(el.textContent, /A tested setting meets/);
});

test("compact decisions keep recipes, unknown checks and bound evidence visible while details toggle locally", () => {
  const req = parseRequirements(
    request({
      max_timing_shift_ms: 24,
      min_usable_fraction: 0.8,
    }),
  ).requirements;
  const makeComparison = (id, cutoff, decision, timing) => ({
    comparison_id: id,
    method: "highpass",
    status: decision,
    window: { start_s: 0.0000000000001234, end_s: 30 },
    parameters: { highpass_hz: cutoff, median_window_s: 2, edge_guard_s: 3 },
    checks: [
      {
        metric: "max_timing_shift_ms",
        limit: 24,
        value: timing,
        status: decision,
      },
      { metric: "min_usable_fraction", limit: 0.8, value: 0.8, status: "met" },
    ],
  });
  const snapshot = {
    target: "pulse_timing",
    ...requirementSnapshot(req, {
      comparison_policy: "float_roundoff_v1",
      status: "not_established",
      comparisons: [
        makeComparison("e1", 0.35, "violated", 32),
        makeComparison("e2", 0.25, "not_established", null),
        makeComparison("e3", 0.1, "met", 24.00000000000091),
      ],
    }),
    comparisons: [{ id: "e1" }, { id: "e3" }],
  };
  const before = JSON.stringify(snapshot);
  const doc = new JSDOM("<main><section></section><section></section></main>")
    .window.document;
  const [panel, otherPanel] = doc.querySelectorAll("section");
  let selected;
  const navigation = {
    evidenceHref: (id) => `#evidence-${id}`,
    onEvidence: (id) => {
      selected = id;
    },
  };
  renderRequirementDecision(panel, snapshot, navigation);
  renderRequirementDecision(otherPanel, snapshot, navigation);
  const toggle = panel.querySelector("button");
  const details = doc.getElementById(toggle.getAttribute("aria-controls"));
  assert.equal(toggle.textContent, "Show measurements and assessment details");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(details.hidden, true);
  assert.notEqual(
    details.id,
    otherPanel.querySelector("button").getAttribute("aria-controls"),
  );
  const primary = panel.cloneNode(true);
  primary.querySelector(".requirement-details").remove();
  assert.match(primary.textContent, /measurement goal: pulse timing/);
  assert.match(primary.textContent, /24 ms/);
  assert.match(primary.textContent, /0\.8 fraction/);
  assert.match(primary.textContent, /1\.234e-13/);
  assert.match(primary.textContent, /not physiological accuracy/);
  assert.equal(primary.querySelector("table"), null);
  assert.doesNotMatch(primary.textContent, /float_roundoff_v1|1e-9 ms/);
  const recipes = panel.querySelectorAll(".requirement-recipes > li");
  assert.equal(recipes.length, 3);
  assert.match(recipes[0].textContent, /high-pass 0\.35 Hz/);
  assert.match(recipes[0].textContent, /timing shift: violated/);
  assert.match(recipes[1].textContent, /timing shift: not established/);
  assert.match(
    recipes[1].textContent,
    /Matching comparison evidence is unavailable/,
  );
  assert.equal(recipes[1].querySelector("a"), null);
  assert.equal(
    recipes[2].querySelector("a").getAttribute("href"),
    "#evidence-e3",
  );
  recipes[2].querySelector("a").click();
  assert.equal(selected, "e3");
  // A met setting does not promote an unestablished investigation outcome.
  assert.equal(panel.dataset.status, "not_established");
  assert.match(
    panel.querySelector("h3").textContent,
    /satisfaction is not established/,
  );
  toggle.click();
  assert.equal(details.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(toggle.textContent, /^Hide/);
  assert.equal(details.querySelectorAll("table").length, 3);
  assert.match(details.textContent, /arithmetic roundoff only/);
  assert.equal(
    details
      .querySelectorAll("tbody")[2]
      .querySelector("td[title='24.00000000000091']").textContent,
    "24 ms",
  );
  toggle.click();
  assert.equal(details.hidden, true);
  assert.equal(JSON.stringify(snapshot), before);
});

test("static decision output includes every check and legacy policy without a nonfunctional disclosure", () => {
  const req = parseRequirements(request()).requirements;
  const snapshot = requirementSnapshot(req, {
    status: "not_established",
    comparisons: [
      {
        comparison_id: "missing-evidence",
        method: "highpass",
        status: "not_established",
        checks: [],
      },
    ],
  });
  const doc = new JSDOM("<section></section>").window.document;
  const panel = doc.querySelector("section");
  renderRequirementDecision(panel, snapshot, {
    evidenceHref: () => "#missing",
  });
  const exported = new JSDOM(panel.outerHTML).window.document;
  assert.equal(
    exported.querySelector("button, details, [hidden], script, a"),
    null,
  );
  assert.equal(exported.querySelectorAll("tbody tr").length, 1);
  assert.match(exported.body.textContent, /not available/);
  assert.match(
    exported.body.textContent,
    /Legacy assessment.*strict arithmetic/,
  );
  assert.match(
    exported.body.textContent,
    /Missing measurements remain not established, never zero/,
  );
});
