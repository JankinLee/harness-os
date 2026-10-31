# HarnessOS

> A meta-harness that turns Feishu topic groups into an auditable Claude Code / Codex delivery bus.

[![CI](https://github.com/JankinLee/harness-os/actions/workflows/ci.yml/badge.svg)](https://github.com/JankinLee/harness-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

HarnessOS is not another agent framework. It is a **thin, event-driven host** that orchestrates existing coding CLIs (Claude Code and Codex) as headless workers. A Feishu topic group is the UI; each topic maps to an isolated CLI session and a workspace; deterministic gates, human approval cards, and a persistent flow log keep the loop auditable.

This repository is the **stable single-team edition**. Multi-team orchestration is not part of this release.

## Why it exists

- Coding CLIs are powerful, but they are stateless processes. Exposing them directly to a chat surface makes permissions, recovery, and audit hard.
- HarnessOS keeps the host thin: it routes messages, assembles context, gates tool calls, renders cards, and persists state. The CLI does the actual reasoning and editing.
- High-risk operations stop at a human approval card. Read-only recon is enforced before execution, not after the damage is done.
- Every collaboration hop can carry a context capsule and a lineage node, so a later failure can be traced back to the hop that introduced it.

## Demo

A 30–60 second recording is the fastest way to understand the system:

1. A human posts a task in a Feishu topic group.
2. The leader bot dispatches it to a product bot.
3. A clarification card appears when the request is ambiguous.
4. A high-risk operation stops at an approval card.
5. The result returns to the same topic with a delivery card.

The demo GIF/video will be linked here with the first public release. Until then, `pnpm demo:server` provides a local fault-injection server for experimenting with the logging and patrol path.

## Features

- **Feishu topic groups as sessions** — one topic = one CLI session = one workspace; switching workspace tears down the old CLI session.
- **Claude Code / Codex adapters** — the host is engine-agnostic; both engines speak the same MCP tool contract.
- **MCP tool gateway** — terminal control tools are exposed through a local MCP server and filtered by a single RBAC source.
- **Human-in-the-loop cards** — clarification, approval, arbitration, technical review, and delivery cards are first-class state machines.
- **Product spec lifecycle** — `pending → in_development → delivered → archived`, with stall and archive sweeps.
- **Collaboration safety** — bounded chain hops, dialectic rounds, dynamic escalation, arbitration, and a circuit breaker.
- **Workspace isolation** — read/write locks, heartbeat, adaptive extension, git worktree isolation, and content-level recon verification.
- **Runaway detection** — normalized fingerprints, period-aware sliding windows, warning/critical/breaker levels.
- **Context capsules** — bounded handoff payloads plus immutable lineage nodes for audit.
- **Scheduling** — one-shot, fixed-interval, and cron tasks.
- **Scratch lifecycle** — inspect, sweep, and archive stalled local workspaces.

## Architecture

```mermaid
flowchart LR
  U[Human in a Feishu topic group] --> G[Lark gateway<br/>long connection]
  G --> R[Session + workspace resolver]
  R --> P[Prompt builder<br/>L0 axioms + team roster + workspace probe]
  P --> C[CLI adapter<br/>Claude Code / Codex]
  C --> T[MCP tool gateway<br/>dispatch / clarify / approve / review / arbitrate]
  T --> G
  C --> D[(JSON stores<br/>data/)]
  T --> D
  D --> S[Scheduler + lifecycle sweeps]
  S --> G
```

The host is deliberately small. It does not reimplement an agent loop; it owns the parts a CLI cannot own safely:

- **Routing**: which bot, topic, workspace, and engine should handle a message.
- **Context**: which static prefix, team roster, workspace assets, and handoff capsule the CLI sees.
- **Gates**: RBAC, read-only recon, approval, collaboration bounds, and runaway detection.
- **State**: sessions, flows, approvals, schedules, capsules, and lifecycle transitions.
- **Rendering**: Feishu cards and thread replies.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the component map, message flow, state machines, and design decisions.

## Quick start

### Prerequisites

- Node.js **22+** and pnpm **8+**.
- At least one Feishu custom app with bot capability (one app per configured bot is the simplest setup).
- Claude Code and/or Codex CLI installed and authenticated on the host.
- Optional: `lark-cli` plus the `lark-doc` / `lark-drive` / `lark-wiki` skills if you want Feishu Docs/Wiki delivery. Without them, use local delivery.

### Run locally

```bash
pnpm install
cp .env.example .env
cp config/bots.local.example.json config/bots.json   # local delivery, no lark-cli required
# fill in the Feishu app credentials, TEST_CHAT_ID, and OWNER_OPEN_ID in .env
pnpm test
pnpm build
pnpm start
```

For Feishu Docs/Wiki delivery, start from `config/bots.example.json` instead and follow [`docs/SETUP.md`](docs/SETUP.md). It includes the full system prompts, the optional `lark-*` skills, and the `<your-wiki-space-id>` placeholder.

The `harness-os` helper CLI can check the local environment:

```bash
pnpm harness-os doctor
```

`doctor` checks Node, pnpm, PM2, Claude Code, Codex, `.env`, and `config/bots.json`.

### Feishu setup

You need, for each bot app:

- Bot capability enabled.
- The app added to the target topic group.
- Event subscription over the long connection for `im.message.receive_v1` and `card.action.trigger`.
- `drive.notice.comment_add_v1` if you want document-comment routing.
- The permissions required by the SDK calls in `src/im/lark.ts` (IM messages, drive comments, and — only if using lark-doc — docs/wiki).

See [`docs/SETUP.md`](docs/SETUP.md) for the step-by-step configuration and troubleshooting.

## Configuration & thresholds

These are the defaults at `v0.1.0`. Some are environment-configurable; others are compile-time constants. If you change one, update this table and the test that guards it.

### Collaboration and approval

| Setting | Default | Where | Notes |
|---|---:|---|---|
| `collaborationMaxRounds` (per bot) | 16 (range 1–32) | `config/bots.json`, `src/core/bot-registry.ts` | Total hops in one collaboration chain. Hitting the limit terminates the chain. |
| `NEGOTIATION_MAX_ROUNDS` | 3 | `src/core/collaboration.ts` | Product ↔ developer dialectic rounds on the same spec. Hitting the limit enters arbitration. |
| `MAX_TASK_ESCALATIONS` | 2 | `src/core/collaboration.ts` | Dynamic tier upgrades before the chain is circuit-broken to arbitration. |
| `ARBITRATION_SUSPEND_MS` | 24 h | `src/core/collaboration.ts` | Human arbitration suspension window before a timeout decision. |
| `ARBITRATION_PRELIMINARY_TTL_MS` | 30 min | `src/app/arbitration-runner.ts` | Time window for the leader's preliminary arbitration verdict. |
| `TECH_REVIEW_IDLE_TTL_MS` | 6 h | `src/core/collaboration.ts` | Idle time before a pending technical-review flow is considered orphaned. |
| Approval default timeout | 300 s (request range 60–3,600 s) | `src/core/approval.ts` | High-risk operation approval card. Timeout is fail-safe: the operation is rejected. |
| Approval field limits | detail 2,000; impact 500; rollback 500 chars | `src/core/approval.ts` | Request schema limits. |

### Lifecycle and workspace

| Setting | Default | Where | Notes |
|---|---:|---|---|
| `LIFECYCLE_STALE_MS` | 7 days | `src/core/product-spec.ts` | `in_development` flow with no activity enters stall/quarantine. |
| `LIFECYCLE_ARCHIVE_MS` | 14 days | `src/core/product-spec.ts` | Delivered flow with no acceptance is auto-archived. |
| `DEFAULT_WORKSPACE_LOCK_TIMEOUT_MS` | 300 s | `src/core/workspace-lock-manager.ts` | Time a writer waits for the workspace lock. |
| `ADAPTIVE_CHECK_WINDOW_MS` | 240 s | `src/core/workspace-lock-manager.ts` | Window used to decide whether a lock holder is still active. |
| `HEARTBEAT_ACTIVE_THRESHOLD_MS` | 60 s | `src/core/workspace-lock-manager.ts` | A heartbeat within this window counts as active. |
| `ADAPTIVE_EXTENSION_MS` | 300 s | `src/core/workspace-lock-manager.ts` | Extension granted when the holder is active. |
| `MAX_AUTO_RENEW_COUNT` | 2 | `src/core/workspace-lock-manager.ts` | Maximum automatic lock renewals. |
| `MAX_DIFF_BUFFER` | 16 MiB | `src/core/workspace-change-probe.ts` | Maximum diff buffer for content-level recon verification. |

### CLI execution

| Setting | Default | Where | Notes |
|---|---:|---|---|
| CLI run timeout | 2 h | `src/cli/runner.ts`; `CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`, `CLI_TIMEOUT_MS` | Per-run wall-clock limit. |
| CLI silent timeout | 5 min | `src/cli/runner.ts`; `CLAUDE_SILENT_TIMEOUT_MS`, `CODEX_SILENT_TIMEOUT_MS`, `CLI_SILENT_TIMEOUT_MS` | Kills a CLI process that produces no output for this long. |
| Native session list limit | 8 | `src/cli/native-sessions.ts` | Number of recent CLI sessions listed. |
| Native session request timeout | 15 s | `src/cli/native-sessions.ts` | Timeout for native session metadata requests. |

### Runaway detection and context

| Setting | Default | Where | Notes |
|---|---:|---|---|
| Runaway window size | 24 invocations | `src/core/runaway-detector.ts` | Sliding window of normalized tool-call fingerprints. |
| Period 1 thresholds | warning 2 / critical 3 / breaker 3 | `src/core/runaway-detector.ts` | Same tool call (including result) repeated. Breaker requires a failure in the cycle. |
| Period 2–3 thresholds | warning 2 / critical 3 / breaker 4 | `src/core/runaway-detector.ts` | Ping-pong patterns. Breaker requires a failure in the cycle. |
| Context warning | 80% of the CLI context window | `src/index.ts` | Sends a yellow warning card once per session. |
| Capsule character budget | 2,000 chars | `src/core/collaboration.ts` | Total context capsule budget. |
| Capsule constraints budget | 600 chars | `src/core/collaboration.ts` | Constraints section inside the capsule. |
| Experience / friction threshold | 3 hits | `src/core/experience-settlement.ts` | A candidate becomes eligible for settlement after three hits. |

### Scheduling

| Setting | Default | Where | Notes |
|---|---:|---|---|
| Interval rule | 60 s – 24 h | `src/core/schedule.ts` | `everyMs` bounds for fixed-interval tasks. |
| Schedule prompt max | 2,000 chars | `src/core/schedule.ts` | Task prompt limit. |
| Cron expression max | 100 chars | `src/core/schedule.ts` | Cron expression limit. |
| Default timezone | `Asia/Shanghai` | `src/core/schedule.ts` | Cron timezone default. |
| `addMany` batch max | 20 | `src/core/schedule.ts` | Maximum schedules per bulk add. |
| `removeMany` batch max | 100 | `src/core/schedule.ts` | Maximum schedules per bulk remove. |
| Run history per schedule | 100 | `src/core/schedule-run-store.ts` | Retained scheduled-run records. |
| Once grace | 5 min | `src/app/scheduler.ts` | Grace window for one-shot tasks. |
| Schedule API port | 3101 | `src/index.ts`, `src/mcp/app-tools-server.ts`; `SCHEDULE_API_PORT` | Local scheduling API. Set `SCHEDULE_API_TOKEN` to require a bearer token. |

### Cards and Feishu limits

| Setting | Default | Where | Notes |
|---|---:|---|---|
| Card answer max | 6,000 chars | `src/im/card.ts` | Full answer rendered on a card. |
| Compact answer max | 900 chars | `src/im/card.ts` | Compact rendering for long answers. |
| Running activity limit | 3 | `src/im/card.ts` | Activity rows while a task is running. |
| Finished activity limit | 8 | `src/im/card.ts` | Activity rows after completion. |
| Schedule summary limit | 600 chars | `src/im/card.ts` | Schedule card summary. |
| Card update throttle | 1 s | `src/im/card.ts` (`ThrottledCardUpdater`) | Minimum interval between card updates. |
| Feishu text limit | 3,000 chars | `src/im/lark.ts` | Text message chunk limit. |
| Feishu mention limit | 1,200 chars | `src/im/lark.ts` | Mention payload limit. |
| Feishu comment limit | 1,000 chars | `src/im/lark.ts` | Document comment limit. |
| Document comment dedup window | 1,000 events | `src/index.ts` | Remembered comment event IDs. |

### Scratch and local state

| Setting | Default | Where | Notes |
|---|---:|---|---|
| `SCRATCH_STALE_DAYS` | 7 days | `src/app/scratch-survey.ts` | Stalled scratch directories eligible for sweep/archive. |

### Environment variables

| Variable | Purpose |
|---|---|
| `BOTS_CONFIG` | Path to the bot registry file; default `config/bots.json`. |
| `FEISHU_<ROLE>_APP_ID` / `_APP_SECRET` | Credentials for each bot app. The exact names are declared in `bots.json` via `appIdEnv` / `appSecretEnv`. |
| `TEST_CHAT_ID` | Topic-group chat id used during setup. |
| `OWNER_OPEN_ID` | Human owner open id; receives result notifications. |
| `ADMIN_OPEN_IDS` | Comma-separated admin open ids for emergency abort/management operations. |
| `CLI_WORKDIR` | Fallback workspace when `bots.json` does not specify one. |
| `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` / `CLI_TIMEOUT_MS` | CLI run timeout overrides. |
| `CLAUDE_SILENT_TIMEOUT_MS` / `CODEX_SILENT_TIMEOUT_MS` / `CLI_SILENT_TIMEOUT_MS` | Silent CLI kill timeout overrides. |
| `SCHEDULE_API_PORT` / `SCHEDULE_API_TOKEN` | Local scheduling API port and bearer token. |
| `PATROL_WEBHOOK_URL` | Optional webhook for auth/patrol notifications. |
| `CLAUDE_CONFIG_DIR` | Optional Claude Code config directory override. |

The full schema is in `src/core/bot-registry.ts` and `src/core/schedule.ts`. Ambient runtime settings are read in `src/index.ts`.

## Safety model

- **Single RBAC source** — `src/core/tool-rbac.ts` decides which terminal tools a role may call. The MCP layer and the host use the same source.
- **Pre-execution enforcement** — read-only recon puts `Write`/`Edit`-style tools in the CLI stop list before the process runs. Post-hoc git fingerprint verification is a fallback, not the gate.
- **Content-level verification** — recon verification hashes `git diff HEAD`, not only `git status --porcelain`, so rewriting an already-dirty file is still detected.
- **Human approval for irreversible actions** — killing external services, `rm -rf`, force-push/reset, destructive database changes, and similar operations must go through `request_approval`.
- **Bounded collaboration** — chain hops, dialectic rounds, and dynamic escalations each have independent limits. Hitting a limit terminates or escalates; it never silently continues.
- **Workspace isolation** — write locks, read/write locks, heartbeat, and optional git worktrees keep concurrent sessions from corrupting each other.
- **Runaway detection** — normalized fingerprints make timestamps, paths, ids, and metrics volatile; a repeated pattern can trigger warning, critical, or breaker.

Known limits are documented below. In particular, HarnessOS does **not** provide an OS-level sandbox; approval gates and CLI stop lists are the primary controls.

## Engineering lessons

Most agent projects show the happy path. This one keeps a failure log. The public edition includes selected postmortems; each is written as **symptom → root cause → fix → regression test** so the fix is anchored in code, not in prose.

Three examples:

- A guardrail that sets a flag and then keeps executing is not a guardrail. Rejections must be a pure function plus a `return` at the call site.
- A persistence schema that omits an interface field will silently drop it: zod strips unknown keys by default. Compare every field, or derive the type from the schema.
- A post-hoc circuit breaker is an incident report, not a gate. If the cost of the damage is irreversible, the enforcement must happen before the tool runs.

Read the selected lessons in [`docs/LESSONS.md`](docs/LESSONS.md). The author's private deployment keeps a larger error book; it is not part of this release.

## Limitations

- **Single-team edition.** The multi-team/dynamic-team orchestration developed after this release is not included.
- **Fixed role ids.** RBAC and leader instructions currently key on `ceo-assistant`, `product`, and `developer`. Renaming a role requires updating `src/core/tool-rbac.ts`, `src/core/team-registry.ts`, and their tests.
- **Feishu/Lark only.** The IM gateway is isolated in `src/im`, but no other chat adapter ships in `v0.1.0`.
- **Windows-first.** The host is developed and used on Windows. Linux/macOS are covered by the core test suite and CI, but Windows-specific process-tree behavior is the primary path.
- **Single host.** State is JSON files under `data/`; there is no distributed queue, multi-tenant isolation, or horizontal scaling.
- **External engines required.** You must install and authenticate Claude Code and/or Codex. HarnessOS does not bundle model access.
- **Optional Feishu Docs/Wiki path.** `lark-cli` and the `lark-*` skills are not bundled. Local delivery works without them.
- **No OS-level sandbox.** Prompt injection and CLI tool misuse remain risks. Use least-privilege Feishu apps, keep approvals on, and review the CLI stop lists.
- **No telemetry.** Runtime data stays on your machine; nothing is sent to the author.

## Project status

`v0.1.0` is the first public, stable single-team edition, derived from the author's private stable baseline. It is used daily on a real Feishu workflow, but the public API and configuration may still change in `0.x`.

Planned work (not commitments):

- Multi-team orchestration.
- Additional IM adapters.
- Stronger sandboxing and egress controls.
- A local mock Feishu adapter for credential-free demos.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. The two non-negotiables are:

1. No secrets in the repository.
2. Tests must be hermetic: use `mkdtempSync`/`tmpdir()` and clean up in `finally`.

For security issues, use [`SECURITY.md`](SECURITY.md) instead of a public issue.

## License

MIT. See [`LICENSE`](LICENSE). Third-party notices, including the MIT-licensed skills adapted from Matt Pocock's repository, are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Acknowledgements

- [Matt Pocock's skills](https://github.com/mattpocock/skills) for the `to-spec`, `to-tickets`, and `grill-me` skill lineage.
- [Anthropic Claude Code](https://claude.com/claude-code) and [OpenAI Codex](https://openai.com/codex/) as the execution engines.
- The Feishu/Lark Open Platform SDK for the IM gateway.
