import { joinSession } from "@github/copilot-sdk/extension";
import { mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";

const RESEARCH_DIR = join(process.cwd(), "research-output");
if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });

function slugify(text) {
  return text.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
}

function reportId() {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(3).toString("hex");
  return `${date}-${suffix}`;
}

// Track whether a research prompt is already in-flight
let researchInFlight = false;

// ═══════════════════════════════════════════════════════════════════════
// Research task templates — lean, skeptical, action-oriented
// ═══════════════════════════════════════════════════════════════════════

function buildTasks(topic, depth, areas) {
  const tasks = [];

  if (areas.includes("web_trends")) {
    tasks.push(`### Web Trends & Sentiment
Research: "${topic}" — what practitioners, pundits, and critics are saying.

Adversarial search pairs (execute BOTH, note what each returns):
- "${topic} adoption 2025 2026" ↔ "${topic} criticism" OR "${topic} overhyped"
- "${topic} best practices" ↔ "${topic} problems" OR "why I stopped using ${topic}"

Deliver:
- What's gaining traction and WHY (adoption metrics > buzz)
- Key voices AND their notable critics
- Community pain points (often the best project opportunities)
- Prior "emerging patterns" in this space that fizzled — what happened?
- Signal vs. noise verdict: is there real adoption data, or just media coverage?`);
  }

  if (areas.includes("academic_papers")) {
    tasks.push(`### Academic Papers
Search ArXiv and academic sources for: "${topic}".
Find ${depth === "deep" ? "10-15" : "5-8"} relevant papers (prioritize: recent + cited).

Search strategy:
- Direct topic search
- Survey/review papers (these represent field consensus)
- Negative results and comparison papers (what DOESN'T work)

Per paper: title, authors, date, link, key findings, methodology,
practical implications, known criticisms or limitations.`);
  }

  if (areas.includes("market_analysis")) {
    tasks.push(`### Market Analysis
Research market landscape for: "${topic}".

Adversarial search pairs:
- "${topic} market size" ↔ "${topic} market size inflated" OR "past ${topic} forecasts accuracy"

Deliver:
- Market size from 2+ independent analyst sources (note methodology differences)
- Key players by actual position (revenue data > self-reported claims)
- Funding/M&A activity
- Hype cycle position (and whether that assessment is warranted)
- How accurate past market projections for this space turned out to be`);
  }

  if (areas.includes("competitor_analysis")) {
    tasks.push(`### Competitor Analysis
Find competitors and alternatives in the "${topic}" space.

Search: direct competitors, then "alternative to [each major player]" for non-obvious
ones, then "[competitor] review" AND "[competitor] complaints" for real user experience,
then "[competitor] shutdown OR pivot" for failures.

Per competitor: what they do, pricing, traction (hard metrics > claims),
what users praise, what users complain about, what they got wrong.
Build a comparison matrix. Weaknesses as visible as strengths.`);
  }

  if (areas.includes("tech_landscape")) {
    tasks.push(`### Technology Landscape
Map the tech ecosystem around: "${topic}".

Maturity test: for each technology, search for production case studies (mature)
vs. only launch announcements/demos (early). Note which.

Deliver:
- Established vs. emerging tools with maturity evidence
- Architecture patterns (from practitioners, not just docs)
- Integration pain points (search for complaints/workarounds)
- Developer experience: learning curve, docs quality, community
- Graveyard: tools/frameworks abandoned and why`);
  }

  if (areas.includes("developer_sentiment")) {
    tasks.push(`### Developer Sentiment
Analyze community sentiment around: "${topic}".

Reality checks:
- GitHub stars ≠ adoption (check: issue activity, commit frequency, bus factor)
- Growing SO questions = growing adoption OR growing confusion — which?
- Blog posts ≠ usage

Search for enthusiast, critic, and daily-practitioner views separately.
How has sentiment shifted vs. 6-12 months ago? Job postings mentioning this?`);
  }

  if (areas.includes("funding_activity")) {
    tasks.push(`### Funding Activity
Research investment activity in: "${topic}".

Signal check: one large round ≠ market validation. Look for breadth —
how many independent firms are investing?

Deliver: recent rounds (12mo) with amounts/investors, investor theses and track
records in this space, acqui-hires vs strategic acquisitions, companies that
raised big and collapsed — what went wrong?`);
  }

  return tasks;
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

const session = await joinSession({
  tools: [
    // ─── Deep Research ────────────────────────────────────────────────
    {
      name: "run_deep_research",
      description: `Multi-source research with falsification, confidence calibration, and
        adversarial search. Searches web, papers, markets. Saves report to ./research-output/`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The research topic or question",
          },
          depth: {
            type: "string",
            enum: ["quick", "standard", "deep"],
            description: "quick=surface scan, standard=thorough, deep=exhaustive with cross-referencing",
          },
          focus_areas: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "web_trends", "academic_papers", "market_analysis",
                "competitor_analysis", "tech_landscape",
                "developer_sentiment", "funding_activity",
              ],
            },
            description: "Research dimensions to cover",
          },
          output_format: {
            type: "string",
            enum: ["markdown", "executive_brief"],
            description: "Full report or concise executive brief",
          },
        },
        required: ["topic"],
      },
      handler: async (args) => {
        if (researchInFlight) {
          return "A research session is already running. Wait for it to complete first.";
        }

        const topic = args.topic;
        const depth = args.depth || "standard";
        const areas = args.focus_areas || ["web_trends", "academic_papers", "market_analysis"];
        const format = args.output_format || "markdown";
        const id = reportId();
        const slug = slugify(topic);
        const reportPath = join(RESEARCH_DIR, `${id}-${slug}-report.md`);

        await session.log(`🔬 Starting ${depth} research: "${topic}"`);
        await session.log(`📁 Output: ${reportPath}`);

        const tasks = buildTasks(topic, depth, areas);

        // ── The prompt: role + task + output schema. Methodology lives in instructions file. ──

        const prompt = `You are investigating: "${topic}"
Your report will be read by someone who will fact-check your claims. Be rigorous.

# Research Tasks

Use the best available mix of search and fetch tools. For important claims,
use at least 2 distinct search surfaces. Follow the research methodology
in your instructions (falsification, adversarial search, confidence tagging).

${tasks.join("\n\n")}

---

# For Each Major Finding

Before including a decision-relevant claim in the report, briefly document:
1. Supporting evidence: what you found and from where
2. Counter-evidence search: what you searched for and what came back
3. Confidence after seeing both sides

You don't need to do this for every background fact — only for conclusions,
numbers, trend assessments, and recommendations.

---

# Report — save to: ${reportPath}

\`\`\`markdown
# Research Report: ${topic}
*Date: ${new Date().toISOString().slice(0, 10)} | Depth: ${depth}*

## Executive Summary
3-5 paragraphs. Lead with the most important finding.
State the strongest counter-argument you found and why your conclusion holds.
Overall confidence: 🟢 High | 🟡 Medium | 🔴 Low (with justification).

## Findings
One subsection per research task above.
Tag conclusions and numbers with confidence levels.
Cite sources as [Title, Date](URL).

## Open Questions
What you couldn't resolve. What searches returned thin results.
What assumptions your conclusions depend on.
These are as valuable as findings — they prevent false confidence.

## Opportunities
Ranked by (evidence strength × timing × unmet need). For each:
- Why now: specific trend creating the window
- Why it might fail: steel-manned risk
- What signal would tell you this thesis is wrong

## Risks & Contrarian Views
Present the skeptics' BEST arguments.
Pre-mortem: "If this space disappoints in 2 years, the likely cause is ___."

## Sources
Grouped by quality: Primary | Independent secondary | Vendor/self-published
Each: [Title](URL) — date — one-line credibility note
\`\`\`
${format === "executive_brief" ? "\nAlso create a separate 1-page executive brief." : ""}`;

        researchInFlight = true;
        setTimeout(async () => {
          try {
            await session.send({ prompt });
          } finally {
            researchInFlight = false;
          }
        }, 100);

        return JSON.stringify({
          status: "research_initiated",
          topic,
          depth,
          focus_areas: areas,
          report_path: reportPath,
        });
      },
    },

    // ─── Brainstorm ───────────────────────────────────────────────────
    {
      name: "brainstorm_from_research",
      description: "Generate stress-tested project ideas from a research report, with pre-mortems and validation plans",
      parameters: {
        type: "object",
        properties: {
          report_path: {
            type: "string",
            description: "Path to the research report (must be in ./research-output/)",
          },
          constraints: {
            type: "string",
            description: "Builder constraints: team size, budget, stack, timeline",
          },
          idea_count: {
            type: "number",
            description: "Number of ideas to generate (default: 10)",
          },
        },
        required: ["report_path"],
      },
      handler: async (args) => {
        const reportPath = args.report_path;
        const resolvedPath = join(process.cwd(), reportPath);

        // Path validation
        if (!resolvedPath.startsWith(RESEARCH_DIR) && !existsSync(reportPath)) {
          return `Error: report not found at ${reportPath}. Use list_research_reports to see available reports.`;
        }

        const count = args.idea_count || 10;
        const slug = basename(reportPath, ".md");
        const ideasPath = join(RESEARCH_DIR, `${slug}-ideas.md`);

        await session.log(`💡 Brainstorming from: ${reportPath}`);

        const prompt = `Read the research report at: ${reportPath}

Generate ${count} project ideas that survive scrutiny. Quality over cleverness.

## Phase 1: Diverge

Extract EVERY opportunity signal from the report:
- Pain points users mentioned
- Gaps between what exists and what's needed
- Trends lacking tooling or infrastructure
- Intersections where 2+ findings create a compound opportunity
- Contrarian angles (consensus says X, but evidence suggests Y)

Aim for 20+ raw signals. Cast wide.

## Phase 2: Stress-Test

For each candidate idea, answer honestly:
1. Does this already exist? Search "[idea] tool" or "[idea] product" if unsure.
   If it exists with traction, drop it — unless you can name a specific differentiator.
2. Why hasn't this been built? There's usually a reason. What is it?
3. Who pays, and is there evidence they'd pay? "Developers, for free" = hobby project.
4. What's the single hardest unsolved problem in building this?
5. Pre-mortem: if this fails in 6 months, why?

Drop ideas that can't pass questions 1-2.

## Phase 3: Converge

Select the ${count} strongest survivors. For each:

### [Number]. [Project Name]
**One-liner:** What it does
**Problem:** Pain point it addresses (cite report evidence)
**Why now:** What trend creates the window (cite specific data)
**Target user:** Who, and how they solve this today
**MVP (2-4 weeks):** What you'd build to test the idea
**12-month vision:** Where this goes if it works
**Tech stack:** What and why
**Difficulty:** ⭐-⭐⭐⭐⭐⭐
**Market:** 🟢 Niche | 🟡 Mid | 🔴 Large
**Moat:** What's defensible (or: "no moat — speed is the advantage")
**Pre-mortem:** "This fails because ___"
**Cheapest validation:** How to test demand before writing code
**First 48 hours:** What to do first
${args.constraints ? `**Constraint fit:** How it works within: ${args.constraints}` : ""}

## Ranking

| # | Idea | Feasibility | Impact | Timing | Score |
|---|------|-------------|--------|--------|-------|
(1-5 each. Score = F × I × T. Be honest — 5/5/5 should be rare.)

## Recommendations
1. **Top 3 overall** — and the key assumption each depends on
2. **Fastest to validate** — least effort to learn if this has legs
3. **Highest ceiling** — biggest upside if it works
4. **Safest bet** — useful even if market thesis is wrong

Save to: ${ideasPath}`;

        setTimeout(() => session.send({ prompt }), 100);

        return JSON.stringify({
          status: "brainstorming_initiated",
          report_path: reportPath,
          ideas_path: ideasPath,
          idea_count: count,
        });
      },
    },

    // ─── List Reports ─────────────────────────────────────────────────
    {
      name: "list_research_reports",
      description: "List all research reports and brainstorm outputs",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const { readdirSync, statSync } = await import("node:fs");
        try {
          const files = readdirSync(RESEARCH_DIR)
            .filter((f) => f.endsWith(".md"))
            .map((f) => {
              const stats = statSync(join(RESEARCH_DIR, f));
              return {
                name: f,
                size: `${(stats.size / 1024).toFixed(1)}KB`,
                modified: stats.mtime.toISOString().slice(0, 16),
              };
            })
            .sort((a, b) => b.modified.localeCompare(a.modified));

          if (files.length === 0) return "No reports yet. Run run_deep_research to create one.";
          return JSON.stringify({ reports: files, directory: RESEARCH_DIR }, null, 2);
        } catch {
          return "Research output directory is empty.";
        }
      },
    },
  ],

  hooks: {
    onSessionStart: async () => {
      await session.log("🔬 Research Orchestrator loaded");
      return {
        additionalContext: `Research orchestrator active. Tools:
- **run_deep_research** — investigate any topic with adversarial search and falsification
- **brainstorm_from_research** — stress-tested project ideas from a report
- **list_research_reports** — show completed reports

Research methodology (falsification, confidence tagging, bias checks) is in your instructions.`,
      };
    },

    onPostToolUse: async (input) => {
      if (input.toolName === "create" && String(input.toolArgs?.path || "").includes("research-output")) {
        await session.log(`📄 Saved: ${input.toolArgs.path}`);
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
  const { readdirSync } = await import("node:fs");
  try {
    const reports = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
    if (reports.length > 0) {
      await session.log(`✅ ${reports.length} report(s) in ./research-output/`, { ephemeral: true });
    }
  } catch { /* ignore */ }
});
