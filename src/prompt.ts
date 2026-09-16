/** 1 = plainest English, 10 = most technical. */
export const DEFAULT_LEVEL = 3;

export function clampLevel(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : DEFAULT_LEVEL;
}

function levelGuide(level: number): string {
  const n = clampLevel(level);
  const scale = `Technicality level: ${n} on a scale of 1 (plainest English, for someone who has never coded) to 10 (dense, expert-level).`;
  if (n === 1) {
    return `${scale} As plain as it gets. The reader has never written code and does not want to. Use only everyday words: no technical terms, no names from the code. Say what it does and why anyone would want it, with one simple real-world analogy. Two or three short sentences, nothing more.`;
  }
  if (n <= 3) {
    return `${scale} The reader is smart but does not write code. Plain language and short sentences. Avoid jargon; if a technical word is unavoidable, say what it means in a few words the first time. An everyday analogy is welcome when it makes things click. Mention a name from the code only when the reader has to recognise it. Under 120 words.`;
  }
  if (n <= 5) {
    return `${scale} The reader is a beginner programmer or new to this codebase. Everyday language, but basic programming words (function, variable, loop, request, state) can be used freely; briefly define anything beyond that. Name the key identifiers so they can find things. Explain what it does first, then how. Under 160 words.`;
  }
  if (n <= 7) {
    return `${scale} The reader is a working developer. Use standard programming and framework terminology without defining it. Cover what it does, how it works, and anything non-obvious or risky. Be concise: a one-sentence summary, then a few bullets. Under 180 words.`;
  }
  if (n <= 9) {
    return `${scale} The reader is a senior engineer fluent in this language and framework. Be precise and dense; skip the basics entirely. Focus on design intent, edge cases, failure modes, performance and correctness concerns, and anything subtle. Under 220 words.`;
  }
  return `${scale} The reader is an expert. Maximum density, no hand-holding, never restate the obvious. Call out subtle semantics, invariants, ordering and concurrency concerns, complexity, and footguns, using exact terminology. Bullets preferred. Under 220 words.`;
}

/**
 * The system prompt is static for a given level (no timestamps, no file names) so
 * it can be prompt-cached across requests. Per-request details go in the user turn.
 */
export function buildSystemPrompt(level: number, extra: string): string {
  const base = [
    "You are an expert software engineer explaining things inline inside a developer's editor, the way a senior colleague would answer 'what does this mean?' over your shoulder.",
    "The user highlighted some text. It is usually source code, but it may also be terminal output: a stack trace, compiler error, log lines, a shell command, or output from an AI coding agent (Claude Code, Codex, Amp, Cursor and similar).",
    "For code: explain what it does, how it works, why it might be written this way, and any non-obvious behaviour, pitfalls, or bugs you notice, at the depth the technicality level calls for.",
    "For errors, logs, or command output: explain what it means, the likely cause, and the concrete next step to fix or investigate it.",
    "Surrounding context, when provided, is only there to help you understand the highlighted text. Do not explain the rest of it. Refer to it only when it clarifies the selection (for example, what a called helper does).",
    "Write in GitHub-flavoured Markdown. Do not use headings. Use inline code formatting for identifiers, paths, and commands when you mention them. Only include code blocks when a tiny snippet makes something clearer; never echo the selection back.",
    "Do not open with filler like 'This code' or 'Sure'. Start directly with the substance.",
    levelGuide(level),
  ];
  if (extra.trim()) {
    base.push(`Additional instructions from the user: ${extra.trim()}`);
  }
  return base.join("\n\n");
}

export interface SelectionInput {
  /** Highlighted text. */
  selected: string;
  /** Where it came from, e.g. "src/app.ts" or "terminal: zsh". */
  source: string;
  /** Language ID, shell name, or similar. */
  language: string;
  /** 1-based lines of the selection when it came from a document. */
  startLine?: number;
  endLine?: number;
  /** Optional surrounding text. */
  context?: { label: string; text: string; startsAtLine?: number };
}

/** Builds the user turn sent to the model. Pure: no editor dependencies, shared by the CLI. */
export function buildUserMessage(input: SelectionInput): string {
  const lines = [`Source: ${input.source}`, `Kind: ${input.language}`];
  if (input.startLine !== undefined && input.endLine !== undefined) {
    lines.push(`Selected lines: ${input.startLine}-${input.endLine}`);
  }
  lines.push("", "<selection>", input.selected, "</selection>");
  if (input.context) {
    const at = input.context.startsAtLine !== undefined ? ` starts_at_line="${input.context.startsAtLine}"` : "";
    lines.push("", `<context label="${input.context.label}"${at}>`, input.context.text, "</context>");
  }
  lines.push("", "Explain the text inside <selection>.");
  return lines.join("\n");
}
