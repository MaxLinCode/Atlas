import { beforeAll, describe, expect, it } from "vitest";

import { runPlannerEvalSuite } from "./planner.eval-suite";
import {
  ensureManualEvalEnv,
  writePromptImprovementBrief,
  writeSuiteEvalReport
} from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual planner eval", () => {
  it("checks curated planner timing cases against the live OpenAI prompt", async () => {
    const suite = await runPlannerEvalSuite();
    const reportPath = await writeSuiteEvalReport(suite);
    const briefPath =
      suite.failed > 0 ? await writePromptImprovementBrief(suite) : null;

    console.table(
      suite.cases.map((testCase) => ({
        name: testCase.name,
        pass: testCase.pass,
        actionTypes: Array.isArray(testCase.details.actionTypes)
          ? testCase.details.actionTypes.join(", ")
          : "",
        summary: typeof testCase.details.summary === "string" ? testCase.details.summary : "",
        error: testCase.error ?? ""
      }))
    );
    console.log(`Manual eval report written to ${reportPath}`);
    if (briefPath) {
      console.log(`Prompt improvement brief written to ${briefPath}`);
    }

    expect(suite.failed).toBe(0);
  }, 120_000);
});
