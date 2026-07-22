// Compact dotted Thinking Orbs renderers adapted from
// https://orbs.jakubantalik.com/ for the Dynamic Island.

function hash(seed, salt) {
  const n = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function project(yaw, pitch, cx, cy, scale) {
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  return (x, y, z) => {
    const x1 = x * cosYaw + z * sinYaw;
    const z1 = -x * sinYaw + z * cosYaw;
    const y1 = y * cosPitch - z1 * sinPitch;
    const z2 = y * sinPitch + z1 * cosPitch;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}

function paintDots(ctx, dots, dark, minRadius = 0.3) {
  dots.sort((a, b) => a.z - b.z);
  for (const dot of dots) {
    const alpha = dot.a ?? 1;
    if (alpha < 0.02) continue;
    const white = Math.min(1, Math.max(0, dot.white));
    const tone = Math.round((dark ? 1 - white : white) * 255);
    ctx.fillStyle = `rgba(${tone},${tone},${tone},${alpha})`;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, Math.max(minRadius, dot.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

function radiusScale(size, power = 0.6) {
  return (size / 300) ** power;
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

function samplePerimeter(points) {
  const lengths = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const length = Math.hypot(next[0] - current[0], next[1] - current[1]);
    lengths.push(length);
    total += length;
  }
  return (amount) => {
    let distance = amount * total;
    let index = 0;
    while (distance > lengths[index] && index < points.length - 1) {
      distance -= lengths[index];
      index += 1;
    }
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const progress = lengths[index] ? Math.min(1, distance / lengths[index]) : 0;
    return [
      current[0] + (next[0] - current[0]) * progress,
      current[1] + (next[1] - current[1]) * progress,
    ];
  };
}

const morphShapes = [
  (amount) => {
    const angle = -Math.PI / 2 + amount * 2 * Math.PI;
    return [Math.cos(angle) * 0.24, Math.sin(angle) * 0.24];
  },
  samplePerimeter([[0, -0.26], [0.24, 0.16], [-0.24, 0.16]]),
  samplePerimeter([[0, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2], [-0.2, -0.2]]),
];

// Morph / "shaping" mode using the Thinking Orbs 20px preset.
function drawMorph(ctx, size, time, dark) {
  const hold = 1.4;
  const transition = 0.9;
  const segmentDuration = hold + transition;
  const cycle = time % (segmentDuration * morphShapes.length);
  const shapeIndex = Math.floor(cycle / segmentDuration);
  const segmentTime = cycle - shapeIndex * segmentDuration;
  const blend = segmentTime > hold
    ? smoothStep((segmentTime - hold) / transition)
    : 0;
  const currentShape = morphShapes[shapeIndex];
  const nextShape = morphShapes[(shapeIndex + 1) % morphShapes.length];
  const spread = 1.45;
  const pathCount = 160;
  const path = [];

  for (let index = 0; index < pathCount; index += 1) {
    const amount = index / pathCount;
    const current = currentShape(amount);
    const next = nextShape(amount);
    path.push([
      (current[0] + (next[0] - current[0]) * blend) * spread,
      (current[1] + (next[1] - current[1]) * blend) * spread,
    ]);
  }

  const lengths = [];
  let total = 0;
  for (let index = 0; index < pathCount; index += 1) {
    const current = path[index];
    const next = path[(index + 1) % pathCount];
    const length = Math.hypot(next[0] - current[0], next[1] - current[1]);
    lengths.push(length);
    total += length;
  }

  const pointCount = 18;
  const dotRadius = 0.021 * 1.011 * 1.35 * spread * size;
  const breathe = 1 + 0.02 * Math.sin(segmentTime * 3.1);
  const center = size / 2;
  const dots = [];
  let pathIndex = 0;
  let traversed = 0;

  for (let index = 0; index < pointCount; index += 1) {
    const target = (index / pointCount) * total;
    while (traversed + lengths[pathIndex] < target && pathIndex < pathCount - 1) {
      traversed += lengths[pathIndex];
      pathIndex += 1;
    }
    const current = path[pathIndex];
    const next = path[(pathIndex + 1) % pathCount];
    const progress = lengths[pathIndex]
      ? Math.min(1, (target - traversed) / lengths[pathIndex])
      : 0;
    const x = (current[0] + (next[0] - current[0]) * progress) * breathe;
    const y = (current[1] + (next[1] - current[1]) * progress) * breathe;
    dots.push({
      x: center + x * size,
      y: center + y * size,
      z: 0,
      r: Math.max(0.35, dotRadius),
      white: 0.1,
    });
  }

  paintDots(ctx, dots, dark, 0.25);
}

function fibonacciSphere(index, count) {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (index + 0.5)) / count;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * goldenAngle;
  return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
}

function buildRubikMoves(count) {
  const moves = [];
  for (let index = 0; index < count; index += 1) {
    const axis = Math.min(2, Math.floor(hash(index, 2.3) * 3));
    const low = -1 + 0.5 * Math.min(3, Math.floor(hash(index, 5.9) * 4));
    const direction = hash(index, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, low, high: low + 0.5, angle: direction * Math.PI / 2 });
  }
  return moves;
}

const rubikMoves = buildRubikMoves(14);

function rubikTimeline(time) {
  const moveDuration = 0.42;
  const pause = 1.2;
  const cycleDuration = 2 * rubikMoves.length * moveDuration + pause;
  const cycle = time % cycleDuration;
  const amounts = new Array(rubikMoves.length).fill(0);
  let active = -1;

  if (cycle < 2 * rubikMoves.length * moveDuration) {
    const step = Math.floor(cycle / moveDuration);
    const progress = (cycle - step * moveDuration) / moveDuration;
    const eased = 1 - (1 - Math.min(1, progress / 0.7)) ** 3;
    if (step < rubikMoves.length) {
      for (let index = 0; index < step; index += 1) amounts[index] = 1;
      amounts[step] = eased;
      active = step;
    } else {
      const reverse = 2 * rubikMoves.length - 1 - step;
      for (let index = 0; index < reverse; index += 1) amounts[index] = 1;
      amounts[reverse] = 1 - eased;
      active = reverse;
    }
  }
  return { amounts, active };
}

function applyRubikMoves(point, timeline) {
  let [x, y, z] = point;
  let active = false;
  for (let index = 0; index < rubikMoves.length; index += 1) {
    const amount = timeline.amounts[index];
    if (amount <= 0) continue;
    const move = rubikMoves[index];
    const coordinate = move.axis === 0 ? x : move.axis === 1 ? y : z;
    if (coordinate < move.low || coordinate >= move.high) continue;
    if (index === timeline.active) active = true;
    const angle = move.angle * amount;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    if (move.axis === 0) {
      const nextY = y * cosine - z * sine;
      z = y * sine + z * cosine;
      y = nextY;
    } else if (move.axis === 1) {
      const nextX = x * cosine + z * sine;
      z = -x * sine + z * cosine;
      x = nextX;
    } else {
      const nextX = x * cosine - y * sine;
      y = x * sine + y * cosine;
      x = nextX;
    }
  }
  return [x, y, z, active];
}

// Rubik / "solving" mode using the Thinking Orbs 20px preset.
function drawSolving(ctx, size, time, dark) {
  const center = size / 2;
  const radius = (size / 2) * 0.82;
  const projectPoint = project(
    time * 0.55,
    0.35 + 0.1 * Math.sin(time * 0.9),
    center,
    center,
    1,
  );
  const scale = radiusScale(size, 0.6);
  const timeline = rubikTimeline(time);
  const dots = [];
  const latitudeRings = 4;
  const longitudeDensity = 12;

  for (let latitude = 0; latitude <= latitudeRings; latitude += 1) {
    const latitudeAngle = -Math.PI / 2 + (latitude / latitudeRings) * Math.PI;
    const ringRadius = Math.cos(latitudeAngle);
    const ringY = Math.sin(latitudeAngle);
    const pointCount = Math.max(1, Math.round(Math.abs(ringRadius) * longitudeDensity));
    for (let longitude = 0; longitude < pointCount; longitude += 1) {
      const angle = (longitude / pointCount) * 2 * Math.PI;
      const [tx, ty, tz, active] = applyRubikMoves(
        [ringRadius * Math.cos(angle), ringY, ringRadius * Math.sin(angle)],
        timeline,
      );
      const [x, y, z] = projectPoint(
        tx * radius,
        ty * radius,
        tz * radius,
      );
      const depth = (z / radius + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (1.14 + 3.23 * depth + (active ? 0.57 : 0)) * scale,
        white: 0.62 - 0.54 * depth - (active ? 0.14 : 0),
      });
    }
  }

  paintDots(ctx, dots, dark, 0.3);
}

// Ribbon / "composing" mode using the Thinking Orbs 20px preset.
function drawComposing(ctx, size, time, dark) {
  const center = size / 2;
  const radius = (size / 2) * 0.78;
  const projectPoint = project(0, 0.3, center, center, 1);
  const scale = radiusScale(size, 0.6);
  const dots = [];
  const ghostCount = 8;

  for (let index = 0; index < ghostCount; index += 1) {
    const point = fibonacciSphere(index, ghostCount);
    const [x, y, z] = projectPoint(point[0] * radius, point[1] * radius, point[2] * radius);
    const depth = (z / radius + 1) / 2;
    dots.push({ x, y, z, r: 0.8 * scale, white: 0.78, a: 0.1 + 0.22 * depth });
  }

  const tilt = 0.55;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const bandCount = 10;
  const segmentCount = 20;
  for (let band = 0; band < bandCount; band += 1) {
    const offsetBase = (band - (bandCount - 1) / 2) * 0.075;
    const edge = Math.abs(band - (bandCount - 1) / 2) / ((bandCount - 1) / 2);
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const angle = (segment / segmentCount) * 2 * Math.PI;
      const wobble =
        0.16 * Math.sin(angle * 3 - time * 1.7 + band * 0.22)
        + 0.07 * Math.sin(angle * 5 + time * 1.1);
      const offset = offsetBase + wobble;
      const px = Math.cos(angle);
      const py = cosTilt * Math.sin(angle) - sinTilt * offset;
      const pz = sinTilt * Math.sin(angle) + cosTilt * offset;
      const length = Math.hypot(px, py, pz);
      const [x, y, z] = projectPoint(
        (px / length) * radius,
        (py / length) * radius,
        (pz / length) * radius,
      );
      const depth = (z / radius + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (1.1803 + 1.8241 * depth) * (1 - 0.25 * edge) * scale,
        white: 0.52 - 0.44 * depth + 0.18 * edge,
        a: 0.4 + 0.6 * depth,
      });
    }
  }

  paintDots(ctx, dots, dark, 0.3);
}

function prefersReducedMotion() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mount a thinking orb into a host element.
 * @param {HTMLElement} host
 * @param {{ size?: number, dark?: boolean }} [options]
 */
export function createThinkingOrb(host, options = {}) {
  const size = options.size ?? 18;
  const dark = options.dark ?? true;
  const canvas = document.createElement("canvas");
  canvas.className = "thinking-orb-canvas";
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.display = "block";
  host.append(canvas);

  const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      start() {},
      stop() {},
      destroy() {
        canvas.remove();
      },
      setMode() {},
    };
  }

  let frame = 0;
  let running = false;
  let visible = true;
  let destroyed = false;
  let mode = "hidden";
  let modeStartedAt = performance.now();

  const draw = (t) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (mode === "shaping") drawMorph(ctx, size, t, dark);
    else if (mode === "composing") drawComposing(ctx, size, t, dark);
    else drawSolving(ctx, size, t, dark);
  };

  const tick = () => {
    if (!running || destroyed) return;
    const modeSpeed = mode === "shaping" ? 2.08 : mode === "composing" ? 3.12 : 1.95;
    draw(((performance.now() - modeStartedAt) / 1000) * modeSpeed);
    frame = requestAnimationFrame(tick);
  };

  const start = () => {
    if (destroyed || running) return;
    if (prefersReducedMotion()) {
      draw(0.6);
      return;
    }
    running = true;
    frame = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(frame);
  };

  const setMode = (value) => {
    const nextMode = ["shaping", "composing", "solving"].includes(value) ? value : "hidden";
    if (nextMode !== mode) {
      mode = nextMode;
      modeStartedAt = performance.now();
    }
    canvas.hidden = mode === "hidden";
    if (mode !== "hidden" && visible && document.visibilityState !== "hidden") {
      start();
      return;
    }
    stop();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      stop();
      return;
    }
    if (mode !== "hidden" && visible) start();
  };

  document.addEventListener("visibilitychange", onVisibility);
  const observer =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          if (mode !== "hidden" && visible && document.visibilityState !== "hidden") start();
          else stop();
        })
      : null;
  observer?.observe(canvas);

  return {
    start,
    stop,
    setMode,
    destroy() {
      destroyed = true;
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.remove();
    },
  };
}
