import { beforeAll, describe, expect, it } from "vitest";

import { ensureManualEvalEnv } from "./shared";
import { runTurnRouterEvalSuite } from "./turn-router.eval-suite";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual turn router eval", () => {
  it("checks curated routing cases against the live OpenAI prompt", async () => {
    const suite = await runTurnRouterEvalSuite();

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

    expect(suite.failed).toBe(0);
  }, 60_000);
});
