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
type RetryContext = { priorAttempt: string; feedback: string };

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
// role description, the raw ticket it needs to clean up, and — if a prior
// attempt was rejected — the rejected output plus the reviewer's feedback,
// so the agent revises instead of starting over blind.
function buildParsePrompt(ticketText: string, retry?: RetryContext): string {
  const projectContext = readFileSync("CLAUDE.md", "utf8");
  const roleDescription = readFileSync("agents/parse.md", "utf8");
  const sections = [projectContext, roleDescription, "## Ticket to parse", ticketText];

  if (retry) {
    sections.push(
      [
        "## Your previous attempt was rejected",
        `Reviewer feedback: ${retry.feedback}`,
        "",
        "Previous output:",
        retry.priorAttempt,
        "",
        "Produce a revised version addressing the feedback.",
      ].join("\n")
    );
  }

  return sections.join("\n\n---\n\n");
}

// Invokes Claude Code headlessly and returns its text output.
//
// The prompt travels over stdin rather than as a CLI argument: on Windows,
// npm installs "claude" as a .cmd shim, and cmd.exe re-parses argv, which
// mangles long/multiline text. Stdin sidesteps that and works the same on
// every platform. Because the only argv content is the static "-p" flag
// (no untrusted data), it's safe to pass shell: true, which Windows also
// requires to launch .cmd files directly (Node refuses without it).
function runParseAgent(prompt: string): string {
  const claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  const result = spawnSync(claudeCommand, ["-p"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
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

async function promptText(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} `);
  rl.close();
  return answer.trim();
}

function logRun(entry: Record<string, unknown>): void {
  appendFileSync("runlog.jsonl", JSON.stringify(entry) + "\n");
}

// Runs the parse stage, and if the mode is "approve" and the human rejects
// the output, loops: ask what should change, log the rejection with that
// feedback, then re-run the same stage with the rejected output and the
// feedback folded into the prompt so the agent revises instead of guessing
// again from scratch. Keeps looping until the human approves.
async function runStageParse(
  ticketId: string,
  mode: StageMode,
  retry?: RetryContext
): Promise<void> {
  const startedAt = Date.now();
  const ticketText = readTicket(ticketId);
  const prompt = buildParsePrompt(ticketText, retry);

  console.log(`\nRunning parse agent on ticket ${ticketId}...\n`);
  const output = runParseAgent(prompt);

  console.log("----- Parse agent output -----\n");
  console.log(output);
  console.log("\n-------------------------------\n");

  if (mode !== "approve") {
    appendFileSync(`tickets/${ticketId}.md`, "\n" + output + "\n");
    console.log(`Saved to tickets/${ticketId}.md`);
    logRun({
      stage: "parse",
      ticket: ticketId,
      mode,
      durationMs: Date.now() - startedAt,
      approved: true,
    });
    return;
  }

  const approved = await confirm("Approve this output?");

  if (approved) {
    appendFileSync(`tickets/${ticketId}.md`, "\n" + output + "\n");
    console.log(`Saved to tickets/${ticketId}.md`);
    logRun({
      stage: "parse",
      ticket: ticketId,
      mode,
      durationMs: Date.now() - startedAt,
      approved: true,
    });
    return;
  }

  const feedback = await promptText("What should change?");
  logRun({
    stage: "parse",
    ticket: ticketId,
    mode,
    durationMs: Date.now() - startedAt,
    approved: false,
    feedback,
  });

  console.log("\nRe-running parse agent with your feedback...\n");
  await runStageParse(ticketId, mode, { priorAttempt: output, feedback });
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
