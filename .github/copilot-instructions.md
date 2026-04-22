# Copilot Instructions

This is a research and brainstorming workspace. The primary workflow is:

1. Use the `run_deep_research` tool to investigate topics across web, academic, and market sources
2. Use the `brainstorm_from_research` tool to generate ranked project ideas from findings
3. All output goes to `./research-output/` with timestamped filenames

## Available MCP Tools
When doing research, use all available tools aggressively:
- `web_search` / `web_fetch` — built-in web access
- `tavily` — full research pipeline (search + extract + crawl)
- `brave-search` — privacy-first web search for cross-checking
- `arxiv` — academic paper search and retrieval
- `firecrawl` — deep web scraping and structured extraction

## Preferences
- Always save intermediate findings, don't just keep them in context
- Cite every claim with a source URL
- When in doubt, search more rather than less
- Prefer recent sources (last 6 months) unless historical context is needed
