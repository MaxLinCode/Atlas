import { beforeAll, describe, expect, it } from "vitest";

import { runRouterConfirmationEvalSuite } from "./router-confirmation.eval-suite";
import {
  ensureManualEvalEnv,
  writePromptImprovementBrief,
  writeSuiteEvalReport
} from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual router confirmation eval", () => {
  it("checks curated confirmation cases against the live OpenAI prompt", async () => {
    const suite = await runRouterConfirmationEvalSuite();
    const reportPath = await writeSuiteEvalReport(suite);
    const briefPath =
      suite.failed > 0 ? await writePromptImprovementBrief(suite) : null;

    console.table(
      suite.cases.map((testCase) => ({
        name: testCase.name,
        pass: testCase.pass,
        input: testCase.details.input,
        expected: testCase.details.expected,
        actual: testCase.details.actual,
        reason: testCase.details.reason,
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
