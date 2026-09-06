import type { CSSProperties } from "react";

import antigravityLogo from "./assets/providers/antigravity.png";
import anthropicLogo from "./assets/providers/anthropic.png";
import cerebrasLogo from "./assets/providers/cerebras.png";
import chutesLogo from "./assets/providers/chutes.svg";
import clineLogo from "./assets/providers/cline.png";
import commandCodeLogo from "./assets/providers/commandcode.svg";
import cognitionLogo from "./assets/providers/cognition.svg";
import deepSeekLogo from "./assets/providers/deepseek.png";
import deepReinforceLogo from "./assets/providers/deepreinforce.svg";
import fireworksLogo from "./assets/providers/fireworks.svg";
import geminiLogo from "./assets/providers/gemini.svg";
import githubCopilotLogo from "./assets/providers/github-copilot.svg";
import googleLogo from "./assets/providers/google.svg";
import groqLogo from "./assets/providers/groq.svg";
import huggingFaceLogo from "./assets/providers/huggingface.svg";
import kimiLogo from "./assets/providers/kimi.png";
import kiloLogo from "./assets/providers/kilo.svg";
import lmStudioLogo from "./assets/providers/lmstudio.svg";
import metaLogo from "./assets/providers/meta.svg";
import minimaxLogo from "./assets/providers/minimax.svg";
import mistralLogo from "./assets/providers/mistral.svg";
import nanoGptLogo from "./assets/providers/nanogpt.svg";
import nousResearchLogo from "./assets/providers/nousresearch.png";
import nvidiaLogo from "./assets/providers/nvidia.svg";
import ollamaLogo from "./assets/providers/ollama.png";
import openaiLogo from "./assets/providers/openai.png";
import openCodeLogo from "./assets/providers/opencode.png";
import openRouterLogo from "./assets/providers/openrouter.png";
import poolsideLogo from "./assets/providers/poolside.svg";
import qwenLogo from "./assets/providers/qwen.svg";
import siliconFlowLogo from "./assets/providers/siliconflow.png";
import stealthLogo from "./assets/providers/stealth.svg";
import stepFunLogo from "./assets/providers/stepfun.svg";
import tencentLogo from "./assets/providers/tencent.svg";
import togetherLogo from "./assets/providers/together.png";
import veniceLogo from "./assets/providers/venice.png";
import xaiLogo from "./assets/providers/xai.png";
import xiaomiLogo from "./assets/providers/xiaomi.svg";
import zaiLogo from "./assets/providers/zai.svg";

export interface ProviderBrand {
  key: string;
  name: string;
  shortName: string;
  color: string;
  logo?: string;
  logoMode?: "mask" | "artwork";
}

interface BrandableModel {
  provider: string;
  slug: string;
  displayName?: string;
  gatewayModel?: string;
}

const BRANDS: Record<string, ProviderBrand> = {
  antigravity: { key: "antigravity", name: "Antigravity", shortName: "AG", color: "#4285f4", logo: antigravityLogo, logoMode: "artwork" },
  anthropic: { key: "anthropic", name: "Anthropic", shortName: "A", color: "#d97757", logo: anthropicLogo, logoMode: "artwork" },
  cerebras: { key: "cerebras", name: "Cerebras", shortName: "C", color: "#f15a24", logo: cerebrasLogo, logoMode: "artwork" },
  chutes: { key: "chutes", name: "Chutes", shortName: "CH", color: "#42a875", logo: chutesLogo },
  cline: { key: "cline", name: "Cline", shortName: "CL", color: "#5b6df2", logo: clineLogo, logoMode: "artwork" },
  commandcode: { key: "commandcode", name: "Command Code", shortName: "CC", color: "#8c4edd", logo: commandCodeLogo, logoMode: "artwork" },
  cognition: { key: "cognition", name: "Devin", shortName: "DV", color: "#0d98d4", logo: cognitionLogo, logoMode: "artwork" },
  deepseek: { key: "deepseek", name: "DeepSeek", shortName: "DS", color: "#4d6bfe", logo: deepSeekLogo },
  deepreinforce: { key: "deepreinforce", name: "Ornith", shortName: "OR", color: "#8f816b", logo: deepReinforceLogo, logoMode: "artwork" },
  // Codenamed preview models ship without a maker's mark of their own. They
  // fell through to their provider's logo, so the same model wore six
  // different faces depending on which account served it.
  stealth: { key: "stealth", name: "Stealth preview", shortName: "SP", color: "#3f4550", logo: stealthLogo, logoMode: "artwork" },
  fireworks: { key: "fireworks", name: "Fireworks AI", shortName: "FW", color: "#6720ff", logo: fireworksLogo },
  github: { key: "github", name: "GitHub", shortName: "GH", color: "#59636e", logo: githubCopilotLogo },
  gemini: { key: "gemini", name: "Gemini", shortName: "GM", color: "#5684d1", logo: geminiLogo, logoMode: "artwork" },
  google: { key: "google", name: "Google", shortName: "G", color: "#4285f4", logo: googleLogo },
  groq: { key: "groq", name: "Groq", shortName: "GQ", color: "#f43e01", logo: groqLogo, logoMode: "artwork" },
  huggingface: { key: "huggingface", name: "Hugging Face", shortName: "HF", color: "#d89b00", logo: huggingFaceLogo },
  kimi: { key: "kimi", name: "Kimi", shortName: "K", color: "#2f6bff", logo: kimiLogo, logoMode: "artwork" },
  kilo: { key: "kilo", name: "Kilo", shortName: "KL", color: "#cfca00", logo: kiloLogo, logoMode: "artwork" },
  lmstudio: { key: "lmstudio", name: "LM Studio", shortName: "LM", color: "#654cdb", logo: lmStudioLogo, logoMode: "artwork" },
  meta: { key: "meta", name: "Meta", shortName: "M", color: "#0467df", logo: metaLogo },
  minimax: { key: "minimax", name: "MiniMax", shortName: "MM", color: "#e73562", logo: minimaxLogo },
  mistral: { key: "mistral", name: "Mistral AI", shortName: "MI", color: "#e54b13", logo: mistralLogo },
  nousresearch: { key: "nousresearch", name: "Nous Research", shortName: "NR", color: "#5a5a5a", logo: nousResearchLogo },
  nvidia: { key: "nvidia", name: "NVIDIA", shortName: "NV", color: "#5d9300", logo: nvidiaLogo },
  ollama: { key: "ollama", name: "Ollama", shortName: "O", color: "#4c4c4c", logo: ollamaLogo },
  openai: { key: "openai", name: "OpenAI", shortName: "OA", color: "#5c6662", logo: openaiLogo },
  opencode: { key: "opencode", name: "opencode", shortName: "OC", color: "#666666", logo: openCodeLogo, logoMode: "artwork" },
  openrouter: { key: "openrouter", name: "OpenRouter", shortName: "OR", color: "#6467f2", logo: openRouterLogo, logoMode: "artwork" },
  poolside: { key: "poolside", name: "Poolside", shortName: "PS", color: "#4137ff", logo: poolsideLogo, logoMode: "artwork" },
  qwen: { key: "qwen", name: "Qwen", shortName: "Q", color: "#6950ef", logo: qwenLogo },
  siliconflow: { key: "siliconflow", name: "SiliconFlow", shortName: "SF", color: "#6736f1", logo: siliconFlowLogo, logoMode: "artwork" },
  stepfun: { key: "stepfun", name: "StepFun", shortName: "ST", color: "#5167f4", logo: stepFunLogo },
  nanogpt: { key: "nanogpt", name: "NanoGPT", shortName: "NG", color: "#0db7b1", logo: nanoGptLogo, logoMode: "artwork" },
  tencent: { key: "tencent", name: "Tencent", shortName: "T", color: "#0052d9", logo: tencentLogo, logoMode: "artwork" },
  together: { key: "together", name: "Together AI", shortName: "TA", color: "#d84a15", logo: togetherLogo, logoMode: "artwork" },
  venice: { key: "venice", name: "Venice", shortName: "VE", color: "#0e2942", logo: veniceLogo },
  xai: { key: "xai", name: "xAI", shortName: "X", color: "#606060", logo: xaiLogo },
  xiaomi: { key: "xiaomi", name: "Xiaomi", shortName: "MI", color: "#ff6900", logo: xiaomiLogo },
  zai: { key: "zai", name: "Z.ai", shortName: "Z", color: "#1f63ec", logo: zaiLogo, logoMode: "artwork" },
};

const PROVIDER_BRANDS: Record<string, string> = {
  openai: "openai",
  "anthropic-api": "anthropic",
  cerebras: "cerebras",
  chutes: "chutes",
  clinepass: "cline",
  commandcode: "commandcode",
  "commandcode-messages": "commandcode",
  // A user-defined endpoint has no brand of its own to show, and a monogram
  // built from the word "custom" says nothing. It shares the mark used for
  // models whose maker is deliberately not disclosed.
  custom: "stealth",
  "devin-cli": "cognition",
  deepseek: "deepseek",
  fireworks: "fireworks",
  "antigravity-oauth": "antigravity",
  "gemini-api": "gemini",
  "github-copilot": "github",
  "grok-api": "xai",
  "grok-oauth": "xai",
  groq: "groq",
  huggingface: "huggingface",
  "kimi-api": "kimi",
  "kimi-api-cn": "kimi",
  "kimi-oauth": "kimi",
  "kilo-free": "kilo",
  "lmstudio": "lmstudio",
  local: "ollama",
  meta: "meta",
  "minimax-token-plan": "minimax",
  mistral: "mistral",
  "nano-gpt": "nanogpt",
  nousresearch: "nousresearch",
  "nvidia-nim": "nvidia",
  "ollama-cloud": "ollama",
  "opencode-go": "opencode",
  "opencode-go-messages": "opencode",
  "opencode-go-responses": "opencode",
  "opencode-zen": "opencode",
  "opencode-free": "opencode",
  openrouter: "openrouter",
  "qwen-plan": "qwen",
  siliconflow: "siliconflow",
  together: "together",
  venice: "venice",
  vertex: "google",
  "xiaomi-mimo": "xiaomi",
  "zai-api": "zai",
  "zai-coding": "zai",
};

const FALLBACK_COLORS = ["#5776a9", "#8b5f8f", "#477c72", "#a46648", "#6e6aa4", "#7d6b49"];

export function brandForProvider(providerId: string, displayName?: string): ProviderBrand {
  const normalized = providerId.trim().toLowerCase();
  const brandKey = PROVIDER_BRANDS[normalized]
    ?? (normalized.startsWith("commandcode") ? "commandcode" : undefined)
    ?? (normalized.startsWith("opencode") ? "opencode" : undefined)
    ?? (normalized.startsWith("grok") ? "xai" : undefined)
    ?? (normalized.startsWith("kimi") ? "kimi" : undefined);
  if (brandKey) return BRANDS[brandKey];
  return fallbackBrand(displayName || humanizeProviderId(providerId), providerId);
}

export function brandForModel(model: BrandableModel): ProviderBrand {
  const identity = `${model.slug} ${model.displayName || ""} ${model.gatewayModel || ""}`.toLowerCase();
  if (/\bclaude\b/.test(identity)) return BRANDS.anthropic;
  if (/\bdeepseek\b/.test(identity)) return BRANDS.deepseek;
  if (/\bgrok\b/.test(identity)) return BRANDS.xai;
  if (/\b(?:kimi|moonshot)\b/.test(identity)) return BRANDS.kimi;
  if (/\bglm(?:-|\b)/.test(identity)) return BRANDS.zai;
  if (/\bqwen(?:-|\d|\b)/.test(identity)) return BRANDS.qwen;
  if (/\bminimax\b/.test(identity)) return BRANDS.minimax;
  // Gemini has carried its own mark since the 2024 rebrand; Google's "G" is
  // the company, not the model. Gemma still ships under the company mark.
  if (/\bgemini\b/.test(identity)) return BRANDS.gemini;
  if (/\bgemma\b/.test(identity)) return BRANDS.google;
  if (/\b(?:gpt|codex)\b/.test(identity) || /^openai\//.test(model.slug.toLowerCase())) return BRANDS.openai;
  if (/\bmimo(?:-|\b)/.test(identity)) return BRANDS.xiaomi;
  if (/\bstep(?:-|\s)/.test(identity)) return BRANDS.stepfun;
  if (/\bhy(?:3|4)(?:-|\b)/.test(identity)) return BRANDS.tencent;
  if (/\blaguna(?:-|\b)/.test(identity)) return BRANDS.poolside;
  if (/\b(?:llama|muse spark)\b/.test(identity)) return BRANDS.meta;
  if (/\b(?:mistral|mixtral|codestral)\b/.test(identity)) return BRANDS.mistral;
  if (/\bnemotron\b/.test(identity)) return BRANDS.nvidia;
  if (/\bornith(?:-|\b)/.test(identity)) return BRANDS.deepreinforce;
  // Anonymous preview models, matched last so a maker's own mark always wins.
  if (/\b(?:ox alpha|ox-alpha|fugu|inkling)\b/.test(identity) || /x-preview/.test(identity)) {
    return BRANDS.stealth;
  }
  return brandForProvider(model.provider);
}

export function brandForLocalModel(model: { tag: string; family?: string; displayName?: string }): ProviderBrand {
  return brandForModel({
    provider: "local",
    slug: `local/${model.tag}`,
    displayName: `${model.family || ""} ${model.displayName || ""}`.trim(),
    gatewayModel: model.tag,
  });
}

export function ProviderLogo({ providerId, displayName, size = "medium", className = "" }: {
  providerId: string;
  displayName?: string;
  size?: "small" | "medium" | "large";
  className?: string;
}) {
  return <BrandLogo brand={brandForProvider(providerId, displayName)} size={size} className={className} />;
}

export function BrandLogo({ brand, size = "medium", className = "" }: {
  brand: ProviderBrand;
  size?: "small" | "medium" | "large";
  className?: string;
}) {
  const style = {
    "--provider-brand-color": brand.color,
    ...(brand.logo ? { "--provider-brand-logo": `url("${brand.logo}")` } : {}),
  } as CSSProperties;
  return (
    <span
      className={`provider-brand-logo provider-brand-logo-${size} ${brand.logoMode === "artwork" ? "is-artwork" : "is-mask"} ${className}`.trim()}
      style={style}
      data-brand={brand.key}
      aria-hidden="true"
    >
      {brand.logo
        ? brand.logoMode === "artwork"
          ? <img src={brand.logo} alt="" />
          : <span className="provider-brand-logo-mask" />
        : <span className="provider-brand-logo-fallback">{brand.shortName}</span>}
    </span>
  );
}

function fallbackBrand(name: string, seed: string): ProviderBrand {
  const cleanName = name.trim() || "Model provider";
  let hash = 0;
  for (const character of seed) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return {
    key: `fallback-${seed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: cleanName,
    shortName: initials(cleanName),
    color: FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length],
  };
}

function humanizeProviderId(providerId: string): string {
  return providerId
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "MR";
}
