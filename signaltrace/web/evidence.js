import { drawChart, COLORS } from "./chart.js";

export const METHODS = {
  unchanged: "Unchanged",
  median: "Median subtraction",
  highpass: "High-pass",
};
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const value = (v) => (finite(v) ? String(v) : "not available");
function node(parent, tag, text) {
  const el = parent.ownerDocument.createElement(tag);
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}
export function metricValue(v, key) {
  if (!finite(v)) return "not available";
  if (v === 0) return "0";
  const digits = key === "centered_normalized_rmse" ? 3 : 1;
  const resolution = 10 ** -digits;
  if (Math.abs(v) < resolution) return `${v < 0 ? ">-" : "<"}${resolution}`;
  return Math.abs(v) >= 1e6
    ? v.toExponential(3)
    : String(Number(v.toFixed(digits)));
}
export function evidenceTable(container, comparison, target, candidate) {
  const table = node(container, "table");
  table.className = "evidence-table";
  node(
    table,
    "caption",
    `All methods · ${target === "pulse_timing" ? "timing is the primary measurement" : "waveform shape is the primary measurement"}. Full analysis window; display zoom does not change measurements.`,
  );
  const timing = ["mean_absolute_shift_ms", "Mean timing shift (ms)"],
    shape = ["centered_normalized_rmse", "Normalized waveform difference"];
  const maximum = ["maximum_absolute_shift_ms", "Maximum timing shift (ms)"];
  const metrics =
    target === "pulse_timing"
      ? [timing, maximum, shape]
      : [shape, timing, maximum];
  metrics.push(
    ["comparator_count", "Comparator candidates"],
    ["candidate_count", "Method candidates"],
    ["matched_count", "Matched candidates"],
    ["unmatched_comparator_count", "Unmatched comparator"],
    ["unmatched_candidate_count", "Unmatched method"],
  );
  const head = node(node(table, "thead"), "tr");
  for (const label of ["Method", ...metrics.map((m) => m[1])])
    node(head, "th", label).scope = "col";
  const body = node(table, "tbody");
  for (const m of comparison.methods) {
    const row = node(body, "tr");
    if (m.method === candidate) row.className = "meta-proposal";
    node(
      row,
      "th",
      `${m.label}${m.method === candidate ? " · Meta proposal" : ""}`,
    ).scope = "row";
    for (const [key] of metrics)
      node(
        row,
        "td",
        key.includes("shift") || key === "centered_normalized_rmse"
          ? metricValue(m.metrics[key], key)
          : value(m.metrics[key]),
      );
  }
  node(
    container,
    "p",
    `${comparison.comparator === "synthetic_reference" ? "Metrics use the evaluator-only synthetic reference; the unchanged method can differ from that reference." : "Unchanged against the original has zero difference by construction."} Missing measurements are not zero. Timing agreement and shape differences do not establish accuracy, true SNR or a best filter.`,
  );
  return table;
}

// Validate every attachment against the selected immutable summary before copying arrays.
export function validatedPlot(snapshot, payload) {
  const c = snapshot.comparisons.find(
      (item) => item.id === payload?.comparison_id,
    ),
    r = payload?.result;
  if (
    !c ||
    !r ||
    payload.recording_id !== snapshot.source_id ||
    payload.experiment_id !== snapshot.experiment_id ||
    payload.channel !== snapshot.channel ||
    payload.target !== snapshot.target ||
    (snapshot.kind === "investigation" &&
      payload.investigation_id !== snapshot.evidence_id)
  )
    throw new Error("Plot belongs to different evidence");
  if (snapshot.unit && payload.unit !== snapshot.unit)
    throw new Error("Plot unit differs from evidence");
  const exact = (a, b, keys) => keys.every((key) => a?.[key] === b?.[key]);
  if (
    !exact(r.window, c.window, ["start_s", "end_s"]) ||
    !exact(r.parameters, c.parameters, [
      "median_window_s",
      "highpass_hz",
      "edge_guard_s",
    ]) ||
    r.goal !== snapshot.target ||
    r.comparison !==
      (c.comparator === "synthetic_reference"
        ? "synthetic_reference"
        : "original")
  )
    throw new Error("Plot scope differs from evidence");
  for (const m of c.methods) {
    for (const [key, v] of Object.entries(m.metrics)) {
      const sourceKey =
        {
          comparator_count: "reference_count",
          unmatched_comparator_count: "unmatched_reference_count",
        }[key] || key;
      if ((r.metrics?.[m.method]?.[sourceKey] ?? null) !== v)
        throw new Error("Plot metrics differ from evidence");
    }
  }
  const ex = r.exclusions;
  if (
    !exact(ex, c.counts, [
      "sample_count",
      "valid_count",
      "excluded_fraction",
      "nonfinite_count",
    ]) ||
    ex?.flatline_count !== c.counts.exact_flat_sample_count ||
    ex?.gap_after_indices?.length !== c.counts.gap_count ||
    ex?.valid_intervals_indices?.length !== c.counts.valid_interval_count
  )
    throw new Error("Plot exclusions differ from evidence");
  const p = r.plot,
    n = p?.times?.length;
  if (
    !Number.isInteger(n) ||
    n < 3 ||
    n > 30000 ||
    n !== c.counts.sample_count ||
    !p.times.every(
      (t, i) =>
        finite(t) &&
        t >= c.window.start_s &&
        t < c.window.end_s &&
        (!i || t > p.times[i - 1]),
    )
  )
    throw new Error("Invalid plot time axis");
  const out = { times: [...p.times] };
  for (const key of ["raw", "unchanged", "median", "highpass"]) {
    if (
      !Array.isArray(p[key]) ||
      p[key].length !== n ||
      !p[key].every((v) => v === null || finite(v))
    )
      throw new Error("Invalid plot samples");
    out[key] = [...p[key]];
  }
  if (
    !Array.isArray(p.valid_mask) ||
    p.valid_mask.length !== n ||
    !p.valid_mask.every((v) => typeof v === "boolean") ||
    p.valid_mask.filter(Boolean).length !== c.counts.valid_count
  )
    throw new Error("Invalid plot exclusions");
  out.valid_mask = [...p.valid_mask];
  if (
    Array.isArray(p.reference) &&
    p.reference.length === n &&
    p.reference.every((v) => v === null || finite(v))
  )
    out.reference = [...p.reference];
  out.candidate_evidence = candidateAnnotations(
    payload.candidate_evidence,
    c,
    r,
    out,
  );
  out.candidate_evidence_status = out.candidate_evidence
    ? "available"
    : "unavailable";
  out.unit =
    typeof payload.unit === "string"
      ? payload.unit.slice(0, 24)
      : "declared units";
  return out;
}

// Optional annotations fail closed independently of the retained numerical plot.
// This validates returned detector output; it never finds or rematches peaks.
function candidateAnnotations(a, c, r, plot) {
  try {
    const require = (ok) => {
      if (!ok) throw new Error("Invalid annotations");
    };
    const equal = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const keys = [
      "median_window_s",
      "highpass_hz",
      "highpass_order",
      "edge_guard_s",
      "minimum_interior_s",
      "flatline_s",
      "peak_distance_s",
      "prominence_fraction",
      "match_tolerance_s",
      "gap_factor",
      "regularity_tolerance",
    ];
    require(
      a?.schema === "signaltrace.candidate-evidence.v1" &&
        a.comparison_id === c.id &&
        a.sample_count === plot.times.length &&
        a.comparator ===
          (c.comparator === "synthetic_reference"
            ? "synthetic_reference"
            : "original"),
    );
    for (const k of ["start_s", "end_s"])
      require(a.window?.[k] === c.window[k]);
    for (const k of ["median_window_s", "highpass_hz", "edge_guard_s"])
      require(
        a.parameters?.[k] === c.parameters[k] &&
          a.detector?.[k] === c.parameters[k],
      );
    require(
      Object.keys(a.detector || {}).length === keys.length &&
        keys.every(
          (k) =>
            finite(a.detector[k]) &&
            a.detector[k] >= 0 &&
            a.detector[k] === r.exclusions?.parameters?.[k],
        ),
    );
    require(
      a.detector.match_tolerance_s > 0 &&
        Number.isInteger(a.detector.highpass_order),
    );
    const intervals = [];
    for (let i = 0; i < plot.times.length;) {
      if (!plot.valid_mask[i]) {
        i++;
        continue;
      }
      const start = i++;
      while (i < plot.times.length && plot.valid_mask[i]) i++;
      intervals.push([start, i]);
    }
    require(
      equal(a.valid_intervals_indices, intervals) &&
        equal(r.exclusions.valid_intervals_indices, intervals),
    );
    const comparator =
      a.comparator === "synthetic_reference" ? plot.reference : plot.raw;
    require(Array.isArray(comparator));
    require(
      plot.valid_mask.every(
        (v, i) =>
          !v ||
          [
            comparator,
            plot.raw,
            plot.unchanged,
            plot.median,
            plot.highpass,
          ].every((x) => finite(x[i])),
      ),
    );
    const indices = (xs) =>
      Array.isArray(xs) &&
      xs.length <= plot.times.length &&
      xs.every(
        (i, j) =>
          Number.isInteger(i) &&
          i >= 0 &&
          i < plot.times.length &&
          plot.valid_mask[i] &&
          (!j || i > xs[j - 1]),
      );
    require(indices(a.reference_indices));
    const reference = new Set(a.reference_indices);
    const segment = new Int32Array(plot.times.length).fill(-1);
    intervals.forEach(([s, e], k) => {
      for (let i = s; i < e; i++) segment[i] = k;
    });
    for (const method of Object.keys(METHODS)) {
      const m = a.methods?.[method],
        metrics = c.methods.find((v) => v.method === method)?.metrics;
      require(
        m &&
          metrics &&
          indices(m.candidate_indices) &&
          Array.isArray(m.pairs) &&
          m.pairs.length <= plot.times.length,
      );
      const candidates = new Set(m.candidate_indices),
        shifts = [];
      m.pairs.forEach((pair, j) => {
        require(Array.isArray(pair) && pair.length === 2);
        const [ref, candidate] = pair;
        require(
          reference.has(ref) &&
            candidates.has(candidate) &&
            (!j ||
              (ref > m.pairs[j - 1][0] && candidate > m.pairs[j - 1][1])) &&
            segment[ref] === segment[candidate],
        );
        const shift = Math.abs(plot.times[candidate] - plot.times[ref]);
        require(shift <= a.detector.match_tolerance_s);
        shifts.push(shift * 1000);
      });
      require(
        metrics.comparator_count === a.reference_indices.length &&
          metrics.candidate_count === m.candidate_indices.length &&
          metrics.matched_count === shifts.length &&
          metrics.unmatched_comparator_count ===
            a.reference_indices.length - shifts.length &&
          metrics.unmatched_candidate_count ===
            m.candidate_indices.length - shifts.length,
      );
      const mean = shifts.length
          ? shifts.reduce((x, y) => x + y, 0) / shifts.length
          : null,
        maximum = shifts.length ? Math.max(...shifts) : null;
      for (const [key, actual] of [
        ["mean_absolute_shift_ms", mean],
        ["maximum_absolute_shift_ms", maximum],
      ])
        require(
          actual === null
            ? metrics[key] === null
            : finite(metrics[key]) &&
                Math.abs(actual - metrics[key]) <=
                  Math.max(1e-9, Math.abs(actual) * 1e-12),
        );
    }
    // Copy only public allowlisted fields, never arbitrary sibling payload data.
    return {
      schema: a.schema,
      comparison_id: a.comparison_id,
      comparator: a.comparator,
      sample_count: a.sample_count,
      window: { ...c.window },
      parameters: { ...c.parameters },
      detector: Object.fromEntries(keys.map((k) => [k, a.detector[k]])),
      valid_intervals_indices: intervals,
      reference_indices: [...a.reference_indices],
      methods: Object.fromEntries(
        Object.keys(METHODS).map((k) => [
          k,
          {
            candidate_indices: [...a.methods[k].candidate_indices],
            pairs: a.methods[k].pairs.map((p) => [...p]),
          },
        ]),
      ),
    };
  } catch {
    return null;
  }
}

// Display only: matching remains exactly the annotated parent full-window result.
export function waveformExcerpt(plot, method) {
  const a = plot?.candidate_evidence,
    m = a?.methods?.[method];
  if (!m) return null;
  const matched = new Set(m.pairs.map((p) => p[1]));
  const unmatched = m.candidate_indices.find((i) => !matched.has(i));
  const target = unmatched ?? m.candidate_indices[0];
  if (target === undefined) return null;
  const [left, right] = a.valid_intervals_indices.find(
    ([s, e]) => s <= target && target < e,
  );
  const segmentStart = plot.times[left],
    segmentEnd = right < plot.times.length ? plot.times[right] : a.window.end_s;
  const width = Math.min(4, segmentEnd - segmentStart);
  if (!finite(width) || width <= 0) return null;
  const start = Math.max(
    segmentStart,
    Math.min(segmentEnd - width, plot.times[target] - width / 2),
  );
  const end = start + width;
  if (!finite(start) || !finite(end) || end <= start) return null;
  let first = left,
    last = right;
  while (first < right && plot.times[first] < start) first++;
  while (last > first && plot.times[last - 1] >= end) last--;
  // Keep every drawn sample, bounded even for a malformed dense time axis.
  if (last - first > 5000 || last - first < 2) return null;
  return {
    start,
    end,
    first,
    last,
    target,
    selection:
      unmatched === undefined
        ? "earliest matched method candidate"
        : "earliest unmatched method candidate",
    matched,
  };
}

// A shared time axis is permitted only for exact source/support/comparator bindings.
// The attachments have already passed validatedPlot; no samples are regenerated here.
function compatibleInitial(
  plot,
  comparison,
  initial,
  initialComparison,
  method,
) {
  const a = plot?.candidate_evidence,
    b = initial?.candidate_evidence;
  if (!a || !b || !initialComparison || !b.methods[method]) return false;
  const equal = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const parameters = ["median_window_s", "highpass_hz", "edge_guard_s"];
  const changed = parameters.filter(
    (k) => comparison.parameters[k] !== initialComparison.parameters[k],
  );
  return (
    a.comparison_id === comparison.id &&
    b.comparison_id === initialComparison.id &&
    a.comparator === b.comparator &&
    plot.unit === initial.unit &&
    comparison.comparator === initialComparison.comparator &&
    equal(a.window, b.window) &&
    equal(comparison.window, initialComparison.window) &&
    equal(a.parameters, comparison.parameters) &&
    equal(b.parameters, initialComparison.parameters) &&
    changed.length === 1 &&
    Object.keys(a.detector).every(
      (k) => changed.includes(k) || a.detector[k] === b.detector[k],
    ) &&
    ["times", "raw", "unchanged", "valid_mask", "reference"].every((k) =>
      equal(plot[k], initial[k]),
    ) &&
    equal(a.reference_indices, b.reference_indices) &&
    equal(a.valid_intervals_indices, b.valid_intervals_indices)
  );
}

export function renderWaveformExcerpt(
  container,
  plot,
  comparison,
  method,
  { initialPlot = null, initialComparison = null, interactive = false } = {},
) {
  const excerpt = waveformExcerpt(plot, method);
  if (!excerpt) {
    node(
      container,
      "p",
      plot?.candidate_evidence
        ? "Waveform excerpt unavailable: no candidate in a bounded valid segment."
        : "Candidate markers unavailable. Retained numerical measurements and full source plots remain available.",
    ).className = "finding-source waveform-unavailable";
    return null;
  }
  const a = plot.candidate_evidence,
    m = a.methods[method];
  const hasInitial = compatibleInitial(
    plot,
    comparison,
    initialPlot,
    initialComparison,
    method,
  );
  const figure = node(container, "figure");
  figure.className = "finding-waveform finding-figure";
  const settings = (c) =>
    `high-pass ${c.parameters.highpass_hz} Hz; median ${c.parameters.median_window_s} s; edge guard ${c.parameters.edge_guard_s} s`;
  node(
    figure,
    "figcaption",
    `Actual waveform excerpt / ${comparison.id} / ${METHODS[method]}`,
  );
  node(
    figure,
    "p",
    `Display [${excerpt.start}, ${excerpt.end}) s; follow-up ${comparison.id}: ${settings(comparison)}.${hasInitial ? ` Initial ${initialComparison.id}: ${settings(initialComparison)}.` : " Initial trace unavailable: an exact compatible annotated attachment is required."} Illustrative selection: ${excerpt.selection} at sample ${excerpt.target} (${plot.times[excerpt.target]} s). Matching and metrics use the full analysis window [${comparison.window.start_s}, ${comparison.window.end_s}) s; no crop redetection or rematching. This is one selected example, not all unmatched candidates.`,
  ).className = "finding-source";
  const comparatorLabel =
    a.comparator === "synthetic_reference"
      ? "Evaluator-only synthetic reference"
      : "Original comparator";
  const rows = [
    {
      values:
        a.comparator === "synthetic_reference" ? plot.reference : plot.raw,
      label: comparatorLabel,
      indices: a.reference_indices,
      matched: new Set(m.pairs.map((p) => p[0])),
      trace: a.comparator,
      role: "comparator",
      color:
        a.comparator === "synthetic_reference" ? COLORS.reference : COLORS.raw,
    },
  ];
  if (hasInitial) {
    const own = initialPlot.candidate_evidence.methods[method];
    rows.push({
      values: initialPlot[method],
      label: `Initial ${METHODS[method]} (${initialComparison.id}; ${settings(initialComparison)})`,
      indices: own.candidate_indices,
      matched: new Set(own.pairs.map((p) => p[1])),
      trace: method,
      role: "initial",
      color: COLORS[method],
    });
  }
  rows.push({
    values: plot[method],
    label: `Follow-up ${METHODS[method]} (${comparison.id}; ${settings(comparison)})`,
    indices: m.candidate_indices,
    matched: excerpt.matched,
    trace: method,
    role: "followup",
    color: COLORS[method],
  });
  const ns = "http://www.w3.org/2000/svg",
    svg = figure.ownerDocument.createElementNS(ns, "svg");
  const height = rows.length * 145 + 40;
  svg.setAttribute("viewBox", `0 0 800 ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("fill", "var(--plot-text, #425164)");
  svg.setAttribute(
    "aria-label",
    `${hasInitial ? "Three" : "Two"} aligned measured waveform traces with actual matched and unmatched algorithmic candidate markers`,
  );
  const viewport = node(figure, "div");
  viewport.className = "finding-waveform-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute(
    "aria-label",
    "Aligned waveform excerpt; scroll horizontally on narrow screens for readable axes",
  );
  viewport.append(svg);
  const add = (tag, attrs, text) => {
    const el = figure.ownerDocument.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  };
  add("rect", { width: 800, height, fill: "var(--plot-bg, #ffffff)" });
  const x = (i) =>
    70 +
    ((plot.times[i] - excerpt.start) / (excerpt.end - excerpt.start)) * 710;
  const summaries = [];
  rows.forEach((row, index) => {
    const { values, label, indices, matched } = row;
    const ys = values.slice(excerpt.first, excerpt.last),
      min = Math.min(...ys),
      max = Math.max(...ys),
      magnitude = Math.max(Math.abs(min), Math.abs(max)) || 1,
      scaledMin = min / magnitude,
      span = max / magnitude - scaledMin || 1,
      top = 35 + index * 145;
    row.y = (i) => top + 95 - ((values[i] / magnitude - scaledMin) / span) * 85;
    row.candidates = new Set(indices);
    // Short role labels keep the plotting area legible; full exact settings are above.
    add(
      "text",
      { x: 70, y: top - 10 },
      `${row.role === "comparator" ? label : `${row.role === "initial" ? "Initial" : "Follow-up"} ${METHODS[method]}`} / amplitude (${plot.unit}); independent y scale`,
    );
    add("text", { x: 4, y: top + 12 }, String(Number(max.toPrecision(4))));
    add("text", { x: 4, y: top + 95 }, String(Number(min.toPrecision(4))));
    add("path", {
      d: `M70 ${top}V${top + 100}H780`,
      fill: "none",
      stroke: "var(--plot-axis, #6d7a89)",
    });
    add("polyline", {
      points: ys
        .map((_, j) => `${x(excerpt.first + j)},${row.y(excerpt.first + j)}`)
        .join(" "),
      fill: "none",
      stroke: row.color,
      "stroke-width": 1.5,
      "stroke-dasharray": row.role === "initial" ? "6 4" : "",
      "data-trace": row.trace,
      "data-role": row.role,
    });
    const shown = indices.filter((i) => i >= excerpt.first && i < excerpt.last);
    shown.forEach((i) => {
      const status = matched.has(i) ? "matched" : "unmatched";
      const mark = add(matched.has(i) ? "circle" : "rect", {
        ...(matched.has(i)
          ? { cx: x(i), cy: row.y(i), r: 4 }
          : { x: x(i) - 4, y: row.y(i) - 4, width: 8, height: 8 }),
        fill: matched.has(i)
          ? "var(--plot-bg, #ffffff)"
          : "var(--marker-unmatched, #996400)",
        stroke: matched.has(i) ? row.color : "var(--marker-unmatched, #996400)",
        "stroke-width": 2,
        "data-sample-index": i,
        "data-time": plot.times[i],
        "data-value": values[i],
        "data-status": status,
        "data-trace": row.trace,
        "data-role": row.role,
      });
      const title = figure.ownerDocument.createElementNS(ns, "title");
      title.textContent = `${label}: ${status} algorithmic candidate, sample ${i}, ${plot.times[i]} s, ${values[i]} ${plot.unit}`;
      mark.append(title);
    });
    summaries.push(
      `${label}: ${shown.map((i) => `${matched.has(i) ? "matched" : "unmatched"} sample ${i} at ${plot.times[i]} s (${values[i]} ${plot.unit})`).join("; ") || "no candidates in display"}.`,
    );
  });
  add("text", { x: 70, y: height - 8 }, `${excerpt.start.toFixed(3)} s`);
  add(
    "text",
    { x: 780, y: height - 8, "text-anchor": "end" },
    `${excerpt.end.toFixed(3)} s / time`,
  );
  const steps = plot.times
    .slice(excerpt.first + 1, excerpt.last)
    .map((t, j) => t - plot.times[excerpt.first + j]);
  node(
    figure,
    "p",
    `Hollow circles: matched algorithmic candidates. Filled squares: unmatched algorithmic candidates. ${hasInitial ? "Initial dashed; follow-up solid." : "Follow-up solid."} Separate amplitude scales; aligned time axes. ${excerpt.last - excerpt.first} actual samples per trace; sample spacing ${Number(Math.min(...steps).toPrecision(12))} to ${Number(Math.max(...steps).toPrecision(12))} s (rounded; stored sample times retained). Comparator markers use follow-up full-window matching. Candidates are not verified heartbeats.`,
  ).className = "finding-source";
  if (interactive) {
    const controls = node(figure, "div");
    controls.className = "finding-cursor-controls";
    const label = node(
      controls,
      "label",
      "Inspect an actual sample (Arrow keys, Home or End)",
    );
    const slider = node(label, "input");
    slider.type = "range";
    slider.min = String(excerpt.first);
    slider.max = String(excerpt.last - 1);
    slider.step = "1";
    slider.value = String(excerpt.target);
    slider.dataset.findingControl = "sample";
    slider.setAttribute("aria-label", "Aligned waveform actual sample index");
    const readout = node(controls, "output");
    readout.className = "finding-sample-readout";
    readout.setAttribute("aria-live", "off");
    // Pointer updates are intentionally not live announcements.
    const line = add("line", {
      y1: 28,
      y2: height - 35,
      stroke: "var(--focus, #986100)",
      "stroke-width": 1,
      "pointer-events": "none",
      "data-cursor": "shared",
    });
    const dots = rows.map((row) =>
      add("circle", {
        r: 3,
        fill: row.color,
        "pointer-events": "none",
        "data-cursor-role": row.role,
      }),
    );
    const inspect = () => {
      const i = Math.max(
        excerpt.first,
        Math.min(excerpt.last - 1, Math.round(Number(slider.value))),
      );
      slider.value = String(i);
      line.setAttribute("x1", x(i));
      line.setAttribute("x2", x(i));
      line.setAttribute("data-sample-index", i);
      const statuses = rows.map((row, j) => {
        dots[j].setAttribute("cx", x(i));
        dots[j].setAttribute("cy", row.y(i));
        return `${row.role === "comparator" ? row.label : `${row.role === "initial" ? "Initial" : "Follow-up"} ${METHODS[method]}`} ${value(row.values[i])} ${plot.unit} (${row.candidates.has(i) ? (row.matched.has(i) ? "matched" : "unmatched") : "not candidate"})`;
      });
      if (!hasInitial) statuses.push("Initial unavailable");
      const text = `Sample ${i} / ${plot.times[i]} s / ${statuses.join(" / ")}. Actual measured samples; no interpolation.`;
      readout.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    };
    slider.addEventListener("input", inspect);
    slider.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
      if (!(event.key in moves) && event.key !== "Home" && event.key !== "End")
        return;
      event.preventDefault();
      slider.value = String(
        event.key === "Home"
          ? excerpt.first
          : event.key === "End"
            ? excerpt.last - 1
            : Number(slider.value) + moves[event.key],
      );
      inspect();
    });
    const inspectPointer = (event) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const time =
        excerpt.start +
        ((((event.clientX - rect.left) / rect.width) * 800 - 70) / 710) *
          (excerpt.end - excerpt.start);
      let lo = excerpt.first,
        hi = excerpt.last - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (plot.times[mid] < time) lo = mid + 1;
        else hi = mid;
      }
      if (
        lo > excerpt.first &&
        Math.abs(plot.times[lo - 1] - time) <= Math.abs(plot.times[lo] - time)
      )
        lo--;
      slider.value = String(lo);
      inspect();
    };
    svg.addEventListener("pointermove", inspectPointer);
    svg.addEventListener("pointerdown", inspectPointer);
    inspect();
    figure.restoreSample = (i) => {
      if (Number.isInteger(i)) {
        slider.value = String(i);
        inspect();
      }
    };
  }
  const details = node(figure, "details");
  node(details, "summary", "Exact displayed candidate samples");
  summaries.forEach((text) => node(details, "p", text));
  return figure;
}

export function staticEvidenceChart(
  container,
  plot,
  comparison,
  method = "median",
) {
  const figure = node(container, "figure");
  node(
    figure,
    "figcaption",
    `Original (grey) + ${METHODS[method]} (${method === "median" ? "ochre" : method === "highpass" ? "blue" : "mauve"}) · ${plot.unit} · [${comparison.window.start_s}, ${comparison.window.end_s}) s. Shaded regions are excluded; no peak annotations are inferred.`,
  );
  const chart = node(figure, "div");
  chart.className = "chart evidence-chart";
  drawChart(
    chart,
    plot.times,
    { raw: plot.raw, [method]: plot[method] },
    comparison.window.start_s,
    comparison.window.end_s,
    plot.unit,
    plot.valid_mask,
    {
      raw: plot.raw,
      unchanged: plot.unchanged,
      median: plot.median,
      highpass: plot.highpass,
    },
    true,
  );
  chart
    .querySelector("svg")
    ?.setAttribute(
      "aria-label",
      `Original and ${METHODS[method]} waveform in ${plot.unit}; excluded samples shaded`,
    );
  chart.querySelector("svg")?.removeAttribute("aria-hidden");
  chart.querySelector("svg")?.setAttribute("role", "img");
  return chart;
}

export function mountEvidence(
  container,
  { snapshot, comparison, plot, onMethod = () => {} },
) {
  container.replaceChildren();
  let method =
    snapshot.candidate?.comparison_id === comparison.id &&
    METHODS[snapshot.candidate.method]
      ? snapshot.candidate.method
      : "median";
  let start = comparison.window.start_s,
    end = comparison.window.end_s,
    animation = null,
    disposed = false;
  const win = container.ownerDocument.defaultView,
    motion = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const root = node(container, "section");
  root.className = "interactive-evidence";
  const heading = node(root, "h2", "Explore the measured evidence");
  const context = node(
    root,
    "p",
    `${snapshot.kind === "manual" ? "Manual comparison · Meta was not used" : `Meta investigation ${snapshot.evidence_id} · comparison ${comparison.id}`}. Original comparator: ${comparison.comparator === "synthetic_reference" ? "evaluator-only synthetic reference for metrics" : "original waveform"}. Analysis [${comparison.window.start_s}, ${comparison.window.end_s}) s. Median ${comparison.parameters.median_window_s} s; high-pass ${comparison.parameters.highpass_hz} Hz; guard ${comparison.parameters.edge_guard_s} s.`,
  );
  const exclusions = node(
    root,
    "p",
    `${comparison.counts.valid_count} of ${comparison.counts.sample_count} samples valid; ${metricValue(finite(comparison.counts.excluded_fraction) ? comparison.counts.excluded_fraction * 100 : null, "percent")}% excluded (shaded). Curves use original ${plot.unit}; amplitude scale stays fixed across method switches.`,
  );
  const controls = node(root, "div");
  controls.className = "button-row evidence-methods";
  controls.setAttribute("aria-label", "Displayed method");
  const buttons = [];
  for (const [key, label] of Object.entries(METHODS)) {
    const b = node(controls, "button", label);
    b.type = "button";
    b.className = "secondary";
    b.dataset.method = key;
    b.style.setProperty("--method-color", COLORS[key]);
    b.addEventListener("click", () => {
      method = key;
      render();
      onMethod(key);
    });
    buttons.push(b);
  }
  const zoom = node(root, "div");
  zoom.className = "button-row";
  for (const [label, action] of [
    ["Zoom in", () => changeZoom(0.5)],
    ["Zoom out", () => changeZoom(2)],
    [
      "Full analysis window",
      () => {
        start = comparison.window.start_s;
        end = comparison.window.end_s;
        render();
      },
    ],
    ["Pan earlier", () => pan(-1)],
    ["Pan later", () => pan(1)],
  ]) {
    const b = node(zoom, "button", label);
    b.type = "button";
    b.addEventListener("click", action);
  }
  const scope = node(root, "p");
  scope.setAttribute("role", "status");
  scope.className = "evidence-display-scope";
  const legend = node(root, "p");
  legend.className = "evidence-legend";
  const chart = node(root, "div");
  chart.className = "chart evidence-chart";
  const label = node(
    root,
    "label",
    "Inspect an actual sample (arrow keys move one sample)",
  );
  const slider = node(label, "input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(plot.times.length - 1);
  slider.step = "1";
  slider.value = "0";
  slider.setAttribute("aria-label", "Actual sample index");
  const readout = node(root, "output");
  readout.className = "evidence-sample";
  readout.setAttribute("aria-live", "polite");
  const wrap = node(root, "div");
  wrap.className = "evidence-table-scroll";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute(
    "aria-label",
    "All method measurements; scroll horizontally for all columns",
  );
  const methodsTable = evidenceTable(
    wrap,
    comparison,
    snapshot.target,
    snapshot.candidate?.comparison_id === comparison.id
      ? snapshot.candidate.method
      : null,
  );
  methodsTable.querySelector("caption").textContent =
    `${snapshot.target === "pulse_timing" ? "Timing" : "Waveform shape"} is primary · Full analysis window`;
  const supportLabels = [
    "Comparator candidates",
    "Method candidates",
    "Matched candidates",
    "Unmatched comparator",
    "Unmatched method",
  ];
  [...methodsTable.querySelectorAll("thead th")]
    .slice(4)
    .forEach((cell, index) => {
      cell.textContent = supportLabels[index];
    });
  wrap.querySelector(":scope > p").textContent =
    `${comparison.comparator === "synthetic_reference" ? "Synthetic-reference comparator" : "Original comparator"}. Missing is not zero; sensitivity is not physiological accuracy.`;
  const tabs = node(root, "nav");
  tabs.className = "evidence-tabs";
  tabs.setAttribute("aria-label", "Evidence views");
  const graphPane = node(root, "div");
  graphPane.className = "evidence-view evidence-graph-view";
  graphPane.append(controls, legend, chart);
  const graphScope = node(graphPane, "p");
  graphScope.className = "evidence-graph-scope";
  const tablePane = node(root, "div");
  tablePane.className = "evidence-view";
  tablePane.append(wrap);
  const samplePane = node(root, "div");
  samplePane.className = "evidence-view";
  samplePane.append(label, readout);
  const navigationPane = node(root, "div");
  navigationPane.className = "evidence-view";
  navigationPane.append(scope, zoom);
  const scopePane = node(root, "div");
  scopePane.className = "evidence-view";
  scopePane.append(heading, context, exclusions);
  root.prepend(tabs);
  const views = [
    ["Graph", graphPane, false],
    ["Measurements", tablePane, false],
    ["Matching counts", tablePane, true],
    ["Navigate & sample", navigationPane, false],
    ["Sample values", samplePane, false],
    ["Scope & exclusions", scopePane, false],
  ];
  const more = node(tabs, "button", "More evidence tools");
  more.type = "button";
  more.className = "secondary evidence-tools-toggle";
  more.setAttribute("aria-expanded", "false");
  const secondary = node(root, "div");
  secondary.className = "evidence-secondary-tools";
  secondary.hidden = true;
  const toolsId = `${container.id || "evidence"}-secondary-tools`;
  secondary.id = toolsId;
  more.setAttribute("aria-controls", toolsId);
  more.addEventListener("click", () => {
    secondary.hidden = !secondary.hidden;
    more.setAttribute("aria-expanded", String(!secondary.hidden));
  });
  const viewButtons = [];
  views.forEach(([name, pane, counts], index) => {
    const button = node(index < 2 ? tabs : secondary, "button", name);
    if (index < 2) tabs.insertBefore(button, more);
    button.type = "button";
    button.className = "secondary";
    const activate = () => {
      for (const el of [
        graphPane,
        tablePane,
        samplePane,
        navigationPane,
        scopePane,
      ])
        el.hidden = el !== pane;
      wrap.classList.toggle("primary-metrics", !counts);
      wrap.classList.toggle("matching-counts", counts);
      viewButtons.forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
      render();
    };
    button.addEventListener("click", activate);
    viewButtons.push(button);
    button.setAttribute("aria-pressed", String(index === 0));
  });
  tabs.after(secondary);
  graphPane.hidden = false;
  tablePane.hidden =
    samplePane.hidden =
    navigationPane.hidden =
    scopePane.hidden =
      true;
  wrap.classList.add("primary-metrics");
  function sample() {
    const i = Number(slider.value);
    const text = `Sample ${i} · ${plot.times[i]} s · original ${value(plot.raw[i])} ${plot.unit} · ${METHODS[method]} ${value(plot[method][i])} ${plot.unit} · ${plot.valid_mask[i] ? "included" : "excluded"}. Values are measured samples, not interpolation.`;
    readout.textContent = text;
    slider.setAttribute("aria-valuetext", text);
  }
  slider.addEventListener("input", sample);
  function pan(direction) {
    const width = end - start,
      shift = (direction * width) / 2;
    start = Math.max(
      comparison.window.start_s,
      Math.min(comparison.window.end_s - width, start + shift),
    );
    end = start + width;
    render();
  }
  function changeZoom(factor) {
    const full = comparison.window.end_s - comparison.window.start_s;
    const width = Math.min(full, Math.max(full / 128, (end - start) * factor)),
      center = (start + end) / 2;
    start = Math.max(
      comparison.window.start_s,
      Math.min(comparison.window.end_s - width, center - width / 2),
    );
    end = start + width;
    render();
  }
  function stop() {
    try {
      animation?.cancel();
    } catch {
      /* Motion never gates data. */
    }
    animation = null;
  }
  function render() {
    if (disposed) return;
    stop();
    buttons.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.method === method)),
    );
    wrap.querySelectorAll("tbody tr").forEach((row, index) => {
      const selected = comparison.methods[index].method === method;
      row.classList.toggle("displayed-method", selected);
      if (selected) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    });
    scope.textContent = `Display [${start}, ${end}) s. Measurements in the table remain for the full analysis window.`;
    graphScope.textContent = `Analysis [${comparison.window.start_s}, ${comparison.window.end_s}) s / ${comparison.counts.valid_count ?? "not available"} of ${comparison.counts.sample_count ?? "not available"} samples valid. ${scope.textContent}`;
    legend.textContent = `Original (grey) + ${METHODS[method]} (${method === "median" ? "ochre" : method === "highpass" ? "blue" : "mauve"}). Shading marks excluded samples.`;
    drawChart(
      chart,
      plot.times,
      { raw: plot.raw, [method]: plot[method] },
      start,
      end,
      plot.unit,
      plot.valid_mask,
      {
        raw: plot.raw,
        unchanged: plot.unchanged,
        median: plot.median,
        highpass: plot.highpass,
      },
      true,
    );
    const first = plot.times.findIndex((t) => t >= start),
      last = plot.times.findLastIndex((t) => t < end);
    const empty = first < 0 || last < first || plot.times[first] >= end;
    slider.disabled = empty;
    if (empty) {
      readout.textContent =
        "No measured samples in this display window. Pan or zoom out to inspect a sample.";
      slider.setAttribute(
        "aria-valuetext",
        "No measured samples in display window",
      );
    } else {
      slider.min = String(first);
      slider.max = String(last);
      slider.value = String(
        Math.max(first, Math.min(last, Number(slider.value))),
      );
      sample();
    }
    if (motion && !motion.matches && chart.animate) {
      try {
        animation = chart.animate([{ opacity: 0.65 }, { opacity: 1 }], {
          duration: 160,
        });
      } catch {
        /* Presentation only. */
      }
    }
  }
  const onMotion = () => {
    if (motion.matches) stop();
  };
  motion?.addEventListener?.("change", onMotion);
  win?.addEventListener("resize", render);
  const observer = win?.ResizeObserver
    ? new win.ResizeObserver(() => render())
    : null;
  observer?.observe(chart);
  render();
  return {
    refresh: render,
    selectMethod(selected) {
      if (disposed || !Object.hasOwn(METHODS, selected)) return;
      method = selected;
      render();
      onMethod(selected);
    },
    destroy() {
      disposed = true;
      stop();
      observer?.disconnect();
      motion?.removeEventListener?.("change", onMotion);
      win?.removeEventListener("resize", render);
      container.replaceChildren();
    },
  };
}
