import { beforeAll, describe, expect, it } from "vitest";

import { runConfirmedMutationRecoveryEvalSuite } from "./confirmed-mutation-recovery.eval-suite";
import { ensureManualEvalEnv } from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual confirmed-mutation recovery eval", () => {
  it("checks curated recovery cases against the live OpenAI prompt", async () => {
    const suite = await runConfirmedMutationRecoveryEvalSuite();

    console.table(
      suite.cases.map((testCase) => ({
        name: testCase.name,
        pass: testCase.pass,
        input: testCase.details.input,
        outcome: testCase.details.outcome,
        recoveredText: testCase.details.recoveredText,
        reason: testCase.details.reason,
        userReplyMessage: testCase.details.userReplyMessage,
        error: testCase.error ?? ""
      }))
    );

    expect(suite.failed).toBe(0);
  }, 120_000);
});
