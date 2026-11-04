"""Researcher-confirmed limits evaluated only against measured original sensitivity."""
from copy import deepcopy
import math

COMPARISON_POLICY = "float_roundoff_v1"
LEGACY_COMPARISON_POLICY = "strict_legacy"
CRITERIA = {
    "max_timing_shift_ms": ("Maximum absolute matched-candidate shift", "ms"),
    "max_unmatched_candidates": ("Total unmatched method and original candidates", "candidates"),
    "min_usable_fraction": ("Common usable selected-sample fraction", "fraction"),
    "max_waveform_difference": ("Centered normalized waveform difference", "normalized"),
}
LIMITATIONS = [
    "Limits are entered and confirmed by the researcher, not supplied as clinical thresholds.",
    "Assessment covers only each exact tested recipe and selected interval; it does not certify a method or unseen settings.",
    "Original-waveform sensitivity does not establish accuracy, denoising benefit or physiological preservation.",
    "Usable fraction measures the shared deterministic analysis mask, not signal quality or artifact absence.",
    "Unchanged remains a control and cannot satisfy a requested processing method by construction.",
]


def validate_requirements(value):
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != {"confirmed", "method", "criteria"}
            or value["confirmed"] is not True or value["method"] not in ("median", "highpass")):
        raise ValueError("Confirm a processing method and at least one explicit measurement limit")
    criteria = value["criteria"]
    if not isinstance(criteria, dict) or not criteria or set(criteria) - set(CRITERIA):
        raise ValueError("Enter at least one supported measurement limit")
    for key, limit in criteria.items():
        if (not _finite(limit)
                or key == "max_unmatched_candidates" and type(limit) is not int
                or key == "min_usable_fraction" and limit > 1):
            raise ValueError("Measurement limits must be finite and within their supported bounds")
    return deepcopy(value)


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def comparison_policy_for_assessment(assessment):
    """Absent policy means historical strict arithmetic, never a silent upgrade."""
    if not isinstance(assessment, dict):
        raise ValueError("Invalid requirement assessment")
    policy = assessment.get("comparison_policy", LEGACY_COMPARISON_POLICY)
    if policy not in (COMPARISON_POLICY, LEGACY_COMPARISON_POLICY):
        raise ValueError("Unsupported requirement comparison policy")
    return policy


def limit_satisfied(metric, value, limit, *, comparison_policy=COMPARISON_POLICY):
    """Compare available finite measurements; the assessment owns missing evidence."""
    if comparison_policy not in (COMPARISON_POLICY, LEGACY_COMPARISON_POLICY):
        raise ValueError("Unsupported requirement comparison policy")
    if metric not in CRITERIA or not _finite(value) or not _finite(limit):
        raise ValueError("A supported metric and finite measurement/limit are required")
    strict = value >= limit if metric == "min_usable_fraction" else value <= limit
    return strict or (comparison_policy == COMPARISON_POLICY and metric != "max_unmatched_candidates"
                      and math.isclose(value, limit, rel_tol=1e-12,
                                       abs_tol=1e-9 if metric == "max_timing_shift_ms" else 1e-12))


def assess_requirements(requirements, evidence, window, *, investigation_failed=False,
                        comparison_policy=COMPARISON_POLICY):
    """Inclusive limits allow only versioned arithmetic roundoff, not scientific slack.

    Timing uses abs_tol=1e-9 ms; fractions and normalized differences use 1e-12.
    All floating comparisons use rel_tol=1e-12. Candidate counts remain exact.
    strict_legacy reproduces pre-policy v3 assessments, including their old shape.
    """
    if comparison_policy not in (COMPARISON_POLICY, LEGACY_COMPARISON_POLICY):
        raise ValueError("Unsupported requirement comparison policy")
    requirements = validate_requirements(requirements)
    if requirements is None:
        return None
    method, criteria = requirements["method"], requirements["criteria"]
    if not isinstance(evidence, dict):
        raise ValueError("Invalid measurement evidence")
    rows = []
    for eid, observation in evidence.items():
        if not isinstance(observation, dict):
            raise ValueError("Invalid measurement evidence")
        if observation.get("kind") != "comparison":
            continue
        measured = observation.get("metrics", {})
        if not isinstance(measured, dict) or not isinstance(measured.get(method, {}), dict):
            raise ValueError("Invalid measurement evidence")
        metrics = measured.get(method, {})
        full = observation.get("window") == window and observation.get("evaluation") == "original_sensitivity"
        samples, valid = observation.get("sample_count"), observation.get("valid_count")
        usable = valid / samples if type(samples) is int and type(valid) is int and 0 <= valid <= samples and samples > 0 else None
        unmatched = (metrics.get("unmatched_candidate_count"), metrics.get("unmatched_comparator_count"))
        values = {
            "max_timing_shift_ms": metrics.get("maximum_absolute_shift_ms") if _finite(metrics.get("matched_count")) and metrics.get("matched_count", 0) > 0 else None,
            "max_unmatched_candidates": sum(unmatched) if all(type(v) is int and v >= 0 for v in unmatched) else None,
            "min_usable_fraction": usable,
            "max_waveform_difference": metrics.get("centered_normalized_rmse"),
        }
        checks = []
        for key in CRITERIA:
            if key not in criteria:
                continue
            value, limit = values[key], criteria[key]
            reason = None
            if not full:
                status, reason = "not_established", "Only an original-sensitivity comparison of the full selected interval is eligible."
            elif not _finite(value):
                value, status, reason = None, "not_established", "This measurement is unavailable; missing evidence is never treated as zero."
            else:
                strict = value >= limit if key == "min_usable_fraction" else value <= limit
                passed = limit_satisfied(key, value, limit, comparison_policy=comparison_policy)
                if passed and not strict:
                    reason = "Inclusive limit met within arithmetic roundoff tolerance; the exact measured value is retained."
                status = "met" if passed else "violated"
                if not passed:
                    reason = "This tested recipe falls outside the confirmed limit."
            checks.append(dict(metric=key, label=CRITERIA[key][0], limit=limit, value=value,
                               status=status, unit=CRITERIA[key][1], reason=reason))
        statuses = {check["status"] for check in checks}
        status = "violated" if "violated" in statuses else "not_established" if "not_established" in statuses else "met"
        rows.append(dict(comparison_id=eid, method=method, parameters=deepcopy(observation["parameters"]),
                         window=deepcopy(observation["window"]), status=status, checks=checks))
    eligible = [row for row in rows if row["window"] == window]
    met = [row["comparison_id"] for row in eligible if row["status"] == "met"]
    status = ("not_established" if investigation_failed else "met" if met else
              "violated" if eligible and all(row["status"] == "violated" for row in eligible) else "not_established")
    action = ("Review the exact passing recipe and its evidence; other settings and downstream accuracy remain untested."
              if status == "met" else
              "No tested full-window recipe meets all confirmed limits. Review failed checks and test a justified setting within the remaining budget."
              if status == "violated" else
              "Resolve missing full-window measurements or the investigation failure before deciding whether the confirmed limits are met.")
    assessment = dict(status=status, comparisons=rows, met_comparison_ids=met, next_action=action,
                      limitations=deepcopy(LIMITATIONS))
    if comparison_policy == COMPARISON_POLICY:
        assessment["comparison_policy"] = comparison_policy
        assessment["limitations"].append("Inclusive floating limits allow only arithmetic roundoff (relative 1e-12; absolute 1e-9 ms for timing and 1e-12 for fraction/normalized difference); this is not a scientific tolerance. Counts are exact.")
    return assessment
