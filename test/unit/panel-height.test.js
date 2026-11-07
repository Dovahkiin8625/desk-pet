import test from 'node:test';
import assert from 'node:assert/strict';

import { maxPanelHeight } from '../../src/main/panelHeight.js';

/**
 * 面板高度的上限。
 *
 * 面板的窗口按插件页面的内容撑开，所以总得有个上限。
 * 上限按**桌宠所在那块屏的工作区**算：写死一个数的话，
 * 页面一长，底部就被裁掉了（录屏的工作台就是这样）。
 */

/** 造一块显示器。 */
function display(x, y, width, height) {
  return { workArea: { x, y, width, height } };
}

test('拿不到显示器信息：用兜底值', () => {
  assert.equal(maxPanelHeight({ displays: [], fallback: 560 }), 560);
  assert.equal(maxPanelHeight({ displays: [{ workArea: null }], fallback: 560 }), 560);
});

test('按工作区高度算上限，上下留一点余量', () => {
  const height = maxPanelHeight({
    displays: [display(0, 0, 1920, 1040)],
    fallback: 560,
    margin: 24,
  });
  assert.equal(height, 1040 - 24);
});

test('跟着桌宠走：桌宠在第二块屏上，就按那块屏算', () => {
  const displays = [display(0, 0, 1920, 1040), display(1920, 0, 1280, 720)];
  const height = maxPanelHeight({
    displays,
    petRect: { x: 2000, y: 100, width: 200, height: 200 },
    margin: 24,
  });
  assert.equal(height, 720 - 24, '该按第二块屏的工作区算');
});

test('再小也要留够面板自己的下限', () => {
  const height = maxPanelHeight({
    displays: [display(0, 0, 800, 150)],
    minimum: 160,
    margin: 24,
  });
  assert.equal(height, 160, '工作区只有 150 高，也得留够 160');
});
