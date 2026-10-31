# HarnessOS

以飞书话题群为操作界面、Claude Code 与 Codex 为无头执行引擎的轻量 Agent 编排宿主。本仓库是**单团队稳定版**（stable single-team edition）；多团队编排不在本版本范围内。

## 运行与验证

```bash
pnpm install
pnpm build
pnpm test
pnpm start       # watch 模式
pnpm start:once  # 单次启动
pnpm lint:docs
```

## 架构与文档

- 公开架构：`docs/ARCHITECTURE.md`
- 飞书应用与配置：`docs/SETUP.md`
- 工程失败学（精选）：`docs/LESSONS.md`
- M1–M13 方法论：`docs/METHODOLOGY.md`
- 阈值与配置索引：`README.md` 的 “Configuration & thresholds” 章节

## 约定

- ESM only，Node 22+，pnpm 8+。
- 凭证只放 `.env`（已 gitignore），绝不硬编码、绝不提交；`config/bots.json` 与 `data/` 同样不提交。
- 测试必须密闭：使用 `mkdtempSync` / `tmpdir()` 创建临时目录，并在 `finally` 中 `rmSync`；严禁依赖仓库外的私有文件。
- 测试串行：`tsx --test --test-concurrency=1 ...`，避免 Windows 下 tsx 多文件并发加载的 IPC 序列化问题。
- 本仓库没有格式化工具；不要引入 Prettier 或批量重排，缩进与引号风格手工对齐既有代码。
- 文档治理：`docs/` 只放架构/协议/ADR/公开说明；业务 PRD 放 `.scratch/<feature>/` 或飞书云文档，禁止双轨同步。
- 只读调研（recon）必须有事前强制：读锁 + 把 `Write` / `Edit` 类工具放进 stop 列表；事后指纹复核只是兜底。
- 高危及不可逆操作必须走 `request_approval` 人工审批；禁止静默重启或杀死正在运行的外部服务。

## 工程失败学

详见 `docs/LESSONS.md`。五条最常被复用的规则：

1. 护栏必须写成「纯函数返回拒绝理由 + 调用点见理由即 return」；不要用「设标志位后继续执行」表达拒绝。
2. 「判定层 + 转移表」的状态机，新增状态/事件必须两处同时改，并写一条断言该跃迁真的可执行的测试。
3. 持久化 schema 必须逐字段对齐 interface；zod 默认会剥离未声明的键。
4. 分散装配的横切关注点一定会漏；上下文、审计、鉴权、限流必须在唯一收口处产生。
5. 能事前拦住的，绝不要留到事后判定；事后复核只负责发现漏网，不负责止损。

## 版本边界

- 本版本是单团队稳定版；多团队编排、动态团队等能力不在本版本中。
- Feishu/Lark 是当前唯一 IM 适配器；CLI 引擎为 Claude Code 与 Codex。
- 单机运行，JSON 文件持久化；不面向分布式/多租户场景。
