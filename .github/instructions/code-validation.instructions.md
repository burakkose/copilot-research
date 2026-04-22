---
applyTo: "research-output/**"
---

# Code-Driven Validation

Numbers, trends, and "X% of Y" claims are where research goes wrong. When a
finding depends on quantitative evidence, **validate with code instead of
trusting prose**. This file defines when and how.

Companion: `research.instructions.md` (methodology) + `orchestration.instructions.md`.

---

## 1. When to write code

Write code (Python preferred) whenever a claim depends on:

| Trigger | Example | What to compute |
|---|---|---|
| Stated growth rate | "growing 40% YoY" | Pull raw data, recompute CAGR yourself |
| Aggregated statistic | "65% of devs use X" | Find sample size; recompute; bootstrap CI |
| Market projection | "TAM = $50B by 2030" | Sensitivity analysis on assumptions |
| Trend / momentum | "GitHub stars exploding" | Fit linear/exponential, report slope + R² |
| Comparative ranking | "X is faster than Y" | Pull benchmark data; check methodology |
| Adoption signal | "1M downloads" | Compare to baseline; check for bot inflation |
| Economic feasibility | "this would cost $X to run" | Build a cost model |

If the claim is decision-relevant and you *didn't* run the numbers — say so
and downgrade confidence.

---

## 2. Standard validation patterns

### Pattern A — Recompute headline numbers
```python
# Pull raw data (npm/PyPI/GitHub API, etc.)
# Recompute the metric the source claimed
# Compare; flag discrepancies
import requests, statistics
r = requests.get("https://api.npmjs.org/downloads/range/2024-01-01:2025-12-31/<pkg>")
weekly = [...]   # aggregate from daily
print(f"Weekly downloads Jan 2024: {weekly[0]}")
print(f"Weekly downloads Oct 2025: {weekly[-1]}")
print(f"CAGR: {((weekly[-1]/weekly[0])**(1/1.83) - 1)*100:.1f}%")
```

### Pattern B — Fit a trend
```python
import numpy as np
# x = months since start, y = metric
x, y = np.arange(len(values)), np.array(values)
# Linear fit
m, b = np.polyfit(x, y, 1)
ss_res = ((y - (m*x+b))**2).sum()
ss_tot = ((y - y.mean())**2).sum()
r2 = 1 - ss_res/ss_tot
print(f"slope={m:.2f}/month  R²={r2:.3f}")
# Exponential fit (log y)
m2, b2 = np.polyfit(x, np.log(y), 1)
print(f"exp growth rate={m2*100:.1f}%/month")
```

### Pattern C — Monte Carlo on a market projection
```python
import numpy as np
# Source claims TAM = users * arpu * penetration
n = 10_000
users = np.random.lognormal(mean=np.log(50_000_000), sigma=0.5, size=n)
arpu  = np.random.uniform(50, 200, n)
pen   = np.random.beta(2, 8, n)        # most outcomes low
tam   = users * arpu * pen
print(f"P10={np.percentile(tam,10)/1e9:.1f}B  P50={np.percentile(tam,50)/1e9:.1f}B  P90={np.percentile(tam,90)/1e9:.1f}B")
```

### Pattern D — Sample-size / sanity check on a survey claim
```python
# Source: "65% of N=320 respondents use X"
# 95% CI via Wilson interval
from statsmodels.stats.proportion import proportion_confint
lo, hi = proportion_confint(208, 320, method='wilson')
print(f"95% CI: [{lo*100:.1f}%, {hi*100:.1f}%]")
```

### Pattern E — Benchmark replication
- If a vendor claims "2× faster than competitor", pull both libs and run a
  minimal benchmark on your own machine. Note: methodology beats numbers —
  document workload, hardware, versions.

### Pattern F — GitHub momentum
```python
# Stars over time via GitHub API + the star-history dataset
# Compute: 90-day rolling new-stars, contributor count, bus factor
# A repo with 30k stars but 2 active contributors is fragile
```

---

## 3. What to save

For every code-validated claim, write to `research-output/<id>-artifacts/`:

- `<slug>.py` — the script (must be re-runnable)
- `<slug>.json` or `<slug>.csv` — raw data fetched
- `<slug>.md` — short writeup: claim, method, result, caveats
- `<slug>.png` (optional) — chart if visual

Reference the artifact in the report:
```
[Verified by code](./research-output/<id>-artifacts/<slug>.md): npm weekly
downloads grew 11.2× from Jan 2024 → Oct 2025 (CAGR 187%, R²=0.94 on log fit).
```

---

## 4. Report-time conventions

- Annotate validated claims: `[code-verified]` link to artifact
- Annotate unvalidated quantitative claims: `[uncomputed]` — and explain why
- Do not present a Monte Carlo result as a point estimate — always give a range
- Always disclose: data source, date pulled, sample size, key assumptions

---

## 5. When NOT to write code

- Pure qualitative findings (no numbers in play)
- Claims you'll downgrade to 🟠 Speculative anyway
- When the data isn't accessible (paywalled, no API) — note this explicitly
- For background facts the conclusions don't depend on

Code is a tool for **decision-relevant numerics**, not for show.

---

## 6. Failure modes

- Pulling data once and not noting the date → numbers go stale silently
- Trusting an API endpoint without sanity check (zero values, schema changes)
- Cherry-picking date ranges that flatter the trend
- Reporting a fit without R² / residual check
- Confusing correlation in time series with growth (seasonality)
