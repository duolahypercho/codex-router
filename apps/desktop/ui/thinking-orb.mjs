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

// Orbits / "working" mode from Thinking Orbs, sized for a 20px island slot.
function drawOrbits(ctx, size, time, dark) {
  const center = size / 2;
  const radius = (size / 2) * 0.82;
  const projectPoint = project(time * 0.12, 0.3, center, center, 1);
  const scale = radiusScale(size, 0.6);
  const dots = [];

  // Island-sized density: fewer orbits/ghosts than the 64px showcase preset.
  const orbitCount = 4;
  const ghostCount = 16;
  const particleCount = 3;
  const ghostRadius = 0.9 * 2.4 * scale;
  const ghostAlpha = 0.5;
  const particleRadius = 1.2 * 2.4;
  const particleDepth = 1.6 * 2.4;
  const minRadius = 0.3;

  for (let orbit = 0; orbit < orbitCount; orbit += 1) {
    const a = hash(orbit, 1.7);
    const b = hash(orbit, 5.2);
    const c = hash(orbit, 8.9);
    const orbitRadius = radius * (0.45 + 0.52 * a);
    const theta = a * 2 * Math.PI;
    const phi = Math.acos(2 * b - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);

    let tx = -ny;
    let ty = nx;
    const tLen = Math.max(1e-6, Math.sqrt(tx * tx + ty * ty));
    tx /= tLen;
    ty /= tLen;
    const bx = ny * 0 - nz * ty;
    const by = nz * tx - nx * 0;
    const bz = nx * ty - ny * tx;
    const speed = (0.25 + 0.55 * c) * (c > 0.5 ? 1 : -1);

    for (let ghost = 0; ghost < ghostCount; ghost += 1) {
      const angle = (ghost / ghostCount) * 2 * Math.PI;
      const [x, y, z] = projectPoint(
        (tx * Math.cos(angle) + bx * Math.sin(angle)) * orbitRadius,
        (ty * Math.cos(angle) + by * Math.sin(angle)) * orbitRadius,
        (0 * Math.cos(angle) + bz * Math.sin(angle)) * orbitRadius,
      );
      const depth = (z / orbitRadius + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: ghostRadius,
        white: 0.72,
        a: ghostAlpha * (0.4 + 0.6 * depth),
      });
    }

    for (let particle = 0; particle < particleCount; particle += 1) {
      const angle = time * speed + (particle / particleCount) * 2 * Math.PI + b * 6;
      const [x, y, z] = projectPoint(
        (tx * Math.cos(angle) + bx * Math.sin(angle)) * orbitRadius,
        (ty * Math.cos(angle) + by * Math.sin(angle)) * orbitRadius,
        (0 * Math.cos(angle) + bz * Math.sin(angle)) * orbitRadius,
      );
      const depth = (z / orbitRadius + 1) / 2;
      dots.push({
        x,
        y,
        z,
        r: (particleRadius + particleDepth * depth) * scale,
        white: 0.3 - 0.22 * depth,
      });
    }
  }

  paintDots(ctx, dots, dark, minRadius);
}

function prefersReducedMotion() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mount a thinking orb into a host element.
 * @param {HTMLElement} host
 * @param {{ size?: number, speed?: number, dark?: boolean }} [options]
 */
export function createThinkingOrb(host, options = {}) {
  const size = options.size ?? 18;
  const speed = options.speed ?? 3.9;
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
    else drawOrbits(ctx, size, t, dark);
  };

  const tick = () => {
    if (!running || destroyed) return;
    const modeSpeed = mode === "shaping" ? 2.08 : speed;
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
    const nextMode = ["shaping", "thinking"].includes(value) ? value : "hidden";
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
