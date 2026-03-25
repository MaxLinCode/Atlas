import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { confirmedMutationRecoverySystemPrompt } from "../prompts/confirmed-mutation-recovery";
import { conversationMemorySummarySystemPrompt } from "../prompts/conversation-memory-summary";
import { conversationResponseSystemPrompt } from "../prompts/conversation-response";
import { inboxPlannerSystemPrompt } from "../prompts/planner";
import { turnRouterSystemPrompt } from "../prompts/turn-router";

export type EvalCaseResult = {
  name: string;
  pass: boolean;
  details: Record<string, unknown>;
  error?: string;
};

export type EvalSuiteResult = {
  suiteName: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cases: EvalCaseResult[];
};

export type EvalReport = {
  generatedAt: string;
  totalSuites: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  suites: EvalSuiteResult[];
};

const SUITE_PROMPTS: Record<string, string> = {
  planner: inboxPlannerSystemPrompt,
  "turn-router": turnRouterSystemPrompt,
  "router-confirmation": turnRouterSystemPrompt,
  "confirmed-mutation-recovery": confirmedMutationRecoverySystemPrompt,
  "conversation-context": [
    "Conversation Response Prompt:",
    conversationResponseSystemPrompt,
    "",
    "Conversation Memory Summary Prompt:",
    conversationMemorySummarySystemPrompt,
  ].join("\n"),
};

export function ensureManualEvalEnv() {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual evals.");
  }

  process.env.DATABASE_URL ??=
    "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS ??= "123";
}

export function buildEvalReport(suites: EvalSuiteResult[]): EvalReport {
  return {
    generatedAt: new Date().toISOString(),
    totalSuites: suites.length,
    totalCases: suites.reduce((sum, suite) => sum + suite.total, 0),
    passedCases: suites.reduce((sum, suite) => sum + suite.passed, 0),
    failedCases: suites.reduce((sum, suite) => sum + suite.failed, 0),
    suites,
  };
}

export async function writeEvalReport(report: EvalReport) {
  const reportPath =
    process.env.ATLAS_EVAL_REPORT_PATH ??
    path.resolve(process.cwd(), "manual-eval-report.json");

  await mkdir(path.dirname(reportPath), {
    recursive: true,
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  return reportPath;
}

export async function writeSuiteEvalReport(suite: EvalSuiteResult) {
  const reportPath =
    process.env.ATLAS_EVAL_REPORT_PATH ??
    path.resolve(process.cwd(), `${suite.suiteName}.manual-eval-report.json`);

  await mkdir(path.dirname(reportPath), {
    recursive: true,
  });
  await writeFile(
    reportPath,
    JSON.stringify(buildEvalReport([suite]), null, 2),
    "utf8",
  );

  return reportPath;
}

function formatCaseDetails(details: Record<string, unknown>) {
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

function buildPromptImprovementPrompt(suite: EvalSuiteResult) {
  const originalPrompt =
    SUITE_PROMPTS[suite.suiteName] ??
    "Prompt text unavailable for this suite. Inspect the owning prompt module directly.";

  const failedCases = suite.cases.filter((testCase) => !testCase.pass);
  const testResults =
    failedCases.length === 0
      ? "No failing cases."
      : failedCases
          .map((testCase) =>
            [
              `Case: ${testCase.name}`,
              `Details:`,
              formatCaseDetails(testCase.details),
              testCase.error ? `Error: ${testCase.error}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n---\n\n");

  return [
    "You are optimizing a production prompt to improve eval pass rate without breaking its intended behavior.",
    "",
    "You will receive:",
    "- `Original prompt`: the current prompt text",
    "- `Test results`: failing cases, logs, model outputs, and any passing-context clues",
    "",
    "Your job:",
    "1. Diagnose why the prompt underperformed.",
    "2. Identify the smallest prompt changes likely to improve behavior.",
    "3. Rewrite the prompt to improve test performance while preserving the original contract.",
    "4. Avoid brittle edits that only patch one example.",
    "",
    "Working rules:",
    "- Preserve the original intent, role, and task boundary.",
    "- Prefer minimal but high-leverage edits.",
    "- Do not overfit to one failure string.",
    "- Generalize from the failure pattern.",
    "- Keep successful existing behavior intact unless the failures show a real conflict.",
    "- If the test failure suggests a schema or evaluator problem rather than a prompt problem, say so briefly before proposing prompt edits.",
    "",
    "Output exactly in this format:",
    "",
    "Improved prompt:",
    '"""',
    "<full revised prompt>",
    '"""',
    "",
    "Explanation:",
    "- <short bullet explaining the main failure pattern>",
    "- <short bullet explaining the key prompt changes>",
    "- <short bullet explaining why the revision should generalize better>",
    "",
    "Original prompt:",
    '"""',
    originalPrompt,
    '"""',
    "",
    "Test results:",
    '"""',
    testResults,
    '"""',
  ].join("\n");
}

export async function writePromptImprovementBrief(suite: EvalSuiteResult) {
  const briefPath =
    process.env.ATLAS_PROMPT_IMPROVEMENT_PATH ??
    path.resolve(process.cwd(), `${suite.suiteName}.prompt-improvement.md`);

  await mkdir(path.dirname(briefPath), {
    recursive: true,
  });
  await writeFile(briefPath, buildPromptImprovementPrompt(suite), "utf8");

  return briefPath;
}

export async function writePromptImprovementBriefsForFailures(
  suites: EvalSuiteResult[],
) {
  const failedSuites = suites.filter((suite) => suite.failed > 0);

  const briefPaths = await Promise.all(
    failedSuites.map((suite) => writePromptImprovementBrief(suite)),
  );

  return briefPaths;
}
