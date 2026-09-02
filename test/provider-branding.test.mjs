import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("provider and model-maker branding covers remote and local catalog families", async () => {
  const branding = await readFile(new URL("apps/control-center/src/provider-branding.tsx", root), "utf8");
  const sources = await readFile(new URL("apps/control-center/src/assets/providers/SOURCES.md", root), "utf8");
  const local = await readFile(new URL("apps/control-center/src/pages/LocalPage.tsx", root), "utf8");
  const tray = await readFile(new URL("apps/macos/ModelRouterTray/Sources/IslandOverlay.swift", root), "utf8");
  const traySources = await readFile(new URL("apps/macos/ModelRouterTray/Resources/PROVIDER-ICON-SOURCES.md", root), "utf8");

  for (const asset of ["cognition", "deepreinforce", "kilo", "lmstudio", "nanogpt", "poolside", "tencent"]) {
    assert.match(branding, new RegExp(`assets/providers/${asset}\\.svg`), `${asset} logo is not bundled`);
    assert.match(sources, new RegExp(`${asset}\\.svg`), `${asset} source is not recorded`);
  }

  for (const providerId of [
    "devin-cli", "kilo-free", "kimi-api-cn", "lmstudio", "nano-gpt", "opencode-free",
    "xiaomi-mimo", "zai-api",
  ]) {
    assert.match(branding, new RegExp(`"${providerId}":`), `${providerId} falls back to a monogram`);
  }

  assert.match(branding, /muse spark[^\n]+BRANDS\.meta/);
  assert.match(branding, /ornith[^\n]+BRANDS\.deepreinforce/);
  assert.match(branding, /hy\(\?:3\|4\)[^\n]+BRANDS\.tencent/);
  assert.match(branding, /laguna[^\n]+BRANDS\.poolside/);
  assert.match(branding, /export function brandForLocalModel/);
  assert.match(branding, /vertex: "google"/);
  assert.match(tray, /providerID == "vertex" \{ return "google" \}/);
  assert.match(traySources, /Google Cloud Vertex AI.*google\.svg/s);
  assert.match(local, /brandForLocalModel/);
  assert.match(local, /<BrandLogo brand=\{brandForLocalModel\(model\)\}/);
  assert.match(sources, /tencent\.com\/newsroom\/media-resources/);
  assert.match(sources, /cropped-04_Tencent_Graphics2-192x192\.png/);
  assert.match(sources, /nano-gpt\.com\/favicon\.ico/);
  assert.match(sources, /nano-gpt\.com\/logo\.png/);
  assert.match(sources, /CognitionAI\/devin-extension[^|]+devin-full-color\.png/);
  assert.match(sources, /ornith-ai\/Ornith-1[^|]+ornith_logo\.png/);
  assert.doesNotMatch(sources, /avatars\.githubusercontent\.com/);
  assert.match(branding, /cognition:[^\n]+name: "Devin"/);
  assert.match(branding, /deepreinforce:[^\n]+name: "Ornith"/);
  assert.match(branding, /nanogpt:[^\n]+name: "NanoGPT"/);
  assert.match(branding, /tencent:[^\n]+name: "Tencent"/);
});
