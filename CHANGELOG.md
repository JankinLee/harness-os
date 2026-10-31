# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic versioning for the public edition.

## [0.1.0] - 2026-10-31

### Added

- First public, stable single-team edition, derived from the author's pre-multi-team baseline.
- Feishu topic-group gateway with long-connection event handling.
- Claude Code and Codex CLI adapters with streamed progress events.
- MCP terminal-tool gateway with a single RBAC source.
- Clarification, approval, arbitration, technical-review, and delivery cards.
- Product spec lifecycle with stall quarantine and auto-archive sweeps.
- Bounded collaboration: chain hops, dialectic rounds, dynamic escalation, arbitration.
- Workspace read/write locks, heartbeat, adaptive extension, and content-level recon verification.
- Runaway detection with normalized fingerprints and period-aware thresholds.
- Context capsules and immutable lineage nodes.
- Scheduling: once, interval, and cron.
- Scratch lifecycle: survey, sweep, and archive.
- Local demo server for fault injection and patrol experiments.
- Public architecture, setup, methodology, and engineering-lessons documents.
- GitHub Actions CI for Ubuntu and Windows on Node 22 and 24.
- MIT license and third-party notices.

### Known limitations

- Single-team only; multi-team/dynamic-team orchestration is not included.
- Feishu/Lark is the only IM adapter.
- Single host; JSON persistence; no horizontal scaling.
- No OS-level sandbox.
- Feishu Docs/Wiki delivery requires optional `lark-cli` and lark skills.

### Security

- No credentials or runtime data are included in the repository. `.env`, `config/bots.json`, and `data/` are gitignored.
- High-risk operations are gated by human approval and role-based access control.
