// WHAT THIS FILE IS:
// The orchestrator. The small program that ties everything together for
// Session 1: read the config, read the ticket, call the parse agent
// (Claude Code, headless), show you the result, wait for your y/n, and
// save. Every run appends one line to runlog.jsonl so there's a record.
//
// Usage:
//   npm run sdlc run 001

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

// Builds the prompt a stage agent sees: shared project context, its role
// description (from roleFile), the input it's working on, and — if a
// prior attempt was rejected — the rejected output plus the reviewer's
// feedback, so the agent revises instead of starting over blind.
//
// The trailing directive matters: without it, a headless Claude Code
// session sometimes treats this whole blob as passive background context
// (it auto-loads repo/git state regardless) and responds with a chatty
// "here's what I see in your repo, what would you like me to do?" instead
// of just doing the stage's job. An explicit "produce your output now, no
// questions, no preamble" instruction reliably prevents that.
function buildPrompt(roleFile: string, input: string, retry?: RetryContext): string {
  const projectContext = readFileSync("CLAUDE.md", "utf8");
  const roleDescription = readFileSync(roleFile, "utf8");
  const sections = [projectContext, roleDescription, "## Input", input];

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

  sections.push(
    "Now produce your output for the Input above, per the role instructions. " +
      "Respond with ONLY the required markdown deliverable — no questions, " +
      "no summary of repository state, no preamble."
  );

  return sections.join("\n\n---\n\n");
}

// Invokes Claude Code headlessly and returns its text output.
//
// The prompt travels over stdin rather than as a CLI argument: on Windows,
// npm installs "claude" as a .cmd shim, and cmd.exe re-parses argv, which
// mangles long/multiline text. Stdin sidesteps that and works the same on
// every platform. Because the only argv content is the static flags below
// (no untrusted data), it's safe to pass shell: true, which Windows also
// requires to launch .cmd files directly (Node refuses without it).
//
// allowedTools scopes what the agent can touch — e.g. the spec stage is
// read-only, so it's invoked with allowedTools: ["Read"], matching the
// "read-only agent" permission scoping described for parse/spec/review.
function callAgent(prompt: string, opts?: { allowedTools?: string[] }): string {
  const claudeCommand = process.platform === "win32" ? "claude.cmd" : "claude";
  const args = opts?.allowedTools
    ? ["--allowedTools", opts.allowedTools.join(","), "-p"]
    : ["-p"];
  const result = spawnSync(claudeCommand, args, {
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

type StageOptions = {
  stage: string;
  ticketId: string;
  mode: StageMode;
  roleFile: string;
  getInput: () => string;
  onApprove: (output: string) => void;
  allowedTools?: string[];
};

// Generic stage runner: build the prompt, call the agent, show the
// output, and (in "approve" mode) wait for a human decision. On approval,
// hands the output to the stage's onApprove callback to save wherever
// that stage's artifact belongs. On rejection, asks what should change,
// logs the rejection with that feedback, then re-runs this same stage
// with the rejected output and the feedback folded into the prompt so
// the agent revises instead of guessing again from scratch. Keeps
// looping until the human approves. "auto" mode skips the pause entirely
// since there's no human to ask.
async function runStage(opts: StageOptions, retry?: RetryContext): Promise<void> {
  const startedAt = Date.now();
  const input = opts.getInput();
  const prompt = buildPrompt(opts.roleFile, input, retry);

  console.log(`\nRunning ${opts.stage} agent on ticket ${opts.ticketId}...\n`);
  const output = callAgent(prompt, { allowedTools: opts.allowedTools });

  console.log(`----- ${opts.stage} agent output -----\n`);
  console.log(output);
  console.log("\n-------------------------------\n");

  const save = () => {
    opts.onApprove(output);
    console.log(`Saved (${opts.stage}).`);
    logRun({
      stage: opts.stage,
      ticket: opts.ticketId,
      mode: opts.mode,
      durationMs: Date.now() - startedAt,
      approved: true,
    });
  };

  if (opts.mode !== "approve") {
    save();
    return;
  }

  const approved = await confirm("Approve this output?");
  if (approved) {
    save();
    return;
  }

  const feedback = await promptText("What should change?");
  logRun({
    stage: opts.stage,
    ticket: opts.ticketId,
    mode: opts.mode,
    durationMs: Date.now() - startedAt,
    approved: false,
    feedback,
  });

  console.log(`\nRe-running ${opts.stage} agent with your feedback...\n`);
  await runStage(opts, { priorAttempt: output, feedback });
}

function runStageParse(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "parse",
    ticketId,
    mode,
    roleFile: "agents/parse.md",
    getInput: () => readTicket(ticketId),
    onApprove: (output) => appendFileSync(`tickets/${ticketId}.md`, "\n" + output + "\n"),
  });
}

function writeSpec(ticketId: string, output: string): void {
  mkdirSync("specs", { recursive: true });
  writeFileSync(`specs/${ticketId}.md`, output);
}

function runStageSpec(ticketId: string, mode: StageMode): Promise<void> {
  return runStage({
    stage: "spec",
    ticketId,
    mode,
    roleFile: "agents/spec.md",
    // The ticket now includes the parse stage's approved criteria, which
    // is exactly what the spec agent needs to work from.
    getInput: () => readTicket(ticketId),
    allowedTools: ["Read"],
    onApprove: (output) => writeSpec(ticketId, output),
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

  const specStage = config.stages.spec;
  if (specStage) {
    await runStageSpec(ticketId, specStage.mode);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
