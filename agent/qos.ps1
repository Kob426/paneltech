# Fixed local implementation. The server supplies typed data, never script text.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$j = $inputData.job
$manifestPath = $inputData.manifestPath
$snapshotPath = $inputData.snapshotPath
$manifest = @()
$previous = @()
$changed = $false
function Save-Json($path, $value) {
    $tmp = "$path.tmp"
    ConvertTo-Json -InputObject @($value) -Depth 12 | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $path -Force
}
function Is-Owned($policy) {
    return @($manifest | Where-Object { $_.name -ceq $policy.Name -and $_.exe -ieq $policy.AppPathName }).Count -eq 1
}
function Read-Rules {
    $all = @(Get-NetQosPolicy -PolicyStore ActiveStore -ErrorAction Stop)
    foreach ($p in $all) {
        $m = @($manifest | Where-Object { $_.name -ceq $p.Name -and $_.exe -ieq $p.AppPathName })
        $ds = 0
        if ($null -ne $p.DSCPValue) { $ds = [int]$p.DSCPValue }
        if ($ds -lt 0 -or $ds -gt 63) { $ds = 0 }
        [PSCustomObject]@{name=[string]$p.Name;gameId=$(if ($m.Count -eq 1) {$m[0].gameId} else {'foreign'});exe=$(if ($p.AppPathName) {[string]$p.AppPathName} else {'*'});dscp=$ds;owned=($m.Count -eq 1)}
    }
}
function Finish($state, $code, $message, $rules, $rollback = $null) {
    $r = @{bootId=$j.bootId;state=$state;code=$code;message=$message;rules=@($rules);rollback=$rollback;dryRun=$false}
    [Console]::WriteLine((ConvertTo-Json -InputObject $r -Depth 15 -Compress))
    exit 0
}
function Fingerprint($rules) {
    return (@($rules | Sort-Object name | ForEach-Object {"$($_.name)|$($_.exe.ToLowerInvariant())|$($_.dscp)"}) -join "`n")
}
try {
    if ($j.operation -notin @('inspect_rules','apply_marking','remove_marking','health')) { throw 'invalid_operation' }
    foreach ($cmd in @('Get-NetQosPolicy','New-NetQosPolicy','Remove-NetQosPolicy')) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Finish 'failed' 'missing_cmdlet' "NetQos недоступен: $cmd" @() }
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Finish 'failed' 'permissions' 'Нужны повышенные права локального администратора.' @() }
    if (Test-Path -LiteralPath $manifestPath) { $manifest = @(Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) }
    $all = @(Read-Rules)
    if ($j.operation -in @('inspect_rules','health')) { Finish 'succeeded' 'inspected' 'Фактические правила ActiveStore прочитаны.' $all }
    if ($j.gameId -notmatch '^[a-zA-Z0-9-]{1,80}$') { throw 'invalid_game' }
    if (@($j.exes).Count -eq 0 -or @($j.exes).Count -gt 30) { throw 'invalid_exe' }
    foreach ($exe in $j.exes) { if ($exe -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.exe$') { throw 'invalid_exe' } }
    if (@($j.exes | ForEach-Object {$_.ToLowerInvariant()} | Select-Object -Unique).Count -ne @($j.exes).Count) {throw 'invalid_exe'}
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$j.expires) { Finish 'failed' 'expired' 'Срок команды истёк.' $all }
    if ($j.operation -eq 'apply_marking') {
        if ($null -eq $j.variant -or [int]$j.variant -lt 0 -or [int]$j.variant -gt 63 -or [int]$j.variant -notin $j.allowedVariants) { Finish 'failed' 'variant' 'Вариант не разрешён.' $all }
        foreach ($r in $all) {
            foreach ($exe in $j.exes) {
                $leaf = [IO.Path]::GetFileName($r.exe)
                $matches = ($r.exe -eq '*' -or $leaf -ieq $exe -or $exe -like $leaf)
                if ($matches -and (-not $r.owned -or ($r.gameId -ne $j.gameId -and $r.dscp -ne [int]$j.variant))) { Finish 'failed' 'conflict' "Конфликт с политикой $($r.name). Автоматическая миграция запрещена." $all }
            }
            # Exact expected name collisions are also conflicts, even when the exe differs.
            foreach ($exe in $j.exes) {
                $name = "PanelTech-$($j.gameId)-$($exe.ToLowerInvariant())"
                if ($r.name -ieq $name -and -not $r.owned) { Finish 'failed' 'conflict' 'Имя правила занято сторонней политикой.' $all }
            }
        }
    }
    $previous = @($all | Where-Object {$_.owned -and $_.gameId -eq $j.gameId})
    Save-Json $snapshotPath $previous
    # Extend manifest only after proving no name collision. Never own rules by prefix alone.
    foreach ($exe in $j.exes) {
        $name = "PanelTech-$($j.gameId)-$($exe.ToLowerInvariant())"
        if ($j.operation -eq 'apply_marking' -and -not @($manifest | Where-Object {$_.name -ceq $name}).Count) {
            $manifest += [PSCustomObject]@{name=$name;gameId=$j.gameId;exe=$exe}
        }
    }
    Save-Json $manifestPath $manifest
    $changed = $true
    foreach ($r in $previous) { Remove-NetQosPolicy -Name $r.name -PolicyStore ActiveStore -Confirm:$false -ErrorAction Stop }
    if ($j.operation -eq 'apply_marking') {
        foreach ($exe in $j.exes) {
            $name = "PanelTech-$($j.gameId)-$($exe.ToLowerInvariant())"
            New-NetQosPolicy -Name $name -AppPathNameMatchCondition $exe -DSCPAction ([sbyte]$j.variant) -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
        }
    }
    $after = @(Read-Rules)
    $own = @($after | Where-Object {$_.owned -and $_.gameId -eq $j.gameId})
    if ($j.operation -eq 'remove_marking' -and $own.Count -ne 0) {throw 'verification_failed'}
    if ($j.operation -eq 'apply_marking') {
        if ($own.Count -ne @($j.exes).Count) {throw 'verification_failed'}
        foreach ($exe in $j.exes) {if (@($own | Where-Object {$_.exe -ieq $exe -and $_.dscp -eq [int]$j.variant -and $_.name -ceq "PanelTech-$($j.gameId)-$($exe.ToLowerInvariant())"}).Count -ne 1) {throw 'verification_failed'}}
    }
    $otherBefore = @($all | Where-Object {-not ($_.owned -and $_.gameId -eq $j.gameId)})
    $otherAfter = @($after | Where-Object {-not ($_.owned -and $_.gameId -eq $j.gameId)})
    if ((Fingerprint $otherBefore) -cne (Fingerprint $otherAfter)) {throw 'unrelated_rules_changed'}
    Finish 'succeeded' 'verified' $(if ($j.operation -eq 'apply_marking') {'Правила применены. При необходимости перезапустите игру.'} else {'Собственные правила выбранной игры удалены.'}) $after
} catch {
    $code = if ($changed) {'partial_failure'} else {'preflight'}
    $rollback = 'not_needed'
    if ($changed) {
        try {
            $current = @(Read-Rules | Where-Object {$_.owned -and $_.gameId -eq $j.gameId})
            foreach ($r in $current) {Remove-NetQosPolicy -Name $r.name -PolicyStore ActiveStore -Confirm:$false -ErrorAction Stop}
            foreach ($r in $previous) {New-NetQosPolicy -Name $r.name -AppPathNameMatchCondition $r.exe -DSCPAction ([sbyte]$r.dscp) -PolicyStore ActiveStore -ErrorAction Stop | Out-Null}
            $restored = @(Read-Rules | Where-Object {$_.owned -and $_.gameId -eq $j.gameId})
            if ((Fingerprint $previous) -cne (Fingerprint $restored)) {throw 'rollback_verification_failed'}
            $rollback = 'succeeded: предыдущий собственный набор проверен; остаточных собственных изменений нет'
        } catch { $rollback = 'failed: возможны остаточные изменения; нужна ручная инспекция. Другие политики не восстанавливались.' }
    }
    try {$actual = @(Read-Rules)} catch {Finish 'unknown' 'inspection_failed' 'Ошибка чтения фактического состояния; успех не подтверждён.' @() $rollback}
    Finish 'failed' $code 'Операция не подтверждена. Проверьте права, cmdlet и фактические правила. Подробности доступны в локальной диагностике Windows.' $actual $rollback
}
