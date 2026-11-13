import test from 'node:test';
import assert from 'node:assert/strict';

import { promisesAction } from '../../src/main/assistant/layer/promise.js';

/**
 * 认「我要去做某件事」那句话。
 *
 * 样例都是真的：左边那几条是模型真的只回了一句话、没把事交出去时说的原话
 * （同一个模型、同一句「放首歌」，实测大约每五次漏一次）。
 */

test('说了要去做的，认得出来', () => {
  const promises = [
    '好嘞，我去给你放一首，别切窗口啦。',
    '好嘞，我去给你挑一首。',
    '好嘞，我去挑一首。',
    '好嘞，我给你放一首，傍晚这种光线适合慢一点的。',
    '好嘞，给你放一首轻快的——傍晚嘛，适合有点暖的调子。我挑了首不吵的钢琴曲，陪你待着正好。',
    '好嘞，给你这会儿放一首慢一点的：《起风了》。',
    '我给你放首歌吧，轻一点的，你就当背景音躺着听。',
    '我这就去查一下。',
    '交给我吧。',
  ];
  for (const text of promises) {
    assert.ok(promisesAction(text), `没认出来：${text}`);
  }
});

test('只是聊天、不是承诺的，不认', () => {
  const notPromises = [
    '你好呀！傍晚好，今天第一次听你说话呢。要我放首歌配个气氛，还是先聊两句？',
    '累了就别硬撑啦，先靠着歇会儿。要不要我放首歌给你当下背景？',
    '我先看看。',
    '还在跑，我盯着呢。',
    '今天过得怎么样，想说就说，不想说也行。',
    '我去年在那边待过一阵。',
    '我放不下心，老想着这件事。',
    '我陪你聊会儿天吧。',
  ];
  for (const text of notPromises) {
    assert.ok(!promisesAction(text), `认错了：${text}`);
  }
});

test('空话不算承诺', () => {
  assert.equal(promisesAction(''), false);
  assert.equal(promisesAction(null), false);
  assert.equal(promisesAction(undefined), false);
});
