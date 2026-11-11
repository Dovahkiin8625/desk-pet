import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNvidiaCsv, refreshGpu, gpuStatus, resetGpuState } from '../../src/main/assistant/gpu.js';

/**
 * GPU 采样。
 *
 * 采的是 nvidia-smi 的输出：解析、限流、机器上没有这个程序时怎么办。
 */

/** 造一个假的 execFile。 */
function fakeExecFile(stdout, error = null) {
  const calls = [];
  const run = (cmd, args, options, cb) => {
    calls.push({ cmd, args, options });
    cb(error, stdout);
  };
  run.calls = calls;
  return run;
}

test('GPU：解析 nvidia-smi 的 CSV', () => {
  const gpu = parseNvidiaCsv('5, 3433, 16303, NVIDIA GeForce RTX 5070 Ti\n');
  assert.equal(gpu.util, 5);
  assert.equal(gpu.memUsed, 3433);
  assert.equal(gpu.memTotal, 16303);
  assert.equal(gpu.name, 'NVIDIA GeForce RTX 5070 Ti');
});

test('GPU：输出是空的时候不编数', () => {
  assert.equal(parseNvidiaCsv(''), null);
  assert.equal(parseNvidiaCsv('   \n'), null);
  assert.equal(parseNvidiaCsv('N/A, N/A, N/A, Something'), null);
});

test('GPU：采样到就存下来', async () => {
  resetGpuState();
  const run = fakeExecFile('12, 1000, 16000, RTX 4070\n');
  const gpu = await refreshGpu({ execFile: run, now: 1000 });
  assert.equal(gpu.util, 12);
  assert.equal(gpuStatus().name, 'RTX 4070');
  assert.equal(run.calls[0].cmd, 'nvidia-smi');
});

test('GPU：两秒之内不重复采样', async () => {
  resetGpuState();
  const run = fakeExecFile('12, 1000, 16000, RTX 4070\n');
  await refreshGpu({ execFile: run, now: 1000 });
  await refreshGpu({ execFile: run, now: 1500 });
  assert.equal(run.calls.length, 1);
  await refreshGpu({ execFile: run, now: 4000 });
  assert.equal(run.calls.length, 2);
});

test('GPU：机器上没有 nvidia-smi 就不再试了', async () => {
  resetGpuState();
  const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
  const run = fakeExecFile('', err);
  await refreshGpu({ execFile: run, now: 1000 });
  assert.equal(gpuStatus(), null);
  await refreshGpu({ execFile: run, now: 9999 });
  assert.equal(run.calls.length, 1);
});
