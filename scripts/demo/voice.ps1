# Renders each line of narration.json to vo/<key>.wav with a Windows voice. Usage: pwsh voice.ps1 <outDir> [voice name]
param([string]$Out, [string]$Voice = 'Microsoft George')
Add-Type -AssemblyName System.Speech
$lines = Get-Content (Join-Path $PSScriptRoot 'narration.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $Out | Out-Null
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($Voice)
$s.Rate = 0
foreach ($p in $lines.PSObject.Properties) {
  $s.SetOutputToWaveFile((Join-Path $Out "$($p.Name).wav"))
  $s.Speak($p.Value)
  $s.SetOutputToNull()
}
$s.Dispose()
