# Copilot Instructions

This is a research and brainstorming workspace built on a multi-agent
orchestration pattern (planner → parallel specialists → red-team critique →
synthesizer → citation verifier).

## Workflow at a glance

| Tool | Phase | What it does |
|---|---|---|
| `plan_research` | Plan | Decompose a topic into specialist scopes + adversarial searches |
| `run_deep_research` | All | Full hybrid pipeline; spawns parallel `task` subagents |
| `deep_paper_search` | Specialist | arXiv + Semantic Scholar with citation-graph traversal |
| `trend_quantifier` | Specialist | GitHub / npm / PyPI / Trends / jobs — code-validated |
| `concept_explainer` | Standalone | Layered technical breakdown with runnable code |
| `red_team_critique` | Critique | Adversarial review of any draft (uses rubber-duck agent) |
| `citation_verifier` | Verify | Fetches each cited URL, checks claim support |
| `validate_with_code` | Validate | Python validation of a quantitative claim |
| `brainstorm_from_research` | Ideate | Stress-tested project ideas, optional code validation |
| `list_research_reports` | Browse | Index of everything in research-output/ |

## Methodology

Three instruction files apply to anything written under `research-output/`:

1. **`.github/instructions/research.instructions.md`** — falsification, confidence
   tagging (✅/🔵/🟠/⚡/❓), source-tier hierarchy, bias pre-flight
2. **`.github/instructions/orchestration.instructions.md`** — when/how to spawn
   subagents, parallelism rules, specialist prompt templates, state-passing via files
3. **`.github/instructions/code-validation.instructions.md`** — when to write
   code, standard patterns (recompute, trend fit, Monte Carlo, survey CI), what to save

## Defaults

- All output goes under `./research-output/` with a per-run `<id>-<slug>-*` namespace
- `run_deep_research` defaults: `autonomy=auto`, `enable_code_validation=true`
- Specialists run in parallel via the `task` tool — issue all spawn calls in
  ONE response or they won't actually parallelize
- For numeric claims: prefer `validate_with_code` over trusting the source
- Save intermediate findings to disk; never rely on long-context retention
