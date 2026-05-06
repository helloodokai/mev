import * as clack from "@clack/prompts";
import type { EscalationEvent, FrontierPoint } from "../types/index.js";

export interface ReviewPaneResult {
  escalationResolutions: Map<
    string,
    "keep" | "drop" | "edit" | "accept_rephrase" | "keep_original"
  >;
  selectedFrontierIndex: number;
}

export async function showReviewPane(
  escalations: EscalationEvent[],
  frontier: FrontierPoint[],
  kneeIndex: number,
  isYes: boolean,
): Promise<ReviewPaneResult> {
  const resolutions = new Map<
    string,
    "keep" | "drop" | "edit" | "accept_rephrase" | "keep_original"
  >();

  if (isYes) {
    // Accept all defaults
    for (const e of escalations) {
      switch (e.kind) {
        case "position_swap_disagreement":
          resolutions.set(makeKey(e), "keep");
          break;
        case "judge_confidence_below_threshold":
          resolutions.set(makeKey(e), "keep");
          break;
        case "inter_rubric_variance":
          resolutions.set(makeKey(e), "keep_original");
          break;
        case "critic_rejection_rate_elevated":
          resolutions.set(makeKey(e), "keep");
          break;
        case "critic_per_case_uncertainty":
          resolutions.set(makeKey(e), "drop");
          break;
        case "optimizer_plateau":
          resolutions.set(makeKey(e), "keep");
          break;
        case "calibration_drift":
          resolutions.set(makeKey(e), "keep");
          break;
        case "lockin_preflight":
          resolutions.set(makeKey(e), "accept_rephrase");
          break;
      }
    }
    return { escalationResolutions: resolutions, selectedFrontierIndex: kneeIndex };
  }

  clack.intro("mev — Review & Lock-In");

  // Resolve escalations
  const displayEscalations = escalations.filter(
    (e): e is EscalationEvent => e.kind !== "lockin_preflight",
  );

  if (displayEscalations.length > 0) {
    clack.note(`${displayEscalations.length} escalation(s) require review.`, "Escalations");
  }

  for (let i = 0; i < displayEscalations.length; i++) {
    const e = displayEscalations[i]!;
    clack.note(e.details, `Escalation ${i + 1} of ${displayEscalations.length} — ${e.kind}`);

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    switch (e.kind) {
      case "position_swap_disagreement":
        options.push({
          value: "keep",
          label: "Keep both judgments (use majority)",
          hint: "default",
        });
        options.push({ value: "drop", label: "Mark ambiguous and drop" });
        break;
      case "inter_rubric_variance":
        if (e.proposedResolution) {
          options.push({
            value: "accept_rephrase",
            label: `Accept rephrase: ${e.proposedResolution}`,
            hint: "suggested",
          });
        }
        options.push({ value: "keep_original", label: "Keep original wording", hint: "default" });
        break;
      case "critic_per_case_uncertainty":
        options.push({ value: "accept", label: "Accept case", hint: "keep in suite" });
        options.push({ value: "drop", label: "Drop case", hint: "default" });
        break;
      case "critic_rejection_rate_elevated":
        options.push({ value: "keep", label: "Continue with surviving cases", hint: "default" });
        break;
      case "calibration_drift":
        options.push({ value: "keep", label: "Keep judgments, log warning", hint: "default" });
        break;
      case "optimizer_plateau":
        options.push({
          value: "keep",
          label: "Halt evolution, use current frontier",
          hint: "default",
        });
        break;
      default:
        options.push({ value: "keep", label: "Accept default", hint: "default" });
    }

    options.push({ value: "edit", label: "Edit by hand" });

    const choice = await clack.select({
      message: `How to resolve?`,
      options: options.map((o) => {
        const opt: { value: string; label: string; hint: string } = {
          value: o.value,
          label: o.label,
          hint: o.hint ?? "",
        };
        return opt;
      }),
    });

    if (typeof choice === "string") {
      resolutions.set(
        makeKey(e),
        choice as ReviewPaneResult["escalationResolutions"] extends Map<string, infer V>
          ? V
          : never,
      );
    }
  }

  // Final Pareto frontier selection
  clack.note("Select a model+prompt combination.", "Final Pareto Frontier");

  const frontierOptions = frontier.map((p, i) => ({
    value: String(i),
    label: `prompt#${p.promptSha.slice(0, 8)} + ${p.modelAlias.padEnd(20)} ${p.meanScore.toFixed(2).padStart(5)}   $${p.totalCostUsd.toFixed(2).padStart(6)}   p50 ${(p.p95LatencyMs / 2).toFixed(1)}s${i === kneeIndex ? " ★ knee" : ""}`,
  }));

  const selected = await clack.select({
    message: "Pick a winner:",
    options: frontierOptions,
  });

  const selectedIndex = typeof selected === "string" ? Number.parseInt(selected, 10) : kneeIndex;

  const selectedFrontierPoint = frontier[selectedIndex];
  clack.outro(
    `Locked in: prompt#${selectedFrontierPoint?.promptSha.slice(0, 8) ?? "unknown"} + ${selectedFrontierPoint?.modelAlias ?? "unknown"}`,
  );

  return {
    escalationResolutions: resolutions,
    selectedFrontierIndex: Number.isNaN(selectedIndex) ? kneeIndex : selectedIndex,
  };
}

function makeKey(e: EscalationEvent): string {
  return `${e.kind}::${e.caseId ?? ""}::${e.rubricCriterion ?? ""}`;
}
