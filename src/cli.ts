/**
 * Standalone CLI so the same explainer works outside the editor: from any
 * terminal, a shell alias, or a system-wide hotkey (see system/).
 *
 *   explain-this                 # explains the clipboard contents
 *   explain-this < file.ts       # explains stdin
 *   explain-this --html          # writes a rendered HTML page to a temp file and prints its path
 *   explain-this --bubble        # shows a floating Liquid Glass bubble at the cursor (macOS)
 *   explain-this --style eli5 --effort low --model claude-opus-5
 *
 * API key: ANTHROPIC_API_KEY, or ~/.config/explain-this/api-key, or an `ant auth login` profile.
 */
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import { streamExplanation, describeError, isMissingCredentials, Effort } from "./client";
import { buildSystemPrompt, buildUserMessage, Style } from "./prompt";
import { BubbleSurface, bubbleAvailable } from "./bubble";

interface Args {
  html: boolean;
  open: boolean;
  bubble: boolean;
  style: Style;
  effort: Effort;
  model: string;
  source: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { html: false, open: false, bubble: false, style: "plain", effort: "medium", model: "claude-opus-5", source: "clipboard" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--html") args.html = true;
    else if (a === "--open") { args.html = true; args.open = true; }
    else if (a === "--bubble") args.bubble = true;
    else if (a === "--style") args.style = next() as Style;
    else if (a === "--effort") args.effort = next() as Effort;
    else if (a === "--model") args.model = next();
    else if (a === "--source") args.source = next();
    else if (a === "-h" || a === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
  }
  return args;
}

function usage(): string {
  return [
    "explain-this: explain selected code or terminal output with Claude.",
    "",
    "  explain-this [--style plain|concise|detailed|eli5] [--effort low|medium|high|xhigh|max]",
    "               [--model ID] [--source LABEL] [--html] [--open] [--bubble]",
    "",
    "Reads stdin if piped, otherwise the clipboard. --html renders Markdown to a temp",
    "HTML file and prints its path; --open also opens it in the default browser.",
    "--bubble shows a floating glass bubble at the mouse cursor with follow-ups (macOS).",
    "",
  ].join("\n");
}

async function readInput(): Promise<{ text: string; source: string }> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim()) {
      return { text, source: "stdin" };
    }
  }
  if (process.platform === "darwin") {
    return { text: execFileSync("pbpaste", { encoding: "utf8" }), source: "clipboard" };
  }
  if (process.platform === "linux") {
    for (const [cmd, cmdArgs] of [["wl-paste", []], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]] as const) {
      try {
        return { text: execFileSync(cmd, [...cmdArgs], { encoding: "utf8" }), source: "clipboard" };
      } catch {
        /* try the next tool */
      }
    }
  }
  if (process.platform === "win32") {
    return { text: execFileSync("powershell", ["-command", "Get-Clipboard"], { encoding: "utf8" }), source: "clipboard" };
  }
  return { text: "", source: "clipboard" };
}

function makeClient(): Anthropic {
  const keyFile = join(homedir(), ".config", "explain-this", "api-key");
  if (!process.env.ANTHROPIC_API_KEY && existsSync(keyFile)) {
    return new Anthropic({ apiKey: readFileSync(keyFile, "utf8").trim() });
  }
  return new Anthropic();
}

function htmlPage(title: string, selected: string, bodyHtml: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#1f2328;background:#fff}
  @media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}pre,code{background:#161b22!important}details{border-color:#30363d}}
  h1{font-size:14px;color:#6e7781;font-weight:600;margin:0 0 12px}
  details{border:1px solid #d0d7de;border-radius:6px;padding:6px 10px;margin-bottom:18px}
  summary{cursor:pointer;color:#6e7781;font-size:13px}
  pre{background:#f6f8fa;padding:10px;border-radius:6px;overflow:auto;white-space:pre-wrap;font-size:13px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;padding:1px 4px;border-radius:3px;font-size:.92em}
  pre code{background:none;padding:0}
</style></head><body><h1>${esc(title)}</h1>
<details><summary>Selected text</summary><pre>${esc(selected)}</pre></details>
<main>${bodyHtml}</main></body></html>`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { text, source } = await readInput();
  if (!text.trim()) {
    process.stderr.write("Nothing to explain: stdin was empty and the clipboard has no text.\n");
    process.exit(2);
  }

  const label = args.source !== "clipboard" ? args.source : source;
  const userMessage = buildUserMessage({ selected: text, source: label, language: "unknown (selected outside the editor)" });

  const client = makeClient();
  const system = buildSystemPrompt(args.style, "");

  if (args.bubble) {
    const binary = join(__dirname, "..", "bin", "ExplainBubble");
    if (!bubbleAvailable(binary)) {
      process.stderr.write("The bubble is macOS-only and needs bin/ExplainBubble (run: npm run build:bubble).\n");
      process.exit(5);
    }
    await runBubble(client, binary, args, label, text, userMessage, system);
    return;
  }

  try {
    const result = await streamExplanation({
      client,
      model: args.model,
      effort: args.effort,
      system,
      messages: [{ role: "user", content: userMessage }],
      signal: new AbortController().signal,
      onText: (delta) => {
        if (!args.html) process.stdout.write(delta);
      },
    });

    if (result.stopReason === "refusal") {
      process.stderr.write(`Claude declined to answer${result.refusalExplanation ? `: ${result.refusalExplanation}` : "."}\n`);
      process.exit(4);
    }

    if (args.html) {
      const page = htmlPage(`Explain This: ${label}`, text, marked.parse(result.text, { async: false }) as string);
      const file = join(tmpdir(), `explain-this-${Date.now()}.html`);
      writeFileSync(file, page);
      process.stdout.write(file + "\n");
      if (args.open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const openArgs = process.platform === "win32" ? ["/c", "start", "", file] : [file];
        execFileSync(opener, openArgs);
      }
    } else {
      process.stdout.write("\n");
    }
  } catch (err) {
    exitWithError(err);
  }
}

function exitWithError(err: unknown): never {
  if (isMissingCredentials(err)) {
    process.stderr.write("No Anthropic credentials. Set ANTHROPIC_API_KEY or write your key to ~/.config/explain-this/api-key.\n");
    process.exit(3);
  }
  process.stderr.write(`${describeError(err).message}\n`);
  process.exit(1);
}

/** Bubble mode: stream into the floating window and keep answering follow-ups until it closes. */
async function runBubble(
  client: Anthropic,
  binary: string,
  args: Args,
  label: string,
  selected: string,
  userMessage: string,
  system: string,
): Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const surface = new BubbleSurface(binary, label, selected, (event) => {
    if (event.type === "closed") {
      resolveClosed();
    } else {
      queue = queue.then(() => turn(event.text));
    }
  });

  const turn = async (question?: string): Promise<void> => {
    if (!surface.isOpen) return;
    if (question) surface.conversation.history.push({ role: "user", content: question });
    const abort = new AbortController();
    surface.conversation.abort = abort;
    const target = surface.beginAssistantTurn();
    try {
      const result = await streamExplanation({
        client,
        model: args.model,
        effort: args.effort,
        system,
        messages: surface.conversation.history,
        signal: abort.signal,
        onText: (delta) => target.append(delta),
      });
      if (result.stopReason === "refusal") {
        surface.conversation.history.pop();
        target.fail(`Claude declined to answer${result.refusalExplanation ? `: ${result.refusalExplanation}` : "."}`);
        return;
      }
      const text = result.text.trim() || "(empty response)";
      surface.conversation.history.push({ role: "assistant", content: text });
      surface.conversation.lastExplanation = text;
      target.finish(text, result.servedBy !== args.model ? `via ${result.servedBy}` : undefined);
    } catch (err) {
      surface.conversation.history.pop();
      if (abort.signal.aborted) return;
      const info = describeError(err);
      target.fail(info.missingKey ? "No Anthropic API key. Put it in ~/.config/explain-this/api-key." : info.message);
    } finally {
      surface.conversation.abort = undefined;
    }
  };

  surface.conversation.history.push({ role: "user", content: userMessage });
  queue = turn();
  await closed;
}

void main();
