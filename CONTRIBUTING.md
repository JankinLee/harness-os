# Contributing

Thanks for taking a look. HarnessOS is a small, opinionated control plane; contributions are most useful when they preserve the safety boundaries described in `docs/ARCHITECTURE.md`.

## Development setup

```bash
pnpm install
cp .env.example .env
cp config/bots.local.example.json config/bots.json
pnpm test
pnpm build
pnpm lint:docs
```

You do not need real Feishu credentials to run the unit tests. You do need them for an end-to-end smoke test.

## Tests are non-negotiable

- **Hermetic**: create fixtures with `mkdtempSync`/`tmpdir()` and clean up in `finally` with `rmSync`. A test must not depend on a sibling repository or a file outside the checkout.
- **Serial**: the test script uses `--test-concurrency=1`. Keep it; parallel tsx loading has caused Windows IPC serialization failures.
- **Wiring-level**: if you add an automatic transition (timeout, sweep, cleanup), add a test that proves the path is actually called. A pure-function test alone can pass while the wiring is dead.
- **Regression-first**: for a bug fix, add a test that fails before the fix and passes after it.

## Style

- ESM, Node 22+, TypeScript, 2-space indentation, single quotes, semicolons.
- The repository has **no formatter**. Do not introduce Prettier or bulk-reformat files; match the surrounding style by hand. Large formatting-only diffs are rejected.
- Prefer small, focused modules and explicit names. Chinese comments are fine; keep them factual and free of private context.
- Do not add absolute paths to agent-visible prompts, contracts, or tests. Use aliases, relative paths, or `tmpdir()`.

## Secrets and private data

Never commit:

- `.env`
- `config/bots.json`
- `data/`
- Feishu app secrets, tenant access tokens, document tokens, chat ids, open ids, or screenshots containing them
- Any private sibling repository or personal document

Use `.env.example` for placeholders. If you paste logs into an issue, redact `cli_*`, `oc_*`, `ou_*`, document tokens, and absolute paths.

## Documentation

- `docs/` is for architecture, protocols, ADRs, and public guides. Business PRDs go to `.scratch/<feature>/` or a Feishu Doc, never both.
- If you add a public doc, add its filename to the allowlist in `scripts/lint-docs.ts`.
- If you change a threshold, update the table in `README.md` and the test that guards it.

## Commits and pull requests

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Keep PRs focused. Do not mix a refactor with a behavior change.
- Include the tests you ran and any manual verification.
- Do not force-push `main`. Do not commit generated `dist/` or runtime `data/`.
- For security issues, follow `SECURITY.md`; do not open a public issue.

## Good first contributions

- Improve setup documentation for a platform you use.
- Add a test for a documented invariant that currently has no coverage.
- Add a small CLI adapter for a new engine, behind the existing `CliAdapter` interface.
- Improve error messages that currently say too little to diagnose a failure.

## Code of conduct

Be direct about code, generous about people. Harassment, personal attacks, and disclosure of private data are not welcome.
