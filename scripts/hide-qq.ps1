# 隐藏所有 QQ 主窗口（NapCat QQNT shell 弹出时藏到后台）
Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'
Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    [W.N]::ShowWindow($_.MainWindowHandle, 0)
}