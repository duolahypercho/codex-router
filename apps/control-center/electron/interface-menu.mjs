// UI language affects native menus only; it never changes router configuration.
export function interfaceMenuTemplates(language, { showWindow, quit }) {
  const zh = language === "zh-CN";
  const label = (english, chinese) => zh ? chinese : english;
  const tray = [
    { label: label("Open Control Center", "打开控制中心"), click: showWindow },
    { type: "separator" },
    { label: label("Quit Codex Router", "退出 Codex Router"), click: quit },
  ];
  const application = [
    { label: "Codex Router", submenu: [
      { role: "about", label: label("About Codex Router", "关于 Codex Router") },
      { type: "separator" },
      { role: "services", label: label("Services", "服务") },
      { type: "separator" },
      { role: "hide", label: label("Hide Codex Router", "隐藏 Codex Router") },
      { role: "hideOthers", label: label("Hide Others", "隐藏其他应用") },
      { role: "unhide", label: label("Show All", "显示全部") },
      { type: "separator" },
      { role: "quit", label: label("Quit Codex Router", "退出 Codex Router") },
    ] },
    { label: label("File", "文件"), submenu: [
      { role: "close", label: label("Close Window", "关闭窗口") },
    ] },
    { label: label("Edit", "编辑"), submenu: [
      { role: "undo", label: label("Undo", "撤销") },
      { role: "redo", label: label("Redo", "重做") },
      { type: "separator" },
      { role: "cut", label: label("Cut", "剪切") },
      { role: "copy", label: label("Copy", "复制") },
      { role: "paste", label: label("Paste", "粘贴") },
      { role: "selectAll", label: label("Select All", "全选") },
    ] },
    { label: label("View", "显示"), submenu: [
      { role: "reload", label: label("Reload", "重新加载") },
      { role: "forceReload", label: label("Force Reload", "强制重新加载") },
      { role: "toggleDevTools", label: label("Toggle Developer Tools", "切换开发者工具") },
      { type: "separator" },
      { role: "resetZoom", label: label("Actual Size", "实际大小") },
      { role: "zoomIn", label: label("Zoom In", "放大") },
      { role: "zoomOut", label: label("Zoom Out", "缩小") },
      { role: "togglefullscreen", label: label("Toggle Full Screen", "切换全屏") },
    ] },
    { label: label("Window", "窗口"), submenu: [
      { role: "minimize", label: label("Minimize", "最小化") },
      { role: "zoom", label: label("Zoom", "缩放") },
      { label: label("Open Control Center", "打开控制中心"), click: showWindow },
      { role: "front", label: label("Bring All to Front", "前置全部窗口") },
      { role: "close", label: label("Close Window", "关闭窗口") },
    ] },
    { role: "help", label: label("Help", "帮助"), submenu: [] },
  ];
  return { tray, application };
}

export function isInterfaceLanguage(value) {
  return ["en", "zh-CN", "ar", "hi", "ja", "ko", "es"].includes(value);
}
