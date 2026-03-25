import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(rootDir, "../..");
const zodDir = readdirSync(
  path.resolve(rootDir, "../../node_modules/.pnpm"),
).find((entry) => entry.startsWith("zod@"));

if (!zodDir) {
  throw new Error("Could not resolve zod in the pnpm store.");
}

loadLocalEnv(path.join(workspaceRoot, "apps/web/.env.local"));
loadLocalEnv(path.join(workspaceRoot, "apps/web/.env.test.local"));
loadLocalEnv(path.join(workspaceRoot, ".env.local"));
loadLocalEnv(path.join(workspaceRoot, ".env.test.local"));

export default defineConfig({
  resolve: {
    alias: {
      "@atlas/core": path.resolve(rootDir, "../../packages/core/src/index.ts"),
      "@atlas/db": path.resolve(rootDir, "../../packages/db/src/index.ts"),
      "@atlas/integrations": path.resolve(
        rootDir,
        "../../packages/integrations/src/index.ts",
      ),
      zod: path.resolve(
        rootDir,
        `../../node_modules/.pnpm/${zodDir}/node_modules/zod/index.js`,
      ),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    fileParallelism: false,
  },
});

function loadLocalEnv(filePath: string) {
  if (existsSync(filePath)) {
    loadEnvFile(filePath);
  }
}
