---
applyTo: "research-output/**"
---

# Multi-Agent Orchestration Playbook

This file defines *when* and *how* to use subagents during research. Read this
together with `research.instructions.md` (methodology) and
`code-validation.instructions.md` (when to write code).

The research orchestrator follows the **hybrid orchestrator-workers** pattern
(Anthropic Research, OpenAI Deep Research, STORM):

```
                    ┌─────────────┐
                    │  PLANNER    │  decompose topic → research plan
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐        ┌─────────┐        ┌─────────┐
   │ SPEC. 1 │        │ SPEC. 2 │   ...  │ SPEC. N │  parallel research threads
   └────┬────┘        └────┬────┘        └────┬────┘
        └──────────────────┼──────────────────┘
                           ▼
                    ┌─────────────┐
                    │ SYNTHESIZER │  merge findings into draft report
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  RED-TEAM   │  adversarial critique of draft
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  REVISE     │  address critique, fill gaps
                    └──────┬──────┘
                           ▼
                    ┌─────────────┐
                    │  CITATION   │  fetch each cited URL, verify claim
                    │  VERIFIER   │  support, flag unsupported claims
                    └─────────────┘
```

---

## 1. Phase-by-phase

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
  source-tier classification
- Specialists return a *summary* + path to full notes (don't dump full content)

### Phase 3 — Synthesis (you)
- Read each specialist's notes file
- Identify cross-cutting themes (don't just concatenate)
- Resolve contradictions (or surface them as ⚡ Contested)
- Draft the report into `research-output/<id>-report.md`

### Phase 4 — Red-team critique
- Spawn a `rubber-duck` agent (`agent_type: "rubber-duck"`, `mode: "sync"`)
- Pass the draft report path; ask for adversarial review focused on:
  - Unsupported claims, hand-waved numbers, missing counter-evidence
  - Survivorship / hype-cycle / anchoring bias
  - Logical leaps in opportunities/recommendations
  - Citations that don't actually support the claim
- Receive critique → decide which findings to adopt

### Phase 5 — Revise (you)
- Address each adopted critique point
- Where evidence is genuinely thin → downgrade confidence tag, don't paper over
- If a critique reveals a real gap → spawn a focused specialist to fill it,
  then revise again

### Phase 6 — Citation verification
- Use the `citation_verifier` tool, OR spawn a `task` (general-purpose) agent
  that opens each cited URL with `web_fetch` and confirms the claim
- For broken/paywalled/redirected URLs → flag and replace or remove
- For unsupported claims → downgrade confidence or remove

---

## 2. Subagent selection guide

| Need | Agent type | Mode | Notes |
|---|---|---|---|
| Independent research thread (broad) | `general-purpose` | `background` | Has full toolset (web, code, grep). Launch many in parallel. |
| Targeted code/file investigation | `explore` | `background` | Faster, cheaper than general-purpose for read-only work. |
| Adversarial review of a draft | `rubber-duck` | `sync` | Block on response — you need it before revising. |
| Run a long pipeline (e.g. paper-graph traversal) | `general-purpose` | `background` | Give it a self-contained brief and a write path. |

---

## 3. Parallelism rules

- **Cap at 5 parallel background agents** unless the topic genuinely needs more.
  Beyond 5, returns diminish (rate limits, context dilution at synthesis).
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
6. **Output contract**: Path to write to + format + length budget + return shape.
7. **Stop conditions**: When to declare a finding "good enough" vs. dig more.

Example (abbreviated):
```
You are the academic-papers specialist for research on "<TOPIC>".

Search arXiv and Semantic Scholar. Find 6–10 papers (recent + cited).
For each: title, authors, date, link, key finding, methodology, limitations.

Adversarial pairs:
- "<TOPIC>" ↔ "<TOPIC> negative results" / "<TOPIC> failed to reproduce"
- "<TOPIC> survey" ↔ "<TOPIC> critique"

Use citation-graph traversal: for the 2 most-cited papers, find their
critics (papers that cite them critically).

Write findings to research-output/<ID>-notes/papers.md (markdown, ~1500 words).
Return only: (a) 200-word summary, (b) the file path.

Stop when you have 6 strong papers + 1 critic for each major claim. Don't
exhaust the search — quality over breadth.
```

---

## 5. State passing

- **Files, not context.** Specialists write to disk; you re-read what you need.
- **One canonical directory per report**: `research-output/<id>-notes/`.
- **Naming convention**:
  - `<id>-plan.md` — the research plan
  - `<id>-notes/<slug>.md` — per-specialist findings
  - `<id>-artifacts/` — code, data, generated charts
  - `<id>-critique.md` — red-team output
  - `<id>-citations.md` — verification log
  - `<id>-report.md` — final report

---

## 6. When NOT to spawn subagents

- The topic is narrow enough that one pass is sufficient (e.g. "explain X")
- You're in the synthesis or revise phase (do that yourself)
- The user explicitly asked for a quick answer
- You'd be spawning <2 specialists — just do it inline

---

## 7. Failure modes to avoid

- **Premature synthesis**: writing the report before specialists return
- **Echo chamber**: all specialists pulling from the same 3 articles — diversify search surfaces
- **Lost-in-the-middle**: dumping all specialist output into one prompt;
  read selectively from files instead
- **Critique theater**: running red-team but not actually changing the draft
- **Citation hallucination**: citing URLs no one opened — always run citation verifier
