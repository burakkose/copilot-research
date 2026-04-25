// Research Orchestrator — Multi-Agent Edition v2 (Enterprise)
//
// Hybrid orchestrator-workers + memory + adaptive supervision:
//   recall prior research → plan → parallel specialists (multi-query) →
//   completeness audit → adaptive gap-fill → citation-grounded synthesis →
//   multi-model red-team → confidence-based escalation → citation verify
//
// Each tool sends a structured prompt to the main agent (Claude), which then
// uses its `task` tool to spawn sub-agents in parallel — including critique
// agents on a *different* model family for variance reduction. State flows
// through files in research-output/<id>-*; never through giant prompts.
//
// v2 additions over v1 (informed by Apr 2026 literature: MIA, HiRAS,
// CoSearch, SeekerGym):
// - Cross-session memory: index of all past reports, queryable + auto-surfaced
// - Completeness audit: dedicated phase that detects gaps, can spawn fill-ins
// - Adaptive supervision: orchestrator dynamically spawns more specialists
// - Multi-query reformulation: 3 query variants per decision-critical claim
// - Multi-model critique: red-team uses different model family (gpt-5.4)
// - Confidence escalation: 🟠/⚡ findings auto-trigger deeper search
// - Citation-grounded synthesis: synthesizer must inline-quote evidence

import { joinSession } from "@github/copilot-sdk/extension";
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const RESEARCH_DIR = join(process.cwd(), "research-output");
if (!existsSync(RESEARCH_DIR)) mkdirSync(RESEARCH_DIR, { recursive: true });

const MEMORY_INDEX_PATH = join(RESEARCH_DIR, "_memory-index.md");

// Default critic model — different family from the orchestrator (Claude).
// Gives variance reduction on critique. Can be overridden per-call.
const CRITIC_MODEL = "gpt-5.4";

// ─── Anti-laziness depth floors ─────────────────────────────────────────
//
// Per-specialist minimums. If a specialist returns a note below these
// floors, the orchestrator auto-respawns it with "INSUFFICIENT — keep
// digging" until it complies. Cost is intentionally high — that's the
// point of the enterprise tier.

const DEPTH_FLOORS = {
  quick:    { words: 800,  urls: 8,  quotes: 4,  adversarial_pairs: 2 },
  standard: { words: 1800, urls: 18, quotes: 10, adversarial_pairs: 4 },
  deep:     { words: 3000, urls: 30, quotes: 18, adversarial_pairs: 6 },
};

// Per-platform floors for the social_pulse specialist (in addition to
// the depth floor). Each row = "you MUST surface at least N items from
// this platform spanning M distinct sources/threads/subs".
const SOCIAL_PLATFORM_FLOORS = {
  quick:    { reddit_threads: 3, reddit_subs: 2, hn_threads: 3, hn_stories: 2, x_threads: 2, blog_posts: 2 },
  standard: { reddit_threads: 6, reddit_subs: 3, hn_threads: 5, hn_stories: 3, x_threads: 4, blog_posts: 4 },
  deep:     { reddit_threads: 10, reddit_subs: 4, hn_threads: 8, hn_stories: 4, x_threads: 6, blog_posts: 6 },
};

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

// Count distinct URLs in a markdown blob. Catches both [text](url) and
// bare http(s)://… URLs. Used by the depth-floor checker.
function countDistinctUrls(md) {
  const urls = new Set();
  const reMd = /\]\((https?:\/\/[^\s)]+)\)/g;
  const reBare = /(?<![("\w])(https?:\/\/[^\s)<>"\]]+)/g;
  let m;
  while ((m = reMd.exec(md)) !== null) urls.add(m[1].split("#")[0]);
  while ((m = reBare.exec(md)) !== null) urls.add(m[1].split("#")[0]);
  return urls.size;
}

// Count inline verbatim quotes — block quotes (> "...") or inline ".." -- attribution.
function countInlineQuotes(md) {
  // Block quote with quoted span on the same line:  > "..."   or  > "..."
  const reBlockQuote = /^\s*>\s*[""].+?[""]/gm;
  // Or any " ... " ≥ 30 chars followed within 80 chars by a markdown link
  const reInlineCited = /[""][^""\n]{30,}?[""]\s*[—–\-]\s*\[[^\]]+\]\(https?:\/\//g;
  return (md.match(reBlockQuote) || []).length + (md.match(reInlineCited) || []).length;
}

function wordCount(md) {
  return (md.match(/\b\w[\w'\-]*\b/g) || []).length;
}

// Programmatic depth-floor check on a single specialist's notes file.
// Returns { area, path, words, urls, quotes, missing: [...], passed: bool }.
function checkDepthFloors(area, notesPath, depth) {
  const f = DEPTH_FLOORS[depth] || DEPTH_FLOORS.standard;
  let content = "";
  try { content = readFileSync(notesPath, "utf8"); } catch {
    return { area, path: notesPath, exists: false, passed: false, missing: ["file_missing"] };
  }
  const w = wordCount(content);
  const u = countDistinctUrls(content);
  const q = countInlineQuotes(content);
  const missing = [];
  if (w < f.words)  missing.push(`words(${w}/${f.words})`);
  if (u < f.urls)   missing.push(`urls(${u}/${f.urls})`);
  if (q < f.quotes) missing.push(`quotes(${q}/${f.quotes})`);
  return {
    area, path: notesPath, exists: true,
    words: w, urls: u, quotes: q,
    floors: f,
    missing,
    passed: missing.length === 0,
  };
}

let researchInFlight = false;

// ─── Memory layer ───────────────────────────────────────────────────────
//
// Auto-built index of all past reports under research-output/. Surfaced to
// the planner on session start; queryable via the `recall_prior_research`
// tool. Inspired by MIA (arXiv 2604.04503): trajectory memory + planner
// consultation.

function listPastReports() {
  try {
    return readdirSync(RESEARCH_DIR)
      .filter((f) => f.endsWith("-report.md"))
      .map((f) => {
        const p = join(RESEARCH_DIR, f);
        const s = statSync(p);
        return { name: f, path: p, mtime: s.mtime, size: s.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function extractTldr(content, maxLen = 600) {
  // Pull "## TL;DR" through next heading, or first 600 chars of the first
  // section, whichever is more useful.
  const tldrMatch = content.match(/##\s+TL;DR[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (tldrMatch) return tldrMatch[1].trim().slice(0, maxLen);
  const summaryMatch = content.match(/##\s+Executive Summary[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (summaryMatch) return summaryMatch[1].trim().slice(0, maxLen);
  return content.slice(0, maxLen);
}

function extractTitle(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

// Tokens we never want as topic signal: English stopwords + boilerplate
// terms that show up in every report ("research", "claim", "evidence", …).
const STOP = new Set((
  "a an and are as at be been being but by can cant could did do does doing " +
  "done dont down during each few for from further had has have having he her " +
  "here hers herself him himself his how i if in into is it its itself just me " +
  "more most my myself no nor not now of off on once only or other our ours " +
  "ourselves out over own same she should so some such than that the their " +
  "theirs them themselves then there these they this those through to too " +
  "under until up very was way we were what when where which while who whom " +
  "why will with would you your yours yourself yourselves " +
  // research-report boilerplate (would dominate IDF otherwise)
  "research report section claim evidence source sources cite cited citation " +
  "citations confidence verified likely speculative contested tldr summary " +
  "executive overview analysis findings conclusion conclusions key questions " +
  "method methodology approach data table tables figure figures appendix " +
  "introduction background context note notes ref refs reference references " +
  "url urls link links page pages chart charts graph graphs"
).split(/\s+/));

function tokenizeForTopics(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !STOP.has(t) && !/^\d+$/.test(t));
}

// Build the TF-IDF corpus over all reports once. Returns:
//   { docs: Map<path, {title, mtime, size, tf: Map<tok,count>, len, content}>,
//     df: Map<tok, docFreq>, N: docCount }
function buildCorpus() {
  const reports = listPastReports();
  const docs = new Map();
  const df = new Map();
  for (const r of reports) {
    try {
      const content = readFileSync(r.path, "utf8");
      const title = extractTitle(content, r.name);
      const toks = tokenizeForTopics(content);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      docs.set(r.path, { path: r.path, title, mtime: r.mtime, size: r.size, tf, len: toks.length, content });
    } catch { /* skip */ }
  }
  return { docs, df, N: docs.size };
}

// TF-IDF score for a token in a doc. Ignores tokens that appear in
// >70% of docs (low IDF = no topic signal).
function tfidf(token, tfCount, docLen, df, N) {
  if (!docLen || !N) return 0;
  const docFreq = df.get(token) || 0;
  if (docFreq === 0) return 0;
  if (N >= 5 && docFreq / N > 0.7) return 0; // too common → noise
  const tf = tfCount / docLen;
  const idf = Math.log((N + 1) / (docFreq + 0.5)) + 1; // smoothed
  return tf * idf;
}

// Top distinctive terms in a single doc (for tagging the memory index).
function topTags(docEntry, df, N, n = 8) {
  const tags = [];
  for (const [tok, cnt] of docEntry.tf.entries()) {
    const s = tfidf(tok, cnt, docEntry.len, df, N);
    if (s > 0) tags.push({ tok, s });
  }
  return tags.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.tok);
}

function rebuildMemoryIndex() {
  const corpus = buildCorpus();
  const reports = [...corpus.docs.values()].sort((a, b) => b.mtime - a.mtime);
  const lines = [
    "# Research Memory Index",
    `*Auto-generated. ${reports.length} report(s) on file. Last refreshed: ${new Date().toISOString().slice(0, 19)}Z.*`,
    "",
    "This index is consulted by the planner before every new research run.",
    "If a topic overlaps with prior work, the planner builds on it instead of",
    "duplicating effort. Use the `recall_prior_research` tool to query —",
    "scoring is TF-IDF with a relevance threshold, so unrelated topics return",
    "no matches rather than spurious ones.",
    "",
    "---",
    "",
  ];
  for (const r of reports) {
    const tags = topTags(r, corpus.df, corpus.N);
    let tldr = "";
    try { tldr = extractTldr(r.content); } catch { /* ignore */ }
    lines.push(`## ${r.title}`);
    lines.push(`**File**: \`${r.path}\``);
    lines.push(`**Updated**: ${r.mtime.toISOString().slice(0, 10)} | **Size**: ${(r.size / 1024).toFixed(1)}KB`);
    lines.push(`**Tags**: ${tags.length ? tags.join(", ") : "_(none extracted)_"}`);
    lines.push("");
    lines.push(tldr);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  try { writeFileSync(MEMORY_INDEX_PATH, lines.join("\n")); } catch { /* ignore */ }
  return reports.length;
}

// Slim session-start digest: NO per-report titles (they pollute context for
// unrelated topics). Just total count + the most distinctive cross-corpus
// tags so the orchestrator knows roughly which clusters exist on file.
function memoryDigestForContext() {
  const corpus = buildCorpus();
  if (corpus.N === 0) return null;
  // Aggregate tag frequency across reports → cluster overview.
  const tagFreq = new Map();
  for (const doc of corpus.docs.values()) {
    for (const t of topTags(doc, corpus.df, corpus.N, 10)) {
      tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
    }
  }
  const clusters = [...tagFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t, n]) => `${t}(${n})`)
    .join(", ");
  return `**Memory**: ${corpus.N} prior report(s) on file. Topic clusters present: ${clusters || "_(none extracted)_"}.\n` +
    `Use \`recall_prior_research\` to query — TF-IDF scored, returns *no_matches* if your topic is unrelated to anything prior.\n` +
    `Index file: \`${MEMORY_INDEX_PATH}\`.`;
}

// TF-IDF + length-normalized search with a minimum relevance threshold so
// unrelated topics return zero matches instead of weak spurious ones.
// Title tokens are weighted 5x.
function searchMemory(query, max = 5, opts = {}) {
  const minScore = opts.minScore != null ? opts.minScore : 0.015;
  const queryToks = tokenizeForTopics(query);
  if (!queryToks.length) return [];
  const corpus = buildCorpus();
  if (corpus.N === 0) return [];
  const scored = [];
  for (const doc of corpus.docs.values()) {
    const titleToks = new Set(tokenizeForTopics(doc.title));
    let score = 0;
    const hits = [];
    for (const qt of queryToks) {
      const tfCount = doc.tf.get(qt) || 0;
      if (tfCount === 0) continue;
      let s = tfidf(qt, tfCount, doc.len, corpus.df, corpus.N);
      if (titleToks.has(qt)) s *= 5; // title match is a strong topic signal
      if (s > 0) { score += s; hits.push(qt); }
    }
    if (score >= minScore && hits.length > 0) {
      let tldr = "";
      try { tldr = extractTldr(doc.content, 400); } catch {}
      scored.push({
        path: doc.path,
        title: doc.title,
        score: Number(score.toFixed(4)),
        hits,
        tags: topTags(doc, corpus.df, corpus.N, 6),
        tldr,
        mtime: doc.mtime,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}

// ─── Specialist scope library ───────────────────────────────────────────
//
// Each focus area has a name + a per-specialist prompt. The orchestrator
// composes a wrapper around these for parallel `task` dispatch.

const SPECIALISTS = {
  web_trends: {
    title: "Web Trends & Practitioner Sentiment",
    brief: (topic) => `Map what practitioners, pundits and critics are saying about "${topic}" across the open web.

Search surfaces (use AT LEAST 4):
- Tavily / Brave web search with adversarial query pairs
- Firecrawl for JS-heavy publisher pages (TechCrunch, The Information, etc.)
- Google site filters: site:techcrunch.com, site:theverge.com, site:arstechnica.com,
  site:theinformation.com, site:stratechery.com, site:platformer.news,
  site:substack.com, site:medium.com, site:dev.to
- Long-form practitioner blogs (search '"why we ${topic}" OR "we evaluated ${topic}"')

Adversarial pairs (run BOTH sides of EACH):
- "${topic} adoption 2025 2026" ↔ "${topic} overhyped" / "why I stopped using ${topic}"
- "${topic} best practices" ↔ "${topic} problems" / "${topic} migration away from"
- "${topic} success stories" ↔ "${topic} postmortem" / "${topic} regret"
- "${topic} compared to" ↔ "${topic} alternative replaced"

Deliver:
- What's gaining traction and WHY (adoption metrics > buzz)
- Key voices AND their notable critics (named, with links)
- Community pain points (often the best opportunities)
- Prior "emerging patterns" in this space that fizzled — what happened?
- Signal vs. noise verdict: real adoption data or just media coverage?`,
  },
  academic_papers: {
    title: "Academic Papers & Citation Graph",
    brief: (topic, depth) => `Find ${depth === "deep" ? "15-25" : depth === "standard" ? "8-12" : "5-7"} relevant papers on "${topic}".

Search surfaces (use ALL that apply):
- arXiv MCP: search title+abstract
- Semantic Scholar MCP: citation graph traversal (citedBy + references)
- Google Scholar via Tavily: \`site:scholar.google.com "${topic}"\` and the
  same with quotes around key sub-terms
- connectedpapers.com — visual citation neighbourhoods
- paperswithcode.com — code-backed papers with reproducible benchmarks
- OpenReview (NeurIPS/ICLR/ICML) for peer-review discussion
- Google Scholar advanced operators: \`"${topic}" inurl:pdf since:2024\`

Strategy:
1. Direct topic search (3 query rephrasings — different jargon levels)
2. Survey/review papers (field consensus)
3. Negative-result, replication, and "limitations of ${topic}" papers
4. Citation-graph traversal: for the top 2 most-cited papers, find papers
   that cite them critically (look in the "Related Work" / "Limitations" / "vs"
   sections of the citers, not just admiring mentions)
5. Track author overlap — beware of single-lab echo chambers

Per paper: title, authors, venue, date, arXiv/DOI link, citation count
(Semantic Scholar), key findings (specific numbers when present),
methodology, known limitations or critiques, who has built on it.

Tag confidence on the field's consensus: ✅/🔵/🟠/⚡.`,
  },
  market_analysis: {
    title: "Market Analysis & Sizing",
    brief: (topic) => `Quantify the market for "${topic}".

Search surfaces:
- Tavily / Brave web search
- Site filters: site:gartner.com, site:forrester.com, site:idc.com,
  site:cbinsights.com, site:pitchbook.com, site:crunchbase.com,
  site:reuters.com, site:bloomberg.com, site:ft.com, site:wsj.com,
  site:sec.gov (10-K and S-1 filings), site:investor.<company>.com
- Macrotrends / Statista for time-series
- Industry trade press for the relevant vertical

Adversarial pairs:
- "${topic} market size" ↔ "${topic} forecast accuracy" / "${topic} bubble"
- "${topic} TAM" ↔ "${topic} reality vs hype"
- "${topic} growth" ↔ "${topic} slowdown" / "${topic} layoffs"

Deliver:
- Market size from 2+ INDEPENDENT analyst sources (note methodology differences)
- If sources disagree by >2× → explain why, don't average
- Ground numbers in primary sources where possible (10-Ks, S-1s, earnings calls)
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

Search sequence (each must produce findings):
1. Direct competitors (named tools/products) — search the segment, then
   cross-check against G2, Capterra, Gartner Peer Insights, Product Hunt
2. "alternative to <each major player>" — surfaces non-obvious ones
3. "<competitor> review" + "<competitor> complaints" + "<competitor> sucks" —
   real user experience; check Reddit, Trustpilot, G2 reviews
4. "<competitor> shutdown OR pivot OR layoffs OR acquisition" — failures
5. "<competitor> vs <competitor>" — practitioner head-to-heads
6. Indie / OSS alternatives via GitHub topic search and AlternativeTo.net

Per competitor: what they do, pricing, traction (hard metrics > claims —
revenue, paying customers, GitHub stars + issue velocity, hiring rate from
LinkedIn/job boards), what users praise, what users complain about, what
they got wrong, recent strategic shifts.

Build a comparison matrix (table). Weaknesses must be as visible as strengths.`,
  },
  tech_landscape: {
    title: "Technology Landscape & Maturity",
    brief: (topic) => `Map the tech ecosystem around "${topic}".

Maturity test: per technology, search for production case studies (mature)
vs. only launch announcements/demos (early). Note the difference. A talk
at a vendor conf is NOT a production case study.

Search surfaces:
- GitHub topic search + GitHub trending
- thenewstack.io, infoq.com, highscalability.com — engineering case studies
- Each vendor's "customers" page (treat as claims) cross-referenced with
  independent confirmations
- Site filters: site:engineering.<bigco>.com (Netflix, Uber, Airbnb,
  Stripe, Shopify, Pinterest, LinkedIn, Spotify, etc.)
- Conference talk archives: QCon, KubeCon, Strange Loop, Velocity

Deliver:
- Established vs. emerging tools, with maturity evidence per tool
- Architecture patterns from PRACTITIONERS (not just docs)
- Integration pain points (search complaints / workarounds on Reddit + HN)
- Developer experience: learning curve, docs, community health (issue
  response time, PR throughput, discussion activity)
- Graveyard: tools/frameworks abandoned and why (link to postmortems)`,
  },
  developer_sentiment: {
    title: "Developer Community Sentiment",
    brief: (topic) => `Analyze developer sentiment for "${topic}" across the developer-facing surfaces.

Search surfaces (all required for depth=deep, ≥3 for standard):
- GitHub: stars over time (use the trend_quantifier tool — don't eyeball),
  open vs closed issue ratio, time-to-close, PR throughput, contributor
  bus factor (read CONTRIBUTORS), recent issues mentioning regressions
- HackerNews via Algolia API:
    \`curl 'https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&hitsPerPage=30'\`
    Then for promising story IDs:
    \`curl 'https://hn.algolia.com/api/v1/items/<story_id>'\` to get the
    full discussion. Read the TOP comments, not just the headlines.
- Reddit: search r/programming, r/ExperiencedDevs, r/cscareerquestions,
  r/webdev, r/MachineLearning, r/devops, r/sre, plus topic-specific subs.
    \`curl -H 'User-Agent: research-bot/1.0' 'https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&limit=25&sort=relevance&t=year'\`
    Read the comments, not just titles. Sort by 'top' for substantive ones.
- Stack Overflow tag trends + new questions vs answer rate
- Lobsters (lobste.rs) — practitioner-only counterweight to HN
- Dev.to + Hashnode for first-person dev experience
- YouTube tech channels (Fireship, ThePrimeagen, etc.) for sentiment shifts
- Job postings: ask the trend_quantifier tool to count keyword occurrences
  in LinkedIn / WeWorkRemotely / hnhiring (Whoishiring threads aggregated)

Reality checks (apply rigorously):
- GitHub stars ≠ adoption. Check issue activity, commit frequency, bus factor.
- Growing SO questions = growing adoption OR growing confusion — distinguish.
- Blog posts ≠ usage; vendor conference talks ≠ usage.
- A loud minority on Twitter ≠ majority sentiment.

Search separately: enthusiasts, critics, daily practitioners. Quote
representative comments verbatim. Note which subreddit / HN story / X
thread each quote came from. How has sentiment shifted vs. 6-12 months ago?`,
  },
  funding_activity: {
    title: "Funding & Investment Activity",
    brief: (topic) => `Investment activity in "${topic}".

Search surfaces:
- **The funding_pulse tool** — call it FIRST with subject="${topic}" and
  window_days=90 to get a fresh, cross-referenced list of recent rounds
  pulled from SEC EDGAR Form D (primary source), Crunchbase News RSS,
  TechCrunch venture RSS, HN Algolia, and layoffs.fyi. Use the resulting
  funding-pulse report as your structured input — then layer historical
  context, investor theses, and post-mortems on top of it.
- Crunchbase (free tier), CB Insights free reports, PitchBook free briefs
- TechCrunch funding rounds, The Information, Axios Pro Rata, Dealroom
- SEC EDGAR for any S-1 / 10-K / 8-K filings (use the EDGAR full-text
  search at https://efts.sec.gov/LATEST/search-index)
- Investor blogs: a16z, Sequoia, Bessemer, Index, Accel, ICONIQ — read
  their thesis posts on this space if any
- LinkedIn for hiring velocity (often a sharper funding signal than
  announced rounds — search "<company> hiring" + headcount changes)
- layoffs.fyi (https://layoffs.fyi/) — sector layoffs as a downside signal
- levels.fyi for compensation data (cuts indicate stress)

Signal check: one large round ≠ market validation. Look for BREADTH — how
many independent firms are investing across multiple companies?

Deliver:
- Recent rounds (12mo) with amounts, leads, co-investors (table)
- Investor theses and their track record in this space
- Acqui-hires (talent grab) vs. strategic acquisitions
- Companies that raised big and collapsed — what went wrong?
- Down rounds, layoffs, valuation cuts in this space (search:
  "<segment> layoffs", layoffs.fyi, levels.fyi compensation cuts)
- Cross-cycle context: how does this period compare to 12 / 24 months ago?`,
  },
  social_pulse: {
    title: "Social Listening: Reddit / HackerNews / X / Forums",
    brief: (topic, depth) => {
      const f = SOCIAL_PLATFORM_FLOORS[depth] || SOCIAL_PLATFORM_FLOORS.standard;
      return `Mine the social-and-forum substrate for what real people are saying about "${topic}".
This is where unfiltered sentiment, war stories, and pain points live —
the stuff that polished blog posts and analyst reports miss.

You MUST surface concrete quotes from:
- ≥${f.reddit_threads} Reddit threads spanning ≥${f.reddit_subs} different subreddits
- ≥${f.hn_threads} HackerNews comments spanning ≥${f.hn_stories} different stories
- ≥${f.x_threads} X/Twitter posts or threads (use Tavily site:x.com / site:twitter.com /
  site:nitter.net; or web-search "<topic> twitter thread")
- ≥${f.blog_posts} long-form practitioner blog posts (Substack, dev.to, Hashnode,
  personal blogs surfaced via "${topic} blog" or HN "Show HN" / "Ask HN")

EXACT URL templates to use (curl them; record the URL you fetched):

Reddit search (no key needed; use a real User-Agent):
  curl -H 'User-Agent: research-bot/1.0' \\
    'https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&limit=25&sort=relevance&t=year'
Then for each promising thread:
  curl -H 'User-Agent: research-bot/1.0' 'https://www.reddit.com<permalink>.json?limit=200'
Subreddit-targeted: append \`&restrict_sr=1\` to a subreddit-scoped URL like
  https://www.reddit.com/r/MachineLearning/search.json?q=...&restrict_sr=1

HackerNews (Algolia):
  curl 'https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&hitsPerPage=30&tags=story'
  curl 'https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&hitsPerPage=50&tags=comment'
Then dive into specific stories:
  curl 'https://hn.algolia.com/api/v1/items/<objectID>'   # full nested thread

X/Twitter (no free API): use Tavily/Brave with these queries —
  "${topic}" site:x.com
  "${topic}" site:twitter.com
  "${topic}" site:nitter.net
  "${topic} thread" site:threadreaderapp.com
Look for technical practitioners (verified accounts, named individuals).

Forums to also check:
- Lobsters: \`https://lobste.rs/search?q=${encodeURIComponent(topic)}\`
- Lemmy (programming.dev): web search "${topic} site:programming.dev"
- Discourse instances for the relevant ecosystem (e.g. discuss.python.org,
  forum.rust-lang.org) — use site: filters

Adversarial discipline:
- Read the TOP-VOTED comments AND the TOP-CONTRARIAN comments per thread
- Quote BOTH sides verbatim
- Note demographic skew of each platform (HN = startup/infra-heavy,
  r/cscareerquestions = early-career, r/ExperiencedDevs = senior, etc.)
- A single viral post is not a trend — show breadth across N independent threads

Deliver:
- A list of representative VERBATIM quotes (≥2 sentences each), each with
  the URL and platform/sub
- Tally: how many positive vs negative vs neutral mentions across the corpus
- Recurring complaints (frequency-ranked)
- Recurring praise (frequency-ranked)
- Emerging memes / shorthand the community uses for this topic
- Single-source claims to NOT trust; corroborated claims to flag as 🔵+`;
    },
  },
};

const ALL_AREAS = Object.keys(SPECIALISTS);

// ─── Tasks (focus-area prompt blocks) ───────────────────────────────────

function buildSpecialistDispatch(topic, areas, depth, paths) {
  const f = DEPTH_FLOORS[depth] || DEPTH_FLOORS.standard;
  const lines = areas.map((area) => {
    const spec = SPECIALISTS[area];
    if (!spec) return null;
    const notesPath = join(paths.notesDir, `${area}.md`);
    return `
**Specialist: ${spec.title}** → write findings to \`${notesPath}\`
\`\`\`
${spec.brief(topic, depth)}

═══════════════════════════════════════════════════════════════════
DEPTH CONTRACT (enterprise tier — cost is no object, depth IS the goal)
═══════════════════════════════════════════════════════════════════
You are NOT done until ALL of the following floors are met for ${depth}:

  ▸ Word count of your notes file:           ≥ ${f.words} words
  ▸ Distinct URLs you actually OPENED:        ≥ ${f.urls}
  ▸ Inline verbatim quotes (≥1 sentence):    ≥ ${f.quotes}
  ▸ Adversarial query pairs run end-to-end:  ≥ ${f.adversarial_pairs}

These are FLOORS, not targets. If your work is below any floor when you
start writing the summary, GO BACK and dig further. The orchestrator will
PROGRAMMATICALLY check these floors and respawn you with "INSUFFICIENT"
if any are missed — saving you from a wasted respawn is just doing it
right the first time.

Multi-query reformulation (CoSearch-inspired, mandatory):
- For each of your most decision-critical claims, issue at least 3 query
  REPHRASINGS (different angles, synonyms, jargon vs plain language,
  practitioner vs vendor framing).
- Dedupe URLs across rephrasings; read the union, not the intersection.
- Note in your notes: "Top claim X verified against N independent results."

Anti-laziness rules (these are the most common failure modes):
1. SEARCHING ≠ READING. A URL in your bibliography that you didn't actually
   open is dishonest. Open every URL you cite (use Firecrawl or curl/view
   for static pages).
2. PARAPHRASE + CITE is INSUFFICIENT. Inline-quote the supporting passage
   verbatim (≤2 sentences), then cite. Hallucinations hide in paraphrase.
3. ONE SOURCE IS NOT EVIDENCE. Any decision-relevant claim needs ≥2
   independent sources (independent = not citing the same original).
4. NO VENDOR-ONLY EVIDENCE. A vendor blog claiming X is a CLAIM, not
   evidence. Find the independent corroboration or downgrade the tag.
5. NO STOPPING ON FIRST AGREEMENT. After you find supporting evidence,
   you MUST run the falsification query and report what you find — even
   if it weakens your conclusion. Especially if it weakens your conclusion.
6. NO PADDING. Floors are about substance, not word inflation. If you can't
   hit the floor with substance, that itself is a finding — say so
   explicitly and explain why the topic is under-researched.

Self-audit (write this checklist VERBATIM at the END of your notes file,
filled in honestly):

\`\`\`
## Self-Audit
- Word count: ___ / floor ${f.words}                    [PASS / FAIL]
- Distinct URLs opened: ___ / floor ${f.urls}            [PASS / FAIL]
- Inline verbatim quotes: ___ / floor ${f.quotes}        [PASS / FAIL]
- Adversarial pairs run: ___ / floor ${f.adversarial_pairs} (list them below)
   1. <pair>
   2. <pair>
   ...
- URLs I actually opened (not just searched), spot-check list of 5+:
   1. <url>
   ...
- Single-source claims I'm flagging 🟠/⚡ for honesty: <count>
- Counter-evidence I found that weakens the headline finding:
   <list, or "none after genuine search">
- Coverage gaps the orchestrator should know about:
   <list>
\`\`\`

Output contract:
- Write full findings (markdown) to: ${notesPath}
- Use confidence tags (✅/🔵/🟠/⚡/❓) on conclusions and numbers
- Cite sources as [Title, Date](URL); tier them (Primary / Independent / Vendor)
- For each major claim, INLINE-QUOTE the supporting passage (≤2 sentences) — paraphrase + cite is not enough
- End with: "What I'm least sure about" + "What would change this conclusion" + "Coverage gaps I noticed" + the Self-Audit block above
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
    // ─── 0. recall_prior_research ────────────────────────────────────
    {
      name: "recall_prior_research",
      description: "Search the cross-session memory of past research reports. Returns ranked excerpts from prior reports that overlap with a query. Inspired by MIA (arXiv 2604.04503) — every research run should consult memory before planning to avoid redundant work and to build on prior findings.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or question to search past reports for" },
          max_results: { type: "number", description: "Max reports to return (default 5)" },
          full_content: { type: "boolean", description: "If true, return full file contents of top match (default false — returns excerpts only)" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const max = args.max_results || 5;
        const results = searchMemory(args.query, max);
        if (results.length === 0) {
          return JSON.stringify({ status: "no_matches", query: args.query, suggestion: "No prior research overlaps with this query — proceed with a fresh plan." });
        }
        const out = {
          status: "matches_found",
          query: args.query,
          count: results.length,
          memory_index: MEMORY_INDEX_PATH,
          matches: results.map((r) => ({
            title: r.title,
            path: r.path,
            updated: r.mtime.toISOString().slice(0, 10),
            relevance_hits: r.hits,
            tags: r.tags,
            score: r.score,
            tldr: r.tldr,
          })),
        };
        if (args.full_content && results[0]) {
          try { out.top_match_full_content = readFileSync(results[0].path, "utf8"); } catch {}
        }
        return JSON.stringify(out, null, 2);
      },
    },

    // ─── 0b. enforce_depth_floors ────────────────────────────────────
    {
      name: "enforce_depth_floors",
      description: "Programmatically check whether a specialist's notes file meets the enterprise depth floors (word count, distinct URLs opened, inline verbatim quotes). Returns a per-area pass/fail report. Use this in Phase 2.4 (after specialists return) to identify which need to be respawned with 'INSUFFICIENT — keep digging'. Cost is no object; depth is the goal.",
      parameters: {
        type: "object",
        properties: {
          notes_dir: { type: "string", description: "Path to the specialists' notes directory (must be inside research-output/)" },
          depth: { type: "string", enum: ["quick", "standard", "deep"], description: "The depth tier the run was launched at — determines floors" },
          areas: { type: "array", items: { type: "string", enum: ALL_AREAS }, description: "Which specialist areas to check" },
        },
        required: ["notes_dir", "depth", "areas"],
      },
      handler: async (args) => {
        const dir = safeResolveReport(args.notes_dir);
        if (!dir) return JSON.stringify({ error: "notes_dir not found inside research-output/" });
        const depth = args.depth || "standard";
        const reports = args.areas.map((area) => {
          const notesPath = join(dir, `${area}.md`);
          return checkDepthFloors(area, notesPath, depth);
        });
        const failing = reports.filter((r) => !r.passed);
        return JSON.stringify({
          status: failing.length === 0 ? "all_floors_met" : "respawn_needed",
          depth,
          floors: DEPTH_FLOORS[depth] || DEPTH_FLOORS.standard,
          per_specialist: reports,
          respawn_areas: failing.map((r) => r.area),
          respawn_directive: failing.length === 0 ? null :
            `INSUFFICIENT depth on these specialists: ${failing.map((r) => `${r.area} (missing: ${r.missing.join(", ")})`).join("; ")}. ` +
            `Respawn EACH failing specialist as a NEW task subagent with this prefix to its brief: ` +
            `"⚠️ INSUFFICIENT — your previous notes file at <path> was below the depth floor. Specifically: <missing>. ` +
            `Open the existing file, READ what you already have, and CONTINUE researching to reach the floor. ` +
            `APPEND new findings; do not delete existing material. Then update the Self-Audit block honestly."`,
        }, null, 2);
      },
    },

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
        const areas = args.focus_areas?.length ? args.focus_areas : ["web_trends", "academic_papers", "market_analysis", "developer_sentiment", "social_pulse"];
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
          next_steps: [
            `→ recommended: Execute the plan with run_deep_research({ topic, continue_from_plan: "${paths.plan}", depth: "${depth}" }) — spawns the parallel specialists.`,
            `Tighten first: open ${paths.plan} and edit the question list, then re-run plan_research if the decomposition feels off.`,
            `Lock the rubric before specialists run: pre_register_research({ topic, dimensions, falsifiability, exclusion_criteria }) — kills motivated reasoning.`,
          ],
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
        const areas = args.focus_areas?.length ? args.focus_areas : ["web_trends", "academic_papers", "market_analysis", "developer_sentiment", "social_pulse"];
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

## PHASE 0 — MEMORY RECALL (NEW)

Before planning, call \`recall_prior_research\` with the topic. Review any
matches:
- If a prior report fully covers the topic → tell the user, ask if they want
  a refresh or a new angle. Do not duplicate work.
- If a prior report is adjacent → cite it as input to the planner; the new
  plan should build on it, not repeat it.
- If no matches → proceed with a fresh plan and note "no prior research".

---

## PHASE 1 — PLAN
${args.continue_from_plan ? `Plan already exists at \`${paths.plan}\` — read it and proceed to Phase 2.` :
`Use the \`plan_research\` tool, OR draft the plan inline and save it to \`${paths.plan}\`.
The plan must list specialist assignments, adversarial pairs, and code-validation candidates.
**Reference any prior reports surfaced in Phase 0** in the plan's "Prior context" section.`}

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
(falsification, confidence tags, source tiers, multi-query reformulation,
inline-quote evidence).

${dispatch}

After spawning, end your turn. You will be notified as each completes;
collect their summaries and notes paths.

---

## PHASE 2.4 — DEPTH-FLOOR ENFORCEMENT (anti-laziness gate)

Once ALL specialists report in, **before** the completeness audit, run the
programmatic depth-floor check:

\`\`\`
enforce_depth_floors:
  notes_dir: "${paths.notesDir}"
  depth: "${depth}"
  areas: ${JSON.stringify(areas)}
\`\`\`

Read the response:

- **status: all_floors_met** → proceed to Phase 2.5.
- **status: respawn_needed** → for EACH area in \`respawn_areas\`, RESPAWN that
  specialist as a NEW \`task\` subagent (parallel, single response, same as
  Phase 2). Use the EXACT respawn_directive prefix returned by the tool
  (it tells the agent specifically what's missing and to APPEND, not replace).
  When respawned specialists return, run \`enforce_depth_floors\` AGAIN. Loop
  until all_floors_met.

Hard rule: you may NOT proceed to Phase 2.5 until \`enforce_depth_floors\`
returns \`status: all_floors_met\`. This is the enterprise tier — cost is
no object, depth is the goal. Stopping a specialist below floor is the
single most common failure mode of "deep research" agents; this gate exists
specifically to prevent it.

If a specialist fails the floor 3 times in a row on the same area, log the
failure mode in the report's "Methodology Notes" and proceed — but tag every
finding from that area as 🟠 Speculative regardless of its in-text tag.

---

## PHASE 2.5 — COMPLETENESS AUDIT (NEW — adaptive supervision)

Once ALL specialists report in, call \`completeness_audit\`:
\`\`\`
notes_dir: "${paths.notesDir}"
topic: "${topic}"
focus_areas: ${JSON.stringify(areas)}
\`\`\`

Read the audit verdict:
- 🟢 → proceed to Phase 3 (synthesis)
- 🟡 → spawn the recommended fill-in specialists (in parallel, same way as
  Phase 2). Each writes to \`${paths.notesDir}/fillin-<slug>.md\`. Then
  proceed to Phase 3, including the fill-in notes.
- 🔴 → re-plan and rerun primary research. Don't synthesize on a broken base.

This is the "adaptive supervisor" pattern (HiRAS-inspired): the supervisor
(you) decides specialist scope dynamically, not just upfront.

---

## PHASE 3 — CITATION-GROUNDED SYNTHESIS

When coverage is sufficient:
1. Read each notes file (use \`view\` with view_range, not giant reads)
2. Identify cross-cutting themes — don't just concatenate sections
3. Resolve contradictions or surface them as ⚡ Contested
4. Draft the report to \`${paths.report}\` using the schema below

**Citation discipline (mandatory)**: every decision-relevant claim must
include either an inline-quoted passage from a source OR a \`[code-verified]\`
artifact link. Paraphrase + bare citation is INSUFFICIENT — that's where
hallucinations hide. Format:
> "<exact quote, ≤2 sentences>" — [Source Title, Date](URL) — Tier: Primary/Independent/Vendor

${codeVal ? `## PHASE 3.5 — CODE VALIDATION

For each quantitative claim flagged in the plan as a validation candidate,
invoke \`validate_with_code\`. Save artifacts to \`${paths.artifacts}/\`.
Annotate validated claims with \`[code-verified](./<artifact>.md)\`.` : ""}

---

## PHASE 4 — MULTI-MODEL RED-TEAM CRITIQUE

Call \`red_team_critique\` with \`target_path: "${paths.report}"\`. The tool
spawns a rubber-duck agent on a **different model family** (default: ${CRITIC_MODEL})
for variance reduction — the critic catches what the orchestrator's model would miss.

Save the critique to \`${paths.critique}\`.

## PHASE 5 — REVISE + CONFIDENCE-BASED ESCALATION (NEW)

1. Address every "Top 3 Priority" critique finding.
2. **Confidence escalation**: scan the draft for any 🟠 Speculative or
   ⚡ Contested tag attached to a *decision-relevant* claim (anything in
   TL;DR, Executive Summary, or Opportunities). For each:
   - Spawn ONE focused specialist (\`task\`, general-purpose, background) to
     dig deeper, with brief: "find primary evidence for/against <claim>;
     return updated tag (✅/🔵/🟠/⚡) with rationale."
   - Run these in parallel.
3. After fill-in evidence comes back, revise tags and update the report.
4. If evidence is genuinely thin after the dig → keep the low confidence tag
   and explicitly say so. Don't paper over.

## PHASE 6 — CITATION VERIFICATION

Call \`citation_verifier\` on \`${paths.report}\`. It fetches each cited URL
and checks claim support, writing results to \`${paths.citations}\`.

After verification: remove unsupported claims, downgrade partial ones,
replace broken links. Overwrite \`${paths.report}\` with the final version.

## PHASE 7 — MEMORY UPDATE (NEW)

After the report is final:
1. The session-end hook auto-rebuilds \`${MEMORY_INDEX_PATH}\`.
2. Verify by reading the index and confirming this report's TL;DR is included.
3. Log: "✅ Research complete and indexed in memory."

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
          next_steps: [
            `→ recommended (when report finishes): Open ${paths.report} first — that's the synthesized answer. Then dive into ${paths.notesDir}/ for any specialist area you want depth on.`,
            `Stress-test before acting on findings: ensemble_critique({ target_path: "${paths.report}" }) — 3 critics on different model families. Run bias_audit on the same path right after.`,
            `Verify every numeric claim: citation_verifier({ report_path: "${paths.report}" }) — required before sharing externally. Flags paraphrase drift.`,
            `If this report inspired product/decision ideas: brainstorm_from_research({ report_path: "${paths.report}", validate_top_ideas: true }) — generates ranked ideas with pre-mortems.`,
          ],
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
        return JSON.stringify({ status: "paper_search_initiated", topic, output_path: out,
          next_steps: [
            `→ recommended (when paper graph is written): Open ${out} and read the "Landmark papers" + "Critical responses" sections — that's the high-signal subset.`,
            `For any paper that looks load-bearing for your decision: deep_paper_search again on its specific claim with traverse_depth: 2 — finds the rebuttals.`,
            `If the literature seems to converge too cleanly: spawn a red_team_critique on ${out} focused on "what's the missing counter-evidence school of thought?".`,
          ],
        });
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
        return JSON.stringify({ status: "trend_quantifier_initiated", subject, artifacts_dir: artifactsDir, output_path: out,
          next_steps: [
            `→ recommended (when trends are written): Open ${out} and check the slope + R² for each metric. R² < 0.5 means the "trend" is noise — don't treat it as signal.`,
            `Cross-check: if GitHub stars trend up but npm/PyPI downloads don't, the project is hype-cycle / not in production use. Trust the install metrics over the social metrics.`,
            `If the trend is real and steep: validate_with_code({ method: "trend_fit", claim: "<X is growing N% YoY>" }) for an independent recompute.`,
          ],
        });
      },
    },

    // ─── 4b. funding_pulse ───────────────────────────────────────────
    {
      name: "funding_pulse",
      description: "Pull the latest funding activity for a topic/sector from REAL-TIME public sources (no paid API needed): SEC EDGAR Form D RSS (primary source — actual filed private placements), Crunchbase News RSS, TechCrunch /venture/ RSS, HackerNews Algolia (for '<startup> raises'), and layoffs.fyi (downside signal). Cross-references rounds across sources, flags single-source claims, and writes a structured funding-pulse report. Use this for 'what funded this week/month' questions or as a fresh-data input to the funding_activity specialist.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Topic, sector, or company-name keyword to filter by (e.g. 'AI agents', 'vector database', 'climate tech')" },
          window_days: { type: "number", description: "Look-back window in days (default 30)" },
          companies: { type: "array", items: { type: "string" }, description: "Optional: specific company names to track. If provided, results are filtered to these companies in addition to subject keyword." },
          investors: { type: "array", items: { type: "string" }, description: "Optional: specific investors to track (e.g. 'a16z', 'Sequoia'). Filters by lead/co-investor mentions." },
          include_layoffs: { type: "boolean", description: "Also pull recent layoffs in this sector (downside signal). Default true." },
          output_path: { type: "string", description: "Optional output path under research-output/" },
        },
        required: ["subject"],
      },
      handler: async (args) => {
        const subject = args.subject;
        const windowDays = args.window_days || 30;
        const companies = args.companies || [];
        const investors = args.investors || [];
        const includeLayoffs = args.include_layoffs !== false;
        const id = newReportId();
        const slug = slugify(subject);
        const out = args.output_path
          ? safeResolveReport(args.output_path) || join(RESEARCH_DIR, `${id}-${slug}-funding-pulse.md`)
          : join(RESEARCH_DIR, `${id}-${slug}-funding-pulse.md`);
        const artifactsDir = join(RESEARCH_DIR, `${id}-${slug}-funding-artifacts`);
        if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true });

        await session.log(`💰 Funding pulse: "${subject}" (last ${windowDays}d)`);

        const prompt = `# Funding Pulse — "${subject}" (last ${windowDays} days)

You are a funding-data specialist. Pull the LATEST funding activity from
REAL-TIME public sources, cross-reference across surfaces, and write the
result to \`${out}\`. Use \`${artifactsDir}/\` for any raw data dumps.

═══════════════════════════════════════════════════════════════════
DATA SOURCES (use ALL — each is free and needs no API key)
═══════════════════════════════════════════════════════════════════

**1. SEC EDGAR Form D RSS — PRIMARY SOURCE (actual filed private placements)**
Form D is the legally required filing for private securities offerings
(most VC rounds). It's the closest thing to ground-truth funding data.

Latest 100 Form D filings (Atom feed):
\`\`\`
curl -A 'research-orchestrator/2.3 (contact@example.com)' \\
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=D&dateb=&owner=include&count=100&output=atom'
\`\`\`
EDGAR full-text search (note: must include a real User-Agent or SEC blocks):
\`\`\`
curl -A 'research-orchestrator/2.3 (contact@example.com)' \\
  'https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(subject)}%22&dateRange=custom&startdt=$(date -d "${windowDays} days ago" +%Y-%m-%d)&enddt=$(date +%Y-%m-%d)&forms=D'
\`\`\`
For each interesting filing, the actual Form D PDF/HTML is linked from the
filing page — open it to extract: company name, total offering amount,
amount sold to date, named investors, date of first sale.

**2. Crunchbase News RSS** (curated rounds with context)
\`\`\`
curl 'https://news.crunchbase.com/feed/'
curl 'https://news.crunchbase.com/sections/venture/feed/'
curl 'https://news.crunchbase.com/sections/ma/feed/'
\`\`\`
Filter items whose title/description mentions "${subject}"${companies.length ? ` or any of: ${companies.join(", ")}` : ""}.

**3. TechCrunch venture RSS**
\`\`\`
curl 'https://techcrunch.com/category/venture/feed/'
curl 'https://techcrunch.com/category/startups/feed/'
\`\`\`
Same keyword filter. TC is fast but vendor-PR-heavy; corroborate with EDGAR.

**4. HackerNews Algolia (search the last ${windowDays} days)**
\`\`\`
SINCE=$(($(date +%s) - ${windowDays}*86400))
curl "https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(subject + " raises OR funding OR Series")}&numericFilters=created_at_i>$SINCE&hitsPerPage=50"
\`\`\`
Read top comments — practitioners often spot inflation or undisclosed
weaknesses before press releases catch up.

**5. Other targeted surfaces** (use as needed):
- Axios Pro Rata (newsletter archive): site:axios.com pro-rata
- The Information's Briefing: site:theinformation.com
- Dealroom press releases: site:dealroom.co
- StrictlyVC: site:strictlyvc.com
- Sifted (EU rounds): site:sifted.eu
- LinkedIn round announcements: \`"${subject}" "Series" "led by" site:linkedin.com\`

${investors.length ? `**Investor-targeted (filter to these LPs/funds): ${investors.join(", ")}**
For each: \`site:<investor-domain>.com 2026\` — many post deal announcements;
also \`"${investors.join('" OR "')}" "led" "Series"\` web search.
` : ""}
${includeLayoffs ? `**6. layoffs.fyi (downside signal — required cross-check)**
\`\`\`
curl 'https://layoffs.fyi/' | grep -oE '"company":"[^"]+","location":"[^"]+","industry":"[^"]+","total_laid_off":[0-9]+,"date":"[^"]+"' | head -50
\`\`\`
Or fetch the underlying CSV/JSON if their format has changed. Filter to
companies in the "${subject}" sector. A sector that's both raising AND
shedding staff is in correction — say so.
` : ""}

═══════════════════════════════════════════════════════════════════
DEPTH CONTRACT
═══════════════════════════════════════════════════════════════════
Floor for ${windowDays}-day window:
  ▸ ≥ 8 distinct funding events surfaced (or "fewer because the sector is
    quiet — here's the evidence the search was thorough")
  ▸ ≥ 5 cross-referenced (round appears in ≥2 of the 5 sources above)
  ▸ ≥ 3 with a SEC Form D primary-source link (treat single-source rounds
    as 🟠 Speculative until corroborated)
  ▸ Layoffs cross-check completed${includeLayoffs ? "" : " (skipped per flag)"}

Anti-laziness: searching ≠ reading. For each round you list, you must have
opened either (a) the SEC filing, (b) the Crunchbase News article, or
(c) the TechCrunch piece — not just relied on a headline snippet.

═══════════════════════════════════════════════════════════════════
OUTPUT — write to \`${out}\`
═══════════════════════════════════════════════════════════════════

\`\`\`markdown
# Funding Pulse: ${subject}
*Window: last ${windowDays} days | Generated: ${new Date().toISOString().slice(0, 10)} | Pipeline: funding_pulse v2.3*

## TL;DR
- N rounds totalling $X disclosed across the window
- Largest round: <Co> — $Y led by <Investor>
- Most active investor: <Investor> (M deals)
- Sector temperature: 🔥 hot / 😐 steady / 🧊 cooling — with one-line justification

## Recent rounds (sorted by date desc)

| Date | Company | Stage | Amount | Lead | Co-investors | Source(s) | Confidence |
|---|---|---|---|---|---|---|---|

For each row: Source(s) lists the URLs you actually opened. Confidence:
✅ if SEC Form D + ≥1 press confirmation; 🔵 if 2+ independent press;
🟠 if single source.

## Investor activity heatmap
Investors ranked by # of deals in the window for this sector. For each:
named deals + thesis (link to their thesis post if any).

## Notable narratives
1-3 themes: e.g. "infra-layer rounds dominate vs application-layer",
"down-rounds clustered in <segment>". Quote verbatim from sources.

${includeLayoffs ? `## Sector-side cross-check (layoffs.fyi)
Layoffs in this sector during the window. If raise-vs-layoff ratio is
unhealthy, flag it.
` : ""}
## Single-source / unverified items
Rounds that appeared in only one source. Listed for transparency, NOT
in the headline tally.

## Coverage gaps
- Any source that returned nothing or was blocked (and why)
- Sectors / sub-segments not covered in this run

## Methodology
- Sources queried (with date)
- Total candidate rounds before dedupe / after dedupe
- Filter terms applied: "${subject}"${companies.length ? `, ${companies.join(", ")}` : ""}${investors.length ? `, investors: ${investors.join(", ")}` : ""}
\`\`\`

When done, log: "✅ Funding pulse complete: ${out}" and return a 150-word summary.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({
          status: "funding_pulse_initiated",
          subject, window_days: windowDays,
          companies, investors, include_layoffs: includeLayoffs,
          output_path: out, artifacts_dir: artifactsDir,
        });
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
        return JSON.stringify({ status: "explainer_initiated", concept, output_path: out, artifacts_dir: artifactsDir,
          next_steps: [
            `→ recommended (when explainer is written): Open ${out} and read the "Pitfalls" + "Comparison" sections first — that's where adoption decisions get made.`,
            `Run the included code in ${artifactsDir} — if it doesn't actually run, the explanation is suspect.`,
            `If you're considering adopting this concept: deep_paper_search on the same topic to surface known failure modes the explainer may have glossed over.`,
            `For decision-grade adoption: trend_quantifier on the relevant libraries to check whether the ecosystem is alive.`,
          ],
        });
      },
    },

    // ─── 6. red_team_critique ────────────────────────────────────────
    {
      name: "red_team_critique",
      description: "Spawns an adversarial reviewer (rubber-duck agent) on a different model family for variance reduction. Surfaces unsupported claims, hand-waved numbers, missing counter-evidence, biased framing, citation issues. Writes critique to disk.",
      parameters: {
        type: "object",
        properties: {
          target_path: { type: "string", description: "Path to the markdown file to critique (must be in research-output/)" },
          focus: { type: "string", description: "Optional: specific concerns to focus on (e.g., 'numbers and market-size claims')" },
          output_path: { type: "string", description: "Where to write the critique (default: <target>-critique.md)" },
          critic_model: { type: "string", description: `Override critic model (default: ${CRITIC_MODEL}). Use a different family from the orchestrator for variance reduction.` },
        },
        required: ["target_path"],
      },
      handler: async (args) => {
        const target = safeResolveReport(args.target_path);
        if (!target) return `Target not found at ${args.target_path} (must be inside research-output/).`;

        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : target.replace(/\.md$/, "-critique.md");
        const model = args.critic_model || CRITIC_MODEL;

        await session.log(`🔴 Red-team critique: ${basename(target)} (critic model: ${model})`);

        const prompt = `# Red-Team Critique

Target: \`${target}\`
Output: \`${out}\`
Critic model: **${model}** (different family from orchestrator for independent variance)
${args.focus ? `Specific focus: ${args.focus}` : ""}

Step 1: Read the target file in full.

Step 2: Spawn a \`rubber-duck\` agent with these parameters:
\`\`\`
agent_type: "rubber-duck"
mode: "sync"
model: "${model}"
\`\`\`

Brief for the rubber-duck:

> You are an adversarial reviewer. The author wants you to find every weakness
> a skeptical expert would notice. The author has explicitly invited a harsh
> review — be direct, not diplomatic. Your independence (different model family)
> is the point: surface what the author's model would miss.
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
> 9. **Evidence-quote mismatch** — does the inline quote actually support the claim?
> ${args.focus ? `10. **Special focus**: ${args.focus}` : ""}
>
> For each issue: quote the exact passage, state the problem, suggest a fix
> (more search, downgrade tag, remove claim).
>
> End with: a verdict on overall epistemic quality (🟢/🟡/🔴) and the 3
> highest-priority issues to address.

Step 3: Write the critique output to \`${out}\` in this format:

\`\`\`markdown
# Red-Team Critique: ${basename(target)}
*Reviewer: rubber-duck agent (${model}) | Date: ${new Date().toISOString().slice(0, 10)}*

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
        return JSON.stringify({ status: "critique_initiated", target_path: target, output_path: out, critic_model: model,
          next_steps: [
            `→ recommended (when critique is written): Open ${out} and triage findings by severity. For each HIGH-severity finding, downgrade the affected claim in the original report (✅ → 🟠) or remove it.`,
            `For higher signal: re-run as ensemble_critique({ target_path: "${target}" }) — 3 critics on different model families catch ~2x more issues than single critic.`,
            `After triaging: re-run citation_verifier({ report_path: "${target}" }) on any claim the critic flagged as unsupported.`,
          ],
        });
      },
    },

    // ─── 7. citation_verifier ────────────────────────────────────────
    {
      name: "citation_verifier",
      description: "Extracts every cited URL from a report, fetches each one, and checks whether the cited claim is actually supported by the source by extracting a VERBATIM supporting quote. Flags broken/paywalled/unsupported/paraphrase-drift citations. Writes a verification log with quote evidence.",
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
     - ✅ **Supported** — page clearly contains the cited claim AND you extracted a VERBATIM quote (≤40 words) that supports it
     - 🟡 **Partial** — page mentions the topic but no verbatim sentence supports the specific claim (paraphrase drift)
     - 🔴 **Unsupported** — page exists but doesn't say what was cited
     - 💀 **Broken** — 404, blocked, paywalled, or redirected
     - ⚠️ **Vendor-as-independent** — claim was tagged independent but source is vendor
     - 🔁 **Echo-chamber** — source merely repeats an upstream originator (different blog, same press release / paper). Note the originator URL.

   For ✅ items you MUST capture the verbatim supporting quote — paraphrase is not acceptable.

3. Write verification log to \`${out}\`:

\`\`\`markdown
# Citation Verification — ${basename(report)}
*Date: ${new Date().toISOString().slice(0, 10)}*

## Summary
- Total citations: N
- ✅ Supported: A | 🟡 Partial: B | 🔴 Unsupported: C | 💀 Broken: D | ⚠️ Vendor-misclassified: E | 🔁 Echo-chamber: F

## ✅ Supported (with verbatim quotes)
| URL | Claim in report | Verbatim quote from source (≤40 words) |
| --- | --- | --- |
| ... | ... | "..." |

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
        return JSON.stringify({ status: "citation_verification_initiated", report_path: report, output_path: out,
          next_steps: [
            `→ recommended (when verification log is written): Open ${out} and filter to ❌ (unsupported) and 🟡 (paraphrase drift) entries — those are the urgent fixes in ${report}.`,
            `For each ❌: either find a real source (web_search) and re-cite, or remove the claim from ${report}.`,
            `For each 🟡: replace the paraphrase with the verbatim quote the verifier extracted.`,
            `Watch for 🔁 echo-chamber tags: multiple cited sources tracing back to the same primary — treat as a single source for confidence purposes.`,
          ],
        });
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
        return JSON.stringify({ status: "code_validation_initiated", claim: args.claim, method: args.method, artifacts_dir: artDir,
          next_steps: [
            `→ recommended (when validation finishes): Open ${artDir}/writeup.md — that's the verdict (claim confirmed / refuted / inconclusive) plus the recomputed numbers.`,
            `If the claim was REFUTED: edit the source report to either remove the claim or replace it with the validated number. Add a citation to ${artDir}.`,
            `If INCONCLUSIVE: try a different validation method (recompute / trend_fit / monte_carlo / survey_ci / benchmark) on the same claim — they catch different failure modes.`,
            `Save as artifact: link to ${artDir} from any report citing this claim — full reproducibility trail.`,
          ],
        });
      },
    },

    // ─── 8.5. completeness_audit ─────────────────────────────────────
    {
      name: "completeness_audit",
      description: "Audit a directory of specialist research notes for coverage gaps, contradictions, thin areas, and overrepresented sources. Recommends which gap-fill specialists to spawn before synthesis. Inspired by SeekerGym (arXiv 2604.17143) finding that even SOTA agents miss >50% of relevant information silently.",
      parameters: {
        type: "object",
        properties: {
          notes_dir: { type: "string", description: "Path to the specialists' notes directory (must be inside research-output/)" },
          topic: { type: "string", description: "The original research topic" },
          focus_areas: { type: "array", items: { type: "string" }, description: "The specialist areas that ran" },
          output_path: { type: "string", description: "Where to write the audit report (default: <notes_dir>/_audit.md)" },
        },
        required: ["notes_dir", "topic"],
      },
      handler: async (args) => {
        const notesDir = safeResolveReport(args.notes_dir);
        if (!notesDir) return `notes_dir not found at ${args.notes_dir} (must be inside research-output/).`;
        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(notesDir, "_audit.md"))
          : join(notesDir, "_audit.md");

        await session.log(`🔍 Completeness audit on ${basename(notesDir)}`);

        const prompt = `# Completeness Audit

Topic: **${args.topic}**
Notes directory: \`${notesDir}\`
${args.focus_areas?.length ? `Focus areas covered: ${args.focus_areas.join(", ")}` : ""}
Output: \`${out}\`

## Method (do NOT spawn subagents — you do this yourself)

1. List every file in \`${notesDir}\` (use \`glob\`).
2. Read each notes file (use \`view\`).
3. Build a coverage matrix: for the topic "${args.topic}", what dimensions
   SHOULD a complete answer cover? (E.g.: market size, competitors, technical
   feasibility, regulation, real users, failure modes, alternatives, history.)
   Mark which are well-covered, partial, or missing.
4. Look for these specific failure modes:
   - **Coverage gaps**: dimensions no specialist explored
   - **Source concentration**: same 2-3 sources cited by multiple specialists
     (suggests echo chamber, not independent corroboration)
   - **Vendor-only sourcing**: a key claim only cited by self-published sources
   - **Single-side framing**: pro-X evidence collected but no falsification done
   - **Confidence inflation**: ✅ Verified tags backed by only 1 source
   - **Contradictions**: specialist A says X, specialist B implies not-X
   - **Date staleness**: claims relying on >18-month-old data in a fast-moving area
   - **Geographic/cultural narrowness**: only US/English sources for a global topic
5. For each material gap, generate a "fill-in specialist brief" — a 100-word
   task description for a focused subagent that would close the gap.

## Output: \`${out}\`

\`\`\`markdown
# Completeness Audit: ${args.topic}
*Date: ${new Date().toISOString().slice(0, 10)}*

## Verdict
🟢 Ready for synthesis / 🟡 Needs targeted fill-ins / 🔴 Substantial gaps; rerun specialists

## Coverage Matrix
| Dimension | Coverage | Specialist | Quality |
|---|---|---|---|
| ... | ✅/🟡/🔴 | ... | brief note |

## Gaps requiring fill-in specialists
For each gap (priority-ordered):
### Gap N: <name>
- **What's missing**: ...
- **Why it matters for the conclusion**: ...
- **Fill-in brief** (paste-ready for spawning a task agent):
  > Specialist focus: <100-word brief>
- **Output file**: \`${notesDir}/fillin-<slug>.md\`

## Other issues (no fill-in needed, just flag for synthesis)
- Source concentration: ...
- Contradictions: ...
- Confidence inflation: ...

## Recommended action
"Spawn N fill-in specialists" / "Proceed to synthesis with caveats" / "Rerun primary research"
\`\`\`

After writing, output to chat: the verdict + count of fill-ins recommended.
The orchestrator will then decide whether to spawn them.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "audit_initiated", notes_dir: notesDir, output_path: out,
          next_steps: [
            `→ recommended (when audit is written): Open ${out} and look at "Recommended gap-fill specialists". Spawn each one as a follow-up task agent before synthesis.`,
            `If audit shows contradiction between specialists: open both notes side-by-side, then run red_team_critique on whichever has the weaker source tier.`,
            `If audit passes (no critical gaps): proceed to synthesis / report writing.`,
          ],
        });
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
          next_steps: [
            `→ recommended (when ideas file is written): Open ${ideasPath} FIRST — this is your "what to build" output with pre-mortems and validation plans for each idea.`,
            `Then cross-reference: open ${report} for the underlying problem-space evidence behind any idea that intrigued you.`,
            `Stress-test the ideas before committing: ensemble_critique({ target_path: "${ideasPath}", domain: "<your domain>" }) — kills the weak ideas. Follow with bias_audit on the same file.`,
            `Pick your top 1-2 ideas and log a forecast: calibration_log({ action: "log", claim: "<idea X reaches PMF in 18 months>", probability: 0.X, source_report: "${ideasPath}" }) — measures your judgment over time.`,
          ],
        });
      },
    },

    // ─── 11. personal_context_profile ─────────────────────────────────
    // Persists "who you are / what you're building / what your constraints
    // are" so every research run can weight findings against your reality
    // (instead of generic "what does the world think"). Auto-injected into
    // the agent context on session start when present.
    {
      name: "personal_context_profile",
      description: "Save / show / clear a personal-context profile that auto-injects into every research run. Encodes your role, stack, constraints, non-goals, and adoption appetite so findings get weighted against your reality (e.g. 'requires NVLink' auto-flags for a PCIe rig, 'eventual consistency only' auto-flags for a strong-consistency shop). One-time setup; massively improves fit-to-you signal for technical research.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "show", "clear"], description: "set = write/replace; show = print current; clear = delete" },
          profile_markdown: { type: "string", description: "(set only) Free-form markdown. Suggested sections: Role, Stack, Scale/Constraints, Non-goals, Adoption appetite (conservative/moderate/aggressive), Known pain points." },
        },
        required: ["action"],
      },
      handler: async (args) => {
        const profilePath = join(RESEARCH_DIR, "_profile.md");
        if (args.action === "set") {
          if (!args.profile_markdown) return JSON.stringify({ error: "set requires profile_markdown" });
          const stamped = `<!-- profile saved: ${new Date().toISOString()} -->\n${args.profile_markdown.trim()}\n`;
          writeFileSync(profilePath, stamped);
          await session.log(`👤 Personal context profile saved (${args.profile_markdown.length} chars). Will auto-inject on next session start.`);
          return JSON.stringify({ status: "saved", path: profilePath,
            note: "Restart session (or it'll pick up on next onSessionStart) for automatic injection.",
            next_steps: [
              `→ recommended: Restart this session so the profile auto-injects into onSessionStart context. After restart, run any research and the agent will weight findings against your profile.`,
              `Validate it took: personal_context_profile({ action: "show" }) after restart.`,
              `Now run your first research: pre_register_research → run_deep_research with a topic that exercises the constraints you encoded.`,
            ],
          });
        }
        if (args.action === "show") {
          if (!existsSync(profilePath)) return JSON.stringify({ status: "no_profile", hint: "Call with action=set and profile_markdown to create one." });
          return JSON.stringify({ status: "ok", path: profilePath, content: readFileSync(profilePath, "utf8") });
        }
        if (args.action === "clear") {
          if (existsSync(profilePath)) { try { writeFileSync(profilePath, ""); } catch {} }
          return JSON.stringify({ status: "cleared" });
        }
        return JSON.stringify({ error: `unknown action: ${args.action}` });
      },
    },

    // ─── 12. pre_register_research ────────────────────────────────────
    // Locks methodology BEFORE specialists run. Inspired by clinical-trial
    // pre-registration. Kills motivated reasoning at the source.
    {
      name: "pre_register_research",
      description: "Pre-register a research protocol BEFORE running specialists: lock evaluation dimensions, exclusion criteria, glossary, falsifiability test, and bias-checks-to-run. Once written, this file is immutable for the duration of the run — synthesis must conform to it. Analog of clinical-trial pre-registration; biggest single defense against motivated reasoning.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Research topic" },
          dimensions: { type: "array", items: { type: "string" }, description: "The dimensions you'll evaluate the topic on (lock these BEFORE looking at vendors/papers, so the rubric isn't reshaped by their narrative)" },
          exclusion_criteria: { type: "array", items: { type: "string" }, description: "Sources/methodologies to EXCLUDE (e.g. 'vendor-sponsored benchmarks', 'sources older than 24 months', 'press releases without underlying data')" },
          glossary: { type: "object", description: "term -> definition. Specialists must use these definitions verbatim. Prevents terminology drift." },
          falsifiability: { type: "string", description: "What evidence would flip the headline conclusion? If you can't answer this, the question is unfalsifiable — sharpen it before proceeding." },
          bias_checks: { type: "array", items: { type: "string" }, description: "Biases to actively guard against on this topic (e.g. survivorship, hype-cycle, vendor narrative, recency, geographic, English-only, echo-chamber)" },
          output_path: { type: "string" },
        },
        required: ["topic", "dimensions", "falsifiability"],
      },
      handler: async (args) => {
        const id = newReportId();
        const slug = slugify(args.topic);
        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : join(RESEARCH_DIR, `${id}-${slug}-prereg.md`);
        const md = `# Pre-Registered Research Protocol
*Locked: ${new Date().toISOString()} — IMMUTABLE for this run*

## Topic
${args.topic}

## Evaluation Dimensions (locked before any source review)
${(args.dimensions || []).map((d, i) => `${i + 1}. ${d}`).join("\n")}

## Exclusion Criteria
${(args.exclusion_criteria || ["(none specified — flag this as a weakness)"]).map((x) => `- ${x}`).join("\n")}

## Glossary (specialists must use these definitions verbatim)
${Object.entries(args.glossary || {}).map(([k, v]) => `- **${k}**: ${v}`).join("\n") || "_(no glossary — terminology drift risk)_"}

## Falsifiability Test
**What evidence would flip the headline conclusion?**

${args.falsifiability}

## Active Bias Checks
${(args.bias_checks || []).map((b) => `- [ ] ${b}`).join("\n") || "- [ ] (none specified — fill before synthesis)"}

## Compliance
Synthesis MUST:
- Score every finding against the locked dimensions (no new dimensions invented mid-research)
- Discard any source that violates exclusion criteria
- Use glossary terms verbatim
- Address the falsifiability test in the conclusion section
- Run the bias checks and document the result of each
`;
        writeFileSync(out, md);
        await session.log(`📜 Pre-registered: ${basename(out)}`);
        return JSON.stringify({ status: "pre_registered", protocol_path: out,
          next_steps: [
            `→ recommended: Run plan_research or run_deep_research now, passing the protocol path as context (e.g., 'Use the locked protocol at ${out} — do not deviate from its dimensions or exclusion criteria').`,
            `Do NOT edit ${out} during the run — that defeats the purpose. If the protocol turns out to be wrong, document why in the final report under "Protocol limitations".`,
            `After the research completes: read ${out} alongside the report to verify the synthesis stayed within the locked rubric.`,
          ],
        });
      },
    },

    // ─── 12. ensemble_critique ────────────────────────────────────────
    // 3 critics with different priors. Replaces single-model red-team.
    // Each critic spawned in parallel on a different model family.
    {
      name: "ensemble_critique",
      description: "Run a 3-critic ensemble on a draft report. Each critic has a different prior (skeptic, regulator, practitioner) and runs on a different model when possible. Aggregates findings; only claims that survive all three are publication-ready. Higher signal than single red-team.",
      parameters: {
        type: "object",
        properties: {
          target_path: { type: "string", description: "Path to the draft report (must be in research-output/)" },
          output_path: { type: "string" },
          critic_models: {
            type: "object",
            description: "Override critic models. Defaults: skeptic=gpt-5.4, regulator=claude-opus-4.7, practitioner=gpt-5.3-codex.",
          },
          domain: { type: "string", description: "Optional: 'finance' / 'medical' / 'security' / 'enterprise-saas' — sharpens the regulator/practitioner priors" },
        },
        required: ["target_path"],
      },
      handler: async (args) => {
        const target = safeResolveReport(args.target_path);
        if (!target) return `Target not found at ${args.target_path}.`;
        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : target.replace(/\.md$/, "-ensemble-critique.md");
        const models = {
          skeptic: (args.critic_models && args.critic_models.skeptic) || "gpt-5.4",
          regulator: (args.critic_models && args.critic_models.regulator) || "claude-opus-4.7",
          practitioner: (args.critic_models && args.critic_models.practitioner) || "gpt-5.3-codex",
        };
        const domain = args.domain ? ` (domain: ${args.domain})` : "";
        await session.log(`🎭 Ensemble critique: ${basename(target)} — 3 critics${domain}`);

        const prompt = `# Ensemble Critique (3 critics, parallel)

Target: \`${target}\`
Output: \`${out}\`${domain}

Spawn THREE \`rubber-duck\` agents in PARALLEL (one tool call, three task invocations) with these distinct briefs:

## Critic 1 — The Skeptic (model: ${models.skeptic}, mode: sync)
> You assume every claim is wrong until proven. Your job is to find the weakest evidence and the strongest counter-arguments the author missed.
> Read: ${target}
> For each non-trivial claim: (a) is it falsifiable? (b) is the evidence independent or echo-chamber? (c) what counter-evidence exists that the author didn't surface?
> Output a list of claims ranked by epistemic fragility (most fragile first).

## Critic 2 — The Regulator (model: ${models.regulator}, mode: sync)
> You read this as a regulator${args.domain ? ` in ${args.domain}` : ""}. Your job is to surface compliance, safety, ethical, legal, privacy, and disclosure risks the author treated as out-of-scope.
> Read: ${target}
> Catalog every recommendation/conclusion that would face regulatory friction or hidden liability. Specifically: data-handling, IP, dual-use, anti-trust, consumer-protection, environmental, labor.
> Output a risk register with severity (low/med/high) and which jurisdiction/framework applies.

## Critic 3 — The Practitioner (model: ${models.practitioner}, mode: sync)
> You're the engineer who has to actually implement what this report recommends. Your job is to find where the recommendations break against operational reality.
> Read: ${target}
> For each recommendation: (a) what's the actual integration cost? (b) what existing system does it conflict with? (c) what skill/headcount does it require that the typical reader won't have? (d) does the timeline assume an unrealistic team?
> Output a feasibility table with build/buy/integrate cost and a "would I bet my quarter on this" verdict.

After all three return, write \`${out}\`:

\`\`\`markdown
# Ensemble Critique — ${basename(target)}
*3 critics: ${models.skeptic} (skeptic), ${models.regulator} (regulator), ${models.practitioner} (practitioner)*
*Date: ${new Date().toISOString().slice(0, 10)}*

## Verdict
🟢 publishable / 🟡 revise-then-publish / 🔴 substantial revision

## Findings that ALL THREE critics flagged
(highest priority — survived three independent priors)
1. ...

## Findings that TWO critics flagged
(medium priority)

## Findings that ONE critic flagged (per critic)
### Skeptic
### Regulator
### Practitioner

## Findings the report does WELL (cross-critic consensus)
(don't break these in revision)

## Top 3 actions before publication
1. ...
\`\`\`

CRITICAL: Spawn all three agents in PARALLEL (single response, three task tool calls). Wait for all three. Then write the aggregated file.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "ensemble_initiated", target_path: target, output_path: out, critics: models,
          next_steps: [
            `→ recommended (when ensemble report is written): Open ${out} and find the "Aggregate findings" section. Claims flagged by ≥2 of 3 critics are the ones to act on first.`,
            `For each consensus finding: edit ${target} to either (a) downgrade the confidence tag, (b) add a counter-evidence quote, or (c) remove the claim.`,
            `Then run bias_audit({ report_path: "${target}" }) — covers a different failure mode (systematic bias) that critics often miss.`,
            `Final gate before sharing: citation_verifier({ report_path: "${target}" }) with verbatim-quote enforcement.`,
          ],
        });
      },
    },

    // ─── 13. bias_audit ───────────────────────────────────────────────
    {
      name: "bias_audit",
      description: "Run an explicit bias audit checklist on a draft report. Each bias gets a documented pass/fail with evidence. Biases checked: survivorship, hype-cycle, recency, vendor-narrative, geographic, English-only, echo-chamber, confirmation, anchoring, single-narrator, selection. Failed checks block publication.",
      parameters: {
        type: "object",
        properties: {
          report_path: { type: "string" },
          output_path: { type: "string" },
          extra_biases: { type: "array", items: { type: "string" }, description: "Domain-specific biases to add (e.g. 'WEIRD-population' for behavioral, 'p-hacking' for empirical)" },
        },
        required: ["report_path"],
      },
      handler: async (args) => {
        const target = safeResolveReport(args.report_path);
        if (!target) return `Report not found at ${args.report_path}.`;
        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : target.replace(/\.md$/, "-bias-audit.md");
        const extra = (args.extra_biases || []).map((b) => `- ${b}`).join("\n");
        await session.log(`🧪 Bias audit: ${basename(target)}`);
        const prompt = `# Bias Audit

Target: \`${target}\`
Output: \`${out}\`

Read the target report. For EACH bias below, produce a structured verdict.

## Biases to check
1. **Survivorship** — Are we only seeing winners? Did we search for failures, postmortems, abandoned projects?
2. **Hype cycle** — Are stars/articles/buzz being treated as production traction?
3. **Recency** — Is the evidence base skewed to last 90 days while ignoring stable older evidence?
4. **Vendor narrative** — Did vendor framing reshape the rubric? Are vendor blogs being treated as evidence rather than claims?
5. **Geographic / English-only** — Are non-English / non-US/EU sources missing?
6. **Echo-chamber** — Multiple sources, but all citing the same originator (1 paper / 1 press release)?
7. **Confirmation** — Did we stop searching after the first agreement?
8. **Anchoring** — Did the first source disproportionately shape framing of all others?
9. **Single-narrator** — Same person/org told us this story across many surfaces?
10. **Selection** — Were the sources/cases chosen because they support the conclusion?
${extra ? `## Extra biases (caller-supplied)\n${extra}` : ""}

## Output format
Write \`${out}\`:

\`\`\`markdown
# Bias Audit — ${basename(target)}
*Date: ${new Date().toISOString().slice(0, 10)}*

## Summary
- ✅ Passed: N | ⚠️ Warning: M | 🔴 Failed: K
- **Publication recommendation**: ✅ ship / ⚠️ ship-with-caveats / 🔴 revise-first

## Per-bias verdict
### Survivorship — ✅ / ⚠️ / 🔴
- **Evidence in report**: <quote/section>
- **Why this verdict**: ...
- **Required fix (if not ✅)**: ...

(repeat for every bias)

## Top 3 fixes before publication
1. ...
\`\`\`

A bias gets ✅ ONLY if you can point to specific evidence in the report that the author actively guarded against it (e.g. for survivorship, the report cites failed projects). Default to ⚠️ when in doubt; default to 🔴 when no guard is visible.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "bias_audit_initiated", report_path: target, output_path: out,
          next_steps: [
            `→ recommended (when audit is written): Open ${out} and look at the per-bias verdict table. Each FAIL is a section of ${target} that needs a specific fix.`,
            `Common fixes: survivorship FAIL → add a "graveyard" section listing failed comparables; vendor-narrative FAIL → add an independent / non-vendor source per claim; recency FAIL → add a 5+ year baseline.`,
            `After remediation: re-run bias_audit on the patched report. Aim for all checks PASS before publishing.`,
            `If you also ran ensemble_critique, cross-reference: a claim flagged by both is high-priority to remove.`,
          ],
        });
      },
    },

    // ─── 14. calibration_log ──────────────────────────────────────────
    // Append-only ledger of probabilistic claims for Brier scoring over time.
    {
      name: "calibration_log",
      description: "Append a probabilistic claim to the calibration ledger, OR record an outcome on a previously-logged claim, OR compute Brier score over resolved claims. Critical for measuring whether your agent's '🔵 Likely' tags actually correspond to ~70% accuracy in reality.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["log", "resolve", "score"], description: "log = add new claim; resolve = mark a claim as true/false; score = compute Brier" },
          claim_id: { type: "string", description: "Required for resolve. Returned by log." },
          claim: { type: "string", description: "The claim text (for log)" },
          probability: { type: "number", description: "0.0–1.0 (for log). Map ✅=0.95, 🔵=0.75, 🟠=0.45, ⚡=0.50." },
          source_report: { type: "string", description: "Path to the report where the claim was made (for log)" },
          resolves_by: { type: "string", description: "ISO date when the claim should be resolvable (for log)" },
          outcome: { type: "boolean", description: "True/False (for resolve)" },
          evidence: { type: "string", description: "Verbatim evidence + URL for the resolve verdict" },
        },
        required: ["action"],
      },
      handler: async (args) => {
        const ledger = join(RESEARCH_DIR, "_calibration-ledger.jsonl");
        const readLedger = () => existsSync(ledger)
          ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
          : [];
        const append = (obj) => {
          const line = JSON.stringify(obj);
          const prev = existsSync(ledger) ? readFileSync(ledger, "utf8") : "";
          writeFileSync(ledger, prev + line + "\n");
        };

        if (args.action === "log") {
          if (!args.claim || args.probability == null) return JSON.stringify({ error: "log requires claim + probability" });
          const id = "clm_" + randomBytes(4).toString("hex");
          append({ id, ts: new Date().toISOString(), claim: args.claim, p: args.probability, source: args.source_report || null, resolves_by: args.resolves_by || null, outcome: null, evidence: null });
          return JSON.stringify({ status: "logged", claim_id: id, ledger,
            next_steps: [
              `→ recommended: Set a calendar reminder for the resolves_by date. When that date arrives, run calibration_log({ action: "resolve", claim_id: "${id}", outcome: true|false, evidence: "<verbatim quote + URL>" }).`,
              `After ≥10 claims resolve: calibration_log({ action: "score" }) — computes Brier score. If your 🔵 Likely tags don't actually hit ~70% accuracy, recalibrate your confidence language.`,
            ],
          });
        }

        if (args.action === "resolve") {
          if (!args.claim_id || args.outcome == null) return JSON.stringify({ error: "resolve requires claim_id + outcome" });
          const all = readLedger();
          const idx = all.findIndex((c) => c.id === args.claim_id);
          if (idx < 0) return JSON.stringify({ error: `claim ${args.claim_id} not found` });
          all[idx].outcome = args.outcome;
          all[idx].evidence = args.evidence || null;
          all[idx].resolved_at = new Date().toISOString();
          writeFileSync(ledger, all.map((c) => JSON.stringify(c)).join("\n") + "\n");
          return JSON.stringify({ status: "resolved", claim: all[idx] });
        }

        if (args.action === "score") {
          const all = readLedger();
          const resolved = all.filter((c) => c.outcome != null);
          if (resolved.length === 0) return JSON.stringify({ status: "no_resolved_claims", total_logged: all.length });
          const brier = resolved.reduce((s, c) => s + Math.pow(c.p - (c.outcome ? 1 : 0), 2), 0) / resolved.length;
          // bucketed calibration
          const buckets = {};
          for (const c of resolved) {
            const b = Math.floor(c.p * 10) / 10;
            buckets[b] = buckets[b] || { count: 0, true_count: 0, mean_p: 0 };
            buckets[b].count++;
            buckets[b].true_count += c.outcome ? 1 : 0;
            buckets[b].mean_p += c.p;
          }
          const calibration = Object.entries(buckets).map(([p_bucket, b]) => ({
            stated_p_range: `${p_bucket}–${(parseFloat(p_bucket) + 0.1).toFixed(1)}`,
            n: b.count,
            mean_stated_p: (b.mean_p / b.count).toFixed(2),
            actual_true_rate: (b.true_count / b.count).toFixed(2),
            calibration_gap: ((b.mean_p / b.count) - (b.true_count / b.count)).toFixed(2),
          })).sort((a, b) => parseFloat(a.stated_p_range) - parseFloat(b.stated_p_range));
          return JSON.stringify({
            status: "scored",
            total_logged: all.length,
            resolved: resolved.length,
            brier_score: brier.toFixed(4),
            interpretation: brier < 0.1 ? "🟢 well-calibrated" : brier < 0.25 ? "🟡 acceptable" : "🔴 poorly calibrated — the agent's confidence tags don't match reality",
            calibration_table: calibration,
            note: "Brier 0.0 = perfect, 0.25 = uniform 50% guess on binary, 1.0 = always wrong with full confidence.",
          }, null, 2);
        }

        return JSON.stringify({ error: `unknown action: ${args.action}` });
      },
    },

    // ─── 15. eval_harness ─────────────────────────────────────────────
    // Reference-question benchmark; the single biggest enterprise gap.
    {
      name: "eval_harness",
      description: "Run the orchestrator against a reference-question benchmark and score it on factual accuracy, citation correctness, hallucination rate, calibration. Without this, every other 'improvement' to the agent is unmeasurable. Loads a YAML/JSON benchmark of (question, ground-truth-answer, scoring-rubric), runs each, grades via a critic on a different model, writes a regression report.",
      parameters: {
        type: "object",
        properties: {
          benchmark_path: { type: "string", description: "Path to the benchmark file (JSON or YAML). If omitted, uses the bundled sample at eval-benchmark/sample.json." },
          subset: { type: "array", items: { type: "string" }, description: "Run only specific question IDs (default: all)" },
          grader_model: { type: "string", description: "Different model family to grade with. Default: gpt-5.4" },
          output_path: { type: "string" },
          depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Depth to run each benchmark question at (default: quick — keeps cost reasonable)" },
        },
        required: [],
      },
      handler: async (args) => {
        const benchmarkPath = args.benchmark_path
          ? (safeResolveReport(args.benchmark_path) || resolve(process.cwd(), args.benchmark_path))
          : join(RESEARCH_DIR, "..", ".github", "extensions", "research-orchestrator", "eval-benchmark", "sample.json");
        if (!existsSync(benchmarkPath)) {
          return JSON.stringify({
            error: "benchmark file not found",
            looked_at: benchmarkPath,
            hint: "Pass benchmark_path or seed eval-benchmark/sample.json. See the bundled sample for schema."
          });
        }
        let benchmark;
        try {
          const raw = readFileSync(benchmarkPath, "utf8");
          benchmark = JSON.parse(raw);
        } catch (e) {
          return JSON.stringify({ error: "could not parse benchmark JSON", detail: e.message });
        }
        const questions = benchmark.questions || [];
        const subset = args.subset && args.subset.length ? questions.filter((q) => args.subset.includes(q.id)) : questions;
        const grader = args.grader_model || "gpt-5.4";
        const depth = args.depth || "quick";
        const runId = newReportId();
        const out = args.output_path
          ? (safeResolveReport(args.output_path) || join(RESEARCH_DIR, basename(args.output_path)))
          : join(RESEARCH_DIR, `${runId}-eval-harness-report.md`);

        await session.log(`🎯 Eval harness: ${subset.length} question(s), depth=${depth}, grader=${grader}`);

        const prompt = `# Eval Harness Run

Benchmark: \`${benchmarkPath}\`
Questions to run: ${subset.length}
Depth per question: ${depth}
Grader model: ${grader}
Output: \`${out}\`

## Phase A — Run the agent on each benchmark question (PARALLEL)

For EACH question below, spawn a \`general-purpose\` task subagent (mode: background) that calls \`run_deep_research\` with that topic at depth=${depth}. Capture the resulting report path.

Questions:
${subset.map((q, i) => `${i + 1}. **${q.id}**: ${q.question}`).join("\n")}

Wait for all to complete (use list_agents / read_agent).

## Phase B — Grade each result against ground truth (PARALLEL)

For EACH completed question, spawn a \`rubber-duck\` agent on \`model: ${grader}\` (different family) with this brief:

> You are a strict grader. Compare the agent's report to the ground truth. Be precise — partial credit is fine but document why.
>
> **Question**: <q.question>
> **Ground truth**:
> ${"```"}
> <q.ground_truth>
> ${"```"}
> **Scoring rubric**: <q.rubric>
>
> **Agent's report**: <path>
>
> Grade on (0.0 – 1.0, with one-sentence justification each):
> 1. **Factual accuracy** — does the report's headline answer match ground truth?
> 2. **Citation correctness** — do the cited URLs actually support the claims?
> 3. **Hallucination rate** — fraction of factual claims unsupported by any source
> 4. **Numeric accuracy** — for any numbers in the report, are they within ±10% of ground-truth numbers?
> 5. **Calibration** — claims tagged ✅ are >90% true; 🔵 are 60-80%; 🟠 ≤50%
> 6. **Coverage** — fraction of ground-truth bullet points the report addressed
>
> Return JSON: \`{ "id": "<id>", "scores": { ... }, "overall": float, "notes": "..." }\`

## Phase C — Aggregate & write the report

Write \`${out}\`:

\`\`\`markdown
# Eval Harness Report — run ${runId}
*Date: ${new Date().toISOString().slice(0, 10)} | Benchmark: ${basename(benchmarkPath)} | N=${subset.length} | depth=${depth}*

## Headline scores (mean ± std)
| Metric | Score | Interpretation |
| --- | --- | --- |
| Factual accuracy | x.xx | ... |
| Citation correctness | x.xx | ... |
| Hallucination rate | x.xx | lower = better |
| Numeric accuracy | x.xx | ... |
| Calibration | x.xx | ... |
| Coverage | x.xx | ... |
| **Overall** | x.xx | 🟢 / 🟡 / 🔴 |

## Per-question results
| ID | Question | Overall | Notes |
| --- | --- | --- | --- |

## Regressions vs previous runs
(scan _eval-runs/ for prior eval reports; flag any metric that dropped >0.05 vs the most recent prior run)

## Top failures (lowest-scoring questions)
1. **<id>**: <one-line diagnosis>

## Recommended fixes (ranked)
1. ...
\`\`\`

Also append a JSONL entry to \`${join(RESEARCH_DIR, "_eval-runs.jsonl")}\` with \`{ run_id, date, benchmark, n, mean_overall, mean_per_metric }\` for trend tracking.`;

        setTimeout(() => session.send({ prompt }), 100);
        return JSON.stringify({ status: "eval_initiated", run_id: runId, benchmark: benchmarkPath, n: subset.length, output_path: out,
          next_steps: [
            `→ recommended (when scoring finishes): Open ${out} for the regression report. Compare overall accuracy / hallucination rate / citation correctness to the previous eval run.`,
            `If accuracy dropped: bisect — which prompt or orchestration change since last eval caused the regression?`,
            `Extend the benchmark over time: add 1-2 new reference questions per major project area. The benchmark gets more useful as it grows.`,
            `Run eval_harness BEFORE merging any prompt or extension change — single most important regression gate.`,
          ],
        });
      },
    },

    // ─── 16. list_research_reports ───────────────────────────────────
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
      const count = rebuildMemoryIndex();
      await session.log(`🔬 Research Orchestrator v2 (enterprise multi-agent) loaded — ${count} prior report(s) indexed`);
      const memoryDigest = memoryDigestForContext();
      let profileBlock = "";
      const profilePath = join(RESEARCH_DIR, "_profile.md");
      if (existsSync(profilePath)) {
        try {
          const p = readFileSync(profilePath, "utf8").trim();
          if (p) profileBlock = `\n\n**👤 Personal context profile (auto-injected — every research run should weight findings against this):**\n\n${p}\n\n*To edit: \`personal_context_profile\` tool with \`action: "set"\`. To remove: \`action: "clear"\`.*`;
        } catch { /* ignore */ }
      }
      return {
        additionalContext: `Research orchestrator v2 active — enterprise multi-agent, falsification-first, with cross-session memory and adaptive supervision.

**Pipeline (informed by Apr 2026 literature: MIA, HiRAS, CoSearch, SeekerGym):**
\`recall memory → plan → parallel specialists (multi-query) → completeness audit → adaptive gap-fill → citation-grounded synthesis → multi-model red-team → confidence escalation → citation verify → memory update\`

**Tools**
- \`recall_prior_research\` — query memory of past reports (always run first on a new topic)
- \`personal_context_profile\` — **NEW** save your role/stack/constraints once; every research run weights findings against it
- \`pre_register_research\` — **NEW** lock dimensions/exclusions/glossary/falsifiability BEFORE specialists run (kills motivated reasoning)
- \`plan_research\` — generate a structured research plan
- \`run_deep_research\` — full hybrid pipeline with all enterprise phases
- \`deep_paper_search\` — arXiv + Semantic Scholar with citation-graph traversal
- \`trend_quantifier\` — GitHub/npm/PyPI/Trends/jobs with code-validated curves
- \`concept_explainer\` — layered technical breakdowns with runnable code
- \`completeness_audit\` — gap detection on specialist notes; recommends fill-ins
- \`red_team_critique\` — adversarial review on a *different model family* (default ${CRITIC_MODEL})
- \`ensemble_critique\` — **NEW** 3-critic ensemble (skeptic + regulator + practitioner) for higher-signal review than single critic
- \`bias_audit\` — **NEW** explicit checklist (survivorship/hype/recency/vendor/echo/...) with documented pass-fail per bias
- \`citation_verifier\` — fetch each cited URL, check claim support, **now requires verbatim quotes for ✅**
- \`validate_with_code\` — Python validation (Monte Carlo, trend fit, CI, recompute, benchmark)
- \`calibration_log\` — **NEW** append probabilistic claims, resolve outcomes, compute Brier score (measures whether your confidence tags match reality)
- \`eval_harness\` — **NEW** run the orchestrator against a reference benchmark; scores accuracy/citation/hallucination/calibration. **The single most important tool for measuring quality over time.**
- \`brainstorm_from_research\` — stress-tested project ideas (with optional code validation)
- \`list_research_reports\` — index of everything in research-output/

**Enterprise quality discipline (Gartner-grade):**
1. Start with \`pre_register_research\` for non-trivial topics — locks the rubric before evidence can reshape it
2. Use \`ensemble_critique\` instead of single \`red_team_critique\` for publication-track reports
3. Always run \`bias_audit\` before declaring a report finished
4. \`citation_verifier\` is non-negotiable — verbatim quotes only, no paraphrase drift
5. Log probabilistic claims to \`calibration_log\`; review Brier score quarterly
6. Run \`eval_harness\` after any change to prompts/orchestration to catch regressions

**Methodology lives in:**
\`.github/instructions/research.instructions.md\` (falsification, confidence tags, source tiers, multi-query)
\`.github/instructions/orchestration.instructions.md\` (when/how to spawn subagents, audit, escalation)
\`.github/instructions/code-validation.instructions.md\` (when/how to write validation code)
\`.github/instructions/memory.instructions.md\` (cross-session memory, recall discipline)

**Enterprise defaults**: \`autonomy=auto\`, \`enable_code_validation=true\`, critic model = ${CRITIC_MODEL} (different family from orchestrator).

---

**🧭 NEXT-STEPS DIRECTIVE (mandatory for every research-tool response)**

After ANY tool from this orchestrator returns, your final user-facing message MUST end with a section formatted exactly like:

\`\`\`
## 🧭 Next steps

1. **<verb> <thing>** — <one-sentence why>. Run: \`<exact tool name + key args>\`
2. **<alternative path>** — <why you'd pick this branch>. Run: \`<tool + args>\`
3. (optional) **Stop here if** — <condition under which the user is already done>
\`\`\`

Rules:
- Suggest 2-3 concrete next moves, not generic advice. Each must name a specific tool or file.
- Order by what most users should do FIRST. Mark the recommended one with **→ recommended**.
- If a tool returned a \`next_steps\` array in its JSON, use those verbatim as the seed — but still add your own judgment about which one fits the user's profile and the phase they're in.
- After a long pipeline (run_deep_research, brainstorm_from_research), tell the user **which file to open first**, not just that files exist.
- After a critique/audit, tell them **what verdict triggers what action** (e.g., "if ≥2 critics flag a claim, downgrade it from ✅ to 🟠 in the report and re-run citation_verifier on that section").
- Never end a response after a long-running tool with just "done" or "saved to X". Always tell them what to do with the output.

This directive overrides the default "be brief" guidance for the closing block: the Next-steps section is required even when the rest of your reply is short.

${memoryDigest || "_(No prior research on file. Memory will accumulate as you run new investigations.)_"}${profileBlock}`,
      };
    },

    onPostToolUse: async (input) => {
      const args = input.toolArgs || {};
      const path = String(args.path || args.file_path || "");
      if ((input.toolName === "create" || input.toolName === "edit") && path.includes("research-output")) {
        await session.log(`📄 ${input.toolName === "create" ? "Saved" : "Updated"}: ${path}`);
        // Refresh the memory index whenever a final report is written.
        if (path.endsWith("-report.md")) {
          try {
            const n = rebuildMemoryIndex();
            await session.log(`🧠 Memory index refreshed (${n} reports)`, { ephemeral: true });
          } catch { /* ignore */ }
        }
      }
    },

    onSessionEnd: async () => {
      try {
        const n = rebuildMemoryIndex();
        return { sessionSummary: `Research orchestrator v2: memory index refreshed with ${n} report(s).` };
      } catch { return undefined; }
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
      await session.log(`✅ ${reports.length} report(s) in ./research-output/ | memory: ${MEMORY_INDEX_PATH}`, { ephemeral: true });
    }
  } catch { /* ignore */ }
});
