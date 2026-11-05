/**
 * 极简 mp4 解析：找出每个轨道是画面还是声音，以及画面的尺寸。
 *
 * 不引 ffprobe——那是本机装的东西，不是项目的依赖。
 * 这里只需要回答两个问题：有没有声音轨？画面多大？
 */

/** 读一个 box 的头，返回 {type, size, bodyStart, end}。 */
function readBox(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  const size =
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3];
  const type = String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7]
  );
  let headerSize = 8;
  let realSize = size;
  if (size === 1) {
    // 64 位长度：取高 4 字节（这里只用到小文件，取低 4 字节够了）。
    realSize =
      bytes[offset + 12] * 0x1000000 +
      (bytes[offset + 13] << 16) +
      (bytes[offset + 14] << 8) +
      bytes[offset + 15];
    headerSize = 16;
  }
  if (!realSize) return null;
  return { type, size: realSize, bodyStart: offset + headerSize, end: offset + realSize };
}

/** 在一段字节里找所有指定类型的 box。 */
function findBoxes(bytes, start, end, type) {
  const found = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(bytes, offset);
    if (!box || box.end > end || box.end <= offset) break;
    if (box.type === type) found.push(box);
    offset = box.end;
  }
  return found;
}

/** 在某个 box 的内容里递归找。 */
function findDeep(bytes, start, end, type) {
  const direct = findBoxes(bytes, start, end, type);
  if (direct.length) return direct;
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(bytes, offset);
    if (!box || box.end > end || box.end <= offset) break;
    const nested = findDeep(bytes, box.bodyStart, box.end, type);
    if (nested.length) return nested;
    offset = box.end;
  }
  return [];
}

/**
 * 解析 mp4。
 *
 * @param {ArrayBuffer|Buffer} input
 * @returns {{tracks: Array<{type:string,width:number,height:number}>}}
 */
export function parseMp4Tracks(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const moov = findBoxes(bytes, 0, bytes.length, 'moov')[0];
  const tracks = [];
  if (!moov) return { tracks };
  for (const trak of findBoxes(bytes, moov.bodyStart, moov.end, 'trak')) {
    const hdlr = findDeep(bytes, trak.bodyStart, trak.end, 'hdlr')[0];
    let type = '';
    if (hdlr) {
      // hdlr 的内容：版本(1) + 标志(3) + 预定义(4) + 处理类型(4)
      type = String.fromCharCode(
        bytes[hdlr.bodyStart + 8],
        bytes[hdlr.bodyStart + 9],
        bytes[hdlr.bodyStart + 10],
        bytes[hdlr.bodyStart + 11]
      );
    }
    const tkhd = findDeep(bytes, trak.bodyStart, trak.end, 'tkhd')[0];
    let width = 0;
    let height = 0;
    if (tkhd) {
      // tkhd 尾部：版本0 是 4 字节宽高（16.16 定点），版本1 是 8 字节
      const version = bytes[tkhd.bodyStart];
      const base = tkhd.end - (version === 1 ? 8 : 4);
      width =
        bytes[base] * 0x1000000 +
        (bytes[base + 1] << 16) +
        (bytes[base + 2] << 8) +
        bytes[base + 3];
      height =
        bytes[base + 4] * 0x1000000 +
        (bytes[base + 5] << 16) +
        (bytes[base + 6] << 8) +
        bytes[base + 7];
      width = Math.round(width / 65536);
      height = Math.round(height / 65536);
    }
    tracks.push({ type, width, height });
  }
  return { tracks };
}
