// 图标集：一份图标，宿主与插件都用它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, ICON_NAMES, DEFAULT_ICON, isIconName, normalizeIconName } from '../../src/shared/icons.js';

test('图标集：每个图标都有标记', () => {
  assert.ok(ICON_NAMES.length > 10, '图标集太空了');
  for (const name of ICON_NAMES) {
    const markup = ICONS[name];
    assert.equal(typeof markup, 'string', `${name} 不是字符串`);
    assert.ok(markup.length > 0, `${name} 是空的`);
    // 标记里只该有 SVG 元素，不该混进别的标签。
    assert.doesNotMatch(markup, /<script/i, `${name} 里混进了脚本`);
  }
});

test('图标集：默认图标自己也在这儿', () => {
  assert.ok(isIconName(DEFAULT_ICON), '默认图标不在图标集里');
});

test('图标名：只认图标集里的名字', () => {
  assert.equal(isIconName('settings'), true);
  assert.equal(isIconName('不存在的图标'), false);
  assert.equal(isIconName(''), false);
  assert.equal(isIconName(null), false);
  assert.equal(isIconName(undefined), false);
});

test('图标名：认不出来的退回默认图标', () => {
  assert.equal(normalizeIconName('settings'), 'settings');
  assert.equal(normalizeIconName('  music  '), 'music');
  // emoji、拼错的、空的——都退回默认的那个。
  assert.equal(normalizeIconName('🎯'), DEFAULT_ICON);
  assert.equal(normalizeIconName('not-an-icon'), DEFAULT_ICON);
  assert.equal(normalizeIconName(''), DEFAULT_ICON);
  assert.equal(normalizeIconName(undefined), DEFAULT_ICON);
});
