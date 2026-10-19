# Raises the Windows runner's virtual display (default 1024x768) so real-Electron specs that size the window to
# 1280..1920 wide are not clamped to the work area. Best effort: a mode the adapter lacks just leaves the default.
param([int]$MaxW = 1920, [int]$MaxH = 1080)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GhRes {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
}
"@
function New-Dm { $d = New-Object GhRes+DEVMODE; $d.dmSize = [Runtime.InteropServices.Marshal]::SizeOf($d); return $d }
$cur = New-Dm
[void][GhRes]::EnumDisplaySettings($null, -1, [ref]$cur)
Write-Host "current: $($cur.dmPelsWidth)x$($cur.dmPelsHeight) @ $($cur.dmBitsPerPel)bpp"
$best = $null
for ($i = 0; ; $i++) {
  $m = New-Dm
  if (-not [GhRes]::EnumDisplaySettings($null, $i, [ref]$m)) { break }
  if ($m.dmPelsWidth -le $MaxW -and $m.dmPelsHeight -le $MaxH -and $m.dmBitsPerPel -ge 24) {
    if ($null -eq $best -or ($m.dmPelsWidth * $m.dmPelsHeight) -gt ($best.dmPelsWidth * $best.dmPelsHeight)) { $best = $m }
  }
}
if ($null -eq $best) { Write-Host "::notice::no usable display mode listed; keeping $($cur.dmPelsWidth)x$($cur.dmPelsHeight)"; exit 0 }
$best.dmFields = 0x80000 -bor 0x100000
$rc = [GhRes]::ChangeDisplaySettings([ref]$best, 0)
$now = New-Dm
[void][GhRes]::EnumDisplaySettings($null, -1, [ref]$now)
Write-Host "::notice::display $($cur.dmPelsWidth)x$($cur.dmPelsHeight) -> asked $($best.dmPelsWidth)x$($best.dmPelsHeight), result code $rc, now $($now.dmPelsWidth)x$($now.dmPelsHeight)"
exit 0
