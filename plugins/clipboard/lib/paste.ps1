# 剪贴板插件的助手：把剪贴板里的内容「贴」到刚才在用的那个窗口。
#
# 为什么需要它：Electron 没有「往别的程序发按键」的接口，
# 而 Ctrl+V 必须真的发出去（发到剪贴板不算粘贴）。
#
# 做法是 Windows 惯用的那一套：
#   1. 找出**不是我们自己的**那个前台窗口（用户刚才在用的那个）；
#   2. 把它叫到前台（SetForegroundWindow）；
#   3. 补发 Ctrl+V（keybd_event）。
#
# 第 2 步之前先按一下 Alt：Windows 的「前台锁」只允许前台进程改前台，
# 这一下 Alt 能临时把资格让出来（老办法，但确实管用）。
#
# 通信：stdout 上一行 base64 的 UTF-8 JSON（绕开控制台代码页，中文标题才不乱码）。
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DpPaste {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLongW(IntPtr h, int i);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOPMOST = 0x8;
  const byte VK_MENU = 0x12;
  const byte VK_CONTROL = 0x11;
  const byte VK_V = 0x56;
  const uint KEYUP = 0x2;

  static bool IsTopMost(IntPtr h) { return (GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0; }

  static string Title(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  /// 找出「用户刚才在用的那个窗口」：我们自己之外的、最靠前的那个。
  /// 枚举顺序就是 Z 序（最靠前的先出来），所以第一个就是最近用过的那一个。
  /// 置顶的窗口（各种悬浮窗）排在更后面，先跳过它们。
  public static IntPtr FindTarget(uint ourPid) {
    IntPtr found = IntPtr.Zero;
    IntPtr fallback = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == ourPid) return true;
      if (Title(h).Length == 0) return true;
      if (fallback == IntPtr.Zero) fallback = h;
      if (!IsTopMost(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero ? found : fallback;
  }

  public static string TitleOf(IntPtr h) { return Title(h); }

  /// 把窗口叫到前台，再补发 Ctrl+V。
  public static bool Paste(IntPtr h) {
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(200);
    if (GetForegroundWindow() != h) return false;
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
    return true;
  }
}
'@

function Send-Answer($obj) {
  $json = $obj | ConvertTo-Json -Compress
  $line = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

$ourPid = 0
if ($env:DP_OUR_PID) { $ourPid = [uint32]$env:DP_OUR_PID }

$target = [DpPaste]::FindTarget($ourPid)
if ($target -eq [IntPtr]::Zero) {
  Send-Answer @{ ok = $false; error = '没有找到可以粘贴的窗口' }
  exit 0
}

$title = [DpPaste]::TitleOf($target)
if ([DpPaste]::Paste($target)) {
  Send-Answer @{ ok = $true; title = $title }
} else {
  Send-Answer @{ ok = $false; error = '没能把那个窗口叫到前台'; title = $title }
}
