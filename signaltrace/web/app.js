import { drawChart, COLORS } from "./chart.js";
import { mountEvidence } from "./evidence.js";
import { mountFindings } from "./findings.js";
import { createCredentials } from "./credentials.js";
import {
  REQUIREMENT_FIELDS,
  parseRequirements,
  renderRequirementDecision,
} from "./requirements.js";
import * as reportTools from "./report.js";
import {
  makeInvestigationReport,
  makeManualReport,
  renderReportPreview,
  renderInvestigationStory,
  renderInvestigationFinding,
  investigationFinding,
  reportHTML,
  attachComparisonPlot,
  selectReportMethod,
  regionalSummarySnapshot,
  renderRegionalSummary,
} from "./report.js";

const UNAVAILABLE_MESSAGE =
  "Insufficient valid data: choose a longer window containing finite, varying segments beyond the 3-second edge guards. No Meta model request was made.";

const defaultQuestion = (target) =>
  `How sensitive is ${target === "waveform_sensitivity" ? "waveform shape" : "pulse timing"} to my preprocessing settings—and does that change across this recording?`;

// Presentation only: never use these strings in requests or stored evidence.
export function formatMeasurement(value, key) {
  if (!Number.isFinite(value)) return "not available";
  const digits = key === "centered_normalized_rmse" ? 3 : 1;
  const resolution = digits === 3 ? 0.001 : 0.1;
  if (value === 0) return "0";
  if (Math.abs(value) < resolution)
    return value > 0 ? `<${resolution}` : `>-${resolution}`;
  if (Math.abs(value) >= 1e6) return scientific(value);
  return Number(value.toFixed(digits)).toString();
}
function scientific(value, exponentOffset = 0) {
  const [mantissa, exponent] = value.toExponential(3).split("e");
  const power = Number(exponent) + exponentOffset;
  return `${Number(mantissa)}e${power >= 0 ? "+" : ""}${power}`;
}
export function formatExcludedPercent(fraction) {
  if (!Number.isFinite(fraction)) return "not available";
  // Scale the exponent instead of multiplying a huge finite input into Infinity.
  const display =
    Math.abs(fraction) >= 1e4
      ? scientific(fraction, 2)
      : formatMeasurement(fraction * 100, "percent");
  return `${display}%`;
}

// A local display preference only; it never changes retained scientific state.
export function createTheme(doc) {
  const win = doc.defaultView,
    root = doc.documentElement,
    select = doc.getElementById("theme-preference"),
    key = "signaltrace.theme";
  const valid = (value) => ["light", "dark", "system"].includes(value);
  let preference = "system",
    media = null,
    destroyed = false;
  try {
    const saved = win.localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch {
    /* Private browsing and disabled storage still support a session preference. */
  }
  try {
    media = win.matchMedia?.("(prefers-color-scheme: dark)");
  } catch {
    /* A missing media API falls back to light. */
  }
  function apply() {
    if (destroyed) return;
    root.dataset.themePreference = preference;
    root.dataset.theme =
      preference === "system"
        ? media?.matches
          ? "dark"
          : "light"
        : preference;
    if (select) select.value = preference;
  }
  function change() {
    if (destroyed || !valid(select?.value)) return;
    preference = select.value;
    try {
      win.localStorage.setItem(key, preference);
    } catch {
      /* The current document can still use the chosen scheme. */
    }
    apply();
  }
  const systemChange = () => {
    if (preference === "system") apply();
  };
  if (media?.addEventListener) media.addEventListener("change", systemChange);
  else media?.addListener?.(systemChange);
  select?.addEventListener("change", change);
  apply();
  return {
    destroy() {
      destroyed = true;
      select?.removeEventListener("change", change);
      if (media?.removeEventListener)
        media.removeEventListener("change", systemChange);
      else media?.removeListener?.(systemChange);
    },
  };
}

export function createApp(
  doc = document,
  request = globalThis.fetch.bind(globalThis),
) {
  const $ = (id) => doc.getElementById(id);
  const win = doc.defaultView;
  const theme = createTheme(doc);
  let guide = null;
  const loadingDialog = $("loading-dialog");
  const pendingTasks = new Map();
  let loadingTimer = null,
    loadingDismissed = false,
    destroyed = false;
  let loadingOrigin = null,
    loadingNavigation = 0,
    loadingFocus = null;
  function focusNode(node) {
    const sessions = $("session-dialog");
    if (sessions?.open && !sessions.contains(node)) return;
    node = guide?.reveal(node) || node;
    if (loadingDialog.open)
      loadingFocus = { node, navigation: navigationToken };
    else node.focus();
  }
  function visibleFocus(node) {
    return (
      node?.isConnected &&
      node !== doc.body &&
      !node.disabled &&
      !node.closest("[hidden], dialog:not([open])")
    );
  }
  function closeLoading() {
    if (loadingTimer !== null) win.clearTimeout(loadingTimer);
    loadingTimer = null;
    if (!loadingDialog.open) return;
    const current = doc.activeElement;
    const preferred =
      !loadingDialog.contains(current) && visibleFocus(current)
        ? current
        : loadingFocus?.navigation === navigationToken &&
            visibleFocus(loadingFocus.node)
          ? loadingFocus.node
          : loadingNavigation === navigationToken && visibleFocus(loadingOrigin)
            ? loadingOrigin
            : $(step + "-title");
    loadingDialog.close();
    // Native close can restore an opener from an older, now hidden stage.
    if (visibleFocus(preferred)) preferred.focus();
  }
  function dismissLoading(event) {
    event?.preventDefault();
    loadingDismissed = true;
    closeLoading();
  }
  $("keep-working").addEventListener("click", dismissLoading);
  loadingDialog.addEventListener("cancel", dismissLoading);
  function taskLabel(path) {
    if (path === "/api/analyze") return "Comparing filters";
    if (
      path === "/api/demo" ||
      path === "/api/import" ||
      path.endsWith("/recording")
    )
      return "Opening recording";
    if (path.endsWith("/export")) return "Preparing download";
    if (path === "/api/preview") return "Preparing CSV preview";
    return "Working locally";
  }
  function updateLoadingLabel() {
    const labels = new Set(pendingTasks.values());
    $("loading-title").textContent =
      labels.size === 1 ? [...labels][0] : "Working locally";
  }
  async function pendingWork(work, path = "") {
    const task = {};
    pendingTasks.set(task, taskLabel(path));
    if (!destroyed) {
      $("request-activity").hidden = false;
      updateLoadingLabel();
      if (pendingTasks.size === 1 && !loadingDismissed) {
        loadingTimer = win.setTimeout(() => {
          loadingTimer = null;
          if (
            destroyed ||
            loadingDismissed ||
            !pendingTasks.size ||
            doc.querySelector("dialog[open]") ||
            !loadingDialog.showModal
          )
            return;
          loadingFocus = null;
          loadingOrigin = doc.activeElement;
          loadingNavigation = navigationToken;
          try {
            loadingDialog.showModal();
          } catch {
            /* Inline status remains available. */
          }
        }, 350);
      }
    }
    try {
      return await work();
    } finally {
      pendingTasks.delete(task);
      if (!pendingTasks.size) {
        closeLoading();
        loadingDismissed = false;
      } else updateLoadingLabel();
      $("request-activity").hidden = destroyed || pendingTasks.size === 0;
    }
  }
  // Animation is presentation only: no state or focus waits for its completion.
  let motionPreference = null;
  try {
    motionPreference = win?.matchMedia?.("(prefers-reduced-motion: reduce)");
  } catch {
    /* Animation is optional when media preference access is unavailable. */
  }
  const animations = new Set();
  const stopMotion = () => {
    if (motionPreference?.matches) {
      for (const animation of animations) animation.cancel();
      animations.clear();
    }
  };
  motionPreference?.addEventListener?.("change", stopMotion);
  function animateEntrance(node, frames, duration) {
    if (
      destroyed ||
      !motionPreference ||
      motionPreference.matches ||
      !node.animate
    )
      return null;
    try {
      const animation = node.animate(frames, {
        duration,
        easing: "cubic-bezier(.22,1,.36,1)",
      });
      animations.add(animation);
      animation.finished?.then(
        () => animations.delete(animation),
        () => animations.delete(animation),
      );
      return animation;
    } catch {
      return null;
    }
  }
  function revealNew(node) {
    if (step !== "compare") return;
    animateEntrance(
      node,
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      300,
    );
  }
  let view = null,
    result = null,
    pendingCSV = null,
    revision = 0,
    loadToken = 0,
    previewToken = 0,
    exportToken = 0;
  let openingView = "choice",
    sampleChooserOpen = false,
    sessionCount = 0;
  let openingExperimentId = null;
  let libraryNarrow = win.innerWidth <= 900;
  let libraryOpen = !libraryNarrow;
  function syncLibrary() {
    const panel = $("session-library");
    const toggle = $("session-library-toggle");
    if (
      !libraryOpen &&
      (panel.contains(doc.activeElement) || panel.contains(loadingFocus?.node))
    )
      focusNode(toggle);
    panel.hidden = !libraryOpen;
    toggle.setAttribute("aria-expanded", String(libraryOpen));
    toggle.textContent = libraryOpen
      ? "Hide session experiments"
      : "Show session experiments";
  }
  function resizeLibrary() {
    const narrow = win.innerWidth <= 900;
    if (narrow === libraryNarrow) return;
    libraryNarrow = narrow;
    libraryOpen = !narrow;
    syncLibrary();
  }
  $("session-library-toggle").addEventListener("click", () => {
    libraryOpen = !libraryOpen;
    syncLibrary();
  });
  win.addEventListener("resize", resizeLibrary);
  let opening = false,
    analyzing = false,
    importing = false;
  let experiment = null,
    runs = [],
    selectedRuns = new Set(),
    protocolDirty = false;
  let contextToken = 0,
    historyToken = 0,
    sessionToken = 0,
    saving = false;
  // Investigation traffic is separate from local work: never open the loading modal.
  let investigationConfig = null,
    credentialsChanging = false,
    investigationBinding = null,
    investigationEpoch = 0,
    investigationRead = 0,
    investigationTimer = null,
    investigationPosting = false,
    investigationRefreshing = false,
    investigationExporting = false,
    investigationUnknown = null,
    investigationActive = null,
    investigationSelected = null,
    investigationMessage = "",
    investigationFailure = "";
  const investigationJobs = new Map();
  const unavailableInvestigations = new Set();
  const investigationSelections = new Map();
  const reportSelections = new Map();
  let retainedSelection = null,
    retainedRead = 0,
    retainedBusy = false;
  let explanationConfig = null,
    explanationConfigLoaded = false,
    explanationBinding = null,
    explanationEpoch = 0;
  let explanationTimer = null,
    explanationReading = false,
    explanationPosting = false;
  let explanationSelected = null,
    explanationUnknown = null,
    explanationMessage = "";
  let findings = null,
    findingsKey = null;
  const explanationJobs = new Map();
  const explanationSelections = new Map();
  let reportBinding = null;
  let reportSelection = null,
    reportSnapshot = null,
    reportVersion = 0,
    reportDownloading = false;
  let reportSummaryKey = "";
  let reportBaseSummaryKey = "",
    reportEvidenceSnapshot = null;
  let reportPlotState = "none";
  // Four retained comparisons at most; no replay recipes or private history enter this cache.
  const comparisonCache = new Map();
  function evidenceController(container, onAttach = () => {}) {
    let key = null,
      epoch = 0,
      revision = 0,
      mounted = null,
      selection = null,
      requestedMethod = null;
    const choices = new Map();
    function clear() {
      epoch++;
      revision++;
      mounted?.destroy();
      mounted = null;
      requestedMethod = null;
      container.replaceChildren();
    }
    function update(snapshot, manualResult = null, force = false) {
      const nextKey = snapshot
        ? `${snapshot.kind}/${snapshot.source_id}/${snapshot.experiment_id}/${snapshot.evidence_id}`
        : null;
      if (nextKey === key && !force) return;
      clear();
      key = nextKey;
      if (!snapshot) {
        onAttach(null, "none");
        return;
      }
      if (!snapshot.comparisons.length) {
        container.textContent =
          "No successful comparison is available to plot. Inspection evidence and questions remain below.";
        onAttach(snapshot, "no-comparison");
        return;
      }
      let retained = snapshot,
        displayState = "loading",
        summaryPending = false;
      const generation = revision;
      const notify = () =>
        onAttach(retained, summaryPending ? "loading" : displayState);
      async function loadPayload(eid) {
        const cacheKey = `${key}/${eid}`;
        let pending = comparisonCache.get(cacheKey);
        if (!pending) {
          pending = (async () => {
            const response = await request(
              `/api/investigations/${encodeURIComponent(snapshot.evidence_id)}/comparisons/${encodeURIComponent(eid)}`,
            );
            if (!response.ok) throw new Error("Comparison unavailable");
            return response.json();
          })();
          comparisonCache.set(cacheKey, pending);
          while (comparisonCache.size > 4)
            comparisonCache.delete(comparisonCache.keys().next().value);
          pending.catch(() => {
            if (comparisonCache.get(cacheKey) === pending)
              comparisonCache.delete(cacheKey);
          });
        }
        return pending;
      }
      selection =
        choices.get(key) ||
        snapshot.candidate?.comparison_id ||
        snapshot.comparisons.at(-1).id;
      if (!snapshot.comparisons.some((c) => c.id === selection))
        selection = snapshot.comparisons.at(-1).id;
      const label = doc.createElement("label");
      label.textContent = "Comparison to explore";
      const select = doc.createElement("select");
      select.setAttribute("aria-label", "Comparison evidence");
      for (const c of snapshot.comparisons) {
        const o = doc.createElement("option");
        o.value = c.id;
        const recipe = c.parameters;
        const identity =
          snapshot.kind === "manual" ? "Manual run" : `Evidence ${c.id}`;
        o.textContent = `${identity} / [${c.window.start_s}, ${c.window.end_s}) s${recipe ? ` / median ${recipe.median_window_s} s; high-pass ${recipe.highpass_hz} Hz; guard ${recipe.edge_guard_s} s` : ""}${snapshot.candidate?.comparison_id === c.id ? " / Meta proposal" : ""}`;
        select.append(o);
      }
      select.value = selection;
      select.disabled = snapshot.comparisons.length < 2;
      label.hidden = snapshot.comparisons.length < 2;
      label.append(select);
      container.append(label);
      const status = doc.createElement("p");
      status.setAttribute("role", "status");
      container.append(status);
      const retry = doc.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry local waveform";
      retry.hidden = true;
      container.append(retry);
      const canvas = doc.createElement("div");
      canvas.className = "evidence-canvas";
      container.append(canvas);
      async function load() {
        const token = ++epoch,
          binding = key,
          eid = selection;
        choices.set(key, eid);
        mounted?.destroy();
        mounted = null;
        canvas.replaceChildren();
        displayState = "loading";
        notify();
        status.textContent = "Loading retained comparison waveform locally…";
        retry.hidden = true;
        canvas.setAttribute("aria-busy", "true");
        const cacheKey = `${binding}/${eid}`;
        try {
          let payload;
          if (manualResult)
            payload = {
              comparison_id: eid,
              recording_id: snapshot.source_id,
              experiment_id: snapshot.experiment_id,
              channel: snapshot.channel,
              target: snapshot.target,
              unit:
                view?.recording.channels.find(
                  (c) => c.name === snapshot.channel,
                )?.unit || "declared units",
              result: manualResult,
            };
          else {
            payload = await loadPayload(eid);
          }
          if (
            destroyed ||
            token !== epoch ||
            binding !== key ||
            eid !== selection
          )
            return;
          const attached = attachComparisonPlot(retained, payload),
            comparison = attached.comparisons.find((c) => c.id === eid);
          retained = attached;
          mounted = mountEvidence(canvas, {
            snapshot: attached,
            comparison,
            plot: comparison.plot,
            onMethod(method) {
              if (!destroyed && token === epoch && binding === key) {
                retained = selectReportMethod(retained, eid, method);
                notify();
              }
            },
          });
          if (requestedMethod?.id === eid) {
            mounted.selectMethod(requestedMethod.method);
            requestedMethod = null;
          }
          status.textContent =
            "Retained local evidence loaded. These controls make no Meta request.";
          displayState = "loaded";
          notify();
        } catch {
          if (!destroyed && token === epoch && binding === key) {
            comparisonCache.delete(cacheKey);
            status.textContent =
              "Comparison waveform unavailable. The retained numerical summary remains below. Retry loading local evidence or download the explicitly labelled summary report; no Meta request was made.";
            retry.hidden = false;
            displayState = "unavailable";
            notify();
          }
        } finally {
          if (token === epoch) canvas.setAttribute("aria-busy", "false");
        }
      }
      select.addEventListener("change", () => {
        selection = select.value;
        void load();
      });
      retry.addEventListener("click", () => {
        void load();
      });
      const finding =
        snapshot.kind === "investigation"
          ? investigationFinding(snapshot)
          : null;
      const optionalEvidence = finding?.contrast
        ? [...new Set(finding.evidence)].filter((id) => id !== selection)
        : [];
      let remaining = optionalEvidence.length;
      summaryPending = remaining > 0;
      void load();
      for (const id of optionalEvidence) {
        // Finding attachments never replace the user's selected comparison/method.
        void loadPayload(id)
          .then((payload) => {
            if (destroyed || generation !== revision) return;
            retained = attachComparisonPlot(retained, payload);
          })
          .catch(() => {
            /* Optional summary excerpt never gates numerical evidence. */
          })
          .finally(() => {
            if (destroyed || generation !== revision) return;
            summaryPending = --remaining > 0;
            notify();
          });
      }
    }
    return {
      update,
      selectComparison(id, method) {
        const select = container.querySelector(
          'select[aria-label="Comparison evidence"]',
        );
        if (!select || ![...select.options].some((o) => o.value === id))
          return false;
        requestedMethod = ["median", "highpass"].includes(method)
          ? { id, method }
          : null;
        if (select.value !== id) {
          select.value = id;
          select.dispatchEvent(new win.Event("change"));
        } else if (mounted && requestedMethod) {
          mounted.selectMethod(requestedMethod.method);
          requestedMethod = null;
        }
        focusNode(select);
        return true;
      },
      refresh() {
        mounted?.refresh();
      },
      destroy() {
        clear();
        key = null;
      },
    };
  }
  const reportVisuals = evidenceController(
    $("report-visuals"),
    (snapshot, state) => {
      reportEvidenceSnapshot = snapshot;
      reportSnapshot = reportWithExplanation(snapshot);
      reportPlotState = state;
      reportVersion++;
      if (reportSnapshot)
        $("report-preview")
          .querySelector("article")
          ?.updateFinding?.(reportSnapshot);
      $("download-report").disabled = !snapshot || state === "loading";
      $("download-report").textContent =
        state === "unavailable"
          ? "Download summary report (waveform unavailable)"
          : "Download readable report (.html)";
      guide?.refresh();
    },
  );
  let investigationAttached = null;
  const investigationVisuals = evidenceController(
    $("investigation-visuals"),
    (snapshot) => {
      investigationAttached = snapshot;
      const job = investigationJobs.get(investigationSelected);
      if (
        snapshot &&
        !destroyed &&
        investigationMatches(job) &&
        snapshot.evidence_id === job.id
      )
        renderInvestigationFinding($("investigation-finding"), snapshot, {
          ...investigationEvidenceNavigation(job),
          interactive: true,
        });
    },
  );
  function reportContext(job) {
    if (job?.display_context) return job.display_context;
    return investigationMatches(job)
      ? { recording: view.recording, experiment }
      : null;
  }
  function reportWithExplanation(snapshot) {
    const selected = explanationJobs.get(explanationSelected);
    if (
      snapshot &&
      selected?.status === "completed" &&
      selected.result &&
      selected.request?.investigation_id === snapshot.evidence_id &&
      selected.request.evidence_digest === snapshot.evidence_digest &&
      reportTools.attachExplanationReport
    ) {
      try {
        return reportTools.attachExplanationReport(snapshot, selected.result);
      } catch {
        /* Keep the independently validated scientific evidence. */
      }
    }
    return snapshot;
  }
  function reportSources() {
    const sources = [];
    for (const job of investigationJobs.values()) {
      if (
        (investigationMatches(job) || job.id === retainedSelection) &&
        reportContext(job) &&
        (!unavailableInvestigations.has(job.id) ||
          reportSelection === `investigation:${job.id}`) &&
        job.status !== "running" &&
        job.result &&
        (job.id === retainedSelection ||
          (!protocolDirty && !opening && !importing))
      )
        sources.push({
          value: `investigation:${job.id}`,
          label: `Meta / ${retainedName(job)} / ${job.source?.kind === "imported_historical" ? "Historical import" : "Recorded investigation"} / ${job.status === "failed" || job.status === "interrupted" ? "Stopped with evidence" : { candidate: "Proposal for review", needs_information: "Needs information", inconclusive: "Inconclusive" }[job.result.conclusion?.status] || "Completed"} / ${job.request.channel} / [${job.request.start_s}, ${job.request.end_s}) s`,
          kind: "investigation",
          job,
        });
    }
    if (
      view &&
      experiment &&
      !protocolDirty &&
      !opening &&
      !importing &&
      result?.recording_id === view.recording.id &&
      result.experiment_id === experiment.id
    )
      sources.push({
        value: `manual:${result.id}`,
        label: `Manual / ${result.channel} / [${result.window.start_s}, ${result.window.end_s}) s / Meta not used`,
        kind: "manual",
        result,
      });
    return sources;
  }
  function syncReport() {
    const binding = retainedSelection
      ? `retained:${retainedSelection}`
      : investigationKey();
    if (binding !== reportBinding) {
      reportBinding = binding;
      reportSelection =
        reportSelections.get(binding) ||
        (retainedSelection
          ? `investigation:${retainedSelection}`
          : reportSelection);
    }
    const sources = reportSources();
    if (
      !opening &&
      !importing &&
      !protocolDirty &&
      !sources.some((s) => s.value === reportSelection)
    )
      reportSelection = sources[0]?.value || null;
    if (binding && sources.some((s) => s.value === reportSelection))
      reportSelections.set(binding, reportSelection);
    const source = sources.find((s) => s.value === reportSelection);
    const select = $("report-source");
    select.replaceChildren(
      ...sources.map((s) => {
        const option = doc.createElement("option");
        option.value = s.value;
        option.textContent = s.label;
        return option;
      }),
    );
    if (reportSelection) select.value = reportSelection;
    select.disabled = sources.length < 2;
    $("report-source-label").hidden = sources.length < 2;
    $("report-source-identity").hidden = sources.length !== 1;
    text(
      "report-source-identity",
      source
        ? source.kind === "investigation"
          ? retainedName(source.job)
          : "Manual comparison"
        : "",
    );
    let next = null;
    try {
      if (source)
        next =
          source.kind === "investigation"
            ? makeInvestigationReport({
                ...reportContext(source.job),
                job: source.job,
              })
            : makeManualReport({
                recording: view.recording,
                experiment,
                result: source.result,
              });
    } catch {
      /* Mismatched or incomplete evidence cannot produce a report. */
    }
    syncWorkspaceContext(next);
    syncExplanationSource(source, next);
    const baseSummaryKey = JSON.stringify(next),
      baseChanged = baseSummaryKey !== reportBaseSummaryKey;
    if (baseChanged) {
      reportBaseSummaryKey = baseSummaryKey;
      reportEvidenceSnapshot = next;
    }
    const selectedExplanation = explanationJobs.get(explanationSelected);
    const summaryKey = JSON.stringify([
      baseSummaryKey,
      explanationSelected,
      selectedExplanation?.result || null,
    ]);
    const scientificSnapshot = next;
    next = reportWithExplanation(reportEvidenceSnapshot);
    renderRequirementDecision($("report-requirements"), next, {
      evidenceHref: () => "#report-visuals",
      onEvidence: (id) => {
        if (
          reportSnapshot?.evidence_id !== next?.evidence_id ||
          reportSnapshot?.source_id !== next?.source_id
        )
          return;
        $("detailed-report").open = true;
        reportVisuals.selectComparison(id, next?.requirements?.method);
        $("report-visuals").scrollIntoView?.({ block: "nearest" });
      },
    });
    if (summaryKey !== reportSummaryKey) {
      reportSummaryKey = summaryKey;
      reportVersion++;
      reportSnapshot = next;
      text("report-download-status", "");
      if (next) renderReportPreview($("report-preview"), next);
      else $("report-preview").replaceChildren();
      if (baseChanged)
        reportVisuals.update(
          scientificSnapshot,
          source?.kind === "manual" ? source.result : null,
          true,
        );
    }
    const scope =
      source?.kind === "investigation" ? source.job.request : source?.result;
    const historical =
      scope &&
      (scope.channel !== $("channel").value ||
        (scope.start_s ?? scope.window?.start_s) !==
          Number($("window-start").value) ||
        (scope.end_s ?? scope.window?.end_s) !== Number($("window-end").value));
    text(
      "report-scope",
      scope
        ? `${source.kind === "investigation" ? "Meta investigation" : "Manual comparison"} / ${scope.channel} / [${scope.start_s ?? scope.window?.start_s}, ${scope.end_s ?? scope.window?.end_s}) s.${historical ? " Historical evidence: current channel or interval differs." : ""}${source.kind === "investigation" && unavailableInvestigations.has(source.job.id) ? " Server copy unavailable: this report is cached in this browser view only. Replay download and new explanations are unavailable; import its saved investigation JSON to restore server evidence." : ""}`
        : "",
    );
    text(
      "report-empty",
      next
        ? ""
        : "No report evidence selected. Complete a Meta investigation or view a saved manual comparison. Retained manual bundles remain available below.",
    );
    $("download-report").disabled = !next || reportPlotState === "loading";
    $("download-report-replay").disabled =
      !next ||
      reportDownloading ||
      (source?.kind === "investigation" &&
        unavailableInvestigations.has(source.job.id));
    for (const id of ["step-nav-export", "continue-export"])
      $(id).disabled = !allowed("export");
    const selectedJob = investigationJobs.get(investigationSelected);
    const hasInvestigation =
      investigationMatches(selectedJob) &&
      selectedJob.status !== "running" &&
      !!selectedJob.result;
    $("review-investigation").disabled =
      !hasInvestigation ||
      unavailableInvestigations.has(selectedJob?.id) ||
      protocolDirty ||
      opening ||
      importing;
    $("review-manual").disabled = !sources.some(
      (s) => s.value === `manual:${result?.id}`,
    );
    text(
      "continue-export",
      hasInvestigation
        ? "Review this investigation & make report"
        : result
          ? "Review manual results & make report"
          : "Review results & make report",
    );
    renderExplanation(source, next);
  }
  function reviewSource(value) {
    if (!reportSources().some((source) => source.value === value)) return;
    retainedSelection = value.startsWith("investigation:")
      ? value.slice(14)
      : null;
    reportSelection = value;
    reportSelections.set(
      retainedSelection ? `retained:${retainedSelection}` : investigationKey(),
      value,
    );
    syncReport();
    goStep("export");
  }
  $("review-investigation").addEventListener("click", () =>
    reviewSource(`investigation:${investigationSelected}`),
  );
  $("review-manual").addEventListener("click", () =>
    reviewSource(`manual:${result?.id}`),
  );
  $("continue-export").addEventListener("click", () => {
    const job = investigationJobs.get(investigationSelected);
    if (investigationMatches(job) && job.status !== "running" && job.result)
      reviewSource(`investigation:${job.id}`);
    else if (result) reviewSource(`manual:${result.id}`);
    else goStep("export");
  });
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob),
      link = doc.createElement("a");
    link.href = url;
    link.download = filename;
    doc.body.append(link);
    link.click();
    link.remove();
    win.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("report-source").addEventListener("change", () => {
    reportSelection = $("report-source").value;
    retainedSelection = reportSelection.startsWith("investigation:")
      ? reportSelection.slice("investigation:".length)
      : null;
    reportSelections.set(
      retainedSelection ? `retained:${retainedSelection}` : investigationKey(),
      reportSelection,
    );
    reportVersion++;
    syncReport();
  });
  $("download-report").addEventListener("click", () => {
    if (
      !reportSnapshot ||
      reportPlotState === "loading" ||
      destroyed ||
      !reportSources().some((s) => s.value === reportSelection)
    )
      return;
    downloadBlob(
      new Blob([reportHTML(reportSnapshot, doc)], {
        type: "text/html;charset=utf-8",
      }),
      "signaltrace-report.html",
    );
    text(
      "report-download-status",
      "Readable report download requested. Open the HTML file to read or print it.",
    );
  });
  $("download-report-replay").addEventListener("click", async () => {
    const source = reportSources().find((s) => s.value === reportSelection);
    if (!source || !reportSnapshot || reportDownloading || destroyed) return;
    if (
      source.kind === "investigation" &&
      unavailableInvestigations.has(source.job.id)
    )
      return;
    const version = reportVersion,
      context = contextToken;
    const path =
      source.kind === "investigation"
        ? `/api/investigations/${encodeURIComponent(source.job.id)}/export`
        : `/api/experiments/${encodeURIComponent(experiment.id)}/runs/${encodeURIComponent(source.result.id)}/export`;
    reportDownloading = true;
    syncReport();
    try {
      const response = await request(path);
      if (!response.ok) throw new Error("download failed");
      const blob = await response.blob();
      if (
        destroyed ||
        version !== reportVersion ||
        context !== contextToken ||
        source.value !== reportSelection
      )
        return;
      downloadBlob(
        blob,
        source.kind === "investigation"
          ? "signaltrace-investigation.json"
          : "signaltrace-analysis.json",
      );
      text(
        "report-download-status",
        "Replay JSON download requested for the selected report evidence.",
      );
    } catch {
      if (!destroyed && version === reportVersion && context === contextToken)
        text(
          "report-download-status",
          "Could not download replay data. Refresh retained evidence and try again.",
        );
    } finally {
      reportDownloading = false;
      if (!destroyed) syncReport();
    }
  });
  // Local archive selection never changes the active editable recording/experiment.
  const retainedDialog = $("retained-results-dialog");
  let retainedOpener = null;
  let retainedPresentation = 0;
  function closeRetained() {
    retainedPresentation++;
    if (retainedDialog.open && retainedDialog.close) retainedDialog.close();
    retainedDialog.removeAttribute("open");
    if (visibleFocus(retainedOpener)) retainedOpener.focus();
  }
  function openRetained(event) {
    if (destroyed) return;
    retainedOpener = event.currentTarget;
    retainedPresentation++;
    if (!retainedDialog.open) {
      if (retainedDialog.showModal) retainedDialog.showModal();
      else retainedDialog.setAttribute("open", "");
    }
    $("retained-results-close").focus();
    void refreshRetained();
  }
  for (const id of ["retained-results-open", "results-library-open"])
    $(id).addEventListener("click", openRetained);
  $("retained-results-close").addEventListener("click", closeRetained);
  retainedDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRetained();
  });
  function retainedName(job) {
    return (
      reportContext(job)?.experiment?.protocol?.name ||
      reportContext(job)?.recording?.name ||
      "Investigation"
    );
  }
  function storageDescription(value) {
    return (
      {
        retained: "retained locally",
        restored: "restored locally",
        write_failed: "save failed; download to keep",
        memory: "memory only",
      }[value] || "session only"
    );
  }
  function renderRetained() {
    $("retained-results-refresh").disabled = retainedBusy;
    $("retained-result-file").disabled = retainedBusy;
    $("retained-results-list").replaceChildren(
      ...[...investigationJobs.values()]
        .filter((job) => !unavailableInvestigations.has(job.id))
        .map((job) => {
          const item = doc.createElement("li"),
            name = doc.createElement("h3"),
            info = doc.createElement("p"),
            button = doc.createElement("button");
          name.textContent = retainedName(job);
          info.textContent = `${job.request.channel} / [${job.request.start_s}, ${job.request.end_s}) s / ${job.status}. ${job.source?.kind === "imported_historical" ? "Imported historical evidence; recorded Meta identity is an unverified historical claim." : "Original investigation; recorded model rationale is unverified."} Storage: ${storageDescription(job.retention)}.`;
          button.type = "button";
          button.dataset.investigationId = job.id;
          button.className = "secondary";
          button.textContent =
            job.result && job.status !== "running"
              ? "Open result"
              : job.status === "running"
                ? "Refresh running investigation"
                : "No retained report evidence";
          button.disabled =
            retainedBusy ||
            (!job.result && job.status !== "running") ||
            (!reportContext(job) && job.status !== "running");
          button.addEventListener("click", async () => {
            if (destroyed || retainedBusy) return;
            const generation = ++retainedRead;
            const presentation = retainedPresentation,
              navigation = navigationToken;
            retainedBusy = true;
            renderRetained();
            text("retained-results-status", "Opening retained result locally…");
            try {
              const fresh = retainInvestigation(
                await investigationAPI(
                  `/api/investigations/${encodeURIComponent(job.id)}`,
                ),
              );
              if (destroyed || generation !== retainedRead) return;
              if (!fresh.result || fresh.status === "running") {
                text(
                  "retained-results-status",
                  fresh.status === "running"
                    ? "This investigation is still running on the server. Refresh to read its actual status; no new investigation was submitted."
                    : "This result has no retained report evidence. Import a saved replay JSON if available.",
                );
                return;
              }
              if (!reportContext(fresh)) throw new Error("No source context");
              if (
                presentation !== retainedPresentation ||
                navigation !== navigationToken
              ) {
                text(
                  "retained-results-status",
                  "Result loaded locally. Open it from Saved results when ready.",
                );
                return;
              }
              retainedSelection = fresh.id;
              reportSelection = `investigation:${fresh.id}`;
              closeRetained();
              syncReport();
              goStep("export");
              text("retained-results-status", "");
            } catch {
              if (!destroyed && generation === retainedRead)
                text(
                  "retained-results-status",
                  "This saved result is unavailable or expired. Import its replay JSON to restore it. Your current recording is unchanged.",
                );
            } finally {
              if (!destroyed && generation === retainedRead) {
                retainedBusy = false;
                renderRetained();
              }
            }
          });
          item.append(name, info, button);
          return item;
        }),
    );
  }
  async function refreshRetained() {
    if (destroyed || retainedBusy) return;
    const generation = ++retainedRead;
    const observed = new Map(investigationJobs);
    retainedBusy = true;
    renderRetained();
    text("retained-results-status", "Reading saved results locally…");
    try {
      const data = await investigationAPI("/api/investigations");
      if (destroyed || generation !== retainedRead) return;
      if (!Array.isArray(data.jobs)) throw new Error("Unreadable archive");
      if (
        !data.jobs.every(
          (job) =>
            typeof job?.id === "string" &&
            job.request &&
            ["running", "completed", "failed", "interrupted"].includes(
              job.status,
            ),
        )
      )
        throw new Error("Unreadable archive");
      const ids = new Set(data.jobs.map((job) => job.id));
      for (const [id, previous] of observed) {
        if (ids.has(id) || investigationJobs.get(id) !== previous) continue;
        // The response is authoritative only for records unchanged since this read began.
        if (
          reportSelection === `investigation:${id}` ||
          investigationSelected === id
        ) {
          unavailableInvestigations.add(id);
          if (previous.status === "running") {
            investigationJobs.set(id, {
              ...previous,
              status: "interrupted",
              error: { category: "interrupted" },
            });
            if (investigationActive === id) {
              investigationActive = null;
              stopInvestigationPoll();
            }
          }
          if (investigationSelected === id)
            investigationFailure =
              "This investigation is no longer retained on the server. Any displayed evidence is cached in this browser view only. Import saved replay JSON to restore it.";
        } else {
          investigationJobs.delete(id);
          unavailableInvestigations.delete(id);
        }
      }
      data.jobs.forEach(retainInvestigation);
      const available = [...investigationJobs.keys()].some(
        (id) => !unavailableInvestigations.has(id),
      );
      const cached = unavailableInvestigations.size > 0;
      if (unavailableInvestigations.has(retainedSelection)) {
        $("explanation-consent").checked = false;
        stopExplanationPoll();
      }
      text(
        "retained-results-status",
        available
          ? "Saved results loaded. Opening them makes no Meta request."
          : `No saved investigations on this server. ${cached ? "The selected report remains cached in this browser view only. " : ""}Import a saved investigation JSON or create an investigation.`,
      );
    } catch {
      if (!destroyed && generation === retainedRead)
        text(
          "retained-results-status",
          "Could not read saved results. Existing session evidence is unchanged; refresh to try a local read again.",
        );
    } finally {
      if (!destroyed && generation === retainedRead) {
        retainedBusy = false;
        renderRetained();
        renderInvestigation();
        syncReport();
      }
    }
  }
  $("retained-results-refresh").addEventListener("click", refreshRetained);
  async function boundedJSON(file, maximum) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !/\.json$/i.test(file.name) ||
      file.name.toLowerCase().startsWith(".env") ||
      /(^|[.\-_])env([.\-_]|$)|secret|credential|private_key|id_rsa/i.test(
        file.name,
      ) ||
      !Number.isFinite(file.size) ||
      file.size <= 0 ||
      file.size > maximum
    )
      throw new Error("File size exceeds local import limit");
    const raw = await file.text();
    if (
      typeof raw !== "string" ||
      raw.length > maximum ||
      new TextEncoder().encode(raw).byteLength > maximum
    )
      throw new Error("File size exceeds local import limit");
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error("Expected JSON object");
    return { value, raw };
  }
  $("retained-result-file").addEventListener("change", async () => {
    const file = $("retained-result-file").files?.[0];
    if (!file || destroyed || retainedBusy) return;
    const generation = ++retainedRead;
    retainedBusy = true;
    renderRetained();
    text("retained-results-status", "Validating saved investigation locally…");
    const presentation = retainedPresentation,
      navigation = navigationToken;
    try {
      const { raw } = await boundedJSON(file, 32 * 1024 * 1024);
      if (destroyed || generation !== retainedRead) return;
      // This dedicated transport preserves original numeric tokens, including -0.0.
      // The bounded text was parsed as one complete object above; only the generated
      // request ID is serialized here. Server validation remains authoritative.
      const response = await request("/api/investigations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"request_id":${JSON.stringify(win.crypto.randomUUID())},"bundle":${raw}}`,
      });
      if (!response.ok) throw new Error("Investigation import rejected");
      const job = retainInvestigation(await response.json());
      if (destroyed || generation !== retainedRead) return;
      if (!reportContext(job) || !job.result)
        throw new Error("Missing imported context");
      if (
        presentation !== retainedPresentation ||
        navigation !== navigationToken
      ) {
        text(
          "retained-results-status",
          "Investigation imported locally. Open it from Saved results when ready.",
        );
        return;
      }
      retainedSelection = job.id;
      reportSelection = `investigation:${job.id}`;
      closeRetained();
      syncReport();
      goStep("export");
      text(
        "retained-results-status",
        "Historical investigation imported locally. No Meta request was made.",
      );
    } catch {
      if (!destroyed && generation === retainedRead)
        text(
          "retained-results-status",
          "Import failed. Choose a validated investigation replay JSON up to 32 MiB. Existing work is unchanged; no Meta request was made.",
        );
    } finally {
      if (!destroyed && generation === retainedRead) {
        retainedBusy = false;
        $("retained-result-file").value = "";
        renderRetained();
      }
    }
  });
  function explanationMatches(job, investigation) {
    return (
      !!job &&
      !!investigation &&
      job.request?.investigation_id === investigation.id &&
      job.request.evidence_digest === investigation.evidence_digest
    );
  }
  function currentExplanationSource() {
    return reportSources().find((s) => s.value === reportSelection);
  }
  function stopExplanationPoll() {
    if (explanationTimer !== null) win.clearTimeout(explanationTimer);
    explanationTimer = null;
  }
  function resetFindings() {
    findings?.destroy();
    findings = null;
    findingsKey = null;
    $("findings-player").replaceChildren();
    $("detailed-report").open = true;
  }
  function syncExplanationSource(source, snapshot) {
    const job =
      source?.kind === "investigation" && snapshot ? source.job : null;
    const binding = job?.evidence_digest
      ? `${job.id}/${job.evidence_digest}`
      : null;
    if (binding === explanationBinding) return;
    stopExplanationPoll();
    explanationEpoch++;
    explanationBinding = binding;
    explanationReading = false;
    explanationSelected = explanationSelections.get(binding) || null;
    explanationMessage = "";
    $("explanation-consent").checked = false;
    resetFindings();
    if (binding)
      void Promise.resolve().then(() => {
        if (!destroyed && binding === explanationBinding) {
          if (!explanationConfigLoaded) {
            explanationConfigLoaded = true;
            const configEpoch = configurationEpoch;
            void investigationAPI("/api/explanations/config")
              .then((config) => {
                if (!destroyed && configEpoch === configurationEpoch) {
                  explanationConfig = config;
                  syncReport();
                }
              })
              .catch(() => {
                if (!destroyed && configEpoch === configurationEpoch) {
                  explanationConfig = null;
                  syncReport();
                }
              });
          }
          return refreshExplanations();
        }
      });
  }
  function retainExplanation(job, investigation) {
    if (
      !job?.id ||
      !["running", "completed", "failed", "interrupted"].includes(job.status) ||
      !explanationMatches(job, investigation)
    )
      throw new Error("Explanation source mismatch");
    const old = explanationJobs.get(job.id);
    if (old && old.status !== "running" && job.status === "running") return old;
    explanationJobs.set(job.id, job);
    if (explanationUnknown?.requestId === job.request.request_id)
      explanationUnknown = null;
    return job;
  }
  function scheduleExplanationPoll(job) {
    stopExplanationPoll();
    if (
      destroyed ||
      job?.status !== "running" ||
      !explanationMatches(job, currentExplanationSource()?.job)
    )
      return;
    const epoch = explanationEpoch;
    explanationTimer = win.setTimeout(async () => {
      explanationTimer = null;
      if (
        destroyed ||
        epoch !== explanationEpoch ||
        explanationReading ||
        explanationPosting
      )
        return;
      explanationReading = true;
      syncReport();
      try {
        const fresh = await investigationAPI(
          `/api/explanations/${encodeURIComponent(job.id)}`,
        );
        if (destroyed || epoch !== explanationEpoch) return;
        const accepted = retainExplanation(
          fresh,
          currentExplanationSource()?.job,
        );
        explanationMessage = "";
        scheduleExplanationPoll(accepted);
      } catch {
        if (!destroyed && epoch === explanationEpoch)
          explanationMessage =
            "Status polling stopped. The server explanation may still be running. Refresh explanation status to reconnect; no request will be resubmitted.";
      } finally {
        if (!destroyed && epoch === explanationEpoch) {
          explanationReading = false;
          syncReport();
        }
      }
    }, 1000);
    explanationTimer?.unref?.();
  }
  async function refreshExplanations() {
    const source = currentExplanationSource(),
      investigation = source?.job;
    if (
      destroyed ||
      !explanationBinding ||
      !investigation ||
      explanationReading ||
      explanationPosting
    )
      return;
    stopExplanationPoll();
    const epoch = explanationEpoch;
    explanationReading = true;
    syncReport();
    try {
      for (const active of [...explanationJobs.values()].filter(
        (j) =>
          j.status === "running" &&
          j.request.investigation_id !== investigation.id,
      )) {
        try {
          const current = await investigationAPI(
            `/api/explanations/${encodeURIComponent(active.id)}`,
          );
          if (destroyed || epoch !== explanationEpoch) return;
          retainExplanation(
            current,
            investigationJobs.get(active.request.investigation_id),
          );
        } catch (failure) {
          if (destroyed || epoch !== explanationEpoch) return;
          if (failure.httpStatus === 404) explanationJobs.delete(active.id);
          else throw failure;
        }
      }
      if (
        explanationUnknown &&
        explanationUnknown.investigationId !== investigation.id
      ) {
        const oldSource = investigationJobs.get(
          explanationUnknown.investigationId,
        );
        const previous = await investigationAPI(
          `/api/explanations?investigation_id=${encodeURIComponent(explanationUnknown.investigationId)}`,
        );
        if (destroyed || epoch !== explanationEpoch) return;
        if (!Array.isArray(previous.jobs))
          throw new Error("Invalid explanation list");
        previous.jobs.forEach((j) => retainExplanation(j, oldSource));
      }
      const data = await investigationAPI(
        `/api/explanations?investigation_id=${encodeURIComponent(investigation.id)}`,
      );
      if (destroyed || epoch !== explanationEpoch) return;
      if (!Array.isArray(data.jobs))
        throw new Error("Invalid explanation list");
      const jobs = data.jobs.map((j) => retainExplanation(j, investigation));
      const ids = new Set(jobs.map((j) => j.id));
      for (const [id, j] of explanationJobs)
        if (explanationMatches(j, investigation) && !ids.has(id))
          explanationJobs.delete(id);
      explanationSelected = ids.has(explanationSelected)
        ? explanationSelected
        : jobs.find((j) => j.status === "running")?.id ||
          jobs.find((j) => j.status === "completed")?.id ||
          jobs[0]?.id ||
          null;
      explanationSelections.set(explanationBinding, explanationSelected);
      explanationMessage = explanationUnknown
        ? "The start response was lost. Refresh to establish its outcome; no automatic retry or new explanation is allowed while the outcome is unknown."
        : "";
      scheduleExplanationPoll(explanationJobs.get(explanationSelected));
    } catch {
      if (!destroyed && epoch === explanationEpoch)
        explanationMessage =
          "Could not read explanation status. The detailed report remains available. Refresh to retry this local read; no Meta request is resubmitted.";
    } finally {
      if (!destroyed && epoch === explanationEpoch) {
        explanationReading = false;
        syncReport();
      }
    }
  }
  function explanationFailureMessage(job) {
    const categories = new Map([
      [
        "network_not_authorized",
        "Meta access was not approved for this explanation.",
      ],
      [
        "missing_or_invalid_credential",
        "Meta could not accept the server credentials.",
      ],
      ["authentication", "Meta could not accept the server credentials."],
      ["quota", "Meta's usage limit blocked this explanation."],
      ["server", "Meta could not complete the explanation request."],
      [
        "timeout",
        "Meta did not finish the explanation within the allowed time.",
      ],
      [
        "transport",
        "The connection to Meta failed before the explanation finished.",
      ],
      [
        "invalid_response",
        "Meta returned an explanation the app could not use.",
      ],
      ["invalid_plan", "Meta's visual explanation could not be validated."],
      [
        "source_changed",
        "The evidence changed before the explanation finished.",
      ],
    ]);
    const responses = new Map([
      [
        "incomplete_max_output_tokens",
        "Meta reached the response length limit before finishing the explanation.",
      ],
      ["incomplete_other", "Meta did not finish the explanation."],
      ["failed_response", "Meta could not finish the explanation."],
      ["cancelled_response", "Meta stopped before finishing the explanation."],
      ["nonterminal_response", "Meta did not return a finished explanation."],
      ["refusal", "Meta declined to create this explanation."],
      ["no_output", "Meta returned no explanation."],
    ]);
    const plans = new Map([
      ["tool_shape", "Meta did not return the required visual plan."],
      ["plan_shape", "Meta's visual plan had an unsupported structure."],
      ["scene_count", "Meta returned an unsupported number of scenes."],
      ["scene_order", "Meta's scenes did not follow the required order."],
      ["scene_fields", "Meta's visual plan had an unsupported structure."],
      ["scene_options", "Meta selected an unsupported visual option."],
      [
        "evidence_reference",
        "A selected finding could not be matched to the retained evidence.",
      ],
      [
        "wording_format",
        "Meta's captions did not meet the format or length limits.",
      ],
      ["wording_policy", "Meta's wording did not pass the explanation checks."],
      [
        "comparison_binding",
        "A selected comparison could not be matched to the retained evidence.",
      ],
      [
        "contrast_binding",
        "The selected settings contrast could not be validated.",
      ],
      ["focus_binding", "The selected waveform focus could not be validated."],
    ]);
    const detail =
      job.error?.category === "invalid_response" &&
      job.error?.http_status === 200
        ? responses.get(job.error?.response_code) ||
          categories.get("invalid_response")
        : job.error?.category === "invalid_plan" &&
            job.error?.http_status === null
          ? plans.get(job.error?.plan_code) || categories.get("invalid_plan")
          : categories.get(job.error?.category) || "";
    return `Explanation ${job.status === "interrupted" ? "interrupted" : "failed"}.${detail ? ` ${detail}` : ""} The analysis and detailed report remain available. A new request requires fresh consent.`;
  }
  function renderExplanation(source, snapshot) {
    const investigation = source?.kind === "investigation" ? source.job : null;
    $("findings-workspace").hidden = !investigation || !snapshot;
    if (!investigation || !snapshot) return;
    const jobs = [...explanationJobs.values()].filter((j) =>
      explanationMatches(j, investigation),
    );
    const job = jobs.find((j) => j.id === explanationSelected);
    const configured =
      explanationConfig?.available === true &&
      explanationConfig?.key_configured === true;
    const sourceUnavailable = unavailableInvestigations.has(investigation.id);
    const importedInvestigation =
      investigation.source?.kind === "imported_historical";
    const importedExplanation =
      job?.result?.provenance?.historical_import ||
      job?.result?.provenance?.kind === "imported_historical_explanation";
    const recordedMode =
      investigation.result?.identity?.execution_mode ||
      investigation.source?.historical_identity?.execution_mode;
    const modeLabel = (mode) =>
      mode === "mocked_test"
        ? "mocked test"
        : mode === "live"
          ? "recorded live execution"
          : "execution unverified";
    text(
      "explanation-config",
      configured
        ? "Server key configured; connection unverified. One explicit Meta request, no automatic retry."
        : "Meta explanation unavailable: configure the key privately with Set up Meta key. Importing saved plans and reading reports stay local.",
    );
    text(
      "explanation-source",
      `Selected: ${retainedName(investigation)} / ${investigation.request.channel} / [${investigation.request.start_s}, ${investigation.request.end_s}) s. Question: ${investigation.request.question || "None"}. Acquisition notes: ${investigation.request.notes || "None"}.`,
    );
    text(
      "explanation-provenance",
      `${importedInvestigation ? "Imported historical evidence" : "Investigation evidence"} (${modeLabel(recordedMode)}). ${job?.result ? `${importedExplanation ? "Imported " : ""}${job.result.identity?.execution_mode === "mocked_test" ? "mocked " : ""}Meta explanation; ` : ""}${sourceUnavailable ? "server copy unavailable; browser view only" : storageDescription(investigation.retention)}.`,
    );
    text(
      "explanation-provenance-detail",
      `${investigation.source?.kind === "imported_historical" ? "Imported historical investigation; original identity is an unverified claim." : "Investigation evidence."} ${job?.result ? `${job.result.provenance?.historical_import || job.result.provenance?.kind === "imported_historical_explanation" ? "Imported historical explanation. " : ""}This separate retrospective Meta explanation is unverified interpretation.` : "Create or import a separate explanation to animate the retained evidence."} Storage: ${sourceUnavailable ? "server copy unavailable; browser view only" : storageDescription(investigation.retention)}.`,
    );
    const busy = explanationPosting || explanationReading;
    const active = [...explanationJobs.values()].some(
      (j) => j.status === "running",
    );
    $("explain").disabled =
      credentialsChanging ||
      !explanationBinding ||
      sourceUnavailable ||
      !configured ||
      !$("explanation-consent").checked ||
      busy ||
      active ||
      !!explanationUnknown;
    $("explain").setAttribute("aria-busy", String(explanationPosting));
    $("explanation-consent").disabled =
      busy ||
      active ||
      !!explanationUnknown ||
      !explanationBinding ||
      sourceUnavailable;
    $("explanation-refresh").disabled = busy || !explanationBinding;
    $("explanation-file").disabled =
      busy || active || !explanationBinding || sourceUnavailable;
    $("explanation-history-label").hidden = !jobs.length;
    $("explanation-history").replaceChildren(
      ...jobs.map((j) =>
        option(
          j.id,
          `${j.status} / ${j.stage || "finished"}${j.result?.provenance?.historical_import || j.result?.provenance?.kind === "imported_historical_explanation" ? " / imported historical plan" : ""} / ${storageDescription(j.retention)}`,
        ),
      ),
    );
    if (job) $("explanation-history").value = job.id;
    $("explanation-history").disabled = busy;
    $("export-explanation").disabled = !job?.result || busy;
    const stages = {
      requesting_meta: "Requesting Meta explanation",
      validating_plan: "Validating the proposed scene plan",
      finished: "Finished",
    };
    const status =
      job?.status === "running"
        ? `${stages[job.stage] || "Running explanation"}. Leaving this view does not cancel the server job.`
        : job?.status === "failed" || job?.status === "interrupted"
          ? explanationFailureMessage(job)
          : job?.status === "completed"
            ? "Saved explanation loaded locally. Playback and video export make no Meta requests."
            : "No explanation selected. The detailed report is ready below.";
    text("explanation-status", explanationMessage || status);
    const nextKey =
      job?.status === "completed" && job.result
        ? `${explanationBinding}/${job.id}`
        : null;
    $("findings-title").hidden = !!nextKey;
    if (nextKey !== findingsKey) {
      resetFindings();
      findingsKey = nextKey;
      if (nextKey) {
        const boundKey = nextKey,
          boundInvestigation = investigation;
        findings = mountFindings($("findings-player"), {
          job: investigation,
          plan: job.result,
          snapshot,
          loadComparison: async (id, { signal } = {}) => {
            const response = await request(
              `/api/investigations/${encodeURIComponent(boundInvestigation.id)}/comparisons/${encodeURIComponent(id)}`,
              { signal },
            );
            if (!response.ok) throw new Error("Retained waveform unavailable");
            return response.json();
          },
          onEvidence(id) {
            if (!destroyed && findingsKey === boundKey) {
              $("detailed-report").open = true;
              reportVisuals.selectComparison(id);
            }
          },
          onState(state) {
            if (destroyed || findingsKey !== boundKey) return;
            $("detailed-report").open = state.status !== "ready";
            if (state.status === "ready") $("explanation-options").open = false;
          },
        });
      }
    }
  }
  $("explanation-consent").addEventListener("change", syncReport);
  $("explanation-refresh").addEventListener("click", refreshExplanations);
  $("explanation-history").addEventListener("change", () => {
    if (destroyed || explanationPosting || explanationReading) return;
    stopExplanationPoll();
    explanationSelected = $("explanation-history").value;
    explanationSelections.set(explanationBinding, explanationSelected);
    $("explanation-consent").checked = false;
    explanationMessage = "";
    syncReport();
    scheduleExplanationPoll(explanationJobs.get(explanationSelected));
  });
  $("explanation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const investigation = currentExplanationSource()?.job;
    if (
      destroyed ||
      !investigation ||
      $("explain").disabled ||
      explanationPosting ||
      explanationUnknown
    )
      return;
    const epoch = explanationEpoch,
      binding = explanationBinding;
    const payload = {
      request_id: win.crypto.randomUUID(),
      investigation_id: investigation.id,
      evidence_digest: investigation.evidence_digest,
      allow_network: true,
    };
    explanationPosting = true;
    explanationUnknown = {
      requestId: payload.request_id,
      investigationId: investigation.id,
    };
    $("explanation-consent").checked = false;
    explanationMessage =
      "Submitting the explicitly approved Meta explanation request…";
    syncReport();
    try {
      const job = retainExplanation(
        await investigationAPI("/api/explanations", payload),
        investigation,
      );
      if (destroyed || epoch !== explanationEpoch) return;
      explanationSelected = job.id;
      explanationSelections.set(binding, job.id);
      explanationMessage = "";
      scheduleExplanationPoll(job);
    } catch (failure) {
      // A lost/5xx response may still have admitted work: only a local read can reconcile it.
      if (failure.httpStatus >= 400 && failure.httpStatus < 500)
        explanationUnknown = null;
      if (!destroyed && epoch === explanationEpoch)
        explanationMessage = explanationUnknown
          ? "Start response unavailable. The server may still be running. Refresh explanation status; this request will not be resubmitted."
          : "The explanation request was rejected. Refresh status and review configuration before explicitly consenting to a new request. The report remains available.";
    } finally {
      explanationPosting = false;
      if (!destroyed) {
        syncReport();
        if (epoch !== explanationEpoch) void refreshExplanations();
      }
    }
  });
  $("explanation-file").addEventListener("change", async () => {
    const file = $("explanation-file").files?.[0],
      investigation = currentExplanationSource()?.job;
    if (
      !file ||
      destroyed ||
      !investigation ||
      explanationPosting ||
      explanationReading
    )
      return;
    const epoch = explanationEpoch;
    explanationPosting = true;
    $("explanation-consent").checked = false;
    explanationMessage = "Validating saved explanation locally…";
    syncReport();
    try {
      const { value: artifact } = await boundedJSON(file, 4 * 1024 * 1024);
      if (destroyed || epoch !== explanationEpoch) return;
      const job = retainExplanation(
        await investigationAPI("/api/explanations/import", {
          request_id: win.crypto.randomUUID(),
          investigation_id: investigation.id,
          artifact,
        }),
        investigation,
      );
      if (destroyed || epoch !== explanationEpoch) return;
      explanationSelected = job.id;
      explanationSelections.set(explanationBinding, job.id);
      explanationMessage =
        "Saved historical explanation imported locally; no Meta request was made.";
    } catch {
      if (!destroyed && epoch === explanationEpoch)
        explanationMessage =
          "Explanation import failed. Choose its separate explanation artifact (up to 4 MiB) matching this investigation. The detailed report remains available.";
    } finally {
      explanationPosting = false;
      if (!destroyed) {
        $("explanation-file").value = "";
        syncReport();
        if (epoch !== explanationEpoch) void refreshExplanations();
      }
    }
  });
  $("export-explanation").addEventListener("click", async () => {
    const job = explanationJobs.get(explanationSelected),
      epoch = explanationEpoch;
    if (destroyed || !job?.result || $("export-explanation").disabled) return;
    $("export-explanation").disabled = true;
    try {
      const response = await request(
        `/api/explanations/${encodeURIComponent(job.id)}/export`,
      );
      if (!response.ok) throw new Error("Export unavailable");
      const blob = await response.blob();
      if (
        destroyed ||
        epoch !== explanationEpoch ||
        explanationSelected !== job.id
      )
        return;
      downloadBlob(blob, "signaltrace-explanation.json");
      explanationMessage =
        "Explanation artifact download requested. Keep it alongside the separate investigation replay JSON.";
    } catch {
      if (!destroyed && epoch === explanationEpoch)
        explanationMessage =
          "Explanation download unavailable. Refresh saved explanation status; no Meta request was made.";
    } finally {
      if (!destroyed && epoch === explanationEpoch) syncReport();
    }
  });
  function investigationKey() {
    return view && experiment ? `${view.recording.id}/${experiment.id}` : null;
  }
  function stopInvestigationPoll() {
    if (investigationTimer !== null) win.clearTimeout(investigationTimer);
    investigationTimer = null;
    investigationRead++;
  }
  async function investigationAPI(path, body) {
    const response = await request(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok) {
      // Do not display arbitrary server/provider exception text.
      let unavailable = false;
      if (
        response.status === 422 &&
        path === "/api/investigations" &&
        body !== undefined
      ) {
        try {
          unavailable = (await response.json())?.detail === UNAVAILABLE_MESSAGE;
        } catch {
          /* malformed rejection stays generic */
        }
      }
      const failure = new Error(
        unavailable
          ? UNAVAILABLE_MESSAGE
          : response.status === 409
            ? "Another investigation is active or this request conflicts. Refresh status before trying again."
            : response.status === 404
              ? "This investigation or experiment is no longer retained on the server."
              : "The server could not start or read this investigation. Check server configuration and refresh status.",
      );
      failure.httpStatus = response.status;
      throw failure;
    }
    return response.json();
  }
  function retainInvestigation(job) {
    if (
      !job?.id ||
      !job.request ||
      !["running", "completed", "failed", "interrupted"].includes(job.status)
    )
      throw new Error(
        "The local server returned an unreadable investigation status.",
      );
    const previous = investigationJobs.get(job.id);
    if (previous && previous.status !== "running" && job.status === "running")
      return previous;
    investigationJobs.set(job.id, job);
    unavailableInvestigations.delete(job.id);
    if (job.status === "running") investigationActive = job.id;
    else if (investigationActive === job.id) investigationActive = null;
    if (investigationUnknown?.requestId === job.request.request_id)
      investigationUnknown = null;
    return job;
  }
  function investigationMatches(job) {
    return (
      !!job &&
      !!view &&
      !!experiment &&
      job?.request.recording_id === view?.recording.id &&
      job?.request.experiment_id === experiment?.id
    );
  }
  function investigationScope(job) {
    const r = job.request;
    return `${r.channel} / [${r.start_s}, ${r.end_s}) s / ${r.target === "waveform_sensitivity" ? "Waveform shape" : "Pulse timing"} / comparator: original samples (sensitivity, not accuracy)`;
  }
  function addInvestigationText(parent, tag, value) {
    const node = doc.createElement(tag);
    node.textContent = value;
    parent.append(node);
    return node;
  }
  function renderInvestigationEvidence(bundle) {
    const panel = $("investigation-evidence"),
      citations = $("investigation-citations");
    panel.replaceChildren();
    citations.replaceChildren();
    const cited = new Set(bundle?.conclusion?.evidence_ids || []);
    for (const [index, [id, item]] of Object.entries(
      bundle?.evidence || {},
    ).entries()) {
      const section = doc.createElement("section");
      const heading = addInvestigationText(
        section,
        "h4",
        `${id} · ${item.kind === "inspection" ? "Local inspection" : item.kind === "regional_summary" ? "Regional summary" : "Local comparison"}`,
      );
      heading.id = `investigation-evidence-${index}`;
      heading.tabIndex = -1;
      addInvestigationText(
        section,
        "p",
        `Exact interval: [${item.window?.start_s}, ${item.window?.end_s}) s. Original samples are the comparator.`,
      );
      if (item.kind === "inspection") {
        addInvestigationText(
          section,
          "p",
          `${count(item.finite_count)} / ${count(item.sample_count)} finite samples; ${count(item.missing_count)} missing samples; ${count(item.gap_count)} timestamp gaps; ${count(item.missing_interval_count)} missing intervals.`,
        );
        if (item.statistics) {
          const stats = addInvestigationText(
            section,
            "pre",
            JSON.stringify(item.statistics, null, 2),
          );
          stats.setAttribute("aria-label", "Exact local sample statistics");
        }
      } else if (item.kind === "regional_summary") {
        const parent = bundle.evidence?.[item.comparison_id];
        renderRegionalSummary(section, regionalSummarySnapshot(id, item), {
          parentHref:
            parent?.kind === "comparison"
              ? "#investigation-visuals"
              : undefined,
          onParent: (parentId) =>
            investigationVisuals.selectComparison(parentId),
        });
        if (parent?.kind !== "comparison")
          addInvestigationText(
            section,
            "p",
            "Parent comparison unavailable; no regional plot is substituted.",
          );
      } else {
        addInvestigationText(
          section,
          "p",
          `${formatExcludedPercent(item.excluded_fraction)} excluded; ${count(item.valid_count)} / ${count(item.sample_count)} valid samples. Missing: ${count(item.nonfinite_count)}; exact-flat: ${count(item.exact_flat_sample_count)}; gaps: ${count(item.gap_count)}; retained intervals: ${count(item.valid_interval_count)}.`,
        );
        const parameters = item.parameters || {};
        addInvestigationText(
          section,
          "p",
          `Exact recipe: median window ${parameters.median_window_s} s; high-pass ${parameters.highpass_hz} Hz; boundary guard ${parameters.edge_guard_s} s.`,
        );
        for (const [method, label] of [
          ["unchanged", "Unchanged"],
          ["median", "Median subtraction"],
          ["highpass", "High-pass"],
        ]) {
          const m = item.metrics?.[method];
          if (!m) continue;
          addInvestigationText(section, "h5", label);
          addInvestigationText(
            section,
            "p",
            `Timing shift: ${formatMeasurement(m.mean_absolute_shift_ms, "mean_absolute_shift_ms")} ms mean; ${formatMeasurement(m.maximum_absolute_shift_ms, "maximum_absolute_shift_ms")} ms maximum. Normalized waveform difference: ${formatMeasurement(m.centered_normalized_rmse, "centered_normalized_rmse")}. Matched candidates: ${count(m.matched_count)}. Unmatched original: ${count(m.unmatched_comparator_count)}; unmatched method: ${count(m.unmatched_candidate_count)}. Original candidates: ${count(m.comparator_count)}; method candidates: ${count(m.candidate_count)}.`,
          );
        }
      }
      panel.append(section);
      if (cited.has(id)) {
        const link = addInvestigationText(
          citations,
          "a",
          `View ${id} ${item.kind === "inspection" ? "inspection" : item.kind === "regional_summary" ? "regional summary" : "comparison"} measurements`,
        );
        link.href = `#${heading.id}`;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          if (!destroyed && section.isConnected) {
            $("investigation-evidence-details").open = true;
            focusNode(heading);
            heading.scrollIntoView?.({ block: "nearest" });
          }
        });
      }
    }
  }
  function investigationEvidenceNavigation(job) {
    const evidenceIds = Object.keys(job.result.evidence || {});
    return {
      evidenceHref: (id) =>
        `#investigation-evidence-${evidenceIds.indexOf(id)}`,
      onEvidence: (id) => {
        if (destroyed || !investigationMatches(job)) return;
        const heading = $(`investigation-evidence-${evidenceIds.indexOf(id)}`);
        if (!heading) return;
        $("investigation-evidence-details").open = true;
        focusNode(heading);
        heading.scrollIntoView?.({ block: "nearest" });
      },
    };
  }
  function readRequirements() {
    return parseRequirements({
      enabled: $("requirements-enabled").checked,
      confirmed: $("requirements-confirmed").checked,
      method: $("requirements-method").value,
      criteria: Object.fromEntries(
        Object.keys(REQUIREMENT_FIELDS).map((key) => [
          key,
          $("requirement-" + key).value,
        ]),
      ),
    });
  }
  function renderInvestigation() {
    if (destroyed) return;
    const selected = investigationJobs.get(investigationSelected);
    const job = investigationMatches(selected) ? selected : null;
    $("investigation-result").hidden = !job;
    let visualSnapshot = null;
    try {
      if (job?.result && job.status !== "running")
        visualSnapshot = makeInvestigationReport({
          recording: view.recording,
          experiment,
          job,
        });
    } catch {
      /* Exact binding required. */
    }
    investigationVisuals.update(visualSnapshot);
    renderRequirementDecision($("investigation-requirements"), visualSnapshot, {
      evidenceHref: () => "#investigation-visuals",
      onEvidence: (id) => {
        if (
          !job ||
          !investigationMatches(job) ||
          investigationSelected !== job.id
        )
          return;
        investigationVisuals.selectComparison(
          id,
          visualSnapshot?.requirements?.method,
        );
        $("investigation-visuals").scrollIntoView?.({ block: "nearest" });
      },
    });
    if (
      visualSnapshot &&
      investigationAttached?.evidence_id === visualSnapshot.evidence_id &&
      investigationAttached.source_id === visualSnapshot.source_id
    )
      visualSnapshot = investigationAttached;
    const story = $("investigation-story");
    story.replaceChildren();
    story.hidden = !visualSnapshot;
    if (visualSnapshot) {
      const evidenceNavigation = investigationEvidenceNavigation(job);
      renderInvestigationStory(story, visualSnapshot, evidenceNavigation);
      renderInvestigationFinding($("investigation-finding"), visualSnapshot, {
        ...evidenceNavigation,
        interactive: true,
      });
    } else {
      $("investigation-finding").replaceChildren();
    }
    $("investigation-status").textContent =
      investigationMessage ||
      (job?.status === "running"
        ? `Running: ${job.progress?.rounds || 0} / 6 rounds started; ${job.progress?.tool_attempts || 0} / 8 tool attempts. No completion percentage is estimated.`
        : investigationActive || investigationPosting || investigationUnknown
          ? "An investigation may still be running for an earlier scope. Refresh status to reconnect; switching recordings does not cancel it."
          : "No investigation is running. Each run requires explicit consent.");
    text("investigation-error", investigationFailure);
    $("investigation-error").hidden = !investigationFailure;
    const jobs = [...investigationJobs.values()].filter(investigationMatches);
    $("investigation-history-label").hidden = jobs.length === 0;
    $("investigation-history").replaceChildren(
      ...jobs.map((item) =>
        option(
          item.id,
          `${item.status} / ${item.request.channel} / [${item.request.start_s}, ${item.request.end_s}) s`,
        ),
      ),
    );
    if (job) $("investigation-history").value = job.id;
    const traceEvents = job?.result?.trace || job?.progress?.trace || [];
    const progressSurface = $("investigation-activity-summary");
    if (progressSurface) {
      const last = traceEvents.at(-1);
      progressSurface.textContent = last
        ? `${traceEvents.length} recorded events / Latest: round ${last.round ?? "unavailable"}, ${last.tool || "model round"} / ${last.status || "started"}${last.evidence_id ? ` / ${last.evidence_id}` : ""}. ${job.status === "running" ? "Waiting for the next reported event." : "Retained activity for this run."}`
        : job?.status === "running"
          ? "Request admitted. Waiting for the first reported event."
          : "No recorded events for the selected run.";
    }
    $("investigation-trace").replaceChildren(
      ...(job?.result?.trace || job?.progress?.trace || []).map((event) => {
        const li = doc.createElement("li");
        li.textContent = `Round ${event.round ?? "—"}: ${event.tool || "model round"} / ${event.status || "started"}${event.evidence_id ? ` / ${event.evidence_id}` : ""}`;
        return li;
      }),
    );
    if (!job) return;
    const bundle = job.result;
    const conclusion = bundle?.conclusion;
    const failureGuidance = {
      network_not_authorized:
        "Start a new run only after explicitly allowing Meta requests.",
      missing_or_invalid_credential:
        "Configure the key privately in the server process and restart the server; never paste it into this page.",
      authentication:
        "Check the server credential privately before explicitly starting a new run.",
      quota:
        "Check Meta quota or credits privately before explicitly starting a new run.",
      timeout:
        "The bounded provider operation timed out. Review or export any partial evidence before choosing whether to start a new run.",
      transport:
        "The provider connection failed. Check connectivity before explicitly starting a new run.",
      server:
        "Meta returned a server failure. Review partial evidence; a later run requires new consent.",
      invalid_response:
        "The response did not meet the validated tool contract. Review partial evidence; no model conclusion was accepted.",
      round_budget_exhausted:
        "The six-round budget ended without an accepted conclusion. Review partial evidence or refine the question before a new run.",
      tool_budget_exhausted:
        "The eight-tool budget ended. Review partial evidence or narrow the interval before a new run.",
      redirect_rejected:
        "A provider redirect was rejected. Check server configuration before a new run.",
      request_rejected:
        "Meta rejected the request. Check server configuration before a new run.",
      response_too_large:
        "The response exceeded the bounded size limit. Review partial evidence before a new run.",
      provider_failure:
        "The investigation stopped safely. Review available evidence and server configuration before a new run.",
      invalid_call_id:
        "The tool response could not be validated. Review partial evidence before a new run.",
      mixed_finish_calls:
        "The model did not finish using the validated tool contract. Review partial evidence before a new run.",
      invalid_history_mode:
        "Check the server investigation configuration before a new run.",
      invalid_continuation:
        "The provider continuation was rejected. Review partial evidence before a new run.",
      request_too_large:
        "The bounded request limit was reached. Narrow the question or interval before a new run.",
      history_too_large:
        "The bounded conversation limit was reached. Review partial evidence before a new run.",
      invalid_request_timeout:
        "Check the server timeout configuration before a new run.",
    };
    const failure = bundle?.error || job.error;
    const category = Object.hasOwn(failureGuidance, failure?.category)
      ? failure.category
      : "provider_failure";
    const responseCodes = new Set([
      "invalid_encoding",
      "invalid_json",
      "invalid_envelope",
      "invalid_response_id",
      "incomplete_max_output_tokens",
      "incomplete_other",
      "failed_response",
      "cancelled_response",
      "nonterminal_response",
      "unknown_status",
      "model_mismatch",
      "invalid_output_shape",
      "unsupported_output_item",
      "invalid_call_id",
      "invalid_call_name",
      "malformed_arguments",
      "missing_encrypted_reasoning",
      "invalid_message_shape",
      "unsupported_message_phase",
      "refusal",
      "no_output",
    ]);
    const responseCode = responseCodes.has(failure?.response_code)
      ? ` / ${failure.response_code}`
      : "";
    const httpStatus =
      Number.isInteger(failure?.http_status) &&
      failure.http_status >= 100 &&
      failure.http_status <= 599
        ? ` / HTTP ${failure.http_status}`
        : "";
    $("investigation-failure-detail").hidden = job.status !== "failed";
    text(
      "investigation-failure-detail",
      job.status === "failed"
        ? `Failure: ${category}${httpStatus}${responseCode}. ${failureGuidance[category]} No request is retried automatically.`
        : "",
    );
    text(
      "investigation-result-title",
      job.status === "running"
        ? "Investigation in progress"
        : job.status === "failed"
          ? Object.keys(bundle?.evidence || job.progress?.evidence || {}).length
            ? "Investigation failed · partial evidence"
            : "Investigation failed · no retained evidence"
          : {
              candidate: "Candidate for review",
              needs_information: "More information needed",
              inconclusive: "Inconclusive",
            }[conclusion?.status] || "Investigation complete",
    );
    text("investigation-scope", investigationScope(job));
    text(
      "investigation-question-used",
      `Question used: ${job.request.question}`,
    );
    const historical =
      job.request.channel !== $("channel").value ||
      job.request.start_s !== Number($("window-start").value) ||
      job.request.end_s !== Number($("window-end").value) ||
      protocolDirty;
    $("investigation-historical").hidden = !historical;
    text(
      "investigation-historical",
      "Historical scope: current channel, interval or protocol inputs differ. These findings apply only to the exact investigated scope above.",
    );
    text(
      "investigation-narrative",
      job.status === "completed" ? conclusion?.narrative || "" : "",
    );
    $("investigation-proposal-note").hidden = job.status !== "completed";
    $("investigation-questions").replaceChildren(
      ...(job.status === "completed" ? conclusion?.questions || [] : []).map(
        (question) => {
          const li = doc.createElement("li");
          li.textContent = question;
          return li;
        },
      ),
    );
    if (conclusion?.candidate && job.status === "completed") {
      const candidate = conclusion.candidate;
      const names = {
        unchanged: "Unchanged",
        median: "Median subtraction",
        highpass: "High-pass",
      };
      text(
        "investigation-result-title",
        `Candidate for review: ${names[candidate.method] || candidate.method} (${candidate.comparison_id})`,
      );
    }
    renderInvestigationEvidence(
      job.status === "failed"
        ? { evidence: bundle?.evidence || job.progress?.evidence }
        : bundle || { evidence: job.progress?.evidence },
    );
    $("investigation-limitations").replaceChildren(
      ...(bundle?.limitations || []).map((value) => {
        const li = doc.createElement("li");
        li.textContent = value;
        return li;
      }),
    );
    $("export-investigation").hidden = !bundle;
    $("export-investigation").disabled = investigationExporting;
  }
  function syncInvestigation() {
    if (destroyed) return;
    const key = investigationKey();
    if (key !== investigationBinding) {
      stopInvestigationPoll();
      investigationEpoch++;
      investigationBinding = key;
      investigationRefreshing = false;
      investigationSelected = investigationSelections.get(key) || null;
      investigationMessage = "";
      investigationFailure = "";
      $("investigation-consent").checked = false;
      $("requirements-confirmed").checked = false;
      $("investigation-export-status").textContent = "";
      $("investigation-question").value =
        experiment?.protocol.research_question?.slice(0, 500) ||
        defaultQuestion(experiment?.protocol.target);
      $("investigation-notes").value =
        experiment?.protocol.notes?.slice(0, 1000) || "";
      if (key) void refreshInvestigations();
    }
    const ready =
      !!experiment &&
      view?.recording.modality === "ppg" &&
      !protocolDirty &&
      !opening &&
      !importing &&
      !saving;
    if (opening || importing) {
      stopInvestigationPoll();
      investigationRefreshing = false;
    }
    $("investigation-panel").hidden =
      !experiment || view?.recording.modality !== "ppg";
    if (investigationPosting || investigationActive || investigationUnknown)
      $("investigation-consent").checked = false;
    const requirementInput = readRequirements();
    $("requirements-fields").hidden = !$("requirements-enabled").checked;
    $("requirements-status").textContent =
      requirementInput.error ||
      ($("requirements-enabled").checked
        ? "Confirmed limits will be checked against retained measurements."
        : "Exploratory investigation: no requirement verdict is requested.");
    for (const input of $("requirements-form").querySelectorAll(
      "input, select",
    ))
      input.disabled =
        !ready ||
        investigationPosting ||
        !!investigationActive ||
        !!investigationUnknown ||
        (input.id !== "requirements-enabled" &&
          !$("requirements-enabled").checked);
    $("investigate").disabled =
      credentialsChanging ||
      !ready ||
      investigationConfig?.available !== true ||
      investigationConfig?.key_configured !== true ||
      !$("investigation-consent").checked ||
      !!requirementInput.error ||
      investigationPosting ||
      investigationRefreshing ||
      !!investigationActive ||
      !!investigationUnknown;
    $("investigate").setAttribute("aria-busy", String(investigationPosting));
    $("investigation-refresh").disabled =
      !ready || investigationRefreshing || investigationPosting;
    $("investigation-refresh").setAttribute(
      "aria-busy",
      String(investigationRefreshing),
    );
    $("investigation-history").disabled =
      investigationRefreshing || investigationPosting || opening || importing;
    for (const id of ["investigation-question", "investigation-notes"])
      $(id).disabled = !ready || investigationPosting;
    $("investigation-consent").disabled =
      !ready ||
      investigationPosting ||
      !!investigationActive ||
      !!investigationUnknown;
    text(
      "investigation-current-scope",
      ready
        ? `Current scope: ${$("channel").value} / [${$("window-start").value}, ${$("window-end").value}) s / ${experiment.protocol.target === "waveform_sensitivity" ? "Waveform shape" : "Pulse timing"}.`
        : "Save a clean PPG protocol before investigating.",
    );
    renderInvestigation();
    syncReport();
    guide?.refresh();
  }
  function scheduleInvestigationPoll(job) {
    if (destroyed || job?.status !== "running" || !investigationMatches(job))
      return;
    if (investigationTimer !== null) win.clearTimeout(investigationTimer);
    const epoch = investigationEpoch,
      id = job.id;
    investigationTimer = win.setTimeout(async () => {
      investigationTimer = null;
      const read = ++investigationRead;
      try {
        const data = await investigationAPI(
          `/api/investigations/${encodeURIComponent(id)}`,
        );
        if (
          destroyed ||
          epoch !== investigationEpoch ||
          read !== investigationRead
        )
          return;
        const retained = retainInvestigation(data);
        investigationMessage = "";
        investigationFailure = "";
        syncInvestigation();
        scheduleInvestigationPoll(retained);
      } catch {
        if (
          destroyed ||
          epoch !== investigationEpoch ||
          read !== investigationRead
        )
          return;
        investigationFailure =
          "Status polling stopped. The server job may still be running. Select Refresh investigation status to reconnect; no request will be resubmitted.";
        syncInvestigation();
      }
    }, 1000);
    investigationTimer?.unref?.();
  }
  async function refreshInvestigations() {
    if (
      destroyed ||
      !experiment ||
      !view ||
      investigationPosting ||
      opening ||
      importing
    )
      return;
    stopInvestigationPoll();
    const epoch = investigationEpoch,
      key = investigationKey(),
      id = experiment.id,
      read = ++investigationRead;
    investigationRefreshing = true;
    investigationMessage = "";
    syncInvestigation();
    try {
      if (investigationUnknown && investigationUnknown.experimentId !== id) {
        const previous = await investigationAPI(
          `/api/investigations?experiment_id=${encodeURIComponent(investigationUnknown.experimentId)}`,
        );
        if (
          destroyed ||
          epoch !== investigationEpoch ||
          read !== investigationRead
        )
          return;
        if (!Array.isArray(previous.jobs)) throw new Error("Invalid job list");
        previous.jobs.forEach(retainInvestigation);
      }
      if (investigationActive) {
        const activeId = investigationActive;
        try {
          const active = await investigationAPI(
            `/api/investigations/${encodeURIComponent(activeId)}`,
          );
          if (
            destroyed ||
            epoch !== investigationEpoch ||
            read !== investigationRead
          )
            return;
          retainInvestigation(active);
        } catch (failure) {
          if (
            destroyed ||
            epoch !== investigationEpoch ||
            read !== investigationRead
          )
            return;
          if (failure.httpStatus !== 404) throw failure;
          investigationJobs.delete(activeId);
          investigationActive = null;
          if (investigationSelected === activeId) investigationSelected = null;
          investigationMessage =
            "The previous job is no longer retained, possibly after a server restart. Its outcome cannot be recovered here. Reopen a retained experiment and explicitly consent before starting a new investigation.";
        }
      }
      const data = await investigationAPI(
        `/api/investigations?experiment_id=${encodeURIComponent(id)}`,
      );
      if (
        destroyed ||
        epoch !== investigationEpoch ||
        read !== investigationRead ||
        key !== investigationKey()
      )
        return;
      if (!Array.isArray(data.jobs)) throw new Error("Invalid job list");
      const retained = data.jobs
        .map(retainInvestigation)
        .filter(investigationMatches);
      const ids = new Set(retained.map((job) => job.id));
      for (const [jobId, job] of investigationJobs)
        if (
          investigationMatches(job) &&
          !ids.has(jobId) &&
          job.status !== "running"
        )
          investigationJobs.delete(jobId);
      if (!ids.has(investigationSelected))
        investigationSelected = retained[0]?.id || null;
      investigationSelections.set(key, investigationSelected);
      investigationFailure = "";
      if (investigationUnknown)
        investigationMessage =
          "The start response was lost and its job is not yet listed. Refresh again to establish the outcome. No automatic retry will be made.";
      scheduleInvestigationPoll(investigationJobs.get(investigationSelected));
    } catch {
      if (
        destroyed ||
        epoch !== investigationEpoch ||
        read !== investigationRead
      )
        return;
      investigationFailure =
        "Could not refresh investigations. Retained local work is unchanged. Refresh investigation status to try reading again.";
    } finally {
      if (
        !destroyed &&
        epoch === investigationEpoch &&
        read === investigationRead
      ) {
        investigationRefreshing = false;
        syncInvestigation();
      }
    }
  }
  $("investigation-refresh").addEventListener("click", refreshInvestigations);
  $("investigation-history").addEventListener("change", () => {
    if (
      destroyed ||
      investigationRefreshing ||
      investigationPosting ||
      opening ||
      importing
    )
      return;
    stopInvestigationPoll();
    investigationSelected = $("investigation-history").value;
    investigationSelections.set(investigationKey(), investigationSelected);
    investigationMessage = "";
    investigationFailure = "";
    text("investigation-export-status", "");
    syncInvestigation();
    scheduleInvestigationPoll(investigationJobs.get(investigationSelected));
  });
  $("investigation-consent").addEventListener("change", syncInvestigation);
  for (const input of $("requirements-form").querySelectorAll("input, select"))
    input.addEventListener(input.type === "number" ? "input" : "change", () => {
      $("investigation-consent").checked = false;
      if (input.id !== "requirements-confirmed")
        $("requirements-confirmed").checked = false;
      syncInvestigation();
    });
  for (const id of ["investigation-question", "investigation-notes"])
    $(id).addEventListener("input", () => {
      $("investigation-consent").checked = false;
      $("requirements-confirmed").checked = false;
      syncInvestigation();
    });
  for (const id of ["channel", "window-start", "window-end"])
    $(id).addEventListener(id === "channel" ? "change" : "input", () => {
      $("investigation-consent").checked = false;
      $("requirements-confirmed").checked = false;
      syncInvestigation();
    });
  $("investigation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      destroyed ||
      $("investigate").disabled ||
      !$("investigation-consent").checked
    )
      return;
    const question = $("investigation-question").value.trim(),
      notes = $("investigation-notes").value;
    const requirementInput = readRequirements();
    if (requirementInput.error) {
      investigationFailure = requirementInput.error;
      syncInvestigation();
      return;
    }
    const start = Number($("window-start").value),
      end = Number($("window-end").value);
    const selected = view.plot.times.filter(
      (t) => t >= start && t < end,
    ).length;
    if (
      !question ||
      question.length > 500 ||
      notes.length > 1000 ||
      !$("window-start").value ||
      !$("window-end").value ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < view.recording.start_s ||
      end > recordingEnd() ||
      start >= end ||
      selected < 3 ||
      selected > 30000
    ) {
      investigationFailure =
        "Enter a question (up to 500 characters), notes (up to 1,000) and a valid interval containing 3–30,000 samples.";
      syncInvestigation();
      return;
    }
    const requestId = win.crypto.randomUUID();
    const payload = {
      request_id: requestId,
      experiment_id: experiment.id,
      recording_id: view.recording.id,
      channel: $("channel").value,
      start_s: start,
      end_s: end,
      question,
      notes,
      allow_network: true,
      ...(requirementInput.requirements
        ? { requirements: requirementInput.requirements }
        : {}),
    };
    const epoch = investigationEpoch;
    investigationPosting = true;
    investigationUnknown = { requestId, experimentId: experiment.id };
    investigationMessage = "Starting an explicitly consented investigation…";
    investigationFailure = "";
    $("investigation-consent").checked = false;
    syncInvestigation();
    try {
      const data = await investigationAPI("/api/investigations", payload);
      if (destroyed) return;
      if (
        Object.entries(payload).some(
          ([key, value]) =>
            key !== "allow_network" &&
            (key === "requirements"
              ? data.request?.requirements?.confirmed !== true ||
                data.request?.requirements?.method !== value.method ||
                Object.keys(data.request?.requirements?.criteria || {})
                  .length !== Object.keys(value.criteria).length ||
                Object.entries(value.criteria).some(
                  ([metric, limit]) =>
                    data.request?.requirements?.criteria?.[metric] !== limit,
                )
              : data.request?.[key] !== value),
        )
      )
        throw new Error(
          "The start response did not match the submitted scope.",
        );
      const job = retainInvestigation(data);
      if (epoch !== investigationEpoch || !investigationMatches(job)) return;
      investigationSelected = job.id;
      investigationSelections.set(investigationKey(), job.id);
      investigationMessage = "";
      scheduleInvestigationPoll(job);
    } catch (failure) {
      if (destroyed) return;
      // A definite HTTP rejection is safe to correct; transport loss is ambiguous.
      if (failure.httpStatus) investigationUnknown = null;
      if (epoch === investigationEpoch) {
        investigationMessage = "";
        investigationFailure = failure.httpStatus
          ? failure.message
          : "The start response was lost. Refresh investigation status to find the job. No automatic submission retry will occur.";
      }
    } finally {
      if (!destroyed) {
        investigationPosting = false;
        syncInvestigation();
        if (epoch !== investigationEpoch && investigationKey())
          void refreshInvestigations();
      }
    }
  });
  $("export-investigation").addEventListener("click", async () => {
    const job = investigationJobs.get(investigationSelected);
    if (
      destroyed ||
      investigationExporting ||
      !investigationMatches(job) ||
      !job.result
    )
      return;
    const epoch = investigationEpoch,
      id = job.id;
    investigationExporting = true;
    renderInvestigation();
    text(
      "investigation-export-status",
      "Preparing exact investigation bundle…",
    );
    try {
      const response = await request(
        `/api/investigations/${encodeURIComponent(id)}/export`,
      );
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      if (
        destroyed ||
        epoch !== investigationEpoch ||
        id !== investigationSelected
      )
        return;
      const url = URL.createObjectURL(blob),
        link = doc.createElement("a");
      link.href = url;
      link.download = "signaltrace-investigation.json";
      doc.body.append(link);
      link.click();
      link.remove();
      win.setTimeout(() => URL.revokeObjectURL(url), 1000);
      text(
        "investigation-export-status",
        "Investigation download requested. Contains exact local recipes and samples for offline numerical replay; model proposals remain unverified.",
      );
    } catch {
      if (
        !destroyed &&
        epoch === investigationEpoch &&
        id === investigationSelected
      )
        text(
          "investigation-export-status",
          "Could not download the investigation. Try this download again while the job remains retained.",
        );
    } finally {
      if (!destroyed) {
        investigationExporting = false;
        renderInvestigation();
      }
    }
  });
  let displayedWindow = null;
  let customWindow = null,
    gesture = null,
    issuePage = 0,
    issueKey = null;
  const recordingCache = new WeakMap();
  let step = "open",
    navigationToken = 0;
  const steps = ["open", "inspect", "compare", "export"];
  const displayStates = {};
  function allowed(target) {
    if (target === "export" && retainedSelection && reportSources().length)
      return true;
    if (target !== "open" && (opening || importing)) return false;
    return (
      target === "open" ||
      (target === "inspect" && !!view) ||
      (target === "compare" &&
        view?.recording.modality === "ppg" &&
        !!experiment &&
        !protocolDirty) ||
      (target === "export" &&
        ((!protocolDirty && !!experiment && runs.length > 0) ||
          reportSources().length > 0))
    );
  }
  function goStep(target, focus = true) {
    if (destroyed || !allowed(target)) return;
    cancelGesture();
    if (step === "inspect" || step === "compare")
      displayStates[step] = {
        start: $("zoom-start").value,
        span: $("zoom-span").value,
        custom: customWindow && { ...customWindow },
      };
    step = target;
    if (step === "export") status("");
    if (step !== "export") findings?.pause();
    navigationToken++;
    for (const key of steps) {
      $("step-" + key).hidden = key !== step;
      if (key === step)
        $("step-nav-" + key).setAttribute("aria-current", "step");
      else $("step-nav-" + key).removeAttribute("aria-current");
    }
    if (step === "inspect" || step === "compare") {
      $(step + "-waveform").append($("waveform-panel"));
      $(step === "compare" ? "compare-channel" : "inspect-channel").prepend(
        $("channel-control"),
      );
      const saved = displayStates[step];
      $("zoom-start").value =
        saved?.start ??
        (step === "compare" && result
          ? result.window.start_s
          : view.recording.start_s);
      $("zoom-span").value = saved?.span ?? "10";
      customWindow = saved?.custom ?? null;
      renderPlot();
    }
    sync();
    if (step === "export") reportVisuals.refresh();
    if (step === "compare") investigationVisuals.refresh();
    if (focus) focusNode($(step + "-title"));
  }
  function setPanel(id, open) {
    $(id).hidden = !open;
    const button = $(id + "-toggle");
    button.setAttribute("aria-expanded", String(open));
    button.textContent = `${open ? "Hide" : "Show"} ${button.dataset.label}`;
  }
  for (const id of [
    "protocol-details",
    "parameters",
    "inspection-details",
    "technical-details",
    "developer-details",
    "waveform-guide",
    "manual-comparison",
    "export-technical",
    "requirements-options",
  ])
    $(id + "-toggle").addEventListener("click", () =>
      setPanel(id, $(id).hidden),
    );
  for (const key of steps)
    $("step-nav-" + key).addEventListener("click", () => goStep(key));
  for (const [id, key] of [
    ["continue-inspect", "inspect"],
    ["continue-compare", "compare"],
    ["back-open", "open"],
    ["back-inspect", "inspect"],
    ["back-compare", "compare"],
  ])
    $(id).addEventListener("click", () => goStep(key));
  const text = (id, value) => {
    $(id).textContent = value;
  };
  const status = (value) => {
    text("status", value);
    $("status").hidden = !value;
  };
  function showOpening(next, focus = false) {
    if (next !== openingView) navigationToken++;
    openingView = next;
    sync();
    if (focus && step === "open") focusNode($("open-title"));
  }
  $("sample-chooser-toggle").addEventListener("click", () => {
    sampleChooserOpen = !sampleChooserOpen;
    sync();
    focusNode($(sampleChooserOpen ? "demo-select" : "sample-chooser-toggle"));
  });
  $("change-recording").addEventListener("click", () => {
    if (opening || importing || openingView === "mapping") cancelLoad();
    cancelPreview();
    error("");
    status("");
    showOpening("choice", true);
  });
  $("return-recording").addEventListener("click", () => {
    if (opening || importing) cancelLoad();
    cancelPreview();
    error("");
    status("");
    showOpening("setup", true);
  });
  const error = (value) => {
    text("error", value || "");
    $("error").hidden = !value;
  };
  function formatError(detail) {
    if (Array.isArray(detail))
      return detail
        .map(
          (e) =>
            `${(e.loc || []).filter((x) => x !== "body").join(" · ")}: ${e.msg || "Invalid value"}`,
        )
        .join("\n");
    return typeof detail === "string"
      ? detail
      : "The local server could not complete this request.";
  }
  async function api(path, body) {
    return pendingWork(async () => {
      const response = await request(
        path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(
          `Local server returned an unreadable response (${response.status}).`,
        );
      }
      if (!response.ok) {
        const failure = new Error(formatError(data.detail));
        failure.fields = Array.isArray(data.detail)
          ? data.detail.flatMap((entry) => entry.loc || [])
          : [];
        throw failure;
      }
      return data;
    }, path);
  }
  function syncWorkspaceContext(snapshot = reportSnapshot) {
    if (step === "export") {
      text(
        "experiment-context",
        snapshot
          ? `${snapshot.experiment_name || "Selected result"} / ${snapshot.target === "waveform_sensitivity" ? "Waveform shape" : "Pulse timing"}`
          : "",
      );
      $("experiment-context").hidden = true;
      text(
        "journey-context",
        snapshot
          ? `${snapshot.source_name || snapshot.source_id} / Question: ${snapshot.question || "No recorded research question"} / Evidence interval: ${snapshot.channel} [${snapshot.window.start_s}, ${snapshot.window.end_s}) s`
          : "",
      );
      $("journey-context").hidden = !snapshot;
      return;
    }
    text(
      "experiment-context",
      experiment
        ? `${experiment.protocol.name} / ${experiment.protocol.target === "waveform_sensitivity" ? "Waveform shape" : "Pulse timing"}${protocolDirty ? " / unsaved changes" : ""}`
        : "",
    );
    $("experiment-context").hidden = !experiment;
    text(
      "journey-context",
      view
        ? `${view.recording.name}${experiment ? ` / Question: ${experiment.protocol.research_question || "How do preprocessing choices change the signal for this target?"}` : ""}${experiment ? ` / Selected interval: ${$("channel").value} [${$("window-start").value}, ${$("window-end").value}) s` : ""}`
        : "",
    );
    $("journey-context").hidden = !view;
  }
  function sync() {
    $("main-content").dataset.stage = step;
    $("step-open").dataset.view = openingView;
    $("source-picker").hidden = openingView !== "choice";
    $("import-form").hidden = !pendingCSV;
    $("import-panel").hidden = openingView !== "mapping";
    $("protocol-form").hidden =
      openingView !== "setup" || view?.recording.modality !== "ppg";
    $("change-recording").hidden = openingView === "choice";
    $("return-recording").hidden = openingView !== "choice" || !view;
    $("opening-lead").hidden = openingView !== "choice";
    $("open-title").textContent =
      openingView === "mapping"
        ? "Map your CSV"
        : openingView === "setup"
          ? view?.recording.modality === "ppg"
            ? "Set up experiment"
            : "Inspect recording"
          : "Open a recording";
    $("inspection-entry").hidden =
      openingView !== "setup" || !view || view.recording.modality === "ppg";
    text("inspection-entry-name", view?.recording.name || "");
    text(
      "inspection-entry-note",
      view && view.recording.modality !== "ppg"
        ? `${view.recording.modality.toUpperCase()} / inspection only. Modality-specific analysis is not available.`
        : "",
    );
    text(
      "continue-inspect",
      view?.recording.modality === "ppg"
        ? "Continue to Inspect"
        : "Continue to Inspect",
    );
    $("sample-chooser").hidden = !sampleChooserOpen;
    $("sample-chooser-toggle").setAttribute(
      "aria-expanded",
      String(sampleChooserOpen),
    );
    $("sample-chooser-toggle").textContent = sampleChooserOpen
      ? "Hide sample choices"
      : "Choose sample";
    $("session-resume").hidden = sessionCount === 0;
    syncLibrary();
    for (const [key, value] of Object.entries({
      recordingId: view?.recording.id,
      experimentId: experiment?.id,
      resultId: result?.id,
    })) {
      if (value) $("main-content").dataset[key] = value;
      else delete $("main-content").dataset[key];
    }
    $("experiment-context").hidden = !experiment;

    if (opening || importing || analyzing || saving) cancelGesture();
    for (const id of [
      "zoom-start",
      "zoom-end",
      "zoom-apply",
      "zoom-reset",
      "zoom-span",
      "overview-inspect",
      "channel",
    ])
      $(id).disabled = opening || importing || analyzing || saving || !view;
    $("recording-overview").setAttribute(
      "aria-disabled",
      String(!canExplore()),
    );
    $("recording-overview").setAttribute("tabindex", canExplore() ? "0" : "-1");
    $("zoom-prev").disabled =
      !canExplore() ||
      !displayedWindow ||
      displayedWindow.start_s <= displayedWindow.lower;
    $("zoom-next").disabled =
      !canExplore() ||
      !displayedWindow ||
      displayedWindow.end_s >= displayedWindow.upper;
    for (const button of $("issue-list").querySelectorAll("button"))
      button.disabled = !canExplore();
    if (view) {
      const total = originalData(
        $("channel").value || view.recording.channels[0].name,
      ).issues.length;
      $("issues-prev").disabled = !canExplore() || issuePage === 0;
      $("issues-next").disabled = !canExplore() || (issuePage + 1) * 8 >= total;
    }
    const supported = view?.recording.modality === "ppg";
    for (const field of $("protocol-form").querySelectorAll(
      "input, textarea, select",
    )) {
      field.disabled =
        opening ||
        importing ||
        !supported ||
        (field.id === "evaluation-synthetic" && !view.recording.has_reference);
    }
    $("analyze").disabled =
      !supported ||
      !experiment ||
      protocolDirty ||
      opening ||
      analyzing ||
      importing ||
      saving ||
      runs.length >= 8;
    $("demo-select").disabled = !$("demo-select").options.length;
    $("open-demo").disabled = opening || !$("demo-select").value;
    $("import-submit").disabled = importing;
    $("export").disabled = !result || protocolDirty || opening || importing;
    $("export-experiment").disabled =
      !experiment || protocolDirty || !runs.length || opening || importing;
    $("start-experiment").disabled =
      !supported ||
      saving ||
      opening ||
      importing ||
      (!!experiment && !protocolDirty);
    $("current-recording").hidden = !view;
    text("current-recording-open", view?.recording.name || "");
    text(
      "current-recording-scope",
      view
        ? `${view.recording.modality.toUpperCase()} / original recording`
        : "",
    );
    $("current-recording-open").disabled = !view || opening || importing;
    $("session-list").setAttribute(
      "aria-busy",
      String(!!openingExperimentId && opening),
    );
    for (const button of $("session-list").querySelectorAll("button")) {
      const current = button.dataset.experimentId === experiment?.id;
      if (current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
      button.disabled = opening || importing;
      button.setAttribute(
        "aria-busy",
        String(opening && button.dataset.experimentId === openingExperimentId),
      );
      button.querySelector(".session-state").textContent =
        opening && button.dataset.experimentId === openingExperimentId
          ? "Opening?"
          : current
            ? protocolDirty
              ? "Current / unsaved changes"
              : "Current"
            : "";
    }
    text(
      "protocol-state",
      saving
        ? "Saving protocol..."
        : protocolDirty
          ? "Unsaved protocol. Save as a new experiment before comparing or exporting."
          : experiment
            ? "Saved protocol. Changes create a new experiment."
            : "",
    );
    $("protocol-state").hidden = !saving && !protocolDirty && !experiment;
    syncWorkspaceContext();
    text(
      "experiment-export-summary",
      experiment
        ? `${experiment.protocol.name} / ${runs.length} saved run(s).${!result && runs.length && !protocolDirty ? " Saved runs remain available despite changes to the current analysis inputs." : ""}`
        : "",
    );
    $("plot-method").disabled = !result;
    text(
      "comparison-waveform-source",
      result
        ? "Waveform: the selected manual comparison, with its recorded filter settings. This does not plot Meta's proposed candidate; review Meta's exact tests in its evidence above."
        : "Waveform: original recording samples. Meta's tested settings and measurements appear in its evidence above; they are not substituted into this plot.",
    );
    $("overlay-control").hidden = !result || step !== "compare";
    for (const key of steps) $("step-nav-" + key).disabled = !allowed(key);
    $("continue-inspect").hidden = !view || openingView !== "setup";
    $("continue-inspect").disabled = !view || opening || importing;
    $("continue-compare").disabled = !allowed("compare");
    $("continue-export").disabled = !allowed("export");
    $("analyze").classList.toggle("secondary", !!result);
    text(
      "export-summary",
      protocolDirty
        ? "Protocol has unsaved changes. Start a new experiment before exporting."
        : result
          ? `${view.recording.name} / ${result.channel} / [${result.window.start_s}, ${result.window.end_s}) s`
          : runs.length
            ? "Current-run download is disabled because no valid run is being viewed. View a saved run or compare the current inputs. The saved-run bundle is still available."
            : "Run a comparison to enable current-run JSON export.",
    );
    $("analysis-form").setAttribute("aria-busy", String(analyzing));
    $("import-form").setAttribute("aria-busy", String(importing));
    $("source-picker").setAttribute("aria-busy", String(opening));
    $("use-visible").disabled = !supported || opening || importing;
    $("full-window").disabled = !supported || opening || importing;
    updateRequest();
    syncInvestigation();
    guide?.refresh();
  }
  function invalidate(
    message = "Setup changed. Run the comparison to update measurements.",
  ) {
    revision++;
    exportToken++;
    result = null;
    analyzing = false;
    if (step === "export") goStep("compare");
    $("results").hidden = true;
    $("measurement-details").hidden = true;
    $("metrics").querySelector("tbody").replaceChildren();
    for (const id of [
      "metric-details",
      "exclusion-details",
      "exclusions",
      "findings",
      "export-summary",
    ])
      $(id).replaceChildren();
    $("exclusions-panel").hidden = true;
    $("findings-panel").hidden = true;
    text("analysis-state", "Not analyzed");
    text("limitations", "");
    status(message);
    if (view) {
      renderPlot();
    }
    renderHistory();
    sync();
  }
  function row(parent, label, value) {
    const div = doc.createElement("div");
    div.className = "stat-row";
    const span = doc.createElement("span"),
      strong = doc.createElement("strong");
    span.textContent = label;
    strong.textContent = value;
    div.append(span, strong);
    parent.append(div);
  }
  function renderRecording(data, focusRecording = false) {
    invalidate(
      "Recording ready. Inspect the original or run a PPG comparison.",
    );
    experiment = null;
    runs = [];
    selectedRuns.clear();
    protocolDirty = false;
    view = data;
    cancelGesture();
    customWindow = null;
    issueKey = null;
    issuePage = 0;
    openingView = "setup";
    $("experiment-name").value = `${data.recording.name} experiment`.slice(
      0,
      120,
    );
    $("research-question").value = defaultQuestion("pulse_timing");
    $("protocol-notes").value = "";
    $("target-pulse").checked = true;
    $("goal").value = "pulse_timing";
    $("evaluation-original").checked = true;
    $("evaluation-synthetic").disabled = !data.recording.has_reference;
    text(
      "evaluation-help",
      data.recording.has_reference
        ? "This recording has a synthetic reference available for evaluation only. You may also measure change from the original."
        : "No reference is available. Original sensitivity measures change, not accuracy.",
    );
    text("setup-recording", `Recording: ${data.recording.name}`);
    renderHistory();
    delete displayStates.inspect;
    delete displayStates.compare;
    const r = data.recording;
    text("recording-name", r.name);
    text(
      "recording-modality",
      `${r.modality.toUpperCase()}${r.modality === "ppg" ? "" : " / inspection only"}`,
    );
    text(
      "recording-summary",
      `${count(r.sample_count)} samples · ${number(r.sample_rate_hz)} Hz nominal · ${number(r.duration_s)} s · ${r.channels.length} channel${r.channels.length === 1 ? "" : "s"}`,
    );
    $("channel").replaceChildren(
      ...r.channels.map((c) => option(c.name, c.name)),
    );
    $("channel-control").hidden = r.channels.length < 2;
    $("window-start").value = r.start_s;
    $("window-end").value = recordingEnd();
    for (const id of ["window-start", "window-end"]) {
      $(id).min = r.start_s;
      $(id).max = recordingEnd();
    }
    $("zoom-start").value = r.start_s;
    $("zoom-span").value = "10";
    text("provenance", JSON.stringify(r.provenance, null, 2));
    const integrity = $("integrity");
    integrity.replaceChildren();
    row(integrity, "Timestamp gaps", count(data.inspection.gap_count));
    for (const [name, missing] of Object.entries(
      data.inspection.missing_by_channel,
    ))
      row(integrity, `${name} · missing`, count(missing));
    $("warnings").replaceChildren(
      ...data.inspection.warnings.map((w) => {
        const li = doc.createElement("li");
        li.textContent = w;
        return li;
      }),
    );
    const supported = r.modality === "ppg";
    $("analysis-form").hidden = !supported;
    $("use-visible").hidden = !supported;
    $("analysis-state").hidden = !supported;
    text(
      "setup-title",
      supported ? "Choose what to compare" : "Inspection only",
    );
    for (const id of [
      "goal",
      "median-window",
      "highpass",
      "edge-guard",
      "window-start",
      "window-end",
    ])
      $(id).disabled = !supported;
    text(
      "module-note",
      supported
        ? ""
        : `${r.modality.toUpperCase()} analysis is not available. Inspection only.`,
    );
    status(supported ? "" : "Ready to inspect");
    sync();
    renderPlot();
    if (focusRecording) goStep(supported ? "open" : "inspect");
    else if (step === "open" && !visibleFocus(doc.activeElement))
      focusNode($("open-title"));
  }
  const option = (value, label) => {
    const o = doc.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  const number = (value) =>
    Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : "—";
  const count = (value) =>
    Number.isSafeInteger(value) ? value.toLocaleString() : number(value);
  // The backend accepts one nominal sample period beyond the last sample.
  // Avoid display rounding here: full-record half-open selection includes it.
  function recordingEnd() {
    const end = view.recording.end_s + 1 / view.recording.sample_rate_hz;
    return Number.isFinite(end) ? end : view.recording.end_s;
  }
  const numberInput = (value) => String(value);
  function analysisRequest() {
    return {
      recording_id: view.recording.id,
      ...(experiment ? { experiment_id: experiment.id } : {}),
      channel: $("channel").value,
      start_s: Number($("window-start").value),
      end_s: Number($("window-end").value),
      goal: experiment?.protocol.target ?? $("goal").value,
      parameters: {
        median_window_s: Number($("median-window").value),
        highpass_hz: Number($("highpass").value),
        edge_guard_s: Number($("edge-guard").value),
      },
    };
  }
  function updateRequest() {
    if (view) {
      const startValue = $("window-start").value,
        endValue = $("window-end").value,
        full =
          startValue !== "" &&
          endValue !== "" &&
          Number(startValue) === view.recording.start_s &&
          Number(endValue) === recordingEnd();
      text(
        "range-summary",
        full
          ? `Full recording \u00b7 ${view.recording.start_s} to ${recordingEnd()} seconds`
          : `${startValue || "Not set"} to ${endValue || "Not set"} seconds`,
      );
    }
    text(
      "analysis-request",
      view
        ? JSON.stringify(analysisRequest(), null, 2)
        : "Open a recording first",
    );
  }
  function applyWindow(start, end) {
    if (
      !view ||
      view.recording.modality !== "ppg" ||
      !experiment ||
      protocolDirty ||
      opening ||
      importing ||
      saving ||
      analyzing ||
      runs.length >= 8
    )
      return;
    $("window-start").value = numberInput(start);
    $("window-end").value = numberInput(end);
    invalidate("Analysis window changed. Compare to update results.");
  }
  function interval(start, end) {
    const span = doc.createElement("span");
    span.className = "interval";
    span.textContent = `[${start}, ${end}) s`;
    return span;
  }
  // Coordinates only: original timestamps and amplitudes are never modified.
  function fraction(value, low, high) {
    if (!(high > low)) return 0;
    const width = high - low;
    if (Number.isFinite(width))
      return Math.max(0, Math.min(1, (value - low) / width));
    const scale = Math.max(Math.abs(low), Math.abs(high));
    return Math.max(
      0,
      Math.min(1, (value / scale - low / scale) / (high / scale - low / scale)),
    );
  }
  function interpolate(low, high, f) {
    const width = high - low;
    return Number.isFinite(width) ? low + width * f : low * (1 - f) + high * f;
  }
  function canExplore() {
    return (
      !!view && !destroyed && !opening && !importing && !analyzing && !saving
    );
  }
  function originalData(channel) {
    let cache = recordingCache.get(view);
    const times = view.plot.times;
    if (!cache) {
      const dt = times.slice(1).map((t, i) => t - times[i]);
      const sorted = [...dt].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const nominal =
        sorted.length % 2
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) / 2;
      const gaps = dt.map((d) => d > 1.5 * nominal);
      cache = { gaps, channels: new Map() };
      recordingCache.set(view, cache);
    }
    if (cache.channels.has(channel)) return cache.channels.get(channel);
    const values = view.plot.channels[channel],
      issues = [];
    let missingStart = null,
      missingCount = 0,
      gapCount = 0;
    function closeMissing(end) {
      if (missingStart === null) return;
      issues.push({
        type: "missing",
        start: times[missingStart],
        end: times[end],
        count: end - missingStart + 1,
        first: missingStart,
        last: end,
      });
      missingStart = null;
    }
    for (let i = 0; i < times.length; i++) {
      if (i && cache.gaps[i - 1]) {
        closeMissing(i - 1);
        gapCount++;
        issues.push({
          type: "gap",
          start: times[i - 1],
          end: times[i],
          first: i - 1,
          last: i,
        });
      }
      if (!Number.isFinite(values[i])) {
        missingCount++;
        if (missingStart === null) missingStart = i;
      } else closeMissing(i - 1);
    }
    closeMissing(times.length - 1);
    // Fixed-size time bins bound both path complexity and DOM, even for
    // 100,000 alternating missing values. Broken bins use disconnected extrema
    // marks, never a line across an unobserved region.
    const bins = new Array(1000);
    let low = Infinity,
      high = -Infinity;
    for (let i = 0; i < times.length; i++) {
      const b = Math.min(
        999,
        Math.floor(fraction(times[i], times[0], times.at(-1)) * 1000),
      );
      const bin = (bins[b] ??= {
        points: [],
        broken: false,
        first: i,
        last: i,
      });
      bin.last = i;
      if (!Number.isFinite(values[i]) || (i && cache.gaps[i - 1]))
        bin.broken = true;
      if (!Number.isFinite(values[i])) continue;
      low = Math.min(low, values[i]);
      high = Math.max(high, values[i]);
      if (!bin.points.length) bin.points = [i, i, i, i];
      else {
        bin.points[3] = i;
        if (values[i] < values[bin.points[1]]) bin.points[1] = i;
        if (values[i] > values[bin.points[2]]) bin.points[2] = i;
      }
    }
    const x = (i) =>
      (fraction(times[i], times[0], recordingEnd()) * 1000).toFixed(3);
    const y = (i) =>
      (high === low ? 60 : 106 - fraction(values[i], low, high) * 92).toFixed(
        3,
      );
    const path = [];
    let previous = null,
      retained = 0;
    for (const bin of bins) {
      if (!bin) continue;
      if (!bin.points.length) {
        previous = null;
        continue;
      }
      const indices = [...new Set(bin.points)].sort((a, b) => a - b);
      retained += indices.length;
      if (bin.broken) {
        for (const i of indices) path.push(`M${x(i)},${y(i)}h0.5`);
        previous = null;
      } else {
        const connected =
          previous !== null &&
          previous + 1 === bin.first &&
          !cache.gaps[previous];
        indices.forEach((i, n) =>
          path.push(`${n || connected ? "L" : "M"}${x(i)},${y(i)}`),
        );
        if (indices.length === 1 && !connected) path.push("h0.5");
        previous = bin.last;
      }
    }
    const data = {
      issues,
      gapCount,
      missingCount,
      path: path.join(" "),
      reduced: retained < values.filter(Number.isFinite).length,
    };
    cache.channels.set(channel, data);
    return data;
  }
  function overviewRect(id, start, end) {
    const low = view.plot.times[0],
      high = recordingEnd();
    const x = fraction(start, low, high) * 1000,
      right = fraction(end, low, high) * 1000;
    $(id).setAttribute("x", String(x));
    $(id).setAttribute("width", String(Math.max(0, right - x)));
  }
  function renderOverview(channel, plottedResult) {
    const data = originalData(channel);
    // Avoid replacing the focusable SVG or rebuilding paths during gestures.
    if ($("overview-path").getAttribute("d") !== data.path)
      $("overview-path").setAttribute("d", data.path);
    overviewRect(
      "overview-selection",
      displayedWindow.start_s,
      displayedWindow.end_s,
    );
    $("overview-analysis").toggleAttribute("hidden", !plottedResult);
    if (plottedResult)
      overviewRect(
        "overview-analysis",
        plottedResult.window.start_s,
        plottedResult.window.end_s,
      );
    $("overview-inspect").hidden = !plottedResult;
    text(
      "overview-note",
      `Original ${channel}: ${view.plot.times[0]} to ${view.plot.times.at(-1)} s · ${view.plot.times.length} timestamps. Displayed [${displayedWindow.start_s}, ${displayedWindow.end_s}) s (solid). ${plottedResult ? `Analyzed [${plottedResult.window.start_s}, ${plottedResult.window.end_s}) s (dashed); Compare navigation stays inside analysis. Inspect whole recording to explore outside. ` : ""}${data.reduced ? "Display-only reduction retains extrema; see waveform guide." : ""}`,
    );
  }
  function selectDisplay(start, end) {
    if (!canExplore() || !displayedWindow) return;
    cancelGesture();
    const { lower, upper } = displayedWindow;
    const a = Math.max(lower, Math.min(upper, start)),
      b = Math.max(lower, Math.min(upper, end));
    if (!(b > a)) {
      text(
        "display-error",
        "Choose a displayed range inside the available interval.",
      );
      return;
    }
    customWindow = { start_s: a, end_s: b };
    $("zoom-span").value = "custom";
    text(
      "display-error",
      a !== start || b !== end
        ? "Display range clamped to the available interval. Analysis range is unchanged."
        : "",
    );
    renderPlot();
  }
  function relocate(start) {
    if (!canExplore() || !displayedWindow) return;
    const { lower, upper, start_s, end_s } = displayedWindow;
    const width = end_s - start_s;
    if (!Number.isFinite(width)) {
      selectDisplay(lower, upper);
      return;
    }
    const a = Math.max(lower, Math.min(start, upper - width));
    if ($("zoom-span").value !== "custom") {
      $("zoom-start").value = String(a);
      renderPlot();
    } else selectDisplay(a, Math.min(upper, a + width));
  }
  function renderIssues(channel) {
    const data = originalData(channel);
    if (issueKey?.view !== view || issueKey.channel !== channel) issuePage = 0;
    if (
      issueKey?.view === view &&
      issueKey.channel === channel &&
      issueKey.page === issuePage
    )
      return;
    issueKey = { view, channel, page: issuePage };
    const total = data.issues.length,
      first = issuePage * 8;
    text(
      "issue-summary",
      total
        ? `${data.gapCount} timestamp gaps; ${data.missingCount} missing samples in ${channel}, grouped into ${total - data.gapCount} missing regions. Showing issues ${first + 1}–${Math.min(first + 8, total)} of ${total}. Warnings without a known location remain listed above.`
        : `No timestamp gaps or missing samples found in ${channel}. This does not assess signal health; review any warnings above.`,
    );
    $("issues-prev").disabled = issuePage === 0;
    $("issues-next").disabled = first + 8 >= total;
    $("issue-list").replaceChildren(
      ...data.issues.slice(first, first + 8).map((issue) => {
        const article = doc.createElement("article"),
          detail = doc.createElement("p"),
          button = doc.createElement("button");
        article.className = "recording-issue";
        article.dataset.issueType = issue.type;
        article.dataset.startS = String(issue.start);
        article.dataset.endS = String(issue.end);
        if (issue.type === "missing")
          article.dataset.sampleCount = String(issue.count);
        detail.textContent =
          issue.type === "gap"
            ? `Timestamp gap between observed timestamps ${issue.start} and ${issue.end} s. No samples are observed inside this gap. The trace is disconnected; inspect the surrounding samples.`
            : `${issue.count} missing sample${issue.count === 1 ? "" : "s"} in ${channel} at ${issue.start}${issue.start === issue.end ? "" : ` to ${issue.end}`} s (observed timestamps with nonfinite values). The trace is disconnected; inspect the surrounding samples before choosing an analysis interval.`;
        button.type = "button";
        button.className = "secondary";
        button.textContent = "View region";
        button.setAttribute(
          "aria-label",
          `View ${issue.type === "gap" ? "timestamp gap" : "missing sample region"} at ${issue.start} to ${issue.end} seconds`,
        );
        button.disabled = !canExplore();
        const source = view;
        button.addEventListener("click", () => {
          if (
            !canExplore() ||
            view !== source ||
            $("channel").value !== channel
          )
            return;
          goStep("inspect", false);
          const times = view.plot.times;
          // Include observed neighbors and 10% of the region on either side.
          const left = times[Math.max(0, issue.first - 2)],
            right = times[Math.min(times.length - 1, issue.last + 2)];
          const padding = (right - left) * 0.1;
          const paddedEnd = Number.isFinite(right + padding)
            ? right + padding
            : right;
          // Padding can round back to the affected timestamp at large offsets.
          // A half-open view must end beyond it: use the observed successor or
          // the recording's available endpoint, without rounding timestamps.
          const end =
            paddedEnd > issue.end
              ? paddedEnd
              : (times[issue.last + 1] ?? displayedWindow.upper);
          selectDisplay(
            Number.isFinite(left - padding) ? left - padding : left,
            Math.min(displayedWindow.upper, end),
          );
          if (displayedWindow.end_s <= issue.end) {
            text(
              "display-error",
              `The final affected timestamp (${issue.end} s) cannot be included in this half-open view: no supported finite exclusive endpoint exists beyond it. Showing the available interval and surrounding samples.`,
            );
          }
          focusNode($("waveform-title"));
        });
        article.append(detail, button);
        return article;
      }),
    );
  }
  for (const [id, delta] of [
    ["issues-prev", -1],
    ["issues-next", 1],
  ])
    $(id).addEventListener("click", () => {
      if (!canExplore()) return;
      const data = originalData($("channel").value);
      issuePage = Math.max(
        0,
        Math.min(Math.ceil(data.issues.length / 8) - 1, issuePage + delta),
      );
      renderIssues($("channel").value);
      focusNode($("issue-summary"));
    });
  $("overview-inspect").addEventListener("click", () => {
    if (!canExplore()) return;
    goStep("inspect", false);
    $("zoom-reset").click();
    focusNode($("waveform-title"));
  });
  function cancelGesture() {
    const active = gesture;
    gesture = null;
    if (active) {
      try {
        $("recording-overview").releasePointerCapture?.(active.id);
      } catch {
        /* Already released. */
      }
      if (view && displayedWindow)
        overviewRect(
          "overview-selection",
          displayedWindow.start_s,
          displayedWindow.end_s,
        );
    }
  }
  function pointerTime(event, rect) {
    return interpolate(
      view.plot.times[0],
      recordingEnd(),
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    );
  }
  const overview = $("recording-overview");
  overview.addEventListener("pointerdown", (event) => {
    if (
      !canExplore() ||
      (event.button !== undefined && event.button !== 0) ||
      event.isPrimary === false
    )
      return;
    cancelGesture();
    const rect = overview.getBoundingClientRect();
    if (!(rect.width > 0) || !Number.isFinite(event.clientX)) return;
    event.preventDefault();
    focusNode(overview);
    gesture = {
      id: event.pointerId,
      rect,
      x: event.clientX,
      start: pointerTime(event, rect),
      source: view,
      channel: $("channel").value,
    };
    try {
      overview.setPointerCapture?.(event.pointerId);
    } catch {
      /* Window listeners still finish safely. */
    }
  });
  function movePointer(event) {
    if (
      !gesture ||
      event.pointerId !== gesture.id ||
      !Number.isFinite(event.clientX)
    )
      return;
    const time = pointerTime(event, gesture.rect);
    overviewRect(
      "overview-selection",
      Math.max(displayedWindow.lower, Math.min(gesture.start, time)),
      Math.min(displayedWindow.upper, Math.max(gesture.start, time)),
    );
  }
  function endPointer(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const active = gesture;
    cancelGesture();
    if (
      !canExplore() ||
      active.source !== view ||
      active.channel !== $("channel").value ||
      !Number.isFinite(event.clientX)
    )
      return;
    const time = pointerTime(event, active.rect);
    if (Math.abs(event.clientX - active.x) < 4)
      relocate(time - displayedWindow.span / 2);
    else
      selectDisplay(Math.min(active.start, time), Math.max(active.start, time));
  }
  function cancelPointer(event) {
    if (gesture && event.pointerId === gesture.id) cancelGesture();
  }
  win.addEventListener("pointermove", movePointer);
  win.addEventListener("pointerup", endPointer);
  win.addEventListener("pointercancel", cancelPointer);
  overview.addEventListener("lostpointercapture", cancelPointer);
  win.addEventListener("resize", cancelGesture);
  overview.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cancelGesture();
      return;
    }
    if (!canExplore() || !displayedWindow) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    cancelGesture();
    const { lower, upper, span, start_s } = displayedWindow;
    relocate(
      event.key === "Home"
        ? lower
        : event.key === "End"
          ? upper
          : start_s + (event.key === "ArrowRight" ? 1 : -1) * span,
    );
  });
  function renderPlot() {
    if (!view || destroyed) return;
    const plottedResult = step === "compare" ? result : null;
    const channel = $("channel").value || view.recording.channels[0].name;
    const unit =
      view.recording.channels.find((c) => c.name === channel)?.unit || "";
    let times,
      series,
      mask = null;
    if (plottedResult) {
      ({ times, valid_mask: mask } = plottedResult.plot);
      const selected = $("plot-method").value;
      const methods =
        selected === "all"
          ? ["median", "highpass"]
          : selected === "original"
            ? []
            : [selected];
      series = { raw: plottedResult.plot.raw };
      for (const key of methods) series[key] = plottedResult.plot[key];
      if (
        $("show-reference").checked &&
        Array.isArray(plottedResult.plot.reference)
      )
        series.reference = plottedResult.plot.reference;
    } else {
      times = view.plot.times;
      series = { raw: view.plot.channels[channel] };
    }
    const lower = plottedResult
      ? plottedResult.window.start_s
      : view.recording.start_s;
    const upper = plottedResult ? plottedResult.window.end_s : recordingEnd();
    const full = $("zoom-span").value === "all";
    const custom = $("zoom-span").value === "custom" && customWindow;
    const span = custom
      ? custom.end_s - custom.start_s
      : full
        ? upper - lower
        : Math.min(Number($("zoom-span").value), upper - lower);
    let start = custom ? custom.start_s : Number($("zoom-start").value);
    if (!Number.isFinite(start)) start = lower;
    start = full
      ? lower
      : custom
        ? Math.max(lower, Math.min(start, upper))
        : Math.max(lower, Math.min(start, upper - span));
    let end = custom
      ? Math.max(start, Math.min(upper, custom.end_s))
      : Math.min(upper, start + span);
    if (!(end > start)) {
      start = lower;
      end = upper;
      text(
        "display-error",
        "Previous display was outside the available interval; showing the available interval. Analysis range is unchanged.",
      );
    }
    if (custom) customWindow = { start_s: start, end_s: end };
    displayedWindow = {
      start_s: start,
      end_s: end,
      lower,
      upper,
      span: end - start,
    };
    $("zoom-start").value = numberInput(start);
    $("zoom-start").min = lower;
    $("zoom-start").max = upper;
    $("zoom-end").value = numberInput(end);
    $("zoom-end").min = lower;
    $("zoom-end").max = upper;
    $("zoom-prev").disabled = !canExplore() || start <= lower;
    $("zoom-next").disabled = !canExplore() || end >= upper;
    renderOverview(channel, plottedResult);
    renderIssues(channel);
    $("reference-control").hidden = !Array.isArray(
      plottedResult?.plot.reference,
    );
    // Keep a shared amplitude scale across overlay choices, including the
    // optional evaluator reference. Selection never normalizes a method.
    const amplitudeSeries = plottedResult
      ? Object.fromEntries(
          ["raw", "median", "highpass", "reference"]
            .filter((key) => Array.isArray(plottedResult.plot[key]))
            .map((key) => [key, plottedResult.plot[key]]),
        )
      : series;
    const rendered = drawChart(
      $("chart"),
      times,
      series,
      start,
      end,
      unit,
      mask,
      amplitudeSeries,
      true,
    );
    text("plot-unit", `${channel} \u00b7 ${unit}`);
    text("waveform-title", "Waveform");
    $("window-label").replaceChildren(
      ...(plottedResult
        ? [
            "Analyzed: ",
            interval(plottedResult.window.start_s, plottedResult.window.end_s),
          ]
        : ["Original samples · no filtering applied in Inspect"]),
    );
    $("display-note").replaceChildren(
      "Displayed: ",
      interval(start, end),
      ` · ${count(rendered.sampleCount)} samples${rendered.reduced ? " · display reduced; calculations use all samples" : ""}`,
    );
    text(
      "guide-source",
      plottedResult
        ? "Original shows the loaded samples. Method overlays show processing of the analyzed interval only."
        : view.recording.modality === "ppg"
          ? "Original shows the loaded samples without filtering. Inspect always shows the original recording, even after a comparison."
          : "Original shows the loaded samples without filtering. This modality supports recording inspection only.",
    );
    text(
      "guide-window",
      view.recording.modality === "ppg"
        ? "Displayed interval is the part on screen. Display navigation does not change the analysis interval; select Use visible window to copy it before comparing."
        : "Displayed interval is the part on screen. Use the display controls to explore the original recording; preprocessing comparison is unavailable for this modality.",
    );
    const missing = view.inspection.missing_by_channel[channel] ?? 0;
    text(
      "guide-integrity",
      `${count(missing)} missing samples in this channel; ${count(view.inspection.gap_count)} timestamp gaps in the recording. Missing samples and timestamp gaps break the trace; timestamps are not repaired.`,
    );
    $("guide-exclusions").hidden =
      !plottedResult || !(plottedResult.exclusions.excluded_fraction > 0);
    $("legend").replaceChildren(
      ...Object.keys(series).map((name) => {
        const item = doc.createElement("span");
        item.className = "legend-item";
        const swatch = doc.createElement("span");
        swatch.className = `legend-swatch ${name}`;
        swatch.style.background = COLORS[name];
        const label = doc.createElement("span");
        label.textContent = {
          raw: "Original",
          unchanged: "Unchanged",
          median: "Median subtraction",
          highpass: "High-pass",
          reference: "Synthetic reference · evaluation only",
        }[name];
        item.append(swatch, label);
        return item;
      }),
    );
  }
  function renderResult(data) {
    result = data;
    setPanel("manual-comparison", true);
    $("plot-method").value = "median";
    $("show-reference").checked = false;
    text("analysis-state", "Analysis ready");
    $("results").hidden = false;
    text(
      "comparison-label",
      data.comparison === "synthetic_reference"
        ? "Compared with synthetic reference · evaluation only"
        : "Compared with original samples · change, not accuracy",
    );
    const synthetic = data.comparison === "synthetic_reference";
    const timing = data.goal === "pulse_timing";
    const primaryKey = timing
      ? "mean_absolute_shift_ms"
      : "centered_normalized_rmse";
    const measured = (method) => {
      const value = data.metrics[method]?.[primaryKey];
      return Number.isFinite(value)
        ? `${formatMeasurement(value, primaryKey)}${timing ? " ms" : ""}`
        : "not available";
    };
    text(
      "results-intro",
      `${timing ? "Timing shift" : "Waveform difference"}: median subtraction ${measured("median")}; high-pass ${measured("highpass")} versus ${synthetic ? "the synthetic reference" : "the original samples"}.`,
    );
    text(
      "goal-note",
      `Analyzed [${data.window.start_s}, ${data.window.end_s}) s.${timing ? " Matched candidates only; unmatched counts below." : ""} No automatic ranking.`,
    );
    const differenceLabel = "Waveform difference";
    text(
      "exclusion-summary",
      `${formatExcludedPercent(data.exclusions.excluded_fraction)} excluded \u00b7 ${count(data.exclusions.valid_count)} / ${count(data.exclusions.sample_count)} valid`,
    );
    $("method-comparison").replaceChildren(
      ...[
        ["unchanged", "Unchanged"],
        ["median", "Median subtraction"],
        ["highpass", "High-pass"],
      ].map(([key, label]) => {
        const section = doc.createElement("section"),
          heading = doc.createElement("h3"),
          description = doc.createElement("p"),
          list = doc.createElement("dl");
        section.className = "method-result";
        heading.id = `method-${key}`;
        heading.textContent = label;
        description.className = "method-description";
        description.textContent = {
          unchanged: "The original samples, kept as a reference condition.",
          median: "Removes slow baseline movement before measuring the signal.",
          highpass: "Reduces slower signal components with a high-pass filter.",
        }[key];
        section.setAttribute("aria-labelledby", heading.id);
        const m = data.metrics[key];
        const shapeMetric = [
          differenceLabel,
          formatMeasurement(
            m?.centered_normalized_rmse,
            "centered_normalized_rmse",
          ),
        ];
        const timingMetric = [
          "Timing shift (ms)",
          formatMeasurement(
            m?.mean_absolute_shift_ms,
            "mean_absolute_shift_ms",
          ),
        ];
        for (const [index, [name, value]] of [
          ...(timing
            ? [timingMetric, shapeMetric]
            : [shapeMetric, timingMetric]),
          [
            synthetic
              ? "Unmatched reference peaks"
              : "Unmatched original peaks",
            count(m?.unmatched_reference_count),
          ],
          ["Unmatched method peaks", count(m?.unmatched_candidate_count)],
        ].entries()) {
          const group = doc.createElement("div"),
            term = doc.createElement("dt"),
            definition = doc.createElement("dd");
          term.textContent = name;
          if (index === 0) group.className = "target-metric";
          definition.textContent = value;
          group.append(term, definition);
          list.append(group);
        }
        section.append(heading, description, list);
        return section;
      }),
    );
    const rows = [
      ["centered_normalized_rmse", "Normalized waveform difference", !timing],
      ["reference_count", "Comparator peak candidates", false],
      ["candidate_count", "Method peak candidates", false],
      ["matched_count", "Matched candidates", false],
      ["unmatched_reference_count", "Unmatched comparator candidates", timing],
      ["unmatched_candidate_count", "Unmatched method candidates", timing],
      [
        "mean_absolute_shift_ms",
        "Mean absolute peak timing shift (ms)",
        timing,
      ],
      [
        "maximum_absolute_shift_ms",
        "Maximum absolute peak timing shift (ms)",
        timing,
      ],
    ];
    const tbody = $("metrics").querySelector("tbody");
    tbody.replaceChildren(
      ...rows.map(([key, label, emphasis]) => {
        const tr = doc.createElement("tr");
        if (emphasis) tr.className = "emphasis";
        const th = doc.createElement("th");
        th.scope = "row";
        th.textContent = label;
        tr.append(th);
        for (const method of ["unchanged", "median", "highpass"]) {
          const td = doc.createElement("td");
          td.textContent = key.endsWith("_count")
            ? count(data.metrics[method]?.[key])
            : formatMeasurement(data.metrics[method]?.[key], key);
          tr.append(td);
        }
        return tr;
      }),
    );
    $("measurement-details").hidden = false;
    text("metric-details", JSON.stringify(data.metrics, null, 2));
    text("exclusion-details", JSON.stringify(data.exclusions, null, 2));
    $("exclusions-panel").hidden = false;
    const ex = $("exclusions");
    ex.replaceChildren();
    row(
      ex,
      "Excluded samples",
      `${formatExcludedPercent(data.exclusions.excluded_fraction)}`,
    );
    row(
      ex,
      "Valid / selected",
      `${count(data.exclusions.valid_count)} / ${count(data.exclusions.sample_count)}`,
    );
    row(ex, "Missing samples", count(data.exclusions.nonfinite_count));
    row(ex, "Exact flat samples", count(data.exclusions.flatline_count));
    row(
      ex,
      "Timestamp gaps",
      count(data.exclusions.gap_after_indices?.length ?? 0),
    );
    row(
      ex,
      "Short segments",
      count(data.exclusions.too_short_segments?.length ?? 0),
    );
    $("findings-panel").hidden = false;
    $("findings").replaceChildren(
      ...data.findings.map((f) => {
        const d = doc.createElement("div");
        d.className = "finding";
        const strong = doc.createElement("strong"),
          p = doc.createElement("p");
        strong.textContent = f.label;
        p.textContent = f.detail;
        d.append(strong, p);
        return d;
      }),
    );
    const limits = Array.isArray(data.limitations)
      ? data.limitations
      : [data.limitations];
    $("limitations").replaceChildren(
      ...limits.filter(Boolean).map((l) => {
        const p = doc.createElement("p");
        p.textContent = l;
        return p;
      }),
    );
    displayStates.compare = {
      start: String(data.window.start_s),
      span:
        step === "compare"
          ? $("zoom-span").value
          : (displayStates.compare?.span ?? "10"),
      custom:
        step === "compare"
          ? customWindow && { ...customWindow }
          : displayStates.compare?.custom,
    };
    if (step === "compare") $("zoom-start").value = data.window.start_s;
    status("Comparison ready. Export or inspect the results.");
    sync();
    renderPlot();
  }
  function cancelLoad() {
    cancelGesture();
    loadToken++;
    openingExperimentId = null;
    contextToken++;
    historyToken++;
    sessionToken++;
    saving = false;
    analyzing = false;
    exportToken++;
    opening = false;
    importing = false;
  }
  function cancelPreview() {
    previewToken++;
    pendingCSV = null;
    $("import-panel").hidden = true;
    $("csv-file").value = "";
  }
  async function openDemo(focusRecording = false) {
    cancelLoad();
    cancelPreview();
    const token = loadToken,
      navigation = navigationToken;
    status("Opening sample recording...");
    opening = true;
    sync();
    error("");
    try {
      const data = await api("/api/demo", { demo_id: $("demo-select").value });
      if (token !== loadToken) return;
      opening = false;
      renderRecording(data, focusRecording && navigation === navigationToken);
    } catch (e) {
      if (token === loadToken) {
        error(e.message);

        status(
          view
            ? "Could not open recording. Your current recording is retained."
            : "Could not open recording. Choose another demo or import a CSV.",
        );
      }
    } finally {
      if (token === loadToken) {
        opening = false;
        sync();
      }
    }
  }
  $("open-demo").addEventListener("click", () => openDemo(true));
  $("csv-file").addEventListener("change", async () => {
    const file = $("csv-file").files?.[0];
    if (!file) return;
    goStep("open", false);
    cancelLoad();
    openingView = "choice";
    const token = ++previewToken;
    sync();
    error("");
    pendingCSV = null;
    text("import-name", file.name);
    $("import-panel").hidden = true;
    if (
      !/\.csv$/i.test(file.name) ||
      file.name.toLowerCase().startsWith(".env") ||
      /(^|[.\-_])env([.\-_]|$)|secret|credential|private_key|id_rsa/i.test(
        file.name,
      )
    ) {
      error(
        "Choose a non-secret CSV file. Secret-like names and unsupported file types cannot be imported.",
      );
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      error(
        "CSV files must be no larger than 2 MiB. Select a smaller recording.",
      );
      return;
    }
    showOpening("mapping", true);
    const navigation = navigationToken;
    status("Reading CSV locally for column mapping…");
    try {
      const csv = await file.text();
      if (token !== previewToken) return;
      const data = await api("/api/preview", { csv_text: csv });
      if (token !== previewToken) return;
      pendingCSV = { name: file.name, csv_text: csv };
      text("import-name", file.name);
      $("time-column").replaceChildren(
        ...data.columns.map((c) => option(c, c)),
      );
      $("signal-columns").replaceChildren(
        Object.assign(doc.createElement("legend"), {
          textContent: "Signal channels (choose up to eight)",
        }),
        ...data.columns.map((c, i) => {
          const label = doc.createElement("label"),
            input = doc.createElement("input");
          input.type = "checkbox";
          input.value = c;
          input.name = "signal-column";
          input.checked = i === 1;
          label.append(input, doc.createTextNode(c));
          return label;
        }),
      );
      const table = doc.createElement("table");
      const head = doc.createElement("thead"),
        body = doc.createElement("tbody");
      const header = doc.createElement("tr");
      for (const value of data.columns) {
        const th = doc.createElement("th");
        th.scope = "col";
        th.dataset.column = value;
        th.textContent = value;
        header.append(th);
      }
      head.append(header);
      for (const cells of data.sample_rows) {
        const tr = doc.createElement("tr");
        for (const value of cells) {
          const td = doc.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(head, body);
      $("preview-table").replaceChildren(table);
      showOpening("mapping");
      status("CSV preview ready. Confirm column mapping before importing.");
      if (navigation === navigationToken && step === "open")
        focusNode($("time-column"));
    } catch (e) {
      if (token === previewToken) {
        error(e.message);
        status("CSV preview failed. Choose a corrected CSV to retry.");
        showOpening("choice", true);
      }
    }
  });
  $("import-cancel").addEventListener("click", () => {
    cancelLoad();
    cancelPreview();
    error("");
    status("Import cancelled");
    showOpening(view ? "setup" : "choice");
    focusNode($(view ? "open-title" : "csv-file"));
  });
  $("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pendingCSV || importing) return;
    const signal_columns = [
      ...$("signal-columns").querySelectorAll("input:checked"),
    ].map((i) => i.value);
    if (!signal_columns.length || signal_columns.length > 8) {
      error("Choose between one and eight signal channels.");
      return;
    }
    if (signal_columns.includes($("time-column").value)) {
      error("The time column cannot also be a signal channel.");
      return;
    }
    cancelLoad();
    const token = loadToken,
      navigation = navigationToken;
    status("Importing original samples...");
    importing = true;
    sync();
    error("");
    try {
      const data = await api("/api/import", {
        ...pendingCSV,
        modality: $("import-modality").value,
        time_column: $("time-column").value,
        time_unit: $("time-unit").value,
        signal_columns,
        signal_unit: $("signal-unit").value,
      });
      if (token !== loadToken) return;
      importing = false;
      renderRecording(data, navigation === navigationToken);
      $("import-panel").hidden = true;
      pendingCSV = null;
      $("csv-file").value = "";
    } catch (e) {
      if (token === loadToken) {
        error(e.message);
        status(
          "Import failed. Your CSV and mapping are retained for correction.",
        );
      }
    } finally {
      if (token === loadToken) {
        importing = false;
        sync();
      }
    }
  });
  for (const id of [
    "channel",
    "window-start",
    "window-end",
    "median-window",
    "highpass",
    "edge-guard",
  ])
    $(id).addEventListener(id === "channel" ? "change" : "input", () => {
      if (view) {
        if (id === "channel") {
          cancelGesture();
          issueKey = null;
          issuePage = 0;
        }
        invalidate();
      }
    });
  function revealAndFocus(input) {
    goStep("compare", false);
    if ($("manual-comparison").contains(input))
      setPanel("manual-comparison", true);
    if ($("parameters").contains(input)) setPanel("parameters", true);
    focusNode(input);
  }
  $("analysis-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !view ||
      view.recording.modality !== "ppg" ||
      !experiment ||
      protocolDirty ||
      opening ||
      importing ||
      saving ||
      analyzing ||
      runs.length >= 8
    )
      return;
    if (!$("analysis-form").checkValidity()) {
      error("Enter values within the labelled parameter bounds.");
      const invalid = [...$("analysis-form").elements].find(
        (input) => !input.validity.valid,
      );
      if (invalid) {
        revealAndFocus(invalid);
        invalid.reportValidity();
      }
      return;
    }
    if (Number($("window-start").value) >= Number($("window-end").value)) {
      error("Window end must be greater than window start.");
      revealAndFocus($("window-end"));
      return;
    }
    invalidate("Running deterministic PPG comparison…");
    const token = revision,
      context = contextToken,
      experimentId = experiment.id,
      navigation = navigationToken;
    analyzing = true;
    sync();
    text("analysis-state", "Analyzing…");
    error("");
    const payload = analysisRequest();
    try {
      const data = await api("/api/analyze", payload);
      if (context !== contextToken || experiment?.id !== experimentId) return;
      if (!runs.some((run) => run.id === data.id)) {
        runs.push(
          structuredClone({
            id: data.id,
            label: data.run_label || `Run ${runs.length + 1}`,
            request: payload,
            goal: data.goal,
            channel: data.channel,
            window: data.window,
            parameters: data.parameters || payload.parameters,
            comparison: data.comparison,
            metrics: data.metrics,
            exclusions: data.exclusions,
            input_sha256: data.provenance?.input_sha256,
          }),
        );
        renderHistory();
        sync();
      }
      if (token !== revision) {
        await refreshHistory();
        return;
      }
      renderResult(data);
      revealNew($("results"));
      await refreshHistory(data.id);
      if (token !== revision) return;
      if (step === "compare" && navigation === navigationToken)
        focusNode($("results-title"));
    } catch (e) {
      if (token === revision && context === contextToken) {
        error(e.message);
        text("analysis-state", "Analysis failed");
        status("Analysis failed. Adjust the window or parameters and retry.");
        const fields = {
          start_s: "window-start",
          end_s: "window-end",
          goal: "goal",
          median_window_s: "median-window",
          highpass_hz: "highpass",
          edge_guard_s: "edge-guard",
        };
        const field = e.fields?.find((name) => fields[name]);
        if (field && navigation === navigationToken)
          revealAndFocus($(fields[field]));
      }
    } finally {
      if (token === revision && context === contextToken) {
        analyzing = false;
        sync();
      }
    }
  });
  for (const [id, direction] of [
    ["zoom-prev", -1],
    ["zoom-next", 1],
  ]) {
    $(id).addEventListener("click", () => {
      if (!displayedWindow || !canExplore()) return;
      relocate(
        direction > 0
          ? displayedWindow.end_s
          : displayedWindow.start_s - displayedWindow.span,
      );
    });
  }
  $("use-visible").addEventListener("click", () => {
    if (displayedWindow)
      applyWindow(displayedWindow.start_s, displayedWindow.end_s);
  });
  $("full-window").addEventListener("click", () => {
    if (view) applyWindow(view.recording.start_s, recordingEnd());
  });
  $("plot-method").addEventListener("change", renderPlot);
  $("show-reference").addEventListener("change", renderPlot);
  $("zoom-apply").addEventListener("click", () => {
    if (!canExplore()) return;
    const a = $("zoom-start"),
      b = $("zoom-end");
    const start = Number(a.value),
      end = Number(b.value);
    if (
      !a.value ||
      !b.value ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end
    ) {
      text("display-error", "Enter finite display times with end after start.");
      focusNode(!a.value || !Number.isFinite(start) ? a : b);
      return;
    }
    selectDisplay(start, end);
  });
  $("zoom-span").addEventListener("change", () => {
    if (!canExplore()) return;
    if ($("zoom-span").value === "custom")
      customWindow = { ...displayedWindow };
    text("display-error", "");
    renderPlot();
  });
  $("zoom-reset").addEventListener("click", () => {
    if (!canExplore()) return;
    $("zoom-span").value = "all";
    customWindow = null;
    text("display-error", "");
    renderPlot();
  });
  $("export").addEventListener("click", async () => {
    if (!result || !experiment || protocolDirty || opening || importing) return;
    const experimentId = experiment.id;
    const id = result.id,
      token = ++exportToken;
    $("export").disabled = true;
    error("");
    try {
      const blob = await pendingWork(async () => {
        const response = await request(
          `/api/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(id)}/export`,
        );
        if (!response.ok) {
          const data = await response.json();
          throw new Error(formatError(data.detail));
        }
        return response.blob();
      }, "/export");
      if (
        token !== exportToken ||
        result?.id !== id ||
        experiment?.id !== experimentId ||
        protocolDirty
      )
        return;
      const url = URL.createObjectURL(blob),
        a = doc.createElement("a");
      a.href = url;
      a.download = "signaltrace-analysis.json";
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(
        "Current-run JSON download requested. Contains input, recipe and measurements.",
      );
    } catch (e) {
      if (token === exportToken) error(e.message);
    } finally {
      sync();
    }
  });
  function draftProtocol() {
    return {
      name: $("experiment-name").value.trim(),
      research_question: $("research-question").value,
      task: "ppg_preprocessing",
      target: $("target-waveform").checked
        ? "waveform_sensitivity"
        : "pulse_timing",
      evaluation: $("evaluation-synthetic").checked
        ? "synthetic_reference"
        : "original_sensitivity",
      processing_mode: "offline",
      notes: $("protocol-notes").value,
    };
  }
  function fillProtocol(protocol) {
    $("experiment-name").value = protocol.name;
    $("research-question").value = protocol.research_question;
    $("protocol-notes").value = protocol.notes;
    $("target-pulse").checked = protocol.target === "pulse_timing";
    $("target-waveform").checked = protocol.target === "waveform_sensitivity";
    $("evaluation-original").checked =
      protocol.evaluation === "original_sensitivity";
    $("evaluation-synthetic").checked =
      protocol.evaluation === "synthetic_reference";
    $("goal").value = protocol.target;
  }
  $("protocol-form").addEventListener("input", (event) => {
    if (opening || importing) return;
    if (
      !experiment &&
      ["target-pulse", "target-waveform"].includes(event.target.id) &&
      [
        defaultQuestion("pulse_timing"),
        defaultQuestion("waveform_sensitivity"),
      ].includes($("research-question").value)
    )
      $("research-question").value = defaultQuestion(draftProtocol().target);
    contextToken++;
    historyToken++;
    saving = false;
    protocolDirty =
      !!experiment &&
      Object.entries(draftProtocol()).some(
        ([key, value]) => experiment.protocol[key] !== value,
      );
    $("goal").value = draftProtocol().target;
    if (protocolDirty) goStep("open", false);
    invalidate("Protocol changed. Start a new experiment to save it.");
    renderHistory();
  });
  async function refreshSessions() {
    const token = ++sessionToken;
    const data = await api("/api/experiments");
    if (token !== sessionToken) return;
    sessionCount = (data.experiments || []).length;
    const list = $("session-list");
    const retained = new Set((data.experiments || []).map((e) => e.id));
    for (const item of [...list.children]) {
      if (!retained.has(item.firstElementChild.dataset.experimentId)) {
        const focused = item.contains(doc.activeElement);
        item.remove();
        if (focused)
          focusNode(
            $("session-dialog")?.open
              ? $("session-dialog-close")
              : $("step-nav-" + step),
          );
      }
    }
    for (const e of data.experiments || []) {
      let button = [...list.querySelectorAll("button")].find(
        (b) => b.dataset.experimentId === e.id,
      );
      if (!button) {
        const item = doc.createElement("li");
        button = doc.createElement("button");
        button.type = "button";
        button.className = "secondary session-item";
        button.dataset.experimentId = e.id;
        for (const name of ["session-name", "session-count", "session-state"]) {
          const span = doc.createElement("span");
          span.className = name;
          button.append(span);
        }
        button.addEventListener("click", () => openExperiment(e.id));
        item.append(button);
        list.append(item);
      }
      button.querySelector(".session-name").textContent = e.protocol.name;
      button.querySelector(".session-count").textContent =
        `${e.run_count} run${e.run_count === 1 ? "" : "s"}`;
    }
    sync();
  }
  $("protocol-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !view ||
      view.recording.modality !== "ppg" ||
      saving ||
      opening ||
      importing ||
      (experiment && !protocolDirty)
    )
      return;
    const protocol = draftProtocol();
    if (!$("protocol-form").reportValidity() || !protocol.name) {
      error("Enter a nonblank experiment name.");
      return;
    }
    if (
      protocol.evaluation === "synthetic_reference" &&
      !view.recording.has_reference
    ) {
      error("This recording has no synthetic reference.");
      return;
    }
    const token = ++contextToken,
      navigation = navigationToken,
      recordingId = view.recording.id;
    saving = true;
    error("");
    sync();
    try {
      const saved = await api("/api/experiments", {
        recording_id: recordingId,
        protocol,
      });
      if (token !== contextToken || view?.recording.id !== recordingId) return;
      experiment = saved;
      runs = saved.runs || [];
      selectedRuns.clear();
      protocolDirty = false;
      saving = false;
      fillProtocol(saved.protocol);
      invalidate("Experiment started. Inspect the original recording.");
      renderHistory();
      if (navigation === navigationToken) goStep("inspect");
      await refreshSessions();
    } catch (e) {
      if (token === contextToken) error(e.message);
    } finally {
      if (token === contextToken) {
        saving = false;
        sync();
      }
    }
  });
  $("current-recording-open").addEventListener("click", () =>
    goStep("inspect"),
  );
  async function openExperiment(id) {
    if (!id || opening || importing) return;
    if (id === experiment?.id) {
      goStep(protocolDirty ? "open" : "inspect");
      if (protocolDirty) showOpening("setup");
      return;
    }
    cancelLoad();
    cancelPreview();
    openingExperimentId = id;
    status("Opening saved experiment...");
    const token = contextToken,
      navigation = navigationToken;
    opening = true;
    sync();
    error("");
    try {
      const [saved, recording] = await Promise.all([
        api(`/api/experiments/${encodeURIComponent(id)}`),
        api(`/api/experiments/${encodeURIComponent(id)}/recording`),
      ]);
      if (token !== contextToken) return;
      opening = false;
      renderRecording(recording);
      experiment = saved;
      runs = saved.runs || [];
      protocolDirty = false;
      fillProtocol(saved.protocol);
      renderHistory();
      sync();
      status(
        "Saved experiment opened. Choose a saved run or make a new comparison.",
      );
      if (navigation === navigationToken) goStep("inspect");
    } catch (e) {
      if (token === contextToken) {
        error(e.message);
        status("Could not open saved experiment. It may have expired.");
      }
    } finally {
      if (token === contextToken) {
        opening = false;
        openingExperimentId = null;
        sync();
      }
    }
  }
  async function refreshHistory(newRunId) {
    if (!experiment) return;
    const id = experiment.id,
      context = contextToken,
      token = ++historyToken;
    try {
      const data = await api(`/api/experiments/${encodeURIComponent(id)}`);
      if (
        token !== historyToken ||
        context !== contextToken ||
        experiment?.id !== id
      )
        return;
      experiment = data;
      runs = data.runs || [];
      renderHistory(newRunId);
      sync();
      await refreshSessions();
    } catch (e) {
      if (token === historyToken && context === contextToken) {
        if (newRunId) revealHistoryRun(newRunId);
        error(e.message);
        text(
          "history-status",
          "Could not refresh saved runs. Reopen the experiment to retry.",
        );
      }
    }
  }
  function restoreRequest(run) {
    const r = run.request || run;
    $("channel").value = r.channel;
    $("window-start").value = r.start_s ?? run.window.start_s;
    $("window-end").value = r.end_s ?? run.window.end_s;
    $("goal").value = experiment.protocol.target;
    const p = r.parameters || run.parameters;
    $("median-window").value = p.median_window_s;
    $("highpass").value = p.highpass_hz;
    $("edge-guard").value = p.edge_guard_s;
  }
  async function viewRun(run) {
    if (!experiment || protocolDirty || opening || importing) return;
    invalidate("Loading saved run...");
    const id = experiment.id,
      context = contextToken,
      token = revision,
      navigation = navigationToken;
    error("");
    try {
      const data = await api(
        `/api/experiments/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}`,
      );
      if (
        context !== contextToken ||
        token !== revision ||
        experiment?.id !== id ||
        protocolDirty
      )
        return;
      restoreRequest(run);
      renderResult(data);
      text(
        "analysis-state",
        `Saved run: ${run.label || data.run_label || run.id}`,
      );
      status(
        "Viewing a saved run with its exact settings. No new calculation was performed.",
      );
      if (navigation === navigationToken) goStep("compare");
      renderHistory();
    } catch (e) {
      if (context === contextToken && token === revision) error(e.message);
    }
  }
  function runScope(run) {
    const p = run.parameters || run.request.parameters;
    return `${run.channel} / [${run.window.start_s}, ${run.window.end_s}) s / median ${p.median_window_s} s / high-pass ${p.highpass_hz} Hz / guard ${p.edge_guard_s} s / ${formatExcludedPercent(run.exclusions.excluded_fraction)} excluded`;
  }
  function renderHistory(newRunId) {
    text(
      "history-status",
      experiment
        ? `${runs.length} / 8 saved runs. Select two to compare measurements.${runs.length >= 8 ? " Run limit reached; start a new experiment for more runs." : ""}`
        : "Start an experiment to save comparisons.",
    );
    $("history-empty").hidden = runs.length > 0;
    text(
      "history-empty",
      experiment
        ? "No saved runs yet. Choose an interval and select Run comparison; each run saves unchanged, median subtraction and high-pass measurements."
        : "Start an experiment, then select Run comparison to save your first run.",
    );
    $("run-history").replaceChildren(
      ...runs.map((run) => {
        const article = doc.createElement("article"),
          label = doc.createElement("label"),
          check = doc.createElement("input"),
          name = doc.createElement("span"),
          scope = doc.createElement("dl"),
          button = doc.createElement("button");
        article.className = "history-row";
        article.classList.toggle("is-current", result?.id === run.id);
        article.dataset.runId = run.id;
        label.className = "run-select";
        check.type = "checkbox";
        check.className = "check";
        check.checked = selectedRuns.has(run.id);
        check.disabled =
          protocolDirty || (!check.checked && selectedRuns.size >= 2);
        check.setAttribute("aria-label", `Compare ${run.label || run.id}`);
        check.addEventListener("change", () => {
          if (check.checked) selectedRuns.add(run.id);
          else selectedRuns.delete(run.id);
          for (const input of $("run-history").querySelectorAll("input"))
            input.disabled =
              protocolDirty || (!input.checked && selectedRuns.size >= 2);
          renderRunComparison();
          guide?.refresh();
        });
        name.textContent = `${run.label || run.id}${result?.id === run.id ? " / currently viewed" : ""}`;
        label.append(check, name);
        scope.className = "run-scope";
        const parameters = run.parameters || run.request.parameters;
        for (const [title, value] of [
          [
            "Channel / interval",
            `${run.channel} / [${run.window.start_s}, ${run.window.end_s}) s`,
          ],
          [
            "Settings",
            `Median ${parameters.median_window_s} s · high-pass ${parameters.highpass_hz} Hz · edge guard ${parameters.edge_guard_s} s`,
          ],
          [
            "Exclusions",
            `${formatExcludedPercent(run.exclusions.excluded_fraction)} excluded · ${count(run.exclusions.valid_count)} / ${count(run.exclusions.sample_count)} valid samples`,
          ],
          [
            "Methods / comparator",
            `Unchanged, median subtraction, high-pass / ${run.comparison === "synthetic_reference" ? "synthetic reference (evaluation only)" : "original samples (change, not accuracy)"}`,
          ],
        ]) {
          const group = doc.createElement("div"),
            term = doc.createElement("dt"),
            detail = doc.createElement("dd");
          term.textContent = title;
          detail.textContent = value;
          group.append(term, detail);
          scope.append(group);
        }
        button.type = "button";
        button.className = "secondary";
        button.textContent = "View run";
        button.disabled = protocolDirty || opening || importing;
        button.setAttribute("aria-label", `View ${run.label || run.id}`);
        button.addEventListener("click", () => viewRun(run));
        article.append(label, scope, button);
        return article;
      }),
    );
    if (newRunId) revealHistoryRun(newRunId);
    renderRunComparison();
  }
  function revealHistoryRun(id) {
    const row = [...$("run-history").children].find(
      (node) => node.dataset.runId === id,
    );
    if (row) revealNew(row);
  }
  function renderRunComparison() {
    text(
      "history-selection",
      `${selectedRuns.size}/2 runs selected for comparison${protocolDirty ? " · save the protocol to compare" : ""}`,
    );
    const selected = runs.filter((run) => selectedRuns.has(run.id)),
      panel = $("run-comparison");
    panel.replaceChildren();
    panel.hidden = selected.length !== 2 || protocolDirty;
    if (panel.hidden) return;
    const [a, b] = selected,
      heading = doc.createElement("h3"),
      note = doc.createElement("p");
    heading.textContent = "Two saved runs / measured side by side";
    const mismatch =
      a.channel !== b.channel ||
      a.window.start_s !== b.window.start_s ||
      a.window.end_s !== b.window.end_s ||
      a.input_sha256 !== b.input_sha256 ||
      a.comparison !== b.comparison;
    note.textContent = mismatch
      ? "Different channels, ranges or comparator inputs: descriptive comparison only. These measurements do not establish improvement."
      : "Same channel, range and comparator input. Measurements describe these runs; no winner is ranked.";
    note.className = mismatch ? "comparison-warning" : "subtle";
    panel.append(heading, note);
    selected.forEach((run) => {
      const p = doc.createElement("p");
      p.textContent = `${run.label || run.id}: ${runScope(run)} / ${run.comparison === "synthetic_reference" ? "compared with synthetic reference (evaluation only)" : "compared with original samples (change, not accuracy)"}`;
      panel.append(p);
    });
    const scroll = doc.createElement("div"),
      table = doc.createElement("table"),
      head = doc.createElement("thead"),
      body = doc.createElement("tbody"),
      tr = doc.createElement("tr");
    scroll.className = "table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Saved run measurements");
    ["Method / measurement", ...selected.map((r) => r.label || r.id)].forEach(
      (value) => {
        const th = doc.createElement("th");
        th.scope = "col";
        th.textContent = value;
        tr.append(th);
      },
    );
    head.append(tr);
    for (const [method, label] of [
      ["unchanged", "Unchanged"],
      ["median", "Median subtraction"],
      ["highpass", "High-pass"],
    ]) {
      for (const [key, metric] of [
        experiment.protocol.target === "pulse_timing"
          ? ["mean_absolute_shift_ms", "Timing shift (ms)"]
          : ["centered_normalized_rmse", "Waveform difference"],
        [
          "unmatched_reference_count",
          selected.every((run) => run.comparison === "synthetic_reference")
            ? "Unmatched reference peaks"
            : selected.every((run) => run.comparison !== "synthetic_reference")
              ? "Unmatched original peaks"
              : "Unmatched peaks (reference / original as above)",
        ],
        ["unmatched_candidate_count", "Unmatched method peaks"],
      ]) {
        const row = doc.createElement("tr"),
          th = doc.createElement("th");
        th.scope = "row";
        th.textContent = `${label} / ${metric}`;
        row.append(th);
        selected.forEach((run) => {
          const td = doc.createElement("td");
          td.textContent = key.endsWith("_count")
            ? count(run.metrics[method]?.[key])
            : formatMeasurement(run.metrics[method]?.[key], key);
          row.append(td);
        });
        body.append(row);
      }
    }
    table.append(head, body);
    scroll.append(table);
    panel.append(scroll);
    const help = doc.createElement("p");
    help.textContent =
      "For all measurements, view a run and select Show technical evidence.";
    panel.append(help);
  }
  $("export-experiment").addEventListener("click", async () => {
    if (!experiment || protocolDirty || !runs.length || opening || importing)
      return;
    const id = experiment.id,
      context = contextToken,
      token = ++exportToken;
    $("export-experiment").disabled = true;
    error("");
    try {
      const blob = await pendingWork(async () => {
        const response = await request(
          `/api/experiments/${encodeURIComponent(id)}/export`,
        );
        if (!response.ok) {
          const data = await response.json();
          throw new Error(formatError(data.detail));
        }
        return response.blob();
      }, "/export");
      if (
        token !== exportToken ||
        context !== contextToken ||
        experiment?.id !== id ||
        protocolDirty
      )
        return;
      const url = URL.createObjectURL(blob),
        a = doc.createElement("a");
      a.href = url;
      a.download = "signaltrace-experiment.json";
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(
        "Experiment JSON download requested with the saved protocol and all retained runs.",
      );
    } catch (e) {
      if (token === exportToken && context === contextToken) error(e.message);
    } finally {
      sync();
    }
  });
  let observer;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      cancelGesture();
      renderPlot();
    });
    observer.observe($("chart"));
  }
  let configurationEpoch = 0;
  async function refreshMetaConfiguration({ both = false } = {}) {
    const token = ++configurationEpoch;
    try {
      const config = await investigationAPI("/api/investigations/config");
      if (destroyed || token !== configurationEpoch) return;
      investigationConfig = config;
      const configured =
        config.available === true && config.key_configured === true;
      text(
        "investigation-config",
        configured
          ? "Server key configured (presence only). Authentication and connection have not been verified. Each run is explicit. Limits: 6 rounds and 8 tool attempts."
          : "Meta investigation is unavailable. Use Set up Meta key to configure this local server process, or continue with local comparison and saved results.",
      );
      text(
        "meta-status",
        configured
          ? "Meta · server configured, connection unverified"
          : "Meta · server key not configured",
      );
      if (both) {
        const explanation = await investigationAPI("/api/explanations/config");
        if (destroyed || token !== configurationEpoch) return;
        explanationConfig = explanation;
        explanationConfigLoaded = true;
      }
    } catch {
      if (destroyed || token !== configurationEpoch) return;
      investigationConfig = null;
      if (both) explanationConfig = null;
      text(
        "investigation-config",
        "Could not read server configuration. Reload to check availability; no Meta request has been made.",
      );
      text("meta-status", "Meta · configuration unavailable");
    }
    if (destroyed || token !== configurationEpoch) return;
    syncInvestigation();
    if (both) syncReport();
  }
  const credentials = createCredentials(doc, request, {
    onBusy: (busy) => {
      if (destroyed) return;
      credentialsChanging = busy;
      syncInvestigation();
    },
    onChange: async () => {
      // A different credential never inherits consent from the previous one.
      $("investigation-consent").checked = false;
      $("explanation-consent").checked = false;
      investigationConfig = null;
      explanationConfig = null;
      syncInvestigation();
      syncReport();
      await refreshMetaConfiguration({ both: true });
    },
  });
  async function init() {
    const initialLoad = loadToken,
      initialPreview = previewToken;
    void refreshMetaConfiguration();
    const credentialStartup = credentials.init();
    try {
      const catalog = await api("/api/catalog");
      $("demo-select").replaceChildren(
        ...catalog.demos.map((d) => option(d.id, d.label)),
      );
      if (catalog.demos.some((d) => d.id === "synthetic_drift_noise"))
        $("demo-select").value = "synthetic_drift_noise";
      await refreshSessions();
      sync();
      if (initialLoad === loadToken && initialPreview === previewToken) {
        status("");
      }
    } catch (e) {
      error(e.message);
      status(
        "The local API is unavailable. Start the SignalTrace server and reload.",
      );
    }
    await credentialStartup;
  }
  guide = createGuide(doc, {
    navigate: goStep,
    state: () => ({
      step,
      openingView,
      retainedSelection,
      explanationSelected,
      view,
      experiment,
      protocolDirty,
      investigationStatus: investigationJobs.get(investigationSelected)?.status,
      investigationPosting,
    }),
  });
  goStep("open", false);
  return {
    init,
    getState: () => ({
      view,
      result,
      step,
      experiment,
      runs,
      protocolDirty,
      openingView,
      retainedSelection,
      explanationSelected,
      displayedWindow: displayedWindow && { ...displayedWindow },
    }),
    destroy: () => {
      destroyed = true;
      configurationEpoch++;
      credentials.destroy();
      retainedRead++;
      explanationEpoch++;
      stopExplanationPoll();
      findings?.destroy();
      findings = null;
      if (retainedDialog.open && retainedDialog.close) retainedDialog.close();
      retainedDialog.removeAttribute("open");
      theme.destroy();
      guide?.destroy();
      reportVisuals.destroy();
      investigationVisuals.destroy();
      comparisonCache.clear();
      investigationEpoch++;
      stopInvestigationPoll();
      cancelGesture();
      loadToken++;
      previewToken++;
      revision++;
      contextToken++;
      historyToken++;
      sessionToken++;
      exportToken++;
      closeLoading();
      win.removeEventListener("pointermove", movePointer);
      win.removeEventListener("pointerup", endPointer);
      win.removeEventListener("pointercancel", cancelPointer);
      win.removeEventListener("resize", cancelGesture);
      win.removeEventListener("resize", resizeLibrary);
      $("request-activity").hidden = true;
      $("keep-working").removeEventListener("click", dismissLoading);
      loadingDialog.removeEventListener("cancel", dismissLoading);
      observer?.disconnect();
      motionPreference?.removeEventListener?.("change", stopMotion);
      for (const animation of animations) animation.cancel();
      animations.clear();
    },
  };
}
if (
  typeof document !== "undefined" &&
  document.getElementById("analysis-form")
) {
  const app = createApp();
  app.init();
}

// Stage presentation only. The existing forms and request handlers own all data.
export function createGuide(doc, { navigate, state }) {
  const $ = (id) => doc.getElementById(id);
  const make = (tag, text, id) => {
    const el = doc.createElement(tag);
    if (text) el.textContent = text;
    if (id) el.id = id;
    return el;
  };
  let destroyed = false;
  const scope = doc.querySelector(".compare-panel");
  const activity = make("p", "", "investigation-activity-summary");
  activity.className = "activity-summary";
  $("investigation-trace").before(activity);
  const finding = make("section", "", "investigation-finding");
  finding.setAttribute("aria-label", "Computed finding");
  $("investigation-result").prepend(finding);

  // Session tools overlay the current stage without discarding the research draft.
  const sessions = make("dialog", "", "session-dialog");
  sessions.hidden = true;
  sessions.setAttribute("aria-labelledby", "sessions-dialog-title");
  const sessionsTitle = make(
    "h2",
    "Session experiments",
    "sessions-dialog-title",
  );
  const close = make("button", "Close session tools", "session-dialog-close");
  close.type = "button";
  close.className = "secondary";
  sessions.append(sessionsTitle, close, $("session-resume"));
  doc.body.append(sessions);
  const sessionsButton = make("button", "Session tools", "guide-sessions");
  sessionsButton.type = "button";
  sessionsButton.className = "secondary";
  sessionsButton.setAttribute("aria-haspopup", "dialog");
  sessionsButton.setAttribute("aria-controls", sessions.id);
  doc.querySelector(".studio-rail").append(sessionsButton);
  function closeSessions() {
    if (sessions.open && typeof sessions.close === "function") sessions.close();
    sessions.removeAttribute("open");
    sessions.hidden = true;
    sessionsButton.focus();
  }
  sessionsButton.addEventListener("click", () => {
    sessions.hidden = false;
    if (typeof sessions.showModal === "function") sessions.showModal();
    else sessions.setAttribute("open", "");
    close.focus();
  });
  close.addEventListener("click", closeSessions);
  sessions.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSessions();
  });
  // Resuming a session retains the existing authoritative source/race handlers.
  $("session-list").addEventListener(
    "click",
    (event) => {
      if (event.target.closest("button")) closeSessions();
    },
    true,
  );
  const brand = doc.querySelector(".brand");
  const openSetup = (event) => {
    event.preventDefault();
    navigate("open");
  };
  brand.addEventListener("click", openSetup);

  function updateColumnRoles() {
    const selected = [
      ...$("signal-columns").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    for (const th of $("preview-table").querySelectorAll("th[data-column]")) {
      const name = th.dataset.column;
      const role =
        name === $("time-column").value
          ? `Time (${$("time-unit").value})${selected.includes(name) ? "; also selected as signal; resolve before import" : ""}`
          : selected.includes(name)
            ? `Channel ${selected.indexOf(name) + 1} (${$("signal-unit").value || "unit needed"})`
            : "Ignored";
      th.replaceChildren(doc.createTextNode(name), make("span", role));
    }
  }
  $("import-form").addEventListener("change", updateColumnRoles);
  $("import-form").addEventListener("input", updateColumnRoles);
  function refresh() {
    if (destroyed) return;
    const current = state();
    updateColumnRoles();
    const error = $("error");
    if (current.step === "open" && current.openingView === "mapping") {
      if (error.parentElement !== $("import-panel"))
        $("import-form").before(error);
    } else if (error.parentElement !== doc.querySelector(".message-area")) {
      doc.querySelector(".message-area").append(error);
    }
    doc.body.dataset.guideStage = current.step;
    sessionsButton.disabled = $("session-resume").hidden;
    scope.hidden = !current.view || current.view.recording.modality !== "ppg";
    if (current.step === "inspect") {
      if (scope.previousElementSibling !== $("inspect-waveform"))
        $("inspect-waveform").after(scope);
    } else if (current.step === "compare") {
      const investigation = $("investigation-panel");
      if (scope.nextElementSibling !== $("compare-waveform"))
        investigation.before(scope, $("compare-waveform"));
    }
  }
  function reveal(node) {
    if (!node) return node;
    // Disclosures open before native validation or async result focus lands.
    for (
      let parent = node.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (parent.tagName === "DETAILS") parent.open = true;
      if (
        parent.classList.contains("expert-panel") ||
        parent.id === "manual-comparison"
      ) {
        parent.hidden = false;
        const toggle = $(parent.id + "-toggle");
        if (toggle) {
          toggle.setAttribute("aria-expanded", "true");
          toggle.textContent = `Hide ${toggle.dataset.label}`;
        }
      }
    }
    const stage = node.closest(".workflow-step");
    if (stage?.hidden) navigate(stage.id.slice(5));
    return node;
  }
  const invalid = (event) => reveal(event.target);
  doc.addEventListener("invalid", invalid, true);
  doc.body.classList.add("research-workbench");
  refresh();
  return {
    refresh,
    reveal,
    destroy() {
      destroyed = true;
      doc.removeEventListener("invalid", invalid, true);
      brand.removeEventListener("click", openSetup);
      $("import-form").removeEventListener("change", updateColumnRoles);
      $("import-form").removeEventListener("input", updateColumnRoles);
      sessions.remove();
      sessionsButton.remove();
    },
  };
}
