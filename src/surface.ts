import Anthropic from "@anthropic-ai/sdk";

/** One conversation about one selection. */
export interface Conversation {
  history: Anthropic.Beta.BetaMessageParam[];
  lastExplanation: string;
  abort?: AbortController;
}

export function newConversation(): Conversation {
  return { history: [], lastExplanation: "" };
}

/** Receives a streamed assistant turn. */
export interface StreamingTarget {
  append(delta: string): void;
  finish(finalText: string, label?: string): void;
  fail(message: string): void;
}

/** Somewhere an explanation can be shown: an inline card or the side panel. */
export interface Surface {
  readonly conversation: Conversation;
  addUserTurn(text: string): void;
  beginAssistantTurn(): StreamingTarget;
}

/** Throttles streamed deltas so a UI is not repainted on every token. */
export class ThrottledRenderer {
  private buffer = "";
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly render: (markdown: string, streaming: boolean) => void, private readonly ms = 80) {}

  get text(): string {
    return this.buffer;
  }

  append(delta: string): void {
    this.buffer += delta;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.render(this.buffer, true);
      }, this.ms);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
