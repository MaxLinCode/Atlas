export * from "./bot-events";
export * from "./conversation-state";
export * from "./google-calendar";
export * from "./planner";
export * from "./schema";

export type RepositoryHealth = {
  status: "configured" | "unconfigured";
  message: string;
};

export function getRepositoryHealth(): RepositoryHealth {
  if (hasConfiguredDatabaseUrl()) {
    return {
      status: "configured",
      message: "Database repositories are configured for Postgres."
    };
  }

  return {
    status: "unconfigured",
    message: "Database repositories require a Postgres DATABASE_URL outside tests."
  };
}

function hasConfiguredDatabaseUrl(url = process.env.DATABASE_URL) {
  return typeof url === "string" && /^postgres(ql)?:\/\//.test(url);
}
