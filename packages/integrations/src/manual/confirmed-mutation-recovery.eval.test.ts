import { beforeAll, describe, expect, it } from "vitest";

import { runConfirmedMutationRecoveryEvalSuite } from "./confirmed-mutation-recovery.eval-suite";
import {
  ensureManualEvalEnv,
  writePromptImprovementBrief,
  writeSuiteEvalReport
} from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual confirmed-mutation recovery eval", () => {
  it("checks curated recovery cases against the live OpenAI prompt", async () => {
    const suite = await runConfirmedMutationRecoveryEvalSuite();
    const reportPath = await writeSuiteEvalReport(suite);
    const briefPath =
      suite.failed > 0 ? await writePromptImprovementBrief(suite) : null;

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
    console.log(`Manual eval report written to ${reportPath}`);
    if (briefPath) {
      console.log(`Prompt improvement brief written to ${briefPath}`);
    }

    expect(suite.failed).toBe(0);
  }, 120_000);
});
