$ErrorActionPreference = 'SilentlyContinue'

# 列出桌面上看得见的窗口与显示器：位置与大小（框选前自动选窗用）。
#
# 为什么自己枚举，不用 Electron 的 desktopCapturer：
# desktopCapturer 给的是**捕获源**（没有位置），而且要窗口图标的话
# 系统会去挨个抓一遍窗口画面，慢得要命（实测列一次要 5.5 秒）。
# 截图要的是「窗口在哪」，自己枚举才拿得到。
#
# **坐标是物理像素**：脚本先把进程设成 per-monitor DPI 感知，
# 否则 GetWindowRect 给的是被系统缩放过的逻辑坐标——在 150% 的屏幕上
# 框出来的地方会跟窗口对不上。
#
# 窗口的位置是**相对它所在那块屏的左上角**给的：多块屏的缩放不一样时，
# 屏与屏之间的偏移没有统一的物理含义，只有屏内的偏移是准的。
#
# 输出是 **base64 的 UTF-8 JSON**：PowerShell 的控制台编码在中文系统上是 GBK，
# 直接输出 JSON 会把中文弄成乱码。base64 绕开编码问题。

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ShotWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool MonitorProc(IntPtr hMon, IntPtr hdc, IntPtr rect, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO mi);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr h, int type, out uint dpiX, out uint dpiY);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  public static bool MakeDpiAware() {
    // PER_MONITOR_AWARE_V2 = -4；老系统上退一步用 SetProcessDPIAware。
    if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true;
    return SetProcessDPIAware();
  }

  public class Monitor {
    public IntPtr Handle;
    public int X, Y, W, H;
    public uint Dpi;
  }

  public class Win {
    public int Pid, X, Y, W, H;
    public string Title;
    public string Class;
    public int Monitor;
    // z 序：EnumWindows 枚举出来就是从顶到下的——被压在下面的窗口
    // 指针点不到，吸附也不该框它。
    public int Z;
  }

  public static List<Monitor> ListMonitors() {
    var res = new List<Monitor>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (h, hdc, rect, l) => {
      var mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(mi);
      if (!GetMonitorInfo(h, ref mi)) return true;
      uint dx = 96, dy = 96;
      GetDpiForMonitor(h, 0, out dx, out dy);   // MDT_EFFECTIVE_DPI
      res.Add(new Monitor {
        Handle = h,
        X = mi.rcMonitor.Left, Y = mi.rcMonitor.Top,
        W = mi.rcMonitor.Right - mi.rcMonitor.Left,
        H = mi.rcMonitor.Bottom - mi.rcMonitor.Top,
        Dpi = dx
      });
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static List<Win> ListWindows(List<Monitor> monitors) {
    var res = new List<Win>();
    int z = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      if (IsIconic(h)) return true;              // 最小化的窗口框不到
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w <= 0 || ht <= 0) return true;
      int cloaked = 0;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;  // 换过虚拟桌面的
      uint pid; GetWindowThreadProcessId(h, out pid);
      int len = GetWindowTextLengthW(h);
      var sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      var sbCls = new StringBuilder(256);
      GetClassNameW(h, sbCls, sbCls.Capacity);
      IntPtr mon = MonitorFromWindow(h, 2);       // MONITOR_DEFAULTTONEAREST
      int index = -1;
      for (int i = 0; i < monitors.Count; i++) {
        if (monitors[i].Handle == mon) { index = i; break; }
      }
      if (index < 0) return true;
      var m = monitors[index];
      res.Add(new Win {
        Pid = (int)pid,
        // **相对所在屏的左上角**：屏内偏移才是准的物理像素。
        X = r.Left - m.X, Y = r.Top - m.Y,
        W = w, H = ht,
        Title = sb.ToString(),
        Class = sbCls.ToString(),
        Monitor = index,
        Z = z++,
      });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

[ShotWindows]::MakeDpiAware() | Out-Null

$monitors = [ShotWindows]::ListMonitors()

$mList = New-Object System.Collections.ArrayList
foreach ($m in $monitors) {
  [void]$mList.Add([PSCustomObject]@{
    Index = $monitors.IndexOf($m)
    X = [int]$m.X
    Y = [int]$m.Y
    W = [int]$m.W
    H = [int]$m.H
    Dpi = [int]$m.Dpi
  })
}

$wList = New-Object System.Collections.ArrayList
foreach ($w in [ShotWindows]::ListWindows($monitors)) {
  [void]$wList.Add([PSCustomObject]@{
    Pid = [int]$w.Pid
    X = [int]$w.X
    Y = [int]$w.Y
    W = [int]$w.W
    H = [int]$w.H
    Title = [string]$w.Title
    Class = [string]$w.Class
    Monitor = [int]$w.Monitor
    Z = [int]$w.Z
  })
}

$json = ConvertTo-Json -InputObject ([PSCustomObject]@{
  Monitors = @($mList)
  Windows = @($wList)
}) -Compress -Depth 4
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
