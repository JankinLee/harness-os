# Security policy

## Supported versions

The public `0.1.x` line is the supported stable single-team edition.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include a description, reproduction steps, affected version/commit, and the impact you observed.

If private reporting is unavailable, contact the maintainer through the GitHub profile rather than posting details publicly. Please allow a reasonable window for a fix before disclosure.

## Threat model

HarnessOS is a control plane around powerful coding CLIs. The main trust boundaries are:

| Input | Trust level | Why |
|---|---|---|
| Feishu messages, mentions, and card actions | **Untrusted** | Anyone in the group can write text; a bot may relay model output. |
| Feishu document comments | **Untrusted** | Comment text is external input. |
| CLI stream events and tool calls | **Untrusted** | The model can emit arbitrary tool calls; the host must gate them. |
| Workspace files | **Untrusted** | A repository may contain prompt-injection payloads. |
| `.env`, `config/bots.json`, `data/` | **Sensitive local state** | Contains credentials and conversation state; never commit or share. |

Controls in this repository:

- RBAC in `src/core/tool-rbac.ts`, used by both the MCP server and the host.
- Pre-execution stop lists for read-only recon (`src/cli/app-tools.ts`).
- Human approval for irreversible operations (`request_approval`).
- Workspace read/write locks and content-level fingerprint verification.
- Runaway detection for repeated failing tool-call loops.

**Not provided:** an OS-level sandbox, network egress filtering, or multi-tenant isolation. If a malicious CLI process or a compromised host is in scope, this project's controls are not sufficient on their own.

## Hardening recommendations

- Use a separate Feishu app per bot with least-privilege scopes.
- Keep `request_approval` enabled for irreversible operations.
- Review `READONLY_FORBIDDEN_TOOLS` and `TERMINAL_CONTROL_TOOLS` before granting write access.
- Run the host on a machine you control and restrict who can add the bot to a group.
- Treat model output as untrusted: do not pipe it into a shell without review.
- Rotate Feishu app secrets if they were ever exposed.
- Keep `data/` out of backups that are shared more broadly than the host.

## Out of scope

- Attacks that require an already-compromised host or root access.
- Social engineering of the operator.
- Denial of service caused by intentionally exhausting the host's own resources.
- Vulnerabilities in Feishu/Lark, Claude Code, Codex, or other third-party services; report those upstream.
