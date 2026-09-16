import * as vscode from "vscode";
import { getClient, promptForKey, clearKey } from "./apiKey";
import { streamExplanation, describeError, Effort } from "./client";
import { buildSystemPrompt, clampLevel, DEFAULT_LEVEL } from "./prompt";
import { fromEditor, fromTerminal, EditorSelection } from "./editorContext";
import { InlineThreads } from "./inline";
import { ExplainPanel } from "./panel";
import { BubbleSurface, bubbleAvailable } from "./bubble";
import { Surface, StreamingTarget } from "./surface";

let inline: InlineThreads;
let panel: ExplainPanel;
let bubble: BubbleSurface | undefined;
let bubbleBinary: string;

export function activate(context: vscode.ExtensionContext): void {
  inline = new InlineThreads();
  panel = new ExplainPanel(context.extensionUri);
  bubbleBinary = context.asAbsolutePath("bin/ExplainBubble");
  context.subscriptions.push({ dispose: () => bubble?.close() });
  panel.setAskHandler((surface, text) => void followUp(context, surface, text));
  context.subscriptions.push(inline, panel);

  context.subscriptions.push(
    vscode.commands.registerCommand("explainThis.explain", () => explainEditor(context)),
    vscode.commands.registerCommand("explainThis.explainTerminal", () => explainTerminal(context)),
    vscode.commands.registerCommand("explainThis.explainInPanel", () => explainEditor(context, "panel")),
    vscode.commands.registerCommand("explainThis.explainInline", () => explainEditor(context, "inline")),
    vscode.commands.registerCommand("explainThis.reply", (reply: vscode.CommentReply) => {
      const surface = inline.get(reply.thread);
      if (surface) {
        void followUp(context, surface, reply.text);
      }
    }),
    vscode.commands.registerCommand("explainThis.copy", async (thread: vscode.CommentThread) => {
      const text = inline.get(thread)?.conversation.lastExplanation;
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage("Explanation copied", 2000);
      }
    }),
    vscode.commands.registerCommand("explainThis.closeThread", (thread: vscode.CommentThread) =>
      inline.close(thread),
    ),
    vscode.commands.registerCommand("explainThis.closeAll", () => inline.closeAll()),
    vscode.commands.registerCommand("explainThis.setApiKey", async () => {
      if (await promptForKey(context.secrets)) {
        vscode.window.showInformationMessage("Anthropic API key saved.");
      }
    }),
    vscode.commands.registerCommand("explainThis.clearApiKey", async () => {
      await clearKey(context.secrets);
      vscode.window.showInformationMessage("Stored Anthropic API key removed.");
    }),
  );
}

export function deactivate(): void {
  inline?.dispose();
  panel?.dispose();
}

interface Settings {
  model: string;
  effort: Effort;
  contextLines: number;
  maxWholeFileChars: number;
  level: number;
  extraInstructions: string;
  display: Display;
}

type Display = "bubble" | "inline" | "panel";

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("explainThis");
  return {
    model: cfg.get<string>("model", "claude-opus-5"),
    effort: cfg.get<Effort>("effort", "medium"),
    contextLines: cfg.get<number>("contextLines", 60),
    maxWholeFileChars: cfg.get<number>("maxWholeFileChars", 24000),
    level: clampLevel(cfg.get<number>("level", DEFAULT_LEVEL)),
    extraInstructions: cfg.get<string>("extraInstructions", ""),
    display: cfg.get<Display>("display", "bubble"),
  };
}

/** Opens a floating bubble for this selection, replacing any bubble already open. */
function openBubble(context: vscode.ExtensionContext, label: string, selected: string): BubbleSurface {
  bubble?.close();
  const surface = new BubbleSurface(bubbleBinary, label, selected, readSettings().level, (event) => {
    if (event.type === "ask") {
      void followUp(context, surface, event.text);
    } else if (event.type === "level") {
      void changeLevel(context, surface, event.value);
    } else if (bubble === surface) {
      bubble = undefined;
    }
  });
  bubble = surface;
  return surface;
}

/** Explains the editor selection. Falls back to the terminal when no editor is active. */
async function explainEditor(context: vscode.ExtensionContext, forceDisplay?: Display): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    if (vscode.window.activeTerminal) {
      return explainTerminal(context);
    }
    vscode.window.showWarningMessage("Select some code or terminal output first.");
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
  const sel = fromEditor(editor.document, range, settings);
  let display = forceDisplay ?? settings.display;
  if (display === "bubble" && !bubbleAvailable(bubbleBinary)) {
    display = "inline"; // the native bubble is macOS-only
  }

  const surface: Surface =
    display === "bubble"
      ? openBubble(context, sel.label, sel.input.selected)
      : display === "panel"
        ? panel.show(sel.label, sel.input.selected)
        : inline.create(editor.document.uri, range, sel.label);

  await start(context, surface, sel, settings);
}

/** Explains the text selected in the integrated terminal: bubble on macOS, otherwise the side panel. */
async function explainTerminal(context: vscode.ExtensionContext): Promise<void> {
  const sel = await fromTerminal();
  if (!sel) {
    vscode.window.showWarningMessage("Select some text in the terminal first.");
    return;
  }
  const settings = readSettings();
  const surface: Surface =
    settings.display === "bubble" && bubbleAvailable(bubbleBinary)
      ? openBubble(context, sel.label, sel.input.selected)
      : panel.show(sel.label, sel.input.selected);
  await start(context, surface, sel, settings);
}

async function start(
  context: vscode.ExtensionContext,
  surface: Surface,
  sel: EditorSelection,
  settings: Settings,
): Promise<void> {
  surface.conversation.history.push({ role: "user", content: sel.userMessage });
  await runTurn(context, surface, settings);
}

/** Re-explains the same selection at a new technicality level and remembers the level. */
async function changeLevel(context: vscode.ExtensionContext, surface: BubbleSurface, value: number): Promise<void> {
  const level = clampLevel(value);
  await vscode.workspace.getConfiguration("explainThis").update("level", level, vscode.ConfigurationTarget.Global);
  surface.restart(level);
  await runTurn(context, surface, { ...readSettings(), level });
}

async function followUp(context: vscode.ExtensionContext, surface: Surface, text: string): Promise<void> {
  const question = text.trim();
  if (!question) {
    return;
  }
  if (surface.conversation.abort) {
    vscode.window.showInformationMessage("Claude is still answering. Wait for it to finish.");
    return;
  }
  surface.addUserTurn(question);
  surface.conversation.history.push({ role: "user", content: question });
  await runTurn(context, surface, readSettings());
}

/**
 * Sends the conversation to Claude and streams the reply into the surface.
 * `retry` carries the existing target when re-running after the user enters an API key.
 */
async function runTurn(
  context: vscode.ExtensionContext,
  surface: Surface,
  settings: Settings,
  retry?: { target: StreamingTarget },
): Promise<void> {
  const conversation = surface.conversation;
  const client = await getClient(context.secrets);

  const abort = new AbortController();
  conversation.abort = abort;
  const target = retry?.target ?? surface.beginAssistantTurn();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Claude is explaining…", cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      try {
        const result = await streamExplanation({
          client,
          model: settings.model,
          effort: settings.effort,
          system: buildSystemPrompt(settings.level, settings.extraInstructions),
          messages: conversation.history,
          signal: abort.signal,
          onText: (delta) => target.append(delta),
        });

        if (result.stopReason === "refusal") {
          target.fail(`Claude declined to answer${result.refusalExplanation ? `: ${result.refusalExplanation}` : "."}`);
          conversation.history.pop(); // drop the unanswered user turn so a follow-up still works
          return;
        }

        const text = result.text.trim() || "_(empty response)_";
        conversation.history.push({ role: "assistant", content: text });
        conversation.lastExplanation = text;
        target.finish(text, result.servedBy !== settings.model ? `via ${result.servedBy}` : undefined);
      } catch (err) {
        if (abort.signal.aborted) {
          conversation.history.pop();
          target.fail("Cancelled.");
          return;
        }
        const { message, authProblem, missingKey } = describeError(err);
        if (missingKey && !retry) {
          // First run with no credentials anywhere: ask for a key and retry into the same card.
          conversation.abort = undefined;
          if (await promptForKey(context.secrets)) {
            return runTurn(context, surface, settings, { target });
          }
        }
        conversation.history.pop();
        target.fail(message);
        if (authProblem) {
          const pick = await vscode.window.showErrorMessage(`Explain This: ${message}`, "Set API key");
          if (pick === "Set API key") {
            await promptForKey(context.secrets);
          }
        } else {
          vscode.window.showErrorMessage(`Explain This: ${message}`);
        }
      } finally {
        conversation.abort = undefined;
      }
    },
  );
}
