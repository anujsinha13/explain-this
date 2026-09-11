import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";

const SECRET_KEY = "claudeExplain.anthropicApiKey";

/**
 * Resolves an Anthropic client. Order of preference:
 *   1. Key stored in VS Code SecretStorage (set via "Claude Explain: Set Anthropic API Key")
 *   2. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile, resolved by the SDK
 *   3. Prompt the user for a key and store it.
 */
export async function getClient(secrets: vscode.SecretStorage): Promise<Anthropic | undefined> {
  const stored = await secrets.get(SECRET_KEY);
  if (stored) {
    return new Anthropic({ apiKey: stored });
  }
  try {
    // Zero-arg constructor resolves env vars and the ant CLI profile.
    return new Anthropic();
  } catch {
    // No ambient credentials; fall through to prompting.
  }
  const key = await promptForKey(secrets);
  return key ? new Anthropic({ apiKey: key }) : undefined;
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
