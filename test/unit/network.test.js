import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNetstatE,
  parseWlan,
  refreshNetwork,
  networkStatus,
  resetNetworkState,
} from '../../src/main/assistant/network.js';
import { formatRate, formatNetwork, formatNetworkShort } from '../../src/shared/network.js';

/**
 * 网络采样。
 *
 * 采的是 netstat -e 与 netsh wlan show interfaces 的输出：解析、限流、
 * 速率怎么从两次采样的差值里算出来。
 */

/** netstat -e 的输出（中文系统：第一行两个数字就是累计字节）。 */
const NETSTAT = `
接口统计

                           收到的字节数            发送的字节数
字节                    2089323902       446522321
接受的数据包              59418938        23573984
发出的数据包              17519          230969
`;

/** netsh 的输出（中文系统）。 */
const WLAN_CN = `
系统上有 1 个接口:

    名称                   : WLAN 2
    说明            : MediaTek Wi-Fi 7
    状态                  : 已连接
    无线电状态           : 硬件 开
    信号                         : 72
`;

/** netsh 的输出（英文系统）。 */
const WLAN_EN = `
There is 1 interface on the system:

    Name                   : Wi-Fi
    State                  : connected
    Signal                 : 88
`;

/** 造一个假的 execFile：按命令名给不同的输出。 */
function fakeExecFile(outputs) {
  const calls = [];
  const run = (cmd, args, options, cb) => {
    calls.push({ cmd, args });
    cb(null, outputs[cmd] ?? '');
  };
  run.calls = calls;
  return run;
}

test('网络：解析 netstat -e 的字节那一行', () => {
  const bytes = parseNetstatE(NETSTAT);
  assert.equal(bytes.received, 2089323902);
  assert.equal(bytes.sent, 446522321);
});

test('网络：netstat 输出里没有数字就不编数', () => {
  assert.equal(parseNetstatE(''), null);
  assert.equal(parseNetstatE('接口统计\n'), null);
});

test('网络：解析 netsh 的信号（中文系统）', () => {
  const list = parseWlan(WLAN_CN);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'WLAN 2');
  assert.equal(list[0].signal, 72);
  assert.equal(list[0].connected, true);
});

test('网络：解析 netsh 的信号（英文系统）', () => {
  const list = parseWlan(WLAN_EN);
  assert.equal(list[0].signal, 88);
  assert.equal(list[0].connected, true);
});

test('网络：Wi-Fi 断开时没有信号', () => {
  const list = parseWlan('    名称 : WLAN 2\n    状态 : 已断开连接\n');
  assert.equal(list[0].connected, false);
  assert.equal(list[0].signal, null);
});

test('网络：第一次采样没有速率', async () => {
  resetNetworkState();
  const run = fakeExecFile({ netstat: NETSTAT, netsh: WLAN_CN });
  const net = await refreshNetwork({ execFile: run, now: 1000 });
  assert.equal(net.down, null);
  assert.equal(net.up, null);
  assert.equal(net.signal, 72);
});

test('网络：速率是两次采样的差值', async () => {
  resetNetworkState();
  const run = fakeExecFile({ netstat: NETSTAT, netsh: WLAN_CN });
  await refreshNetwork({ execFile: run, now: 1000 });
  // 两秒后累计字节多了 2000：那就是 1000 字节每秒。
  const run2 = fakeExecFile({
    netstat: NETSTAT.replace('2089323902', '2089325902'),
    netsh: WLAN_CN,
  });
  const net = await refreshNetwork({ execFile: run2, now: 3000 });
  assert.equal(net.down, 1000);
  assert.equal(net.up, 0);
});

test('网络：两秒之内不重复采样', async () => {
  resetNetworkState();
  const run = fakeExecFile({ netstat: NETSTAT, netsh: WLAN_CN });
  await refreshNetwork({ execFile: run, now: 1000 });
  await refreshNetwork({ execFile: run, now: 1500 });
  assert.equal(run.calls.filter((c) => c.cmd === 'netstat').length, 1);
});

test('网络：采完存下来', async () => {
  resetNetworkState();
  const run = fakeExecFile({ netstat: NETSTAT, netsh: WLAN_CN });
  await refreshNetwork({ execFile: run, now: 1000 });
  assert.equal(networkStatus().signal, 72);
});

test('网络：速率写成什么样', () => {
  assert.equal(formatRate(null), '—');
  assert.equal(formatRate(512), '512 B/s');
  assert.equal(formatRate(2048), '2.0 KB/s');
  assert.equal(formatRate(5 * 1024 * 1024), '5.0 MB/s');
});

test('网络：一行字里有速率、信号与 IP', () => {
  const text = formatNetwork({
    down: 1024,
    up: 0,
    signal: 72,
    connected: true,
    ip: '192.168.1.3',
  });
  assert.match(text, /↓ 1\.0 KB\/s/);
  assert.match(text, /Wi-Fi 72%/);
  assert.match(text, /192\.168\.1\.3/);
  assert.match(formatNetworkShort({ down: 1024, up: 0 }), /↓1\.0 KB\/s/);
});
