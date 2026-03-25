import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const zodDir = readdirSync(
  path.resolve(rootDir, "../../node_modules/.pnpm"),
).find((entry) => entry.startsWith("zod@"));

if (!zodDir) {
  throw new Error("Could not resolve zod in the pnpm store.");
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
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
    include: ["src/**/*.test.ts"],
  },
});
