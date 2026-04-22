---
applyTo: "research-output/**"
---

# Cross-Session Memory

The orchestrator maintains an auto-built index of every report under
`research-output/` at `research-output/_memory-index.md`. The index is
refreshed on session start, after every report write, and on session end.

This is inspired by **MIA — Memory Intelligence Agent** (arXiv 2604.04503,
Apr 2026), which showed that storing compressed past trajectories and
having the planner consult them on every new query beats stateless
re-planning across 11 benchmarks.

---

## When to recall

**Always run `recall_prior_research` at the start of a new investigation**,
before drafting a plan. Three outcomes:

| Match quality | Action |
|---|---|
| Direct hit (prior report covers same topic) | Tell the user. Ask if they want a **refresh** (new data, same scope) or a **new angle** (different focus areas). Do not silently duplicate. |
| Adjacent (related topic, different scope) | Cite the prior report in the new plan's "Prior context" section. Build on its findings; don't re-derive them. |
| No match | Note "no prior research" and proceed fresh. |

---

## What's stored

The index entry per report:
- Title (from `# H1`)
- Path
- Updated date + size
- **Tags**: top 5–8 most distinctive terms from the report, auto-extracted
  by TF-IDF over the whole corpus. Tags are the cheapest way to know
  whether a prior report is in the same topic cluster as your new query.
- TL;DR or Executive Summary excerpt (≤600 chars)

The full report files are *not* loaded into context — only the index digest.
Use `recall_prior_research(query, full_content: true)` to pull the top match
in full when needed.

---

## How retrieval works (and why unrelated topics return nothing)

Memory uses **TF-IDF with length normalization, title-token boosting (5×),
and a minimum relevance threshold** — not semantic embeddings, but stronger
than raw keyword count:

- A token that appears in >70% of reports (corpus ≥5) gets zero weight —
  it's noise.
- The score is normalized by report length, so a long report doesn't
  automatically win.
- A query whose tokens never overlap distinctively with any prior report
  returns `status: "no_matches"` rather than weak spurious hits. This is
  intentional — running unrelated investigations should NOT pollute the new
  one with prior context.

So when you do a coffee-brewing run after an AI-agents run, `recall_prior_research`
on coffee terms will simply return `no_matches` and you proceed fresh. No
cross-contamination.

---

## How to phrase recall queries

- **Use specific terms** the prior report would have used (look at its tags
  in `_memory-index.md`)
- **Try multiple keywords** if the first query returns nothing
- **Don't paraphrase** — match the original framing
- For follow-up runs that are deliberately related, query using the prior
  report's distinctive tags

Example:
```
recall_prior_research("LLM agent benchmarks GAIA")        # good — specific
recall_prior_research("how good are AI agents these days") # weaker — vague
```

---

## When NOT to use memory

- The user explicitly asked for a "fresh take" without prior context
- The prior report is >12 months old in a fast-moving area (note staleness;
  re-research, but cite the prior report's claims as "as of <date>")
- The prior report itself is flagged ⚡ Contested or 🔴 verdict — don't
  build on shaky ground

---

## Memory hygiene

- The `onPostToolUse` hook auto-refreshes the index when a `*-report.md`
  is written.
- Drafts (notes, plans, critiques, audits) are NOT indexed — only final reports.
- If a report is later retracted, delete it AND `_memory-index.md`; both
  rebuild on next session start.
