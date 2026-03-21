import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export function ensureManualEvalEnv() {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual evals.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
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
    suites
  };
}

export async function writeEvalReport(report: EvalReport) {
  const reportPath =
    process.env.ATLAS_EVAL_REPORT_PATH ??
    path.resolve(process.cwd(), "manual-eval-report.json");

  await mkdir(path.dirname(reportPath), {
    recursive: true
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  return reportPath;
}

export async function writeSuiteEvalReport(suite: EvalSuiteResult) {
  const reportPath =
    process.env.ATLAS_EVAL_REPORT_PATH ??
    path.resolve(process.cwd(), `${suite.suiteName}.manual-eval-report.json`);

  await mkdir(path.dirname(reportPath), {
    recursive: true
  });
  await writeFile(
    reportPath,
    JSON.stringify(buildEvalReport([suite]), null, 2),
    "utf8"
  );

  return reportPath;
}
