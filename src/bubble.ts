import { spawn, ChildProcess } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import * as readline from "node:readline";
import { Conversation, newConversation, StreamingTarget, Surface } from "./surface";

/** Messages the bubble sends back over stdout. */
export type BubbleEvent = { type: "ask"; text: string } | { type: "closed" };

export function bubbleAvailable(binary: string): boolean {
  return process.platform === "darwin" && existsSync(binary);
}

/**
 * A native floating Liquid Glass bubble (macOS). One process per explanation;
 * JSON lines over stdin/stdout. See bubble/Sources/ExplainBubble/main.swift.
 */
export class BubbleSurface implements Surface {
  readonly conversation: Conversation = newConversation();
  private readonly proc: ChildProcess;
  private closed = false;

  constructor(binary: string, source: string, selected: string, private readonly onEvent: (e: BubbleEvent) => void) {
    try {
      chmodSync(binary, 0o755); // zip-based installs can drop the executable bit
    } catch {
      /* best effort */
    }
    this.proc = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as BubbleEvent;
        if (msg.type === "ask") {
          this.onEvent(msg);
        }
      } catch {
        /* ignore malformed lines */
      }
    });
    const onGone = () => {
      if (!this.closed) {
        this.closed = true;
        this.conversation.abort?.abort();
        this.onEvent({ type: "closed" });
      }
    };
    this.proc.on("exit", onGone);
    this.proc.on("error", onGone);
    this.proc.stdin?.on("error", () => undefined);
    this.send({ type: "start", source, selected });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.closed && this.proc.stdin?.writable) {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  addUserTurn(text: string): void {
    // The bubble already shows the question it sent; nothing to echo.
    void text;
  }

  beginAssistantTurn(): StreamingTarget {
    this.send({ type: "begin" });
    return {
      append: (delta) => this.send({ type: "delta", text: delta }),
      finish: (text, label) => this.send({ type: "done", text, label }),
      fail: (message) => this.send({ type: "error", message }),
    };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.proc.kill();
    }
  }
}
