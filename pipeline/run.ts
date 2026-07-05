// WHAT THIS FILE IS:
// The orchestrator. The small program that ties everything together for
// Session 1: read the config, read the ticket, call the parse agent
// (Claude Code, headless), show you the result, wait for your y/n, and
// save. Every run appends one line to runlog.jsonl so there's a record.
//
// Usage:
//   npm run sdlc run 001

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

type StageMode = "manual" | "approve" | "auto";
type Config = { stages: Record<string, { mode: StageMode }> };

function readConfig(): Config {
  return JSON.parse(readFileSync("sdlc.config.json", "utf8"));
}

function readTicket(id: string): string {
  const path = `tickets/${id}.md`;
  if (!existsSync(path)) {
    throw new Error(`No ticket found at ${path}`);
  }
  return readFileSync(path, "utf8");
}

// Builds the prompt the parse agent sees: shared project context, its
// role description, then the raw ticket it needs to clean up.
function buildParsePrompt(ticketText: string): string {
  const projectContext = readFileSync("CLAUDE.md", "utf8");
  const roleDescription = readFileSync("agents/parse.md", "utf8");
  return [
    projectContext,
    roleDescription,
    "## Ticket to parse",
    ticketText,
  ].join("\n\n---\n\n");
}

// Invokes Claude Code headlessly and returns its text output.
function runParseAgent(prompt: string): string {
  const result = spawnSync("claude", ["-p", prompt], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Failed to invoke claude CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`claude CLI exited with code ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} (y/n) `);
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

function logRun(entry: Record<string, unknown>): void {
  appendFileSync("runlog.jsonl", JSON.stringify(entry) + "\n");
}

async function runStageParse(ticketId: string, mode: StageMode): Promise<void> {
  const startedAt = Date.now();
  const ticketText = readTicket(ticketId);
  const prompt = buildParsePrompt(ticketText);

  console.log(`\nRunning parse agent on ticket ${ticketId}...\n`);
  const output = runParseAgent(prompt);

  console.log("----- Parse agent output -----\n");
  console.log(output);
  console.log("\n-------------------------------\n");

  let approved = true;
  if (mode === "approve") {
    approved = await confirm("Append this to the ticket?");
  }

  if (approved) {
    appendFileSync(`tickets/${ticketId}.md`, "\n" + output + "\n");
    console.log(`Saved to tickets/${ticketId}.md`);
  } else {
    console.log("Discarded. Ticket file left unchanged.");
  }

  logRun({
    stage: "parse",
    ticket: ticketId,
    mode,
    durationMs: Date.now() - startedAt,
    approved,
  });
}

async function main(): Promise<void> {
  const [command, ticketId] = process.argv.slice(2);

  if (command !== "run" || !ticketId) {
    console.error("Usage: npm run sdlc run <ticketId>");
    process.exit(1);
  }

  const config = readConfig();
  const parseStage = config.stages.parse;
  if (!parseStage) {
    throw new Error("sdlc.config.json is missing a 'parse' stage entry");
  }

  await runStageParse(ticketId, parseStage.mode);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
