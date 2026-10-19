# Raises the Windows runner's virtual display (default 1024x768) so real-Electron specs are not squeezed into a small
# work area. Best effort: a mode the adapter lacks just leaves the default. DEVMODE is handled as a raw 156-byte buffer
# (dmSize at 36, dmFields at 40, dmBitsPerPel at 104, dmPelsWidth at 108, dmPelsHeight at 112).
param([int]$MaxW = 1920, [int]$MaxH = 1080)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GhRes {
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern bool EnumDisplaySettings(string dev, int mode, byte[] dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettings(byte[] dm, int flags);
}
"@
function New-Dm { $b = New-Object byte[] 156; [BitConverter]::GetBytes([int16]156).CopyTo($b, 36); return ,$b }
function Get-Dm($b) { [pscustomobject]@{ W = [BitConverter]::ToInt32($b, 108); H = [BitConverter]::ToInt32($b, 112); Bpp = [BitConverter]::ToInt32($b, 104) } }
$cur = New-Dm
$ok = [GhRes]::EnumDisplaySettings([NullString]::Value, -1, $cur)
$c = Get-Dm $cur
Write-Host "current: $($c.W)x$($c.H) @ $($c.Bpp)bpp (enum ok=$ok)"
$best = $null
$bestArea = 0
for ($i = 0; ; $i++) {
  $m = New-Dm
  if (-not [GhRes]::EnumDisplaySettings([NullString]::Value, $i, $m)) { break }
  $g = Get-Dm $m
  if ($g.W -le $MaxW -and $g.H -le $MaxH -and $g.Bpp -ge 24 -and ($g.W * $g.H) -gt $bestArea) { $best = $m; $bestArea = $g.W * $g.H }
}
if ($null -eq $best) { Write-Host "::notice::no usable display mode listed; keeping $($c.W)x$($c.H)"; exit 0 }
$bg = Get-Dm $best
[BitConverter]::GetBytes([int]0x180000).CopyTo($best, 40)
$rc = [GhRes]::ChangeDisplaySettings($best, 0)
$now = New-Dm
[void][GhRes]::EnumDisplaySettings([NullString]::Value, -1, $now)
$n = Get-Dm $now
Write-Host "::notice::display $($c.W)x$($c.H) -> asked $($bg.W)x$($bg.H), result code $rc, now $($n.W)x$($n.H)"
exit 0
