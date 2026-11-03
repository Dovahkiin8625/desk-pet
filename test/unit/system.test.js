import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemController } from '../../src/main/system.js';

/**
 * 造一个替身窗口：只记录被调用的方法。
 *
 * **位置必须跟着 setPosition 变**：停靠的判定读的是窗口的真实位置，
 * 替身不动的话拖拽永远停在起点，停靠根本触发不了。
 */
function fakeWindow() {
  const calls = [];
  let pos = [100, 100];
  return {
    calls,
    isDestroyed: () => false,
    getPosition: () => pos,
    getSize: () => [300, 560],
    setPosition: (x, y) => {
      calls.push(['setPosition', x, y]);
      pos = [x, y];
    },
    setIgnoreMouseEvents: (ignore, options) =>
      calls.push(['setIgnoreMouseEvents', ignore, options]),
  };
}

/** 造一个控制器：外部能力全部是替身。 */
function makeController(overrides = {}) {
  const win = fakeWindow();
  const loginItemCalls = [];
  const settings = {
    autoLaunch: false,
    hotkey: 'Control+Shift+D',
    clickThrough: false,
    edgeSnap: true,
    dockEnabled: false,
    dock: null,
    ...(overrides.settings || {}),
  };
  const patched = [];
  let controller = null;
  const options = {
    getWindow: () => win,
    getDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1000, height: 800 },
        workArea: { x: 0, y: 0, width: 1000, height: 800 },
      },
    ],
    getSettings: () => settings,
    // 模拟 index.js 的 persist：改完设置后会回头调 system.applySettings。
    // 这一步是必须的——不回调的话，「改设置 → 生效」这条链在单测里是断的。
    applySettings: (patch) => {
      patched.push(patch);
      Object.assign(settings, patch);
      controller?.applySettings(settings);
      return settings;
    },
    onHotkeyAction: () => {},
    onStateChanged: () => {},
    onHotkeyStatus: () => {},
    loginItem: {
      set: (s) => loginItemCalls.push(s),
      get: () => ({ openAtLogin: false }),
    },
    shortcuts: {
      register: () => true,
      unregister: () => {},
      unregisterAll: () => {},
      isRegistered: () => true,
    },
    getAppPath: () => 'E:/project/desk-pet',
    isPackaged: false,
    isE2E: true,
    ...(overrides.options || {}),
  };
  controller = createSystemController(options);
  return { controller, win, settings, patched, loginItemCalls };
}

test('开机自启：打开时写入登录项', () => {
  const { controller, loginItemCalls, settings } = makeController();
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.equal(loginItemCalls.length, 1);
  assert.equal(loginItemCalls[0].openAtLogin, true);
});

test('开机自启：关闭时也要写（否则系统里还留着）', () => {
  const { controller, loginItemCalls, settings } = makeController({
    settings: { autoLaunch: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: false });
  assert.equal(loginItemCalls.length, 1);
  assert.equal(loginItemCalls[0].openAtLogin, false);
});

test('开机自启：没变化就不重复写注册表', () => {
  const { controller, loginItemCalls, settings } = makeController({
    settings: { autoLaunch: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls, []);
});

test('开机自启：开发态要带上应用路径，否则开机只弹空白 Electron', () => {
  const { controller, loginItemCalls, settings } = makeController({
    options: { isPackaged: false, getAppPath: () => 'E:/project/desk-pet' },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls[0].args, ['E:/project/desk-pet']);
  // path 指向当前可执行文件（Electron 的默认值，写出来是为了明确）。
  assert.equal(loginItemCalls[0].path, process.execPath);
});

test('开机自启：打包后不带参数（process.execPath 就是应用自己）', () => {
  const { controller, loginItemCalls, settings } = makeController({
    options: { isPackaged: true },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  assert.deepEqual(loginItemCalls[0].args, []);
});

test('开机自启：注册失败时把开关改回关闭', () => {
  const { controller, patched, settings } = makeController({
    options: {
      loginItem: {
        set: () => {
          throw new Error('注册表写不进去');
        },
        get: () => ({ openAtLogin: false }),
      },
    },
  });
  controller.init(settings);
  controller.applySettings({ ...settings, autoLaunch: true });
  // 磁盘上不能写着 true 而系统里没有注册项。
  assert.deepEqual(patched, [{ autoLaunch: false }]);
  assert.equal(settings.autoLaunch, false);
});
