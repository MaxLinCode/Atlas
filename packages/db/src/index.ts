export * from "./bot-events";
export * from "./schema";

export type RepositoryHealth = {
  status: "unconfigured";
  message: string;
};

export function getRepositoryHealth(): RepositoryHealth {
  return {
    status: "unconfigured",
    message: "Database repositories are not implemented yet."
  };
}
