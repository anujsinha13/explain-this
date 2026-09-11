import * as vscode from "vscode";
import { marked } from "marked";
import { Conversation, newConversation, StreamingTarget, Surface, ThrottledRenderer } from "./surface";

type ToWebview =
  | { type: "reset"; label: string; selected: string }
  | { type: "user"; text: string }
  | { type: "assistant"; html: string; streaming: boolean; label?: string }
  | { type: "busy"; busy: boolean };

type FromWebview = { type: "ask"; text: string } | { type: "copy" } | { type: "cancel" };

/**
 * A side panel for explanations that have nowhere inline to live (terminal
 * selections) or when the user prefers a panel over inline cards.
 */
export class ExplainPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private surface: PanelSurface | undefined;
  private onAsk: ((surface: PanelSurface, text: string) => void) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setAskHandler(handler: (surface: PanelSurface, text: string) => void): void {
    this.onAsk = handler;
  }

  /** Starts a fresh conversation in the panel, creating it if needed. */
  show(label: string, selected: string): PanelSurface {
    this.surface?.conversation.abort?.abort();
    const panel = this.ensurePanel();
    this.surface = new PanelSurface((msg) => void panel.webview.postMessage(msg));
    this.post({ type: "reset", label, selected });
    panel.reveal(undefined, true);
    return this.surface;
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      "explainThis.panel",
      "Explain This",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    panel.webview.html = html(panel.webview);
    panel.onDidDispose(() => {
      this.surface?.conversation.abort?.abort();
      this.surface = undefined;
      this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      const surface = this.surface;
      if (!surface) {
        return;
      }
      switch (msg.type) {
        case "ask":
          this.onAsk?.(surface, msg.text);
          break;
        case "copy":
          if (surface.conversation.lastExplanation) {
            await vscode.env.clipboard.writeText(surface.conversation.lastExplanation);
            vscode.window.setStatusBarMessage("Explanation copied", 2000);
          }
          break;
        case "cancel":
          surface.conversation.abort?.abort();
          break;
      }
    });
    this.panel = panel;
    return panel;
  }

  private post(msg: ToWebview): void {
    void this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

export class PanelSurface implements Surface {
  readonly conversation: Conversation = newConversation();

  constructor(private readonly post: (msg: ToWebview) => void) {}

  addUserTurn(text: string): void {
    this.post({ type: "user", text });
  }

  beginAssistantTurn(): StreamingTarget {
    const send = (markdown: string, streaming: boolean, label?: string) =>
      this.post({ type: "assistant", html: marked.parse(markdown, { async: false }) as string, streaming, label });
    const throttle = new ThrottledRenderer((md) => send(md, true), 120);
    send("_Thinking…_", true);
    this.post({ type: "busy", busy: true });
    return {
      append: (delta) => throttle.append(delta),
      finish: (text, label) => {
        throttle.stop();
        send(text, false, label);
        this.post({ type: "busy", busy: false });
      },
      fail: (message) => {
        throttle.stop();
        const partial = throttle.text;
        send(partial ? `${partial}\n\n---\n⚠️ ${message}` : `⚠️ ${message}`, false, "error");
        this.post({ type: "busy", busy: false });
      },
    };
  }
}

function html(webview: vscode.Webview): string {
  const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join("");
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 90px; }
  h1 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); }
  details { margin-bottom: 12px; }
  summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
  pre.selected { max-height: 160px; overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); white-space: pre-wrap; }
  .turn { margin: 10px 0; padding: 10px 12px; border-radius: 6px; line-height: 1.5; }
  .turn.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  .turn.assistant { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border, transparent); }
  .turn .who { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .turn .who .label { font-weight: 400; margin-left: 6px; opacity: .8; }
  .turn p:first-of-type { margin-top: 0; } .turn p:last-child { margin-bottom: 0; }
  .turn code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .turn pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow: auto; }
  .turn pre code { background: none; padding: 0; }
  .streaming::after { content: "▍"; animation: blink 1s steps(2) infinite; }
  @keyframes blink { to { visibility: hidden; } }
  footer { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 16px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; min-height: 34px; max-height: 120px; font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; padding: 7px 12px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .empty { color: var(--vscode-descriptionForeground); margin-top: 40px; text-align: center; }
</style>
</head>
<body>
  <div id="root"><p class="empty">Select code or terminal output and press Ctrl+Shift+E.</p></div>
  <footer>
    <textarea id="ask" rows="1" placeholder="Ask a follow-up… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Ask</button>
    <button id="copy" class="secondary" title="Copy last explanation">Copy</button>
    <button id="cancel" class="secondary" title="Stop generating" hidden>Stop</button>
  </footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const ask = document.getElementById("ask");
  const send = document.getElementById("send");
  const cancel = document.getElementById("cancel");
  let current = null;

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "reset") {
      root.innerHTML = '<h1>' + esc(m.label) + '</h1><details><summary>Selected text</summary><pre class="selected">' + esc(m.selected) + '</pre></details>';
      current = null;
    } else if (m.type === "user") {
      const d = document.createElement("div");
      d.className = "turn user";
      d.innerHTML = '<div class="who">You</div>';
      const p = document.createElement("div"); p.textContent = m.text; d.appendChild(p);
      root.appendChild(d);
      current = null;
    } else if (m.type === "assistant") {
      if (!current) {
        current = document.createElement("div");
        current.className = "turn assistant";
        current.innerHTML = '<div class="who">Claude<span class="label"></span></div><div class="body"></div>';
        root.appendChild(current);
      }
      current.querySelector(".body").innerHTML = m.html;
      current.querySelector(".label").textContent = m.label || "";
      current.querySelector(".body").classList.toggle("streaming", m.streaming);
      if (!m.streaming) current = null;
      window.scrollTo(0, document.body.scrollHeight);
    } else if (m.type === "busy") {
      send.disabled = m.busy;
      cancel.hidden = !m.busy;
    }
  });

  const submit = () => {
    const text = ask.value.trim();
    if (!text || send.disabled) return;
    vscode.postMessage({ type: "ask", text });
    ask.value = "";
  };
  send.addEventListener("click", submit);
  ask.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  document.getElementById("copy").addEventListener("click", () => vscode.postMessage({ type: "copy" }));
  cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
</script>
</body>
</html>`;
}
