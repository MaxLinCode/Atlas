import { beforeAll, describe, expect, it } from "vitest";

import {
  ensureManualEvalEnv,
  writePromptImprovementBrief,
  writeSuiteEvalReport
} from "./shared";
import { runTurnRouterEvalSuite } from "./turn-router.eval-suite";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual turn router eval", () => {
  it("checks curated routing cases against the live OpenAI prompt", async () => {
    const suite = await runTurnRouterEvalSuite();
    const reportPath = await writeSuiteEvalReport(suite);
    const briefPath =
      suite.failed > 0 ? await writePromptImprovementBrief(suite) : null;

    console.table(
      suite.cases.map((testCase) => ({
        name: testCase.name,
        pass: testCase.pass,
        expected: testCase.details.expected,
        actual: testCase.details.actual,
        reason: testCase.details.reason,
        note: testCase.details.note,
        error: testCase.error ?? ""
      }))
    );
    console.log(`Manual eval report written to ${reportPath}`);
    if (briefPath) {
      console.log(`Prompt improvement brief written to ${briefPath}`);
    }

    expect(suite.failed).toBe(0);
  }, 60_000);
});
