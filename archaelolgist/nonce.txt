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

        # SQL Server hands back DateTimes with Kind=Unspecified, and 'o' then emits no offset
        # at all. System.Text.Json accepts that string but silently stamps it with the
        # *reader's* local offset - so the same census file read in another timezone would
        # describe a different instant. These values are server local time and the collector
        # runs on that server, so Local is the accurate qualification.
        if ($DateTime -is [datetime] -and $DateTime.Kind -eq [System.DateTimeKind]::Unspecified) {
            $DateTime = [datetime]::SpecifyKind($DateTime, [System.DateTimeKind]::Local)
        }
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

    # --- IIS helpers ---------------------------------------------------------------------
    # Field-by-field rationale for everything below is in
    # .docs\features\census-collector.md section 8.6.

    function Get-CensusXmlAttribute {
        # Attribute-absent and attribute-present-but-empty are different facts in
        # applicationHost.config: managedRuntimeVersion="" means "No Managed Code", while an
        # absent attribute means "inherit the default". Dotted XML navigation collapses both
        # to $null, so attributes are always read explicitly.
        # HasAttribute/GetAttribute rather than indexing .Attributes: PowerShell cannot
        # disambiguate XmlAttributeCollection's int and string indexer overloads and throws
        # "Argument types do not match" instead of returning the attribute.
        param($Node, [string]$Name)
        if ($null -eq $Node) { return $null }
        if (-not $Node.HasAttribute($Name)) { return $null }
        return $Node.GetAttribute($Name)
    }

    function Get-CensusSha256Text {
        # Untyped on purpose: [string]$null coerces to '', which would defeat the guard below
        # and hash the empty string instead of reporting "no value".
        param($Text)
        if ($null -eq $Text) { return $null }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
            return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
        }
        finally { $sha.Dispose() }
    }

    function Get-CensusFileFacts {
        param([string]$Path)
        $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        if (-not $item) { return @{ status = 'not-present'; path = $Path } }
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try {
                $stream = [System.IO.File]::OpenRead($item.FullName)
                try   { $hashBytes = $sha.ComputeHash($stream) }
                finally { $stream.Dispose() }
            }
            finally { $sha.Dispose() }
        }
        catch {
            return @{ status = 'insufficient-rights'; path = $item.FullName; reason = $_.Exception.Message }
        }
        @{
            status       = 'ok'
            path         = $item.FullName
            lastWriteUtc = Format-CensusDate $item.LastWriteTimeUtc
            sizeBytes    = $item.Length
            sha256       = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
        }
    }

    function Expand-CensusConfigPath {
        # applicationHost.config stores paths with %SystemDrive% and friends unexpanded. Both
        # forms are kept so a variable that could not be expanded stays visible instead of
        # silently producing a wrong path.
        # Untyped on purpose: [string]$null coerces to '', and an absent path must stay null
        # rather than becoming an empty string a consumer cannot tell from a real value.
        param($Path)
        if ([string]::IsNullOrEmpty($Path)) { return @{ raw = $null; expanded = $null; expandable = $true } }
        $expanded = [System.Environment]::ExpandEnvironmentVariables($Path)
        @{ raw = $Path; expanded = $expanded; expandable = ($expanded -notmatch '%[^%]+%') }
    }

    function Resolve-CensusHostAlias {
        # '.', '(local)', 'localhost', a loopback address and '(localdb)\x' all mean "this
        # machine". Left alone, every locally-referenced database across the estate collapses
        # onto one shared node in a downstream dependency map - see graph-interop.md section 6.
        # Untyped on purpose: see Expand-CensusConfigPath. A connection string with no
        # recognisable server key must yield a null host, not an empty one.
        param($HostName)
        if ([string]::IsNullOrEmpty($HostName)) { return @{ host = $null; rawHost = $null; isLocal = $false } }
        $trimmed = $HostName.Trim()
        $lowered = $trimmed.ToLowerInvariant()
        if (@('.', '(local)', 'localhost', '127.0.0.1', '::1', '[::1]') -contains $lowered -or $lowered -like '(localdb)*') {
            return @{ host = $env:COMPUTERNAME; rawHost = $trimmed; isLocal = $true }
        }
        if ($lowered -eq $env:COMPUTERNAME.ToLowerInvariant() -or $lowered -like ($env:COMPUTERNAME.ToLowerInvariant() + '.*')) {
            return @{ host = $trimmed; rawHost = $trimmed; isLocal = $true }
        }
        @{ host = $trimmed; rawHost = $trimmed; isLocal = $false }
    }

    function ConvertFrom-CensusBindingInformation {
        # 'ip:port:hostHeader' is the http/https grammar only. net.tcp, net.msmq and net.pipe
        # use entirely different shapes ('808:*'), so parsing is protocol-gated and the parsed
        # fields stay null rather than carrying garbage. The bracket alternative in the regex
        # keeps IPv6 literals ('[::1]:80:host') from splitting on their own colons.
        param([string]$Protocol, [string]$BindingInformation)
        $parsed = @{ ip = $null; port = $null; hostHeader = $null; parsed = $false }
        if (@('http', 'https') -notcontains $Protocol) { return $parsed }
        if ($BindingInformation -notmatch '^(\[[^\]]+\]|[^:]*):(\d*):(.*)$') { return $parsed }
        $parsed.ip = $matches[1]
        if ($matches[2]) { $parsed.port = [int]$matches[2] }
        if ($matches[3]) { $parsed.hostHeader = $matches[3] }
        $parsed.parsed = $true
        $parsed
    }

    function Test-CensusSchemaUrl {
        # XML namespace and schema URIs appear throughout every web.config. Without this they
        # would swamp a dependency map with edges to w3.org.
        param([string]$HostName)
        $schemaHosts = @(
            'schemas.xmlsoap.org', 'schemas.microsoft.com', 'schemas.datacontract.org',
            'schemas.openxmlformats.org', 'schemas.android.com', 'www.w3.org', 'w3.org',
            'tempuri.org', 'docs.oasis-open.org', 'java.sun.com', 'xmlns.oracle.com',
            'ws-i.org', 'purl.org', 'www.opengis.net', 'go.microsoft.com', 'www.iis.net',
            'schemas.zune.net', 'namespaces.soaplite.com'
        )
        $lowered = $HostName.ToLowerInvariant()
        foreach ($schemaHost in $schemaHosts) {
            if ($lowered -eq $schemaHost -or $lowered.EndsWith('.' + $schemaHost)) { return $true }
        }
        return $false
    }

    function ConvertFrom-CensusUrlValue {
        # Returns $null when the value is not an absolute http(s) URL, or is a well-known
        # schema URI. Userinfo and query string are dropped where they are read and never
        # written; their presence survives as booleans (spec section 6.7).
        param([string]$Value)
        if ([string]::IsNullOrEmpty($Value)) { return $null }
        # Must be declared as [System.Uri]: TryCreate's [ref] parameter is type-checked, and an
        # untyped $null here throws "Argument types do not match" rather than failing to parse.
        [System.Uri]$uri = $null
        if (-not [System.Uri]::TryCreate($Value.Trim(), [System.UriKind]::Absolute, [ref]$uri)) { return $null }
        if (@('http', 'https') -notcontains $uri.Scheme) { return $null }
        if (Test-CensusSchemaUrl $uri.Host) { return $null }
        $resolved = Resolve-CensusHostAlias $uri.Host
        @{
            scheme         = $uri.Scheme
            host           = $resolved.host
            rawHost        = $resolved.rawHost
            isLocal        = $resolved.isLocal
            port           = $uri.Port
            path           = $uri.AbsolutePath
            hadCredentials = -not [string]::IsNullOrEmpty($uri.UserInfo)
            hadQuery       = -not [string]::IsNullOrEmpty($uri.Query)
            sha256         = Get-CensusSha256Text $Value.Trim()
        }
    }

    function ConvertFrom-CensusConnectionString {
        # Parse-and-drop (spec section 6.7): the raw string is never returned and never
        # reaches disk. Every name is kept, including DefaultConnection - filtering here is
        # irreversible, and a real DefaultConnection pointing at production is the finding
        # worth having.
        param([string]$Value, [string]$ProviderName)

        $pairs = @{}
        foreach ($segment in $Value.Split(';')) {
            if ([string]::IsNullOrWhiteSpace($segment)) { continue }
            $split = $segment.Split('=', 2)
            if ($split.Count -ne 2) { continue }
            $pairs[$split[0].Trim().ToLowerInvariant()] = $split[1].Trim()
        }

        function Get-Pair {
            param($Table, [string[]]$Keys)
            foreach ($key in $Keys) { if ($Table.ContainsKey($key)) { return $Table[$key] } }
            return $null
        }

        $serverValue   = Get-Pair $pairs @('server', 'data source', 'datasource', 'addr', 'address', 'network address')
        $databaseValue = Get-Pair $pairs @('initial catalog', 'database')
        $integrated    = Get-Pair $pairs @('integrated security', 'trusted_connection')
        $userValue     = Get-Pair $pairs @('user id', 'uid', 'username', 'user')
        $passwordValue = Get-Pair $pairs @('password', 'pwd')
        $attachValue   = Get-Pair $pairs @('attachdbfilename')

        $authMode = 'unknown'
        if ($integrated -and @('true', 'sspi', 'yes') -contains $integrated.ToLowerInvariant()) { $authMode = 'integrated' }
        elseif ($userValue) { $authMode = 'sql' }

        # A LocalDB attachment or a bare .mdf is a dependency on a file, not on a database
        # server - emitting it as a server edge would invent a node that does not exist.
        $kind = 'database'
        if ($attachValue -or ($serverValue -and $serverValue -match '\.(mdf|sdf|db|sqlite)\s*$')) { $kind = 'file' }

        $protocol = $null
        $instance = $null
        $port     = $null
        $filePath = $null
        $resolved = @{ host = $null; rawHost = $serverValue; isLocal = $false }

        if ($kind -eq 'file') {
            # Host and instance parsing is skipped entirely here: splitting 'C:\data\app.mdf'
            # on its backslash yields host 'C:' and instance 'data\app.mdf', which would put a
            # machine called "C:" into a dependency map.
            $filePath = if ($attachValue) { $attachValue } else { $serverValue }
        }
        else {
            $hostPart = $serverValue
            if ($hostPart -and $hostPart -match '^(tcp|np|lpc|admin):(.*)$') {
                $protocol = $matches[1]
                $hostPart = $matches[2]
            }
            if ($hostPart -and $hostPart.Contains(',')) {
                $split    = $hostPart.Split(',', 2)
                $hostPart = $split[0]
                $parsedPort = 0
                if ([int]::TryParse($split[1].Trim(), [ref]$parsedPort)) { $port = $parsedPort }
            }
            if ($hostPart -and $hostPart.Contains('\') -and $hostPart -notlike '(localdb)*' -and -not $hostPart.StartsWith('\\')) {
                $split    = $hostPart.Split('\', 2)
                $hostPart = $split[0]
                $instance = $split[1]
            }
            $resolved = Resolve-CensusHostAlias $hostPart
        }

        $normalized = (($pairs.Keys | Sort-Object | ForEach-Object { "$_=$($pairs[$_])" }) -join ';')

        @{
            kind                   = $kind
            provider               = if ($ProviderName) { $ProviderName } else { Get-Pair $pairs @('provider') }
            host                   = $resolved.host
            rawHost                = $resolved.rawHost
            isLocal                = $resolved.isLocal
            instance               = $instance
            port                   = $port
            protocol               = $protocol
            filePath               = $filePath
            database               = $databaseValue
            authMode               = $authMode
            encrypt                = Get-Pair $pairs @('encrypt')
            trustServerCertificate = Get-Pair $pairs @('trustservercertificate')
            secretsPresent         = -not [string]::IsNullOrEmpty($passwordValue)
            parseStatus            = if ($serverValue) { 'ok' } else { 'unrecognized' }
            sha256                 = Get-CensusSha256Text $normalized
        }
    }

    function Add-CensusJsonUrlEdges {
        # appsettings.json puts downstream base URLs under arbitrary keys, so the whole
        # document is walked and every string leaf tested. Key path is retained
        # ('Services:Billing:BaseUrl') so an edge can be traced back to its setting.
        param($Node, [string]$Prefix, $Edges)
        if ($null -eq $Node) { return }
        if ($Node -is [string]) {
            $url = ConvertFrom-CensusUrlValue $Node
            if ($url) { $Edges.Add(@{ key = $Prefix; url = $url }) }
            return
        }
        if ($Node -is [System.Collections.IEnumerable]) {
            $index = 0
            foreach ($item in $Node) {
                Add-CensusJsonUrlEdges -Node $item -Prefix "$Prefix[$index]" -Edges $Edges
                $index++
            }
            return
        }
        if ($Node -is [System.Management.Automation.PSCustomObject]) {
            foreach ($property in $Node.PSObject.Properties) {
                $childPrefix = if ($Prefix) { "$Prefix`:$($property.Name)" } else { $property.Name }
                Add-CensusJsonUrlEdges -Node $property.Value -Prefix $childPrefix -Edges $Edges
            }
        }
    }

    function Get-CensusAuthenticationFromNode {
        param($AuthenticationNode, [string]$Source)
        $result = @{}
        if ($null -eq $AuthenticationNode) { return $result }
        foreach ($authType in @('anonymousAuthentication', 'windowsAuthentication', 'basicAuthentication', 'digestAuthentication')) {
            $node = $AuthenticationNode.SelectSingleNode($authType)
            if ($null -eq $node) { continue }
            $enabled = Get-CensusXmlAttribute $node 'enabled'
            if ($null -eq $enabled) { continue }
            $result[$authType] = @{
                enabled  = ($enabled -eq 'true')
                userName = Get-CensusXmlAttribute $node 'userName'
                source   = $Source
            }
        }
        $result
    }

    function Get-CensusIisLogStats {
        param([string]$Directory, [string]$SiteId, [int]$Cap)

        if ([string]::IsNullOrEmpty($Directory)) {
            return @{ enumerationStatus = 'skipped'; reason = 'no log directory configured' }
        }
        # A log directory on a UNC path is a genuine second hop from inside a WinRM session.
        if ($Directory.StartsWith('\\')) {
            return @{ enumerationStatus = 'unavailable'; reason = 'double-hop'; resolvedDirectory = $Directory }
        }

        $resolved = Join-Path $Directory ('W3SVC' + $SiteId)
        if (-not (Test-Path -LiteralPath $resolved)) {
            return @{ enumerationStatus = 'ok'; resolvedDirectory = $resolved; exists = $false }
        }

        try {
            $files = @(Get-ChildItem -LiteralPath $resolved -File -ErrorAction Stop | Select-Object -First ($Cap + 1))
        }
        catch {
            return @{ enumerationStatus = 'insufficient-rights'; resolvedDirectory = $resolved; exists = $true; reason = $_.Exception.Message }
        }

        # A silent cap would read as a shrinking log directory in the diff - the flag is what
        # stops that (spec section 6.6).
        $truncated = $files.Count -gt $Cap
        if ($truncated) { $files = $files[0..($Cap - 1)] }

        $stats = @{
            enumerationStatus = 'ok'
            resolvedDirectory = $resolved
            exists            = $true
            fileCount         = $files.Count
            truncated         = $truncated
            enumerationCap    = $Cap
            totalBytes        = 0
            oldestUtc         = $null
            newestUtc         = $null
            last24hBytes      = 0
        }
        if ($files.Count -eq 0) { return $stats }

        $sorted = @($files | Sort-Object LastWriteTimeUtc)
        $stats.totalBytes = [int64](($files | Measure-Object -Property Length -Sum).Sum)
        $stats.oldestUtc  = Format-CensusDate $sorted[0].LastWriteTimeUtc
        $stats.newestUtc  = Format-CensusDate $sorted[$sorted.Count - 1].LastWriteTimeUtc
        $cutoff = (Get-Date).ToUniversalTime().AddDays(-1)
        $recent = @($files | Where-Object { $_.LastWriteTimeUtc -gt $cutoff })
        if ($recent.Count -gt 0) { $stats.last24hBytes = [int64](($recent | Measure-Object -Property Length -Sum).Sum) }
        $stats
    }

    function Get-CensusIis {
        param([int]$LogEnumerationCap = 5000)

        # The precondition is a positive proof of absence - the registry key - never an
        # inference from an empty result.
        if (-not (Test-Path 'HKLM:\SOFTWARE\Microsoft\InetStp')) {
            return @{ status = 'not-present'; reason = 'HKLM:\SOFTWARE\Microsoft\InetStp absent' }
        }

        $inetStp    = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\InetStp' -ErrorAction SilentlyContinue
        $configPath = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'

        Get-CensusIisFromConfig -ConfigPath $configPath -InetStp $inetStp -LogEnumerationCap $LogEnumerationCap
    }

    function Get-CensusIisFromConfig {
        # Split from Get-CensusIis so the parsing can be exercised against a fixture tree on a
        # machine with no IIS installed - which is every dev box here.
        param(
            [string]$ConfigPath,
            $InetStp,
            [int]$LogEnumerationCap = 5000
        )

        $configFacts = Get-CensusFileFacts $configPath

        # Category-level failure is reserved for exactly this: applicationHost.config could
        # not be read. Everything below isolates per site and per application instead.
        if ($configFacts.status -ne 'ok') {
            return @{ status = 'failed'; reason = "applicationHost.config $($configFacts.status): $configPath" }
        }

        [xml]$config = Get-Content -LiteralPath $configPath -Raw

        $server = @{
            versionString      = $inetStp.VersionString
            majorVersion       = $inetStp.MajorVersion
            pathWwwRoot        = $inetStp.PathWWWRoot
            configPath         = $configFacts.path
            configLastWriteUtc = $configFacts.lastWriteUtc
            configSha256       = $configFacts.sha256
        }

        # --- app pools, merged with applicationPoolDefaults ---------------------------
        # An absent managedRuntimeVersion inherits the default; only an explicitly empty one
        # means No Managed Code. Reading the pool alone would report every non-overriding
        # pool as .NET Core.
        $poolDefaultsNode = $config.SelectSingleNode('/configuration/system.applicationHost/applicationPools/applicationPoolDefaults')
        $poolDefaultsProcessModel = $null
        if ($poolDefaultsNode) { $poolDefaultsProcessModel = $poolDefaultsNode.SelectSingleNode('processModel') }
        $defaultRuntime   = Get-CensusXmlAttribute $poolDefaultsNode 'managedRuntimeVersion'
        $defaultPipeline  = Get-CensusXmlAttribute $poolDefaultsNode 'managedPipelineMode'
        $defaultIdentity  = Get-CensusXmlAttribute $poolDefaultsProcessModel 'identityType'

        $appPools    = @()
        $poolsByName = @{}
        foreach ($poolNode in @($config.SelectNodes('/configuration/system.applicationHost/applicationPools/add'))) {
            $processModel = $poolNode.SelectSingleNode('processModel')

            $runtime       = Get-CensusXmlAttribute $poolNode 'managedRuntimeVersion'
            $runtimeSource = 'pool'
            if ($null -eq $runtime) {
                if ($null -ne $defaultRuntime) { $runtime = $defaultRuntime; $runtimeSource = 'applicationPoolDefaults' }
                else                           { $runtime = 'v4.0';          $runtimeSource = 'schemaDefault' }
            }

            $identity       = Get-CensusXmlAttribute $processModel 'identityType'
            $identitySource = 'pool'
            if ($null -eq $identity) {
                if ($null -ne $defaultIdentity) { $identity = $defaultIdentity;           $identitySource = 'applicationPoolDefaults' }
                else                            { $identity = 'ApplicationPoolIdentity';  $identitySource = 'schemaDefault' }
            }

            $pipeline = Get-CensusXmlAttribute $poolNode 'managedPipelineMode'
            if ($null -eq $pipeline) { $pipeline = $defaultPipeline }

            $pool = @{
                name                        = Get-CensusXmlAttribute $poolNode 'name'
                managedRuntimeVersion       = $runtime
                managedRuntimeVersionSource = $runtimeSource
                managedPipelineMode         = $pipeline
                identityType                = $identity
                identityTypeSource          = $identitySource
                userName                    = Get-CensusXmlAttribute $processModel 'userName'
            }
            $appPools += $pool
            if ($pool.name) { $poolsByName[$pool.name] = $pool }
        }

        # --- authentication sources -----------------------------------------------------
        # windowsAuthentication is a locked section by default, so IIS Manager writes it into
        # applicationHost.config under <location path="Site/App"> rather than into the
        # application's own web.config. Reading one source reports the wrong answer for half
        # the estate.
        $serverAuth = Get-CensusAuthenticationFromNode `
            $config.SelectSingleNode('/configuration/system.webServer/security/authentication') 'serverDefault'

        $locationAuth = @()
        foreach ($locationNode in @($config.SelectNodes('/configuration/location[@path]'))) {
            $locationPath = Get-CensusXmlAttribute $locationNode 'path'
            if ([string]::IsNullOrEmpty($locationPath) -or $locationPath -eq '.') { continue }
            $authNode = $locationNode.SelectSingleNode('system.webServer/security/authentication')
            if ($null -eq $authNode) { continue }
            $locationAuth += @{
                path = $locationPath
                auth = Get-CensusAuthenticationFromNode $authNode 'location'
            }
        }

        $centralLogNode = $config.SelectSingleNode('/configuration/system.applicationHost/log')
        $centralLogMode = Get-CensusXmlAttribute $centralLogNode 'centralLogFileMode'
        if ($null -eq $centralLogMode) { $centralLogMode = 'Site' }
        $siteDefaultsLog = $config.SelectSingleNode('/configuration/system.applicationHost/sites/siteDefaults/logFile')

        $sites        = @()
        $applications = @()
        $dependencies = New-Object System.Collections.Generic.List[object]

        foreach ($siteNode in @($config.SelectNodes('/configuration/system.applicationHost/sites/site'))) {
            $siteName = Get-CensusXmlAttribute $siteNode 'name'
            $siteId   = Get-CensusXmlAttribute $siteNode 'id'

            $bindings = @()
            foreach ($bindingNode in @($siteNode.SelectNodes('bindings/binding'))) {
                $protocol           = Get-CensusXmlAttribute $bindingNode 'protocol'
                $bindingInformation = Get-CensusXmlAttribute $bindingNode 'bindingInformation'
                $parsed             = ConvertFrom-CensusBindingInformation $protocol $bindingInformation
                $bindings += @{
                    protocol             = $protocol
                    bindingInformation   = $bindingInformation
                    ip                   = $parsed.ip
                    port                 = $parsed.port
                    hostHeader           = $parsed.hostHeader
                    parsed               = $parsed.parsed
                    sslFlags             = Get-CensusXmlAttribute $bindingNode 'sslFlags'
                    certificateHash      = Get-CensusXmlAttribute $bindingNode 'certificateHash'
                    certificateStoreName = Get-CensusXmlAttribute $bindingNode 'certificateStoreName'
                }
            }

            # A site's physical path is not an attribute of <site> - it lives on the root
            # application's root virtual directory.
            $siteRootPathNode = $siteNode.SelectSingleNode("application[@path='/']/virtualDirectory[@path='/']")
            $siteRootPath     = Expand-CensusConfigPath (Get-CensusXmlAttribute $siteRootPathNode 'physicalPath')

            $logNode = $siteNode.SelectSingleNode('logFile')
            $logDirectoryRaw = Get-CensusXmlAttribute $logNode 'directory'
            $logSource = 'site'
            if ($null -eq $logDirectoryRaw) {
                $logDirectoryRaw = Get-CensusXmlAttribute $siteDefaultsLog 'directory'
                $logSource = 'siteDefaults'
            }
            $logEnabled = Get-CensusXmlAttribute $logNode 'enabled'
            $logDirectory = Expand-CensusConfigPath $logDirectoryRaw

            # Central logging makes every per-site directory inert - reporting stats against
            # paths nothing writes to would be worse than reporting nothing.
            if ($centralLogMode -ne 'Site') {
                $logStats = @{ enumerationStatus = 'not-applicable'; reason = "centralLogFileMode=$centralLogMode" }
            }
            else {
                try   { $logStats = Get-CensusIisLogStats -Directory $logDirectory.expanded -SiteId $siteId -Cap $LogEnumerationCap }
                catch { $logStats = @{ enumerationStatus = 'failed'; reason = $_.Exception.Message } }
            }

            $sites += @{
                name             = $siteName
                id               = $siteId
                serverAutoStart  = Get-CensusXmlAttribute $siteNode 'serverAutoStart'
                physicalPath     = $siteRootPath
                bindings         = $bindings
                logFile          = @{
                    enabled            = $logEnabled
                    directory          = $logDirectory
                    directorySource    = $logSource
                    logFormat          = Get-CensusXmlAttribute $logNode 'logFormat'
                    period             = Get-CensusXmlAttribute $logNode 'period'
                    truncateSize       = Get-CensusXmlAttribute $logNode 'truncateSize'
                    logTargetW3C       = Get-CensusXmlAttribute $logNode 'logTargetW3C'
                    centralLogFileMode = $centralLogMode
                    stats              = $logStats
                }
            }

            # Every site has an implicit root application at '/'. It is emitted like any
            # other, or the commonest case in any estate - a site with no sub-applications -
            # produces no application rows at all.
            foreach ($appNode in @($siteNode.SelectNodes('application'))) {
                $appPath  = Get-CensusXmlAttribute $appNode 'path'
                $poolName = Get-CensusXmlAttribute $appNode 'applicationPool'
                $pool     = $null
                if ($poolName -and $poolsByName.ContainsKey($poolName)) { $pool = $poolsByName[$poolName] }

                $vdirs = @()
                foreach ($vdirNode in @($appNode.SelectNodes('virtualDirectory'))) {
                    $vdirs += @{
                        path         = Get-CensusXmlAttribute $vdirNode 'path'
                        physicalPath = Expand-CensusConfigPath (Get-CensusXmlAttribute $vdirNode 'physicalPath')
                        userName     = Get-CensusXmlAttribute $vdirNode 'userName'
                        logonMethod  = Get-CensusXmlAttribute $vdirNode 'logonMethod'
                    }
                }

                $rootVdirNode = $appNode.SelectSingleNode("virtualDirectory[@path='/']")
                $appPhysical  = Expand-CensusConfigPath (Get-CensusXmlAttribute $rootVdirNode 'physicalPath')

                $application = @{
                    siteName                  = $siteName
                    path                      = $appPath
                    physicalPath              = $appPhysical
                    applicationPool           = $poolName
                    poolManagedRuntimeVersion = if ($pool) { $pool.managedRuntimeVersion } else { $null }
                    poolManagedPipelineMode   = if ($pool) { $pool.managedPipelineMode }   else { $null }
                    poolIdentityType          = if ($pool) { $pool.identityType }          else { $null }
                    poolUserName              = if ($pool) { $pool.userName }              else { $null }
                    enabledProtocols          = Get-CensusXmlAttribute $appNode 'enabledProtocols'
                    virtualDirectories        = $vdirs
                    status                    = 'ok'
                }

                # Authentication merge, in IIS's own order: server defaults, then every
                # <location> whose path is a prefix of this application's config path (least
                # specific first, so the most specific wins), then the application's own
                # web.config below.
                $auth = @{}
                foreach ($key in $serverAuth.Keys) { $auth[$key] = $serverAuth[$key] }

                $appConfigPath = if ($appPath -eq '/') { $siteName } else { $siteName + $appPath }
                $matching = @($locationAuth | Where-Object {
                    $appConfigPath.Equals($_.path, [System.StringComparison]::OrdinalIgnoreCase) -or
                    $appConfigPath.StartsWith($_.path + '/', [System.StringComparison]::OrdinalIgnoreCase)
                } | Sort-Object { $_.path.Length })
                foreach ($match in $matching) {
                    foreach ($key in $match.auth.Keys) { $auth[$key] = $match.auth[$key] }
                }

                # --- per-application config files: everything below is isolated -----------
                # One malformed or ACL'd web.config must degrade its own row, not the whole
                # category.
                $runtime = @{
                    poolManagedRuntimeVersion = $application.poolManagedRuntimeVersion
                    aspNetCore                = $null
                    hasAppSettingsJson        = $false
                    hasRuntimeConfigJson      = $false
                }
                $configFiles = @{
                    webConfig       = @{ status = 'skipped' }
                    appSettingsJson = @{ status = 'skipped' }
                }

                try {
                    if ([string]::IsNullOrEmpty($appPhysical.expanded)) {
                        $application.status = 'failed'
                        $application.reason = 'application has no root virtualDirectory physicalPath'
                    }
                    elseif ($appPhysical.expanded.StartsWith('\\')) {
                        $application.status = 'unavailable'
                        $application.reason = 'double-hop'
                    }
                    else {
                        $webConfigPath = Join-Path $appPhysical.expanded 'web.config'
                        $configFiles.webConfig = Get-CensusFileFacts $webConfigPath

                        if ($configFiles.webConfig.status -eq 'ok') {
                            [xml]$webConfig = Get-Content -LiteralPath $webConfigPath -Raw

                            $webAuthNode = $webConfig.SelectSingleNode('/configuration/system.webServer/security/authentication')
                            $webAuth = Get-CensusAuthenticationFromNode $webAuthNode 'webConfig'
                            foreach ($key in $webAuth.Keys) { $auth[$key] = $webAuth[$key] }

                            $aspNetCoreNode = $webConfig.SelectSingleNode('/configuration/system.webServer/aspNetCore')
                            if ($aspNetCoreNode) {
                                $environmentVariables = @{}
                                foreach ($envNode in @($aspNetCoreNode.SelectNodes('environmentVariables/environmentVariable'))) {
                                    $envName = Get-CensusXmlAttribute $envNode 'name'
                                    if ($envName) { $environmentVariables[$envName] = Get-CensusXmlAttribute $envNode 'value' }
                                }
                                $runtime.aspNetCore = @{
                                    processPath          = Get-CensusXmlAttribute $aspNetCoreNode 'processPath'
                                    arguments            = Get-CensusXmlAttribute $aspNetCoreNode 'arguments'
                                    hostingModel         = Get-CensusXmlAttribute $aspNetCoreNode 'hostingModel'
                                    environmentVariables = $environmentVariables
                                }
                            }

                            foreach ($csNode in @($webConfig.SelectNodes('/configuration/connectionStrings/add'))) {
                                $csName  = Get-CensusXmlAttribute $csNode 'name'
                                $csValue = Get-CensusXmlAttribute $csNode 'connectionString'
                                if ([string]::IsNullOrEmpty($csValue)) { continue }
                                $edge = ConvertFrom-CensusConnectionString $csValue (Get-CensusXmlAttribute $csNode 'providerName')
                                $edge.siteName   = $siteName
                                $edge.appPath    = $appPath
                                $edge.sourceFile = 'web.config'
                                $edge.name       = $csName
                                $dependencies.Add($edge)
                            }

                            # appSettings values are captured only when they parse as an
                            # absolute http(s) URL - the deliberate carve-out from keys-only,
                            # because those values are the dependency map.
                            foreach ($settingNode in @($webConfig.SelectNodes('/configuration/appSettings/add'))) {
                                $url = ConvertFrom-CensusUrlValue (Get-CensusXmlAttribute $settingNode 'value')
                                if ($null -eq $url) { continue }
                                $url.kind       = 'http'
                                $url.siteName   = $siteName
                                $url.appPath    = $appPath
                                $url.sourceFile = 'web.config'
                                $url.name       = Get-CensusXmlAttribute $settingNode 'key'
                                $dependencies.Add($url)
                            }

                            foreach ($endpointNode in @($webConfig.SelectNodes('/configuration/system.serviceModel/client/endpoint'))) {
                                $url = ConvertFrom-CensusUrlValue (Get-CensusXmlAttribute $endpointNode 'address')
                                if ($null -eq $url) { continue }
                                $url.kind       = 'http'
                                $url.siteName   = $siteName
                                $url.appPath    = $appPath
                                $url.sourceFile = 'web.config'
                                $endpointName   = Get-CensusXmlAttribute $endpointNode 'name'
                                if ($endpointName) { $url.name = $endpointName }
                                else               { $url.name = Get-CensusXmlAttribute $endpointNode 'contract' }
                                $dependencies.Add($url)
                            }
                        }

                        $appSettingsPath = Join-Path $appPhysical.expanded 'appsettings.json'
                        $configFiles.appSettingsJson = Get-CensusFileFacts $appSettingsPath
                        $runtime.hasAppSettingsJson = ($configFiles.appSettingsJson.status -eq 'ok')

                        $runtimeConfig = @(Get-ChildItem -LiteralPath $appPhysical.expanded -Filter '*.runtimeconfig.json' -File -ErrorAction SilentlyContinue)
                        $runtime.hasRuntimeConfigJson = ($runtimeConfig.Count -gt 0)

                        if ($configFiles.appSettingsJson.status -eq 'ok') {
                            $appSettings = Get-Content -LiteralPath $appSettingsPath -Raw | ConvertFrom-Json

                            $connectionStringsNode = $appSettings.PSObject.Properties | Where-Object { $_.Name -eq 'ConnectionStrings' } | Select-Object -First 1
                            if ($connectionStringsNode -and $connectionStringsNode.Value) {
                                foreach ($property in $connectionStringsNode.Value.PSObject.Properties) {
                                    if ([string]::IsNullOrEmpty($property.Value)) { continue }
                                    $edge = ConvertFrom-CensusConnectionString $property.Value $null
                                    $edge.siteName   = $siteName
                                    $edge.appPath    = $appPath
                                    $edge.sourceFile = 'appsettings.json'
                                    $edge.name       = $property.Name
                                    $dependencies.Add($edge)
                                }
                            }

                            $jsonEdges = New-Object System.Collections.Generic.List[object]
                            Add-CensusJsonUrlEdges -Node $appSettings -Prefix '' -Edges $jsonEdges
                            foreach ($jsonEdge in $jsonEdges) {
                                $url = $jsonEdge.url
                                $url.kind       = 'http'
                                $url.siteName   = $siteName
                                $url.appPath    = $appPath
                                $url.sourceFile = 'appsettings.json'
                                $url.name       = $jsonEdge.key
                                $dependencies.Add($url)
                            }
                        }
                    }
                }
                catch {
                    $application.status = 'failed'
                    $application.reason = $_.Exception.Message
                }

                $application.runtime     = $runtime
                $application.auth        = $auth
                $application.configFiles = $configFiles
                $applications += $application
            }
        }

        @{
            server       = $server
            sites        = $sites
            appPools     = $appPools
            applications = $applications
            # .ToArray() rather than @(): on Windows PowerShell 5.1 the array subexpression
            # operator throws "Argument types do not match" against a List[object] built by
            # New-Object.
            dependencies = $dependencies.ToArray()
        }
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

    function Get-CensusAliases {
        # Every name this machine answers to, so a downstream consumer can match it against a
        # model whose node names were typed by people over years. Census emits the whole name
        # surface and never performs the match itself - see graph-interop.md section 4 (GI-4).
        #
        # Derived: it aggregates from the other collectors, so it runs as a post-pass and
        # records which of them contributed. An alias set assembled while IIS was failing is
        # smaller, and that must not read as aliases having been removed (section 6.6).
        param($IdentityResult, $IisResult, $CertificatesResult, $SqlServerResult)

        $aliases = New-Object System.Collections.Generic.List[object]
        $seen = New-Object System.Collections.Generic.HashSet[string]

        function Add-Alias {
            param([string]$Kind, $Value, [string]$Source)
            if ([string]::IsNullOrWhiteSpace($Value)) { return }
            $trimmed = ([string]$Value).Trim()
            if (-not $seen.Add(("$Kind|$trimmed").ToLowerInvariant())) { return }
            $aliases.Add([ordered]@{ kind = $Kind; value = $trimmed; source = $Source })
        }

        $sources = [ordered]@{}

        # --- identity -----------------------------------------------------------------
        $sources.identity = $IdentityResult.status
        Add-Alias 'netbios' $env:COMPUTERNAME 'identity'
        if ($IdentityResult.status -eq 'ok') {
            $domain = $IdentityResult.data.domain
            if ($domain -and $domain -notmatch '^(WORKGROUP)$') {
                Add-Alias 'fqdn' "$env:COMPUTERNAME.$domain" 'identity'
            }
            Add-Alias 'machineGuid' $IdentityResult.data.machineGuid 'identity'
            Add-Alias 'smbiosUuid'  $IdentityResult.data.smbiosUuid  'identity'
            Add-Alias 'biosSerial'  $IdentityResult.data.biosSerialNumber 'identity'
        }

        # --- sql server ---------------------------------------------------------------
        $sources.sqlserver = $SqlServerResult.status
        if ($SqlServerResult.status -eq 'ok') {
            foreach ($instance in @($SqlServerResult.data.instances)) {
                if (-not $instance.instanceName) { continue }
                $value = if ($instance.instanceName -eq 'MSSQLSERVER') { $env:COMPUTERNAME }
                         else { "$env:COMPUTERNAME\$($instance.instanceName)" }
                Add-Alias 'sqlInstance' $value 'sqlserver'
            }
        }

        # --- iis ----------------------------------------------------------------------
        $sources.iis = $IisResult.status
        if ($IisResult.status -eq 'ok') {
            foreach ($site in @($IisResult.data.sites)) {
                foreach ($binding in @($site.bindings)) {
                    Add-Alias 'bindingHostHeader' $binding.hostHeader 'iis'
                }
            }
        }

        # --- certificates -------------------------------------------------------------
        $sources.certificates = $CertificatesResult.status
        if ($CertificatesResult.status -eq 'ok') {
            foreach ($certificate in @($CertificatesResult.data.certificates)) {
                foreach ($san in @($certificate.sanDnsNames)) {
                    Add-Alias 'certSan' $san 'certificates'
                }
            }
        }

        # --- addresses ----------------------------------------------------------------
        # There is no `network` collector yet; the addresses are read directly here so the
        # kind is not simply missing. When that collector lands this moves to it.
        try {
            $addresses = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' -ErrorAction Stop |
                ForEach-Object { $_.IPAddress } |
                Where-Object { $_ -and $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -ne '127.0.0.1' })
            foreach ($address in $addresses) { Add-Alias 'ipv4' $address 'network' }
            $sources.network = 'ok'
        }
        catch {
            $sources.network = 'failed'
        }

        @{ aliases = $aliases.ToArray(); sources = $sources }
    }

    # --- SQL Server helpers ----------------------------------------------------------------
    # This is the only place the collector opens an outbound connection; everything else reads
    # the local registry or local files. See census-collector.md 8.8.1.

    function Invoke-CensusSqlQuery {
        # Raw System.Data.SqlClient, no SqlServer module. Returns rows as an array of
        # hashtables. Every caller wraps this - a query that throws degrades its own section,
        # never the instance.
        param(
            [string]$ServerInstance,
            [string]$Query,
            [int]$ConnectTimeoutSeconds = 5,
            [int]$CommandTimeoutSeconds = 30
        )

        $connectionString = "Server=$ServerInstance;Integrated Security=SSPI;Application Name=census;Connect Timeout=$ConnectTimeoutSeconds"
        $connection = New-Object System.Data.SqlClient.SqlConnection $connectionString
        $rows = New-Object System.Collections.Generic.List[object]
        try {
            $connection.Open()
            $command = $connection.CreateCommand()
            $command.CommandText = $Query
            $command.CommandTimeout = $CommandTimeoutSeconds
            $reader = $command.ExecuteReader()
            try {
                while ($reader.Read()) {
                    $row = @{}
                    for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                        $value = $reader.GetValue($i)
                        if ($value -is [System.DBNull]) { $value = $null }
                        $row[$reader.GetName($i)] = $value
                    }
                    $rows.Add($row)
                }
            }
            finally { $reader.Close() }
        }
        finally { $connection.Dispose() }
        return $rows.ToArray()
    }

    function Get-CensusSqlInstanceDetail {
        # Databases and their files for one instance. Returns a hashtable carrying its own
        # status, so a single unreachable instance never fails the category.
        param([string]$ServerInstance)

        # The permission stamp. Without VIEW ANY DEFINITION, sys.databases silently returns
        # only what the login can see and sys.master_files returns almost nothing - a short
        # list that looks complete, which is the worst failure this collector could have.
        $contextQuery = @'
SELECT
    SUSER_NAME()                                         AS loginName,
    IS_SRVROLEMEMBER('sysadmin')                         AS isSysadmin,
    HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW ANY DEFINITION') AS viewAnyDefinition,
    HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE')   AS viewServerState,
    SERVERPROPERTY('ProductVersion')                     AS productVersion,
    SERVERPROPERTY('Edition')                            AS edition,
    SERVERPROPERTY('Collation')                          AS serverCollation
'@

        try {
            $context = @(Invoke-CensusSqlQuery -ServerInstance $ServerInstance -Query $contextQuery)[0]
        }
        catch {
            return @{ status = 'failed'; reason = $_.Exception.Message }
        }

        $permissions = @{
            loginName         = $context.loginName
            isSysadmin        = [bool]$context.isSysadmin
            viewAnyDefinition = [bool]$context.viewAnyDefinition
            viewServerState   = [bool]$context.viewServerState
        }
        $serverProperties = @{
            productVersion  = $context.productVersion
            edition         = $context.edition
            serverCollation = $context.serverCollation
        }

        # A filtered list is never presented as a whole one.
        if (-not $permissions.viewAnyDefinition) {
            return @{
                status           = 'insufficient-rights'
                reason           = "VIEW ANY DEFINITION denied for $($context.loginName); database and file lists would be silently partial"
                permissions      = $permissions
                serverProperties = $serverProperties
            }
        }

        $databaseQuery = @'
SELECT name, database_id, state_desc, recovery_model_desc, compatibility_level,
       collation_name, is_read_only, is_encrypted, SUSER_SNAME(owner_sid) AS owner_name,
       create_date
FROM sys.databases
ORDER BY name
'@
        # Instance-wide, so no per-database context switch and no per-database try/catch: one
        # inaccessible or offline database cannot kill the collector. sys.master_files lists
        # the files of offline and restoring databases too.
        $fileQuery = @'
SELECT DB_NAME(database_id) AS database_name, database_id, file_id, type_desc, name,
       physical_name, size, max_size, growth, is_percent_growth
FROM sys.master_files
ORDER BY database_id, file_id
'@

        $databases = @()
        foreach ($row in @(Invoke-CensusSqlQuery -ServerInstance $ServerInstance -Query $databaseQuery)) {
            $databases += @{
                name                = $row.name
                databaseId          = $row.database_id
                stateDesc           = $row.state_desc
                recoveryModelDesc   = $row.recovery_model_desc
                compatibilityLevel  = $row.compatibility_level
                collationName       = $row.collation_name
                isReadOnly          = [bool]$row.is_read_only
                isEncrypted         = [bool]$row.is_encrypted
                owner               = $row.owner_name
                createDate          = Format-CensusDate $row.create_date
            }
        }

        $files = @()
        foreach ($row in @(Invoke-CensusSqlQuery -ServerInstance $ServerInstance -Query $fileQuery)) {
            $physicalName = $row.physical_name
            $files += @{
                databaseName    = $row.database_name
                fileId          = $row.file_id
                typeDesc        = $row.type_desc
                logicalName     = $row.name
                physicalName    = $physicalName
                directory       = if ($physicalName) { Split-Path -Parent $physicalName } else { $null }
                # sizes are in 8 KB pages
                sizePages       = $row.size
                sizeBytes       = if ($null -ne $row.size) { [int64]$row.size * 8192 } else { $null }
                maxSizePages    = $row.max_size
                growth          = $row.growth
                isPercentGrowth = [bool]$row.is_percent_growth
                isUnc           = [bool]($physicalName -and $physicalName.StartsWith('\\'))
            }
        }

        @{
            status           = 'ok'
            permissions      = $permissions
            serverProperties = $serverProperties
            databases        = $databases
            databaseFiles    = $files
        }
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

            # Only a running instance is connected to. A stopped one is skipped outright, so
            # it can never contribute a connect timeout to the run.
            $serverInstance = if ($instanceName -eq 'MSSQLSERVER') { '.' } else { ".\$instanceName" }
            if ($service.State -eq 'Running') {
                try   { $detail = Get-CensusSqlInstanceDetail -ServerInstance $serverInstance }
                catch { $detail = @{ status = 'failed'; reason = $_.Exception.Message } }
            }
            else {
                $detail = @{ status = 'skipped'; reason = "service $serviceName is $($service.State)" }
            }

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
                connectedStatus     = $detail.status
                connectedReason     = $detail.reason
                permissions         = $detail.permissions
                serverProperties    = $detail.serverProperties
                databases           = $detail.databases
                databaseFiles       = $detail.databaseFiles
            }
        }

        @{ instances = $instances }
    }

    # Ordered deliberately: `aliases` is derived from the four below it and must run last
    # (spec section 8.1.1). Everything else is independent.
    $identityResult     = Invoke-CensusCategory { Get-CensusIdentity }
    $iisResult          = Invoke-CensusCategory { Get-CensusIis }
    $certificatesResult = Invoke-CensusCategory { Get-CensusCertificates -IisResult $iisResult }
    $sqlServerResult    = Invoke-CensusCategory { Get-CensusSqlServer }
    $aliasesResult      = Invoke-CensusCategory {
        Get-CensusAliases -IdentityResult $identityResult -IisResult $iisResult `
                          -CertificatesResult $certificatesResult -SqlServerResult $sqlServerResult
    }

    $census = [ordered]@{
        schemaVersion = 1
        computerName  = $env:COMPUTERNAME
        collectedUtc  = (Get-Date).ToUniversalTime().ToString('o')
        identity      = $identityResult
        memory        = Invoke-CensusCategory { Get-CensusMemory }
        os            = Invoke-CensusCategory { Get-CensusOs }
        updates       = Invoke-CensusCategory { Get-CensusUpdates }
        dotnet        = Invoke-CensusCategory { Get-CensusDotNet }
        drives        = Invoke-CensusCategory { Get-CensusDrives }
        apps          = Invoke-CensusCategory { Get-CensusApps }
        iis           = $iisResult
        certificates  = $certificatesResult
        sqlserver     = $sqlServerResult
        aliases       = $aliasesResult
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
