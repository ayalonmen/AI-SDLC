// WHAT THIS FILE IS:
// Deterministic pass/fail checks the orchestrator runs to gate a ticket. No
// model involved, just exit codes and text diffs. This is the actual quality
// guarantee: an agent's own claim that it succeeded is never trusted on its
// own.

import { exec } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// "real-failure" means the code (or its coverage) is wrong — route back to the
// stage that owns the fix. "infra-failure" means the harness itself hiccuped
// (PocketBase never came up, a port was taken, Docker wasn't running) — retry
// the gate, never an agent, since there's no bug to fix. Only E2E can produce
// infra-failure; the other checks are either pass or real-failure.
export type GateKind = "pass" | "real-failure" | "infra-failure";

// Which check produced this result. The QA belt routes a failure to the stage
// that OWNS the fix based on this: a failing test or a NO-SHIP verdict means
// the CODE is wrong -> implement; a coverage gap means a test is MISSING ->
// test. Crucially, a failing test is never routed back to the test agent "to
// make it pass" — that would invite weakening tests to go green.
export type GateSource = "checks" | "e2e" | "coverage" | "verdict";

export type GateResult = {
  passed: boolean;
  output: string;
  kind: GateKind;
  source: GateSource;
};

type ExecResult = { passed: boolean; output: string; killed: boolean };

// A gate command that outlives this has hung — a wedged headless browser, a
// serve that never answers, a readiness poll spinning forever. Without a cap,
// exec() never calls back and the whole orchestrator hangs with no log line
// (exactly the failure that once left a QA run silently stuck). Kill it instead.
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
// exec()'s default stdout+stderr buffer is 1 MB; a full Playwright run can
// exceed that, which errors the command with ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// and looks like a spurious failure. Give it real headroom.
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;

// Runs a declared command string in a given working directory. The command
// comes from the product's .sdlc/product.json (e.g. "npm run build",
// "go build ./..."), so the pipeline never hardcodes a toolchain.
//
// Uses exec() with one command string (not execFile + args + shell) to avoid
// Node's DEP0190, same reasoning as before. The command is declared by the
// product owner in their descriptor, not built from untrusted runtime input.
// `killed` distinguishes "we terminated it (timeout / buffer overflow)" from a
// clean non-zero exit, so callers can classify a hang as infra, not code.
function runCommand(command: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER },
      (err, stdout, stderr) => {
        const killed = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
        const body = (stdout + stderr).trim();
        resolve({
          passed: !err,
          output: killed
            ? `Command was killed after ${COMMAND_TIMEOUT_MS / 1000}s ` +
              `(timed out or exceeded the ${COMMAND_MAX_BUFFER / (1024 * 1024)}MB output buffer).\n${body}`
            : body,
          killed,
        });
      }
    );
  });
}

// Runs the declared check command for every component, in each component's
// directory. Passes only if ALL components pass. Returns the concatenated
// output so a failure feeds back to the agent verbatim. A syntax check
// failure is always a real-failure (broken code); nothing here stands up the
// app, so it can never be an infra-failure.
export async function runChecks(
  workdir: string,
  components: Record<string, { path: string; check: string }>
): Promise<GateResult> {
  const results: string[] = [];
  for (const [name, comp] of Object.entries(components)) {
    const compDir = `${workdir}/${comp.path}`;
    const r = await runCommand(comp.check, compDir);
    results.push(`[${name}] ${comp.check}\n${r.output}`);
    if (!r.passed) {
      return { passed: false, output: results.join("\n\n"), kind: "real-failure", source: "checks" };
    }
  }
  return { passed: true, output: results.join("\n\n"), kind: "pass", source: "checks" };
}

// Runs the product's declared E2E command in the product dir. Distinguishes
// a real test-assertion failure (route back to implement) from an
// infrastructure/setup failure (retry the gate; do NOT blame the code). The
// signal is the "SETUP:" prefix run-e2e.ps1-style scripts throw on
// readiness failure, plus common connection-refused/address-in-use errors —
// see e2e/run-e2e.ps1 in the product repo for the setup side of this
// contract.
export async function runE2E(workdir: string, command: string): Promise<GateResult> {
  const r = await runCommand(command, workdir);
  if (r.passed) return { passed: true, output: r.output, kind: "pass", source: "e2e" };

  // A command we had to kill (hang/timeout) is a harness problem, not a failing
  // assertion — treat it as infra so the gate retries and then escalates to a
  // human, rather than belting a non-bug back to the implement agent.
  const looksLikeInfra = r.killed || /SETUP:|never became ready|ECONNREFUSED|EADDRINUSE/i.test(r.output);
  return {
    passed: false,
    output: r.output,
    kind: looksLikeInfra ? "infra-failure" : "real-failure",
    source: "e2e",
  };
}

// The QA agent (a model) writes the verdict; this function (a dumb script)
// reads it. Determinism at the boundary: a model may produce the judgment,
// but a script decides whether the pipeline proceeds, and it reads a file
// the model was not allowed to write. qa/ lives in the pipeline repo, same
// as every other artifact — artifacts stay here, only build/test commands
// run against the product repo.
export function checkQaVerdict(ticketId: string): GateResult {
  const path = `qa/${ticketId}.md`;
  if (!existsSync(path)) {
    return { passed: false, output: `No QA report at ${path}`, kind: "real-failure", source: "verdict" };
  }
  const md = readFileSync(path, "utf8");
  const hasFail = /\|\s*FAIL\s*\|/i.test(md);
  const saysShip = /Verdict:\s*SHIP/i.test(md);
  const passed = saysShip && !hasFail;
  return {
    passed,
    output: !saysShip ? "No SHIP verdict found" : hasFail ? "QA report has FAIL rows" : "SHIP",
    kind: passed ? "pass" : "real-failure",
    source: "verdict",
  };
}

// Recursively collect files under dir whose name matches the test pattern.
function collectTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.(test|spec)\.[jt]s$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Isolates the ticket's "## Acceptance Criteria" section (any heading level),
// up to the next heading or EOF. The AC-N scan must be scoped to this section:
// scanning the whole ticket would also catch AC-N tokens the parse agent
// writes in prose — e.g. a "Decisions made to resolve ambiguity" note like
// "considered AC-6 but ruled it out" — turning a non-criterion into a phantom
// required criterion that no test can ever cover, deadlocking the gate.
function acceptanceCriteriaSection(ticket: string): string | null {
  const heading = ticket.match(/^#{1,6}[ \t]*Acceptance Criteria.*$/im);
  if (!heading || heading.index === undefined) return null;
  const rest = ticket.slice(heading.index + heading[0].length);
  const nextHeading = rest.match(/^#{1,6}[ \t]+/m);
  return nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest;
}

// AC-N sort key so operator-facing lists read in numeric order (AC-2 before
// AC-10), not lexical order (AC-10 before AC-2).
function byAcNumber(a: string, b: string): number {
  return Number(a.slice(3)) - Number(b.slice(3));
}

// A COVERS tag only counts if it sits on a LIVE test. A tag left on a skipped
// or TODO'd test would otherwise let coverage certify a criterion that never
// actually runs (a skipped test doesn't fail E2E either) — an easy way to make
// the gate green by weakening a test rather than satisfying the criterion.
// This is a deliberately conservative, parser-free heuristic: it catches the
// common vectors (`.skip`/`.fixme`/`x`-prefixed test declarations near the
// tag, and TODO/FIXME on the tag line itself). It does NOT catch a fully
// commented-out block whose tag lingers — that residual is what the review
// stage and the human escalation are for. It only ever WITHHOLDS credit, so
// it can never cause a false pass; at worst it forces a real re-tag.
const SKIP_MARKER =
  /\b(?:x(?:it|test|describe|context)|(?:it|test|describe|context)\s*\.\s*(?:skip|fixme|todo))\b/i;
const META_MARKER = /\b(?:TODO|FIXME|XXX)\b/i;

// Deterministic coverage gate. Reads the acceptance-criteria IDs from the
// ticket's Acceptance Criteria section (AC-N, assigned by parse) and the
// COVERS: tags from the product's test files (written by test). Passes only if
// every criterion is covered by at least one live test. The model produces the
// criteria and the tags; this dumb script decides whether coverage is complete
// — the same determinism boundary as checkQaVerdict. The ticket is read
// pipeline-relative (tickets/<id>.md); testDir is in the PRODUCT repo.
export function checkCoverage(ticketId: string, testDir: string): GateResult {
  const ticketPath = `tickets/${ticketId}.md`;
  if (!existsSync(ticketPath)) {
    return { passed: false, output: `No ticket at ${ticketPath}`, kind: "real-failure", source: "coverage" };
  }
  const ticket = readFileSync(ticketPath, "utf8");

  const section = acceptanceCriteriaSection(ticket);
  if (section === null) {
    return {
      passed: false,
      output: `No "## Acceptance Criteria" section found in ${ticketPath}. Parse must produce one.`,
      kind: "real-failure",
      source: "coverage",
    };
  }

  // Acceptance criteria the parse agent assigned, e.g. "AC-3: ...".
  const criteria = new Set<string>();
  for (const m of section.matchAll(/\bAC-(\d+)\b/gi)) criteria.add(`AC-${m[1]}`);

  if (criteria.size === 0) {
    return {
      passed: false,
      output:
        `No acceptance criteria (AC-N) found in the Acceptance Criteria section of ${ticketPath}. ` +
        `Parse must assign each criterion a stable AC-N ID.`,
      kind: "real-failure",
      source: "coverage",
    };
  }

  // Every AC-N mentioned in a COVERS: tag across the product's test files —
  // split into those on live tests (count) vs skipped/TODO tests (don't count,
  // but remembered so the failure message can say WHY they don't count).
  const covered = new Set<string>();
  const skippedOnly = new Set<string>();
  const files = collectTestFiles(testDir);
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const tag = lines[i].match(/COVERS:\s*(.+)/i);
      if (!tag) continue;
      const acs = [...tag[1].matchAll(/\bAC-(\d+)\b/gi)].map((m) => `AC-${m[1]}`);
      if (acs.length === 0) continue;
      // Look at the tag line plus a small window (tags usually sit just above
      // the test they annotate, or inline on the test line) to judge liveness.
      const windowText = lines.slice(Math.max(0, i - 1), i + 4).join("\n");
      const live = !SKIP_MARKER.test(windowText) && !META_MARKER.test(lines[i]);
      for (const ac of acs) (live ? covered : skippedOnly).add(ac);
    }
  }

  const missing = [...criteria].filter((c) => !covered.has(c));
  if (missing.length > 0) {
    const noTest = missing.filter((c) => !skippedOnly.has(c)).sort(byAcNumber);
    const skipped = missing.filter((c) => skippedOnly.has(c)).sort(byAcNumber);
    const parts: string[] = [];
    if (noTest.length) parts.push(`no covering test: ${noTest.join(", ")}`);
    if (skipped.length) parts.push(`tagged only on skipped/TODO tests (does not count): ${skipped.join(", ")}`);
    return {
      passed: false,
      output:
        `Uncovered acceptance criteria — ${parts.join("; ")}. ` +
        `Scanned ${files.length} test file(s) under ${testDir}. ` +
        `Each criterion needs a LIVE (non-skipped) test tagged "// COVERS: <AC-N>".`,
      kind: "real-failure",
      source: "coverage",
    };
  }

  return { passed: true, output: `All ${criteria.size} criteria covered.`, kind: "pass", source: "coverage" };
}
