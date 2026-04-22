---
applyTo: "research-output/**"
---

# Multi-Agent Orchestration Playbook

This file defines *when* and *how* to use subagents during research. Read this
together with `research.instructions.md` (methodology), `code-validation.instructions.md`
(when to write code), and `memory.instructions.md` (cross-session memory).

The research orchestrator follows the **hybrid orchestrator-workers** pattern
(Anthropic Research, OpenAI Deep Research, STORM) — extended in v2 with
memory recall, completeness audit, adaptive supervision, multi-model critique,
and confidence-based escalation (informed by MIA, HiRAS, CoSearch, SeekerGym):

```
                 ┌──────────────────┐
                 │ MEMORY RECALL    │  recall_prior_research → reuse / build on
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ PLANNER          │  decompose topic → research plan
                 └────────┬─────────┘
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   ┌─────────┐       ┌─────────┐        ┌─────────┐
   │ SPEC. 1 │       │ SPEC. 2 │  ...   │ SPEC. N │   (multi-query reformulation,
   └────┬────┘       └────┬────┘        └────┬────┘    inline-quote evidence)
        └─────────────────┼──────────────────┘
                          ▼
                 ┌──────────────────┐
                 │ COMPLETENESS     │  audit coverage; recommend fill-ins
                 │ AUDIT            │  ↳ adaptive spawn if gaps found
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ SYNTHESIZER      │  citation-grounded draft
                 │ (+ code-validate)│
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ RED-TEAM CRITIC  │  *different model family* (variance reduction)
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ REVISE +         │  🟠/⚡ on decision-relevant claims
                 │ CONFIDENCE       │  → spawn focused dig-deeper specialists
                 │ ESCALATION       │
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ CITATION         │  fetch each URL, check claim support
                 │ VERIFIER         │  (parallel, batches of 5)
                 └────────┬─────────┘
                          ▼
                 ┌──────────────────┐
                 │ MEMORY UPDATE    │  index final report for future recall
                 └──────────────────┘
```

---

## 1. Phase-by-phase

### Phase 0 — Memory recall (NEW in v2)
- Always call `recall_prior_research` with the topic before planning
- If a prior report fully covers it → consult user (refresh vs. new angle)
- If adjacent → cite prior report in plan's "Prior context" section
- If no match → proceed fresh (and say so)
- See `memory.instructions.md` for details

### Phase 1 — Planner (you, the lead orchestrator)
- Decompose the topic into 3–8 independent research questions
- Each question = one specialist subagent's scope
- Identify cross-cutting concerns (e.g., "the same competitor appears in 3 questions")
- Decide which focus areas need a `validate_with_code` step
- Save plan to `research-output/<id>-plan.md`
- If `autonomy=interactive` → present plan to user and STOP for approval
- If `autonomy=auto` → proceed directly to Phase 2

### Phase 2 — Parallel specialist research
- Spawn one `task` agent (`agent_type: "general-purpose"`, `mode: "background"`)
  per research question — **launch them all in the same response** for parallelism
- Each specialist writes its findings to `research-output/<id>-notes/<slug>.md`
- Each specialist must follow the methodology: adversarial pairs, confidence tags,
  source-tier classification, **multi-query reformulation** (3 query rephrasings
  per decision-critical claim, dedupe URLs), **inline-quote evidence** (not
  paraphrase + bare cite)
- Specialists return a *summary* + path to full notes (don't dump full content)

### Phase 2.5 — Completeness audit (NEW in v2)
- Once specialists return, call `completeness_audit` with the notes dir + topic
- Read the verdict:
  - 🟢 → proceed to synthesis
  - 🟡 → spawn the recommended fill-in specialists in parallel; their output
    joins the notes directory; then synthesize
  - 🔴 → re-plan and rerun; don't synthesize on broken foundation
- This is the "adaptive supervisor" pattern (HiRAS, arXiv 2604.17745) —
  specialist scope is set dynamically, not just upfront

### Phase 3 — Citation-grounded synthesis (you)
- Read each specialist's notes file (use `view` with `view_range`, not full reads)
- Identify cross-cutting themes (don't just concatenate)
- Resolve contradictions (or surface them as ⚡ Contested)
- Draft the report into `research-output/<id>-report.md`
- **Every decision-relevant claim must include an inline quote** from a source,
  OR a `[code-verified]` artifact link. Paraphrase + bare citation is INSUFFICIENT.

### Phase 4 — Multi-model red-team critique (NEW in v2 — model variance)
- Call `red_team_critique` — by default it spawns a `rubber-duck` agent on a
  **different model family** (gpt-5.4) than the orchestrator (Claude)
- Rationale: a critic running on the same model as the writer suffers from
  shared blind spots. Different model family = independent error distribution.
- Receive critique → decide which findings to adopt

### Phase 5 — Revise + confidence-based escalation (NEW in v2)
- Address every "Top 3 Priority" finding from the critique
- **Confidence escalation**: scan for any 🟠/⚡ tag attached to a *decision-relevant*
  claim (TL;DR, Executive Summary, Opportunities). For each → spawn ONE focused
  specialist to dig deeper (parallel where possible)
- After fill-in evidence comes back → revise tags
- If evidence remains thin → keep the low tag and say so explicitly

### Phase 6 — Citation verification
- Use `citation_verifier` — opens each cited URL, checks claim support
- Flags broken / paywalled / unsupported / vendor-misclassified
- For each issue: remove or downgrade

### Phase 7 — Memory update (NEW in v2)
- The `onPostToolUse` hook automatically rebuilds the memory index when
  a `*-report.md` is written
- Verify by reading `_memory-index.md`; the new TL;DR should be present

---

## 2. Subagent selection guide

| Need | Agent type | Mode | Model | Notes |
|---|---|---|---|---|
| Independent research thread (broad) | `general-purpose` | `background` | default | Has full toolset. Launch many in parallel. |
| Targeted code/file investigation | `explore` | `background` | default | Faster, cheaper for read-only work. |
| Adversarial review of a draft | `rubber-duck` | `sync` | **different family** | Block on response. Use `gpt-5.4` if orchestrator is Claude (and vice-versa). |
| Long pipeline (e.g. paper-graph traversal) | `general-purpose` | `background` | default | Self-contained brief + write path. |
| Confidence-escalation dig-deeper | `general-purpose` | `background` | default | Tight scope: "find primary evidence for/against claim X". |

---

## 3. Parallelism rules

- **Cap at 5 parallel background agents per wave** (audit fill-ins, escalation
  specialists, primary specialists). Beyond 5, returns diminish.
- For enterprise depth, run multiple waves rather than one giant wave.
- **All parallel calls in ONE response.** Don't drip-feed `task` calls — they
  only run truly in parallel when issued together.
- **Specialist scopes must be independent.** If subagent B needs subagent A's
  output, sequence them across two phases.
- **Always tell each specialist where to write.** "Write findings to
  `research-output/<id>-notes/<slug>.md` and return only a 200-word summary
  plus the file path."

---

## 4. Specialist prompt template

When spawning a specialist, give it:

1. **Role**: "You are a research specialist focused on <area>."
2. **Context**: One paragraph on the parent topic and why this slice matters.
3. **Methodology pointer**: "Follow `.github/instructions/research.instructions.md`."
4. **Specific tasks**: 3–6 concrete questions to answer.
5. **Adversarial pairs**: Pre-supplied counter-search queries.
6. **Multi-query directive**: "For your 3 most decision-critical claims, issue
   3 query rephrasings each; dedupe URLs across rephrasings."
7. **Evidence discipline**: "Inline-quote (≤2 sentences) the supporting passage
   for each major claim. Paraphrase + bare cite is insufficient."
8. **Output contract**: Path to write to + format + length budget + return shape.
9. **Stop conditions**: When to declare a finding "good enough" vs. dig more.

(The orchestrator's `buildSpecialistDispatch` already wraps these — but if
spawning ad-hoc fill-in specialists, replicate the pattern.)

---

## 5. State passing

- **Files, not context.** Specialists write to disk; you re-read what you need.
- **One canonical directory per report**: `research-output/<id>-notes/`.
- **Naming convention**:
  - `<id>-<slug>-plan.md` — the research plan
  - `<id>-<slug>-notes/<area>.md` — per-specialist findings
  - `<id>-<slug>-notes/fillin-<slug>.md` — adaptive gap-fill output
  - `<id>-<slug>-notes/_audit.md` — completeness audit
  - `<id>-<slug>-artifacts/` — code, data, generated charts
  - `<id>-<slug>-critique.md` — red-team output
  - `<id>-<slug>-citations.md` — verification log
  - `<id>-<slug>-report.md` — final report (auto-indexed in memory)
  - `_memory-index.md` — cross-session memory of all reports

---

## 6. When NOT to spawn subagents

- The topic is narrow enough that one pass is sufficient (e.g. "explain X")
- You're in the synthesis or revise phase (do that yourself)
- The user explicitly asked for a quick answer
- You'd be spawning <2 specialists — just do it inline

---

## 7. Failure modes to avoid

- **Skipping memory recall**: silently re-deriving what an earlier report already
  established
- **Premature synthesis**: writing the report before specialists return OR
  before the completeness audit
- **Skipping the audit**: jumping from specialists to synthesis loses adaptive
  supervision (the SeekerGym finding: SOTA agents miss >50% of relevant info silently)
- **Echo chamber**: all specialists pulling from the same 3 articles —
  diversify search surfaces, run the multi-query reformulation
- **Lost-in-the-middle**: dumping all specialist output into one prompt;
  read selectively from files instead
- **Same-model critique theater**: spawning a critic on the same model family as
  the writer; it shares the writer's blind spots
- **Citation hallucination**: citing URLs no one opened — always run `citation_verifier`
- **Confidence inflation by default**: tagging ✅ on single-source claims;
  the escalation phase is your safety net but only if the tags were honest first

