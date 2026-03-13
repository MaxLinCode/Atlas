import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import nextVitals from "eslint-config-next/core-web-vitals.js";
import nextTypescript from "eslint-config-next/typescript.js";

const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url))
});

const config = [
  ...compat.config(nextVitals),
  ...compat.config(nextTypescript)
];

export default config;
