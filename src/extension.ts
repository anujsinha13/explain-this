import * as vscode from "vscode";
import { getClient, promptForKey, clearKey } from "./apiKey";
import { streamExplanation, describeError, Effort } from "./client";
import { buildSystemPrompt, buildSelectionContext, Style } from "./prompt";
import { ExplanationThreads } from "./threads";

let threads: ExplanationThreads;

export function activate(context: vscode.ExtensionContext): void {
  threads = new ExplanationThreads();
  context.subscriptions.push(threads);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeExplain.explain", () => explainSelection(context)),
    vscode.commands.registerCommand("claudeExplain.reply", (reply: vscode.CommentReply) =>
      followUp(context, reply),
    ),
    vscode.commands.registerCommand("claudeExplain.copy", async (thread: vscode.CommentThread) => {
      const text = threads.get(thread)?.lastExplanation;
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage("Explanation copied", 2000);
      }
    }),
    vscode.commands.registerCommand("claudeExplain.closeThread", (thread: vscode.CommentThread) =>
      threads.close(thread),
    ),
    vscode.commands.registerCommand("claudeExplain.closeAll", () => threads.closeAll()),
    vscode.commands.registerCommand("claudeExplain.setApiKey", async () => {
      if (await promptForKey(context.secrets)) {
        vscode.window.showInformationMessage("Anthropic API key saved.");
      }
    }),
    vscode.commands.registerCommand("claudeExplain.clearApiKey", async () => {
      await clearKey(context.secrets);
      vscode.window.showInformationMessage("Stored Anthropic API key removed.");
    }),
  );
}

export function deactivate(): void {
  threads?.dispose();
}

interface Settings {
  model: string;
  effort: Effort;
  contextLines: number;
  maxWholeFileChars: number;
  style: Style;
  extraInstructions: string;
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("claudeExplain");
  return {
    model: cfg.get<string>("model", "claude-opus-5"),
    effort: cfg.get<Effort>("effort", "medium"),
    contextLines: cfg.get<number>("contextLines", 60),
    maxWholeFileChars: cfg.get<number>("maxWholeFileChars", 24000),
    style: cfg.get<Style>("style", "concise"),
    extraInstructions: cfg.get<string>("extraInstructions", ""),
  };
}

async function explainSelection(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file and select some code first.");
    return;
  }

  // Fall back to the current line when nothing is selected (e.g. via the command palette).
  let range: vscode.Range = editor.selection;
  if (range.isEmpty) {
    range = editor.document.lineAt(editor.selection.active.line).range;
  }
  if (editor.document.getText(range).trim() === "") {
    vscode.window.showWarningMessage("Select some code to explain.");
    return;
  }

  const settings = readSettings();
  const ctx = buildSelectionContext(editor.document, range, settings);
  const label =
    ctx.startLine === ctx.endLine ? `Line ${ctx.startLine}` : `Lines ${ctx.startLine}-${ctx.endLine}`;

  const thread = threads.create(editor.document.uri, range, label);
  const state = threads.get(thread)!;
  state.history.push({ role: "user", content: ctx.userMessage });

  await runTurn(context, thread, settings);
}

async function followUp(context: vscode.ExtensionContext, reply: vscode.CommentReply): Promise<void> {
  const thread = reply.thread;
  const state = threads.get(thread);
  const question = reply.text.trim();
  if (!state || !question) {
    return;
  }
  if (state.abort) {
    vscode.window.showInformationMessage("Claude is still answering. Wait for it to finish.");
    return;
  }
  threads.addUserComment(thread, question);
  state.history.push({ role: "user", content: question });
  await runTurn(context, thread, readSettings());
}

/** Sends the thread's history to Claude and streams the reply into a new comment. */
async function runTurn(
  context: vscode.ExtensionContext,
  thread: vscode.CommentThread,
  settings: Settings,
): Promise<void> {
  const state = threads.get(thread);
  if (!state) {
    return;
  }

  const client = await getClient(context.secrets);
  if (!client) {
    threads.close(thread);
    return;
  }

  const abort = new AbortController();
  state.abort = abort;
  const comment = threads.startStreamingComment(thread);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Claude is explaining…", cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      try {
        const result = await streamExplanation({
          client,
          model: settings.model,
          effort: settings.effort,
          system: buildSystemPrompt(settings.style, settings.extraInstructions),
          messages: state.history,
          signal: abort.signal,
          onText: (delta) => comment.append(delta),
        });

        if (result.stopReason === "refusal") {
          comment.fail(
            `Claude declined to answer${result.refusalExplanation ? `: ${result.refusalExplanation}` : "."}`,
          );
          state.history.pop(); // drop the unanswered user turn so a follow-up still works
          return;
        }

        const text = result.text.trim() || "_(empty response)_";
        state.history.push({ role: "assistant", content: text });
        state.lastExplanation = text;
        comment.finish(text, result.servedBy !== settings.model ? `via ${result.servedBy}` : undefined);
      } catch (err) {
        if (abort.signal.aborted) {
          comment.fail("Cancelled.");
          state.history.pop();
          return;
        }
        const { message, authProblem } = describeError(err);
        comment.fail(message);
        state.history.pop();
        if (authProblem) {
          const pick = await vscode.window.showErrorMessage(message, "Set API key");
          if (pick === "Set API key") {
            await promptForKey(context.secrets);
          }
        } else {
          vscode.window.showErrorMessage(`Claude Explain: ${message}`);
        }
      } finally {
        state.abort = undefined;
      }
    },
  );
}
