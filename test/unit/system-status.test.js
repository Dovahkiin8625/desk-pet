import test from 'node:test';
import assert from 'node:assert/strict';

import { formatStatus } from '../../src/main/assistant/systemStatus.js';

/**
 * 系统状态的那段话（气泡里念、工具返回的那份）。
 *
 * GPU 采不到的时候**整行不写**：宁可少一行，也不写「GPU 0%」。
 */

test('状态：有 GPU 就写上占用与型号', () => {
  const text = formatStatus({
    cpu: 20,
    memory: 40,
    gpu: { name: 'RTX 5070 Ti', util: 35, memUsed: 3433, memTotal: 16303 },
  });
  assert.match(text, /GPU 35%（RTX 5070 Ti）/);
});

test('状态：没有 GPU 就不写那一行', () => {
  const text = formatStatus({ cpu: 20, memory: 40, gpu: null });
  assert.doesNotMatch(text, /GPU/);
});
