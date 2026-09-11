import * as vscode from "vscode";

export type Style = "concise" | "detailed" | "eli5";

const STYLE_GUIDES: Record<Style, string> = {
  concise:
    "Keep it short: a one-sentence summary, then 2-5 bullets on how it works and anything surprising. Aim for under 150 words unless the code is genuinely complex.",
  detailed:
    "Walk through the logic step by step, explain the purpose of each significant construct, and call out edge cases, side effects, and gotchas. Use short paragraphs and bullets; stay under 400 words.",
  eli5:
    "Assume the reader is new to programming. Avoid jargon or define it inline, use a simple analogy where it helps, and explain what the code achieves before how. Stay under 250 words.",
};

/**
 * The system prompt is deliberately static (no timestamps, no file names) so
 * it can be prompt-cached across requests. Per-request details go in the user turn.
 */
export function buildSystemPrompt(style: Style, extra: string): string {
  const base = [
    "You are an expert software engineer explaining code inline inside a code editor, the way a senior colleague would answer 'what does this do?' over your shoulder.",
    "The user selected a region of code. Explain that selection: what it does, how it works, why it might be written this way, and any non-obvious behaviour, pitfalls, or bugs you notice.",
    "Surrounding file context is provided only to help you understand the selection. Do not explain the rest of the file. Refer to it only when it clarifies the selection (for example, what a called helper does).",
    "Write in GitHub-flavoured Markdown. Do not use headings. Use inline code for identifiers. Only include code blocks when a tiny snippet makes something clearer; never echo the selection back.",
    "Do not open with filler like 'This code' or 'Sure'. Start directly with the substance.",
    STYLE_GUIDES[style],
  ];
  if (extra.trim()) {
    base.push(`Additional instructions from the user: ${extra.trim()}`);
  }
  return base.join("\n\n");
}

export interface SelectionContext {
  /** The text the user selected (or the current line if nothing was selected). */
  selected: string;
  /** Text of the user turn to send to the model. */
  userMessage: string;
  /** 1-based start and end line of the selection, for display. */
  startLine: number;
  endLine: number;
}

export function buildSelectionContext(
  document: vscode.TextDocument,
  range: vscode.Range,
  opts: { contextLines: number; maxWholeFileChars: number },
): SelectionContext {
  const selected = document.getText(range);
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const relPath = vscode.workspace.asRelativePath(document.uri, false);
  const language = document.languageId;

  const fullText = document.getText();
  let contextLabel: string;
  let contextText: string;
  let contextStartLine: number;

  if (fullText.length <= opts.maxWholeFileChars) {
    contextLabel = "Full file";
    contextText = fullText;
    contextStartLine = 1;
  } else {
    const from = Math.max(0, range.start.line - opts.contextLines);
    const to = Math.min(document.lineCount - 1, range.end.line + opts.contextLines);
    const ctxRange = new vscode.Range(from, 0, to, document.lineAt(to).text.length);
    contextLabel = `Lines ${from + 1}-${to + 1} of the file (file is large, so only nearby lines are included)`;
    contextText = document.getText(ctxRange);
    contextStartLine = from + 1;
  }

  const userMessage = [
    `File: ${relPath}`,
    `Language: ${language}`,
    `Selected lines: ${startLine}-${endLine}`,
    "",
    "<selection>",
    selected,
    "</selection>",
    "",
    `<context label="${contextLabel}" starts_at_line="${contextStartLine}">`,
    contextText,
    "</context>",
    "",
    "Explain the code inside <selection>.",
  ].join("\n");

  return { selected, userMessage, startLine, endLine };
}
