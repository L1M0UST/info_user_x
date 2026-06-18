param(
  [string]$TaskName = "InfoUserX-DailyCollector"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json

$timeParts = $config.schedule.time.Split(":")
$hour = [int]$timeParts[0]
$minute = [int]$timeParts[1]

if ($config.schedule.windowsTaskName) {
  $TaskName = $config.schedule.windowsTaskName
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -File `"$projectRoot\scripts\run-daily.ps1`""

$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($hour).AddMinutes($minute))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Collect latest X posts for configured authors" `
  -Force
