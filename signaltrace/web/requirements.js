// Researcher-supplied sensitivity limits. No physiological defaults or model guesses.
export const REQUIREMENT_FIELDS = {
  max_timing_shift_ms: {
    label: "Maximum matched-candidate timing shift",
    unit: "ms",
    direction: "≤",
  },
  max_unmatched_candidates: {
    label: "Total unmatched candidates (processed + original)",
    unit: "candidates",
    direction: "≤",
  },
  min_usable_fraction: {
    label: "Usable sample fraction",
    unit: "fraction",
    direction: "≥",
  },
  max_waveform_difference: {
    label: "Normalized waveform difference",
    unit: "unitless",
    direction: "≤",
  },
};
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const methods = { highpass: "High-pass", median: "Median subtraction" };
const text = (v) => (typeof v === "string" ? v.slice(0, 1200) : "");
const status = (v) =>
  ["met", "violated", "not_established"].includes(v) ? v : "not_established";
const labels = {
  met: "Met",
  violated: "Violated",
  not_established: "Not established",
};
const value = (v, metric) =>
  finite(v)
    ? metric === "max_unmatched_candidates"
      ? String(v)
      : String(Number(v.toPrecision(12)))
    : "not available";
const validLimit = (key, v) =>
  finite(v) &&
  v >= 0 &&
  (key !== "max_unmatched_candidates" || Number.isSafeInteger(v)) &&
  (key !== "min_usable_fraction" || v <= 1);

export function parseRequirements({
  enabled = false,
  confirmed = false,
  method = "",
  criteria = {},
} = {}) {
  if (!enabled) return { requirements: null, error: "" };
  if (!Object.hasOwn(methods, method))
    return {
      requirements: null,
      error:
        "Select the processed method to check. Unchanged is a control, not a requirement candidate.",
    };
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria))
    return {
      requirements: null,
      error: "Enter supported research limits as numeric fields.",
    };
  const parsed = {};
  for (const key of Object.keys(REQUIREMENT_FIELDS)) {
    const raw = criteria[key];
    if (raw === undefined || raw === null || String(raw).trim() === "")
      continue;
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!validLimit(key, n))
      return {
        requirements: null,
        error: `${REQUIREMENT_FIELDS[key].label}: enter ${key === "min_usable_fraction" ? "a fraction from 0 to 1" : key === "max_unmatched_candidates" ? "a nonnegative whole number" : "a finite nonnegative number"}.`,
      };
    parsed[key] = n;
  }
  if (!Object.keys(parsed).length)
    return {
      requirements: null,
      error:
        "Enter at least one research requirement. Blank fields are not requested.",
    };
  if (confirmed !== true)
    return {
      requirements: null,
      error:
        "Confirm that these limits come from your research requirements before starting.",
    };
  return {
    requirements: { confirmed: true, method, criteria: parsed },
    error: "",
  };
}

// A detached, explicit allowlist of the server's assessment. Never infer a verdict.
export function requirementSnapshot(requirements, assessment) {
  if (!requirements)
    return { requirements: null, requirement_assessment: null };
  const parsed = parseRequirements({ ...requirements, enabled: true });
  if (parsed.error) return { requirements: null, requirement_assessment: null };
  const policy = assessment?.comparison_policy;
  const supportedPolicy =
    policy === undefined || policy === "float_roundoff_v1";
  const comparisons = (
    Array.isArray(assessment?.comparisons) ? assessment.comparisons : []
  )
    .slice(0, 8)
    .map((c) => ({
      comparison_id: text(c?.comparison_id),
      method: text(c?.method),
      parameters: Object.fromEntries(
        ["median_window_s", "highpass_hz", "edge_guard_s"].map((k) => [
          k,
          finite(c?.parameters?.[k]) ? c.parameters[k] : null,
        ]),
      ),
      window: Object.fromEntries(
        ["start_s", "end_s"].map((k) => [
          k,
          finite(c?.window?.[k]) ? c.window[k] : null,
        ]),
      ),
      status: supportedPolicy ? status(c?.status) : "not_established",
      checks: (Array.isArray(c?.checks) ? c.checks : [])
        .slice(0, 4)
        .map((check) => ({
          metric: text(check?.metric),
          label: text(check?.label),
          limit: finite(check?.limit) ? check.limit : null,
          value: finite(check?.value) ? check.value : null,
          status:
            supportedPolicy && finite(check?.value)
              ? status(check?.status)
              : "not_established",
          unit: text(check?.unit),
          reason: text(check?.reason),
        })),
    }));
  for (const c of comparisons) {
    if (
      c.method !== parsed.requirements.method ||
      (c.status === "met" &&
        Object.entries(parsed.requirements.criteria).some(
          ([key, limit]) =>
            !c.checks.some(
              (check) =>
                check.metric === key &&
                check.limit === limit &&
                check.status === "met",
            ),
        ))
    )
      c.status = "not_established";
  }
  const assessmentStatus = supportedPolicy
    ? status(assessment?.status)
    : "not_established";
  return {
    requirements: parsed.requirements,
    requirement_assessment: {
      ...(policy !== undefined
        ? { comparison_policy: text(policy) || "unsupported" }
        : {}),
      status:
        assessmentStatus === "met" &&
        !comparisons.some((c) => c.status === "met")
          ? "not_established"
          : assessmentStatus,
      comparisons,
      met_comparison_ids: (Array.isArray(assessment?.met_comparison_ids)
        ? assessment.met_comparison_ids
        : []
      )
        .slice(0, 8)
        .map(text),
      next_action: text(assessment?.next_action),
      limitations: (Array.isArray(assessment?.limitations)
        ? assessment.limitations
        : []
      )
        .slice(0, 12)
        .map(text),
    },
  };
}

function node(parent, tag, content) {
  const el = parent.ownerDocument.createElement(tag);
  if (content !== undefined) el.textContent = content;
  parent.append(el);
  return el;
}
let disclosureId = 0;
const exact = (v) => (finite(v) ? String(v) : "not available");

function recipe(c) {
  return `Tested interval [${exact(c.window?.start_s)}, ${exact(c.window?.end_s)}) s · median ${exact(c.parameters?.median_window_s)} s · high-pass ${exact(c.parameters?.highpass_hz)} Hz · edge guard ${exact(c.parameters?.edge_guard_s)} s.`;
}

export function renderRequirementDecision(
  container,
  snapshot,
  { evidenceHref, onEvidence, interactive = Boolean(onEvidence) } = {},
) {
  container.replaceChildren();
  const req = snapshot?.requirements;
  container.hidden = !req;
  if (!req) return;
  container.className = "requirement-decision";
  container.setAttribute("aria-label", "Research requirement decision");
  const a = snapshot.requirement_assessment;
  const verdict = status(a?.status);
  container.dataset.status = verdict;
  node(
    container,
    "h3",
    {
      met: "A tested setting meets your confirmed limits",
      violated: "Tested settings violate your confirmed limits",
      not_established: "Requirement satisfaction is not established",
    }[verdict],
  );
  node(
    container,
    "p",
    `Your measurement goal: ${snapshot.target === "pulse_timing" ? "pulse timing" : snapshot.target === "waveform_sensitivity" ? "waveform sensitivity" : "the confirmed limits below"}. Check ${methods[req.method] || "the requested method"} against the original recording.`,
  ).className = "requirement-goal";
  node(container, "h4", "Your confirmed limits");
  const requested = node(container, "ul");
  requested.className = "requirement-limits";
  for (const [key, limit] of Object.entries(req.criteria)) {
    const field = REQUIREMENT_FIELDS[key];
    node(
      requested,
      "li",
      `${field.label}: ${field.direction} ${value(limit, key)} ${field.unit}`,
    ).title = String(limit);
  }
  node(container, "h4", "Tested settings");
  const tested = node(container, "ol");
  tested.className = "requirement-recipes";
  for (const c of a?.comparisons || []) {
    const item = node(tested, "li");
    const heading = node(item, "p");
    heading.className = "requirement-recipe-heading";
    node(heading, "strong", c.comparison_id || "Comparison unavailable");
    node(heading, "span", labels[status(c.status)]).className =
      "requirement-verdict";
    node(
      item,
      "p",
      `${methods[c.method] || c.method || "Method unavailable"}. ${recipe(c)}`,
    );
    const unresolved = Object.keys(req.criteria).flatMap((key) => {
      const check = c.checks.find((check) => check.metric === key);
      const decision = finite(check?.value)
        ? status(check?.status)
        : "not_established";
      return decision === "met"
        ? []
        : [
            `${REQUIREMENT_FIELDS[key].label}: ${labels[decision].toLowerCase()}`,
          ];
    });
    node(
      item,
      "p",
      unresolved.length
        ? unresolved.join(". ") + "."
        : status(c.status) === "met"
          ? "All confirmed limits met in the retained measurements."
          : "The retained checks do not establish this setting against the requested method and limits.",
    );
    const exists = snapshot.comparisons?.some(
      (comparison) => comparison.id === c.comparison_id,
    );
    if (exists && evidenceHref) {
      const link = node(item, "a", `Inspect ${c.comparison_id} evidence`);
      link.href = evidenceHref(c.comparison_id);
      if (onEvidence)
        link.addEventListener("click", (event) => {
          event.preventDefault();
          onEvidence(c.comparison_id);
        });
    } else node(item, "p", "Matching comparison evidence is unavailable.");
  }
  if (!a?.comparisons?.length)
    node(
      container,
      "p",
      "No assessed comparison is retained. Missing measurements are not zero.",
    );
  if (
    a?.comparison_policy !== undefined &&
    a.comparison_policy !== "float_roundoff_v1"
  )
    node(
      container,
      "p",
      "The retained comparison policy is unsupported; a decision cannot be established in this viewer.",
    );
  node(container, "h4", "Next action");
  node(
    container,
    "p",
    a?.next_action ||
      "Review the available evidence and define or run a full-window check. Satisfaction remains unestablished.",
  );
  node(
    container,
    "p",
    "Only these exact tested settings and intervals are assessed. This concerns sensitivity to the original recording, not physiological accuracy or a best filter.",
  ).className = "requirement-limit";

  // Export uses the same evidence renderer, fully expanded and without scripts.
  let toggle;
  if (interactive) {
    toggle = node(
      container,
      "button",
      "Show measurements and assessment details",
    );
    toggle.type = "button";
    toggle.className = "secondary panel-toggle requirement-details-toggle";
    toggle.setAttribute("aria-expanded", "false");
  }
  const details = node(container, "div");
  details.className = "requirement-details";
  if (toggle) {
    details.id = `requirement-details-${++disclosureId}`;
    details.hidden = true;
    toggle.setAttribute("aria-controls", details.id);
    toggle.addEventListener("click", () => {
      details.hidden = !details.hidden;
      toggle.setAttribute("aria-expanded", String(!details.hidden));
      toggle.textContent = `${details.hidden ? "Show" : "Hide"} measurements and assessment details`;
    });
  }
  node(details, "h4", "Measured checks for each setting");
  for (const c of a?.comparisons || []) {
    const section = node(details, "section");
    node(
      section,
      "h4",
      `${c.comparison_id || "Comparison unavailable"} · ${labels[status(c.status)]}`,
    );
    const scroll = node(section, "div");
    scroll.className = "evidence-table-scroll";
    const table = node(scroll, "table");
    table.className = "evidence-table";
    node(
      table,
      "caption",
      "Confirmed requirements versus retained measurements",
    );
    const head = node(node(table, "thead"), "tr");
    for (const label of ["Requirement", "Target", "Observed", "Decision"])
      node(head, "th", label).scope = "col";
    const body = node(table, "tbody");
    for (const [key, limit] of Object.entries(req.criteria)) {
      const field = REQUIREMENT_FIELDS[key];
      const check = c.checks.find((check) => check.metric === key);
      const row = node(body, "tr");
      node(row, "th", field.label).scope = "row";
      node(
        row,
        "td",
        `${field.direction} ${value(limit, key)} ${field.unit}`,
      ).title = String(limit);
      const observed = node(
        row,
        "td",
        `${value(check?.value, key)}${finite(check?.value) ? ` ${field.unit}` : ""}`,
      );
      if (finite(check?.value)) observed.title = String(check.value);
      node(
        row,
        "td",
        `${labels[status(check?.status)]}${check?.reason ? `: ${check.reason}` : ""}`,
      );
    }
  }
  node(details, "h4", "Assessment policy and provenance");
  node(
    details,
    "p",
    "SignalTrace checks the retained measurements against your researcher-confirmed limits. Only tested settings over the full requested interval can establish satisfaction. Meta's proposal and these numerical checks are separate evidence.",
  );
  if (a?.comparison_policy === "float_roundoff_v1")
    node(
      details,
      "p",
      "Comparison policy: arithmetic roundoff only (float_roundoff_v1). Timing: 1e-9 ms absolute / 1e-12 relative; fraction and waveform difference: 1e-12 absolute / relative. Unmatched candidate counts remain exact. This adds no scientific allowance to your limits. Display values use up to 12 significant digits; full values remain in the snapshot and numeric cell titles.",
    );
  else if (a?.comparison_policy !== undefined)
    node(
      details,
      "p",
      "Comparison policy is unsupported in this viewer. Verify the retained assessment with a compatible version before relying on a decision.",
    );
  else
    node(
      details,
      "p",
      "Legacy assessment: the original strict arithmetic comparison is retained. No newer roundoff policy is applied to this result.",
    );
  node(
    details,
    "p",
    "Unchanged is a zero-difference control by construction; it does not demonstrate preprocessing efficacy. Missing measurements remain not established, never zero.",
  );
  for (const limitation of a?.limitations || []) node(details, "p", limitation);
}
