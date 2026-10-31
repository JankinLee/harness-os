# Methodology (M1–M13)

HarnessOS injects a compressed methodology block into every bot prompt as the stable **L0** prefix. The block is deliberately short and numbered so it can be referenced in reviews, incidents, and tests.

This document is the public, unabridged explanation of that block. It is a living synthesis of the author's notes and public multi-agent systems research, not an academic paper. Corrections and counterexamples are welcome.

## The block

> The runtime injects a compressed version in `src/core/bot-registry.ts` (`L0_META_AXIOMS`). This document is the longer public explanation. If they diverge, the runtime block is what bots actually see; update both together.

### M1 — Four-layer governance

Knowledge supply → execution orchestration → risk gating → governance operations. Each layer has an explicit input/output contract and does not call across layers. The orchestration layer only decides *what* and *who* (not business rules or permissions). **The gating layer is the layer least likely to disappear as autonomy increases.**

### M2 — Coordination topology

Beyond roughly four agents, a poor topology makes accuracy gains saturate or decline. The production default is a **hybrid** topology (peer-to-peer plus a lead arbitrator); pure mesh is rare in practice.

### M3 — Orchestrator / Workflow / Policy

- **Orchestrator** (task DAG, routing, parallelism, replanning) is the most replaceable.
- **Workflow** (deterministic stage transitions, retries, compensation, human approval) should not be replaced by an LLM.
- **Policy** (permissions, budget, data domain, audit) is the least replaceable.

Autonomy progressively takes over *how* to do something, not *whether* it may be done.

### M4 — Single-agent patterns

ReAct is the default. Depending on the task, mix in Plan-and-Execute, ReWOO, heterogeneous division of labor, or reflection loops.

### M5 — The root cause is usually not the prompt

In the public multi-agent failure literature summarized in the author's notes, failures are dominated by system design (role overlap/omission, poor task allocation), coordination failure, and missing verification. Look at the architecture before rewriting the prompt; prompt edits often only address symptoms.

### M6 — Three-stage evolution

Predefined orchestration → experience-driven orchestration → autonomous orchestration. The transition criterion is whether accumulated experience is sufficient to guide orchestration. **Even in the third stage, boundaries and verification remain external constraints.**

### M7 — Six load-bearing points (LB1–LB6)

Freeze these in order; each must have a checkable verification method:

1. **LB1 — Architecture boundary**: layer responsibilities do not overlap.
2. **LB2 — Authority matrix**: each semantic has one authoritative owner; no multi-truth reads.
3. **LB3 — Host ownership**: each piece of logic has a defined home module; no adapter bloat.
4. **LB4 — Contract discipline**: no dual-sided interfaces, optional authority, or fallback-based privilege escalation.
5. **LB5 — Transition lifetime**: a transition layer that is never retired becomes the new default host.
6. **LB6 — Eval harness**: behavior must be verifiable, not merely asserted.

### M8 — Three-stage root-cause repair

The "three" means **three stages**, not three recurrences:

1. **Ownership diagnosis** — which layer does this logic belong to? Who is the formal host?
2. **Authority freeze** — is the same semantic read by multiple paths?
3. **Contract freeze** — is the frontend fallback compensating for a missing backend contract?

The order matters: skip a stage and the next fix will be bypassed.

### M9 — Five practical rules (code-review checklist)

1. Before fixing, answer: semantic type, architectural layer, formal host.
2. Every new adapter/helper/bridge must include a **retirement plan**.
3. Review order: belongs → authority → contract → behavior.
4. **Fallback is debt**; every fallback needs an issue.
5. Stage order: freeze ownership → freeze contract → host placement → compatibility exit → delete fallback.

### M10 — Constraints buy autonomy; decision sufficiency

**Constraints do not limit autonomy; they enable it.** The more complete the constraints, the more trustworthy autonomous decisions become — and the larger the scope autonomy can cover. Three principles:

1. Do not enhance model capability; model capability will evolve and wrappers will age quickly.
2. Provide only differential assistance: physical environment and state information the model cannot obtain itself.
3. Inside complete hard constraints, let the model maximize autonomous reasoning — not maximize without constraints.

Decision sufficiency uses **sufficiency of evidence** as its only yardstick:

- Enough evidence → decide autonomously.
- Not enough, but obtainable → probe first, then decide.
- After analysis, two or more reasonable paths involve a value judgment → present options + impact + recommendation + evidence to the human.

Two symmetric failure modes: throwing an unanalyzed question at the user is **evasion**; deciding without analysis is **arbitrariness**. Three self-checks: did I analyze all paths? did I assess the impact? is the evidence traceable?

### M11 — Three moves

- **Reduce**: compression and summarization.
- **Offload**: use the file system as external memory, atomic tools, progressive disclosure.
- **Isolate**: the main purpose of multiple agents is **context isolation**, not role-play.

### M12 — Context-rot defense

Model performance can degrade unpredictably as context grows. All compression is recoverable: information is not truly lost, only temporarily out of view. Lost-in-the-middle effects matter; a stable tool definition enables KV-cache reuse. Four parameters:

- A single tool result ≤ 30% of the total context.
- Reserve 20% of context for model output.
- Keep the most recent 3 rounds when compressing.
- Trigger summarization above 180K tokens.

### M13 — Friction-driven evolution

Any pause of the form "where should this go / what should it be called / which rule applies" is a signal that the design is incomplete. **When the same friction occurs a third time, do not fix the symptom; redesign the structure that carries it.** Beware the Goblin effect: repeated exposure normalizes anomalies and friction.

Four friction layers:

- **Operational**: anchor replaces pause; extract a pattern afterward.
- **Design health**: re-check "has a rejected design revived at a new entry point?"
- **Architectural**: having consumption rights without definition rights means the host is incomplete; return the write right.
- **Experience pipeline**: friction not encoded into a backlog has not been consumed.

Friction settled into the knowledge base **must not be written back automatically**; it requires human final review.

## HarnessOS project rules

These are not M-numbered; they are the hosting rules for this repository:

- Single source of truth.
- Physical isolation.
- No absolute paths in agent-visible contracts.
- Separation of powers across roles.
- Deterministic gates.
- Thin host.

These six are distinct from M7's LB1–LB6 and must not be substituted for them.

## Further reading

The methodology is a synthesis; the following public sources are useful starting points. They are not endorsements of every claim, and the numbers in M5 are summarized from the author's notes rather than asserted as universal constants.

- Multi-agent failure modes: <https://cloud.tencent.com.cn/developer/article/2762318>
- Long-running agent runtimes: <https://www.langchain.com/blog/runtime-behind-production-deep-agents>
- Google ADK: pause/resume and context: <https://developers.googleblog.com/en/build-long-running-ai-agents-that-pause-resume-and-never-lose-context-with-adk/>
- Anthropic, "Skills explained": <https://claude.com/blog/skills-explained>
- MCP specification changelog: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Meta-harness (ICML): <https://icml.cc/virtual/2026/67972>
- Terminal-Bench: <https://www.tbench.ai/>

If you disagree with a rule, the most useful contribution is a concrete counterexample with a reproducible scenario. That is how the block has evolved.
