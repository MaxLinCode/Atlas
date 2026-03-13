import OpenAI from "openai";

import { getConfig } from "@atlas/core";

export function createOpenAIClient() {
  const config = getConfig();
  return new OpenAI({ apiKey: config.OPENAI_API_KEY });
}
