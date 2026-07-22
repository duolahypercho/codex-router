import AppKit
import CoreVideo
import QuartzCore
import SwiftUI

/// Compact dotted "working" thinking orb adapted from https://orbs.jakubantalik.com/
/// for the Dynamic Island generating state.
final class ThinkingOrbRenderer {
  private let size: CGFloat
  private let speed: CGFloat
  private let dark: Bool

  init(size: CGFloat = 18, speed: CGFloat = 3.9, dark: Bool = true) {
    self.size = size
    self.speed = speed
    self.dark = dark
  }

  func draw(in ctx: CGContext, time: CGFloat) {
    ctx.clear(CGRect(x: 0, y: 0, width: size, height: size))
    drawOrbits(in: ctx, time: time)
  }

  private func hash(_ seed: Int, _ salt: CGFloat) -> CGFloat {
    let n = sin(CGFloat(seed) * 12.9898 + salt * 78.233) * 43758.5453
    return n - floor(n)
  }

  private func radiusScale(power: CGFloat = 0.6) -> CGFloat {
    pow(size / 300, power)
  }

  private func projectPoint(
    yaw: CGFloat,
    pitch: CGFloat,
    x: CGFloat,
    y: CGFloat,
    z: CGFloat
  ) -> (CGFloat, CGFloat, CGFloat) {
    let center = size / 2
    let sinPitch = sin(pitch)
    let cosPitch = cos(pitch)
    let sinYaw = sin(yaw)
    let cosYaw = cos(yaw)
    let x1 = x * cosYaw + z * sinYaw
    let z1 = -x * sinYaw + z * cosYaw
    let y1 = y * cosPitch - z1 * sinPitch
    let z2 = y * sinPitch + z1 * cosPitch
    return (center + x1, center - y1, z2)
  }

  private struct Dot {
    var x: CGFloat
    var y: CGFloat
    var z: CGFloat
    var r: CGFloat
    var white: CGFloat
    var a: CGFloat
  }

  private func drawOrbits(in ctx: CGContext, time: CGFloat) {
    let radius = (size / 2) * 0.82
    let scale = radiusScale()
    var dots: [Dot] = []

    let orbitCount = 4
    let ghostCount = 16
    let particleCount = 3
    let ghostRadius = 0.9 * 2.4 * scale
    let ghostAlpha: CGFloat = 0.5
    let particleRadius = 1.2 * 2.4
    let particleDepth = 1.6 * 2.4
    let minRadius: CGFloat = 0.3
    let yaw = time * 0.12
    let pitch: CGFloat = 0.3

    for orbit in 0..<orbitCount {
      let a = hash(orbit, 1.7)
      let b = hash(orbit, 5.2)
      let c = hash(orbit, 8.9)
      let orbitRadius = radius * (0.45 + 0.52 * a)
      let theta = a * 2 * .pi
      let phi = acos(2 * b - 1)
      let nx = sin(phi) * cos(theta)
      let ny = cos(phi)
      let nz = sin(phi) * sin(theta)

      var tx = -ny
      var ty = nx
      let tLen = max(1e-6, sqrt(tx * tx + ty * ty))
      tx /= tLen
      ty /= tLen
      let bx = -nz * ty
      let by = nz * tx
      let bz = nx * ty - ny * tx
      let orbitSpeed = (0.25 + 0.55 * c) * (c > 0.5 ? 1 : -1)

      for ghost in 0..<ghostCount {
        let angle = CGFloat(ghost) / CGFloat(ghostCount) * 2 * .pi
        let px = (tx * cos(angle) + bx * sin(angle)) * orbitRadius
        let py = (ty * cos(angle) + by * sin(angle)) * orbitRadius
        let pz = (bz * sin(angle)) * orbitRadius
        let (x, y, z) = projectPoint(yaw: yaw, pitch: pitch, x: px, y: py, z: pz)
        let depth = (z / orbitRadius + 1) / 2
        dots.append(
          Dot(
            x: x,
            y: y,
            z: z,
            r: ghostRadius,
            white: 0.72,
            a: ghostAlpha * (0.4 + 0.6 * depth)
          )
        )
      }

      for particle in 0..<particleCount {
        let angle =
          time * orbitSpeed + CGFloat(particle) / CGFloat(particleCount) * 2 * .pi + b * 6
        let px = (tx * cos(angle) + bx * sin(angle)) * orbitRadius
        let py = (ty * cos(angle) + by * sin(angle)) * orbitRadius
        let pz = (bz * sin(angle)) * orbitRadius
        let (x, y, z) = projectPoint(yaw: yaw, pitch: pitch, x: px, y: py, z: pz)
        let depth = (z / orbitRadius + 1) / 2
        dots.append(
          Dot(
            x: x,
            y: y,
            z: z,
            r: (particleRadius + particleDepth * depth) * scale,
            white: 0.3 - 0.22 * depth,
            a: 1
          )
        )
      }
    }

    dots.sort { $0.z < $1.z }
    for dot in dots {
      if dot.a < 0.02 { continue }
      let white = min(1, max(0, dot.white))
      let tone = (dark ? 1 - white : white)
      let color = NSColor(white: tone, alpha: dot.a)
      ctx.setFillColor(color.cgColor)
      let radius = max(minRadius, dot.r)
      ctx.fillEllipse(
        in: CGRect(x: dot.x - radius, y: dot.y - radius, width: radius * 2, height: radius * 2)
      )
    }
  }
}

final class ThinkingOrbNSView: NSView {
  private let renderer: ThinkingOrbRenderer
  private var displayLink: CVDisplayLink?
  private var startTime = CACurrentMediaTime()
  private var running = false
  var reduceMotion = false {
    didSet { setNeedsDisplay(bounds) }
  }

  init(size: CGFloat = 18) {
    self.renderer = ThinkingOrbRenderer(size: size)
    super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  deinit {
    stop()
  }

  override var isFlipped: Bool { true }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil {
      stop()
    } else if running {
      start()
    }
  }

  func setRunning(_ value: Bool) {
    if value {
      start()
    } else {
      stop()
      setNeedsDisplay(bounds)
    }
  }

  private func start() {
    running = true
    guard !reduceMotion else {
      setNeedsDisplay(bounds)
      return
    }
    guard displayLink == nil else { return }
    startTime = CACurrentMediaTime()
    var link: CVDisplayLink?
    CVDisplayLinkCreateWithActiveCGDisplays(&link)
    guard let link else { return }
    displayLink = link
    let unmanaged = Unmanaged.passUnretained(self)
    CVDisplayLinkSetOutputCallback(
      link,
      { _, _, _, _, _, userInfo in
        guard let userInfo else { return kCVReturnSuccess }
        let view = Unmanaged<ThinkingOrbNSView>.fromOpaque(userInfo).takeUnretainedValue()
        DispatchQueue.main.async {
          view.setNeedsDisplay(view.bounds)
        }
        return kCVReturnSuccess
      },
      unmanaged.toOpaque()
    )
    CVDisplayLinkStart(link)
  }

  private func stop() {
    running = false
    if let displayLink {
      CVDisplayLinkStop(displayLink)
      self.displayLink = nil
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let elapsed = CGFloat(CACurrentMediaTime() - startTime)
    let time = reduceMotion || !running ? 0.6 : elapsed * rendererSpeed
    renderer.draw(in: ctx, time: time)
  }

  private var rendererSpeed: CGFloat { 3.9 }
}

struct ThinkingOrbView: NSViewRepresentable {
  var active: Bool
  var reduceMotion: Bool
  var size: CGFloat = 18

  func makeNSView(context: Context) -> ThinkingOrbNSView {
    let view = ThinkingOrbNSView(size: size)
    view.reduceMotion = reduceMotion
    view.setRunning(active)
    return view
  }

  func updateNSView(_ nsView: ThinkingOrbNSView, context: Context) {
    nsView.reduceMotion = reduceMotion
    nsView.setRunning(active)
  }
}
