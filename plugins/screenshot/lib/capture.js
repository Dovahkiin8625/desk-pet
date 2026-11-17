// plugins/screenshot/lib/capture.js
/**
 * 抓屏：把显示器或窗口的画面抓成一张图片。
 *
 * 走 Electron 的 desktopCapturer——它是系统给的那一套（与录屏插件同一口）。
 * 抓回来的画面是 nativeImage，既能存成文件，也能裁一块去识别文字。
 */
import { electron } from './electron.js';

/**
 * 一块显示器的**物理像素**大小。
 *
 * bounds 是 DIP，缩放不是 100% 时两者不等——截图要的是原分辨率。
 */
function physicalSize(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale),
  };
}

/**
 * 把每块显示器都抓一遍。
 *
 * **一次调用抓一块尺寸**：`getSources` 的缩略图尺寸是整次调用共用的，
 * 不同尺寸的屏得分开抓；同尺寸的屏共用一次（并行），别一块屏抓一次。
 *
 * @returns {Promise<Array<{display:object,width:number,height:number,image:object}>>}
 */
export async function captureDisplays() {
  const { desktopCapturer, screen } = await electron();
  const displays = screen.getAllDisplays();

  const groups = new Map();
  for (const display of displays) {
    const size = physicalSize(display);
    const key = `${size.width}x${size.height}`;
    if (!groups.has(key)) groups.set(key, { size, displays: [] });
    groups.get(key).displays.push(display);
  }

  const captures = await Promise.all(
    [...groups.values()].map(async (group) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: group.size,
        fetchWindowIcons: false,
      });
      return { group, sources };
    })
  );

  const out = [];
  for (const { group, sources } of captures) {
    const screens = sources.filter((s) => String(s.id).startsWith('screen:'));
    group.displays.forEach((display, index) => {
      const source =
        sources.find((s) => String(s.display_id) === String(display.id)) ||
        screens[index];
      // **不要兜底到别的源**：用户要的是这一块屏，兜底成另一块的话，
      // 截出来的东西跟用户要的完全不是一回事，而且全程没有提示。
      if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
        throw new Error(`这块屏抓不到画面（${display.label || '显示器'}）`);
      }
      out.push({
        display,
        width: group.size.width,
        height: group.size.height,
        image: source.thumbnail,
      });
    });
  }
  return out;
}

/**
 * 抓一块显示器（给 agent 的工具用）。
 *
 * @param {string} [displayId] 显示器 id（不给就是主显示器）
 * @returns {Promise<{image:object,label:string}>}
 */
export async function captureScreen(displayId) {
  const { screen } = await electron();
  const displays = screen.getAllDisplays();
  const target =
    displays.find((d) => String(d.id) === String(displayId || '')) ||
    screen.getPrimaryDisplay() ||
    displays[0];
  if (!target) throw new Error('找不到显示器');

  const size = physicalSize(target);
  const { desktopCapturer } = await electron();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size,
    fetchWindowIcons: false,
  });
  const source = sources.find((s) => String(s.display_id) === String(target.id));
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error(`这块屏抓不到画面（${target.label || '显示器'}）`);
  }
  return { image: source.thumbnail, label: target.label || `显示器 ${target.id}` };
}
