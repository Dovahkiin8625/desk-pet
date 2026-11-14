// Spine 骨骼动画模型的端到端验证。
//
// 用的是**现造**的一份最小 Spine 4.1 模型（骨架 JSON + 图集 + 一张纯色 PNG）：
// 真游戏里的 Spine 资源躺在 D 盘的游戏目录里，不能拿来做测试依赖。
//
// 要验的是整条链路：
//   注册表 → app:// 虚拟根 → 渲染层加载 → 画到**第二块画布**上。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-userdata-spine');

// ---------------------------------------------------------------------------
// 一张纯色 PNG（测试用的角色贴图）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 一张纯色 PNG。 */
function solidPng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 4;
      raw[p] = rgba[0];
      raw[p + 1] = rgba[1];
      raw[p + 2] = rgba[2];
      raw[p + 3] = rgba[3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 一份最小 Spine 4.1 模型
// ---------------------------------------------------------------------------

const SKELETON = {
  skeleton: { hash: 'e2e', spine: '4.1.20', x: 0, y: 0, width: 64, height: 64 },
  bones: [{ name: 'root' }],
  slots: [{ name: 'body', bone: 'root', attachment: 'body' }],
  skins: [
    {
      name: 'default',
      attachments: {
        body: { body: { type: 'region', x: 0, y: 0, width: 64, height: 64 } },
      },
    },
  ],
  animations: {
    idle: {
      bones: {
        root: {
          rotate: [
            { time: 0, angle: 0, degrees: true },
            { time: 1, angle: 5, degrees: true },
          ],
        },
      },
    },
    tap_head: {
      bones: {
        root: {
          rotate: [
            { time: 0, angle: 0, degrees: true },
            { time: 0.5, angle: -8, degrees: true },
          ],
        },
      },
    },
  },
};

const ATLAS = [
  '0.png',
  'size: 64, 64',
  'format: RGBA8888',
  'filter: Nearest, Nearest',
  'repeat: none',
  'body',
  '  bounds: 0, 0, 64, 64',
  '',
].join('\n');

async function seedSpineModel() {
  const dir = join(USER_DATA, 'live2d', 'models', 'spinechar');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'model.json'), JSON.stringify(SKELETON));
  await writeFile(join(dir, 'model.atlas'), ATLAS);
  await writeFile(join(dir, '0.png'), solidPng(64, [90, 170, 255, 255]));
  await writeFile(
    join(dir, 'pet.json'),
    JSON.stringify({
      id: 'spinechar',
      name: 'SpineChar',
      type: 'spine',
      spine: {
        skeleton: 'model.json',
        atlas: 'model.atlas',
        skeletonFormat: 'json',
        textures: ['0.png'],
      },
      viewport: { width: 300, height: 560 },
      fit: { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
    }),
  );
  await writeFile(
    join(USER_DATA, 'live2d', 'registry.json'),
    JSON.stringify({
      version: 1,
      models: [
        {
          id: 'spinechar',
          name: 'SpineChar',
          type: 'spine',
          manifest: 'spinechar/pet.json',
        },
      ],
    }),
  );
  await writeFile(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({ version: 1, modelId: 'spinechar', scale: 1, opacity: 1, visible: true }),
  );
}

test.describe('Spine 骨骼动画模型', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await seedSpineModel();
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('能加载出来并画到自己的画布上', async () => {
    const app = await electron.launch({
      args: [ROOT],
      env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
    });
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      expect(await pet.evaluate(() => window.__pet.modelId)).toBe('spinechar');
      expect(await pet.evaluate(() => window.__pet.manifest?.type)).toBe('spine');
      // 走的是用户模型的虚拟根。
      expect(await pet.evaluate(() => window.__pet.manifest?.base)).toBe('/__models__');
      // Spine 没有表情。
      expect(await pet.evaluate(() => window.__pet.expressions.length)).toBe(0);

      // 动作按动画名映射：idle 与 tap_head 都认得。
      const motions = await pet.evaluate(() => window.__pet.manifest?.motions);
      expect(motions?.idle?.group).toBe('idle');
      expect(motions?.tapHead?.group).toBe('tap_head');

      // Spine 的舞台在，画布可见；Live2D 那块画布藏起来了。
      const canvases = await pet.evaluate(() =>
        Array.from(document.querySelectorAll('#stage canvas')).map((c) => ({
          visible: c.style.display !== 'none',
          width: c.width,
        })),
      );
      expect(canvases.length).toBe(2);
      expect(canvases.filter((c) => c.visible).length).toBe(1);
      expect(canvases[1].visible).toBe(true);

      // 画布上真的有东西：Spine 的舞台里渲染出了不透明的像素。
      const painted = await pet.evaluate(() => {
        const s = window.__pet.spineStage;
        if (!s) return { ok: false };
        const el = s.app.renderer.extract.canvas(s.app.stage);
        const data = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque += 1;
        return { ok: true, opaque, total: el.width * el.height };
      });
      expect(painted.ok).toBe(true);
      expect(painted.opaque).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  test('切回 Live2D 形象后，两块画布的显隐跟着换', async () => {
    const app = await electron.launch({
      args: [ROOT],
      env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
    });
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      expect(await pet.evaluate(() => window.__pet.modelId)).toBe('spinechar');

      // 切到内置的 Live2D 形象。
      const ok = await pet.evaluate(() => window.__pet.switchModel('haru'));
      expect(ok).toBe(true);
      await pet.waitForFunction(() => window.__pet?.modelId === 'haru', null, { timeout: 30000 });

      const canvases = await pet.evaluate(() =>
        Array.from(document.querySelectorAll('#stage canvas')).map((c) => c.style.display !== 'none'),
      );
      expect(canvases.length).toBe(2);
      expect(canvases[0]).toBe(true);
      expect(canvases[1]).toBe(false);

      // 再切回 Spine：纹理是缓存过的，释放后重新加载必须还能画出来。
      const back = await pet.evaluate(() => window.__pet.switchModel('spinechar'));
      expect(back).toBe(true);
      await pet.waitForFunction(() => window.__pet?.modelId === 'spinechar', null, { timeout: 30000 });
      const repainted = await pet.evaluate(() => {
        const s = window.__pet.spineStage;
        if (!s) return { ok: false };
        const el = s.app.renderer.extract.canvas(s.app.stage);
        const data = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque += 1;
        return { ok: true, opaque };
      });
      expect(repainted.ok).toBe(true);
      expect(repainted.opaque).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
