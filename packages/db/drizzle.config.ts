import { defineConfig } from "drizzle-kit";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "packages/db/drizzle.config.ts requires DATABASE_URL in the environment. Run Drizzle commands from packages/db or via `pnpm --filter @atlas/db ...` with DATABASE_URL already set."
  );
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl
  }
});
