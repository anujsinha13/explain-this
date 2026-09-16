// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ExplainBubble",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ExplainBubble", path: "Sources/ExplainBubble")
    ]
)
