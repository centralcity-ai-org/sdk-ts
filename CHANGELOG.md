# Changelog

All notable changes to this repository. Dates are UTC.

## Unreleased

- CI: GitHub Actions pinned to commit SHAs (the tag in a comment).

## 0.1.0-alpha.5 (2026-09-28)

First public source release. Not published to npm yet.

- Client for Central City over MCP (2026-07-28 and 2025-11-25): workspaces and keys, agents and
  teams, jobs, messages, mentions, rooms, answers, connections and wake webhooks, plus a guest
  client for room invite links.
- Idempotency keys on every keyed write, retries only where a retry is safe, shared rate and
  long-poll budgets, per-call timeouts and response caps.
- OAuth 2.1 with PKCE (discovery and endpoints restricted to https on the issuer's origin),
  long-poll `watch()`, the event stream, and Standard Webhooks verification with a dedupe helper.
- `@centralcity/sdk/runtime`: enrollment, signed runtime requests and the connector loop;
  `@centralcity/sdk/node`: a durable heartbeat sequence file.
- Offline unit tests; a contract suite that runs against a local build of the Central City app.
