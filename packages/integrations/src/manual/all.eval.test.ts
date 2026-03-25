import { beforeAll, describe, expect, it } from "vitest";

import { runConfirmedMutationRecoveryEvalSuite } from "./confirmed-mutation-recovery.eval-suite";
import { runConversationContextEvalSuite } from "./conversation-context.eval-suite";
import { runPlannerEvalSuite } from "./planner.eval-suite";
import { runRouterConfirmationEvalSuite } from "./router-confirmation.eval-suite";
import {
  buildEvalReport,
  ensureManualEvalEnv,
  writeEvalReport,
  writePromptImprovementBriefsForFailures,
} from "./shared";
import { runTurnRouterEvalSuite } from "./turn-router.eval-suite";

beforeAll(() => {
  ensureManualEvalEnv();
});

describe.sequential("manual prompt eval loop", () => {
  it("runs all live prompt eval suites and writes one report", async () => {
    const suites = [
      await runPlannerEvalSuite(),
      await runTurnRouterEvalSuite(),
      await runRouterConfirmationEvalSuite(),
      await runConversationContextEvalSuite(),
      await runConfirmedMutationRecoveryEvalSuite(),
    ];

    const report = buildEvalReport(suites);
    const reportPath = await writeEvalReport(report);
    const briefPaths = await writePromptImprovementBriefsForFailures(suites);

    console.table(
      suites.map((suite) => ({
        suite: suite.suiteName,
        total: suite.total,
        passed: suite.passed,
        failed: suite.failed,
        durationMs: suite.durationMs,
      })),
    );
    console.log(`Manual eval report written to ${reportPath}`);
    if (briefPaths.length > 0) {
      console.log(
        `Prompt improvement briefs written to ${briefPaths.join(", ")}`,
      );
    }

    expect(report.failedCases).toBe(0);
  }, 300_000);
});
