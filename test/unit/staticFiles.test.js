import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticFile } from '../../src/main/staticFiles.js';

const ROOT = 'C:\\app';

test('解析正常路径', () => {
  const r = resolveStaticFile(ROOT, '/src/renderer/index.html');
  assert.ok(r);
  assert.equal(r.filePath, 'C:\\app\\src\\renderer\\index.html');
});

test('根路径映射到渲染层入口', () => {
  const r = resolveStaticFile(ROOT, '/');
  assert.ok(r);
  assert.equal(r.filePath, 'C:\\app\\src\\renderer\\index.html');
});

test('阻止目录穿越', () => {
  assert.equal(resolveStaticFile(ROOT, '/../../secret.txt'), null);
  assert.equal(resolveStaticFile(ROOT, '/..%2f..%2fsecret.txt'), null);
  assert.equal(resolveStaticFile(ROOT, '/src/../../secret.txt'), null);
});

test('允许 node_modules 下的路径', () => {
  const r = resolveStaticFile(ROOT, '/node_modules/pixi.js/dist/browser/pixi.js');
  assert.ok(r);
  assert.ok(r.filePath.includes('node_modules'));
});
