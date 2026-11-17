// plugins/screenshot/lib/ocr.js
/**
 * 文字识别：走 Windows 自带的 OCR（Windows.Media.Ocr）。
 *
 * 为什么不自己带一个引擎：Windows 11 自带的中英双语识别包是系统的一部分，
 * 不下载模型、不联网、不占磁盘，开箱就能用。要换引擎就得引入几十兆的依赖，
 * 而这个插件要的只是「屏幕上的字」。
 *
 * 怎么调 WinRT：Node 里没有 WinRT 的绑定，于是把一小段 PowerShell 脚本
 * 用 `-EncodedCommand` 喂给 powershell.exe——**不走脚本文件**，
 * 所以不受执行策略（ExecutionPolicy）的影响。
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** OCR 脚本（与本文件同目录）。 */
const SCRIPT_PATH = fileURLToPath(new URL('./ocr.ps1', import.meta.url));

/** 识别语言（设置里的值）→ Windows 的语言标记。 */
export const OCR_LANGUAGES = Object.freeze({
  自动: ['zh-Hans-CN', 'en-US'],
  中文: ['zh-Hans-CN'],
  英文: ['en-US'],
});

/** 一次识别最多等这么久。 */
const TIMEOUT_MS = 30000;

/** 汉字（以及全角标点）——用来判断一句话是不是中文。 */
const CJK = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;

/**
 * 跑那段 PowerShell，拿到它吐的 JSON。
 *
 * @param {string} filePath 图片路径
 * @param {string[]} tags 语言标记
 * @returns {Promise<Array<{lang:string,text:string,words:Array<object>}>>}
 */
function runScript(filePath, tags) {
  return readFile(SCRIPT_PATH, 'utf8').then(
    (script) =>
      new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          {
            env: { ...process.env, OCR_FILE: filePath, OCR_LANGS: tags.join(',') },
            windowsHide: true,
          }
        );
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('识别超时了'));
        }, TIMEOUT_MS);
        child.stdout.on('data', (chunk) => (out += chunk));
        child.stderr.on('data', (chunk) => (err += chunk));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`调不动系统的识别服务：${e.message}`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(firstLine(err) || '识别服务没跑成功'));
            return;
          }
          try {
            const parsed = JSON.parse(out.trim() || '{"lines":[]}');
            resolve(Array.isArray(parsed.lines) ? parsed.lines : []);
          } catch {
            reject(new Error('识别服务回的话看不懂'));
          }
        });
      })
  );
}

/** 报错信息只要第一行（PowerShell 的报错后面跟着一堆）。 */
function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#<')) || '';
}

/**
 * 一行字的包围盒（由它的词算出来）。
 *
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function lineBox(line) {
  const words = line.words || [];
  if (!words.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const word of words) {
    x = Math.min(x, word.x);
    y = Math.min(y, word.y);
    right = Math.max(right, word.x + word.w);
    bottom = Math.max(bottom, word.y + word.h);
  }
  return { x, y, w: right - x, h: bottom - y };
}

/** 两个盒子重合得有多厉害（0～1）。 */
function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (!inter) return 0;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller ? inter / smaller : 0;
}

/**
 * 合并两个引擎的结果（「自动」模式）。
 *
 * 中文引擎认得出汉字，但把英文认歪了（"Hello" 认成 "HeIIo"）；
 * 英文引擎相反——认英文准，汉字完全不看。
 * 所以同一行里：**汉字用中文引擎的词，纯英文的词用英文引擎的**。
 *
 * @param {Array} zh 中文引擎的行
 * @param {Array} en 英文引擎的行
 */
export function mergeAuto(zh, en) {
  const used = new Set();
  const out = [];

  zh.forEach((line) => {
    let bestIndex = -1;
    let bestScore = 0;
    en.forEach((candidate, index) => {
      const score = overlap(lineBox(line), lineBox(candidate));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore > 0.3) {
      used.add(bestIndex);
      const other = en[bestIndex];
      const words = (line.words || []).map((word) => {
        if (CJK.test(word.text)) return word;
        const better = (other.words || []).find((w) => overlap(word, w) > 0.5);
        return better ? { ...word, text: better.text } : word;
      });
      const box = lineBox(line);
      out.push({ text: words.map((w) => w.text).join(' '), x: box.x, y: box.y });
      return;
    }
    const box = lineBox(line);
    out.push({ text: line.text, x: box.x, y: box.y });
  });

  // 中文引擎没读出来的行（纯英文的行它有时会漏）：补上。
  en.forEach((line, index) => {
    if (used.has(index)) return;
    const box = lineBox(line);
    out.push({ text: line.text, x: box.x, y: box.y });
  });

  return dedupe(out);
}

/**
 * 汉字之间的空格去掉。
 *
 * Windows 把汉字一个一个当词（「文」「件」「旧」），拼回来就是「文 件 旧」——
 * 中间那些空格是它加的，不是图上有的。
 */
function tidy(text) {
  return String(text || '').replace(
    /([⺀-鿿　-〿＀-￯])\s+(?=[⺀-鿿　-〿＀-￯])/g,
    '$1'
  );
}

/** 去掉重复的一行（同一句被两个引擎各认了一遍）。 */
export function dedupe(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const text = tidy(line.text).trim();
    if (!text) continue;
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...line, text });
  }
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return out;
}

/**
 * 识别一张图片里的文字。
 *
 * @param {string} filePath 图片路径
 * @param {string} language 设置里的语言（自动 / 中文 / 英文）
 * @returns {Promise<{text:string, lines:Array<{text:string}>}>}
 */
export async function ocrFile(filePath, language = '自动') {
  const tags = OCR_LANGUAGES[language] || OCR_LANGUAGES['自动'];
  // **路径里的斜杠要换成反斜杠**：WinRT 的 StorageFile 只认 Windows 那一种。
  const raw = await runScript(String(filePath).replace(/\//g, '\\'), tags);

  let lines;
  if (tags.length === 1) {
    lines = dedupe(raw.map((line) => {
      const box = lineBox(line);
      return { text: line.text, x: box.x, y: box.y };
    }));
  } else {
    lines = mergeAuto(
      raw.filter((line) => line.lang === 'zh-Hans-CN'),
      raw.filter((line) => line.lang === 'en-US')
    );
  }

  return {
    text: lines.map((line) => line.text).join('\n'),
    lines: lines.map((line) => ({ text: line.text })),
  };
}
