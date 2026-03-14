import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

loadLocalEnv(path.join(rootDir, "apps/web/.env.local"));
loadLocalEnv(path.join(rootDir, "apps/web/.env.test.local"));
loadLocalEnv(path.join(rootDir, ".env.local"));
loadLocalEnv(path.join(rootDir, ".env.test.local"));

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/atlas_test"
  }
});

function loadLocalEnv(filePath: string) {
  if (existsSync(filePath)) {
    loadEnvFile(filePath);
  }
}
