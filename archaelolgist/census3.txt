<#
.SYNOPSIS
    Runs the daily census collection across every machine in the machine list.
.DESCRIPTION
    Reads a flat list of machine names, reaches each one over PowerShell Remoting (WinRM),
    and collects OS/patch/.NET/installed-software/IIS/SQL Server facts. Writes one JSON
    census file per machine per day, plus a single accumulating run log recording which
    machines were reached, when, and for how long.

    Nothing is installed or left behind on any target machine. The account this script runs
    as must have local administrator rights on every target; there is no per-machine or
    per-bucket credential handling.
.PARAMETER MachinesPath
    Path to the JSON file listing machine names to census. Defaults to config\machines.json
    next to this script.
.PARAMETER CensusRoot
    Root folder census output is written under. Defaults to .\output next to this script.
#>
[CmdletBinding()]
param(
    [string]$MachinesPath,
    [string]$CensusRoot
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is blank if this file is run via "Run Selection" (F8) or pasted into a
# console instead of executed as a saved script (F5) - fall back to the invoked path, then
# the working directory, so defaulting the two paths below doesn't break in that case.
$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    if ($PSCommandPath) { $scriptRoot = Split-Path -Parent $PSCommandPath }
    else                { $scriptRoot = (Get-Location).Path }
}
if (-not $MachinesPath) { $MachinesPath = Join-Path $scriptRoot 'config\machines.json' }
if (-not $CensusRoot)   { $CensusRoot   = Join-Path $scriptRoot 'output' }

# --- the collector, shipped to each target and executed there ---------------------------
# Everything below runs ON the remote machine via Invoke-Command. It never writes anything
# to disk on the target and returns a single JSON string (Invoke-Command mangles anything
# richer than that crossing the remoting boundary).
$CollectScriptBlock = {

    function Format-CensusDate {
        # ConvertTo-Json on Windows PowerShell 5.1 serializes [datetime] values as
        # "/Date(ticks)/" (ASP.NET AJAX format) instead of a readable timestamp. Format
        # these explicitly as ISO 8601 with the local UTC offset before they reach JSON.
        param($DateTime)
        if ($null -eq $DateTime) { return $null }
        return $DateTime.ToString('o')
    }

    function Invoke-CensusCategory {
        param(
            [scriptblock]$Body
        )
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $result = & $Body
            if ($result -is [hashtable] -and $result.ContainsKey('status')) {
                $result.durationMs = $stopwatch.ElapsedMilliseconds
                return $result
            }
            return @{ status = 'ok'; durationMs = $stopwatch.ElapsedMilliseconds; data = $result }
        }
        catch {
            return @{ status = 'failed'; durationMs = $stopwatch.ElapsedMilliseconds; reason = $_.Exception.Message }
        }
    }

    function Get-CensusIdentity {
        $cs        = Get-CimInstance Win32_ComputerSystem
        $csProduct = Get-CimInstance Win32_ComputerSystemProduct
        $bios      = Get-CimInstance Win32_BIOS
        $cpu       = @(Get-CimInstance Win32_Processor)
        $machineGuid = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid

        $hypervisorSignals = @()
        if ($cs.Manufacturer -match 'VMware')                                            { $hypervisorSignals += 'VMware' }
        if ($cs.Manufacturer -match 'Microsoft Corporation' -and $cs.Model -match 'Virtual Machine') { $hypervisorSignals += 'Hyper-V' }
        if ($cs.Model -match 'KVM|QEMU')                                                 { $hypervisorSignals += 'KVM/QEMU' }
        if ($bios.SerialNumber -match 'Xen')                                             { $hypervisorSignals += 'Xen' }
        if ($cs.Manufacturer -match 'Amazon EC2')                                         { $hypervisorSignals += 'AmazonEC2' }
        if ($cs.Manufacturer -match 'Google')                                             { $hypervisorSignals += 'GoogleComputeEngine' }

        @{
            domain                   = $cs.Domain
            manufacturer             = $cs.Manufacturer
            model                    = $cs.Model
            smbiosUuid               = $csProduct.UUID
            machineGuid              = $machineGuid
            biosSerialNumber         = $bios.SerialNumber
            isVirtual                = $hypervisorSignals.Count -gt 0
            hypervisorSignals        = $hypervisorSignals
            cpuSockets               = $cpu.Count
            cpuCores                 = ($cpu | Measure-Object -Property NumberOfCores -Sum).Sum
            cpuLogicalProcessors     = ($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
        }
    }

    function Get-CensusMemory {
        $cs = Get-CimInstance Win32_ComputerSystem
        @{
            totalPhysicalMemoryBytes = $cs.TotalPhysicalMemory
            totalPhysicalMemoryGB    = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        }
    }

    function Get-CensusDrives {
        $drives = @()
        foreach ($volume in @(Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })) {
            $sizeBytes = $volume.Size
            $freeBytes = $volume.SizeRemaining
            $usedBytes = if ($null -ne $sizeBytes -and $null -ne $freeBytes) { $sizeBytes - $freeBytes } else { $null }
            $percentFree = if ($sizeBytes) { [math]::Round(($freeBytes / $sizeBytes) * 100, 1) } else { $null }

            $drives += @{
                driveLetter  = $volume.DriveLetter
                label        = $volume.FileSystemLabel
                fileSystem   = $volume.FileSystemType
                driveType    = $volume.DriveType
                healthStatus = $volume.HealthStatus
                sizeBytes    = $sizeBytes
                freeBytes    = $freeBytes
                usedBytes    = $usedBytes
                percentFree  = $percentFree
            }
        }

        # Volumes mounted as a folder rather than a drive letter (common on SQL data
        # volumes) are deliberately out of scope here - only lettered drives are reported.
        @{ drives = $drives }
    }

    function Get-CensusOs {
        $os = Get-CimInstance Win32_OperatingSystem
        $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'

        $pendingRebootReasons = @()
        if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') {
            $pendingRebootReasons += 'ComponentBasedServicing'
        }
        if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
            $pendingRebootReasons += 'WindowsUpdate'
        }
        if (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue) {
            $pendingRebootReasons += 'PendingFileRenameOperations'
        }
        $activeName  = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -Name ComputerName -ErrorAction SilentlyContinue).ComputerName
        $currentName = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -Name ComputerName -ErrorAction SilentlyContinue).ComputerName
        if ($activeName -and $currentName -and $activeName -ne $currentName) {
            $pendingRebootReasons += 'ComputerNameChangePending'
        }

        @{
            productName          = $cv.ProductName
            editionId            = $cv.EditionID
            installationType     = $cv.InstallationType
            currentBuild         = $cv.CurrentBuild
            ubr                  = $cv.UBR
            displayVersion       = $cv.DisplayVersion
            architecture         = $os.OSArchitecture
            installDate          = Format-CensusDate $os.InstallDate
            lastBootUpTime       = Format-CensusDate $os.LastBootUpTime
            pendingReboot        = $pendingRebootReasons.Count -gt 0
            pendingRebootReasons = $pendingRebootReasons
        }
    }

    function Get-CensusUpdates {
        $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $resultsPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\Results'
        $detect  = Get-ItemProperty (Join-Path $resultsPath 'Detect')  -ErrorAction SilentlyContinue
        $install = Get-ItemProperty (Join-Path $resultsPath 'Install') -ErrorAction SilentlyContinue

        @{
            currentBuild           = $cv.CurrentBuild
            ubr                    = $cv.UBR
            lastDetectSuccessTime  = $detect.LastSuccessTime
            lastInstallSuccessTime = $install.LastSuccessTime
        }
    }

    function Get-CensusDotNet {
        $frameworkReleaseId = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction SilentlyContinue).Release

        $runtimes = @()
        $sdks     = @()
        if (Get-Command 'dotnet.exe' -ErrorAction SilentlyContinue) {
            $runtimes = @(& dotnet --list-runtimes 2>$null)
            $sdks     = @(& dotnet --list-sdks 2>$null)
        }

        @{
            frameworkReleaseId = $frameworkReleaseId
            coreRuntimes       = $runtimes
            sdks               = $sdks
        }
    }

    function Get-CensusApps {
        # Win32_Product is never called here or anywhere in this script: enumerating it
        # triggers an MSI consistency check and self-repair across every installed product
        # on the machine.
        function Get-UninstallEntries {
            param([string]$Path, [string]$Hive, [string]$Architecture, [string]$Sid)
            Get-ItemProperty $Path -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName } |
                ForEach-Object {
                    # Uninstall registry entries only ever carry a date (yyyyMMdd), never a
                    # time - there's no finer-grained install timestamp available here.
                    $installDate = $_.InstallDate
                    if ($installDate -match '^\d{8}$') {
                        try { $installDate = [datetime]::ParseExact($installDate, 'yyyyMMdd', $null).ToString('yyyy-MM-dd') }
                        catch { }
                    }
                    [PSCustomObject]@{
                        displayName     = $_.DisplayName
                        displayVersion  = $_.DisplayVersion
                        publisher       = $_.Publisher
                        installDate     = $installDate
                        installLocation = $_.InstallLocation
                        systemComponent = [bool]$_.SystemComponent
                        hive            = $Hive
                        architecture    = $Architecture
                        sid             = $Sid
                    }
                }
        }

        $entries = New-Object System.Collections.Generic.List[object]
        $entries.AddRange(@(Get-UninstallEntries 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' 'HKLM' 'x64' $null))
        $entries.AddRange(@(Get-UninstallEntries 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' 'HKLM' 'x86' $null))

        Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue |
            Where-Object { $_.PSChildName -match '^S-1-5-21-\d+-\d+-\d+-\d+$' } |
            ForEach-Object {
                $sid  = $_.PSChildName
                $path = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
                $entries.AddRange(@(Get-UninstallEntries $path 'HKU' 'unknown' $sid))
            }

        @{ count = $entries.Count; entries = $entries }
    }

    function Get-CensusIis {
        if (-not (Test-Path 'HKLM:\SOFTWARE\Microsoft\InetStp')) {
            return @{ status = 'not-present'; reason = 'HKLM:\SOFTWARE\Microsoft\InetStp absent' }
        }

        $configPath = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'
        [xml]$config = Get-Content $configPath -Raw

        $sites = @()
        foreach ($site in @($config.configuration.'system.applicationHost'.sites.site)) {
            $bindings = @()
            foreach ($binding in @($site.bindings.binding)) {
                $bindings += @{
                    protocol              = $binding.protocol
                    bindingInformation    = $binding.bindingInformation
                    sslFlags              = $binding.sslFlags
                    certificateHash       = $binding.certificateHash
                    certificateStoreName  = $binding.certificateStoreName
                }
            }
            $sites += @{
                name     = $site.name
                id       = $site.id
                state    = $site.state
                bindings = $bindings
            }
        }

        @{ sites = $sites }
    }

    function Get-CensusCertificates {
        param($IisResult)

        # thumbprint -> list of what it's bound to, so a cert shared across IIS and RDP
        # (or bound more than once) still shows up as a single entry.
        $boundBySource = @{}
        function Add-BoundThumbprint {
            param([string]$Thumbprint, [string]$Source)
            if (-not $Thumbprint) { return }
            if (-not $boundBySource.ContainsKey($Thumbprint)) {
                $boundBySource[$Thumbprint] = New-Object System.Collections.Generic.List[string]
            }
            if (-not $boundBySource[$Thumbprint].Contains($Source)) {
                $boundBySource[$Thumbprint].Add($Source)
            }
        }

        if ($IisResult.status -eq 'ok') {
            @($IisResult.data.sites) |
                ForEach-Object { $_.bindings } |
                Where-Object { $_.certificateHash } |
                ForEach-Object { Add-BoundThumbprint -Thumbprint $_.certificateHash -Source 'IIS' }
        }

        $rdpQueryError = $null
        try {
            $rdpSetting = Get-CimInstance -Namespace 'root\cimv2\TerminalServices' -ClassName Win32_TSGeneralSetting -ErrorAction Stop
            Add-BoundThumbprint -Thumbprint $rdpSetting.SSLCertificateSHA1Hash -Source 'RDP'
        }
        catch {
            $rdpQueryError = $_.Exception.Message
        }

        # applicationHost.config's certificateHash only covers SNI bindings. Classic,
        # IP-based SSL bindings (still common on real IIS boxes) are registered at the
        # HTTP.SYS layer instead and only show up here, not in the XML.
        $httpSysQueryError = $null
        try {
            $httpSysOutput = & netsh.exe http show sslcert 2>&1
            foreach ($line in $httpSysOutput) {
                if ($line -match 'Certificate Hash\s*:\s*([0-9a-fA-F]+)') {
                    Add-BoundThumbprint -Thumbprint $matches[1] -Source 'HTTP.SYS'
                }
            }
        }
        catch {
            $httpSysQueryError = $_.Exception.Message
        }

        $certificates = @()
        foreach ($thumbprint in $boundBySource.Keys) {
            $cert = Get-ChildItem 'Cert:\LocalMachine' -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $thumbprint } |
                Select-Object -First 1
            if ($cert) {
                $certificates += @{
                    thumbprint      = $cert.Thumbprint
                    subject         = $cert.Subject
                    sanDnsNames     = @($cert.DnsNameList | ForEach-Object { $_.Unicode })
                    issuer          = $cert.Issuer
                    notBefore       = Format-CensusDate $cert.NotBefore
                    notAfter        = Format-CensusDate $cert.NotAfter
                    keySize         = $cert.PublicKey.Key.KeySize
                    daysUntilExpiry = [math]::Floor(($cert.NotAfter - (Get-Date)).TotalDays)
                    boundTo         = @($boundBySource[$thumbprint])
                }
            }
        }

        @{ certificates = $certificates; rdpQueryError = $rdpQueryError; httpSysQueryError = $httpSysQueryError }
    }

    function Get-CensusSqlServer {
        $instanceKey = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
        if (-not (Test-Path $instanceKey)) {
            return @{ status = 'not-present'; reason = "$instanceKey absent" }
        }

        $instanceMap = Get-ItemProperty $instanceKey
        $instances = @()
        foreach ($prop in $instanceMap.PSObject.Properties) {
            if ($prop.Name -like 'PS*') { continue }

            $instanceName = $prop.Name
            $internalName = $prop.Value
            $setupPath = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$internalName\Setup"
            $mssqlPath = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$internalName\MSSQLServer"
            $tcpPath   = "$mssqlPath\SuperSocketNetLib\Tcp\IPAll"

            $setup = Get-ItemProperty $setupPath -ErrorAction SilentlyContinue
            $mssql = Get-ItemProperty $mssqlPath -ErrorAction SilentlyContinue
            $tcp   = Get-ItemProperty $tcpPath   -ErrorAction SilentlyContinue

            $serviceName      = if ($instanceName -eq 'MSSQLSERVER') { 'MSSQLSERVER' }   else { "MSSQL`$$instanceName" }
            $agentServiceName = if ($instanceName -eq 'MSSQLSERVER') { 'SQLSERVERAGENT' } else { "SQLAgent`$$instanceName" }
            $service      = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"      -ErrorAction SilentlyContinue
            $agentService = Get-CimInstance Win32_Service -Filter "Name='$agentServiceName'" -ErrorAction SilentlyContinue

            $instances += @{
                instanceName        = $instanceName
                edition             = $setup.Edition
                version             = $setup.Version
                patchLevel          = $setup.PatchLevel
                sqlBinRoot          = $setup.SQLBinRoot
                sqlDataRoot         = $setup.SQLDataRoot
                collation           = $setup.Collation
                loginMode           = $mssql.LoginMode
                backupDirectory     = $mssql.BackupDirectory
                tcpPort             = $tcp.TcpPort
                tcpDynamicPorts     = $tcp.TcpDynamicPorts
                serviceAccount      = $service.StartName
                serviceState        = $service.State
                agentServiceAccount = $agentService.StartName
                agentServiceState   = $agentService.State
            }
        }

        @{ instances = $instances }
    }

    $iisResult = Invoke-CensusCategory { Get-CensusIis }

    $census = [ordered]@{
        schemaVersion = 1
        computerName  = $env:COMPUTERNAME
        collectedUtc  = (Get-Date).ToUniversalTime().ToString('o')
        identity      = Invoke-CensusCategory { Get-CensusIdentity }
        memory        = Invoke-CensusCategory { Get-CensusMemory }
        os            = Invoke-CensusCategory { Get-CensusOs }
        updates       = Invoke-CensusCategory { Get-CensusUpdates }
        dotnet        = Invoke-CensusCategory { Get-CensusDotNet }
        drives        = Invoke-CensusCategory { Get-CensusDrives }
        apps          = Invoke-CensusCategory { Get-CensusApps }
        iis           = $iisResult
        certificates  = Invoke-CensusCategory { Get-CensusCertificates -IisResult $iisResult }
        sqlserver     = Invoke-CensusCategory { Get-CensusSqlServer }
    }

    $census | ConvertTo-Json -Depth 10 -Compress
}

# --- orchestration: read config, reach each machine, write output ------------------------

if (-not (Test-Path $MachinesPath)) {
    throw "Machine list not found: $MachinesPath"
}
$machines = @((Get-Content $MachinesPath -Raw | ConvertFrom-Json).machines)

if (-not (Test-Path $CensusRoot)) {
    New-Item -ItemType Directory -Path $CensusRoot -Force | Out-Null
}
$runsDir = Join-Path $CensusRoot '_runs'
if (-not (Test-Path $runsDir)) {
    New-Item -ItemType Directory -Path $runsDir -Force | Out-Null
}
$runLogPath = Join-Path $runsDir 'run-log.json'

$runLog = New-Object System.Collections.Generic.List[object]
if (Test-Path $runLogPath) {
    $existing = @(Get-Content $runLogPath -Raw | ConvertFrom-Json)
    $runLog.AddRange($existing)
}

$dateStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd')

foreach ($machineName in $machines) {
    Write-Verbose "Collecting $machineName"

    $startedUtc = (Get-Date).ToUniversalTime()
    $stopwatch  = [System.Diagnostics.Stopwatch]::StartNew()
    $outcome    = 'ok'
    $reason     = $null

    try {
        try {
            Test-WSMan -ComputerName $machineName -ErrorAction Stop | Out-Null
        }
        catch {
            throw "unreachable: $($_.Exception.Message)"
        }

        $jsonText = Invoke-Command -ComputerName $machineName -ScriptBlock $CollectScriptBlock -ErrorAction Stop

        $censusObject = $jsonText | ConvertFrom-Json
        $censusObject | Add-Member -NotePropertyName requestedName -NotePropertyValue $machineName -Force

        $roles = New-Object System.Collections.Generic.List[string]
        if ($censusObject.iis.status -eq 'ok' -and $censusObject.iis.data.sites.Count -gt 0) {
            $roles.Add('WebServer')
        }
        if ($censusObject.sqlserver.status -eq 'ok' -and $censusObject.sqlserver.data.instances.Count -gt 0) {
            $roles.Add('DatabaseServer')
        }
        $devSignal = $censusObject.dotnet.status -eq 'ok' -and $censusObject.dotnet.data.sdks.Count -gt 0
        if ($devSignal) {
            if ($censusObject.os.data.installationType -match 'Server') {
                $roles.Add('DevServer')
            }
            else {
                $roles.Add('DevLaptop')
            }
        }
        $censusObject | Add-Member -NotePropertyName roles -NotePropertyValue $roles.ToArray() -Force

        $machineDir = Join-Path $CensusRoot $machineName.ToUpperInvariant()
        if (-not (Test-Path $machineDir)) {
            New-Item -ItemType Directory -Path $machineDir -Force | Out-Null
        }
        $outFile = Join-Path $machineDir "$($machineName.ToLowerInvariant())-census-$dateStamp.json"
        $censusObject | ConvertTo-Json -Depth 10 | Set-Content -Path $outFile -Encoding utf8
    }
    catch {
        if ($_.Exception.Message -like 'unreachable:*') {
            $outcome = 'unreachable'
            $reason  = $_.Exception.Message -replace '^unreachable:\s*', ''
        }
        else {
            $outcome = 'failed'
            $reason  = $_.Exception.Message
        }
    }
    finally {
        $stopwatch.Stop()
        $runLog.Add([PSCustomObject]@{
            machine     = $machineName
            outcome     = $outcome
            reason      = $reason
            startedUtc  = $startedUtc.ToString('o')
            finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
            durationMs  = $stopwatch.ElapsedMilliseconds
        })
    }
}

$runLog | ConvertTo-Json -Depth 5 | Set-Content -Path $runLogPath -Encoding utf8
