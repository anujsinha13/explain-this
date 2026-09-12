import * as vscode from "vscode";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_KEY = "explainThis.anthropicApiKey";

/** Shared with the CLI and the macOS Quick Action. */
export const KEY_FILE = join(homedir(), ".config", "explain-this", "api-key");

function readKeyFile(): string | undefined {
  try {
    if (existsSync(KEY_FILE)) {
      const key = readFileSync(KEY_FILE, "utf8").trim();
      return key || undefined;
    }
  } catch {
    // unreadable; fall through
  }
  return undefined;
}

/**
 * Resolves an Anthropic client. Order of preference:
 *   1. Key stored in VS Code SecretStorage (set via "Explain This: Set Anthropic API Key")
 *   2. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the environment
 *   3. ~/.config/explain-this/api-key (the file the CLI and Quick Action use)
 *   4. An `ant auth login` profile, resolved lazily by the SDK
 * If nothing is found the SDK throws on the first request; the caller then prompts for a key and retries.
 */
export async function getClient(secrets: vscode.SecretStorage): Promise<Anthropic> {
  const stored = await secrets.get(SECRET_KEY);
  if (stored) {
    return new Anthropic({ apiKey: stored });
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return new Anthropic();
  }
  const fromFile = readKeyFile();
  return fromFile ? new Anthropic({ apiKey: fromFile }) : new Anthropic();
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
