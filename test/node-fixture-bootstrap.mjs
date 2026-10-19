// Test-only phase messages. The parent can distinguish a Node process that
// has not initialized from a loaded application that has not bound its port.
import net from "node:net";
import { performance } from "node:perf_hooks";

const started = performance.now();
const cpu = process.cpuUsage();
function publish(phase, detail = {}) {
  if (!process.send || !process.connected) return;
  process.send({
    nodeFixturePhase: phase,
    elapsedMs: performance.now() - started,
    cpu: process.cpuUsage(cpu),
    ...detail,
  }, () => {});
  // Observing the fixture must not keep an otherwise finished child alive.
  process.channel?.unref();
}

publish("initialized");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const requested = args[0]?.port ?? args[0];
  const port = Number(requested);
  publish("binding", { port: Number.isInteger(port) ? port : undefined });
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") publish("listening", { port: address.port });
  });
  return listen.apply(this, args);
};
