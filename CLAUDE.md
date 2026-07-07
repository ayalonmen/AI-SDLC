# CLAUDE.md

<!--
WHAT THIS FILE IS:
The sticky note every agent reads first. Claude Code auto-loads this file
from the repo root into context for every stage agent (parse, spec,
implement, review, test, QA...). It carries the static facts that never
change between tickets, so we don't have to repeat them in every prompt.
-->

## Project

Swing Trading App: a paper-trading / backtest engine. It simulates a swing
trading strategy against historical daily price bars. No live broker
connection, no real money, no financial advice — this is an SDLC practice
sandbox with a genuinely rich domain (position sizing, stop-losses, P&L,
risk limits).

## Stack

- TypeScript, run via `tsx` (no separate build step during development)
- Node.js

## Conventions

- Pure functions for anything that touches money math (sizing, P&L,
  R-multiples) so they stay trivially testable.
- No look-ahead bias: a decision made using a bar's close must not be
  filled at that same close.
- Files are the handoff protocol between pipeline stages. Agents read and
  write plain files under `tickets/`, `specs/` (`reviews/`, `qa/` arrive as
  the stages that use them come online).

## Pipeline

This repo is built by its own AI-SDLC pipeline (`pipeline/run.ts`). Each
feature ticket moves through stages (parse, spec, implement, review, test,
QA, deploy). Stage behavior (auto / approve / manual) is controlled by
`sdlc.config.json`. See `agents/*.md` for each stage's role prompt.
