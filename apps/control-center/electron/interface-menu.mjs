// @ts-check
import english from "./locales/interface-menu.en.mjs";
import simplifiedChinese from "./locales/interface-menu.zh-CN.mjs";
import traditionalChinese from "./locales/interface-menu.zh-TW.mjs";

export { interfaceLanguageFromLocale, isInterfaceLanguage } from "./interface-locale.mjs";

// UI language affects native menus only; it never changes router configuration.
// Menu structure, roles and callbacks are language-independent. Dictionaries
// supply display labels only and never carry commands or callback names.
/**
 * @param {unknown} language
 * @param {{ showWindow: () => void, quit: () => void }} actions
 */
export function interfaceMenuTemplates(language, { showWindow, quit }) {
  const messages = language === "zh-CN" ? simplifiedChinese
    : language === "zh-TW" ? traditionalChinese : english;
  /** @param {keyof typeof english} key */
  const label = (key) => messages[key];
  const tray = [
    { label: label("tray.open"), click: showWindow },
    { type: "separator" },
    { label: label("app.quit"), click: quit },
  ];
  const application = [
    { label: "Codex Router", submenu: [
      { role: "about", label: label("app.about") },
      { type: "separator" },
      { role: "services", label: label("app.services") },
      { type: "separator" },
      { role: "hide", label: label("app.hide") },
      { role: "hideOthers", label: label("app.hideOthers") },
      { role: "unhide", label: label("app.showAll") },
      { type: "separator" },
      { role: "quit", label: label("app.quit") },
    ] },
    { label: label("menu.file"), submenu: [
      { role: "close", label: label("window.close") },
    ] },
    { label: label("menu.edit"), submenu: [
      { role: "undo", label: label("edit.undo") },
      { role: "redo", label: label("edit.redo") },
      { type: "separator" },
      { role: "cut", label: label("edit.cut") },
      { role: "copy", label: label("edit.copy") },
      { role: "paste", label: label("edit.paste") },
      { role: "selectAll", label: label("edit.selectAll") },
    ] },
    { label: label("menu.view"), submenu: [
      { role: "reload", label: label("view.reload") },
      { role: "forceReload", label: label("view.forceReload") },
      { role: "toggleDevTools", label: label("view.developerTools") },
      { type: "separator" },
      { role: "resetZoom", label: label("view.actualSize") },
      { role: "zoomIn", label: label("view.zoomIn") },
      { role: "zoomOut", label: label("view.zoomOut") },
      { role: "togglefullscreen", label: label("view.fullScreen") },
    ] },
    { label: label("menu.window"), submenu: [
      { role: "minimize", label: label("window.minimize") },
      { role: "zoom", label: label("window.zoom") },
      { label: label("tray.open"), click: showWindow },
      { role: "front", label: label("window.front") },
      { role: "close", label: label("window.close") },
    ] },
    { role: "help", label: label("menu.help"), submenu: [] },
  ];
  return { tray, application };
}
