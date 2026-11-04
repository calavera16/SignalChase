const NS = "http://www.w3.org/2000/svg";
export const COLORS = {
  raw: "var(--trace-raw, #526174)",
  unchanged: "var(--trace-unchanged, #955781)",
  median: "var(--trace-median, #996400)",
  highpass: "var(--trace-highpass, #006c9a)",
  reference: "var(--trace-reference, #007658)",
};
function element(document, name, attrs = {}, value) {
  const node = document.createElementNS(NS, name);
  for (const [key, val] of Object.entries(attrs))
    node.setAttribute(key, String(val));
  if (value !== undefined) node.textContent = value;
  return node;
}
export function drawChart(
  container,
  times,
  series,
  start,
  end,
  unit,
  validMask = null,
  amplitudeSeries = series,
  halfOpen = false,
) {
  const doc = container.ownerDocument,
    width = container.clientWidth || 800,
    height = container.clientHeight || 360,
    fontSize =
      parseFloat(
        doc.defaultView?.getComputedStyle(doc.documentElement).fontSize,
      ) || 16;
  const svg = element(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    "aria-hidden": "true",
    fill: "var(--plot-text, #425164)",
  });
  svg.append(
    element(doc, "rect", { width, height, fill: "var(--plot-bg, #ffffff)" }),
  );
  const visible = [];
  for (let i = 0; i < times.length; i++)
    if (times[i] >= start && (halfOpen ? times[i] < end : times[i] <= end))
      visible.push(i);
  let low = Infinity,
    high = -Infinity;
  for (const values of Object.values(amplitudeSeries))
    for (const i of visible)
      if (Number.isFinite(values[i])) {
        low = Math.min(low, values[i]);
        high = Math.max(high, values[i]);
      }
  if (!Number.isFinite(low)) {
    low = 0;
    high = 1;
  }
  // Scale only display coordinates: subtraction/padding in original units can
  // overflow, or round away for constant signals at large magnitudes.
  const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
  low /= scale;
  high /= scale;
  const margin = Math.max(
    high === low ? 0.5 : (high - low) * 0.08,
    Number.EPSILON * 8,
    (Number.MIN_VALUE / scale) * 8,
  );
  const limit = Math.min(2, Number.MAX_VALUE / scale);
  low = Math.max(-limit, low - margin);
  high = Math.min(limit, high + margin);
  const tickCount = width < 480 ? 3 : 5;
  const ticks = Array.from({ length: tickCount }, (_, i) =>
    Math.max(
      -Number.MAX_VALUE,
      Math.min(
        Number.MAX_VALUE,
        (low + ((high - low) * i) / (tickCount - 1)) * scale,
      ),
    ),
  );
  // Retain original units, enough precision to distinguish nearby ticks, and
  // avoid parsing rounded MAX_VALUE labels back into overflowing numbers.
  let labels;
  for (let precision = 3; precision <= 17; precision++) {
    labels = ticks.map((value) => {
      const label = value.toPrecision(precision);
      const rounded = Number(label);
      return Number.isFinite(rounded) ? rounded.toString() : value.toString();
    });
    if (new Set(labels).size === ticks.length) break;
  }
  // Reserve real space for 1rem labels. Long finite extremes wrap into
  // multiple lines; their full precision and original units are retained.
  const charWidth = fontSize * 0.63,
    longest = Math.max(...labels.map((label) => label.length)),
    left = Math.min(Math.max(64, longest * charWidth + 16), width * 0.46),
    right = 12,
    charsPerLine = Math.max(1, Math.floor((left - 16) / charWidth)),
    labelLines = Math.ceil(longest / charsPerLine),
    top = Math.max(28, labelLines * fontSize * 0.65),
    w = Math.max(1, width - left - right);
  // Give each time tick a disjoint horizontal region. Endpoint labels anchor
  // inward; middle labels center on their ticks. Preserve round-trip values,
  // wrapping long timestamps instead of shrinking or dropping their digits.
  const timeTicks = w < 320 ? 2 : w < 600 ? 3 : 5,
    tickSpacing = w / (timeTicks - 1),
    timeLabels = Array.from({ length: timeTicks }, (_, i) => {
      const value = start + (end - start) * (i / (timeTicks - 1)),
        available =
          tickSpacing * (i === 0 || i === timeTicks - 1 ? 0.5 : 1) - 12,
        characters = Math.max(1, Math.floor(available / charWidth));
      return {
        value,
        chunks: String(value).match(new RegExp(`.{1,${characters}}`, "g")),
      };
    }),
    timeLineCount = Math.max(...timeLabels.map(({ chunks }) => chunks.length)),
    timeLineHeight = fontSize * 1.2,
    bottom = Math.max(64, timeLineCount * timeLineHeight + fontSize * 2.25),
    h = Math.max(1, height - top - bottom);
  const x = (t) => left + ((t - start) / Math.max(end - start, 1e-9)) * w,
    y = (v) => top + h - ((v / scale - low) / (high - low)) * h;
  const steps = times
    .slice(1)
    .map((v, i) => v - times[i])
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(steps.length / 2);
  const nominal = steps.length
    ? steps.length % 2
      ? steps[middle]
      : (steps[middle - 1] + steps[middle]) / 2
    : Infinity;
  const gap = nominal * 1.5;
  if (validMask) {
    let a = null;
    for (let k = 0; k <= visible.length; k++) {
      const i = visible[k];
      if (k < visible.length && !validMask[i]) {
        if (a === null) a = i;
      } else if (a !== null) {
        const b = times[visible[k - 1]];
        svg.append(
          element(doc, "rect", {
            x: x(times[a]),
            y: top,
            width: Math.max(1, x(b) - x(times[a])),
            height: h,
            fill: "var(--plot-exclusion, #e7ebf0)",
          }),
        );
        a = null;
      }
    }
  }
  for (let i = 0; i < tickCount; i++) {
    const yy = top + h - (i / (tickCount - 1)) * h;
    const label = element(doc, "text", {
      x: left - 8,
      y: yy + fontSize * 0.3,
      "text-anchor": "end",
      "data-axis": "amplitude",
    });
    const chunks = labels[i].match(new RegExp(`.{1,${charsPerLine}}`, "g"));
    chunks.forEach((chunk, index) =>
      label.append(
        element(
          doc,
          "tspan",
          {
            x: left - 8,
            dy:
              index === 0
                ? -((chunks.length - 1) * fontSize * 0.6)
                : fontSize * 1.2,
          },
          chunk,
        ),
      ),
    );
    svg.append(
      element(doc, "line", {
        x1: left,
        x2: width - right,
        y1: yy,
        y2: yy,
        stroke: "var(--plot-grid, #d1d9e0)",
        "data-grid": "amplitude",
      }),
      label,
    );
  }
  timeLabels.forEach(({ value, chunks }, i) => {
    const label = element(doc, "text", {
      x: x(value),
      y: top + h + fontSize * 1.5,
      "text-anchor": i === 0 ? "start" : i === timeTicks - 1 ? "end" : "middle",
      "data-axis": "time",
    });
    chunks.forEach((chunk, line) =>
      label.append(
        element(
          doc,
          "tspan",
          {
            x: x(value),
            dy: line === 0 ? 0 : timeLineHeight,
          },
          chunk,
        ),
      ),
    );
    svg.append(label);
  });
  svg.append(
    element(doc, "path", {
      d: `M${left} ${top}V${top + h}H${width - right}`,
      fill: "none",
      stroke: "var(--plot-axis, #6d7a89)",
    }),
    element(
      doc,
      "text",
      {
        x: left + w / 2,
        y: height - fontSize * 0.5,
        "text-anchor": "middle",
        "data-axis": "time-title",
      },
      "Time (s)",
    ),
  );
  let reduced = false;
  for (const [name, values] of Object.entries(series)) {
    const segments = [];
    let segment = [];
    for (const i of visible) {
      if (
        !Number.isFinite(values[i]) ||
        (segment.length && times[i] - times[segment.at(-1)] > gap)
      ) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (Number.isFinite(values[i])) segment.push(i);
    }
    if (segment.length) segments.push(segment);
    for (let points of segments) {
      if (points.length > w * 3) {
        reduced = true;
        const selected = [];
        const bucket = Math.ceil(points.length / (w * 1.5));
        for (let k = 0; k < points.length; k += bucket) {
          const part = points.slice(k, k + bucket);
          let min = part[0],
            max = part[0];
          for (const i of part) {
            if (values[i] < values[min]) min = i;
            if (values[i] > values[max]) max = i;
          }
          selected.push(
            ...new Set([part[0], min, max, part.at(-1)].sort((a, b) => a - b)),
          );
        }
        points = selected;
      }
      const d = points
        .map(
          (i, k) =>
            `${k ? "L" : "M"}${x(times[i]).toFixed(2)},${y(values[i]).toFixed(2)}`,
        )
        .join(" ");
      svg.append(
        element(doc, "path", {
          d,
          fill: "none",
          stroke: COLORS[name] || COLORS.raw,
          "stroke-width": name === "raw" ? 1.1 : 1.4,
          "stroke-dasharray": name === "reference" ? "5 4" : "",
          "vector-effect": "non-scaling-stroke",
        }),
      );
    }
  }
  container.replaceChildren(svg);
  container.setAttribute(
    "aria-label",
    `${unit} waveform from ${start.toFixed(2)} to ${end.toFixed(2)} seconds. Gaps remain disconnected.${validMask ? " Shaded regions excluded from metrics." : ""}`,
  );
  return { reduced, sampleCount: visible.length };
}
