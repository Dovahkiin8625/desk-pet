import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeMotions,
  motionListForMenu,
  motionLabelFromFile,
} from '../../src/shared/motions.js';

test('motionLabelFromFile：去掉目录与扩展名（含复合扩展）', () => {
  assert.equal(motionLabelFromFile('motions/haru_g_idle.motion3.json'), 'haru_g_idle');
  assert.equal(motionLabelFromFile('motions/Hiyori_m01.motion3.json'), 'Hiyori_m01');
  assert.equal(motionLabelFromFile('mtn_01.mtn'), 'mtn_01');
  assert.equal(motionLabelFromFile(''), '');
  assert.equal(motionLabelFromFile(null), '');
});

test('motionListForMenu：live2d 清单带上动作文件原名，缺名字的回退到「动作 N」', () => {
  const manifest = {
    type: 'live2d',
    motionGroups: { Idle: 2, TapBody: 3 },
    motionNames: {
      Idle: ['haru_g_idle', 'haru_g_m15'],
      TapBody: ['haru_g_m26', 'haru_g_m06'],
    },
  };
  const list = motionListForMenu(manifest);
  assert.deepEqual(list, [
    {
      group: 'Idle',
      motions: [
        { index: 0, label: 'haru_g_idle' },
        { index: 1, label: 'haru_g_m15' },
      ],
    },
    {
      group: 'TapBody',
      motions: [
        { index: 0, label: 'haru_g_m26' },
        { index: 1, label: 'haru_g_m06' },
        { index: 2, label: '动作 3' },
      ],
    },
  ]);
});

test('motionListForMenu：spine 清单每个动画自成一组，标签就是动画名', () => {
  const manifest = {
    type: 'spine',
    motionGroups: { idle: 1, attack: 1 },
  };
  const list = motionListForMenu(manifest);
  assert.deepEqual(list, [
    { group: 'idle', motions: [{ index: 0, label: 'idle' }] },
    { group: 'attack', motions: [{ index: 0, label: 'attack' }] },
  ]);
});

test('motionListForMenu：异常输入返回空数组', () => {
  assert.deepEqual(motionListForMenu(null), []);
  assert.deepEqual(motionListForMenu({}), []);
  assert.deepEqual(motionListForMenu({ motionGroups: { Idle: '两' } }), []);
});

test('sanitizeMotions：只保留合法项，异常数据被丢掉', () => {
  const input = [
    { group: ' Idle ', motions: [{ index: 0, label: ' haru_g_idle ' }] },
    { group: '', motions: [{ index: 0, label: 'x' }] },
    { group: 'TapBody', motions: [
      { index: 0, label: 'a' },
      { index: -1, label: 'b' },
      { index: '两', label: 'c' },
      { index: 1.5, label: 'd' },
      { index: 3 },
    ] },
    '不是对象',
  ];
  const list = sanitizeMotions(input);
  assert.deepEqual(list, [
    { group: 'Idle', motions: [{ index: 0, label: 'haru_g_idle' }] },
    { group: 'TapBody', motions: [
      { index: 0, label: 'a' },
      { index: 3, label: '动作 4' },
    ] },
  ]);
});

test('sanitizeMotions：整个组没有任何可用动作时丢弃该组', () => {
  const list = sanitizeMotions([
    { group: 'Empty', motions: [{ index: -1, label: 'x' }, { index: 'x', label: 'y' }] },
  ]);
  assert.deepEqual(list, []);
});

test('sanitizeMotions：非数组输入返回空数组', () => {
  assert.deepEqual(sanitizeMotions('不是数组'), []);
  assert.deepEqual(sanitizeMotions(null), []);
  assert.deepEqual(sanitizeMotions(undefined), []);
});

test('sanitizeMotions：超长字符串被截断', () => {
  const list = sanitizeMotions([
    { group: 'g'.repeat(200), motions: [{ index: 0, label: 'l'.repeat(200) }] },
  ]);
  assert.equal(list[0].group.length, 64);
  assert.equal(list[0].motions[0].label.length, 64);
});
