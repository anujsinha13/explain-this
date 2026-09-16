// ExplainBubble: a floating Liquid Glass bubble that shows a streamed explanation
// near the mouse cursor, on top of every other window.
//
// Protocol (JSON lines):
//   stdin  <- {"type":"start","source":"...","selected":"..."}
//             {"type":"user","text":"..."}            a follow-up question, echoed by the host
//             {"type":"begin"}                        a new assistant turn is starting
//             {"type":"delta","text":"..."}           streamed text
//             {"type":"done","text":"...","label":"…"} final text (replaces the streamed buffer)
//             {"type":"error","message":"..."}
//   stdout -> {"type":"ask","text":"..."}             the user typed a follow-up
//             {"type":"closed"}                       the bubble was dismissed

import AppKit
import SwiftUI

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
    @Published var hostAlive = true
    @Published var showSelection = false

    var onAsk: ((String) -> Void)?
    var onClose: (() -> Void)?
    var onLayoutChange: (() -> Void)?

    var lastAssistantText: String? {
        turns.last(where: { $0.role == .assistant && !$0.isError })?.text
    }

    func handle(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "start":
            source = msg["source"] as? String ?? ""
            selected = msg["selected"] as? String ?? ""
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
        onLayoutChange?()
    }
}

// MARK: - Markdown (small, block-level renderer on top of AttributedString inline markdown)

enum MDBlock: Identifiable {
    case paragraph(String)
    case bullet(String)
    case code(String)

    var id: String {
        switch self {
        case .paragraph(let s): return "p" + s
        case .bullet(let s): return "b" + s
        case .code(let s): return "c" + s
        }
    }
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
        while text.hasPrefix("#") { text.removeFirst() }  // headings are not requested, but be safe
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
                let isLast = index == blocks.count - 1
                switch block {
                case .paragraph(let s):
                    Text(inline(s + (isLast && streaming ? " ▍" : "")))
                        .textSelection(.enabled)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inline(s + (isLast && streaming ? " ▍" : "")))
                            .textSelection(.enabled)
                    }
                case .code(let s):
                    Text(s)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            if blocks.isEmpty && streaming {
                Text("Thinking…").foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - View

struct HeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct BubbleView: View {
    @ObservedObject var model: BubbleModel
    @State private var question = ""
    @State private var contentHeight: CGFloat = 0
    @FocusState private var askFocused: Bool

    private let width: CGFloat = 440
    private let maxBodyHeight: CGFloat = 460

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if model.showSelection {
                            Text(model.selected)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                        }
                        ForEach(model.turns) { turn in
                            turnView(turn)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .background(GeometryReader { g in
                        Color.clear.preference(key: HeightKey.self, value: g.size.height)
                    })
                }
                .frame(height: min(max(contentHeight, 24), maxBodyHeight))
                .onPreferenceChange(HeightKey.self) { h in
                    contentHeight = h
                    DispatchQueue.main.async { model.onLayoutChange?() }
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            if model.hostAlive { askField }
        }
        .padding(16)
        .frame(width: width)
        .modifier(GlassBackground())
        .onChange(of: model.turns.count) { _, _ in model.onLayoutChange?() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").foregroundStyle(.secondary)
            Text(model.source.isEmpty ? "Explain This" : model.source)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Spacer()
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { model.showSelection.toggle() }
            } label: {
                Image(systemName: model.showSelection ? "eye.slash" : "eye")
            }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Show the selected text")
            Button {
                if let t = model.lastAssistantText {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(t, forType: .string)
                }
            } label: { Image(systemName: "doc.on.doc") }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Copy explanation")
            Button { model.onClose?() } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(.secondary).help("Close (Esc)")
                .keyboardShortcut(.cancelAction)
        }
    }

    @ViewBuilder
    private func turnView(_ turn: Turn) -> some View {
        switch turn.role {
        case .user:
            Text(turn.text)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant:
            VStack(alignment: .leading, spacing: 4) {
                MarkdownText(text: turn.text, streaming: model.streaming && turn.id == model.turns.last?.id)
                    .foregroundStyle(turn.isError ? Color.red : Color.primary)
                if let label = turn.label, !label.isEmpty {
                    Text(label).font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private var askField: some View {
        HStack(spacing: 8) {
            TextField("Ask a follow-up…", text: $question)
                .textFieldStyle(.plain)
                .focused($askFocused)
                .onSubmit(submit)
                .disabled(model.streaming)
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill").font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(model.streaming || question.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
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
            content.glassEffect(.regular, in: .rect(cornerRadius: 26))
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26))
                .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(Color.white.opacity(0.25), lineWidth: 0.5))
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
    private var monitors: [Any] = []
    private var closed = false
    private var shownAt = Date.distantFuture
    private let debug = ProcessInfo.processInfo.environment["EXPLAIN_BUBBLE_DEBUG"] != nil

    init() {
        hosting = NSHostingView(rootView: BubbleView(model: model))
        panel = BubblePanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 120),
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

        model.onLayoutChange = { [weak self] in self?.resize() }
        model.onClose = { [weak self] in self?.close() }
        model.onAsk = { [weak self] q in
            self?.model.handle(["type": "user", "text": q])
            self?.model.streaming = true
            emit(["type": "ask", "text": q])
        }

        // Esc closes when the bubble has keyboard focus.
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.close(); return nil }
            return event
        } as Any)
        // A click anywhere outside the bubble closes it (after a short grace period so a
        // click that was already in flight when the bubble appeared does not dismiss it).
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self, Date().timeIntervalSince(self.shownAt) > 0.6 else { return }
            if !self.panel.frame.contains(NSEvent.mouseLocation) { self.close() }
        } as Any)
    }

    func show() {
        placeNearMouse()
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        shownAt = Date()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 1
        }
        if debug {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self else { return }
                let s = "debug: visible=\(self.panel.isVisible) onScreen=\(self.panel.isOnActiveSpace) frame=\(self.panel.frame) screen=\(String(describing: self.panel.screen?.frame))\n"
                FileHandle.standardError.write(s.data(using: .utf8)!)
            }
        }
    }

    private func placeNearMouse() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = hosting.fittingSize
        var origin = NSPoint(x: mouse.x + 14, y: mouse.y - 14 - size.height)
        if origin.x + size.width > visible.maxX { origin.x = max(visible.minX, mouse.x - size.width - 14) }
        if origin.y < visible.minY { origin.y = min(visible.maxY - size.height, mouse.y + 14) }
        origin.y = max(visible.minY, origin.y)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    func resize() {
        guard !closed else { return }
        let size = hosting.fittingSize
        guard size.height > 0, abs(size.height - panel.frame.height) > 0.5 || abs(size.width - panel.frame.width) > 0.5 else { return }
        var frame = panel.frame
        let top = frame.maxY
        frame.size = size
        frame.origin.y = top - size.height
        if let screen = panel.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            if frame.minY < visible.minY { frame.origin.y = visible.minY }
            if frame.maxY > visible.maxY { frame.origin.y = visible.maxY - frame.height }
        }
        panel.setFrame(frame, display: true, animate: false)
    }

    func close() {
        guard !closed else { return }
        if ProcessInfo.processInfo.environment["EXPLAIN_BUBBLE_DEBUG"] != nil {
            FileHandle.standardError.write(("close() called from:\n" + Thread.callStackSymbols.joined(separator: "\n") + "\n").data(using: .utf8)!)
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
            controller.model.hostAlive = false
            controller.model.streaming = false
            controller.model.onLayoutChange?()
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
