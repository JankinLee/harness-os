# Setup

This guide takes a clean machine to a running HarnessOS instance. It assumes the **single-team stable edition** (`v0.1.0`).

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Node.js **22+** | The code uses modern ESM and Node APIs. |
| pnpm **8+** | The repository ships a pnpm v6 lockfile; pnpm 8 matches it. |
| Feishu/Lark custom apps | One app per bot is the simplest setup. |
| Claude Code and/or Codex CLI | The actual execution engine. HarnessOS does not bundle model access. |
| Git | Workspace change probes and optional worktree isolation. |
| Optional: `lark-cli` + `lark-doc` / `lark-drive` / `lark-wiki` skills | Feishu Docs/Wiki delivery. Not required for local delivery. |

## 2. Create Feishu apps

For each bot in your roster (the example uses `ceo-assistant`, `product`, and `developer`):

1. Create a **custom app** in the Feishu/Lark Open Platform.
2. Enable **Bot** capability.
3. Add the app to the target **topic group**.
4. Configure **event subscription** using the **long connection** (WebSocket) mode.
5. Subscribe to:
   - `im.message.receive_v1` — incoming messages.
   - `card.action.trigger` — card button and form callbacks.
   - `drive.notice.comment_add_v1` — document comment events (only needed for Feishu Docs/Wiki workflows).
6. Grant the permissions required by the SDK calls in `src/im/lark.ts`:
   - IM: receive messages, send messages as the bot, read chat/group metadata.
   - Card: send/update interactive cards and receive card actions.
   - Drive: read/write document comments if you use comment routing.
   - Docs/Wiki: only if you use `lark-doc` / `lark-wiki` delivery.
7. Publish the app version and make sure the app is enabled.

> The app credentials are long-lived, but tenant access tokens are refreshed by the SDK. If an app is disabled, its credentials rotated, or its scopes changed, update `.env` and restart the host.

## 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in at least:

```dotenv
FEISHU_CEO_ASSISTANT_APP_ID=cli_xxx
FEISHU_CEO_ASSISTANT_APP_SECRET=xxx
FEISHU_PRODUCT_APP_ID=cli_xxx
FEISHU_PRODUCT_APP_SECRET=xxx
FEISHU_DEVELOPER_APP_ID=cli_xxx
FEISHU_DEVELOPER_APP_SECRET=xxx

TEST_CHAT_ID=oc_xxx
OWNER_OPEN_ID=ou_xxx
```

The variable names are not hard-coded by role: each bot entry in `config/bots.json` declares `appIdEnv` and `appSecretEnv`. If you add a role, add its variables here and reference them in the bot entry.

How to get the two ids:

- **`TEST_CHAT_ID`**: the topic-group chat id. Add a bot to the group, send a message, and read the `chat=` field in the host log; or use the Feishu API to list the group.
- **`OWNER_OPEN_ID`**: your human open id. After the first message, read the `sender=` field in the log, or use the contact API.

Optional variables:

- `ADMIN_OPEN_IDS` — comma-separated admin open ids for emergency abort/management.
- `CLI_WORKDIR` — fallback workspace when a bot does not declare one.
- `CLAUDE_TIMEOUT_MS` / `CODEX_TIMEOUT_MS` / `CLI_TIMEOUT_MS` — CLI run timeout (default 2 hours).
- `CLAUDE_SILENT_TIMEOUT_MS` / `CODEX_SILENT_TIMEOUT_MS` / `CLI_SILENT_TIMEOUT_MS` — silent CLI kill timeout (default 5 minutes).
- `SCHEDULE_API_PORT` / `SCHEDULE_API_TOKEN` — local scheduling API (default port 3101). Set a token if other local processes should not call it.
- `PATROL_WEBHOOK_URL` — optional auth/patrol webhook.

## 4. Configure `config/bots.json`

Start from one of the two examples:

| Example | Delivery | Extra dependencies |
|---|---|---|
| `config/bots.local.example.json` | Local specs under `.scratch/<feature>/` | None beyond the bundled skills |
| `config/bots.example.json` | Feishu Docs/Wiki via `lark-doc` | `lark-cli` + `lark-doc` / `lark-drive` / `lark-wiki` skills |

```bash
cp config/bots.local.example.json config/bots.json
# or
cp config/bots.example.json config/bots.json
```

Key fields:

```jsonc
{
  "teamLeader": "ceo-assistant",
  "defaultProductDeliveryMode": "local",       // or "lark-doc"
  "defaultWorkspace": ".",
  "workspaces": {
    "harness-os": "."
  },
  "wikiSpaceId": "<your-wiki-space-id>",       // optional; remove if unused
  "bots": [
    {
      "id": "ceo-assistant",
      "appIdEnv": "FEISHU_CEO_ASSISTANT_APP_ID",
      "appSecretEnv": "FEISHU_CEO_ASSISTANT_APP_SECRET",
      "defaultCli": "claude",                  // or "codex"
      "role": "…",
      "skills": [],
      "systemPrompt": "…",
      "collaborationMaxRounds": 16             // optional, 1–32
    }
  ]
}
```

Notes:

- `workspaces` maps an alias to a path. Use relative paths or aliases; avoid absolute paths in prompts and contracts.
- `wikiSpaceId` is optional. If you use Feishu Wiki, replace the placeholder with your space id; otherwise remove the key.
- `skills` must name skills that are installed. The bundled skills are `grill-me`, `implement-ticket`, `to-spec`, and `to-tickets`. `lark-*` and `code-review-expert` are optional and must be installed separately.
- `defaultProductDeliveryMode: "local"` writes specs to `.scratch/<feature>/`; `"lark-doc"` requires `lark-cli` and the lark skills.
- `collaborationMaxRounds` is the total hop budget for a collaboration chain; default 16, max 32.
- The runtime currently assumes the role ids `ceo-assistant`, `product`, and `developer`. RBAC (`src/core/tool-rbac.ts`) and the leader text (`src/core/team-registry.ts`) are keyed to them. Renaming a role requires code and test changes.

`config/bots.json` is gitignored. Do not commit it.

## 5. Install and authenticate the engines

```bash
claude --version
codex --version
```

Install and log in to at least one engine following its own documentation. HarnessOS spawns the CLI in headless mode and streams its events; it never stores your model credentials.

Check the environment:

```bash
pnpm harness-os doctor
```

`doctor` checks Node, pnpm, PM2, Claude Code, Codex, `.env`, and `config/bots.json`. PM2 is only needed for the optional production helper; `pnpm start` does not require it.

## 6. Optional: lark-cli and lark skills

The Feishu Docs/Wiki path uses `lark-cli` through the `lark-doc`, `lark-drive`, and `lark-wiki` skills. These are not bundled with HarnessOS.

If you install them:

- Keep `lark-doc`, `lark-drive`, and `lark-wiki` in the product bot's `skills`.
- Set `defaultProductDeliveryMode` to `"lark-doc"`.
- Set `wikiSpaceId` and optional `prdParentNodeToken` values.

If you do not install them:

- Use `config/bots.local.example.json` (or remove the `lark-*` skills from your config).
- Set `defaultProductDeliveryMode` to `"local"`.
- The product bot writes specs under `.scratch/<feature>/`.

## 7. Run

```bash
pnpm install
pnpm test
pnpm build
pnpm start
```

`pnpm start` runs in watch mode. `pnpm start:once` runs a single process. For a production-style process, use `pnpm start:prod` after `pnpm build`, or the optional `pnpm harness-os start` helper (requires PM2).

On startup you should see:

```text
HarnessOS 启动，正在建立飞书长连接…
[配置] 已注册 N 个 bot，Team Leader=ceo-assistant，已恢复 M 个会话
[CLI] id=claude command=claude
[CLI] id=codex command=codex
```

Send a message in the topic group and @ the bot. The first run creates `data/` and the JSON stores.

## 8. Troubleshooting

### The bot does not receive messages

- Is the app enabled and published?
- Is the bot in the target **topic group**?
- Is the event subscription in **long connection** mode?
- Is `im.message.receive_v1` subscribed?
- Did you @ the bot? Group messages that do not mention the bot may be ignored by design.
- Check the host log for `[收到]` lines.

### Feishu authorization expired / token invalid

- Confirm the app id and secret in `.env` match the app in the developer console.
- If the app was disabled, re-enabled, or its scopes changed, publish a new version and restart the host.
- If the credentials were rotated, update `.env` and restart.
- If the CLI engine itself is logged out, re-run its login command (`claude` / `codex`) and restart the host.
- A long connection can reconnect automatically; if it does not, restart the host once and check outbound network access.

### `401` / `403` from Feishu

- The app is missing a scope required by the call. Check the permission list in section 2.
- The app version is not published, or the scope change was not approved.
- The bot is not a member of the target group, or the group is not visible to the app.

### Card rendering fails with a schema error

Feishu Card Schema 2.0 input components use `tag: "input"`, not `textarea`. If you add a card, validate it against the current schema and add a regression test. Existing card builders live in `src/im/card.ts`.

### `config/bots.json` not found

```bash
cp config/bots.local.example.json config/bots.json
```

`config/bots.json` is intentionally gitignored.

### Missing skill warning

```text
[Skill] bot=product 找不到 lark-doc，请安装到工作区或用户级 Skills 目录
```

Install the skill, or remove it from the bot's `skills` list. The host warns but does not fail on a missing optional skill.

### `pnpm start` exits immediately

- Node version is below 22.
- `.env` is missing or has empty app credentials.
- `config/bots.json` is missing or references an unknown `teamLeader`.
- The port used by the scheduling API is already in use (`SCHEDULE_API_PORT`, default 3101).

## 9. Security checklist

- Use a separate Feishu app per bot, with least-privilege scopes.
- Never commit `.env`, `config/bots.json`, or `data/`.
- Keep `request_approval` enabled for irreversible operations.
- Review the CLI stop lists in `src/cli/app-tools.ts` before granting a bot write access.
- Treat Feishu messages, document comments, and CLI output as untrusted input.
- Rotate app secrets if they were ever exposed.
- Run the host on a machine you control; there is no multi-tenant isolation.

## 10. Cleanup

Runtime state is under `data/`. To start fresh:

```bash
# Stop the host first.
rm -rf data
```

Do not delete `data/` while a task is running; active flows and locks will be lost.
