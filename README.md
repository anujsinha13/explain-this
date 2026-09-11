# Claude Explain

Select some code, press **Ctrl+Shift+E**, and Claude explains it in an inline card right under the selection. Think Grammarly's "explain this" popup, but for code. Ask follow-up questions in the same card.

Works in VS Code and VS Code-based editors (Cursor, Windsurf, VSCodium).

## How it works

1. Highlight a function, block, or expression.
2. Press `Ctrl+Shift+E` (or right-click and choose **Explain Selection with Claude**).
3. An inline thread opens beneath the selection and the explanation streams in.
4. Type a follow-up in the reply box and press **Ask** to continue the conversation. Claude keeps the selected code and prior answers as context.
5. Use the **Copy** or **Close** icons in the card's title bar. **Claude Explain: Close All Explanations** clears every open card.

The model sees the selection plus surrounding context (the whole file when it is small, otherwise the lines around the selection), so it can explain what helpers do and where values come from.

## Setup

Install from the `.vsix`:

```bash
npm install
npm run package
code --install-extension claude-explain-0.1.0.vsix
```

Then provide an Anthropic API key in one of these ways:

- Run **Claude Explain: Set Anthropic API Key** from the command palette. The key is kept in VS Code's secret storage, not in settings.
- Or export `ANTHROPIC_API_KEY` in the environment VS Code is launched from.
- Or log in with the Anthropic CLI (`ant auth login`). The SDK picks up the profile automatically.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeExplain.model` | `claude-opus-5` | Anthropic model ID. |
| `claudeExplain.effort` | `medium` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Lower is faster and cheaper. |
| `claudeExplain.style` | `concise` | `concise` (short digest), `detailed` (step-by-step), or `eli5` (no jargon). |
| `claudeExplain.maxWholeFileChars` | `24000` | Files up to this size are sent in full for context. |
| `claudeExplain.contextLines` | `60` | Lines of context around the selection for larger files. |
| `claudeExplain.extraInstructions` | `""` | Extra instructions appended to the system prompt, e.g. "Answer in Spanish". |

## Keybinding

The default is `Ctrl+Shift+E` on every platform, active only when the editor has focus and text is selected. On Windows and Linux that combination normally focuses the Explorer; with a selection active, this extension wins, and without one the Explorer shortcut still works. Rebind under **Preferences: Open Keyboard Shortcuts** by searching for "Claude Explain".

## Development

```bash
npm install
npm run watch     # rebuild on change
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. `npm run check` runs the TypeScript type-checker and `npm run package` builds a `.vsix`.

The extension talks to the Anthropic Messages API through the official `@anthropic-ai/sdk`, streaming responses, caching the static system prompt, and using server-side refusal fallbacks so a safety-classifier decline is retried on Anthropic's recommended fallback model.

## License

MIT
