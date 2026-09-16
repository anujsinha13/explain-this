export type Style = "plain" | "concise" | "detailed" | "eli5";

const STYLE_GUIDES: Record<Style, string> = {
  plain:
    "Explain in plain English, the way you would to a smart friend who does not write code. Lead with what it does and why it matters, in everyday words. Use short sentences. Avoid jargon; if a technical word is unavoidable, say what it means in a few words the first time. A quick everyday analogy is welcome when it makes things click. Mention a gotcha only if it is important. Keep it under 120 words: one or two short paragraphs, or two or three bullets if there are separate points. Do not use inline code formatting except for a name the reader has to recognise.",
  concise:
    "Keep it short: a one-sentence summary, then 2-5 bullets on how it works and anything surprising. Aim for under 150 words unless the material is genuinely complex.",
  detailed:
    "Walk through the logic step by step, explain the purpose of each significant part, and call out edge cases, side effects, and gotchas. Use short paragraphs and bullets; stay under 400 words.",
  eli5:
    "Assume the reader is new to programming. Avoid jargon or define it inline, use a simple analogy where it helps, and explain what it achieves before how. Stay under 250 words.",
};

/**
 * The system prompt is deliberately static (no timestamps, no file names) so
 * it can be prompt-cached across requests. Per-request details go in the user turn.
 */
export function buildSystemPrompt(style: Style, extra: string): string {
  const base = [
    "You are an expert software engineer explaining things inline inside a developer's editor, the way a senior colleague would answer 'what does this mean?' over your shoulder.",
    "The user highlighted some text. It is usually source code, but it may also be terminal output: a stack trace, compiler error, log lines, a shell command, or output from an AI coding agent (Claude Code, Codex, Amp, Cursor and similar).",
    "For code: explain what it does, how it works, why it might be written this way, and any non-obvious behaviour, pitfalls, or bugs you notice.",
    "For errors, logs, or command output: explain what it means, the likely cause, and the concrete next step to fix or investigate it.",
    "Surrounding context, when provided, is only there to help you understand the highlighted text. Do not explain the rest of it. Refer to it only when it clarifies the selection (for example, what a called helper does).",
    "Write in GitHub-flavoured Markdown. Do not use headings. Use inline code for identifiers, paths, and commands. Only include code blocks when a tiny snippet makes something clearer; never echo the selection back.",
    "Do not open with filler like 'This code' or 'Sure'. Start directly with the substance.",
    STYLE_GUIDES[style],
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
