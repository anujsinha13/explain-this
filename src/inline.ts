import * as vscode from "vscode";
import { Conversation, newConversation, StreamingTarget, Surface, ThrottledRenderer } from "./surface";

export const CONTROLLER_ID = "explainThis";

const ASSISTANT_AUTHOR: vscode.CommentAuthorInformation = { name: "Claude" };
const YOU_AUTHOR: vscode.CommentAuthorInformation = { name: "You" };

/** Inline cards rendered as comment threads directly under the selection. */
export class InlineThreads implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly surfaces = new WeakMap<vscode.CommentThread, InlineSurface>();
  private readonly open = new Set<vscode.CommentThread>();

  constructor() {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Explain This");
    // No commentingRangeProvider on purpose: threads are only created by the command,
    // so no "+" gutter icons appear.
    this.controller.options = {
      prompt: "Ask a follow-up question…",
      placeHolder: "e.g. why is this async?",
    };
  }

  create(uri: vscode.Uri, range: vscode.Range, label: string): InlineSurface {
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.label = label;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = "explainThis";
    const surface = new InlineSurface(thread);
    this.surfaces.set(thread, surface);
    this.open.add(thread);
    return surface;
  }

  get(thread: vscode.CommentThread): InlineSurface | undefined {
    return this.surfaces.get(thread);
  }

  close(thread: vscode.CommentThread): void {
    this.surfaces.get(thread)?.conversation.abort?.abort();
    this.surfaces.delete(thread);
    this.open.delete(thread);
    thread.dispose();
  }

  closeAll(): void {
    for (const t of [...this.open]) {
      this.close(t);
    }
  }

  dispose(): void {
    this.closeAll();
    this.controller.dispose();
  }
}

export class InlineSurface implements Surface {
  readonly conversation: Conversation = newConversation();

  constructor(readonly thread: vscode.CommentThread) {}

  addUserTurn(text: string): void {
    this.thread.comments = [
      ...this.thread.comments,
      { author: YOU_AUTHOR, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview },
    ];
  }

  beginAssistantTurn(): StreamingTarget {
    const thread = this.thread;
    const index = thread.comments.length;

    const render = (markdown: string, label?: string) => {
      const comment: vscode.Comment = {
        author: ASSISTANT_AUTHOR,
        body: new vscode.MarkdownString(markdown),
        mode: vscode.CommentMode.Preview,
        label,
      };
      const comments = [...thread.comments];
      comments[index] = comment;
      thread.comments = comments;
    };

    const throttle = new ThrottledRenderer((md) => render(md + " ▍", "streaming"));
    render("_Thinking…_", "streaming");

    return {
      append: (delta) => throttle.append(delta),
      finish: (text, label) => {
        throttle.stop();
        render(text, label);
      },
      fail: (message) => {
        throttle.stop();
        const partial = throttle.text;
        render(partial ? `${partial}\n\n---\n⚠️ ${message}` : `⚠️ ${message}`, "error");
      },
    };
  }
}
