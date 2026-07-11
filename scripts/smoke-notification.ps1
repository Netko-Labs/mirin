param(
  [Parameter(Mandatory = $true)]
  [string]$LibraryPath
)

$source = @"
using System;
using System.Runtime.InteropServices;

public static class MirinNotificationSmoke
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int NotificationShow(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string specification);

    public static int Run(string libraryPath)
    {
        IntPtr library = NativeLibrary.Load(libraryPath);
        try
        {
            IntPtr symbol = NativeLibrary.GetExport(library, "mirin_notification_show");
            NotificationShow show = Marshal.GetDelegateForFunctionPointer<NotificationShow>(symbol);
            return show("{\"title\":\"Mirin release smoke\",\"body\":\"Native Windows notification bridge\"}");
        }
        finally
        {
            NativeLibrary.Free(library);
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$resolved = (Resolve-Path $LibraryPath).Path
$result = [MirinNotificationSmoke]::Run($resolved)
if ($result -ne 0 -and $result -ne 1) {
  throw "notification bridge returned invalid status $result"
}
Write-Host "notification bridge smoke passed (accepted=$($result -eq 1))"
