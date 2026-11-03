import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemController, buildAccelerator } from '../../src/main/system.js';

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
      // 默认 false：进程刚起来时快捷键并没有注册着，
      // 「已注册」不是默认状态。
      isRegistered: () => false,
    },
    getAppPath: () => 'E:/project/desk-pet',
    isPackaged: false,
    isE2E: true,
    ...(overrides.options || {}),
  };
  controller = createSystemController(options);
  return { controller, win, settings, patched, loginItemCalls };
}

/**
 * 捕获 console.warn。
 *
 * 失败路径**必须留痕**——那是「用户勾了开关但系统里没生效」时唯一的线索，
 * 所以要**验证**它，而不是把它当成测试噪音留在输出里。
 */
function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
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
  const warnings = captureWarnings(() => {
    controller.applySettings({ ...settings, autoLaunch: true });
  });
  // 磁盘上不能写着 true 而系统里没有注册项。
  assert.deepEqual(patched, [{ autoLaunch: false }]);
  assert.equal(settings.autoLaunch, false);
  // 失败必须留痕：终端里要有一条说得清原因的警告。
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /开机自启/);
  assert.match(warnings[0], /注册表写不进去/);
});

test('开机自启：注册失败要通知外面，而且通知时开关已经是回退后的值', () => {
  // holder 是因为回调要在 makeController 返回之后才拿到 settings。
  const holder = {};
  const seen = [];
  const { controller, settings } = makeController({
    options: {
      onStateChanged: () => seen.push(holder.settings.autoLaunch),
      loginItem: {
        set: () => {
          throw new Error('注册表写不进去');
        },
        get: () => ({ openAtLogin: false }),
      },
    },
  });
  holder.settings = settings;
  controller.init(settings);
  captureWarnings(() => {
    controller.applySettings({ ...settings, autoLaunch: true });
  });
  // 界面不能是静默的：失败必须通知出去。
  assert.equal(seen.length, 1);
  // 而且通知的时候开关已经是关闭的——否则界面会停留在「已开启」。
  assert.deepEqual(seen, [false]);
});

test('开机自启：关闭失败时保持旧值，下次同值会重试', () => {
  const { controller, loginItemCalls, patched, settings } = makeController({
    settings: { autoLaunch: true },
    options: {
      loginItem: {
        set: (s) => {
          loginItemCalls.push(s);
          throw new Error('注册表写不进去');
        },
        get: () => ({ openAtLogin: false }),
      },
    },
  });
  controller.init(settings);
  captureWarnings(() => {
    controller.applySettings({ ...settings, autoLaunch: false });
    controller.applySettings({ ...settings, autoLaunch: false });
  });
  // 第一次失败后 applied 仍记着 true（系统里的注册项其实还在），
  // 所以第二次同值调用会重试，而不是「以为已经关了」。
  assert.equal(loginItemCalls.length, 2);
  // 关闭方向失败不改磁盘：只有「打开」方向失败才必须把磁盘改回去。
  assert.deepEqual(patched, []);
});

test('getState 把当前状态与最后一次失败一起报出来', () => {
  const { controller, settings } = makeController();
  controller.init(settings);
  const state = controller.getState();
  assert.equal(state.autoLaunch, false);
  assert.equal(state.clickThroughActive, false);
  assert.equal(state.edgeSnap, true);
  assert.equal(state.lastError, '');
});

test('getState：注册失败后 lastError 说清是什么事、为什么', () => {
  const { controller, settings } = makeController({
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
  captureWarnings(() => {
    controller.applySettings({ ...settings, autoLaunch: true });
  });
  const state = controller.getState();
  // 光在终端留痕不够：界面也要有话说。
  assert.notEqual(state.lastError, '');
  assert.match(state.lastError, /开机自启/);
  assert.match(state.lastError, /注册表写不进去/);
});

test('加速键串：修饰键 + 主键', () => {
  assert.equal(
    buildAccelerator({ key: 'd', control: true, alt: false, shift: true, meta: false }),
    'Control+Shift+D',
  );
});

test('加速键串：纯修饰键不构成组合', () => {
  assert.equal(buildAccelerator({ key: 'Control', control: true }), '');
  assert.equal(buildAccelerator({ key: 'Shift', shift: true }), '');
});

test('加速键串：裸键被拒绝（会全局劫持字母键）', () => {
  assert.equal(buildAccelerator({ key: 'd' }), '');
  assert.equal(buildAccelerator({ key: 'F5' }), '');
});

test('加速键串：Shift 过的符号要还原成基础键', () => {
  // 用户按 Ctrl+Shift+1 时 input.key 是 '!'（美式键盘）。
  // 直接用 '!' 会得到注册不了的 'Control+Shift+!'。
  assert.equal(
    buildAccelerator({ key: '!', control: true, shift: true }),
    'Control+Shift+1',
  );
});

test('加速键串：特殊键名要换成 Electron 的写法', () => {
  assert.equal(buildAccelerator({ key: 'ArrowUp', control: true }), 'Control+Up');
  assert.equal(buildAccelerator({ key: ' ', control: true }), 'Control+Space');
});

test('快捷键注册成功：落盘新组合并注销旧的', () => {
  const registered = [];
  const unregistered = [];
  const { controller, patched, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: (acc) => unregistered.push(acc),
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  controller.setHotkey('Control+Alt+P');
  // init 已经按规格注册了 settings.hotkey，这里再注册新组合——
  // 两次都在列表里，顺序也反映了真实发生的事。
  assert.deepEqual(registered, ['Control+Shift+D', 'Control+Alt+P']);
  assert.deepEqual(unregistered, ['Control+Shift+D']);
  assert.equal(settings.hotkey, 'Control+Alt+P');
});

test('快捷键注册失败：旧组合保留，且不落盘新组合', () => {
  const { controller, patched, settings } = makeController({
    options: {
      shortcuts: {
        register: () => false,
        unregister: () => {
          throw new Error('不该注销旧的');
        },
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  // init 也会注册一次（同样失败）：失败必须留痕，警告要被捕获并断言，
  // 而不是留在测试输出里当噪音。
  const initWarnings = captureWarnings(() => controller.init(settings));
  assert.ok(initWarnings.length >= 1);
  assert.match(initWarnings.join('\n'), /快捷键注册失败/);
  const warnings = captureWarnings(() => {
    const ok = controller.setHotkey('Control+Alt+P');
    assert.equal(ok, false);
  });
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join('\n'), /快捷键注册失败/);
  // 磁盘上的组合没变：用户不至于连原来的快捷键也丢掉。
  assert.deepEqual(patched, []);
  assert.equal(settings.hotkey, 'Control+Shift+D');
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /占用/);
});

test('快捷键语法非法：提示与「被占用」区分开', () => {
  // 「被占用」要用户换个组合；「这个组合不能用」是设置本身写坏了。
  // 混成一句话等于让用户瞎猜。
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: () => {
          throw new Error('Invalid accelerator token');
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  // init 也会尝试注册（同样抛）：失败必须留痕，警告要被捕获并断言，
  // 而不是留在测试输出里当噪音。
  const initWarnings = captureWarnings(() => controller.init(settings));
  assert.ok(initWarnings.length >= 1);
  assert.match(initWarnings.join('\n'), /快捷键注册失败/);
  // 失败必须留痕：警告要被捕获并**断言**，而不是留在测试输出里当噪音。
  const warnings = captureWarnings(() => {
    assert.equal(controller.setHotkey('Control+Alt+P'), false);
  });
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join('\n'), /快捷键注册失败/);
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /不能用/);
  assert.doesNotMatch(state.hotkeyStatus.error, /占用/);
});

test('录制：开始 → 处理按键 → 注册', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.isRecording(), true);
  const acc = controller.handleInput({ key: 'k', control: true, alt: true });
  assert.equal(acc, 'Control+Alt+K');
  // init 已经注册了 settings.hotkey，这里是第二次注册。
  assert.deepEqual(registered, ['Control+Shift+D', 'Control+Alt+K']);
  assert.equal(controller.isRecording(), false);
});

test('录制：Esc 取消', () => {
  const { controller, settings } = makeController();
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.handleInput({ key: 'Escape' }), null);
  assert.equal(controller.isRecording(), false);
});

test('录制：纯修饰键不算数，继续等', () => {
  const { controller, settings } = makeController();
  controller.init(settings);
  controller.startRecording();
  assert.equal(controller.handleInput({ key: 'Control', control: true }), null);
  assert.equal(controller.isRecording(), true);
});

test('启动时按 settings.hotkey 注册一次', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  assert.deepEqual(registered, ['Control+Shift+D']);
});

test('启动时注册失败：只留痕 + 状态为 error，不抛', () => {
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: () => false,
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  // 启动就失败不能抛：抛出去会中断启动，桌宠都开不起来。
  const warnings = captureWarnings(() => controller.init(settings));
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /占用/);
  // 留痕也要被验证：终端里要有一条说得清原因的警告。
  assert.ok(warnings.length >= 1);
  assert.match(warnings.join('\n'), /快捷键注册失败/);
});

test('setHotkey 拒绝没有修饰键的裸键（会全局劫持字母键）', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  const before = registered.length;
  assert.equal(controller.setHotkey('D'), false);
  // 一次都不能注册：裸键注册是全局的，「按 D 一下」会被桌宠吃掉。
  assert.equal(registered.length, before);
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'error');
  assert.match(state.hotkeyStatus.error, /不能用/);
});

test('与当前相同且确实注册着：直接算成功，不重复注册', () => {
  const registered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: () => {},
        unregisterAll: () => {},
        isRegistered: () => true,
      },
    },
  });
  controller.init(settings);
  assert.deepEqual(registered, ['Control+Shift+D']);
  // 已经注册着：重复 register 会返回 false（会被误报成「被占用」），
  // 所以直接算成功。
  assert.equal(controller.setHotkey('Control+Shift+D'), true);
  assert.deepEqual(registered, ['Control+Shift+D']);
});

test('与当前相同但没注册着：不能算成功，要走一次真实注册', () => {
  const registered = [];
  const unregistered = [];
  const { controller, settings } = makeController({
    options: {
      shortcuts: {
        register: (acc) => {
          registered.push(acc);
          return true;
        },
        unregister: (acc) => unregistered.push(acc),
        unregisterAll: () => {},
        isRegistered: () => false,
      },
    },
  });
  controller.init(settings);
  // 启动时注册失败（被别的程序占用）的情况下，用户再录一次同一个组合，
  // 直接算成功的话界面显示正常、快捷键却根本没生效。
  assert.equal(controller.setHotkey('Control+Shift+D'), true);
  assert.deepEqual(registered, ['Control+Shift+D', 'Control+Shift+D']);
  // 同一个组合不能被注销：刚注册上的就是它自己，
  // 注销等于把新组合也一起搭进去。
  assert.deepEqual(unregistered, []);
  const state = controller.getState();
  assert.equal(state.hotkeyStatus.state, 'ok');
});
