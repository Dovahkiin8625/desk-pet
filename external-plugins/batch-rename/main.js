// external-plugins/batch-rename/main.js
/**
 * 批量重命名（不内置、不接给 agent——纯自带界面的工具插件）。
 *
 * 文件清单放在这里（主进程内存里），规则放在页面上（表单里拿），
 * 预览用 lib/plan.js 现算；真正动手前把同一份规则再算一遍，
 * 页面传来的「哪些行有问题」清单页面自己留着不算数。
 */
import { app, dialog } from 'electron';
import { stat } from 'node:fs/promises';
import { normalize, join } from 'node:path';
import { existsSync } from 'node:fs';

import { buildPlan } from './lib/plan.js';
import { applyRenames, undoRenames } from './lib/execute.js';
import { readUndo, writeUndo, clearUndo } from './lib/store.js';

/** Windows 路径大小写不敏感：去重与改名判定都按这个键来。 */
const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

export default function createBatchRenamePlugin() {
  /** 文件清单（绝对路径，添加顺序）。 */
  let files = [];
  let status = '';

  const userDataDir = () => app.getPath('userData');

  /** 列表 + 撤销记录 → 给页面的一份快照。 */
  async function snapshot(report) {
    const undoCount = (await readUndo(userDataDir())).length;
    return {
      files: files.map((path) => ({ path })),
      undoCount,
      status,
      ...(report ? { report } : {}),
    };
  }

  /** 加一批路径：去重、剔目录、剔不存在的。返回加了几个。 */
  async function addPaths(paths) {
    let added = 0;
    let skipped = 0;
    const known = new Set(files.map(keyOf));
    for (const raw of Array.isArray(paths) ? paths : []) {
      const p = typeof raw === 'string' ? normalize(raw) : '';
      if (!p) { skipped += 1; continue; }
      const key = keyOf(p);
      if (known.has(key)) continue;
      try {
        const st = await stat(p);
        if (!st.isFile()) { skipped += 1; continue; }
      } catch {
        skipped += 1;
        continue;
      }
      known.add(key);
      files.push(p);
      added += 1;
    }
    return { added, skipped };
  }

  /** 应用之后：把清单里的旧路径换成新路径（回滚了就别换）。 */
  function replacePaths(mapping) {
    if (!mapping?.length) return;
    const byFrom = new Map(mapping.map((m) => [keyOf(m.from), m.to]));
    files = files.map((p) => byFrom.get(keyOf(p)) ?? p);
  }

  /**
   * 加完文件之后的收尾。
   *
   * 文件已经在共享的清单里（面板与独立窗口同一个插件实例）——
   * 先推一份快照给所有开着的界面，让它们跟上；再按请求脱离成独立窗口。
   */
  async function afterFilesAdded(ctx, payload, added) {
    if (added <= 0) return;
    try {
      ctx?.push?.(await snapshot());
    } catch {
      // 推送没到不碍事：调用方自己的面板会用 act 的回包刷新。
    }
    if (!payload?.detach) return;
    try {
      const result = await ctx?.host?.openWindow?.('batch-rename', 'window');
      if (result && result.ok === false) {
        console.warn('[批量重命名] 自动打开独立窗口没成：', result.message);
        status = '加好了，但没能自动打开独立窗口';
      }
    } catch (err) {
      console.warn('[批量重命名] 自动打开独立窗口失败：', err?.message);
      status = '加好了，但没能自动打开独立窗口';
    }
  }

  async function handleAct(ctx, actionId, payload) {
    switch (actionId) {
      case 'pick-files': {
        const result = await dialog.showOpenDialog({
          title: '选择要重命名的文件',
          buttonLabel: '加入列表',
          properties: ['openFile', 'multiSelections'],
        });
        if (result.canceled || !result.filePaths?.length) {
          return snapshot();
        }
        const { added, skipped } = await addPaths(result.filePaths);
        status = added ? `加入了 ${added} 个文件` + (skipped ? `，${skipped} 个跳过` : '') : '没加进去';
        await afterFilesAdded(ctx, payload, added);
        return snapshot();
      }

      case 'add-files': {
        const { added, skipped } = await addPaths(payload?.paths);
        status = added
          ? `加入了 ${added} 个文件` + (skipped ? `，${skipped} 个没加进去（目录或不存在）` : '')
          : skipped ? '拖进来的都不是文件' : '没有新文件';
        await afterFilesAdded(ctx, payload, added);
        return snapshot();
      }

      case 'remove-file': {
        const key = keyOf(normalize(String(payload?.path ?? '')));
        files = files.filter((p) => keyOf(p) !== key);
        return snapshot();
      }

      case 'clear-files': {
        files = [];
        return snapshot();
      }

      case 'apply': {
        const rules = payload?.rules ?? {};
        const plan = buildPlan(files.map((path) => ({ path })), rules, { exists: existsSync });
        if (plan.error) return snapshot({ ok: false, message: plan.error });
        const bad = plan.counts.invalid + plan.counts.collision;
        if (bad > 0) {
          return snapshot({ ok: false, message: `有 ${bad} 个文件有问题（名字非法或撞车），先改一下规则` });
        }
        const changed = plan.rows.filter((row) => row.status === 'ok');
        if (changed.length === 0) return snapshot({ ok: false, message: '没有需要改的' });

        const result = await applyRenames(changed);
        if (result.ok) {
          await writeUndo(userDataDir(), result.done);
          replacePaths(result.done);
          status = `改了 ${result.done.length} 个文件`;
          return snapshot({ ok: true, message: status });
        }
        if (result.unrestored.length === 0) {
          // 全回滚了：磁盘跟动手前一样，旧的撤销记录留着。
          status = `没改成，已还原（${result.error}）`;
          return snapshot({ ok: false, message: status });
        }
        // 没能全部回滚：把还在磁盘上的记下来，让用户能「撤销」回去。
        await writeUndo(userDataDir(), result.unrestored);
        // 清单里指向「已挪位」的文件的那些行，换成它们现在的路径。
        replacePaths(result.unrestored);
        status = `没改成，而且有 ${result.unrestored.length} 个没还原回去（${result.error}）——可以点「撤销上次」`;
        return snapshot({ ok: false, message: status });
      }

      case 'undo': {
        const entries = await readUndo(userDataDir());
        if (entries.length === 0) {
          return snapshot({ ok: false, message: '没有可撤销的重命名' });
        }
        const result = await undoRenames(entries);
        if (result.remaining.length > 0) {
          await writeUndo(userDataDir(), result.remaining);
        } else {
          await clearUndo(userDataDir());
        }
        // 清单里把「真的回去了」的条目换回原名（没能撤掉的留在原地）。
        const stuckFrom = new Set(result.remaining.map((r) => keyOf(r.from)));
        replacePaths(entries.filter((e) => !stuckFrom.has(keyOf(e.from)))
          .map((e) => ({ from: e.to, to: e.from })));
        const skipped = result.skipped.length;
        status = `撤销了 ${result.undone} 个` + (skipped ? `，${skipped} 个跳过（文件被改过或目标名被占用）` : '');
        return snapshot({ ok: true, message: status });
      }

      default:
        return snapshot();
    }
  }

  return {
    async meta() {
      return {
        title: '批量重命名',
        subtitle: files.length ? `${files.length} 个文件` : '多选 / 拖进文件',
        status,
      };
    },

    /** 页面加载不出来时的退回稿（积木界面）。 */
    page(ctx) {
      return ctx.ui.makePage({
        pluginId: 'batch-rename',
        title: '批量重命名',
        blocks: [ctx.ui.textBlock('自带页面没加载出来——这个插件的界面在 pages/batch-rename.html 里。')],
      });
    },

    async data() {
      return snapshot();
    },

    /** 自带页面的动作。 */
    async act(currentCtx, actionId, payload) {
      try {
        return await handleAct(currentCtx, actionId, payload);
      } catch (err) {
        // 动作里异常：回一句清楚的话，别让页面的按钮永远卡在「处理中」。
        console.error('[批量重命名] 动作失败：', err);
        status = `出错了：${err?.message ?? err}`;
        return snapshot({ ok: false, message: status });
      }
    },

    /** 声明式页面的动作（退回稿里用不到，保持一致）。 */
    async action(ctx, actionId) {
      return ctx.ui.makePage({
        pluginId: 'batch-rename',
        title: '批量重命名',
        blocks: [ctx.ui.textBlock(`自带页面没加载出来。（动作 ${actionId} 被忽略）`)],
      });
    },
  };
}
