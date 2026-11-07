$ErrorActionPreference = 'SilentlyContinue'

# 列出桌面上可见的窗口：标题 + 程序的路径。
#
# 为什么不用 Electron 的 desktopCapturer 拿图标：
# Windows 上 DesktopCapturerSource.appIcon 是空的（只有 macOS 有），
# 而为了图标去请求缩略图，系统会去挨个抓一遍窗口画面——
# 实测列一次窗口要 5.5 秒（不要缩略图只要 0.4 秒）。
#
# 所以这里自己枚举窗口，拿到「窗口属于哪个程序」，
# 图标交给 Electron 的 app.getFileIcon（那是本机资源读取得来的，快）。
#
# 输出是 **base64 的 UTF-8 JSON**：
# PowerShell 的控制台编码在中文系统上是 GBK，直接输出 JSON 会把中文弄成乱码，
# 标题对不上就匹配不到图标了。base64 绕开编码问题。

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      uint procId; GetWindowThreadProcessId(h, out procId);
      res.Add(procId + "\t" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

# 进程 id → 程序路径。
# 有些进程读不到路径（权限不够），那就当它没有图标。
$paths = @{}
Get-Process | ForEach-Object {
  $p = $_.Path
  if ($p) { $paths[[uint32]$_.Id] = $p }
}

$out = New-Object System.Collections.ArrayList
foreach ($line in [WinEnum]::List()) {
  $tab = $line.IndexOf("`t")
  if ($tab -lt 1) { continue }
  $procId = [uint32]$line.Substring(0, $tab)
  $title = $line.Substring($tab + 1)
  $exe = ''
  if ($paths.ContainsKey($procId)) { $exe = $paths[$procId] }
  [void]$out.Add([PSCustomObject]@{ Title = $title; Path = $exe })
}

$json = ConvertTo-Json -InputObject @($out) -Compress -Depth 3
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
