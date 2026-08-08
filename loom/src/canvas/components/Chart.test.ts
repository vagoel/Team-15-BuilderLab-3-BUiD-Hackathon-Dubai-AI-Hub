import { describe, expect, it } from "vitest";
import { reportDashAt, reportGrayAt } from "./Chart.js";

describe("report chart series styles", () => {
  it("cycles deterministic grayscale colors and line dashes", () => {
    expect(reportGrayAt(0)).toBe("#1a1a1a");
    expect(reportGrayAt(8)).toBe(reportGrayAt(0));
    expect(reportDashAt(0)).toBeUndefined();
    expect(reportDashAt(1)).toBe("8 4");
    expect(reportDashAt(9)).toBe(reportDashAt(1));
  });

  it("gives each of the first eight series a distinct grayscale value", () => {
    expect(new Set(Array.from({ length: 8 }, (_, index) => reportGrayAt(index))).size).toBe(8);
  });
});
