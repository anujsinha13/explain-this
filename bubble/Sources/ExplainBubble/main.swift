// ExplainBubble: a floating Liquid Glass bubble that shows a streamed explanation
// near the mouse cursor, on top of every other window.
//
// Protocol (JSON lines):
//   stdin  <- {"type":"start","source":"...","selected":"...","level":3}   (also used to reset)
//             {"type":"user","text":"..."}            a follow-up question, echoed by the host
//             {"type":"begin"}                        a new assistant turn is starting
//             {"type":"delta","text":"..."}           streamed text
//             {"type":"done","text":"...","label":"…"} final text (replaces the streamed buffer)
//             {"type":"error","message":"..."}
//   stdout -> {"type":"ask","text":"..."}             the user typed a follow-up
//             {"type":"level","value":7}              the user moved the technicality slider
//             {"type":"closed"}                       the bubble was dismissed
//
// Env: EXPLAIN_BUBBLE_DEBUG=1 logs to stderr; EXPLAIN_BUBBLE_NO_AUTOCLOSE=1 disables click-outside dismissal.

import AppKit
import SwiftUI

// MARK: - Layout constants

/// User zoom (⌘+ / ⌘− / ⌘0 while the bubble is open), remembered across launches.
var uiScale: CGFloat = {
    let saved = UserDefaults.standard.double(forKey: "uiScale")
    return saved > 0 ? CGFloat(saved) : 1
}()
let uiScaleRange: ClosedRange<CGFloat> = 0.7...1.8

var bubbleWidth: CGFloat { pt(700) }
var bubblePadding: CGFloat { pt(22) }
var bodySize: CGFloat { pt(17) }

/// Scales a design-size point value by the current zoom.
func pt(_ v: CGFloat) -> CGFloat { (v * uiScale).rounded() }

// MARK: - Model

struct Turn: Identifiable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
    var label: String?
    var isError = false
}

final class BubbleModel: ObservableObject {
    @Published var source = ""
    @Published var selected = ""
    @Published var turns: [Turn] = []
    @Published var streaming = false
    @Published var hostAlive = true { didSet { onRelayout?() } }
    @Published var showSelection = false { didSet { onRelayout?() } }
    @Published var level: Double = 3
    /// Natural height of the scrolling body, reported by the rendered view itself.
    @Published var contentHeight: CGFloat = 28
    /// Tallest the scrolling body may get: about four and a half lines of body text, so a
    /// long answer stays compact and the rest is a scroll away.
    var maxBodyHeight: CGFloat { (bodySize * 1.2 + 3) * 4.5 }

    var bodyHeight: CGFloat { min(max(contentHeight, 28), maxBodyHeight) }

    var onAsk: ((String) -> Void)?
    var onLevelChange: ((Int) -> Void)?
    var onClose: (() -> Void)?
    var onRelayout: (() -> Void)?
    /// Called with the bubble's full rendered height whenever it changes.
    var onHeightChange: ((CGFloat) -> Void)?

    var lastAssistantText: String? {
        turns.last(where: { $0.role == .assistant && !$0.isError })?.text
    }

    func handle(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "start":
            source = msg["source"] as? String ?? ""
            selected = msg["selected"] as? String ?? ""
            if let l = msg["level"] as? Double { level = min(10, max(1, l)) }
            turns = []
            streaming = false
        case "user":
            turns.append(Turn(role: .user, text: msg["text"] as? String ?? ""))
        case "begin":
            turns.append(Turn(role: .assistant, text: ""))
            streaming = true
        case "delta":
            let delta = msg["text"] as? String ?? ""
            if let i = turns.indices.last, turns[i].role == .assistant {
                turns[i].text += delta
            } else {
                turns.append(Turn(role: .assistant, text: delta))
                streaming = true
            }
        case "done":
            if let i = turns.indices.last, turns[i].role == .assistant {
                if let text = msg["text"] as? String { turns[i].text = text }
                turns[i].label = msg["label"] as? String
            }
            streaming = false
        case "error":
            let message = msg["message"] as? String ?? "Something went wrong."
            if let i = turns.indices.last, turns[i].role == .assistant, turns[i].text.isEmpty {
                turns[i].text = message
                turns[i].isError = true
            } else {
                turns.append(Turn(role: .assistant, text: message, isError: true))
            }
            streaming = false
        default:
            break
        }
        onRelayout?()
    }
}

// MARK: - Markdown (small block-level renderer on top of AttributedString inline markdown)

enum MDBlock {
    case paragraph(String)
    case bullet(String)
    case code(String)
}

func parseBlocks(_ markdown: String) -> [MDBlock] {
    var blocks: [MDBlock] = []
    var paragraph: [String] = []
    var code: [String]? = nil

    func flushParagraph() {
        if !paragraph.isEmpty {
            blocks.append(.paragraph(paragraph.joined(separator: " ")))
            paragraph = []
        }
    }

    for rawLine in markdown.components(separatedBy: "\n") {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("```") {
            if let c = code {
                blocks.append(.code(c.joined(separator: "\n")))
                code = nil
            } else {
                flushParagraph()
                code = []
            }
            continue
        }
        if code != nil {
            code?.append(rawLine)
            continue
        }
        if line.isEmpty {
            flushParagraph()
            continue
        }
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
            flushParagraph()
            blocks.append(.bullet(String(line.dropFirst(2))))
            continue
        }
        if let range = line.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) {
            flushParagraph()
            blocks.append(.bullet(String(line[range.upperBound...])))
            continue
        }
        var text = line
        while text.hasPrefix("#") { text.removeFirst() }
        paragraph.append(text.trimmingCharacters(in: .whitespaces))
    }
    if let c = code { blocks.append(.code(c.joined(separator: "\n"))) }
    flushParagraph()
    return blocks
}

func inline(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

struct MarkdownText: View {
    let text: String
    let streaming: Bool

    var body: some View {
        let blocks = parseBlocks(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                let cursor = index == blocks.count - 1 && streaming ? " ▍" : ""
                switch block {
                case .paragraph(let s):
                    Text(inline(s + cursor))
                        .font(.system(size: bodySize))
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").font(.system(size: bodySize)).foregroundStyle(.secondary)
                        Text(inline(s + cursor))
                            .font(.system(size: bodySize))
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .code(let s):
                    Text(s)
                        .font(.system(size: bodySize - 2, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            if blocks.isEmpty && streaming {
                Text("Thinking…").font(.system(size: bodySize)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Height reporting

/// Reads a view's rendered height without affecting its layout.
struct BodyHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct TotalHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

extension View {
    func reportHeight<K: PreferenceKey>(_ key: K.Type, _ action: @escaping (CGFloat) -> Void) -> some View where K.Value == CGFloat {
        background(GeometryReader { g in Color.clear.preference(key: key, value: g.size.height) })
            .onPreferenceChange(key) { action($0) }
    }
}

// MARK: - Views

/// The scrolling part: selected text (optional) and the conversation turns.
/// Kept separate so the controller can measure it offscreen at the bubble's width.
struct BodyContent: View {
    @ObservedObject var model: BubbleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.showSelection {
                Text(model.selected)
                    .font(.system(size: pt(14), design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            ForEach(model.turns) { turn in
                turnView(turn)
            }
        }
        .frame(width: bubbleWidth - 2 * bubblePadding, alignment: .leading)
        .reportHeight(BodyHeightKey.self) { h in
            if abs(h - model.contentHeight) > 0.5 { model.contentHeight = h }
        }
    }

    @ViewBuilder
    private func turnView(_ turn: Turn) -> some View {
        switch turn.role {
        case .user:
            Text(turn.text)
                .font(.system(size: bodySize))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            VStack(alignment: .leading, spacing: 4) {
                MarkdownText(text: turn.text, streaming: model.streaming && turn.id == model.turns.last?.id)
                    .foregroundStyle(turn.isError ? Color.red : Color.primary)
                if let label = turn.label, !label.isEmpty {
                    Text(label).font(.system(size: pt(12))).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

struct BubbleView: View {
    @ObservedObject var model: BubbleModel
    @State private var question = ""
    @State private var levelEmitter: DispatchWorkItem?
    @FocusState private var askFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            levelRow
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        BodyContent(model: model)
                        Color.clear.frame(height: 1).id("bottom")
                    }
                }
                .frame(height: model.bodyHeight)
                .onChange(of: model.contentHeight) { _, _ in
                    guard model.turns.count > 1 else { return }
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            if model.hostAlive { askField }
        }
        .padding(bubblePadding)
        .frame(width: bubbleWidth)
        .modifier(GlassBackground())
        .reportHeight(TotalHeightKey.self) { h in model.onHeightChange?(h) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").foregroundStyle(.secondary)
            Text(model.source.isEmpty ? "Explain This" : model.source)
                .font(.system(size: pt(13))).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Spacer()
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { model.showSelection.toggle() }
            } label: {
                Image(systemName: model.showSelection ? "eye.slash" : "eye").font(.system(size: pt(15)))
            }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Show the selected text")
            Button {
                if let t = model.lastAssistantText {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(t, forType: .string)
                }
            } label: { Image(systemName: "doc.on.doc").font(.system(size: pt(15))) }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Copy explanation")
            Button { model.onClose?() } label: { Image(systemName: "xmark").font(.system(size: pt(15), weight: .medium)) }
                .buttonStyle(.plain).foregroundStyle(.secondary).help("Close (Esc) · zoom with ⌘+ / ⌘−")
                .keyboardShortcut(.cancelAction)
        }
    }

    private var levelRow: some View {
        HStack(spacing: 10) {
            Text("Plain").font(.system(size: pt(13))).foregroundStyle(.secondary)
            Slider(value: $model.level, in: 1...10, step: 1)
                .controlSize(.small)
            Text("Technical").font(.system(size: pt(13))).foregroundStyle(.secondary)
            Text("\(Int(model.level))")
                .font(.system(size: pt(13), weight: .semibold, design: .rounded))
                .monospacedDigit()
                .frame(width: pt(26))
                .padding(.vertical, 2)
                .background(Color.primary.opacity(0.08), in: Capsule())
        }
        .onChange(of: model.level) { _, newValue in
            // Wait for the drag to settle, then ask the host to re-explain at this level.
            levelEmitter?.cancel()
            let item = DispatchWorkItem { model.onLevelChange?(Int(newValue)) }
            levelEmitter = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
        }
    }

    private var askField: some View {
        HStack(spacing: 8) {
            TextField("Ask a follow-up…", text: $question)
                .textFieldStyle(.plain)
                .font(.system(size: bodySize))
                .focused($askFocused)
                .onSubmit(submit)
                .disabled(model.streaming)
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: pt(22)))
            }
            .buttonStyle(.plain)
            .disabled(model.streaming || question.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(Color.primary.opacity(0.06), in: Capsule())
    }

    private func submit() {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !model.streaming else { return }
        question = ""
        model.onAsk?(q)
    }
}

struct GlassBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: .rect(cornerRadius: 28))
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 28))
                .overlay(RoundedRectangle(cornerRadius: 28).strokeBorder(Color.white.opacity(0.25), lineWidth: 0.5))
        }
    }
}

// MARK: - Window

final class BubblePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class BubbleController {
    let model = BubbleModel()
    let panel: BubblePanel
    let hosting: NSHostingView<BubbleView>
    let debug = ProcessInfo.processInfo.environment["EXPLAIN_BUBBLE_DEBUG"] != nil
    private var monitors: [Any] = []
    private var closed = false
    private var shownAt = Date.distantFuture
    private var anchorTop: CGFloat = 0
    private var anchorLeft: CGFloat = 0

    init() {
        hosting = NSHostingView(rootView: BubbleView(model: model))
        // The window is sized from the height the SwiftUI view reports; keep AppKit's constraints out of it.
        hosting.sizingOptions = []
        panel = BubblePanel(
            contentRect: NSRect(x: 0, y: 0, width: bubbleWidth, height: 200),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = hosting

        model.onRelayout = { [weak self] in self?.relayout() }
        model.onHeightChange = { [weak self] h in
            // Preference changes arrive mid-layout; resize the window on the next runloop turn.
            DispatchQueue.main.async { self?.resize(toHeight: h) }
        }
        model.onClose = { [weak self] in self?.close() }
        model.onLevelChange = { level in emit(["type": "level", "value": level]) }
        model.onAsk = { [weak self] q in
            self?.model.handle(["type": "user", "text": q])
            self?.model.streaming = true
            emit(["type": "ask", "text": q])
        }

        // Esc closes when the bubble has keyboard focus; ⌘+ / ⌘− / ⌘0 zoom the bubble.
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if event.keyCode == 53 { self.close(); return nil }
            if event.modifierFlags.contains(.command) {
                switch event.charactersIgnoringModifiers {
                case "=", "+": self.zoom(to: uiScale + 0.1); return nil
                case "-", "_": self.zoom(to: uiScale - 0.1); return nil
                case "0": self.zoom(to: 1); return nil
                default: break
                }
            }
            return event
        } as Any)
        // A click anywhere outside the bubble closes it (after a short grace period so a
        // click that was already in flight when the bubble appeared does not dismiss it).
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self, Date().timeIntervalSince(self.shownAt) > 0.6 else { return }
            if ProcessInfo.processInfo.environment["EXPLAIN_BUBBLE_NO_AUTOCLOSE"] != nil { return }
            if !self.panel.frame.contains(NSEvent.mouseLocation) { self.close() }
        } as Any)
    }

    /// Changes the zoom, persists it, and rebuilds the view tree at the new size.
    func zoom(to scale: CGFloat) {
        let clamped = min(max(scale, uiScaleRange.lowerBound), uiScaleRange.upperBound)
        guard clamped != uiScale else { return }
        uiScale = clamped
        UserDefaults.standard.set(Double(clamped), forKey: "uiScale")
        hosting.rootView = BubbleView(model: model)
    }

    func show() {
        let mouse = NSEvent.mouseLocation
        anchorLeft = mouse.x + 16
        anchorTop = mouse.y - 16
        panel.setFrame(clamped(NSRect(x: anchorLeft, y: anchorTop - 200, width: bubbleWidth, height: 200)), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        shownAt = Date()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 1
        }
    }

    /// Re-applies the current height (used after model changes that do not alter the view's height).
    func relayout() {
        guard !closed, lastHeight > 0 else { return }
        resize(toHeight: lastHeight)
    }

    private var lastHeight: CGFloat = 0

    /// Sizes and positions the window to the height the SwiftUI view reported.
    func resize(toHeight height: CGFloat) {
        guard !closed, height > 0 else { return }
        lastHeight = height
        if debug {
            FileHandle.standardError.write("debug: content \(model.contentHeight) -> body \(model.bodyHeight), window height \(height)\n".data(using: .utf8)!)
        }
        let frame = clamped(NSRect(x: anchorLeft, y: anchorTop - height, width: bubbleWidth, height: height))
        if frame != panel.frame {
            panel.setFrame(frame, display: true, animate: false)
        }
    }

    /// Keeps the bubble anchored at its top-left corner and inside the visible screen.
    private func clamped(_ proposed: NSRect) -> NSRect {
        var frame = proposed
        let anchor = NSPoint(x: anchorLeft, y: anchorTop)
        let screen = NSScreen.screens.first { NSMouseInRect(anchor, $0.frame, false) } ?? panel.screen ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return frame }
        if frame.maxX > visible.maxX { frame.origin.x = max(visible.minX, anchorLeft - frame.width - 32) }
        if frame.origin.x < visible.minX { frame.origin.x = visible.minX }
        if frame.minY < visible.minY { frame.origin.y = visible.minY }
        if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height }
        return frame
    }

    func close() {
        guard !closed else { return }
        if debug {
            FileHandle.standardError.write(("close() called from:\n" + Thread.callStackSymbols.prefix(4).joined(separator: "\n") + "\n").data(using: .utf8)!)
        }
        closed = true
        for m in monitors { NSEvent.removeMonitor(m) }
        emit(["type": "closed"])
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            panel.animator().alphaValue = 0
        }, completionHandler: {
            self.panel.orderOut(nil)
            NSApp.terminate(nil)
        })
    }
}

// MARK: - IO

func emit(_ msg: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: msg),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func startReadingStdin(_ controller: BubbleController) {
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            DispatchQueue.main.async { controller.model.handle(obj) }
        }
        DispatchQueue.main.async {
            controller.model.streaming = false
            controller.model.hostAlive = false
        }
    }
}

// MARK: - Main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = BubbleController()
startReadingStdin(controller)
controller.show()
app.run()
