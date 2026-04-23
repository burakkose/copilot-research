# 🔬 AI Research Agent — Enterprise Multi-Agent Edition (v2)

A production-grade autonomous research and brainstorming system built on
GitHub Copilot CLI. Hybrid orchestrator-workers architecture with
**cross-session memory**, **adaptive supervision**, **multi-model critique**,
and **confidence-based escalation** — informed by April 2026 research-agent
literature (MIA, HiRAS, CoSearch, SeekerGym).

## Pipeline (v2)

```
recall_prior_research          MIA-inspired memory
        ↓
plan_research                  decompose into specialist scopes
        ↓
parallel specialists           CoSearch-inspired multi-query reformulation
  ├── web_trends                ↳ inline-quote evidence (no paraphrase-and-cite)
  ├── academic_papers           ↳ arXiv + Semantic Scholar + Google Scholar +
  │                              connectedpapers + paperswithcode + OpenReview
  ├── market_analysis           ↳ Gartner/Forrester/IDC/CB Insights/PitchBook/
  │                              SEC EDGAR (10-K, S-1)
  ├── competitor_analysis       ↳ G2 / Capterra / Product Hunt / AlternativeTo
  ├── tech_landscape            ↳ engineering blogs (Netflix/Uber/Stripe...) + QCon/KubeCon
  ├── developer_sentiment       ↳ GitHub + StackOverflow + Lobsters + dev.to
  ├── funding_activity          ↳ Crunchbase + TechCrunch + a16z/Sequoia + layoffs.fyi
  │                              (orchestrates the funding_pulse tool for fresh rounds)
  └── social_pulse              ↳ Reddit (multiple subs) + HackerNews (Algolia) +
                                  X/Twitter + practitioner Substacks
        ↓
enforce_depth_floors          anti-laziness gate — auto-respawn if any specialist
        ↓                      is below word/URL/quote/adversarial-pair floor
completeness_audit             SeekerGym-inspired gap detection
        ↓                       ↳ adaptive fill-in spawn (HiRAS-inspired)
validate_with_code             PAL-style quantitative validation
        ↓
citation-grounded synthesis    every claim has an inline quote
        ↓
red_team_critique              different model family (variance reduction)
        ↓
revise + escalation            🟠/⚡ on key claims → spawn dig-deeper specialists
        ↓
citation_verifier              fetch every URL, check claim support
        ↓
memory update                  index report for future recall
```

## Anti-laziness depth floors (v2.2)

The single most common failure mode of "deep research" agents is stopping early.
The orchestrator now enforces hard, programmatically-checked floors per
specialist before allowing the pipeline to advance to synthesis:

| Depth | Words | Distinct URLs | Inline quotes | Adversarial pairs |
|---|---|---|---|---|
| `quick`    |   800 |  8 |  4 | 2 |
| `standard` | 1,800 | 18 | 10 | 4 |
| `deep`     | 3,000 | 30 | 18 | 6 |

If any specialist's notes fall below the floor, the orchestrator calls
`enforce_depth_floors` → gets back a `respawn_directive` → respawns the
specialist with `"⚠️ INSUFFICIENT — keep digging, APPEND don't replace"` and
re-checks. This loops until the floor is met. **The agent cannot exit early.**

For the `social_pulse` specialist, additional per-platform floors apply
(deep tier: ≥10 Reddit threads from ≥4 subs, ≥8 HN comments from ≥4 stories,
≥6 X/Twitter threads, ≥6 long-form blog posts). Curl templates for the public
HackerNews Algolia API and Reddit `.json` endpoints are baked into the brief
so specialists never have an "I couldn't search there" excuse.

## Tools

| Tool | Phase | What it does |
|---|---|---|
| `recall_prior_research` | 0 | Query cross-session memory of past reports |
| `enforce_depth_floors` | 2.4 | Anti-laziness gate: programmatically check word/URL/quote/adversarial-pair floors per specialist; returns a respawn directive for any below floor |
| `funding_pulse` | Standalone | **Real-time funding feed** — pulls fresh rounds from SEC EDGAR Form D RSS (primary), Crunchbase News RSS, TechCrunch venture RSS, HN Algolia, layoffs.fyi; cross-references across surfaces; flags single-source claims |
| `plan_research` | 1 | Decompose topic → specialist scopes + adversarial searches |
| `run_deep_research` | All | Full enterprise pipeline (configurable autonomy) |
| `deep_paper_search` | Specialist | arXiv + Semantic Scholar with citation-graph traversal |
| `trend_quantifier` | Specialist | GitHub/npm/PyPI/Trends/jobs — code-validated curves |
| `concept_explainer` | Standalone | Layered breakdown with runnable code |
| `completeness_audit` | 2.5 | Gap detection on specialist notes; recommends fill-ins |
| `red_team_critique` | 4 | Adversarial review on a *different model family* |
| `validate_with_code` | 3.5 | Python validation: Monte Carlo, trend fit, CI, recompute |
| `citation_verifier` | 6 | Fetch every URL, check claim support |
| `brainstorm_from_research` | Output | Stress-tested project ideas with optional code-validated market fit |
| `list_research_reports` | Browse | Index of everything in `research-output/` |

## What's new in v2 (vs the original Anthropic-style orchestrator-workers)

| Upgrade | Source paper | Why it matters |
|---|---|---|
| **Cross-session memory** + auto-index | MIA (arXiv 2604.04503) | Avoid re-deriving what prior reports already established; build on findings |
| **Completeness audit + adaptive fill-in** | SeekerGym (arXiv 2604.17143), HiRAS (arXiv 2604.17745) | SOTA agents silently miss >50% of relevant info; explicit gap detection + dynamic specialist spawning closes this |
| **Multi-query reformulation** | CoSearch (arXiv 2604.17555) | Treating retrieval as fixed leaves up to 26.8% F1 on the table; 3 query rephrasings per critical claim recovers most of it |
| **Multi-model red-team** | Standard ensemble practice | A critic on the same model family shares the writer's blind spots; running it on a different family (gpt-5.4 vs Claude) reduces variance |
| **Confidence-based escalation** | Calibration literature | Low-confidence (🟠/⚡) findings on decision-relevant claims auto-trigger focused dig-deeper specialists |
| **Citation-grounded synthesis** | RAG hallucination research | Inline-quoted evidence per claim, not paraphrase + bare cite — the latter is where hallucinations hide |

We did not adopt full **agentic-RL training** (LiteResearcher, Tongyi
DeepResearch) — it requires training infrastructure outside the prompt-orchestration
model. The other 5 upgrades together close most of the gap.

## Quick Start

### 1. Install MCP servers (all optional — built-in fallbacks exist)

```bash
cp .env.example .env
$EDITOR .env       # add whichever API keys you have
source .env
```

In Copilot CLI, run `/mcp` and copy server entries from `mcp-servers.json`.
Recommended: `tavily`, `brave-search`, `arxiv`, `semantic-scholar`,
`firecrawl`, `github`.

| Service | Free tier | Used by |
|---|---|---|
| Tavily | 1000 searches/mo | All web research |
| Brave Search | 2000/mo | Falsification cross-check |
| ArXiv MCP | unlimited | `deep_paper_search` |
| Semantic Scholar | unlimited (key for higher rate) | `deep_paper_search` (citation graph) |
| Firecrawl | 500 pages/mo | JS-heavy fetches, `citation_verifier` |
| GitHub | Public API (auth raises rate) | `trend_quantifier` |

### 2. Run

```bash
copilot --experimental
```

Then in the session:

```
> Run deep research on "AI agent frameworks for developer productivity"
```

For full enterprise control:

```
> Use run_deep_research with topic "serverless AI inference",
  depth "deep", focus_areas [web_trends, academic_papers, market_analysis,
  competitor_analysis, tech_landscape, developer_sentiment, funding_activity],
  autonomy "interactive", enable_code_validation true
```

For overnight autonomous runs use `autonomy: auto` (default) and Shift+Tab
into autopilot mode.

## Common patterns

### Memory-first investigation
```
> Recall any prior research on "vector databases" before planning.
```
The orchestrator will query memory and either build on prior reports or
proceed fresh.

### Quick concept explainer
```
> Explain "speculative decoding" at practitioner level with runnable code.
```

### Just the trend numbers
```
> Run trend_quantifier on "LangChain" with github_repos ["langchain-ai/langchain"]
  and pypi_packages ["langchain"].
```

### Critique an existing draft (cross-model)
```
> Red-team-critique research-output/<id>-<slug>-report.md focusing
  on market-size claims, critic_model "gpt-5.4".
```

### Brainstorm with code-validation
```
> Brainstorm from research-output/.../report.md with constraints "solo dev,
  TypeScript+Python, $0 budget" and validate_top_ideas true.
```

## Project structure

```
.github/
  copilot-instructions.md
  extensions/research-orchestrator/extension.mjs   # The orchestrator
  instructions/
    research.instructions.md         # Falsification, confidence tags, source tiers
    orchestration.instructions.md    # When/how to spawn subagents (all 7 phases)
    code-validation.instructions.md  # When/how to validate with code
    memory.instructions.md           # Cross-session memory recall discipline
mcp-servers.json                     # MCP server reference config
.env.example                         # API key template
research-output/                     # All artifacts saved here
  _memory-index.md                   # Auto-built memory of past reports
  <id>-<slug>-plan.md
  <id>-<slug>-notes/
    <area>.md                        # Per-specialist findings
    fillin-<slug>.md                 # Adaptive gap-fill outputs
    _audit.md                        # Completeness audit
  <id>-<slug>-artifacts/             # Code, data, charts
  <id>-<slug>-critique.md
  <id>-<slug>-citations.md
  <id>-<slug>-report.md              # Final, auto-indexed
  <id>-<slug>-ideas.md
```

## Why this works (epistemic design notes)

- **Memory recall first** — avoids redundant work; later reports build on earlier
- **Multi-agent decomposition** — each specialist focuses on one slice; better
  signal than one big prompt
- **Parallel execution** — N specialists in roughly the wall-clock of one
- **Multi-query reformulation** — 3 rephrasings per claim recovers retrieval
  recall lost by treating search as fixed
- **Falsification by default** — every important claim runs an adversarial
  search pair before it's allowed in the report
- **Completeness audit** — explicit gap detection prevents silent omissions
- **Adaptive fill-in** — supervisor spawns more specialists dynamically, not
  just upfront
- **Confidence tagging** — calibration matters more than confidence
- **Code validation** — numbers get recomputed, not just quoted
- **Multi-model red-team** — critic on different model family = independent error
- **Confidence escalation** — low-confidence on key claims triggers more research
- **Citation verification** — every URL is opened and the claim is checked
- **Memory update** — final report becomes input for next investigation

## Extending

- Add MCP servers via `/mcp` in Copilot CLI
- Add focus areas: edit `SPECIALISTS` in
  `.github/extensions/research-orchestrator/extension.mjs`
- Change critic model: edit `CRITIC_MODEL` constant (or pass `critic_model` per call)
- Tighten or relax methodology: edit files in `.github/instructions/`
- After editing the extension, run `extensions_reload` in CLI (no restart needed)

## References (the literature behind v2)

- **MIA — Memory Intelligence Agent** (arXiv 2604.04503, Apr 2026) — Manager-Planner-Executor
  with non-parametric memory + on-the-fly test-time learning
- **HiRAS — Hierarchical Research Agent System** (arXiv 2604.17745, Apr 2026) — supervisory
  managers coordinating specialists across stages
- **CoSearch** (arXiv 2604.17555, Apr 2026) — joint training of reasoner + ranker;
  showed fixed retrieval leaves 26.8% F1 on the table
- **SeekerGym** (arXiv 2604.17143, Apr 2026) — completeness-of-retrieval benchmark;
  best agents retrieve only 42.5% of relevant Wikipedia passages
- **LiteResearcher** (arXiv 2604.17931, Apr 2026) — agentic-RL training framework
  (not adopted; out of scope for prompt-orchestration)
- Anthropic "How we built our multi-agent research system" — orchestrator-workers
- STORM (Shao et al. 2024) — outline-first writing
- Reflexion (Shinn et al. 2023), Self-Refine (Madaan et al. 2023) — critique loops
- ReAct (Yao et al. 2022) — reason + act with tools
- PAL (Gao et al. 2022) — program-aided validation
