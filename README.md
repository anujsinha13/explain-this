# Explain This

Highlight anything, press **Ctrl+Shift+E**, and a floating Liquid Glass bubble pops up at your cursor and explains it in plain English. Think Grammarly's popup, but for code, stack traces, logs, and AI-agent output.

It is agent-agnostic. It does not plug into any particular AI tool; it works on whatever text you have selected, so it sits happily next to Claude Code, Codex, Amp, Cursor, Copilot, or nothing at all.

## Where it works

| Where you are | What happens |
| --- | --- |
| **Editor** (VS Code, Cursor, Windsurf, VSCodium) | The bubble pops up over the editor with the explanation streaming in. Ask follow-ups right in the bubble. |
| **Integrated terminal** (Claude Code, Codex CLI, Amp CLI, any shell) | Select text in the terminal, press the shortcut, same bubble. |
| **Any macOS app** (iTerm, Terminal.app, Warp, Ghostty, browsers, Xcode…) | A system-wide Quick Action sends the selected text to the CLI, which pops the same bubble. |
| **Your shell** | `explain-this` explains the clipboard or stdin. Pipe anything into it, or add `--bubble`. |

The bubble is a native macOS window using the system Liquid Glass material (macOS 26; a frosted material on older versions). It floats above everything, follows your mouse position, streams as Claude writes, and has a follow-up box, copy button, and a toggle to peek at the selected text. Esc, the close button, or a click anywhere outside dismisses it. On Linux and Windows the editor falls back to inline cards and the side panel.

## Editor extension

### Install

```bash
npm install
npm run package
code --install-extension explain-this-0.1.0.vsix      # VS Code
cursor --install-extension explain-this-0.1.0.vsix    # Cursor
```

`npm run package` builds the JavaScript only. On macOS run `npm run build:all` first (or `npm run build:bubble`) so the native bubble is bundled into the `.vsix`; it needs Xcode or the Command Line Tools.

Then give it an Anthropic API key in one of these ways:

- Run **Explain This: Set Anthropic API Key** from the command palette. The key is kept in the editor's secret storage, not in settings.
- Or export `ANTHROPIC_API_KEY` in the environment the editor is launched from.
- Or put the key in `~/.config/explain-this/api-key`. The extension, CLI, and Quick Action all read this file, so one setup covers everything.
- Or log in with the Anthropic CLI (`ant auth login`). The SDK picks up the profile automatically.

### Use

1. Highlight a function, block, error message, or a chunk of an agent's output.
2. Press `Ctrl+Shift+E`, or right-click and choose **Explain Selection** (editor) or **Explain Terminal Selection** (terminal).
3. Read the explanation as it streams into the bubble. Type a follow-up and press Enter to keep going. Claude keeps the selection and earlier answers as context.
4. Press Esc or click anywhere else to dismiss.

Editor selections send the whole file as context when it is small, otherwise the lines around the selection, so Claude can explain what helpers do and where values come from. Terminal selections send just the selected text.

Prefer something docked? Set `explainThis.display` to `inline` (a card under the code) or `panel` (a side panel), or use **Explain Selection as Inline Card** / **Explain Selection in Side Panel** for a one-off.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `explainThis.display` | `bubble` | `bubble` (floating glass window, macOS), `inline` card under the code, or the side `panel`. |
| `explainThis.model` | `claude-opus-5` | Anthropic model ID. |
| `explainThis.effort` | `medium` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Lower is faster and cheaper. |
| `explainThis.style` | `plain` | `plain` (plain English, no jargon), `concise` (short technical digest), `detailed` (step-by-step), or `eli5` (assumes no programming knowledge). |
| `explainThis.maxWholeFileChars` | `24000` | Files up to this size are sent in full for context. |
| `explainThis.contextLines` | `60` | Lines of context around the selection for larger files. |
| `explainThis.extraInstructions` | `""` | Extra instructions appended to the system prompt, e.g. "Answer in Spanish". |

### Keybinding

`Ctrl+Shift+E` on every platform, active when the editor has a selection or the terminal has selected text. On Windows and Linux that combination normally focuses the Explorer; with a selection active this extension wins, and without one the Explorer shortcut still works. Rebind under **Preferences: Open Keyboard Shortcuts** by searching for "Explain This".

## System-wide hotkey (macOS)

For text in apps the editor cannot see, such as a standalone terminal running Codex or Claude Code:

```bash
npm install && npm run build:all
mkdir -p ~/.config/explain-this && echo 'sk-ant-...' > ~/.config/explain-this/api-key
./system/install-macos-quick-action.sh
```

Then open **System Settings > Keyboard > Keyboard Shortcuts > Services > Text**, find **Explain This**, and assign a hotkey. Select text in any app, press it, and the bubble pops up at your cursor. The first run in each app will ask for permission.

The key file is needed because Quick Actions run without your shell profile. The CLI also honours `ANTHROPIC_API_KEY` and `ant auth login` profiles when they are available.

## CLI

```bash
npm run build
npm link                       # puts `explain-this` on your PATH

explain-this                   # explains whatever is on the clipboard
pbpaste | explain-this         # or pipe anything in
explain-this --bubble          # floating glass bubble at the cursor (macOS)
explain-this --style eli5 --effort low
explain-this --open            # render to HTML and open in the browser
```

Options: `--style plain|concise|detailed|eli5`, `--effort low|medium|high|xhigh|max`, `--model ID`, `--source LABEL`, `--bubble`, `--html`, `--open`. Works on macOS, Linux (`wl-paste`, `xclip`, or `xsel`), and Windows.

## Development

```bash
npm install
npm run watch          # rebuild extension and CLI on change
npm run build:bubble   # rebuild the native bubble (bubble/, Swift Package)
```

Press `F5` in VS Code to launch an Extension Development Host. `npm run check` type-checks, `npm run package` builds a `.vsix`.

The bubble is a small Swift package in `bubble/`. It is UI only: the host (extension or CLI) talks to it with JSON lines over stdin/stdout, so the Anthropic call lives in one place. Set `EXPLAIN_BUBBLE_DEBUG=1` to get diagnostics on stderr.

Under the hood it calls the Anthropic Messages API through the official `@anthropic-ai/sdk`, streaming responses, caching the static system prompt, and using server-side refusal fallbacks so a safety-classifier decline is retried on Anthropic's recommended fallback model.

## License

MIT
