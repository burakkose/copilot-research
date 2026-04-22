# 🔬 AI Research Agent

A multi-agent research and brainstorming system built on GitHub Copilot CLI.

## What This Does

Launch a prompt, go to sleep, wake up to a comprehensive research report with
ranked project ideas. Uses MCP servers for web search, academic papers, market
analysis, and trend detection.

## Quick Start

### 1. Install MCP Servers

Open Copilot CLI and run `/mcp` to add these servers:

```
tavily        → Web search + extraction (TAVILY_API_KEY)
brave-search  → Cross-checking results (BRAVE_API_KEY)
arxiv         → Academic papers (no key needed)
firecrawl     → Deep web scraping (FIRECRAWL_API_KEY)
```

Or copy `mcp-servers.json` into your Copilot config (see below).

### 2. Get API Keys

| Service | Free Tier | Sign Up |
|---------|-----------|---------|
| Tavily | 1000 searches/mo | https://tavily.com |
| Brave Search | 2000 queries/mo | https://brave.com/search/api |
| Firecrawl | 500 pages/mo | https://firecrawl.dev |
| ArXiv MCP | Unlimited | No key needed |

### 3. Set Environment Variables

```bash
cp .env.example .env
# Edit .env with your API keys
source .env
```

### 4. Run Research

```bash
copilot --experimental
```

Then in the session:
```
> Run deep research on "AI agents for developer productivity"
```

Or use autopilot mode (Shift+Tab) for fully autonomous overnight runs.

## Project Structure

```
.github/
  extensions/
    research-orchestrator/
      extension.mjs          # Core orchestrator extension
  instructions/
    research.instructions.md  # Agent behavior instructions
  copilot-instructions.md     # Global Copilot instructions
mcp-servers.json              # MCP server configuration reference
research-output/              # Where reports get saved
  .gitkeep
.env.example                  # API key template
```

## Usage Patterns

### Quick Research (5 min)
```
/research What are the top AI agent frameworks in 2026?
```

### Standard Research (1-2 hours)
```
Run deep research on "serverless AI inference" covering web_trends,
academic_papers, and market_analysis
```

### Overnight Deep Dive
```
Run deep research on "autonomous coding agents" with depth "deep" covering
web_trends, academic_papers, market_analysis, competitor_analysis, tech_landscape.
Then brainstorm project ideas for a solo developer with TypeScript/Python stack.
```

### Brainstorm From Existing Research
```
Brainstorm project ideas from research-output/my-report.md.
I'm a solo dev, budget $0, prefer TypeScript + Python stack.
```

## Extending

- Add more MCP servers via `/mcp` in Copilot CLI
- Edit the extension in `.github/extensions/research-orchestrator/extension.mjs`
- Add custom instructions in `.github/instructions/`
