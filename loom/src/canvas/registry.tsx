import type { ReactNode } from "react";
import type { Dataset } from "../contract/dataset.js";
import type { UiComponentSpec } from "../contract/ui.js";
import { Chart } from "./components/Chart.js";
import { ComparisonTable } from "./components/ComparisonTable.js";
import { Findings } from "./components/Findings.js";
import { SourceList } from "./components/SourceList.js";
import { StatCards } from "./components/StatCards.js";

/**
 * The one place that knows how a `UiComponentSpec` becomes pixels. `spec.type` is a
 * discriminated union tag, so each branch below narrows `spec` for free.
 */
export function renderComponent(spec: UiComponentSpec, dataset: Dataset | undefined): ReactNode {
  switch (spec.type) {
    case "stat_cards":
      return <StatCards spec={spec} />;
    case "comparison_table":
      return <ComparisonTable spec={spec} dataset={dataset} />;
    case "chart":
      return <Chart spec={spec} dataset={dataset} />;
    case "source_list":
      return <SourceList dataset={dataset} />;
    case "findings":
      return <Findings spec={spec} dataset={dataset} />;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}
