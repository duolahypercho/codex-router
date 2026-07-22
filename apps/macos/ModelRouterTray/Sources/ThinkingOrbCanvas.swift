import AppKit
import CoreVideo
import QuartzCore
import SwiftUI

enum ThinkingOrbMode {
  case shaping
  case composing
  case solving
}

/// Compact dotted Thinking Orbs renderers adapted from https://orbs.jakubantalik.com/
/// for the Dynamic Island.
final class ThinkingOrbRenderer {
  private let size: CGFloat
  private let dark: Bool

  init(size: CGFloat = 18, dark: Bool = true) {
    self.size = size
    self.dark = dark
  }

  func draw(in ctx: CGContext, time: CGFloat, mode: ThinkingOrbMode) {
    ctx.clear(CGRect(x: 0, y: 0, width: size, height: size))
    switch mode {
    case .shaping:
      drawMorph(in: ctx, time: time)
    case .composing:
      drawComposing(in: ctx, time: time)
    case .solving:
      drawSolving(in: ctx, time: time)
    }
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

  private struct Perimeter {
    let points: [CGPoint]
    let lengths: [CGFloat]
    let total: CGFloat

    init(_ points: [CGPoint]) {
      self.points = points
      var lengths: [CGFloat] = []
      var total: CGFloat = 0
      for index in points.indices {
        let current = points[index]
        let next = points[(index + 1) % points.count]
        let length = hypot(next.x - current.x, next.y - current.y)
        lengths.append(length)
        total += length
      }
      self.lengths = lengths
      self.total = total
    }

    func sample(_ amount: CGFloat) -> CGPoint {
      var distance = amount * total
      var index = 0
      while distance > lengths[index], index < points.count - 1 {
        distance -= lengths[index]
        index += 1
      }
      let current = points[index]
      let next = points[(index + 1) % points.count]
      let progress = lengths[index] > 0 ? min(1, distance / lengths[index]) : 0
      return CGPoint(
        x: current.x + (next.x - current.x) * progress,
        y: current.y + (next.y - current.y) * progress
      )
    }
  }

  private struct RubikMove {
    let axis: Int
    let low: CGFloat
    let high: CGFloat
    let angle: CGFloat
  }

  private struct RubikTimeline {
    let amounts: [CGFloat]
    let active: Int
  }

  private static let triangle = Perimeter(
    [CGPoint(x: 0, y: -0.26), CGPoint(x: 0.24, y: 0.16), CGPoint(x: -0.24, y: 0.16)]
  )
  private static let square = Perimeter(
    [
      CGPoint(x: 0, y: -0.2),
      CGPoint(x: 0.2, y: -0.2),
      CGPoint(x: 0.2, y: 0.2),
      CGPoint(x: -0.2, y: 0.2),
      CGPoint(x: -0.2, y: -0.2),
    ]
  )

  private lazy var rubikMoves = buildRubikMoves(count: 14)

  private func smoothStep(_ value: CGFloat) -> CGFloat {
    value * value * (3 - 2 * value)
  }

  private func morphShapePoint(_ index: Int, amount: CGFloat) -> CGPoint {
    switch index {
    case 0:
      let angle = -.pi / 2 + amount * 2 * .pi
      return CGPoint(x: cos(angle) * 0.24, y: sin(angle) * 0.24)
    case 1:
      return Self.triangle.sample(amount)
    default:
      return Self.square.sample(amount)
    }
  }

  private func drawMorph(in ctx: CGContext, time: CGFloat) {
    let hold: CGFloat = 1.4
    let transition: CGFloat = 0.9
    let segmentDuration = hold + transition
    let shapeCount = 3
    let cycle = time.truncatingRemainder(dividingBy: segmentDuration * CGFloat(shapeCount))
    let shapeIndex = Int(floor(cycle / segmentDuration))
    let segmentTime = cycle - CGFloat(shapeIndex) * segmentDuration
    let blend = segmentTime > hold
      ? smoothStep((segmentTime - hold) / transition)
      : 0
    let nextShapeIndex = (shapeIndex + 1) % shapeCount
    let spread: CGFloat = 1.45
    let pathCount = 160
    var path: [CGPoint] = []

    for index in 0..<pathCount {
      let amount = CGFloat(index) / CGFloat(pathCount)
      let current = morphShapePoint(shapeIndex, amount: amount)
      let next = morphShapePoint(nextShapeIndex, amount: amount)
      path.append(
        CGPoint(
          x: (current.x + (next.x - current.x) * blend) * spread,
          y: (current.y + (next.y - current.y) * blend) * spread
        )
      )
    }

    var lengths: [CGFloat] = []
    var total: CGFloat = 0
    for index in 0..<pathCount {
      let current = path[index]
      let next = path[(index + 1) % pathCount]
      let length = hypot(next.x - current.x, next.y - current.y)
      lengths.append(length)
      total += length
    }

    let pointCount = 18
    let dotRadius = 0.021 * 1.011 * 1.35 * spread * size
    let breathe = 1 + 0.02 * sin(segmentTime * 3.1)
    let center = size / 2
    var dots: [Dot] = []
    var pathIndex = 0
    var traversed: CGFloat = 0

    for index in 0..<pointCount {
      let target = CGFloat(index) / CGFloat(pointCount) * total
      while traversed + lengths[pathIndex] < target, pathIndex < pathCount - 1 {
        traversed += lengths[pathIndex]
        pathIndex += 1
      }
      let current = path[pathIndex]
      let next = path[(pathIndex + 1) % pathCount]
      let progress = lengths[pathIndex] > 0
        ? min(1, (target - traversed) / lengths[pathIndex])
        : 0
      let x = (current.x + (next.x - current.x) * progress) * breathe
      let y = (current.y + (next.y - current.y) * progress) * breathe
      dots.append(
        Dot(
          x: center + x * size,
          y: center + y * size,
          z: 0,
          r: max(0.35, dotRadius),
          white: 0.1,
          a: 1
        )
      )
    }

    paintDots(in: ctx, dots: dots, minRadius: 0.25)
  }

  private func fibonacciSphere(index: Int, count: Int) -> (CGFloat, CGFloat, CGFloat) {
    let goldenAngle = CGFloat.pi * (3 - sqrt(5))
    let y = 1 - 2 * (CGFloat(index) + 0.5) / CGFloat(count)
    let radius = sqrt(1 - y * y)
    let angle = CGFloat(index) * goldenAngle
    return (radius * cos(angle), y, radius * sin(angle))
  }

  private func buildRubikMoves(count: Int) -> [RubikMove] {
    var moves: [RubikMove] = []
    for index in 0..<count {
      let axis = min(2, Int(floor(hash(index, 2.3) * 3)))
      let low = -1 + 0.5 * min(3, floor(hash(index, 5.9) * 4))
      let direction: CGFloat = hash(index, 7.7) < 0.5 ? 1 : -1
      moves.append(
        RubikMove(axis: axis, low: low, high: low + 0.5, angle: direction * .pi / 2)
      )
    }
    return moves
  }

  private func rubikTimeline(time: CGFloat) -> RubikTimeline {
    let moveDuration: CGFloat = 0.42
    let pause: CGFloat = 1.2
    let cycleDuration = 2 * CGFloat(rubikMoves.count) * moveDuration + pause
    let cycle = time.truncatingRemainder(dividingBy: cycleDuration)
    var amounts = Array(repeating: CGFloat(0), count: rubikMoves.count)
    var active = -1

    if cycle < 2 * CGFloat(rubikMoves.count) * moveDuration {
      let step = Int(floor(cycle / moveDuration))
      let progress = (cycle - CGFloat(step) * moveDuration) / moveDuration
      let eased = 1 - pow(1 - min(1, progress / 0.7), 3)
      if step < rubikMoves.count {
        for index in 0..<step { amounts[index] = 1 }
        amounts[step] = eased
        active = step
      } else {
        let reverse = 2 * rubikMoves.count - 1 - step
        for index in 0..<reverse { amounts[index] = 1 }
        amounts[reverse] = 1 - eased
        active = reverse
      }
    }
    return RubikTimeline(amounts: amounts, active: active)
  }

  private func applyRubikMoves(
    x initialX: CGFloat,
    y initialY: CGFloat,
    z initialZ: CGFloat,
    timeline: RubikTimeline
  ) -> (x: CGFloat, y: CGFloat, z: CGFloat, active: Bool) {
    var x = initialX
    var y = initialY
    var z = initialZ
    var active = false
    for index in rubikMoves.indices {
      let amount = timeline.amounts[index]
      if amount <= 0 { continue }
      let move = rubikMoves[index]
      let coordinate = move.axis == 0 ? x : move.axis == 1 ? y : z
      if coordinate < move.low || coordinate >= move.high { continue }
      if index == timeline.active { active = true }
      let angle = move.angle * amount
      let cosine = cos(angle)
      let sine = sin(angle)
      if move.axis == 0 {
        let nextY = y * cosine - z * sine
        z = y * sine + z * cosine
        y = nextY
      } else if move.axis == 1 {
        let nextX = x * cosine + z * sine
        z = -x * sine + z * cosine
        x = nextX
      } else {
        let nextX = x * cosine - y * sine
        y = x * sine + y * cosine
        x = nextX
      }
    }
    return (x, y, z, active)
  }

  private func drawSolving(in ctx: CGContext, time: CGFloat) {
    let radius = (size / 2) * 0.82
    let scale = radiusScale()
    let timeline = rubikTimeline(time: time)
    let latitudeRings = 4
    let longitudeDensity = 12
    let yaw = time * 0.55
    let pitch = 0.35 + 0.1 * sin(time * 0.9)
    var dots: [Dot] = []

    for latitude in 0...latitudeRings {
      let latitudeAngle = -.pi / 2 + CGFloat(latitude) / CGFloat(latitudeRings) * .pi
      let ringRadius = cos(latitudeAngle)
      let ringY = sin(latitudeAngle)
      let pointCount = max(1, Int(round(abs(ringRadius) * CGFloat(longitudeDensity))))
      for longitude in 0..<pointCount {
        let angle = CGFloat(longitude) / CGFloat(pointCount) * 2 * .pi
        let transformed = applyRubikMoves(
          x: ringRadius * cos(angle),
          y: ringY,
          z: ringRadius * sin(angle),
          timeline: timeline
        )
        let (x, y, z) = projectPoint(
          yaw: yaw,
          pitch: pitch,
          x: transformed.x * radius,
          y: transformed.y * radius,
          z: transformed.z * radius
        )
        let depth = (z / radius + 1) / 2
        dots.append(
          Dot(
            x: x,
            y: y,
            z: z,
            r: (1.14 + 3.23 * depth + (transformed.active ? 0.57 : 0)) * scale,
            white: 0.62 - 0.54 * depth - (transformed.active ? 0.14 : 0),
            a: 1
          )
        )
      }
    }

    paintDots(in: ctx, dots: dots, minRadius: 0.3)
  }

  private func drawComposing(in ctx: CGContext, time: CGFloat) {
    let radius = (size / 2) * 0.78
    let scale = radiusScale()
    var dots: [Dot] = []
    let ghostCount = 8

    for index in 0..<ghostCount {
      let point = fibonacciSphere(index: index, count: ghostCount)
      let (x, y, z) = projectPoint(
        yaw: 0,
        pitch: 0.3,
        x: point.0 * radius,
        y: point.1 * radius,
        z: point.2 * radius
      )
      let depth = (z / radius + 1) / 2
      dots.append(Dot(x: x, y: y, z: z, r: 0.8 * scale, white: 0.78, a: 0.1 + 0.22 * depth))
    }

    let tilt: CGFloat = 0.55
    let cosTilt = cos(tilt)
    let sinTilt = sin(tilt)
    let bandCount = 10
    let segmentCount = 20
    for band in 0..<bandCount {
      let offsetBase = (CGFloat(band) - CGFloat(bandCount - 1) / 2) * 0.075
      let edge = abs(CGFloat(band) - CGFloat(bandCount - 1) / 2)
        / (CGFloat(bandCount - 1) / 2)
      for segment in 0..<segmentCount {
        let angle = CGFloat(segment) / CGFloat(segmentCount) * 2 * .pi
        let wobble = 0.16 * sin(angle * 3 - time * 1.7 + CGFloat(band) * 0.22)
          + 0.07 * sin(angle * 5 + time * 1.1)
        let offset = offsetBase + wobble
        let px = cos(angle)
        let py = cosTilt * sin(angle) - sinTilt * offset
        let pz = sinTilt * sin(angle) + cosTilt * offset
        let length = sqrt(px * px + py * py + pz * pz)
        let (x, y, z) = projectPoint(
          yaw: 0,
          pitch: 0.3,
          x: px / length * radius,
          y: py / length * radius,
          z: pz / length * radius
        )
        let depth = (z / radius + 1) / 2
        dots.append(
          Dot(
            x: x,
            y: y,
            z: z,
            r: (1.1803 + 1.8241 * depth) * (1 - 0.25 * edge) * scale,
            white: 0.52 - 0.44 * depth + 0.18 * edge,
            a: 0.4 + 0.6 * depth
          )
        )
      }
    }

    paintDots(in: ctx, dots: dots, minRadius: 0.3)
  }

  private func paintDots(in ctx: CGContext, dots: [Dot], minRadius: CGFloat) {
    let sortedDots = dots.sorted { $0.z < $1.z }
    for dot in sortedDots {
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
  private var mode: ThinkingOrbMode = .shaping
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

  func setMode(_ value: ThinkingOrbMode) {
    guard mode != value else { return }
    mode = value
    startTime = CACurrentMediaTime()
    setNeedsDisplay(bounds)
  }

  private func start() {
    running = true
    guard !reduceMotion else {
      if let displayLink {
        CVDisplayLinkStop(displayLink)
        self.displayLink = nil
      }
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
    renderer.draw(in: ctx, time: time, mode: mode)
  }

  private var rendererSpeed: CGFloat {
    switch mode {
    case .shaping: return 2.08
    case .composing: return 3.12
    case .solving: return 1.95
    }
  }
}

struct ThinkingOrbView: NSViewRepresentable {
  var mode: ThinkingOrbMode
  var reduceMotion: Bool
  var size: CGFloat = 18

  func makeNSView(context: Context) -> ThinkingOrbNSView {
    let view = ThinkingOrbNSView(size: size)
    view.setMode(mode)
    view.reduceMotion = reduceMotion
    view.setRunning(true)
    return view
  }

  func updateNSView(_ nsView: ThinkingOrbNSView, context: Context) {
    nsView.setMode(mode)
    nsView.reduceMotion = reduceMotion
    nsView.setRunning(true)
  }
}
