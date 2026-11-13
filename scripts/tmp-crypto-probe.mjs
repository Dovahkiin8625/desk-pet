// 临时分析：判断加密模型的文件是不是「固定密钥流」。
// 判据：同一密钥流加密下，两个明文前缀相同的文件，
// 密文逐字节异或应当全为 0。
import fs from 'node:fs';
import path from 'node:path';

const LPK = 'D:/Program Files/LpkUnpacker/output';

const DIRS = {
  sailimiye: '塞利米耶号 - 自投罗网的预言家？',
  mercury: '水星号 - 天使降临之日',
  goldendeer: '金鹿号 - 微笑的白色魅影',
};

function head(file, n = 64) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  return buf;
}

function xor(a, b) {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

console.log('=== 同名文件跨模型：密文 XOR ===');
for (const name of ['Motions_Idle_0_File_0', 'Textures_0_0', 'Moc_0']) {
  const files = Object.entries(DIRS)
    .map(([k, d]) => [k, path.join(LPK, d, name)])
    .filter(([, p]) => fs.existsSync(p));
  if (files.length < 2) {
    console.log(`  ${name}: 只有 ${files.length} 个模型有，跳过`);
    continue;
  }
  const [k0, p0] = files[0];
  const h0 = head(p0);
  for (const [k, p] of files.slice(1)) {
    const x = xor(h0, head(p));
    const zeros = x.subarray(0, 16).every((b) => b === 0);
    console.log(
      `  ${name}: ${k0} ^ ${k} -> ${zeros ? '前16字节全0 ✔ 同密钥流' : '不一致 ✘'}\n    ${x.subarray(0, 16).toString('hex')}`,
    );
  }
}

console.log('\n=== 同一文件内的周期性（密钥长度 L 的自相关）===');
for (const [k, d] of Object.entries(DIRS)) {
  const p = path.join(LPK, d, 'Motions_Idle_0_File_0');
  if (!fs.existsSync(p)) continue;
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(65536);
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const scores = [];
  for (const L of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    let same = 0;
    let n = 0;
    for (let i = 0; i + L < buf.length; i++) {
      n++;
      if (buf[i] === buf[i + L]) same++;
    }
    scores.push(`L=${L}:${(same / n).toFixed(4)}`);
  }
  console.log(`  ${k}: ${scores.join('  ')}`);
}

console.log('\n=== 字节频率（均匀 = 流加密/压缩）===');
for (const [k, d] of Object.entries(DIRS)) {
  const p = path.join(LPK, d, 'Moc_0');
  if (!fs.existsSync(p)) continue;
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1 << 20);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const freq = new Array(256).fill(0);
  for (let i = 0; i < n; i++) freq[buf[i]]++;
  const min = Math.min(...freq);
  const max = Math.max(...freq);
  console.log(`  ${k}: n=${n} 每字节出现次数 min=${min} max=${max}（理想≈${(n / 256).toFixed(0)}）`);
}
