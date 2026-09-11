import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";

const SECRET_KEY = "explainThis.anthropicApiKey";

/**
 * Resolves an Anthropic client. Order of preference:
 *   1. Key stored in VS Code SecretStorage (set via "Explain This: Set Anthropic API Key")
 *   2. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile, resolved lazily by the SDK
 * If neither exists the SDK throws on the first request; the caller then prompts for a key and retries.
 */
export async function getClient(secrets: vscode.SecretStorage): Promise<Anthropic> {
  const stored = await secrets.get(SECRET_KEY);
  return stored ? new Anthropic({ apiKey: stored }) : new Anthropic();
}

export async function promptForKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: "Anthropic API key",
    prompt: "Paste your Anthropic API key. It is stored in VS Code's secret storage, never in settings.",
    placeHolder: "sk-ant-...",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length < 10 ? "That does not look like an API key." : undefined),
  });
  if (!key) {
    return undefined;
  }
  await secrets.store(SECRET_KEY, key.trim());
  return key.trim();
}

export async function clearKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
}
