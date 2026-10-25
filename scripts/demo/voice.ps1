# Renders each line of narration.json to <outDir>/<key>.wav with a Windows voice. Usage: pwsh voice.ps1 <outDir> [voice name] [rate]
# A soft voice: Hazel (British, female), a little slower than the default.
param([string]$Out, [string]$Voice = 'Microsoft Hazel', [int]$Rate = -1)
Add-Type -AssemblyName System.Speech
$lines = Get-Content (Join-Path $PSScriptRoot 'narration.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $Out | Out-Null
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($Voice)
$s.Rate = $Rate
$s.Volume = 90
foreach ($p in $lines.PSObject.Properties) {
  $s.SetOutputToWaveFile((Join-Path $Out "$($p.Name).wav"))
  $s.Speak($p.Value)
  $s.SetOutputToNull()
}
$s.Dispose()
