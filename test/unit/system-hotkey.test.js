import test from 'node:test';
import assert from 'node:assert/strict';

import { createSystemController } from '../../src/main/system.js';

/**
 * 造一个系统控制器，Electron 的能力全部用替身挡在外面。
 *
 * 快捷键这一段是「全局快捷键」这个功能唯一的按键入口，
 * 而它在浏览器里按不出来——所以必须能单测。
 *
 * @param {object} options
 * @param {object} [options.settings] 初始设置
 * @param {string[]} [options.occupied] 被别的程序占住的组合（注册会失败）
 */
function makeController({ settings: settingsOverrides = {}, occupied = [] } = {}) {
  const settings = {
    hotkey: 'Control+Shift+D',
    panelHotkey: '',
    autoLaunch: false,
    clickThrough: false,
    edgeSnap: true,
    dockEnabled: false,
    dock: null,
    ...settingsOverrides,
  };
  const taken = new Set(occupied);
  // accelerator → 回调。注册成功才在里面。
  const registered = new Map();
  const actions = [];
  const statuses = [];

  const controller = createSystemController({
    getWindow: () => null,
    getDisplays: () => [],
    getSettings: () => settings,
    applySettings: (patch) => {
      Object.assign(settings, patch);
    },
    hotkeyActions: {
      hotkey: () => actions.push('hotkey'),
      panelHotkey: () => actions.push('panelHotkey'),
    },
    onStateChanged: () => {},
    onHotkeyStatus: (status) => statuses.push(status),
    loginItem: {
      set: () => {},
      get: () => ({ openAtLogin: false }),
    },
    shortcuts: {
      register: (acc, cb) => {
        // 被别的程序占住时，globalShortcut.register 返回 false 而且**不抛错**。
        if (taken.has(acc)) return false;
        // 同一个加速键注册两次也会返回 false。
        if (registered.has(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
      unregisterAll: () => registered.clear(),
      isRegistered: (acc) => registered.has(acc),
    },
    getAppPath: () => '',
  });

  /** init 用的那份设置。 */
  const init = () =>
    controller.init({
      hotkey: settings.hotkey,
      panelHotkey: settings.panelHotkey,
      autoLaunch: settings.autoLaunch,
      clickThrough: settings.clickThrough,
      edgeSnap: settings.edgeSnap,
      dockEnabled: settings.dockEnabled,
      dock: settings.dock,
    });

  return { controller, settings, registered, actions, statuses, init };
}

test('init：注册「呼出/隐藏桌宠」，不注册没设的「唤醒输入框」', () => {
  const { init, registered } = makeController();
  init();
  assert.equal(registered.has('Control+Shift+D'), true);
  assert.equal(registered.size, 1);
});

test('init：「唤醒输入框」设了就注册', () => {
  const { init, registered } = makeController({
    settings: { panelHotkey: 'Control+Shift+F' },
  });
  init();
  assert.equal(registered.has('Control+Shift+D'), true);
  assert.equal(registered.has('Control+Shift+F'), true);
});

test('init：磁盘上的组合没有修饰键时**不注册**（不能劫持用户的字母键）', () => {
  const { init, registered, statuses } = makeController({ settings: { hotkey: 'D' } });
  init();
  assert.equal(registered.size, 0);
  assert.equal(statuses[statuses.length - 1].state, 'error');
  assert.match(statuses[statuses.length - 1].error, /修饰键/);
});

test('setHotkey：设上「唤醒输入框」并落盘', () => {
  const { controller, settings, registered } = makeController();
  const ok = controller.setHotkey('panelHotkey', 'Control+Shift+F');
  assert.equal(ok, true);
  assert.equal(settings.panelHotkey, 'Control+Shift+F');
  assert.equal(registered.has('Control+Shift+F'), true);
});

test('setHotkey：状态推送带着槽位名', () => {
  const { controller, statuses } = makeController();
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  const last = statuses[statuses.length - 1];
  assert.equal(last.slot, 'panelHotkey');
  assert.equal(last.state, 'ok');
  assert.equal(last.accelerator, 'Control+Shift+F');
});

test('setHotkey：与另一个槽位撞组合要说清楚是被**自己人**占了', () => {
  const { controller, settings, registered, statuses } = makeController();
  const ok = controller.setHotkey('panelHotkey', 'Control+Shift+D');
  assert.equal(ok, false);
  assert.equal(statuses[statuses.length - 1].state, 'error');
  assert.match(statuses[statuses.length - 1].error, /呼出 \/ 隐藏桌宠/);
  // 没有落盘，也没有注册。
  assert.equal(settings.panelHotkey, '');
  assert.equal(registered.has('Control+Shift+D'), false);
});

test('setHotkey：没有修饰键的组合被拒', () => {
  const { controller, settings, statuses } = makeController();
  const ok = controller.setHotkey('panelHotkey', 'F');
  assert.equal(ok, false);
  assert.match(statuses[statuses.length - 1].error, /修饰键/);
  assert.equal(settings.panelHotkey, '');
});

test('setHotkey：被别的程序占用 → 失败，原来那个仍然有效', () => {
  const { controller, settings, registered, statuses } = makeController({
    occupied: ['Control+Alt+Delete'],
  });
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  const ok = controller.setHotkey('panelHotkey', 'Control+Alt+Delete');
  assert.equal(ok, false);
  assert.equal(statuses[statuses.length - 1].state, 'error');
  assert.match(statuses[statuses.length - 1].error, /其他程序占用/);
  // 原来的组合仍然注册着（换组合失败不能把原来那个也搭进去）。
  assert.equal(settings.panelHotkey, 'Control+Shift+F');
  assert.equal(registered.has('Control+Shift+F'), true);
});

test('setHotkey：换组合时先注册新的、再注销旧的', () => {
  const { controller, settings, registered } = makeController();
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  assert.equal(controller.setHotkey('panelHotkey', 'Control+Shift+G'), true);
  assert.equal(registered.has('Control+Shift+G'), true);
  assert.equal(registered.has('Control+Shift+F'), false);
  assert.equal(settings.panelHotkey, 'Control+Shift+G');
});

test('setHotkey：换组合不会注销**另一个槽位**的组合', () => {
  const { controller, registered } = makeController();
  controller.init({
    hotkey: 'Control+Shift+D',
    panelHotkey: '',
    autoLaunch: false,
    clickThrough: false,
    edgeSnap: true,
    dockEnabled: false,
    dock: null,
  });
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  // 旧的那个是「呼出/隐藏桌宠」的，不该被这次改动注销。
  assert.equal(registered.has('Control+Shift+D'), true);
});

test('clearHotkey：清掉「唤醒输入框」并注销', () => {
  const { controller, settings, registered } = makeController();
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  assert.equal(registered.has('Control+Shift+F'), true);
  const ok = controller.clearHotkey('panelHotkey');
  assert.equal(ok, true);
  assert.equal(settings.panelHotkey, '');
  assert.equal(registered.has('Control+Shift+F'), false);
});

test('clearHotkey：「呼出/隐藏桌宠」那个不许清空', () => {
  const { controller, settings } = makeController();
  const ok = controller.clearHotkey('hotkey');
  assert.equal(ok, false);
  assert.equal(settings.hotkey, 'Control+Shift+D');
});

test('录制：录出来的组合落到**正在录的那个**槽位上', () => {
  const { controller, settings, registered } = makeController();
  assert.equal(controller.startRecording('panelHotkey'), true);
  assert.equal(controller.isRecording(), true);
  const acc = controller.handleInput({ key: 'F', control: true, shift: true });
  assert.equal(acc, 'Control+Shift+F');
  assert.equal(settings.panelHotkey, 'Control+Shift+F');
  assert.equal(settings.hotkey, 'Control+Shift+D');
  assert.equal(registered.has('Control+Shift+F'), true);
});

test('录制：Esc 取消录制，什么都不改', () => {
  const { controller, settings } = makeController();
  controller.startRecording('panelHotkey');
  const acc = controller.handleInput({ key: 'Escape' });
  assert.equal(acc, null);
  assert.equal(controller.isRecording(), false);
  assert.equal(settings.panelHotkey, '');
});

test('录制：没在录制时按键什么也不做', () => {
  const { controller, settings } = makeController();
  assert.equal(controller.handleInput({ key: 'F', control: true }), null);
  assert.equal(settings.panelHotkey, '');
});

test('录制：认不出的槽位不开始', () => {
  const { controller } = makeController();
  assert.equal(controller.startRecording('nope'), false);
  assert.equal(controller.isRecording(), false);
});

test('录制：换一个槽位录时，上一个槽位不再停在「录制中」', () => {
  const { controller, statuses } = makeController();
  controller.startRecording('hotkey');
  controller.startRecording('panelHotkey');
  // 上一个槽位的状态被收回「空闲」——
  // 否则界面上那一行会一直写着「请按下组合键…」。
  const petStatus = statuses.filter((s) => s.slot === 'hotkey').pop();
  assert.equal(petStatus.state, 'idle');
  const panelStatus = statuses.filter((s) => s.slot === 'panelHotkey').pop();
  assert.equal(panelStatus.state, 'recording');
  // 录出来的是**现在**这个槽位的。
  controller.handleInput({ key: 'F', control: true });
  assert.equal(controller.isRecording(), false);
});

test('注册的快捷键按下之后走的是**对应槽位**的动作', () => {
  const { controller, registered, actions } = makeController();
  controller.setHotkey('panelHotkey', 'Control+Shift+F');
  controller.setHotkey('hotkey', 'Control+Shift+G');
  registered.get('Control+Shift+F')();
  registered.get('Control+Shift+G')();
  assert.deepEqual(actions, ['panelHotkey', 'hotkey']);
});
