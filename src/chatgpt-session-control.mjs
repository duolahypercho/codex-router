// Safe desktop/control projection for the ChatGPT session-sharing boundary.
//
// The credential owner lives in codex-native-session.mjs and the mutation
// transaction lives in chatgpt-session.mjs. Desktop surfaces intentionally do
// not import either shape directly: nativeSessionStatus also contains local
// path/account metadata that is useful to doctor but must never cross an IPC
// or tray boundary.

const SHARING_STATES = new Set(["enabled", "disabled"]);
const SESSION_STATES = new Set(["usable", "expired", "unavailable"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function finiteExpiry(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  return email.length <= 320 && EMAIL.test(email) ? email : undefined;
}

export function projectChatGptSessionStatus(status) {
  const usable = status?.usable === true;
  const expired = !usable && status?.expired === true;
  return {
    // `sharingEnabled` deliberately has no compatibility fallback. Older
    // routers implicitly shared the session; treating their fallback flag as
    // consent would recreate the authorization bug this surface is closing.
    sharing: status?.sharingEnabled === true ? "enabled" : "disabled",
    session: usable ? "usable" : expired ? "expired" : "unavailable",
    present: status?.present === true,
    expiresInHours: finiteExpiry(status?.expiresInHours),
    ...(safeEmail(status?.email) ? { email: safeEmail(status.email) } : {}),
  };
}

export function projectChatGptSessionAction(result) {
  return {
    sharing: SHARING_STATES.has(result?.sharing) ? result.sharing : "disabled",
    session: SESSION_STATES.has(result?.session) ? result.session : "unavailable",
    present: result?.present === true,
    expiresInHours: finiteExpiry(result?.expiresInHours),
    ...(safeEmail(result?.email) ? { email: safeEmail(result.email) } : {}),
    refreshed: result?.refreshed === true,
  };
}

export async function chatGptSessionStatus() {
  const { nativeSessionStatus } = await import("./codex-native-session.mjs");
  return projectChatGptSessionStatus(nativeSessionStatus());
}

export async function setChatGptSessionSharingFromControl(enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  // Call the upstream transaction rather than writing its marker here. That
  // function owns consent validation and republishes every installed client
  // catalog so DSH/Gemini cannot retain native models after sharing is off.
  let sessionModule;
  try {
    sessionModule = await import("./chatgpt-session.mjs");
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND"
      && String(error?.url || error?.message || "").includes("chatgpt-session.mjs")
    ) {
      throw new Error("This router build does not support explicit ChatGPT session sharing.");
    }
    throw error;
  }
  if (typeof sessionModule.setChatGptSessionSharing !== "function") {
    throw new Error("This router build does not support explicit ChatGPT session sharing.");
  }
  return projectChatGptSessionAction(await sessionModule.setChatGptSessionSharing(enabled));
}
