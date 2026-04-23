# copilot-research

A multi-agent research and brainstorming extension for GitHub Copilot
CLI. Give it a topic; it plans the work, runs specialist sub-agents in
parallel across web / papers / market / social / funding sources,
synthesizes a report, critiques it with a different model, verifies
the citations, and indexes the result for future sessions.

Design notes:

- **Depth floors** — each specialist has minimum word count, distinct
  URLs opened, inline quotes, and adversarial queries; failures get
  respawned automatically.
- **Falsification first** — counter-evidence searches are required,
  claims need verbatim quotes, citations are fetched and checked.
- **Cross-session memory** — past reports are indexed with TF-IDF +
  topic tags and a relevance threshold, so prior work surfaces only
  when it's actually related.

Some of the architecture choices are informed by recent research-agent
papers (MIA, HiRAS, CoSearch, SeekerGym) — see [References](#references).

---

## Table of contents

- [Quick start](#quick-start)
- [Features](#features)
- [The 11 tools](#the-11-tools)
- [Usage — every common workflow](#usage--every-common-workflow)
- [Pipeline diagram](#pipeline-diagram)
- [Anti-laziness depth floors](#anti-laziness-depth-floors)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Why this works (epistemic design)](#why-this-works-epistemic-design)
- [Extending](#extending)
- [References](#references-the-literature-behind-the-design)
- [License](#license)

---

## Quick start

```bash
# 1. (Optional but recommended) — add API keys for higher-quality search
cp .env.example .env
$EDITOR .env             # add TAVILY_API_KEY at minimum (free 1k/mo)
source .env

# 2. Launch Copilot CLI in this directory
copilot --experimental

# 3. In the session, just talk to it
> Run deep research on "AI coding agents in 2026"
```

That's it. Outputs land in `research-output/`. Every other key listed in
`.env.example` is optional — the system falls back to public APIs and
keyless surfaces (HackerNews, Reddit, SEC EDGAR, arXiv, Crunchbase RSS)
when an MCP server isn't configured.

---

## Features

### 🧠 Multi-agent orchestration
- **Hybrid orchestrator-workers pattern** (Anthropic's playbook) — one lead agent decomposes the task, spawns N specialists in parallel, and synthesizes
- **Up to 5 specialists run truly concurrently**, each with its own context window — no lost-in-the-middle from one giant prompt
- **8 specialist scopes** out of the box, each with prescriptive (not suggestive) briefs

### 🚦 Anti-laziness gate (the headline)
- **Programmatic depth floors** per specialist (word count, distinct URLs opened, inline verbatim quotes, adversarial query pairs) — checked by code, not vibes
- **Auto-respawn loop**: any specialist below floor is sent back with `"⚠️ INSUFFICIENT — append, don't delete"` until it complies
- **Mandatory self-audit checklist** at the end of every specialist note
- Cannot proceed to synthesis while any floor is unmet

### 🔍 Falsification-first methodology
- Every important claim runs an **adversarial query pair** before it's allowed in the report
- **Multi-query reformulation** (CoSearch-inspired) — 3+ rephrasings per critical claim, union of results
- **Inline-quoted evidence** required — paraphrase-and-cite is rejected (that's where hallucinations hide)
- **Confidence tags** on every claim (✅ Verified / 🔵 Likely / 🟠 Speculative / ⚡ Contested)

### 🎯 Adaptive supervision
- **Completeness audit** runs after specialists return; detects coverage gaps, contradictions, thin sections (SeekerGym-inspired)
- **Dynamic fill-in spawning** — supervisor decides specialist scope at runtime, not just upfront (HiRAS-inspired)
- **Confidence-based escalation**: any 🟠/⚡ on a decision-relevant claim auto-triggers a focused dig-deeper specialist

### 🛰️ Real-time data sources
- **Funding pulse**: SEC EDGAR Form D RSS (primary source!) + Crunchbase News RSS + TechCrunch venture RSS + HN Algolia + layoffs.fyi
- **Social listening**: Reddit JSON endpoints (no key needed), HackerNews Algolia API, X/Twitter via site filters, Substack/dev.to/Lobsters
- **Academic**: arXiv + Semantic Scholar (citation graph) + Google Scholar + connectedpapers + paperswithcode + OpenReview
- **Market**: Gartner / Forrester / IDC / CB Insights / PitchBook / Crunchbase / SEC EDGAR (10-K, S-1, 8-K)
- **Engineering**: blog filters for Netflix/Uber/Stripe/Airbnb/Spotify/Pinterest/LinkedIn/Shopify + QCon/KubeCon archives

### 🧪 Code-validated numerics
- **`validate_with_code` tool** writes Python that pulls raw data and recomputes claimed numbers
- Supports trend fits, Monte Carlo, survey CIs, benchmark recomputation
- Validated claims get a `[code-verified](./<artifact>.md)` link in the final report

### 🪞 Multi-model red-team critique
- Critic runs on a **different model family** from the orchestrator (default: `gpt-5.4` when orchestrator is Claude)
- Prevents same-family blind spots
- Configurable per-call via `critic_model`

### ✅ Citation verification
- After draft is written, **every cited URL is fetched** and the claim is checked against the source
- Broken / paywalled / unsupported citations are flagged in `research-output/<id>-<slug>-citations.md`
- Unsupported claims must be removed or downgraded before the report is finalized

### 💾 Cross-session memory
- All past reports are auto-indexed at `research-output/_memory-index.md`
- **TF-IDF retrieval** with length normalization, title-token boosting (5×), minimum relevance threshold
- **Auto-extracted topic tags** per report (top distinctive terms)
- **Slim session-start digest**: shows topic clusters, not titles → no off-topic bleed-through when you're working on something unrelated
- Unrelated queries return `no_matches` (verified — coffee research won't surface AI-agents work)

### 💡 Brainstorm with stress-tests
- `brainstorm_from_research` generates project ideas grounded in a report
- Each idea includes a **pre-mortem** ("This fails because ___"), a **validation plan cheaper than the MVP**, a **specific "why now" data point**, and an **honest difficulty rating**
- Optional `validate_top_ideas: true` runs `validate_with_code` on the top-3 ideas' market-fit numbers

---

## The 11 tools

| Tool | Phase | What it does |
|---|---|---|
| `recall_prior_research` | 0 | Query cross-session memory of past reports (TF-IDF, threshold-filtered) |
| `plan_research` | 1 | Decompose topic → specialist scopes + adversarial searches + code-validation candidates |
| `run_deep_research` | All | Full pipeline: plan → specialists → audit → synth → critique → verify |
| `enforce_depth_floors` | 2.4 | Anti-laziness gate — counts words/URLs/quotes per specialist; returns respawn directive for any below floor |
| `completeness_audit` | 2.5 | Gap detection on specialist notes; recommends adaptive fill-ins |
| `deep_paper_search` | Specialist | arXiv + Semantic Scholar with citation-graph traversal |
| `trend_quantifier` | Specialist | GitHub/npm/PyPI/Trends/jobs — code-validated curves with slope + R² |
| `funding_pulse` | Standalone | **Real-time funding feed** — SEC EDGAR Form D + Crunchbase RSS + TechCrunch RSS + HN Algolia + layoffs.fyi, cross-referenced |
| `concept_explainer` | Standalone | Layered breakdown (intuition → mechanics → math → code → comparison → pitfalls) |
| `red_team_critique` | 4 | Adversarial review on a *different model family* |
| `validate_with_code` | 3.5 | Python validation: Monte Carlo, trend fit, CI, recompute |
| `citation_verifier` | 6 | Fetch every URL, check claim support |
| `brainstorm_from_research` | Output | Stress-tested project ideas with optional code-validated market fit |
| `list_research_reports` | Browse | Index of everything in `research-output/` |

---

## Usage — every common workflow

You don't invoke these as functions; just describe what you want in
plain English in the Copilot CLI session and the orchestrator routes
to the right tool. Examples below show what to type.

### 🚀 The 90% case — full deep research

```
> Run deep research on "browser-based AI agents"
```

Defaults: `depth=standard`, `autonomy=auto`, all 5 default specialists
(`web_trends`, `academic_papers`, `market_analysis`, `developer_sentiment`,
`social_pulse`), code validation on, multi-model critic.

### 🔥 Maximum-depth research (cost-no-object)

```
> Run deep research on "vector databases for RAG", depth "deep",
  focus_areas ["web_trends", "academic_papers", "market_analysis",
  "competitor_analysis", "tech_landscape", "developer_sentiment",
  "funding_activity", "social_pulse"]
```

This triggers the **deep tier floors** per specialist: 3,000 words, 30
distinct URLs opened, 18 inline quotes, 6 adversarial pairs — auto-respawn
if any specialist falls short. With all 8 specialists, expect 20–60 minutes
of background work and a 10–20K-word grounded report.

### 🛑 Plan-then-execute (interactive)

```
> Run deep research on "post-quantum cryptography", autonomy "interactive"
```

Pauses after planning so you can read/edit the plan before specialists
fire. Useful for novel topics where you want to steer the scope.

### 💰 Just the latest funding rounds

```
> funding_pulse subject "AI agents" window_days 60
> funding_pulse subject "vector database" window_days 90 investors ["a16z", "Sequoia"]
> funding_pulse subject "climate tech" companies ["Climeworks", "Heirloom"]
```

Pulls from SEC EDGAR Form D + Crunchbase News + TechCrunch + HN Algolia
+ layoffs.fyi. Cross-references every round; flags single-source claims.
No API keys required.

### 📚 Just the academic literature

```
> deep_paper_search topic "constitutional AI" paper_count 15 traverse_depth 2
```

Returns a paper-graph report: relevant papers + papers that cite them
critically + papers that those papers cite. arXiv + Semantic Scholar +
optional Google Scholar.

### 📈 Just the adoption metrics

```
> trend_quantifier subject "LangChain" github_repos ["langchain-ai/langchain"]
  pypi_packages ["langchain"] job_keywords ["langchain", "LLM agent"]
```

Pulls GitHub stars-over-time, contributor bus factor, npm/PyPI downloads,
Google Trends, HN "Who's hiring?" mention counts. Fits trend lines and
reports slope + R².

### 🎓 Quick concept explainer (no full pipeline)

```
> Explain "speculative decoding" at practitioner level with runnable code
```

Layered breakdown: intuition → mechanics → math → code → comparisons →
pitfalls. No memory recall, no critique loop — just a focused explainer.

### 🧠 Use prior work

```
> recall_prior_research query "vector database pgvector benchmarks"
```

Returns ranked excerpts from past reports (or `no_matches` if your topic
is genuinely unrelated to anything on file).

### 🪞 Critique an existing draft (cross-model)

```
> red_team_critique target_path "research-output/2026-04-22-abc123-vector-databases-report.md"
  focus "market-size and growth-rate claims"
```

Spawns a critic on a different model family. Saves critique alongside
the report.

### 🔢 Sanity-check a number

```
> validate_with_code claim "Vector-DB market is growing 60% YoY"
  method "trend_fit"
  data_source_hint "Pinecone funding rounds + npm downloads of pgvector"
```

Writes Python that pulls real data, fits a trend, and writes a verdict.
Saved to `research-output/.../artifacts/`.

### 💡 Brainstorm projects from a report

```
> Brainstorm from research-output/2026-04-22-abc123-vector-databases-report.md
  with constraints "solo dev, TypeScript+Python, $0 budget, 8-week timeline"
  validate_top_ideas true
```

Ideas come with pre-mortems, cheap validation plans, and (with the flag)
code-validated market-fit numbers for the top 3.

### 📋 What have I researched?

```
> list_research_reports
```

Or just look in `research-output/` directly.

---

## Pipeline diagram

```
recall_prior_research          MIA-inspired memory (TF-IDF, no off-topic noise)
        ↓
plan_research                  decompose into specialist scopes
        ↓
parallel specialists           CoSearch-inspired multi-query reformulation
  ├── web_trends               ↳ inline-quote evidence
  ├── academic_papers          ↳ arXiv + Semantic Scholar + Google Scholar +
  │                              connectedpapers + paperswithcode + OpenReview
  ├── market_analysis          ↳ Gartner/Forrester/IDC/CB Insights/PitchBook/
  │                              SEC EDGAR (10-K, S-1)
  ├── competitor_analysis      ↳ G2 / Capterra / Product Hunt / AlternativeTo
  ├── tech_landscape           ↳ engineering blogs (Netflix/Uber/Stripe…) + QCon/KubeCon
  ├── developer_sentiment      ↳ GitHub + HN Algolia + named subs + StackOverflow + Lobsters
  ├── funding_activity         ↳ Crunchbase + TechCrunch + investor blogs + layoffs.fyi
  │                              (calls funding_pulse tool for real-time rounds)
  └── social_pulse             ↳ Reddit (multiple subs, .json endpoints) +
                                  HackerNews (Algolia) + X/Twitter + Substack
        ↓
enforce_depth_floors           ⚠️ ANTI-LAZINESS GATE — programmatic
        ↓                       auto-respawn if any specialist is below floor
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
memory update                  index report (with topic tags) for future recall
```

---

## Anti-laziness depth floors

The single most common failure mode of "deep research" agents is stopping
early. This orchestrator enforces hard, programmatically-checked floors
per specialist before allowing the pipeline to advance to synthesis:

| Depth     | Words   | Distinct URLs | Inline quotes | Adversarial pairs |
|-----------|---------|---------------|---------------|-------------------|
| `quick`   |   800   |  8            |  4            | 2                 |
| `standard`| 1,800   | 18            | 10            | 4                 |
| `deep`    | 3,000   | 30            | 18            | 6                 |

If any specialist's notes fall below the floor, the orchestrator calls
`enforce_depth_floors` → gets back a `respawn_directive` → respawns the
specialist with `"⚠️ INSUFFICIENT — keep digging, APPEND don't replace"`
and re-checks. **The agent cannot exit early.**

For the `social_pulse` specialist, additional per-platform floors apply:

| Depth     | Reddit threads / subs | HN comments / stories | X threads | Long-form blogs |
|-----------|------------------------|------------------------|-----------|-----------------|
| `quick`   | 3 / 2                  | 3 / 2                  | 2         | 2               |
| `standard`| 6 / 3                  | 5 / 3                  | 4         | 4               |
| `deep`    | 10 / 4                 | 8 / 4                  | 6         | 6               |

Curl templates for the public HackerNews Algolia API and Reddit `.json`
endpoints are baked into the brief so specialists never have an "I
couldn't search there" excuse.

---

## Configuration

### MCP servers (all optional)

In Copilot CLI, run `/mcp` and copy server entries from `mcp-servers.json`.
Recommended priority order:

| Service | Free tier | Used by | Required? |
|---|---|---|---|
| **Tavily** | 1000 searches/mo | All web research | Highly recommended |
| **Brave Search** | 2000/mo | Falsification cross-check | Optional |
| **ArXiv MCP** | unlimited | `deep_paper_search` | No (built-in fallback) |
| **Semantic Scholar** | unlimited (key for higher rate) | Citation graph | Optional |
| **Firecrawl** | 500 pages/mo | JS-heavy fetches, citation_verifier | Optional |
| **GitHub** | Public API | `trend_quantifier` | Optional |
| **Reddit** | Free OAuth | `social_pulse` | No (public JSON works) |
| **HackerNews** | unlimited | `social_pulse`, `developer_sentiment` | No (Algolia is public) |
| **SerpAPI (Scholar)** | 100/mo | `academic_papers` | No (use Tavily site filter) |
| **Perplexity** | paid | Optional cross-check | Optional |

### Knobs you'll actually use

```
depth: "quick" | "standard" | "deep"           # default: standard
autonomy: "auto" | "interactive"               # default: auto
focus_areas: [...]                             # default: 5-pack
enable_code_validation: true                   # default: true
output_format: "markdown" | "executive_brief"  # default: markdown
critic_model: "gpt-5.4" | …                    # default: gpt-5.4
```

---

## Project layout

```
.
├── .github/
│   ├── copilot-instructions.md
│   ├── extensions/research-orchestrator/extension.mjs   # The orchestrator (~2000 LOC)
│   └── instructions/
│       ├── research.instructions.md         # Falsification, confidence tags, source tiers
│       ├── orchestration.instructions.md    # When/how to spawn subagents (all 7 phases)
│       ├── code-validation.instructions.md  # When/how to validate with code
│       └── memory.instructions.md           # Cross-session memory recall discipline
├── mcp-servers.json                         # MCP server reference config
├── .env.example                             # API key template
├── README.md                                # this file
└── research-output/                         # All artifacts saved here
    ├── _memory-index.md                     # Auto-built TF-IDF memory index
    ├── <id>-<slug>-plan.md
    ├── <id>-<slug>-notes/
    │   ├── <area>.md                        # Per-specialist findings
    │   ├── fillin-<slug>.md                 # Adaptive gap-fill outputs
    │   └── _audit.md                        # Completeness audit
    ├── <id>-<slug>-artifacts/               # Code, data, charts
    ├── <id>-<slug>-funding-pulse.md         # If funding_pulse was run
    ├── <id>-<slug>-trend.md                 # If trend_quantifier was run
    ├── <id>-<slug>-papers.md                # If deep_paper_search was run
    ├── <id>-<slug>-critique.md
    ├── <id>-<slug>-citations.md
    ├── <id>-<slug>-report.md                # ⭐ Final report, auto-indexed
    └── <id>-<slug>-ideas.md                 # If brainstorm was run
```

---

## Why this works (epistemic design)

- **Memory recall first** — avoids redundant work; later reports build on earlier
- **Multi-agent decomposition** — each specialist focuses on one slice; better signal than one big prompt
- **Parallel execution** — N specialists in roughly the wall-clock of one
- **Multi-query reformulation** — 3 rephrasings per claim recovers retrieval recall lost by treating search as fixed (CoSearch showed up to 26.8% F1 left on the table)
- **Falsification by default** — every important claim runs an adversarial search pair before it's allowed in the report
- **Programmatic depth floors** — the agent cannot lie to itself about how thoroughly it searched
- **Completeness audit** — explicit gap detection prevents silent omissions (SeekerGym showed SOTA agents miss >50% of relevant info)
- **Adaptive fill-in** — supervisor spawns more specialists dynamically, not just upfront (HiRAS pattern)
- **Confidence tagging** — calibration matters more than confidence
- **Code validation** — numbers get recomputed, not just quoted (PAL pattern)
- **Multi-model red-team** — critic on different model family = independent error
- **Confidence escalation** — low-confidence on key claims triggers more research
- **Citation verification** — every URL is opened and the claim is checked
- **Memory update** — final report becomes input for next investigation

---

## Extending

- **Add MCP servers** via `/mcp` in Copilot CLI
- **Add focus areas**: edit `SPECIALISTS` in `.github/extensions/research-orchestrator/extension.mjs`
- **Adjust depth floors**: edit `DEPTH_FLOORS` and `SOCIAL_PLATFORM_FLOORS` constants
- **Change critic model**: edit `CRITIC_MODEL` constant (or pass `critic_model` per call)
- **Tighten/relax methodology**: edit files in `.github/instructions/`
- **After editing the extension**, run `extensions_reload` in CLI (no restart needed)

---

## References (the literature behind the design)

- **MIA — Memory Intelligence Agent** (arXiv 2604.04503, Apr 2026) — Manager-Planner-Executor with non-parametric memory + on-the-fly test-time learning
- **HiRAS — Hierarchical Research Agent System** (arXiv 2604.17745, Apr 2026) — supervisory managers coordinating specialists across stages
- **CoSearch** (arXiv 2604.17555, Apr 2026) — joint training of reasoner + ranker; showed fixed retrieval leaves 26.8% F1 on the table
- **SeekerGym** (arXiv 2604.17143, Apr 2026) — completeness-of-retrieval benchmark; best agents retrieve only 42.5% of relevant Wikipedia passages
- **LiteResearcher** (arXiv 2604.17931, Apr 2026) — agentic-RL training framework (not adopted; out of scope for prompt-orchestration)
- Anthropic *"How we built our multi-agent research system"* — orchestrator-workers
- **STORM** (Shao et al. 2024) — outline-first writing
- **Reflexion** (Shinn et al. 2023), **Self-Refine** (Madaan et al. 2023) — critique loops
- **ReAct** (Yao et al. 2022) — reason + act with tools
- **PAL** (Gao et al. 2022) — program-aided validation

---

## License

MIT — see [LICENSE](./LICENSE).

PRs welcome if you've added a specialist or data surface that's worth sharing.
