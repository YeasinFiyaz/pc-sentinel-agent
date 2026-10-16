$ErrorActionPreference = "Continue"
$AgentDir = "C:\Users\DFIT\PCTrackerAgent"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$AgentScript = Join-Path $AgentDir "agent.js"
$StatusFile = Join-Path $AgentDir "install-status.txt"

"Starting PC Sentinel Pre-Login System Service Installation..." | Out-File -FilePath $StatusFile -Encoding utf8

# 1. Stop any existing node processes running agent.js
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*PCTrackerAgent*agent.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Register Main Pre-Login Boot Agent (Runs as NT AUTHORITY\SYSTEM at Windows Boot BEFORE password login!)
$TaskNameBoot = "PCSentinel_PreLoginBootAgent"
Unregister-ScheduledTask -TaskName $TaskNameBoot -Confirm:$false -ErrorAction SilentlyContinue

$ActionBoot = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$AgentScript`"" -WorkingDirectory $AgentDir
$TriggerStartup = New-ScheduledTaskTrigger -AtStartup
$TriggerLogon = New-ScheduledTaskTrigger -AtLogOn
$PrincipalSystem = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$SettingsBoot = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskNameBoot `
    -Action $ActionBoot `
    -Trigger @($TriggerStartup, $TriggerLogon) `
    -Principal $PrincipalSystem `
    -Settings $SettingsBoot `
    -Description "PC Sentinel Pre-Login Boot Tracker & Remote Shutdown Agent (Runs at Windows Startup before user login)" `
    -Force | Out-Null

"Registered $TaskNameBoot as NT AUTHORITY\SYSTEM (AtStartup + AtLogOn)" | Out-File -FilePath $StatusFile -Append -Encoding utf8

# 3. Register Wake / Fast-Startup Event Trigger Task (Fires when laptop wakes from Sleep, Hibernate, or Fast Startup)
$TaskNameWake = "PCSentinel_WakeFromSleepOrFastStartup"
Unregister-ScheduledTask -TaskName $TaskNameWake -Confirm:$false -ErrorAction SilentlyContinue

$SubscriptionXml = @"
<QueryList>
  <Query Id="0" Path="System">
    <Select Path="System">
      *[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and (EventID=1)]]
      or
      *[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=107)]]
    </Select>
  </Query>
</QueryList>
"@

$CIMTriggerClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler:MSFT_TaskEventTrigger
$TriggerWake = New-CimInstance -CimClass $CIMTriggerClass -ClientOnly
$TriggerWake.Subscription = $SubscriptionXml
$TriggerWake.Enabled = $true

$ActionWake = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$AgentScript`" --wake-only" -WorkingDirectory $AgentDir
$SettingsWake = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskNameWake `
    -Action $ActionWake `
    -Trigger $TriggerWake `
    -Principal $PrincipalSystem `
    -Settings $SettingsWake `
    -Description "PC Sentinel Wake & Fast Startup Alert Hook" `
    -Force | Out-Null

"Registered $TaskNameWake for Fast Startup / Sleep Resume events" | Out-File -FilePath $StatusFile -Append -Encoding utf8

# 4. Open Windows Firewall for Local Mobile PWA Port 4848
Remove-NetFirewallRule -DisplayName "PC Sentinel Mobile App (Port 4848)" -ErrorAction SilentlyContinue
New-NetFirewallRule `
    -DisplayName "PC Sentinel Mobile App (Port 4848)" `
    -Direction Inbound `
    -LocalPort 4848 `
    -Protocol TCP `
    -Action Allow `
    -Profile Any | Out-Null

"Configured Windows Firewall rule for Port 4848" | Out-File -FilePath $StatusFile -Append -Encoding utf8

# 5. Start the Pre-Login Boot Agent right now!
Start-ScheduledTask -TaskName $TaskNameBoot
"Started $TaskNameBoot service." | Out-File -FilePath $StatusFile -Append -Encoding utf8
"INSTALLATION_COMPLETE_SUCCESS" | Out-File -FilePath $StatusFile -Append -Encoding utf8
