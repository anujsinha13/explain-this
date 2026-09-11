import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";

export const CONTROLLER_ID = "claudeExplain";

const CLAUDE_AUTHOR: vscode.CommentAuthorInformation = {
  name: "Claude",
};
const YOU_AUTHOR: vscode.CommentAuthorInformation = {
  name: "You",
};

/** Per-thread state: the conversation so far and any in-flight request. */
export interface ThreadState {
  history: Anthropic.Beta.BetaMessageParam[];
  lastExplanation: string;
  abort?: AbortController;
}

export class ExplanationThreads implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly state = new WeakMap<vscode.CommentThread, ThreadState>();
  private readonly open = new Set<vscode.CommentThread>();

  constructor() {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, "Claude Explain");
    // No commentingRangeProvider on purpose: threads are only created by the command,
    // so no "+" gutter icons appear.
    this.controller.options = {
      prompt: "Ask a follow-up question about this code…",
      placeHolder: "e.g. why is this async?",
    };
  }

  create(uri: vscode.Uri, range: vscode.Range, label: string): vscode.CommentThread {
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.label = label;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = "claudeExplain";
    this.state.set(thread, { history: [], lastExplanation: "" });
    this.open.add(thread);
    return thread;
  }

  get(thread: vscode.CommentThread): ThreadState | undefined {
    return this.state.get(thread);
  }

  close(thread: vscode.CommentThread): void {
    this.state.get(thread)?.abort?.abort();
    this.state.delete(thread);
    this.open.delete(thread);
    thread.dispose();
  }

  closeAll(): void {
    for (const t of [...this.open]) {
      this.close(t);
    }
  }

  addUserComment(thread: vscode.CommentThread, text: string): void {
    thread.comments = [
      ...thread.comments,
      { author: YOU_AUTHOR, body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview },
    ];
  }

  /**
   * Appends a Claude comment that is updated in place as text streams in.
   * Returns a handle for pushing updates and finalising.
   */
  startStreamingComment(thread: vscode.CommentThread): StreamingComment {
    return new StreamingComment(thread);
  }

  dispose(): void {
    this.closeAll();
    this.controller.dispose();
  }
}

export class StreamingComment {
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;
  private readonly index: number;

  constructor(private readonly thread: vscode.CommentThread) {
    this.index = thread.comments.length;
    this.render("_Thinking…_", "streaming");
  }

  append(delta: string): void {
    this.buffer += delta;
    if (!this.timer) {
      // Throttle re-renders so the comment widget is not repainted on every token.
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.render(this.buffer + " ▍", "streaming");
      }, 80);
    }
  }

  finish(finalText: string, label?: string): void {
    this.clearTimer();
    this.buffer = finalText;
    this.render(finalText, label);
  }

  fail(message: string): void {
    this.clearTimer();
    const body = this.buffer ? `${this.buffer}\n\n---\n⚠️ ${message}` : `⚠️ ${message}`;
    this.render(body, "error");
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private render(markdown: string, label?: string): void {
    const body = new vscode.MarkdownString(markdown);
    body.supportThemeIcons = true;
    const comment: vscode.Comment = {
      author: CLAUDE_AUTHOR,
      body,
      mode: vscode.CommentMode.Preview,
      label,
    };
    const comments = [...this.thread.comments];
    comments[this.index] = comment;
    this.thread.comments = comments;
  }
}
