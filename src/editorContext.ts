import * as vscode from "vscode";
import { buildUserMessage, SelectionInput } from "./prompt";

export interface EditorSelection {
  input: SelectionInput;
  userMessage: string;
  label: string;
}

/** Gathers the selection plus surrounding file context from a text editor. */
export function fromEditor(
  document: vscode.TextDocument,
  range: vscode.Range,
  opts: { contextLines: number; maxWholeFileChars: number },
): EditorSelection {
  const selected = document.getText(range);
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const relPath = vscode.workspace.asRelativePath(document.uri, false);

  const fullText = document.getText();
  let context: SelectionInput["context"];
  if (fullText.length <= opts.maxWholeFileChars) {
    context = { label: "Full file", text: fullText, startsAtLine: 1 };
  } else {
    const from = Math.max(0, range.start.line - opts.contextLines);
    const to = Math.min(document.lineCount - 1, range.end.line + opts.contextLines);
    const ctxRange = new vscode.Range(from, 0, to, document.lineAt(to).text.length);
    context = {
      label: `Lines ${from + 1}-${to + 1} of the file (file is large, so only nearby lines are included)`,
      text: document.getText(ctxRange),
      startsAtLine: from + 1,
    };
  }

  const input: SelectionInput = {
    selected,
    source: relPath,
    language: document.languageId,
    startLine,
    endLine,
    context,
  };
  const label = startLine === endLine ? `${relPath}:${startLine}` : `${relPath}:${startLine}-${endLine}`;
  return { input, userMessage: buildUserMessage(input), label };
}

/**
 * Reads the current terminal selection. The stable API has no terminal selection
 * property, so this copies the selection through the clipboard and restores the
 * previous clipboard contents afterwards.
 */
export async function fromTerminal(): Promise<EditorSelection | undefined> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return undefined;
  }
  const previous = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText("");
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
  // The copy is asynchronous inside the terminal; give it a moment.
  let selected = "";
  for (let i = 0; i < 10 && !selected; i++) {
    await new Promise((r) => setTimeout(r, 40));
    selected = await vscode.env.clipboard.readText();
  }
  await vscode.env.clipboard.writeText(previous);
  if (!selected.trim()) {
    return undefined;
  }
  const input: SelectionInput = {
    selected,
    source: `terminal: ${terminal.name}`,
    language: "terminal output",
  };
  return { input, userMessage: buildUserMessage(input), label: `Terminal: ${terminal.name}` };
}
