# cc-session-stats

See how much time you actually spend with Claude Code.

```
npx cc-session-stats
```

## What it shows

- Total sessions and hours
- Average session duration
- Longest session (your personal record)
- Hours by day of week
- Active hours heatmap
- Project breakdown
- Consecutive day streak
- Health warnings when usage looks concerning

## Sample output

```
  Claude Code Session Stats v1.0
  ═══════════════════════════════════════
  Scanning: ~/.claude/projects/

  ▸ Overview
    Sessions:     3396
    Total hours:  101h
    Active days:  47 / 50 days
    First seen:   2026-01-10
    Last seen:    2026-02-28

  ▸ Averages
    Per session:  0.0h
    Per day:      2.1h
    Last 7 days:  23.4h across 8 days

  ▸ Longest Session
    2.7h on 2026-02-28 — cc-loop

  ▸ Hours by Day of Week
    Sun  ███████████████   20.3h
    Mon  █████████████░░   17.2h
    ...

  ▸ Streak
    Longest consecutive days: 35

  ▸ Health Warnings
    ⚠ 35 consecutive days of AI usage. Rest days exist for a reason.

  ▸ Tips
    → Schedule at least one AI-free day per week.
    → Stretch your hip flexors. They're angry. Trust me.
```

## JSON output

For CI pipelines, dashboards, or programmatic use:

```
npx cc-session-stats --json
```

Outputs structured JSON to stdout:

```json
{
  "version": "1.0",
  "totalSessions": 3405,
  "totalHours": 102.12,
  "activeDays": 47,
  "totalDaysSpan": 50,
  "firstSeen": "2026-01-10",
  "lastSeen": "2026-02-28",
  "averages": { "perSession": 0.03, "perDay": 2.17 },
  "longestSession": { "hours": 3.89, "date": "2026-02-28", "project": "cc-loop" },
  "hoursByDayOfWeek": { "Sun": 20.27, "Mon": 17.2, "..." : "..." },
  "topProjects": [{ "name": "~", "hours": 89.47 }, "..."],
  "streak": 35,
  "healthWarnings": ["35 consecutive days of AI usage. Rest days exist for a reason."],
  "last7Days": { "hours": 24.72, "activeDays": 8 }
}
```

## How it works

1. Scans `~/.claude/projects/` for session transcript files (.jsonl)
2. Reads first and last line of each file for timestamps
3. Calculates session durations and aggregates stats
4. Includes subagent sessions (Task tool spawns)

**Zero dependencies. No data sent anywhere. Runs entirely local.**

## Health warnings

The tool flags concerning patterns:

| Pattern | Warning |
|---------|---------|
| Sessions over 3 hours | Your spine has opinions |
| 7+ consecutive days | Rest days exist for a reason |
| Average session > 2 hours | 90-minute focus blocks are backed by research |
| 6+ hours/day average | That's a full workday of sitting |

## The cc-toolkit trilogy

| Tool | What it checks |
|------|---------------|
| [cc-health-check](https://github.com/yurukusa/cc-health-check) | Is your AI **setup** safe? |
| **cc-session-stats** | How much are you **using** AI? |
| [cc-audit-log](https://github.com/yurukusa/cc-audit-log) | What did your AI **do**? |
| [cc-cost-check](https://github.com/yurukusa/cc-cost-check) | Cost per commit calculator |
| [cc-wrapped](https://yurukusa.github.io/cc-wrapped/) | Your AI year in review (Spotify Wrapped style) |
| [cc-roast](https://yurukusa.github.io/cc-roast/) | Your CLAUDE.md, brutally honest |
| [claude-code-hooks](https://github.com/yurukusa/claude-code-hooks) | Fix your score — 10 hooks + 5 templates |

## License

MIT
