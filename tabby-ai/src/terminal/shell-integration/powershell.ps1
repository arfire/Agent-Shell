if (Test-Path Function:\global:__ash_uninstall) { __ash_uninstall }
$global:__ash_saved_prompt = $function:prompt
$global:__ash_prompt = {
    $ashOK = $?
    $ashCode = if ($ashOK) { 0 } else { 1 }
    [Console]::Write("$([char]27)]777;ash;__NONCE__;D;$ashCode$([char]7)$([char]27)]777;ash;__NONCE__;A$([char]7)")
    $ashText = & $global:__ash_saved_prompt
    return "$ashText$([char]27)]777;ash;__NONCE__;B$([char]7)"
}
Set-Item Function:\global:prompt $global:__ash_prompt
function global:__ash_uninstall {
    if ($function:prompt -eq $global:__ash_prompt) { Set-Item Function:\global:prompt $global:__ash_saved_prompt }
    Remove-Variable __ash_saved_prompt, __ash_prompt -Scope Global -ErrorAction SilentlyContinue
    Remove-Item Function:\global:__ash_uninstall
    [Console]::Write("$([char]27)]777;ash;__NONCE__;U$([char]7)")
}
[Console]::Write("$([char]27)]777;ash;__NONCE__;READY;powershell$([char]7)")
