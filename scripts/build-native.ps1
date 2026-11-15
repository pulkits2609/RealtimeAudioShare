param([string]$DotnetPath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$DotnetPath) { $DotnetPath = $env:AUDIOSHARE_DOTNET }
if (!$DotnetPath) {
    $localSdk = Join-Path $projectRoot '.tools/dotnet/dotnet.exe'
    $globalSdk = Get-Command dotnet -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $localSdk) { $DotnetPath = $localSdk }
    elseif ($globalSdk) { $DotnetPath = $globalSdk.Source }
    else { throw 'Install .NET 8 SDK or set AUDIOSHARE_DOTNET to its dotnet.exe. No SDK is downloaded automatically.' }
}
$captureProject = Join-Path $projectRoot 'src-tauri/native-capture/AudioShare.Capture.csproj'
$output = Join-Path $projectRoot 'src-tauri/resources/native'
& $DotnetPath publish $captureProject -c Release -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Built native WASAPI helper: $output/AudioShare.Capture.exe"
