import Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamOptions {
  client: Anthropic;
  model: string;
  effort: Effort;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  signal: AbortSignal;
  /** Called with each text delta as it arrives. */
  onText: (delta: string) => void;
}

export interface StreamResult {
  text: string;
  stopReason: string | null;
  refusalExplanation?: string;
  servedBy: string;
}

/**
 * Streams one explanation turn from Claude.
 *
 * - Adaptive thinking is on by default for claude-opus-5, so `thinking` is omitted.
 * - Server-side refusal fallbacks are enabled so a safety-classifier decline is
 *   retried on Anthropic's recommended fallback model instead of surfacing as an error.
 * - The system prompt is cached (it is static across requests).
 */
export async function streamExplanation(opts: StreamOptions): Promise<StreamResult> {
  const stream = opts.client.beta.messages.stream(
    {
      model: opts.model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
      ],
      output_config: { effort: opts.effort },
      messages: opts.messages,
    },
    { signal: opts.signal },
  );

  stream.on("text", opts.onText);

  const final = await stream.finalMessage();

  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    stopReason: final.stop_reason,
    refusalExplanation:
      final.stop_reason === "refusal" ? final.stop_details?.explanation ?? undefined : undefined,
    servedBy: final.model,
  };
}

/**
 * The SDK resolves credentials lazily and throws a plain Error (not a typed
 * subclass) on the first request when none can be found.
 */
export function isMissingCredentials(err: unknown): boolean {
  return err instanceof Error && !(err instanceof Anthropic.APIError) && err.message.startsWith("Could not resolve authentication method");
}

export interface ErrorInfo {
  message: string;
  /** The key is wrong or absent; offer to (re)enter it. */
  authProblem: boolean;
  /** No credentials at all were found. */
  missingKey: boolean;
}

/** Turns an SDK error into a short, user-facing message. */
export function describeError(err: unknown): ErrorInfo {
  return { missingKey: isMissingCredentials(err), ...describe(err) };
}

function describe(err: unknown): { message: string; authProblem: boolean } {
  if (isMissingCredentials(err)) {
    return { message: "No Anthropic API key found.", authProblem: true };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { message: "Anthropic rejected the API key.", authProblem: true };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { message: "This API key does not have access to the selected model.", authProblem: true };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { message: "Rate limited by Anthropic. Try again in a moment.", authProblem: false };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { message: `Model not found. Check the explainThis.model setting. (${err.message})`, authProblem: false };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { message: `Anthropic rejected the request: ${err.message}`, authProblem: false };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { message: "Could not reach the Anthropic API. Check your network.", authProblem: false };
  }
  if (err instanceof Anthropic.APIError) {
    return { message: `Anthropic API error ${err.status ?? ""}: ${err.message}`, authProblem: false };
  }
  if (err instanceof Error) {
    return { message: err.message, authProblem: false };
  }
  return { message: String(err), authProblem: false };
}
