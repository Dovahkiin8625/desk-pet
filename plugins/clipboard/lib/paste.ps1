# 剪贴板插件的常驻粘贴助手。
#
# 为什么常驻：一次性的话，每次粘贴都要付一遍 PowerShell 的启动 +
# Add-Type 的 C# 编译（几百毫秒）——双击贴的时候一顿一顿的（像加特林打空枪）。
# 常驻之后这两笔开销只付一次，之后每一贴就是「发一行字、等一行回复」。
#
# 做什么：找出**不是我们自己的**那个前台窗口（用户刚才在用的那个）→
# 把它叫到前台 → 补发 Ctrl+V。
# Windows 的「前台锁」只允许前台进程改前台，所以先按一下 Alt 把资格让出来
# （老办法，但确实管用）。
#
# 通信：stdin 上一行一个请求，stdout 上一行一个响应。
# **整行都是 base64（UTF-8 的 JSON）**：绕开控制台代码页，
# 中文标题不会乱码（PowerShell 读 stdin 用的是系统代码页，
# 直接发 UTF-8 会被按 GBK 解释）。
#
# 请求：{"id":1,"op":"paste","ourPid":1234}
# 响应：{"id":1,"ok":true,"title":"窗口标题"} / {"id":1,"ok":false,"error":"…"}
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

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $id = [int]$request.id
    $op = [string]$request.op
    if ($op -eq 'paste') {
      $ourPid = 0
      if ($request.PSObject.Properties.Name -contains 'ourPid') { $ourPid = [uint32]$request.ourPid }
      $target = [DpPaste]::FindTarget($ourPid)
      if ($target -eq [IntPtr]::Zero) {
        $response = @{ id = $id; ok = $false; error = '没有找到可以粘贴的窗口' }
      } else {
        $title = [DpPaste]::TitleOf($target)
        if ([DpPaste]::Paste($target)) {
          $response = @{ id = $id; ok = $true; title = $title }
        } else {
          $response = @{ id = $id; ok = $false; error = '没能把那个窗口叫到前台'; title = $title }
        }
      }
    } elseif ($op -eq 'ping') {
      $response = @{ id = $id; ok = $true; op = 'ping' }
    } else {
      $response = @{ id = $id; ok = $false; error = "不认识的指令：$op" }
    }
  } catch {
    $response = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  $json = $response | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  [Console]::Out.Flush()
}
