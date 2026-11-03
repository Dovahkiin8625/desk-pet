import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticFile, isDeniedResource } from '../../src/main/staticFiles.js';

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

test('阻止与根目录同前缀的兄弟目录', () => {
  // 关键用例：/../app-evil/secret.txt 解析到 C:\app-evil\secret.txt。
  // 只做 startsWith(root) 的朴素实现会错误地放行它；
  // 只有带路径分隔符边界的检查（root + sep）才会拒绝。
  assert.equal(resolveStaticFile(ROOT, '/../app-evil/secret.txt'), null);
});

test('允许 node_modules 下的路径', () => {
  const r = resolveStaticFile(ROOT, '/node_modules/pixi.js/dist/browser/pixi.js');
  assert.ok(r);
  assert.ok(r.filePath.includes('node_modules'));
});

test('拒绝提供密钥类文件', () => {
  // app:// 的根是整个项目目录，而项目根目录里可能躺着用户的 API Key。
  // 渲染层只要 fetch('/minimax-api-key') 就能把它读走——
  // 渲染层不是可信边界。这条用例守住那道门。
  assert.equal(isDeniedResource('C:\\app\\minimax-api-key'), true);
  assert.equal(isDeniedResource('C:\\app\\credentials.json'), true);
  assert.equal(isDeniedResource('C:\\app\\server.key'), true);
  assert.equal(isDeniedResource('C:\\app\\cert.pem'), true);
  assert.equal(isDeniedResource('C:\\app\\token.p12'), true);
});

test('拒绝清单按文件名判断，与所在目录无关', () => {
  // 子目录里叫 minimax-api-key 的文件同样危险：
  // 根目录那份只是用户恰好放在那儿的样子。
  assert.equal(isDeniedResource('C:\\app\\tools\\minimax-api-key'), true);
});

test('拒绝清单不区分大小写', () => {
  // Windows 的文件系统不区分大小写：/MiniMax-API-KEY 命中的是同一个文件。
  assert.equal(isDeniedResource('C:\\app\\MiniMax-API-KEY'), true);
  assert.equal(isDeniedResource('C:\\app\\MINIMAX-API-KEY'), true);
});

test('普通资源不被误伤', () => {
  assert.equal(isDeniedResource('C:\\app\\src\\renderer\\index.html'), false);
  assert.equal(isDeniedResource('C:\\app\\package.json'), false);
  assert.equal(isDeniedResource('C:\\app\\assets\\live2d\\index.json'), false);
  // 名字里带着 key 字样但不是密钥文件
  assert.equal(isDeniedResource('C:\\app\\src\\monkey.js'), false);
  assert.equal(isDeniedResource(''), false);
  assert.equal(isDeniedResource(null), false);
});
