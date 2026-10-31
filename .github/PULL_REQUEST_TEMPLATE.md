## Summary

<!-- What changed, and why? Keep it focused. -->

## Tests

- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm lint:docs`

## Safety checklist

- [ ] No secrets, credentials, chat ids, document tokens, or private absolute paths.
- [ ] New tests are hermetic (`mkdtempSync`/`tmpdir()` + `finally rmSync`).
- [ ] New automatic transitions have a wiring-level test.
- [ ] Threshold or configuration changes update `README.md` and the guarding test.
- [ ] No formatter or bulk-format diff was introduced.

## Notes

<!-- Screenshots, trade-offs, or follow-up work. Do not include private data. -->
