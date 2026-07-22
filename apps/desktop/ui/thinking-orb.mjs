// Compact dotted thinking orb (orbits mode) adapted from
// https://orbs.jakubantalik.com/ for the Dynamic Island generating state.

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
      setRunning() {},
    };
  }

  let frame = 0;
  let running = false;
  let visible = true;
  let destroyed = false;
  let desired = false;

  const draw = (t) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    drawOrbits(ctx, size, t, dark);
  };

  const tick = () => {
    if (!running || destroyed) return;
    draw((performance.now() / 1000) * speed);
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

  const setRunning = (value) => {
    desired = Boolean(value);
    canvas.hidden = !desired;
    if (desired && visible && document.visibilityState !== "hidden") start();
    else stop();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      stop();
      return;
    }
    if (desired && visible) start();
  };

  document.addEventListener("visibilitychange", onVisibility);
  const observer =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          if (desired && visible && document.visibilityState !== "hidden") start();
          else stop();
        })
      : null;
  observer?.observe(canvas);

  return {
    start,
    stop,
    setRunning,
    destroy() {
      destroyed = true;
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.remove();
    },
  };
}
