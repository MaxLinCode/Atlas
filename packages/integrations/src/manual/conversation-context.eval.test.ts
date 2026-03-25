import { beforeAll, describe, expect, it } from "vitest";

import { runConversationContextEvalSuite } from "./conversation-context.eval-suite";
import {
  ensureManualEvalEnv,
  writePromptImprovementBrief,
  writeSuiteEvalReport,
} from "./shared";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual conversation context eval", () => {
  it("checks curated continuity cases against the live OpenAI prompts", async () => {
    const suite = await runConversationContextEvalSuite();
    const reportPath = await writeSuiteEvalReport(suite);
    const briefPath =
      suite.failed > 0 ? await writePromptImprovementBrief(suite) : null;

    console.table(
      suite.cases.map((testCase) => ({
        name: testCase.name,
        pass: testCase.pass,
        route: testCase.details.route,
        memorySummary: testCase.details.memorySummary,
        reply: testCase.details.reply,
        error: testCase.error ?? "",
      })),
    );
    console.log(`Manual eval report written to ${reportPath}`);
    if (briefPath) {
      console.log(`Prompt improvement brief written to ${briefPath}`);
    }

    expect(suite.failed).toBe(0);
  }, 120_000);
});
