# Engineering lessons

These are selected, sanitized postmortems from the author's private deployment. Each one is written as **symptom → root cause → fix → regression anchor**, so the fix is anchored in code and tests rather than in prose.

The private error book is larger; this public selection focuses on lessons that are broadly useful for agent runtimes and control planes.

## 1. A guardrail that sets a flag and continues is not a guardrail

**Symptom:** An operation that should have been rejected still executed. The rejection message was produced, but the forward path continued.

**Root cause:** The guard was written as `if (bad) { reject(); }` plus a flag evaluated only once at the top of a block. Every subsequent guard in that block was bypassed.

**Fix:** Make the guard a pure function returning a rejection reason, and have the call site return immediately when a reason exists. Never express rejection as "set a flag and keep going."

**Anchor:** `src/core/tool-rbac.ts`, `src/app/recon-guard.ts`, `tests/unit/terminal-tools-interception.test.ts`.

## 2. A persistence schema silently drops fields

**Symptom:** A flow persisted with `tier`, `escalations`, and the original message credential, but after a restart those fields were empty. Pending flows stopped producing completion notices because their credentials were gone.

**Root cause:** The zod persistence schema declared only some interface fields. Zod strips unknown keys by default, so every save/load cycle deleted the rest.

**Fix:** Compare every field in the interface against the persistence schema, or derive the type from the schema. Adding a field requires updating the schema in the same change.

**Anchor:** `src/core/product-spec-store.ts`, `tests/unit/spec-lifecycle.test.ts`, `tests/unit/spec-legacy-credential.test.ts`.

## 3. A post-hoc circuit breaker is an incident report, not a gate

**Symptom:** A read-only recon task wrote to the workspace. The host detected the change only after the CLI had exited; the damage was already on disk.

**Root cause:** The only defense was a post-execution `git status` comparison. Worse, comparing only the path set could not detect that an already-dirty file was rewritten.

**Fix:** Enforce before execution: take a read lock, put `Write`/`Edit`-style tools in the CLI stop list, and capture a content-level fingerprint after the lock is acquired. Keep post-hoc verification as a fallback, not as the primary gate.

**Anchor:** `src/cli/app-tools.ts` (`READONLY_FORBIDDEN_TOOLS`), `src/core/workspace-change-probe.ts`, `src/app/recon-guard.ts`.

## 4. Invariant checks must run on both success and failure paths

**Symptom:** A recon task wrote a bad file and then triggered a timeout. The host's `.then`-only verification never ran; the caller received only "execution failed" and nobody attributed the mutation.

**Root cause:** The verification/cleanup invariant was attached to the success branch only.

**Fix:** Run invariant checks, cleanup, and attribution in both success and failure paths. A half-written check is worse than no check because it creates a false sense of protection.

**Anchor:** `src/index.ts` (the recon guard runs before the result branches), `src/app/recon-guard.ts`.

## 5. Scattered assembly always misses a path

**Symptom:** A context capsule was intended for every downstream dispatch, but only 2 of 11 dispatch sites injected it. The missing sites were the most failure-prone ones: arbitration resumes, delivery receipts, failure returns, and Phase 3 handoffs.

**Root cause:** The capsule was assembled at each call site. A cross-cutting concern that requires N call sites to remember it will be forgotten at least once.

**Fix:** Move assembly to the single dispatch choke point so "no capsule" is structurally impossible. The judgment test is simple: if adding a new call site could forget the concern, the call site should not own it.

**Anchor:** `src/app/collaboration-service.ts`, `src/core/collaboration.ts` (`assembleContextCapsule`), `tests/unit/recon-and-capsule.test.ts`.

## 6. A state machine needs both the decision layer and the transition table

**Symptom:** A new "7-day stale quarantine" action was added to the sweep decision, but the feature never ran. The sweep returned `quarantine`, the transition function returned `undefined`, and the loop silently continued.

**Root cause:** The decision layer and the transition table were two separate places. Only one was updated.

**Fix:** When adding a state or event, update both the decision layer and the transition table, and write a test that asserts the transition is actually executable. A pure-function test of the decision alone is not enough.

**Anchor:** `src/core/product-spec.ts` (`LIFECYCLE_TRANSITIONS`, `nextLifecycle`, `planLifecycleSweep`), `tests/unit/spec-lifecycle.test.ts`.

## 7. An override that narrows its signature silently drops parameters

**Symptom:** A policy that should have recycled human to-dos when a task was explicitly terminated never took effect. The chain was later resurrected by the 24-hour timeout policy.

**Root cause:** The base store method took `(taskId, options)`, but a JSON store override declared only `taskId` and forwarded only the first argument. TypeScript did not complain because a subclass may narrow a method signature.

**Fix:** Declare override parameters with `Parameters<Base['method']>[n]` and forward them unchanged. Treat every "subclass override + default parameter" combination as a field-by-field audit.

**Anchor:** `src/core/product-spec-store.ts`, `tests/unit/spec-legacy-credential.test.ts`.

## 8. A singleton does not make async read-modify-write safe

**Symptom:** A friction counter was supposed to auto-settle after three hits. In a concurrency test, three simultaneous records produced only one hit; the threshold was never reached.

**Root cause:** A singleton removed multiple in-memory views, but every call still did `load → mutate → save` without serialization. Two concurrent writes overwrote each other.

**Fix:** Serialize asynchronous file writes with a promise queue or a lock. A singleton solves "multiple copies of the truth," not "the same copy being overwritten concurrently."

**Anchor:** `src/app/friction-recorder.ts`, `src/core/experience-settlement.ts`, `tests/unit/collaboration-tier-and-cognition.test.ts`.

## 9. Topic-level task ids weld unrelated chains together

**Symptom:** Two tasks processed by the same bot in the same topic were linked into one capsule lineage. The second chain appeared to have a parent from the first task.

**Root cause:** Lineage lookup used `taskId + fromBotId`, but `taskId` is a topic-level hash. It is stable across tasks in the same topic.

**Fix:** Carry and filter by the task credential — the original human message id — wherever a `taskId` association is created. "Both sides must have it" is the invariant.

**Anchor:** `src/core/capsule-lineage.ts`, `src/core/capsule-log.ts`, `tests/unit/recon-and-capsule.test.ts`.

## 10. Different suppression conditions must not share one `&&`

**Symptom:** When a technical-review round hit its limit — exactly when arbitration was most likely — the host stopped suppressing "task completed" notices and told the human the task was done.

**Root cause:** Two independent suppression rules ("arbitration pending" and "review not converged and under the round limit") were merged into one condition. Once merged, neither rule could be reasoned about independently.

**Fix:** Evaluate each suppression condition separately. If either is true, suppress. Never combine semantically different suppression rules into one expression.

**Anchor:** `src/index.ts` (terminal-result handling), `tests/unit/terminal-tools-interception.test.ts`.

## 11. A fallback that is used only when there is no other data will drop the most important data

**Symptom:** The CLI observed a batch with a normal tool call and a terminal call rejected by MCP/RBAC. The host neither dispatched nor errored, while the model's prose said "dispatched."

**Root cause:** The terminal call was removed from the observed set when it failed. The result collector used `observed.size > 0 ? all : [stoppedByToolCall]`, so the terminal call disappeared whenever any other call existed.

**Fix:** Merge the terminal/stopped call into the result unconditionally, deduplicating by id. The termination reason is the most important fact; never demote it to a fallback.

**Anchor:** `src/cli/runner.ts`, `tests/unit/terminal-tools-interception.test.ts`.

## 12. A retry result must be unioned with the original facts, not replace them

**Symptom:** After an input-repair retry, a `request_approval` call that had succeeded in the first round disappeared. The approval flow was never created, silently disabling the human gate for a high-risk operation.

**Root cause:** The retry result replaced the first-round result. The successful call lived only in the first round.

**Fix:** Union the corrected/retry result with the original facts, placing corrected values last so the finder's reverse scan prefers them. Keep the first-round prose as the answer; the retry usually only says "resubmitted."

**Anchor:** `src/app/terminal-tool-submission.ts`, `src/index.ts`, `tests/unit/terminal-tool-submission-and-probe.test.ts`.

## 13. A branch that can never be reached is a false fix

**Symptom:** A failure-path probe was added for "terminal call not handled," but the terminal tools were always in the stop list. A successful terminal call always killed the CLI and resolved the promise, so the failure branch never received a terminal call.

**Root cause:** The new code assumed the failure path would see the terminal call, but the control flow made that impossible.

**Fix:** After wiring a new branch, answer: **when will this branch execute?** Provide a reproducible trigger. Symmetry ("the success path has it, so the failure path should too") can create a fix that looks complete but never runs.

**Anchor:** `src/app/terminal-tool-probe.ts`, `src/index.ts`, `tests/unit/terminal-tool-submission-and-probe.test.ts`.

## 14. Observation facilities must be allowed to say "insufficient information"

**Symptom:** A failure-path probe could not distinguish "the host rejected the call (reason already on the failure card)" from "the host died before handling it." It attributed the failure to an invalid role/id anyway and recorded a friction hit. Three false hits produced a fake pattern candidate.

**Root cause:** The probe forced an attribution whenever the input was schema-valid.

**Fix:** Add an explicit "insufficient information" outcome. Prefer under-reporting to misreporting; a noisy observation facility is worse than a quiet one because it contaminates the knowledge base.

**Anchor:** `src/app/terminal-tool-probe.ts`, `src/core/experience-settlement.ts`.

## 15. Expanding visibility can expand the execution surface

**Symptom:** After failed MCP calls were re-included in the host's observable set, three terminal tools that had RBAC checks in MCP but not in the host became executable without a gate.

**Root cause:** The previous invisibility of failed calls was accidentally acting as a gate. Making them visible removed it.

**Fix:** A permission decision must have one source and be used on both sides. Any change that makes a class of calls visible must answer: who will execute on it, and is that side's gate the same source?

**Anchor:** `src/core/tool-rbac.ts`, `src/mcp/app-tools-server.ts`, `src/index.ts`.

## 16. Return-value shape is an implicit control-flow contract

**Symptom:** A retry helper returned the original result to mean "retry disabled." The downstream consumer treated "no valid call after retry" as a hard failure, so a model typo lost the entire research output.

**Root cause:** Control flow was encoded in the shape of a return value, and one consumer did not recognize the convention.

**Fix:** Use an explicit parameter or a discriminated result type. Every consumer must recognize the contract. Do not write comments claiming the cost is small unless it has been verified.

**Anchor:** `src/app/product-spec-submission.ts`, `src/index.ts`, `tests/unit/terminal-tools-interception.test.ts`.

## 17. Never store state that can be derived from existing facts

**Symptom:** A `legacyCredential: true` marker was added to identify rows missing a credential. Its value was recomputed on load from `!originalMessageId`, so declaring it in the schema had no observable effect. A third write path could still violate it.

**Root cause:** The marker duplicated a fact that was already derivable.

**Fix:** Derive the state from the existing fact (`!flow.originalMessageId`) instead of adding a field. A derived condition is consistent across all write paths and cannot rot.

**Anchor:** `src/core/product-spec-store.ts`, `src/app/product-spec-submission.ts`, `tests/unit/spec-legacy-credential.test.ts`.

## 18. A field with two meanings cannot be written for only one of them

**Symptom:** A placeholder was written into `originalMessageId` to mark legacy rows. That field was also used as the reply target message id in several lifecycle paths, so legacy rows tried to reply to a message that did not exist.

**Root cause:** One field carried two semantics (credential and reply target). A write for one purpose polluted the other.

**Fix:** Enumerate every consumer of a field before changing its write policy. If a field has two meanings, split it or add a separate field with a clear ownership rule.

**Anchor:** `src/core/product-spec-store.ts`, `src/app/lifecycle-runner.ts`, `src/app/product-revision-runner.ts`, `tests/unit/spec-legacy-credential.test.ts`.

## 19. Tests must be hermetic

**Symptom:** The test suite passed on the author's machine and failed in a clean clone. One test asserted a pointer to a private file that existed only next to the author's workspace.

**Root cause:** The test depended on a file outside the repository. It was an environment test disguised as a unit test.

**Fix:** Create the fixture in a temporary directory with `mkdtempSync`/`tmpdir()`, write only the files the test needs, and remove the directory in `finally`. A test that requires a sibling private repository is not a unit test.

**Anchor:** `tests/unit/workspace-resolver.test.ts` (the public asset-probe test), `src/core/team-registry.ts`.

## 20. Feishu Card Schema 2.0 has no `textarea`

**Symptom:** A clarification card used `tag: "textarea"`. The Feishu OpenAPI returned HTTP 400 (`200621`, `value: not support tag: textarea`), blocking the review and arbitration cards.

**Root cause:** A non-existent component tag was invented instead of checking the schema.

**Fix:** Use `tag: "input"` for form input; it supports `max_length`, multi-line text, and adaptive layout. Validate card JSON against the current schema and add a regression test.

**Anchor:** `src/im/card.ts`, `tests/unit/terminal-tools-interception.test.ts` (no-`textarea` assertion), `tests/unit/queue-card-rendering.test.ts`.
