// 主题清单：themes 目录里的 css 文件就是主题。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThemes, listThemes, buildThemesStylesheet } from '../../src/main/themes.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('主题：目录里的每个 css 文件都是一个主题', async () => {
  const themes = await listThemes(ROOT);
  assert.ok(themes.length >= 3, `只找到 ${themes.length} 个主题`);
  for (const t of themes) {
    assert.ok(t.id, '主题没有 id');
    assert.ok(t.label, `${t.id} 没有名字`);
  }
});

test('主题：名字取自文件头里的「主题：xxx」', async () => {
  const themes = await listThemes(ROOT);
  assert.equal(themes.find((t) => t.id === 'warm')?.label, '暖阳');
});

test('主题：样式表里每个主题都在', async () => {
  const css = await buildThemesStylesheet(ROOT);
  for (const t of await readThemes(ROOT)) {
    assert.ok(css.includes(`[data-theme='${t.id}']`), `${t.id} 不在样式表里`);
  }
});
