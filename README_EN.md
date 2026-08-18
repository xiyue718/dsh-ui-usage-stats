[中文](./README.md) | [English](./README_EN.md)

# @dsh-external/ui-usage-stats

## Introduction

`ui-usage-stats` is a usage statistics plugin for the DSH Web client. It adds a "Usage Stats" page to Settings, displaying token usage and cost in a **workspace → session → period → model** hierarchy, with totals at each level, session type filtering, fork deduplication, persistent caching, and incremental calculation.

## Installation

### Method 1: Super Module Injector

```text
dev_build_plugin  {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
dev_inject_plugin {"dir": "C:/Users/<user>/.dsh/plugins/ui-usage-stats"}
```

Open or refresh DSH Web and go to Settings → Usage Stats.

### Method 2: dsh CLI (Official Project Way)

If you have the `dsh` CLI installed, follow the official project tutorial to install with `dsh plugin`:

```bash
# Install from a local plugin directory
dsh plugin --profile web add C:/Users/<user>/.dsh/plugins/ui-usage-stats

# Or install from the GitHub repository
dsh plugin --profile web add github:xiyue718/dsh-ui-usage-stats
```

Start after installation:

```bash
dsh --profile web
```

View the composed configuration:

```bash
dsh --profile web --dump-config
```

See the project documentation for details: `docs/user/develop/basic/publish.md`.

Build artifacts: host `lib/index.js`, client `lib/client.js`, package `dsh-external-ui-usage-stats-0.1.0.tgz`.

## Usage

1. Start the DSH Web client.
2. Open the Settings panel.
3. Click "Usage Stats" in the sidebar or navigation.
4. Wait for the statistics to load, then view usage and cost by workspace, session, period, and model.
5. Use the "Total" at the top of the page to see the summary across all workspaces.
6. Check or uncheck session types on the far right of the refresh row; the page shows only the selected types.
7. Click "Refresh" to re-check the revision of all sessions and recalculate only changed ones.

## Features

- Adds a Settings entry: Settings → Usage Stats.
- Displayed fields:
  - Workspace path
  - Session ID
  - Session title
  - Peak/off-peak period
  - Model
  - Cache miss tokens (uncached input)
  - Cache hit tokens (cached input)
  - Output tokens
  - Cost (CNY)
- Level totals:
  - Page-level "Total": aggregates usage and cost across all workspaces
  - Workspace total
  - Session total
  - Period total
  - Model rows are the finest granularity
- Session type filtering:
  - Four checkboxes on the far right of the refresh row: normal user sessions, subagent sessions, fork sessions, and other sessions
  - By default only "normal user sessions" is selected
  - The page only shows data matching the selected types
  - Filter state is persisted through the project storage domain and survives refresh/reopen
- Chat window statistics line:
  - Automatically replaces "cache hit xx%" with "cache hit xx.xx%" based on the real token ratio, keeping two decimal places
  - Calculated by the plugin-side component from the tokenUsage projection, not by simply appending `.00`, and without modifying core project files
- Sorting: workspaces and sessions are sorted by last modification time (last session activity time) in descending order, not by cost.
- Collapse: workspace, session, and period titles can be expanded/collapsed; collapsed by default to reduce rendering.
- Performance: the host reads session logs in parallel and aggregates tokens directly from raw JSONL to avoid full log replay.
- Persistent cache: per-session statistics are persisted through the project storage domain; only sessions whose persistence revision changed are re-read and recalculated, while unchanged sessions reuse cached results.
- Fork deduplication: chat records inherited from the original session through `seedLength` are not double-counted; only usage produced after the fork is counted.
- Clicking "Refresh" re-checks the revision of all sessions and only recalculates updated ones.

### Pricing Calculation

Based on DeepSeek's official peak/off-peak pricing. Peak hours are Beijing time 9:00-12:00 and 14:00-18:00; all other hours are off-peak.

| Model | Period | Input per 1M tokens (cache hit) | Input per 1M tokens (cache miss) | Output per 1M tokens |
|---|---|---|---|---|
| deepseek-v4-flash | Off-peak | 0.05 CNY | 1.5 CNY | 4.5 CNY |
| deepseek-v4-flash | Peak | 0.10 CNY | 3.0 CNY | 9.0 CNY |
| deepseek-v4-pro | Off-peak | 0.15 CNY | 4.5 CNY | 13.5 CNY |
| deepseek-v4-pro | Peak | 0.30 CNY | 9.0 CNY | 27.0 CNY |

Cost formula:

```text
cost = cache miss tokens / 1_000_000 × cache miss unit price
     + cache hit tokens / 1_000_000 × cache hit unit price
     + output tokens / 1_000_000 × output unit price
```

Models not listed above display a cost of `0`.

### Host API

```http
GET /@dsh-external/ui-usage-stats/api/stats
```

```http
GET  /@dsh-external/ui-usage-stats/api/filters
POST /@dsh-external/ui-usage-stats/api/filters
```

## How It Works

The plugin consists of a host half and a client half.

On the host side, it reads session logs through `sessionPersistence.readRaw` or `sessionQuery.readSession`, focusing on the model `usage` data in `assistant/message` events. It aggregates cache miss, cache hit, and output tokens by model and peak/off-peak period, then calculates cost using DeepSeek's official pricing. Fork sessions skip chat records inherited from the original session using `header.seedLength` to avoid double counting.

Statistics are cached per session in the storage domain, keyed by the session's persistence revision. When `/api/stats` is requested, only sessions whose revision changed are re-read and recalculated; unchanged sessions reuse the cache. Sessions are processed in parallel with a `mapLimit` concurrency of 4. Finally, results are grouped by workspace path and returned as a tree sorted by last activity time.

On the client side, it renders the Usage Stats page, calls `/api/stats` for data, displays it level by level by workspace, session, period, and model, and provides collapse, totals, session type filtering, and refresh operations. The percentage correction in the chat window is calculated by a plugin-side component from the tokenUsage projection and displayed with two decimal places.
