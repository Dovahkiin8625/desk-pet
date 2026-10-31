import { resolveExpressionName, resolveMotionSpec } from './manifest.js';

/** 语义化的反应表：这里只有语义，不含任何模型专属名字。 */
export const ZONE_BEHAVIOR = {
  head: { expression: 'happy', motion: 'tapHead' },
  body: { expression: 'smile', motion: 'tapBody' },
};

export function reactionFor(manifest, zone) {
  const b = ZONE_BEHAVIOR[zone];
  if (!b) return { expressionName: null, motionSpec: null };
  return {
    expressionName: resolveExpressionName(manifest, b.expression),
    motionSpec: resolveMotionSpec(manifest, b.motion),
  };
}

/** 空闲时的默认反应：回到 normal 表情并播放 idle 动作。 */
export function idleReaction(manifest) {
  return {
    expressionName: resolveExpressionName(manifest, 'normal'),
    motionSpec: resolveMotionSpec(manifest, 'idle'),
  };
}
