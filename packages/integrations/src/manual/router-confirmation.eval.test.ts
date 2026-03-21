import { beforeAll, describe, expect, it } from "vitest";

import { runRouterConfirmationEvalSuite } from "./router-confirmation.eval-suite";
import { ensureManualEvalEnv } from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual router confirmation eval", () => {
  it("checks curated confirmation cases against the live OpenAI prompt", async () => {
    const suite = await runRouterConfirmationEvalSuite();

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

    expect(suite.failed).toBe(0);
  }, 120_000);
});
