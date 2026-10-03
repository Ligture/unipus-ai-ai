param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [string]$OutputPath,
    [ValidateSet('auto', 'cpu', 'cuda', 'cuda:0')][string]$Device = 'auto',
    [ValidateSet('auto', 'zh', 'en', 'yue', 'ja', 'ko', 'nospeech')][string]$Language = 'auto',
    [string]$ModelRoot = 'D:\Project\search_via_bilibili\models',
    [string]$PythonPath = 'D:\Project\search_via_bilibili\.venv\Scripts\python.exe'
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.asr-runtime'
if (-not (Test-Path -LiteralPath $PythonPath)) { throw "Python runtime missing: $PythonPath" }
if (-not (Test-Path -LiteralPath (Join-Path $runtimePath 'audio_transcription'))) {
    throw "Local transcription package missing: $runtimePath"
}
$previousPythonPath = $env:PYTHONPATH
$previousPath = $env:PATH
try {
    $env:PYTHONPATH = if ($previousPythonPath) { "$runtimePath;$previousPythonPath" } else { $runtimePath }
    $env:PATH = "$projectRoot;$previousPath"
    $cliArgs = @('-m', 'audio_transcription', $InputPath, '--model-root', $ModelRoot,
                 '--device', $Device, '--language', $Language)
    if ($OutputPath) { $cliArgs += @('--output', $OutputPath) }
    & $PythonPath @cliArgs
    if ($LASTEXITCODE -ne 0) { throw "Transcription failed with exit code $LASTEXITCODE" }
} finally {
    $env:PYTHONPATH = $previousPythonPath
    $env:PATH = $previousPath
}
