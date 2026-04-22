import { joinSession } from "@github/copilot-sdk/extension";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const RESEARCH_DIR = join(process.cwd(), "research-output");
if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });

function slugify(text) {
  return text.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
}

function timestamp() {
  return new Date().toISOString().slice(0, 10);
}

const session = await joinSession({
  tools: [
    // ─── Tool 1: Deep Multi-Source Research ───────────────────────────
    {
      name: "run_deep_research",
      description: `Launch a multi-phase research investigation that searches the web,
        reads academic papers, analyzes markets, and produces a comprehensive report.
        Uses all available MCP tools (web_search, web_fetch, tavily, brave-search,
        arxiv, firecrawl) in parallel for maximum coverage. Saves results to ./research-output/`,
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The research topic, question, or area to investigate",
          },
          depth: {
            type: "string",
            enum: ["quick", "standard", "deep"],
            description:
              "quick = surface scan (10 sources), standard = thorough (25+ sources), deep = exhaustive (50+ sources, cross-referencing)",
          },
          focus_areas: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "web_trends",
                "academic_papers",
                "market_analysis",
                "competitor_analysis",
                "tech_landscape",
                "developer_sentiment",
                "funding_activity",
              ],
            },
            description: "Which research dimensions to cover",
          },
          output_format: {
            type: "string",
            enum: ["markdown", "executive_brief"],
            description: "Full markdown report or concise executive brief",
          },
        },
        required: ["topic"],
      },
      handler: async (args) => {
        const topic = args.topic;
        const depth = args.depth || "standard";
        const areas = args.focus_areas || [
          "web_trends",
          "academic_papers",
          "market_analysis",
        ];
        const format = args.output_format || "markdown";
        const slug = slugify(topic);
        const reportPath = join(RESEARCH_DIR, `${timestamp()}-${slug}-report.md`);

        await session.log(`🔬 Starting ${depth} research: "${topic}"`);
        await session.log(`📋 Focus: ${areas.join(", ")}`);
        await session.log(`📁 Output: ${reportPath}`);

        const sourceTargets = {
          quick: 10,
          standard: 25,
          deep: 50,
        };

        const tasks = [];

        if (areas.includes("web_trends")) {
          tasks.push(`## Web Trends & Developer Sentiment
Search the web extensively for the latest trends, blog posts, HackerNews discussions,
Reddit threads, Twitter/X posts, and developer sentiment about: "${topic}".
Find at least ${sourceTargets[depth]} high-quality sources from the last 3-6 months.
Focus on:
- What's gaining traction and why
- Key opinion leaders and their takes
- Community pain points and excitement areas
- Emerging patterns and shifts`);
        }

        if (areas.includes("academic_papers")) {
          tasks.push(`## Academic Papers & Research
Search ArXiv, Semantic Scholar, and academic sources for papers about: "${topic}".
Find the ${depth === "deep" ? "15-20" : "5-10"} most relevant papers (prioritize recent + highly cited).
For each paper provide:
- Title, authors, date, link
- Key findings and methodology
- Practical implications
- How it connects to industry trends`);
        }

        if (areas.includes("market_analysis")) {
          tasks.push(`## Market Analysis
Research the market landscape for: "${topic}".
Find and analyze:
- Market size estimates and growth projections (TAM/SAM/SOM if available)
- Key players and their market positions
- Recent funding rounds and M&A activity
- Gartner/Forrester-style maturity assessments
- Geographic distribution of activity
- Pricing models and business models in use`);
        }

        if (areas.includes("competitor_analysis")) {
          tasks.push(`## Competitor & Alternative Analysis
Find all significant competitors and alternatives in the "${topic}" space.
For each, analyze:
- Product/service overview and key features
- Pricing and business model
- Traction metrics (GitHub stars, users, revenue if public)
- Strengths and weaknesses
- Community activity and developer experience
Create a comparison matrix of the top 5-10 players.`);
        }

        if (areas.includes("tech_landscape")) {
          tasks.push(`## Technology Landscape
Map the technology ecosystem around "${topic}":
- Frameworks, libraries, and tools available
- Architecture patterns and best practices
- Integration patterns and ecosystem connections
- Developer experience and learning curve
- Performance benchmarks if available
- Maturity and stability of key components`);
        }

        if (areas.includes("developer_sentiment")) {
          tasks.push(`## Developer Sentiment & Community
Analyze developer community sentiment around "${topic}":
- GitHub trending repos and star growth
- Stack Overflow question volume and trends
- Reddit/HackerNews discussion themes
- Developer survey data if available
- Common complaints and praise
- Adoption barriers and enablers`);
        }

        if (areas.includes("funding_activity")) {
          tasks.push(`## Funding & Investment Activity
Research venture capital and investment activity in "${topic}":
- Recent funding rounds (last 12 months)
- Key investors and their theses
- Acquisition activity
- Corporate R&D investments
- Open source funding and sustainability`);
        }

        const researchPrompt = `You are a senior research analyst conducting a ${depth} investigation.

# Research Brief: "${topic}"

Use ALL available research tools aggressively: web_search, web_fetch, and any MCP
tools (tavily, brave-search, arxiv, firecrawl, etc.). Search broadly, read deeply,
cross-reference findings.

**Methodology:**
1. Cast a wide net first — search from multiple angles and phrasings
2. Deep-read the most promising sources (don't just skim titles)
3. Cross-reference claims across sources
4. Note contradictions and debates
5. Identify gaps in current knowledge

**Execute these research tasks:**

${tasks.join("\n\n")}

---

**After completing ALL tasks, synthesize into a final report with this structure:**

# Research Report: ${topic}
*Generated: ${new Date().toISOString()}*
*Depth: ${depth} | Sources target: ${sourceTargets[depth]}+*

## Executive Summary
(3-5 paragraph overview of key findings)

## Key Findings
(Organized by focus area, with evidence and citations)

${tasks.map((t) => t.split("\n")[0]).join("\n")}

## Cross-Cutting Themes
(Patterns that emerged across multiple research areas)

## Emerging Opportunities
(Specific opportunities identified, ranked by timing and potential)

## Risks & Challenges
(What could go wrong, what's overhyped, contrarian views)

## Recommended Next Steps
(Concrete actions the reader should take)

## Sources & References
(All sources used, organized by category)

**Save the complete report to: ${reportPath}**
${format === "executive_brief" ? "\nAlso create a 1-page executive brief version." : ""}`;

        setTimeout(() => session.send({ prompt: researchPrompt }), 100);

        return JSON.stringify({
          status: "research_initiated",
          topic,
          depth,
          focus_areas: areas,
          source_target: sourceTargets[depth],
          report_path: reportPath,
          message: `Research pipeline launched with ${tasks.length} parallel focus areas targeting ${sourceTargets[depth]}+ sources. The agent is now executing the full research pipeline.`,
        });
      },
    },

    // ─── Tool 2: Brainstorm Project Ideas ─────────────────────────────
    {
      name: "brainstorm_from_research",
      description:
        "Analyze a completed research report and generate actionable, ranked project ideas with feasibility analysis",
      parameters: {
        type: "object",
        properties: {
          report_path: {
            type: "string",
            description: "Path to the research report markdown file",
          },
          constraints: {
            type: "string",
            description:
              "Your constraints: team size, budget, tech stack, timeline, experience level",
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
        const count = args.idea_count || 10;
        const slug = basename(reportPath, ".md");
        const ideasPath = join(RESEARCH_DIR, `${slug}-ideas.md`);

        await session.log(`💡 Brainstorming from: ${reportPath}`);

        const prompt = `Read the research report at: ${reportPath}

Based on the findings, generate exactly ${count} concrete, actionable project ideas.

For EACH idea, provide:

### [Number]. [Project Name]
**One-liner:** What it does in one sentence
**Problem:** What specific pain point it addresses (cite from report)
**Opportunity:** Why NOW is the right time (cite trend/data from report)
**Target User:** Who would use this
**MVP Scope:** Minimum viable version (2-4 week build)
**Full Vision:** Where this could go in 12 months
**Tech Stack:** Recommended technologies with reasoning
**Difficulty:** ⭐ to ⭐⭐⭐⭐⭐
**Market Potential:** 🟢 Small | 🟡 Medium | 🔴 Large
**Competitive Moat:** What makes this defensible
**Unique Angle:** What makes this different from existing solutions
**First Step:** The very first thing to build/validate

${args.constraints ? `\n**Builder Constraints:** ${args.constraints}\nTailor all ideas to these constraints.\n` : ""}

---

After listing all ideas, create a **Ranking Matrix**:

| # | Idea | Feasibility (1-5) | Impact (1-5) | Timing (1-5) | Score |
|---|------|-------------------|--------------|--------------|-------|

Score = Feasibility × Impact × Timing

End with your **Top 3 Recommendations** and why.

**Save to: ${ideasPath}**`;

        setTimeout(() => session.send({ prompt }), 100);

        return JSON.stringify({
          status: "brainstorming_initiated",
          report_path: reportPath,
          ideas_path: ideasPath,
          idea_count: count,
          message: `Analyzing report and generating ${count} ranked project ideas.`,
        });
      },
    },

    // ─── Tool 3: Research Status ──────────────────────────────────────
    {
      name: "list_research_reports",
      description: "List all research reports and brainstorm outputs in the research-output directory",
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

          if (files.length === 0) return "No research reports found yet. Run run_deep_research to create one.";

          return JSON.stringify({ reports: files, directory: RESEARCH_DIR }, null, 2);
        } catch {
          return "Research output directory is empty. Run run_deep_research to get started.";
        }
      },
    },
  ],

  hooks: {
    onSessionStart: async () => {
      await session.log("🔬 Research Orchestrator loaded");
      return {
        additionalContext: `The research-orchestrator extension is active. You have these research tools:

1. **run_deep_research** — Launch comprehensive multi-source research on any topic.
   Searches web, academic papers, market data, and more using all available MCP tools.
   Supports depth levels: quick (10 sources), standard (25+), deep (50+).

2. **brainstorm_from_research** — Analyze a research report and generate ranked project ideas
   with feasibility scoring.

3. **list_research_reports** — Show all completed research reports.

When doing research, use ALL available search and fetch tools aggressively and in parallel.
Save all output to ./research-output/ with timestamped filenames.
Always cite sources with URLs.`,
      };
    },

    onPostToolUse: async (input) => {
      if (input.toolName === "create" && String(input.toolArgs?.path || "").includes("research-output")) {
        await session.log(`📄 Research output saved: ${input.toolArgs.path}`);
      }
    },

    onErrorOccurred: async (input) => {
      if (input.recoverable) {
        await session.log(`⚠️ Recoverable error: ${input.error}. Retrying...`, { level: "warning" });
        return { errorHandling: "retry", retryCount: 3 };
      }
    },
  },
});

// Notify when the agent goes idle (research may be done)
session.on("session.idle", async () => {
  const { readdirSync } = await import("node:fs");
  try {
    const reports = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
    if (reports.length > 0) {
      await session.log(`✅ Research complete. ${reports.length} report(s) in ./research-output/`, { ephemeral: true });
    }
  } catch { /* ignore */ }
});
