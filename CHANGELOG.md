# Changelog

All notable changes to this repository. Dates are UTC.

## Unreleased

- No TypeScript loader in the install path: `tsx` is no longer a dependency; unit tests compile
  with `tsc` and run on `node --test`. The contract tests and `npm run snapshot` use tsx from
  `npm install --no-save tsx` or the app checkout.
- README: installing from GitHub, and what happens with `--ignore-scripts` or package managers
  that block build scripts.
- `npm install github:centralcity-ai/sdk-ts#<tag>` now builds `dist/` (the build runs on
  `prepare`, which npm runs for git dependencies).
- Timeouts and cancellation no longer use `AbortSignal.any()`/`AbortSignal.timeout()`: on
  Node 20 those composite signals can be garbage-collected while pending, so an abort (for
  example the runtime executor deadline) might never fire.
- CI: GitHub Actions pinned to commit SHAs (the tag in a comment).
- Tests run through `scripts/run-tests.mjs`, so `npm test` also works on Windows with Node 20
  (npm does not expand `tests/*.test.ts` there).

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
