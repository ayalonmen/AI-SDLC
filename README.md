# Swing Trading App

A paper-trading / backtest engine for a swing trading strategy, built
using its own AI-driven SDLC pipeline.

Two things live in this repo:

1. **The product** — a swing trading backtest engine. It will simulate a
   moving-average-crossover strategy against historical daily price bars,
   with risk-based position sizing, stop-losses, and a P&L summary. No
   live broker connection, no real money, no financial advice — this is
   a simulation sandbox.
2. **The factory that builds it** — a small multi-agent pipeline that
   takes a feature request from a rough idea through to a reviewed,
   tested, deployed change, with configurable human-in-the-loop approval
   at each stage.

This README covers Session 1 of the pipeline: one ticket, one agent
(parse), one approval pause.

## Why an AI-SDLC pipeline

Instead of one long chat where an AI writes the whole app in one shot,
the work is broken into stages that mirror a normal software lifecycle:
parse the request, write a spec, implement, review, test, QA, deploy.
Each stage is a separate, narrowly-scoped agent invocation. You control,
per stage, whether the agent runs on its own (`auto`), pauses for your
sign-off (`approve`), or is left entirely to you (`manual`). That dial
lives in `sdlc.config.json`.

Files are the handoff between stages — an agent reads files, writes
output, and the next stage picks it up from disk. That keeps every step
inspectable and auditable instead of buried in chat history.

## How Session 1 works

```
you write tickets/001.md (a fuzzy feature request)
        │
        ▼
npm run sdlc run 001
        │
        ▼
pipeline/run.ts (the orchestrator)
  - reads sdlc.config.json to check the "parse" stage's mode
  - reads CLAUDE.md + agents/parse.md + tickets/001.md
  - calls `claude -p` headlessly with that combined prompt
        │
        ▼
parse agent responds with:
  - Tasks
  - Acceptance Criteria
  - Decisions made to resolve ambiguity
        │
        ▼
orchestrator prints the result and asks: "Approve this output? (y/n)"
        │
        ├─ y → appended to tickets/001.md, logged to runlog.jsonl
        │
        └─ n → asks "What should change?"
                 │
                 ▼
               logs the rejection + your feedback to runlog.jsonl
                 │
                 ▼
               re-runs the parse agent, this time including the
               rejected output and your feedback in its prompt
                 │
                 ▼
               (loops back to "Approve this output?" until you say y)
```

Only the `parse` stage exists so far. Later sessions add `spec`,
`implement`, `review`, `test`, `QA`, and `deploy`, each with its own
agent prompt under `agents/` and its own entry in `sdlc.config.json`.
QA and deploy will always be hard gates — never configurable to `auto`.

## File structure

```
Swing Trading App/
├── README.md            this file
├── CLAUDE.md             shared context every agent reads first (stack, conventions, pipeline overview)
├── sdlc.config.json      the autonomy dial — which stages are manual / approve / auto
├── package.json          npm scripts, incl. `sdlc` which runs the orchestrator
├── tsconfig.json         TypeScript config for the pipeline code
├── agents/
│   └── parse.md          the parse agent's role prompt (read-only; turns a fuzzy request into tasks + acceptance criteria)
├── tickets/
│   └── 001.md            a feature request, written by hand, with parse agent output appended below the divider
├── pipeline/
│   └── run.ts            the orchestrator: reads config + ticket, calls the agent, waits for approval, retries on rejection with feedback, saves, logs
└── runlog.jsonl          one JSON line appended per pipeline run (stage, ticket, mode, duration, approved, and feedback when rejected)
```

## Prerequisites

- Node.js
- The `claude` CLI (Claude Code) installed and on your `PATH` — the
  orchestrator shells out to `claude -p` to invoke agents headlessly

## Usage

Install dependencies (already done if `node_modules` exists):

```bash
npm install
```

Run the parse stage on a ticket:

```bash
npm run sdlc run 001
```

This reads `tickets/001.md`, runs the parse agent, shows you its output,
and asks for approval before writing anything. Every run — approved or
not — is recorded in `runlog.jsonl`.

To try a new feature request, create a new ticket file (e.g.
`tickets/002.md`) with your own rough description, then run
`npm run sdlc run 002`.

## Configuring the autonomy dial

`sdlc.config.json` controls how much each stage runs unattended:

```json
{
  "stages": {
    "parse": { "mode": "approve" }
  }
}
```

- `"manual"` — you do the stage yourself; the pipeline doesn't touch it.
- `"approve"` — the agent produces output, the pipeline pauses and asks
  for your `y`/`n` before saving.
- `"auto"` — the agent runs and the pipeline continues without asking.

As more stages come online, they get their own entry here. QA and
deploy are hard gates by design and will never accept `"auto"`.
