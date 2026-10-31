import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drawIcon } from '../../scripts/gen-icon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readPng(path) {
  let buf;
  try {
    buf = await readFile(path);
  } catch {
    assert.fail(`缺少 ${path}，请先运行 npm run setup`);
  }
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${path} 不是合法 PNG`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('托盘图标存在且尺寸正确', async () => {
  const small = await readPng(join(ROOT, 'assets', 'icons', 'tray.png'));
  assert.equal(small.width, 32);
  assert.equal(small.height, 32);
  const large = await readPng(join(ROOT, 'assets', 'icons', 'tray@2x.png'));
  assert.equal(large.width, 64);
  assert.equal(large.height, 64);
});

test('半透明边缘像素使用直通 alpha，未被覆盖率压暗', () => {
  for (const size of [32, 64]) {
    const rgba = drawIcon(size);
    // 外圈是覆盖率为 k/16 的抗锯齿像素（alpha 约为 16/32/64/80/96/112）。
    // 若把预乘 alpha 的颜色直接写进 RGB，这些像素的颜色会随覆盖率线性变暗
    // （预乘未反预乘时最外圈会接近纯黑 (9,8,12)），边缘会出现黑边。
    // 正确实现下，这些像素反预乘后的颜色应完全一致，且保持明亮。
    const colors = new Map();
    for (let i = 0; i < size * size; i++) {
      const a = rgba[i * 4 + 3];
      if (a > 0 && a <= 112) {
        const key = `${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]}`;
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
    }
    const total = [...colors.values()].reduce((a, b) => a + b, 0);
    assert.ok(total >= 8, `size=${size} 应存在低覆盖率边缘像素，实际 ${total} 个`);
    assert.equal(
      colors.size,
      1,
      `size=${size} 的低覆盖率边缘像素反预乘后应只有一种颜色，实际有 ${colors.size} 种：${[...colors.keys()].join(' | ')}`
    );
    const [r, g, b] = [...colors.keys()][0].split(',').map(Number);
    assert.ok(
      Math.max(r, g, b) >= 100,
      `size=${size} 的边缘颜色 ${r},${g},${b} 偏暗，说明预乘 alpha 没有被反预乘`
    );
  }
});

test('导入 gen-icon.mjs 不会写文件的副作用', async () => {
  const icons = [join(ROOT, 'assets', 'icons', 'tray.png'), join(ROOT, 'assets', 'icons', 'tray@2x.png')];
  const before = [];
  for (const p of icons) before.push((await stat(p)).mtimeMs);

  const url = pathToFileURL(join(ROOT, 'scripts', 'gen-icon.mjs')).href;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('imported');`],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.match(out, /imported/);

  const after = [];
  for (const p of icons) after.push((await stat(p)).mtimeMs);
  assert.deepEqual(after, before, '仅仅 import gen-icon.mjs 不应重新生成图标文件');
});
