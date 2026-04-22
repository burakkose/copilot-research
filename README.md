# 🔬 AI Research Agent — Multi-Agent Edition

A best-practice multi-agent research and brainstorming system built on
GitHub Copilot CLI. **Hybrid orchestrator-workers** architecture: a planner
decomposes the topic, spawns parallel specialist subagents, then runs an
adversarial red-team critique, synthesis, and citation-verification pass —
with optional code-driven validation of quantitative claims.

## Pipeline

```
plan_research  →  parallel specialists (general-purpose subagents)
                  ├── web_trends
                  ├── academic_papers
                  ├── market_analysis
                  ├── competitor_analysis
                  ├── tech_landscape
                  ├── developer_sentiment
                  └── funding_activity
                          ↓
                  validate_with_code   ←── (optional, on numeric claims)
                          ↓
                  synthesize draft  →  red_team_critique (rubber-duck)
                          ↓                       ↓
                  revise based on critique ←──────┘
                          ↓
                  citation_verifier  →  finalize report
                          ↓
                  brainstorm_from_research (optional)
```

## Tools

| Tool | What it does |
|---|---|
| `plan_research` | Decompose topic → specialist scopes + adversarial searches → save plan |
| `run_deep_research` | Full pipeline. `autonomy: auto \| interactive`. `enable_code_validation` default `true`. |
| `deep_paper_search` | arXiv + Semantic Scholar + citation-graph traversal (find critics of landmark papers) |
| `trend_quantifier` | GitHub stars/bus-factor, npm/PyPI downloads, Google Trends, job-posting counts — fits curves, reports R² |
| `concept_explainer` | Layered breakdown of a technical concept with runnable code (intro / practitioner / expert) |
| `red_team_critique` | Spawns a rubber-duck agent to adversarially review any draft markdown |
| `citation_verifier` | Fetches every cited URL, checks claim support, flags broken / unsupported / vendor-misclassified |
| `validate_with_code` | Python validation of a quantitative claim — recompute, trend fit, Monte Carlo, survey CI, benchmark |
| `brainstorm_from_research` | Stress-tested project ideas with pre-mortems, optional code-validated market-fit numbers |
| `list_research_reports` | Index of everything in `research-output/` |

## Quick Start

### 1. Install MCP servers (all optional — there are built-in fallbacks)

```bash
cp .env.example .env
$EDITOR .env       # add whichever API keys you have
source .env
```

Then in Copilot CLI, run `/mcp` and copy the server entries from
`mcp-servers.json`. Recommended: `tavily`, `brave-search`, `arxiv`,
`semantic-scholar`, `firecrawl`, `github`.

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

Or with full control:

```
> Use run_deep_research with topic "serverless AI inference",
  depth "deep", focus_areas [web_trends, academic_papers, market_analysis,
  competitor_analysis, tech_landscape], autonomy "interactive",
  enable_code_validation true
```

For overnight autonomous runs use `autonomy: auto` (default) and Shift+Tab
into autopilot mode.

## Common patterns

### Quick concept explainer
```
> Explain "speculative decoding" at practitioner level with runnable code.
```

### Just the trend numbers
```
> Run trend_quantifier on "LangChain" with github_repos ["langchain-ai/langchain"]
  and pypi_packages ["langchain"].
```

### Critique an existing draft
```
> Red-team-critique research-output/2026-04-22-abc123-foo-report.md focusing
  on market-size claims.
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
    orchestration.instructions.md    # When/how to spawn subagents
    code-validation.instructions.md  # When/how to validate with code
mcp-servers.json                     # MCP server reference config
.env.example                         # API key template
research-output/                     # All artifacts saved here
  <id>-<slug>-plan.md
  <id>-<slug>-notes/<area>.md
  <id>-<slug>-artifacts/
  <id>-<slug>-critique.md
  <id>-<slug>-citations.md
  <id>-<slug>-report.md
  <id>-<slug>-ideas.md
```

## Why this works

- **Multi-agent decomposition** — each specialist focuses on one slice; better
  signal than one big prompt
- **Parallel execution** — N specialists in roughly the wall-clock of one
- **Falsification by default** — every important claim runs an adversarial
  search pair before it's allowed in the report
- **Confidence tagging** — calibration matters more than confidence
- **Code validation** — numbers get recomputed, not just quoted
- **Red-team pass** — separate adversarial agent finds what the writer missed
- **Citation verification** — every URL is opened and the claim is checked

## Extending

- Add MCP servers via `/mcp` in Copilot CLI
- Add focus areas: edit `SPECIALISTS` in
  `.github/extensions/research-orchestrator/extension.mjs`
- Tighten or relax methodology in `.github/instructions/`
- After editing the extension, run `extensions_reload` in CLI (no restart needed)
