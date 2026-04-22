// Research Orchestrator — Multi-Agent Edition
//
// Hybrid orchestrator-workers architecture:
//   plan → parallel specialists → synthesize → red-team → revise → verify citations
//
// Each tool sends a structured prompt to the main agent (Claude), which then
// uses its `task` tool to spawn sub-agents in parallel. State flows through
// files in research-output/<id>-*; never through giant prompts.

import { joinSession } from "@github/copilot-sdk/extension";
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const RESEARCH_DIR = join(process.cwd(), "research-output");
if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });

// ─── Helpers ────────────────────────────────────────────────────────────

const slugify = (t) =>
  t.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "").slice(0, 60);

function newReportId() {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${randomBytes(3).toString("hex")}`;
}

function reportPaths(id, slug) {
  const base = join(RESEARCH_DIR, id);
  return {
    id,
    slug,
    base,
    plan:      join(RESEARCH_DIR, `${id}-${slug}-plan.md`),
    notesDir:  join(RESEARCH_DIR, `${id}-${slug}-notes`),
    artifacts: join(RESEARCH_DIR, `${id}-${slug}-artifacts`),
    critique:  join(RESEARCH_DIR, `${id}-${slug}-critique.md`),
    citations: join(RESEARCH_DIR, `${id}-${slug}-citations.md`),
    report:    join(RESEARCH_DIR, `${id}-${slug}-report.md`),
    ideas:     join(RESEARCH_DIR, `${id}-${slug}-ideas.md`),
  };
}

function ensureDirs(p) {
  for (const d of [RESEARCH_DIR, p.notesDir, p.artifacts]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function safeResolveReport(p) {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!abs.startsWith(RESEARCH_DIR)) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

let researchInFlight = false;

// ─── Specialist scope library ───────────────────────────────────────────
//
// Each focus area has a name + a per-specialist prompt. The orchestrator
// composes a wrapper around these for parallel `task` dispatch.

const SPECIALISTS = {
  web_trends: {
    title: "Web Trends & Practitioner Sentiment",
    brief: (topic) => `Map what practitioners, pundits and critics are saying about "${topic}".

Adversarial pairs (run BOTH):
- "${topic} adoption 2025 2026" ↔ "${topic} overhyped" / "why I stopped using ${topic}"
- "${topic} best practices" ↔ "${topic} problems" / "${topic} migration away"
- "${topic} success stories" ↔ "${topic} postmortem"

Deliver:
- What's gaining traction and WHY (adoption metrics > buzz)
- Key voices AND their notable critics (named, with links)
- Community pain points (often the best opportunities)
- Prior "emerging patterns" in this space that fizzled — what happened?
- Signal vs. noise verdict: real adoption data or just media coverage?`,
  },
  academic_papers: {
    title: "Academic Papers & Citation Graph",
    brief: (topic, depth) => `Find ${depth === "deep" ? "10–15" : "6–8"} relevant papers on "${topic}".

Use arXiv + Semantic Scholar. Prefer: recent + cited + survey + critical.

Strategy:
1. Direct topic search (3 query rephrasings)
2. Survey/review papers (field consensus)
3. Negative-result and replication papers
4. Citation-graph traversal: for the top 2 most-cited papers, find papers
   that cite them critically (not just admiringly)

Per paper: title, authors, date, arXiv/DOI link, key findings (specific
numbers when present), methodology, known limitations or critiques.

Tag confidence on the field's consensus: ✅/🔵/🟠/⚡.`,
  },
  market_analysis: {
    title: "Market Analysis & Sizing",
    brief: (topic) => `Quantify the market for "${topic}".

Adversarial pairs:
- "${topic} market size" ↔ "${topic} forecast accuracy" / "${topic} bubble"
- "${topic} TAM" ↔ "${topic} reality vs hype"

Deliver:
- Market size from 2+ INDEPENDENT analyst sources (note methodology differences)
- If sources disagree by >2× → explain why, don't average
- Key players ranked by actual position (revenue / users > self-reported claims)
- Funding & M&A activity (12mo)
- Hype-cycle position with justification
- How accurate were past projections for this space?

For headline numbers, request a code-validation pass via the validate_with_code
tool: recompute CAGR, run sensitivity, build a TAM Monte Carlo.`,
  },
  competitor_analysis: {
    title: "Competitor & Alternative Landscape",
    brief: (topic) => `Map competitors and alternatives in the "${topic}" space.

Search sequence:
1. Direct competitors (named tools/products)
2. "alternative to <each major player>" — surfaces non-obvious ones
3. "<competitor> review" + "<competitor> complaints" — real user experience
4. "<competitor> shutdown OR pivot OR layoffs" — failures

Per competitor: what they do, pricing, traction (hard metrics > claims),
what users praise, what users complain about, what they got wrong.

Build a comparison matrix. Weaknesses must be as visible as strengths.`,
  },
  tech_landscape: {
    title: "Technology Landscape & Maturity",
    brief: (topic) => `Map the tech ecosystem around "${topic}".

Maturity test: per technology, search for production case studies (mature)
vs. only launch announcements/demos (early). Note the difference.

Deliver:
- Established vs. emerging tools, with maturity evidence per tool
- Architecture patterns from PRACTITIONERS (not just docs)
- Integration pain points (search complaints / workarounds)
- Developer experience: learning curve, docs, community health
- Graveyard: tools/frameworks abandoned and why (links to postmortems)`,
  },
  developer_sentiment: {
    title: "Developer Community Sentiment",
    brief: (topic) => `Analyze developer sentiment for "${topic}".

Reality checks (apply rigorously):
- GitHub stars ≠ adoption. Check issue activity, commit frequency, bus factor.
- Growing SO questions = growing adoption OR growing confusion — distinguish.
- Blog posts ≠ usage.

Search separately: enthusiasts, critics, daily practitioners. How has sentiment
shifted vs. 6–12 months ago? Job postings mentioning this skill — trending up?

Use the trend_quantifier tool for hard numbers (stars, downloads, jobs).`,
  },
  funding_activity: {
    title: "Funding & Investment Activity",
    brief: (topic) => `Investment activity in "${topic}".

Signal check: one large round ≠ market validation. Look for BREADTH — how
many independent firms are investing across multiple companies?

Deliver:
- Recent rounds (12mo) with amounts, leads, co-investors
- Investor theses and their track record in this space
- Acqui-hires (talent grab) vs. strategic acquisitions
- Companies that raised big and collapsed — what went wrong?
- Down rounds, layoffs, valuation cuts in this space`,
  },
};

const ALL_AREAS = Object.keys(SPECIALISTS);

// ─── Tasks (focus-area prompt blocks) ───────────────────────────────────

function buildSpecialistDispatch(topic, areas, depth, paths) {
  const lines = areas.map((area) => {
    const spec = SPECIALISTS[area];
    if (!spec) return null;
    const notesPath = join(paths.notesDir, `${area}.md`);
    return `
**Specialist: ${spec.title}** → write findings to \`${notesPath}\`
\`\`\`
${spec.brief(topic, depth)}

Output contract:
- Write full findings (markdown, ~1500–2500 words depending on depth) to: ${notesPath}
- Use confidence tags (✅/🔵/🟠/⚡) on conclusions and numbers
- Cite sources as [Title, Date](URL) and tier them (Primary / Independent / Vendor)
- End with: "What I'm least sure about" + "What would change this conclusion"
- Return to the orchestrator: a 200-word summary + the file path. NOT the full content.
\`\`\``;
  }).filter(Boolean);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

const session = await joinSession({
  tools: [
    // ─── 1. plan_research ────────────────────────────────────────────
    {
      name: "plan_research",
      description: "Generate a structured research plan for a topic before executing. Decomposes the topic into specialist scopes, adversarial searches, and code-validation candidates. Saves to research-output/.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic or question" },
          depth: { type: "string", enum: ["quick", "standard", "deep"] },
          focus_areas: { type: "array", items: { type: "string", enum: ALL_AREAS } },
          context: { type: "string", description: "Optional: prior knowledge, constraints, or specific angles to emphasize" },
        },
        required: ["topic"],
      },
      handler: async (args) => {
        const topic = args.topic;
        const depth = args.depth || "standard";
        const areas = args.focus_areas?.length ? args.focus_areas : ["web_trends", "academic_papers", "market_analysis"];
        const id = newReportId();
        const slug = slugify(topic);
        const paths = reportPaths(id, slug);
        ensureDirs(paths);

        await session.log(`📋 Planning research: "${topic}" (${depth})`);

        const prompt = `# Research Planning Phase

Topic: **${topic}**
Depth: ${depth}
Focus areas: ${areas.join(", ")}
${args.context ? `Additional context: ${args.context}\n` : ""}

You are the research planner. Produce a structured plan, then SAVE it to:
\`${paths.plan}\`

Follow \`.github/instructions/orchestration.instructions.md\`.

The plan must contain:

## 1. Topic Decomposition
3–8 independent research questions, each scoped tightly enough for one
specialist subagent. Avoid overlap.

## 2. Specialist Assignments
For each focus area in [${areas.join(", ")}], state:
- The specific question(s) the specialist will answer
- 2–3 adversarial search pairs to run
- Any specific sources/communities to mine
- Output file path: \`${paths.notesDir}/<area>.md\`

## 3. Quantitative Validation Candidates
List the numerical claims most likely to need code validation
(see \`code-validation.instructions.md\`):
- Each candidate: claim type, data source, planned method
- Artifact path: \`${paths.artifacts}/<slug>.{py,md}\`

## 4. Cross-Cutting Themes
Issues that span multiple specialists (e.g., one competitor appearing in
3 areas). Note how synthesis will reconcile.

## 5. Risks to the Research Itself
What could make THIS research misleading? (e.g., topic is too new for solid
data; vendor-dominated source landscape; non-English primary sources we'll miss)

## 6. Deliverables Checklist
- Plan: ${paths.plan}
- Notes: ${paths.notesDir}/
- Artifacts: ${paths.artifacts}/
- Critique: ${paths.critique}
- Citations log: ${paths.citations}
- Final report: ${paths.report}

After saving, output to chat:
- The 6 research questions
- The IDs/areas to use with run_deep_research's continue_from_plan parameter:
  \`{ continue_from_plan: "${paths.plan}" }\``;

        setTimeout(() => session.send({ prompt }), 100);

        return JSON.stringify({
          status: "planning_initiated",
          id, slug, depth, focus_areas: areas,
          plan_path: paths.plan,
          notes_dir: paths.notesDir,
          report_path_when_done: paths.report,
        });
      },
    },

    // ─── 2. run_deep_research ────────────────────────────────────────
    {
      name: "run_deep_research",
      description: "Full hybrid multi-agent research pipeline: plan → parallel specialists → synthesize → red-team critique → revise → citation verification. Optionally validates numbers with code. Saves all artifacts under research-output/.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic or question" },
          depth: { type: "string", enum: ["quick", "standard", "deep"], description: "quick=surface scan, standard=thorough, deep=exhaustive with citation traversal" },
          focus_areas: { type: "array", items: { type: "string", enum: ALL_AREAS }, description: "Research dimensions to cover" },
          autonomy: { type: "string", enum: ["auto", "interactive"], description: "auto=run all phases unattended; interactive=pause after planning for user approval (default: auto)" },
          enable_code_validation: { type: "boolean", description: "Run code validation on quantitative claims (default: true)" },
          output_format: { type: "string", enum: ["markdown", "executive_brief"], description: "Full report or 1-page brief (default: markdown)" },
          continue_from_plan: { type: "string", description: "Skip planning; use this existing plan file path" },
        },
        required: ["topic"],
      },
      handler: async (args) => {
        if (researchInFlight) {
          return "A research session is already running. Wait for it to complete first.";
        }

        const topic = args.topic;
        const depth = args.depth || "standard";
        const areas = args.focus_areas?.length ? args.focus_areas : ["web_trends", "academic_papers", "market_analysis"];
        const autonomy = args.autonomy || "auto";
        const codeVal = args.enable_code_validation !== false;
        const format = args.output_format || "markdown";

        let id, slug;
        if (args.continue_from_plan) {
          const planAbs = safeResolveReport(args.continue_from_plan);
          if (!planAbs) return `Plan not found at ${args.continue_from_plan} (must be inside research-output/).`;
          // derive id/slug from filename: <id>-<slug>-plan.md
          const m = basename(planAbs).match(/^(\d{4}-\d{2}-\d{2}-[a-f0-9]+)-(.+)-plan\.md$/);
          if (!m) return `Plan filename does not match expected pattern.`;
          id = m[1]; slug = m[2];
        } else {
          id = newReportId();
          slug = slugify(topic);
        }
        const paths = reportPaths(id, slug);
        ensureDirs(paths);

        await session.log(`🔬 Deep research: "${topic}" (${depth}, ${autonomy}, code=${codeVal})`);
        await session.log(`📁 Workspace: ${paths.notesDir}`);

        const maxParallel = Math.min(areas.length, 5);
        const dispatch = buildSpecialistDispatch(topic, areas, depth, paths);

        const prompt = `# Deep Research Pipeline — "${topic}"

Depth: **${depth}** | Autonomy: **${autonomy}** | Code validation: **${codeVal}** | Format: **${format}**

You are the lead research orchestrator. Follow the hybrid orchestrator-workers
pattern in \`.github/instructions/orchestration.instructions.md\`.

Workspace (already created):
- Plan: \`${paths.plan}\`
- Notes: \`${paths.notesDir}/\`
- Artifacts: \`${paths.artifacts}/\`
- Critique: \`${paths.critique}\`
- Citations log: \`${paths.citations}\`
- Final report: \`${paths.report}\`

---

## PHASE 1 — PLAN
${args.continue_from_plan ? `Plan already exists at \`${paths.plan}\` — read it and proceed to Phase 2.` :
`Use the \`plan_research\` tool, OR draft the plan inline and save it to \`${paths.plan}\`.
The plan must list specialist assignments, adversarial pairs, and code-validation candidates.`}

${autonomy === "interactive" ? `**Interactive mode**: After saving the plan, output a one-paragraph summary
and STOP. Wait for the user to approve or revise before continuing to Phase 2.
Do not spawn specialists yet.` : `**Auto mode**: Proceed directly to Phase 2 after the plan is saved.`}

---

## PHASE 2 — PARALLEL SPECIALIST RESEARCH

Spawn **${areas.length} specialist subagents in parallel** using the \`task\` tool
(\`agent_type: "general-purpose"\`, \`mode: "background"\`). **Issue all task
calls in a SINGLE response** — that is the only way they run truly in parallel.
Cap at ${maxParallel} concurrent.

Each specialist must follow \`.github/instructions/research.instructions.md\`
(falsification, confidence tags, source tiers).

${dispatch}

After spawning, end your turn. You will be notified as each completes;
collect their summaries and notes paths.

---

## PHASE 3 — SYNTHESIS

When all specialists report in:
1. Read each notes file (use \`view\`, not full reads of giant files)
2. Identify cross-cutting themes — don't just concatenate
3. Resolve contradictions or surface them as ⚡ Contested
4. Draft the report to \`${paths.report}\` using the schema below

${codeVal ? `## PHASE 3.5 — CODE VALIDATION

For each quantitative claim flagged in the plan as a validation candidate,
invoke \`validate_with_code\` (or directly write a Python script via \`bash\`).
Save artifacts to \`${paths.artifacts}/\`. Annotate validated claims in the
report with \`[code-verified](./<artifact>.md)\`.` : ""}

---

## PHASE 4 — RED-TEAM CRITIQUE

Use the \`red_team_critique\` tool, OR spawn a \`rubber-duck\` agent
(\`mode: "sync"\`) with the draft report path. Save the critique to
\`${paths.critique}\`.

## PHASE 5 — REVISE

Address each critique point. If a real gap is exposed → spawn a focused
specialist to fill it (Phase 2-style), then revise again. If evidence is
genuinely thin → downgrade the confidence tag, don't paper over.

## PHASE 6 — CITATION VERIFICATION

Use the \`citation_verifier\` tool on \`${paths.report}\`. It will fetch
each cited URL and check claim support, writing results to \`${paths.citations}\`.
After verification: remove or downgrade any unsupported claims, then
overwrite \`${paths.report}\` with the final version.

---

## REPORT SCHEMA — save to \`${paths.report}\`

\`\`\`markdown
# Research Report: ${topic}
*Date: ${new Date().toISOString().slice(0, 10)} | Depth: ${depth} | Pipeline: hybrid multi-agent*

## TL;DR (3 bullets)
The single most important finding, stated baldly. The strongest counter-argument
and why your conclusion still holds. Overall confidence: 🟢 / 🟡 / 🔴 + one-line
justification.

## Executive Summary
3–5 paragraphs. Lead with the highest-impact finding.

## Findings
One subsection per specialist area. Tag conclusions/numbers with confidence.
Cite sources as [Title, Date](URL). Reference \`[code-verified](./<artifact>.md)\`
for validated numerics.

End each subsection with:
- "What I'm least sure about"
- "What would change this conclusion"

## Cross-Cutting Themes
Patterns that emerged across multiple specialists. Contradictions and how they
were resolved (or surfaced as ⚡).

## Quantitative Validation
Summary of code-validated claims. For each: claim → method → result → caveat.
Link to the artifact under \`${paths.artifacts}\`.

## Open Questions
What couldn't be resolved. Searches that returned thin results.
Assumptions the conclusions depend on.

## Opportunities
Ranked by (evidence strength × timing × unmet need). For each:
- Why now: specific trend creating the window
- Why it might fail: steel-manned risk
- What signal would tell you this thesis is wrong

## Risks & Contrarian Views
Steel-man the skeptics. Pre-mortem: "If this space disappoints in 2 years,
the cause is most likely ___."

## Methodology Notes
- Specialists spawned: ${areas.join(", ")}
- Code validations: list artifacts
- Critique addressed: yes/no, key revisions made
- Citations verified: N/M URLs confirmed
- Known methodology limitations

## Sources
Grouped by tier:
**Primary** (original data, papers, filings)
**Independent secondary** (named practitioners, independent benchmarks)
**Vendor / self-published** (treat as claims)

Each: [Title](URL) — date — one-line credibility note
\`\`\`

${format === "executive_brief" ? `\nAlso produce a 1-page executive brief at \`${paths.report.replace(".md", "-brief.md")}\`.` : ""}

When the report is final, log "✅ Research complete: ${paths.report}".`;

        researchInFlight = true;
        setTimeout(async () => {
          try { await session.send({ prompt }); }
          finally { researchInFlight = false; }
        }, 100);

        return JSON.stringify({
          status: "research_pipeline_initiated",
          id, slug, topic, depth, autonomy,
          focus_areas: areas,
          code_validation: codeVal,
          plan_path: paths.plan,
          notes_dir: paths.notesDir,
          artifacts_dir: paths.artifacts,
          report_path: paths.report,
        });
      },
    },

    // ─── 3. deep_paper_search ────────────────────────────────────────
    {
      name: "deep_paper_search",
      description: "Specialist tool for academic literature: searches arXiv + Semantic Scholar, traverses citation graphs (papers that cite/are-cited-by), finds critical responses to landmark papers. Writes a structured paper-graph report.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research question or area" },
          paper_count: { type: "number", description: "Target number of papers (default 10)" },
          traverse_depth: { type: "number", description: "Citation graph depth (1=cited-by, 2=plus their citers; default 1)" },
          output_path: { type: "string", description: "Optional output path under research-output/" },
        },
        required: ["topic"],
      },
      handler: async (args) => {
        const topic = args.topic;
        const count = args.paper_count || 10;
        const depth = args.traverse_depth || 1;
        const id = newReportId();
        const slug = slugify(topic);
        const out = args.output_path && safeResolveReport(args.output_path)
          ? args.output_path
          : join(RESEARCH_DIR, `${id}-${slug}-papers.md`);

        await session.log(`📚 Deep paper search: "${topic}" (${count} papers, depth ${depth})`);

        const prompt = `# Deep Paper Search — "${topic}"

Goal: produce a curated, citation-graph-aware literature map.

## Step 1 — Initial corpus
Search arXiv and (if available via MCP) Semantic Scholar. Run 3 query rephrasings.
Identify ${count} candidate papers prioritizing:
- Recent (last 24 months) AND well-cited
- Surveys / review papers (field consensus)
- Methodological papers introducing new techniques in this area
- Negative-results / replication / critique papers

## Step 2 — Citation graph traversal (depth=${depth})
For the top 3 most-cited papers in your initial corpus:
- Find papers that cite them (use Semantic Scholar API if available, or web
  search "cited by <title>" / "<title> follow-up")
- Specifically seek CRITICAL citers, not just admiring ones
${depth >= 2 ? "- Then repeat one level deeper for the top critical responses" : ""}

## Step 3 — Synthesis

Write to \`${out}\`:

\`\`\`markdown
# Paper Map: ${topic}
*Generated: ${new Date().toISOString().slice(0, 10)}*

## Field Consensus
(From surveys/reviews — what's broadly agreed)

## Landmark Papers
For each (target ${count}):
### [Title]
- Authors, venue, date, link (arXiv/DOI)
- TL;DR (2-3 sentences)
- Key result with specific numbers
- Methodology (one paragraph)
- Citations: <count> | Critics: <comma list of critic paper titles or "none found">
- Limitations / what it doesn't address

## Active Debates
Where the field disagrees. Each side's strongest paper.

## Open Problems
What surveys / recent papers explicitly call out as unsolved.

## Reading Order
A suggested 5-paper sequence for someone new to this area.
\`\`\`

Use confidence tags from \`research.instructions.md\` on consensus claims.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "paper_search_initiated", topic, output_path: out });
      },
    },

    // ─── 4. trend_quantifier ─────────────────────────────────────────
    {
      name: "trend_quantifier",
      description: "Pulls hard adoption metrics for a topic / library / technology: GitHub stars over time + bus factor, npm/PyPI download trends, Google Trends, job-posting counts. Writes Python scripts under artifacts/, fits trend lines, reports slope + R².",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Topic, library name, or technology to quantify" },
          github_repos: { type: "array", items: { type: "string" }, description: "owner/repo strings to analyze" },
          npm_packages: { type: "array", items: { type: "string" }, description: "npm package names" },
          pypi_packages: { type: "array", items: { type: "string" }, description: "PyPI package names" },
          job_keywords: { type: "array", items: { type: "string" }, description: "Search terms for job-posting trends" },
          output_path: { type: "string" },
        },
        required: ["subject"],
      },
      handler: async (args) => {
        const subject = args.subject;
        const id = newReportId();
        const slug = slugify(subject);
        const artifactsDir = join(RESEARCH_DIR, `${id}-${slug}-trend-artifacts`);
        if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true });
        const out = args.output_path || join(RESEARCH_DIR, `${id}-${slug}-trend.md`);

        await session.log(`📈 Quantifying trends: "${subject}"`);

        const repos = args.github_repos || [];
        const npm = args.npm_packages || [];
        const pypi = args.pypi_packages || [];
        const jobs = args.job_keywords || [subject];

        const prompt = `# Trend Quantifier — "${subject}"

Pull hard adoption metrics. Write Python scripts to \`${artifactsDir}/\` and
report results to \`${out}\`. Follow \`code-validation.instructions.md\`.

## Data sources to pull

${repos.length ? `**GitHub repos**: ${repos.join(", ")}
- For each: stars over time, weekly commits (last 52w), unique contributors
  (last 90d), bus factor (top contributor's % of commits), open-issue/PR ratio,
  time-to-close-issue median.
- Use GitHub REST API (no auth needed for public read at low rates) or the
  github-mcp-server tool if loaded.
- Save raw JSON to \`${artifactsDir}/<repo>.json\`.
- Fit linear + exponential to weekly stars; report slope + R².` : "_(no GitHub repos specified)_"}

${npm.length ? `**npm packages**: ${npm.join(", ")}
- Use https://api.npmjs.org/downloads/range/<from>:<to>/<pkg> (24-month window)
- Aggregate weekly. Plot. Compute CAGR. Note any cliffs (potential dependency churn).` : "_(no npm packages)_"}

${pypi.length ? `**PyPI packages**: ${pypi.join(", ")}
- Use pypistats.org/api or pepy.tech. Same analysis as npm.` : "_(no PyPI packages)_"}

**Google Trends** (proxy for general interest)
- If pytrends works in this env, pull 5-year interest curve for: ${jobs.join(", ")}
- Otherwise note as ❓ Unknown and suggest manual check.

**Job postings** (real demand signal)
- Search "${jobs.join('", "')}" on (1) HN "Who is hiring?" via https://hn.algolia.com
  API for the last 12 months — count mentions per month.
- Optionally try LinkedIn jobs search count or indeed.com (note if blocked).

## Output: \`${out}\`

\`\`\`markdown
# Trend Quantification: ${subject}
*Date: ${new Date().toISOString().slice(0, 10)}*

## Headline numbers
| Metric | Value | Period | Confidence |
|---|---|---|---|

## GitHub momentum
Per-repo: stars curve, slope, R², bus factor, contributor health.
Diagnosis: 🟢 Healthy / 🟡 Concentrated / 🔴 Bus-factor risk.

## Download trends
Per-package: 12-month CAGR, weekly trajectory, anomalies.

## Search interest
Google Trends curve summary.

## Hiring demand
HN "Who's hiring" mentions per month + trend.

## Sanity checks performed
What you cross-checked, what you couldn't.

## Caveats
Bot inflation? Self-hosted not counted? Date pulled?

## Artifacts
List of files in \`${artifactsDir}/\`.
\`\`\``;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "trend_quantifier_initiated", subject, artifacts_dir: artifactsDir, output_path: out });
      },
    },

    // ─── 5. concept_explainer ────────────────────────────────────────
    {
      name: "concept_explainer",
      description: "Deep technical breakdown of a concept: builds a layered explanation (intuition → mechanics → math → code → comparison → pitfalls), with worked examples and runnable code. Best for understanding a technique before deciding whether to use it.",
      parameters: {
        type: "object",
        properties: {
          concept: { type: "string", description: "Technical concept to explain" },
          audience: { type: "string", enum: ["intro", "practitioner", "expert"], description: "Default: practitioner" },
          include_code: { type: "boolean", description: "Include runnable example code (default true)" },
          comparisons: { type: "array", items: { type: "string" }, description: "Other concepts to compare against" },
          output_path: { type: "string" },
        },
        required: ["concept"],
      },
      handler: async (args) => {
        const concept = args.concept;
        const audience = args.audience || "practitioner";
        const includeCode = args.include_code !== false;
        const id = newReportId();
        const slug = slugify(concept);
        const out = args.output_path || join(RESEARCH_DIR, `${id}-${slug}-explainer.md`);
        const artifactsDir = join(RESEARCH_DIR, `${id}-${slug}-artifacts`);
        if (includeCode && !existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true });

        await session.log(`🧠 Explaining concept: "${concept}" (${audience})`);

        const prompt = `# Concept Explainer — "${concept}"

Audience: **${audience}**. Build a layered explanation that the audience can
actually USE — not Wikipedia paraphrasing.

## Research first
- Find the canonical primary source(s) (paper, RFC, standard, originating talk)
- Find 2 high-quality practitioner explanations (different framings)
- Find 1 known critique or limitation discussion

## Write to \`${out}\`:

\`\`\`markdown
# ${concept}

## TL;DR
One paragraph. What it is, what problem it solves, when to use it.

## Intuition (no math)
A mental model. Analogy if useful, but not at the cost of accuracy.

## How it actually works
The mechanics. ${audience !== "intro" ? "Include the math where it clarifies, not as decoration." : "Skip heavy math; use diagrams in pseudocode if useful."}

## Worked example
A concrete, small example traced step by step.

${includeCode ? `## Runnable code
A minimal, executable example (Python preferred). Save to
\`${artifactsDir}/<slug>.py\` and embed the key snippet here. Run it; show the
output. Don't fake the output.

Keep dependencies minimal. If a real run isn't possible (needs GPU, paid API,
etc.) say so and provide a mock that still demonstrates the structure.` : ""}

${args.comparisons?.length ? `## Comparison: ${concept} vs ${args.comparisons.join(" vs ")}
| Aspect | ${concept} | ${args.comparisons.join(" | ")} |
For each: when to prefer it, complexity, performance, ecosystem.` : ""}

## Common pitfalls
What practitioners get wrong. Drawn from real debugging stories / blog posts.

## When NOT to use it
Honest list. Every technique has wrong contexts.

## Further reading
- Primary source(s) with link
- 2 best practitioner explanations
- 1 critique
\`\`\`

Use confidence tags only on contested claims (e.g., "X is faster than Y").`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "explainer_initiated", concept, output_path: out, artifacts_dir: artifactsDir });
      },
    },

    // ─── 6. red_team_critique ────────────────────────────────────────
    {
      name: "red_team_critique",
      description: "Spawns an adversarial reviewer (rubber-duck agent) on a research report or any markdown file. Surfaces unsupported claims, hand-waved numbers, missing counter-evidence, biased framing, citation issues. Writes critique to disk.",
      parameters: {
        type: "object",
        properties: {
          target_path: { type: "string", description: "Path to the markdown file to critique (must be in research-output/)" },
          focus: { type: "string", description: "Optional: specific concerns to focus on (e.g., 'numbers and market-size claims')" },
          output_path: { type: "string", description: "Where to write the critique (default: <target>-critique.md)" },
        },
        required: ["target_path"],
      },
      handler: async (args) => {
        const target = safeResolveReport(args.target_path);
        if (!target) return `Target not found at ${args.target_path} (must be inside research-output/).`;

        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : target.replace(/\.md$/, "-critique.md");

        await session.log(`🔴 Red-team critique: ${basename(target)}`);

        const prompt = `# Red-Team Critique

Target: \`${target}\`
Output: \`${out}\`
${args.focus ? `Specific focus: ${args.focus}` : ""}

Step 1: Read the target file in full.

Step 2: Spawn a \`rubber-duck\` agent (\`mode: "sync"\`) with this brief:

> You are an adversarial reviewer. The author wants you to find every weakness
> a skeptical expert would notice. The author has explicitly invited a harsh
> review — be direct, not diplomatic.
>
> Read: ${target}
>
> Review for:
> 1. **Unsupported claims** — assertions without sources or with weak sources
> 2. **Hand-waved numbers** — figures presented without source or methodology
> 3. **Missing counter-evidence** — was the falsification step actually done?
> 4. **Biased framing** — survivorship, hype-cycle, anchoring, confirmation,
>    single-narrator, recency, selection bias
> 5. **Logical leaps** — opportunities/recommendations that don't follow from findings
> 6. **Citation problems** — broken-looking URLs, vendor-only sources stacked
>    as "independent", same source double-counted
> 7. **Confidence calibration** — claims tagged ✅ that should be 🟠, etc.
> 8. **Hidden assumptions** — what does the conclusion depend on that's unstated?
> ${args.focus ? `9. **Special focus**: ${args.focus}` : ""}
>
> For each issue: quote the exact passage, state the problem, suggest a fix
> (more search, downgrade tag, remove claim).
>
> End with: a verdict on overall epistemic quality (🟢/🟡/🔴) and the 3
> highest-priority issues to address.

Step 3: Write the critique output to \`${out}\` in this format:

\`\`\`markdown
# Red-Team Critique: ${basename(target)}
*Reviewer: rubber-duck agent | Date: ${new Date().toISOString().slice(0, 10)}*

## Verdict
🟢 Solid / 🟡 Fixable / 🔴 Substantial revision needed

## Top 3 Priority Issues
1. ...
2. ...
3. ...

## All Findings
### [Issue 1 title]
- **Location**: <quote or section>
- **Problem**: ...
- **Suggested fix**: ...

(repeat for each)

## What the report does WELL
(brief — name the strongest sections so revision doesn't break them)
\`\`\``;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "critique_initiated", target_path: target, output_path: out });
      },
    },

    // ─── 7. citation_verifier ────────────────────────────────────────
    {
      name: "citation_verifier",
      description: "Extracts every cited URL from a report, fetches each one, and checks whether the cited claim is actually supported by the source. Flags broken/paywalled/unsupported citations. Writes a verification log.",
      parameters: {
        type: "object",
        properties: {
          report_path: { type: "string", description: "Path to the report (must be in research-output/)" },
          output_path: { type: "string", description: "Where to write the verification log" },
          max_citations: { type: "number", description: "Cap to verify (default: all; useful for very long reports)" },
        },
        required: ["report_path"],
      },
      handler: async (args) => {
        const report = safeResolveReport(args.report_path);
        if (!report) return `Report not found at ${args.report_path} (must be inside research-output/).`;

        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : report.replace(/\.md$/, "-citations.md");
        const cap = args.max_citations || 0;

        await session.log(`🔗 Verifying citations in ${basename(report)}`);

        const prompt = `# Citation Verification Pass

Report: \`${report}\`
Log output: \`${out}\`
${cap ? `Max citations to verify: ${cap}` : ""}

## Method

1. Read \`${report}\`. Extract every citation — markdown links \`[text](url)\`,
   bare URLs, and footnote-style references. Build a list of (claim_context, url) pairs.

2. For each URL${cap ? ` (up to ${cap})` : ""}, in BATCHES OF 5 IN PARALLEL using
   \`web_fetch\`:
   - Fetch the page (markdown mode)
   - Determine status:
     - ✅ **Supported** — page clearly contains the cited claim or its data
     - 🟡 **Partial** — page mentions the topic but specific claim isn't there
     - 🔴 **Unsupported** — page exists but doesn't say what was cited
     - 💀 **Broken** — 404, blocked, paywalled, or redirected
     - ⚠️ **Vendor-as-independent** — claim was tagged independent but source is vendor

3. Write verification log to \`${out}\`:

\`\`\`markdown
# Citation Verification — ${basename(report)}
*Date: ${new Date().toISOString().slice(0, 10)}*

## Summary
- Total citations: N
- ✅ Supported: A | 🟡 Partial: B | 🔴 Unsupported: C | 💀 Broken: D | ⚠️ Vendor-misclassified: E

## Issues to address
(only the non-✅ ones)

### [URL]
- **Claim in report**: "..." (section: ...)
- **Status**: 🔴 Unsupported
- **What the source actually says**: ...
- **Suggested action**: remove claim / find replacement / downgrade to 🟠
\`\`\`

4. After writing the log, output to chat: a one-line summary + the count of
   issues that need addressing. Do NOT modify the report itself — that's the
   orchestrator's call.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "citation_verification_initiated", report_path: report, output_path: out });
      },
    },

    // ─── 8. validate_with_code ───────────────────────────────────────
    {
      name: "validate_with_code",
      description: "Validate a quantitative claim by writing and running Python: pull raw data, recompute the headline number, fit trends, run Monte Carlo, sanity-check survey statistics. Saves script + data + writeup to artifacts/.",
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The specific claim to validate (e.g. 'X market is growing 40% YoY')" },
          method: { type: "string", enum: ["recompute", "trend_fit", "monte_carlo", "survey_ci", "benchmark", "custom"], description: "Which validation pattern to apply" },
          data_source_hint: { type: "string", description: "Where to pull data from (URL, API, dataset name)" },
          artifacts_dir: { type: "string", description: "Directory under research-output/ to save artifacts (default: auto)" },
          notes: { type: "string", description: "Free-form context: what assumptions to test, what the source claimed, etc." },
        },
        required: ["claim", "method"],
      },
      handler: async (args) => {
        const id = newReportId();
        const slug = slugify(args.claim).slice(0, 40);
        const artDir = args.artifacts_dir
          ? (safeResolveReport(args.artifacts_dir) || join(RESEARCH_DIR, basename(args.artifacts_dir)))
          : join(RESEARCH_DIR, `${id}-${slug}-validation`);
        if (!existsSync(artDir)) mkdirSync(artDir, { recursive: true });

        await session.log(`🧮 Validating with code: "${args.claim}" (${args.method})`);

        const patternHint = {
          recompute: "Pattern A — Pull raw data and recompute the headline number. Compare; flag discrepancies >5%.",
          trend_fit: "Pattern B — Fit linear AND exponential to the time series. Report slope, R², and which fit is better.",
          monte_carlo: "Pattern C — Build a Monte Carlo with explicit assumption distributions. Report P10/P50/P90, not a point estimate.",
          survey_ci: "Pattern D — Find sample size; compute Wilson 95% CI on the proportion; flag if N<100 or selection-biased.",
          benchmark: "Pattern E — Replicate the benchmark on neutral hardware. Document workload, versions, methodology BEFORE numbers.",
          custom: "Choose the most appropriate validation. Document method clearly.",
        }[args.method];

        const prompt = `# Code Validation Task

**Claim**: ${args.claim}
**Method**: ${args.method} — ${patternHint}
${args.data_source_hint ? `**Data source hint**: ${args.data_source_hint}` : ""}
${args.notes ? `**Notes**: ${args.notes}` : ""}

Artifacts dir: \`${artDir}\`

Follow \`.github/instructions/code-validation.instructions.md\`.

## Steps

1. Write a Python script to \`${artDir}/validate.py\` that pulls the data and
   computes the result. Use \`requests\` / \`pandas\` / \`numpy\` / \`scipy\`
   /\`statsmodels\` as needed (\`pip install\` if missing).
2. Run it via \`bash\`. Capture stdout to \`${artDir}/output.txt\`.
3. Save raw fetched data to \`${artDir}/data.json\` (or .csv).
4. Write a writeup to \`${artDir}/writeup.md\`:

\`\`\`markdown
# Validation: ${args.claim}
*Date: ${new Date().toISOString().slice(0, 10)} | Method: ${args.method}*

## Source claim
${args.claim}

## Method
What you did, in one paragraph. Include assumptions, date range, sample size.

## Result
- Headline number: <your computed value>
- Source's claim: <theirs>
- Discrepancy: <delta and direction>
- Confidence: ✅ Verified / 🔵 Likely / 🟠 Speculative / ⚡ Contested / ❌ Refuted

## Caveats
- Date pulled
- Data quality issues
- What this does NOT tell us
- Sensitivity: which assumption swings the result most?

## Reproducibility
\`python validate.py\` from this directory.
\`\`\`

5. Output to chat: a one-line verdict (verified / refuted / partial / inconclusive)
   plus the writeup path.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "code_validation_initiated", claim: args.claim, method: args.method, artifacts_dir: artDir });
      },
    },

    // ─── 9. brainstorm_from_research ─────────────────────────────────
    {
      name: "brainstorm_from_research",
      description: "Generate stress-tested project ideas from a research report, with pre-mortems, validation plans, and (optionally) code-validated market-fit numbers.",
      parameters: {
        type: "object",
        properties: {
          report_path: { type: "string", description: "Path to the research report (must be in research-output/)" },
          constraints: { type: "string", description: "Builder constraints: team size, budget, stack, timeline" },
          idea_count: { type: "number", description: "Number of ideas to generate (default 10)" },
          validate_top_ideas: { type: "boolean", description: "Run validate_with_code on top-3 ideas' market-fit numbers (default false)" },
        },
        required: ["report_path"],
      },
      handler: async (args) => {
        const report = safeResolveReport(args.report_path);
        if (!report) return `Report not found at ${args.report_path} (must be inside research-output/).`;
        const count = args.idea_count || 10;
        const validate = args.validate_top_ideas === true;
        const slug = basename(report, ".md");
        const ideasPath = join(RESEARCH_DIR, `${slug}-ideas.md`);

        await session.log(`💡 Brainstorming from: ${basename(report)}`);

        const prompt = `# Brainstorm — Stress-Tested Ideas

Source report: \`${report}\`
Output: \`${ideasPath}\`
Idea count: ${count}
${args.constraints ? `Constraints: ${args.constraints}` : ""}

Read the report fully first. Then run all three phases.

## Phase 1: Diverge (cast wide)

Extract EVERY opportunity signal:
- Pain points users mentioned
- Gaps between what exists and what's needed
- Trends lacking tooling or infrastructure
- Intersections where 2+ findings create a compound opportunity
- Contrarian angles (consensus says X, evidence suggests Y)

Aim for 20+ raw signals. Quality of signal sourcing > volume.

## Phase 2: Stress-test (kill the weak)

For each candidate, answer honestly:
1. **Does this exist?** Search "[idea] tool" / "[idea] product". If yes with
   traction → drop unless you can name a specific differentiator.
2. **Why hasn't it been built?** There's usually a reason. What is it?
3. **Who pays?** "Developers, for free" = hobby. Specific buyer + evidence
   they'd pay = real.
4. **Hardest unsolved problem in building it?** Be concrete.
5. **Pre-mortem**: if this dies in 6 months, why?

Drop ideas that fail Q1 or Q2.

## Phase 3: Converge — top ${count}

For each survivor:

### [N]. [Project name]
**One-liner**: ...
**Problem**: ... (cite report evidence with section/quote)
**Why now**: ... (cite specific data point)
**Target user**: who, and how they solve this today
**MVP (2–4 weeks)**: scope to test the idea
**12-month vision**: where this goes if it works
**Tech stack**: what + why
**Difficulty**: ⭐–⭐⭐⭐⭐⭐
**Market**: 🟢 Niche / 🟡 Mid / 🔴 Large
**Moat**: what's defensible, or "speed only"
**Pre-mortem**: "This fails because ___"
**Cheapest validation**: how to test demand BEFORE writing code
**First 48 hours**: concrete actions
${args.constraints ? `**Constraint fit**: how it fits within ${args.constraints}` : ""}

## Ranking table
| # | Idea | Feasibility | Impact | Timing | Score |
|---|------|-------------|--------|--------|-------|
1–5 each. Score = F × I × T. Be honest — 5/5/5 should be rare.

## Recommendations
1. Top 3 overall — and the key assumption each depends on
2. Fastest to validate — least effort to learn if this has legs
3. Highest ceiling — biggest upside if it works
4. Safest bet — useful even if market thesis is wrong

${validate ? `## Phase 4 (extra): Validate market-fit numbers
For each of the top 3 ideas, identify the single most decision-relevant
quantitative assumption (e.g. "30% of teams have this pain", "users will pay
$20/mo"). Use the \`validate_with_code\` tool to check it. Append a
"Numerical reality check" subsection to each top-3 idea linking to the
artifact.` : ""}

Save to: \`${ideasPath}\``;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({
          status: "brainstorming_initiated",
          report_path: report,
          ideas_path: ideasPath,
          idea_count: count,
          validate_top_ideas: validate,
        });
      },
    },

    // ─── 10. list_research_reports ───────────────────────────────────
    {
      name: "list_research_reports",
      description: "List all reports, plans, notes, critiques, and brainstorm outputs in research-output/.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        try {
          const entries = readdirSync(RESEARCH_DIR);
          const items = entries
            .filter((f) => f !== ".gitkeep")
            .map((f) => {
              const p = join(RESEARCH_DIR, f);
              const s = statSync(p);
              return {
                name: f,
                kind: s.isDirectory() ? "dir"
                  : f.endsWith("-plan.md") ? "plan"
                  : f.endsWith("-report.md") ? "report"
                  : f.endsWith("-ideas.md") ? "ideas"
                  : f.endsWith("-critique.md") ? "critique"
                  : f.endsWith("-citations.md") ? "citations"
                  : f.endsWith("-explainer.md") ? "explainer"
                  : f.endsWith("-papers.md") ? "papers"
                  : f.endsWith("-trend.md") ? "trend"
                  : "other",
                size: s.isDirectory() ? "-" : `${(s.size / 1024).toFixed(1)}KB`,
                modified: s.mtime.toISOString().slice(0, 16),
              };
            })
            .sort((a, b) => b.modified.localeCompare(a.modified));
          if (items.length === 0) return "No reports yet. Run plan_research or run_deep_research to start.";
          return JSON.stringify({ directory: RESEARCH_DIR, items }, null, 2);
        } catch (e) {
          return `Error listing reports: ${e.message}`;
        }
      },
    },
  ],

  hooks: {
    onSessionStart: async () => {
      await session.log("🔬 Research Orchestrator (multi-agent) loaded");
      return {
        additionalContext: `Research orchestrator active — multi-agent, falsification-first.

**Tools**
- \`plan_research\` — generate a structured research plan
- \`run_deep_research\` — full hybrid pipeline (plan → parallel specialists → critique → synth → cite-verify)
- \`deep_paper_search\` — arXiv + Semantic Scholar with citation-graph traversal
- \`trend_quantifier\` — GitHub/npm/PyPI/Trends/jobs with code-validated curves
- \`concept_explainer\` — layered technical breakdowns with runnable code
- \`red_team_critique\` — adversarial review of a draft (uses rubber-duck agent)
- \`citation_verifier\` — fetch each cited URL, check claim support
- \`validate_with_code\` — Python validation of a quantitative claim (Monte Carlo, trend fit, CI)
- \`brainstorm_from_research\` — stress-tested project ideas (with optional code-validation)
- \`list_research_reports\` — index of everything in research-output/

**Methodology lives in:**
\`.github/instructions/research.instructions.md\` (falsification, confidence tags, source tiers)
\`.github/instructions/orchestration.instructions.md\` (when/how to spawn subagents)
\`.github/instructions/code-validation.instructions.md\` (when/how to write validation code)

Default for \`run_deep_research\`: autonomy=auto, code_validation=true.
Use autonomy=interactive to pause after planning.`,
      };
    },

    onPostToolUse: async (input) => {
      const args = input.toolArgs || {};
      const path = String(args.path || args.file_path || "");
      if ((input.toolName === "create" || input.toolName === "edit") && path.includes("research-output")) {
        await session.log(`📄 ${input.toolName === "create" ? "Saved" : "Updated"}: ${path}`);
      }
    },

    onErrorOccurred: async (input) => {
      if (input.recoverable) {
        await session.log("⚠️ Retrying...", { level: "warning" });
        return { errorHandling: "retry", retryCount: 3 };
      }
    },
  },
});

session.on("session.idle", async () => {
  try {
    const reports = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith("-report.md"));
    if (reports.length > 0) {
      await session.log(`✅ ${reports.length} report(s) in ./research-output/`, { ephemeral: true });
    }
  } catch { /* ignore */ }
});
