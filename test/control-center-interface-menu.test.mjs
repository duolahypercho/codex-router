import assert from "node:assert/strict";
import test from "node:test";
import { interfaceMenuTemplates, isInterfaceLanguage } from "../apps/control-center/electron/interface-menu.mjs";

test("Chinese native menus retain platform roles and action callbacks", () => {
  let opened = 0;
  let closed = 0;
  const callbacks = { showWindow: () => opened++, quit: () => closed++ };
  const zh = interfaceMenuTemplates("zh-CN", callbacks);
  const en = interfaceMenuTemplates("en", callbacks);
  assert.equal(zh.tray[0].label, "打开控制中心");
  assert.equal(en.tray[0].label, "Open Control Center");
  assert.equal(zh.application[2].label, "编辑");
  assert.equal(zh.application[2].submenu.find(item => item.role === "copy").label, "复制");
  for (const role of ["reload", "forceReload", "toggleDevTools", "close"]) {
    assert.ok(zh.application.some(item => item.submenu.some(entry => entry.role === role)), role);
  }
  zh.tray[0].click();
  zh.tray[2].click();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.deepEqual(zh.application.flatMap(item => item.submenu.map(entry => entry.role)), en.application.flatMap(item => item.submenu.map(entry => entry.role)));
});

test("interface language validates bounded locale IDs", () => {
  for (const value of [null, {}, "../../zh-CN", "Chinese", ""]) assert.equal(isInterfaceLanguage(value), false);
  for (const value of ["en", "zh-CN", "ja"]) assert.equal(isInterfaceLanguage(value), true);
});
