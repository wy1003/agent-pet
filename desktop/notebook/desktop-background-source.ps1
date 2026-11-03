# Read-only discovery. Only desktop hosts are returned; never application windows.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class AgentPetDesktopSource {
    private delegate bool Callback(IntPtr window, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    public class Source { public string id; public int x, y, width, height; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr state);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    private static string ClassName(IntPtr window) { var name = new StringBuilder(256); GetClassName(window, name, name.Capacity); return name.ToString(); }
    public static Source[] Find() {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var preferred = new List<Source>(); var fallback = new List<Source>();
        EnumWindows((window, state) => {
            var kind = ClassName(window);
            if ((kind != "Progman" && kind != "WorkerW") || !IsWindowVisible(window)) return true;
            Rect rect; if (!GetWindowRect(window, out rect) || rect.Right - rect.Left < 100 || rect.Bottom - rect.Top < 100) return true;
            bool hasWallpaper = false;
            EnumChildWindows(window, (child, unused) => { if (ClassName(child).StartsWith("WPEDesktop")) hasWallpaper = true; return true; }, IntPtr.Zero);
            var source = new Source { id = "window:" + window.ToInt64() + ":0", x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top };
            if (hasWallpaper) preferred.Add(source); else fallback.Add(source);
            return true;
        }, IntPtr.Zero);
        return (preferred.Count > 0 ? preferred : fallback).ToArray();
    }
}
'@
ConvertTo-Json -InputObject @([AgentPetDesktopSource]::Find()) -Compress
