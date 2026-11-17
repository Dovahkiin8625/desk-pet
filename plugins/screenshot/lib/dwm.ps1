$ErrorActionPreference = 'SilentlyContinue'

# 给某个窗口关掉 DWM 的转场动画（DWMWA_TRANSITIONS = FALSE）。
#
# 为什么非用原生调用不可：整屏 + 置顶的窗口出现时，Windows 会播一段
# 「整屏缩放/淡入」的转场（视觉效果里的「动画效果」），看起来像整块屏
# 缩小了一下。关掉它，窗口出现就是一步到位——和微信的遮罩一个样。
#
# HWND 走环境变量 SHOT_HWND（十进制），不走参数：spawn 的参数在
# 某些机器上会被引号包裹得乱七八糟，环境变量最省心。

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win32Shot {
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
'@

$raw = $env:SHOT_HWND
if (-not $raw) { exit 2 }
$hwnd = [IntPtr]::new([int64]::Parse($raw))
$value = 0
$result = [Win32Shot]::DwmSetWindowAttribute($hwnd, 3, [ref]$value, 4)
if ($result -ne 0) { exit 1 }
exit 0
