#!/usr/bin/env bash
# Installs a macOS Quick Action so "Explain This" works in ANY app:
# iTerm, Terminal.app, Warp, Ghostty, a browser, Xcode, Slack... Select text,
# press the hotkey, and the explanation opens in your browser.
#
# Usage:  ./system/install-macos-quick-action.sh
# Then:   System Settings > Keyboard > Keyboard Shortcuts > Services > Text >
#         "Explain This" and assign a shortcut (Ctrl+Shift+E is a good choice).
#
# The action needs an API key that does not depend on your shell profile:
#         mkdir -p ~/.config/explain-this && echo 'sk-ant-...' > ~/.config/explain-this/api-key
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO/dist/cli.js"
NODE="$(command -v node || true)"
NAME="Explain This"
DEST="$HOME/Library/Services/$NAME.workflow"

if [[ -z "$NODE" ]]; then
  echo "node was not found on PATH. Install Node.js first." >&2
  exit 1
fi
if [[ ! -f "$CLI" ]]; then
  echo "dist/cli.js is missing. Run 'npm install && npm run build' in $REPO first." >&2
  exit 1
fi

# The shell script the Quick Action runs. Selected text arrives on stdin.
# Automator runs with a minimal environment, so node and the CLI are referenced by absolute path.
SCRIPT="export PATH=\"$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin\"
out=\$(\"$NODE\" \"$CLI\" --open --source \"selected text\" 2>&1) || osascript -e \"display notification \\\"\${out//\\\"/}\\\" with title \\\"Explain This failed\\\"\""

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
SCRIPT_XML="$(printf '%s' "$SCRIPT" | xml_escape)"

rm -rf "$DEST"
mkdir -p "$DEST/Contents"

cat > "$DEST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict>
        <key>default</key>
        <string>$NAME</string>
      </dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSSendTypes</key>
      <array>
        <string>public.utf8-plain-text</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

cat > "$DEST/Contents/document.wflow" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key>
  <string>528</string>
  <key>AMApplicationVersion</key>
  <string>2.10</string>
  <key>AMDocumentVersion</key>
  <string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Optional</key>
          <true/>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>AMActionVersion</key>
        <string>2.0.3</string>
        <key>AMApplication</key>
        <array>
          <string>Automator</string>
        </array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key>
          <dict/>
          <key>CheckedForUserDefaultShell</key>
          <dict/>
          <key>inputMethod</key>
          <dict/>
          <key>shell</key>
          <dict/>
          <key>source</key>
          <dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key>
          <string>List</string>
          <key>Types</key>
          <array>
            <string>com.apple.cocoa.string</string>
          </array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key>
        <string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>$SCRIPT_XML</string>
          <key>CheckedForUserDefaultShell</key>
          <true/>
          <key>inputMethod</key>
          <integer>0</integer>
          <key>shell</key>
          <string>/bin/bash</string>
          <key>source</key>
          <string></string>
        </dict>
        <key>BundleIdentifier</key>
        <string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key>
        <string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key>
        <false/>
        <key>CanShowWhenRun</key>
        <true/>
        <key>Category</key>
        <array>
          <string>AMCategoryUtilities</string>
        </array>
        <key>Class Name</key>
        <string>RunShellScriptAction</string>
        <key>InputUUID</key>
        <string>6F2A6D2E-0D2B-4C3E-9C58-3B0B7C6D1A01</string>
        <key>Keywords</key>
        <array>
          <string>Shell</string>
          <string>Script</string>
          <string>Command</string>
          <string>Run</string>
          <string>Unix</string>
        </array>
        <key>OutputUUID</key>
        <string>6F2A6D2E-0D2B-4C3E-9C58-3B0B7C6D1A02</string>
        <key>UUID</key>
        <string>6F2A6D2E-0D2B-4C3E-9C58-3B0B7C6D1A03</string>
        <key>UnlocalizedApplications</key>
        <array>
          <string>Automator</string>
        </array>
        <key>arguments</key>
        <dict>
          <key>0</key>
          <dict>
            <key>default value</key>
            <integer>0</integer>
            <key>name</key>
            <string>inputMethod</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>0</string>
          </dict>
          <key>1</key>
          <dict>
            <key>default value</key>
            <false/>
            <key>name</key>
            <string>CheckedForUserDefaultShell</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>1</string>
          </dict>
          <key>2</key>
          <dict>
            <key>default value</key>
            <string></string>
            <key>name</key>
            <string>source</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>2</string>
          </dict>
          <key>3</key>
          <dict>
            <key>default value</key>
            <string></string>
            <key>name</key>
            <string>COMMAND_STRING</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>3</string>
          </dict>
          <key>4</key>
          <dict>
            <key>default value</key>
            <string>/bin/sh</string>
            <key>name</key>
            <string>shell</string>
            <key>required</key>
            <string>0</string>
            <key>type</key>
            <string>0</string>
            <key>uuid</key>
            <string>4</string>
          </dict>
        </dict>
        <key>isViewVisible</key>
        <integer>1</integer>
        <key>location</key>
        <string>309.000000:253.000000</string>
        <key>nibPath</key>
        <string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>connectors</key>
  <dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>applicationBundleIDsByPath</key>
    <dict/>
    <key>applicationPaths</key>
    <array/>
    <key>inputTypeIdentifier</key>
    <string>com.apple.Automator.text</string>
    <key>outputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>presentationMode</key>
    <integer>11</integer>
    <key>processesInput</key>
    <integer>0</integer>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.text</string>
    <key>serviceOutputTypeIdentifier</key>
    <string>com.apple.Automator.nothing</string>
    <key>serviceProcessesInput</key>
    <integer>0</integer>
    <key>systemImageName</key>
    <string>NSActionTemplate</string>
    <key>useAutomaticInputType</key>
    <integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
PLIST

plutil -lint "$DEST/Contents/Info.plist" "$DEST/Contents/document.wflow" >/dev/null
# Tell the system a new service exists.
/System/Library/CoreServices/pbs -update 2>/dev/null || true

echo "Installed: $DEST"
echo
echo "Next: System Settings > Keyboard > Keyboard Shortcuts > Services > Text > \"$NAME\" and assign a hotkey."
echo "Then, in any app, select text and press it. The explanation opens in your browser."
echo
if [[ ! -f "$HOME/.config/explain-this/api-key" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Reminder: the action needs an API key at ~/.config/explain-this/api-key"
fi
