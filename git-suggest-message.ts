#!/usr/bin/env -S deno run --allow-all

/**
 * git-suggest-message
 *
 * A git subcommand that uses an LLM to draft a commit message from a staged diff.
 *
 * Usage:
 *   git suggest-message
 *   git suggest-message --commit
 *   git suggest-message --commit --edit
 *   git suggest-message --commit --yes
 *
 * Env:
 * - MINIMAX_CP_KEY (required)
 * - MINIMAX_ENDPOINT (optional; default: https://api.minimax.io/anthropic/v1/messages)
 * - MINIMAX_MODEL (optional; default: MiniMax-M2.1)
 */

interface Args {
  commit: boolean;
  edit: boolean;
  yes: boolean;
  debug: boolean;
  help: boolean;
}

let spinner: AbortController | null = null;

// Parse arguments
function parseArgs(): Args {
  const args = Deno.args;
  const result: Args = {
    commit: false,
    edit: false,
    yes: false,
    debug: false,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--commit":
        result.commit = true;
        i++;
        break;
      case "--edit":
        result.edit = true;
        i++;
        break;
      case "--yes":
        result.yes = true;
        i++;
        break;
      case "--debug":
        result.debug = true;
        i++;
        break;
      case "--help":
      case "-h":
        result.help = true;
        i++;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        Deno.exit(2);
    }
  }

  if (result.edit) result.commit = true;
  if (result.yes) result.commit = true;

  return result;
}

// Show usage
function showHelp(): void {
  console.log(`git suggest-message

Draft a commit message using an LLM from a staged diff (or stdin).

USAGE:
  git suggest-message
  git suggest-message --commit
  git suggest-message --commit --edit
  git suggest-message --commit --yes

FLAGS:
  --commit   Commit with the suggested message (after confirmation unless --yes)
  --edit     Open editor before finalizing commit (implies --commit)
  --yes      Skip confirmation prompt (implies --commit)
  --debug    Print extra debug info to stderr
  -h,--help  Show help`);
}

// Check if stdin is a TTY
function isStdinTTY(): boolean {
  return Deno.isatty(Deno.stdin.rid);
}

// Run git command
async function runGit(...args: string[]): Promise<string> {
  const proc = new Deno.Command("git", { args, stdout: "piped", stderr: "piped" });
  const output = await proc.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`git ${args.join(" ")} failed: ${err}`);
  }
  return new TextDecoder().decode(output.stdout);
}

// Parse unified diff by file - returns list of filenames
function parseDiffFiles(diffText: string): string[] {
  const files: string[] = [];
  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git a/")) {
      const match = line.match(/diff --git a\/.* b\/(.+?)(\s|$)/);
      if (match) {
        files.push(match[1]);
      }
    }
  }
  return files;
}

// Get diff content for a specific file
function getFileDiff(diffText: string, targetFile: string): string {
  const lines = diffText.split("\n");
  let inFile = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git a/")) {
      const match = line.match(/diff --git a\/.* b\/(.+?)(\s|$)/);
      if (match) {
        const currentFile = match[1];
        inFile = currentFile === targetFile;
      }
    }
    if (inFile) {
      result.push(line);
    }
  }

  return result.join("\n");
}

// Pick CONTINUITY.md key from file list
function pickContinuityKey(files: string[]): string {
  for (const f of files) {
    if (f === "CONTINUITY.md") return f;
  }
  for (const f of files) {
    if (f.endsWith("/CONTINUITY.md") || f.includes("//CONTINUITY.md")) return f;
  }
  return "";
}

// Extract added Done bullets from CONTINUITY.md diff
function extractAddedDoneBullets(continuityDiff: string): string[] {
  const lines = continuityDiff.split("\n");
  let inDone = false;
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    // Skip diff metadata lines
    if (
      rawLine.startsWith("diff --git") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("+++") ||
      rawLine.startsWith("@@")
    ) {
      continue;
    }

    let normalized = rawLine.replace(/^ /, "").replace(/^-/, "").replace(/^\+/, "");

    if (normalized.startsWith("Done")) {
      inDone = true;
      continue;
    }
    if (normalized.startsWith("Now")) {
      inDone = false;
      continue;
    }

    if (inDone && rawLine.startsWith("+  - ")) {
      const bullet = rawLine.replace("+  - ", "").trim();
      if (!seen.has(bullet)) {
        seen.add(bullet);
        result.push(bullet);
      }
    }
  }

  return result;
}

// Build prompt for LLM
function buildPrompt(
  rawDiff: string,
  continuityDiff: string,
  continuityBullets: string[],
  changedFiles: string[],
  nonContinuityDiff: string
): string {
  const doneBulletsBlock = continuityBullets.length > 0
    ? continuityBullets.map((b) => `- ${b}`).join("\n")
    : "(none detected)";

  const continuityBlock = continuityDiff || "(CONTINUITY.md diff not present in this input)";

  const filesBlock = changedFiles.length > 0
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "(none detected)";

  const nonContinuityBlock = nonContinuityDiff || "(none)";

  const rawDiffBlock = rawDiff || "(empty)";

  return `You are the commit-message writer for this repository.

Task:
- Suggest a high-quality git commit message based on the staged diff.
- IMPORTANT: Do NOT do code review. Do NOT judge quality/correctness. Only describe intent, scope, and rationale.

Output format:
- Line 1: Conventional Commits subject (e.g. feat(ui): ..., fix(api): ..., refactor: ...)
- Body: at most 7 lines, using this structure:
  Why:
  - ...
  What:
  - ...
  Notes:
  - ... (optional)

Selection rules:
- If CONTINUITY.md "Done:" gained new bullet(s), prioritize those as the source of truth for What (and often the subject).
- Use changed file paths to infer scope (ui/api/workflows/lib/app/etc).
- If multiple distinct changes exist, either:
  - suggest splitting commits (1 line), OR
  - pick the dominant theme and mention the rest briefly in Notes.

Context extracted:
[Changed files]
${filesBlock}

[CONTINUITY.md Done bullets added]
${doneBulletsBlock}

[CONTINUITY.md diff]
${continuityBlock}

[Non-CONTINUITY diffs]
${nonContinuityBlock}

[Raw diff (full)]
${rawDiffBlock}`;
}

// Spinner for API call
function startSpinner(message: string): void {
  const frames = ["⠾", "⠽", "⠻", "⠧", "⠟", "⠯", "⠷"];
  let i = 0;

  spinner = new AbortController();
  const { signal } = spinner;

  (async () => {
    try {
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!signal.aborted) {
          const buf = new TextEncoder().encode(`\r${frames[i]}${message}`);
          await Deno.stderr.write(buf);
          i = (i + 1) % frames.length;
        }
      }
    } catch {
      // Ignore errors when aborted
    }
  })();
}

function stopSpinner(): void {
  if (spinner) {
    spinner.abort();
    spinner = null;
    const buf = new TextEncoder().encode(`\r${" ".repeat(40)}\r`);
    Deno.stderr.writeSync(buf);
  }
}

// Call MiniMax API
async function callMinimax(content: string, debug: boolean): Promise<string> {
  const endpoint = Deno.env.get("MINIMAX_ENDPOINT") || "https://api.minimax.io/anthropic/v1/messages";
  const model = Deno.env.get("MINIMAX_MODEL") || "MiniMax-M2.1";
  const apiKey = Deno.env.get("MINIMAX_CP_KEY") || "";

  if (!apiKey) {
    console.error("Missing MINIMAX_CP_KEY env var.");
    Deno.exit(1);
  }

  if (debug) {
    console.error(`[debug] endpoint=${endpoint} model=${model}`);
  }

  startSpinner(" Calling API...");

  try {
    const payload = {
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content }],
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (data.error) {
      console.error(`API error: ${data.error.message || "Unknown error"}`);
      Deno.exit(1);
    }

    const textContent = data.content?.find((c: { type: string }) => c.type === "text");
    return textContent?.text || "";
  } finally {
    stopSpinner();
  }
}

// Confirmation prompt
async function confirm(prompt: string): Promise<boolean> {
  const buf = new TextEncoder().encode(`\n${prompt}`);
  await Deno.stderr.write(buf);

  const input = new Uint8Array(1024);
  const n = await Deno.stdin.read(input);
  if (n === null) return false;

  const response = new TextDecoder().decode(input.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// Commit with message
async function gitCommitWithMessage(message: string, edit: boolean): Promise<void> {
  const args = edit ? ["commit", "-e", "-F", "-"] : ["commit", "-F", "-"];
  const proc = new Deno.Command("git", { args, stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = proc.spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(message));
  writer.releaseLock();
  await child.stdin.close();

  const output = await child.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr);
    throw new Error(`git commit failed: ${err}`);
  }
}

// Setup signal handlers for cleanup
function setupSignalHandlers(): void {
  const handler = () => {
    stopSpinner();
    Deno.exit(130);
  };

  Deno.addSignalListener("SIGINT", handler);
  Deno.addSignalListener("SIGTERM", handler);
}

// Main
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  setupSignalHandlers();

  // 1) Get diff input
  let rawDiff = "";

  if (!isStdinTTY()) {
    const stdinData = new Uint8Array(4096);
    let totalRead = 0;
    let read;
    while ((read = await Deno.stdin.read(stdinData.subarray(totalRead))) !== null) {
      totalRead += read;
    }
    rawDiff = new TextDecoder().decode(stdinData.subarray(0, totalRead)).trim();
  }

  if (!rawDiff) {
    const nameOnly = await runGit("diff", "--cached", "--name-only");
    if (!nameOnly.trim()) {
      console.error("Nothing staged. Stage changes first (git add ...).");
      Deno.exit(1);
    }
    rawDiff = await runGit("diff", "--cached");
  }

  // 2) Parse CONTINUITY.md signals + file list
  const fileKeys = parseDiffFiles(rawDiff);
  const continuityKey = pickContinuityKey(fileKeys);

  let continuityDiff = "";
  if (continuityKey) {
    continuityDiff = getFileDiff(rawDiff, continuityKey);
  }

  let continuityBullets: string[] = [];
  if (continuityDiff) {
    continuityBullets = extractAddedDoneBullets(continuityDiff);
  }

  // Build non-continuity diff
  let nonContinuityDiff = "";
  if (fileKeys.length > 0) {
    const nonContinuityFiles = fileKeys.filter((k) => k !== continuityKey);
    if (nonContinuityFiles.length > 0) {
      nonContinuityDiff = nonContinuityFiles.map((k) => getFileDiff(rawDiff, k)).join("\n\n");
    }
  } else {
    nonContinuityDiff = rawDiff;
  }

  // Build prompt
  const prompt = buildPrompt(
    rawDiff,
    continuityDiff,
    continuityBullets,
    fileKeys,
    nonContinuityDiff
  );

  // 3) Call API
  const suggested = await callMinimax(prompt, args.debug);

  // Print suggestion
  console.log(suggested);

  // 4) Optionally commit
  if (!args.commit) {
    return;
  }

  if (!args.yes) {
    if (!(await confirm("Commit with this message? [y/N] "))) {
      return;
    }
  }

  await gitCommitWithMessage(suggested, args.edit);
}

// Run
main().catch((err) => {
  console.error(err.message);
  Deno.exit(1);
});
