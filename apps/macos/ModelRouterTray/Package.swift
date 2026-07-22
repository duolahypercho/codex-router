// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "ModelRouterTray",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "ModelRouterTray", targets: ["ModelRouterTray"]),
  ],
  targets: [
    .executableTarget(
      name: "ModelRouterTray",
      path: "Sources",
      resources: [.process("Resources")]
    ),
  ],
)
