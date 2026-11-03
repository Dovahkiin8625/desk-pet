/**
 * 口型同步：用音频的响度包络驱动模型的嘴部参数。
 *
 * 写值的位置很讲究。第三方库每帧的顺序是
 * （`pixi-live2d-display/dist/cubism4.es.js:5416-5437`）：
 *
 *   动作 → saveParameters → 表情 → 眨眼 → 视线 → 呼吸 → 物理 → 姿势
 *   → **emit('beforeModelUpdate')** → model.update()（= core 的 UpdateParameters+SaveParameters）
 *   → loadParameters
 *
 * 值必须写进 core 的参数数组才能活到画出来的那一帧，而
 * `model.update()` 才是「core → 渲染用 model」的最终拷贝点。
 * 库在它之前 emit 了 `beforeModelUpdate`——那正是「画之前最后一句话」。
 *
 * 为什么不打补丁 `saveParameters`：
 * - 它在表情**之前**，而 Haru 的表情文件本身就会写 `ParamMouthOpenY`
 *   （F02/F03.exp3.json），表情会把口型盖掉；
 * - 它是帧末 `loadParameters()` 用来恢复基准的那份快照，
 *   在它之前写值会让下一帧的动作混合对着你上帧的口型插值——嘴会卡在张开。
 *
 * `beforeModelUpdate` 两个问题都没有：它不污染基准快照，
 * 而且是最后一刻——表情已经叠完了，我们的话最终胜出。
 */

/** 幅度范围。嘴部参数一般是 0..1。 */
function clampAmplitude(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * 给一个模型装上口型驱动。
 *
 * @returns {object|null} 控制句柄；模型没有口型参数时返回 null
 *   （这时整个功能静默关闭，不报错）。
 */
export function attachLipSync(model) {
  const internal = model?.internalModel;
  const core = internal?.coreModel;
  if (!internal || !core) return null;

  // 口型参数从模型自己的设置里取，不写死参数名：
  // 写死的话，换个没有这个参数的模型就会写到越界索引上。
  let ids = [];
  try {
    ids = internal.settings?.getLipSyncParameters?.() || [];
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids) || ids.length === 0) return null;

  const indexes = [];
  for (const id of ids) {
    try {
      const index = core.getParameterIndex(id);
      // getParameterIndex 对不存在的参数返回 -1（合成的越界索引），
      // 写进去会触发 core 的断言。
      if (index >= 0) indexes.push(index);
    } catch {
      /* 模型没有这个参数 */
    }
  }
  if (indexes.length === 0) return null;

  let amplitude = 0;
  const onBeforeModelUpdate = () => {
    for (const index of indexes) {
      try {
        core.setParameterValueByIndex(index, amplitude, 1);
      } catch {
        /* 参数在切换形象后失效：忽略这一帧 */
      }
    }
  };

  internal.on('beforeModelUpdate', onBeforeModelUpdate);

  return {
    /** 设置当前幅度（0..1）。 */
    setAmplitude(value) {
      amplitude = clampAmplitude(value);
    },
    /** 拆掉驱动：模型要被销毁时必须调用，否则闭包会一直引用它。 */
    detach() {
      amplitude = 0;
      try {
        internal.off?.('beforeModelUpdate', onBeforeModelUpdate);
      } catch {
        /* ignore */
      }
    },
  };
}
