# Scripts

Use this directory for local helpers that support development workflows but are not part of the product runtime.

- keep scripts idempotent where possible
- prefer TypeScript or shell for transparent maintenance
- document any script that changes local or remote state
- `db-test-start.sh`, `db-test-reset.sh`, and `db-test-stop.sh` manage the local Homebrew Postgres integration-test database workflow
