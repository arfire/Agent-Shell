if (Test-Path Function:\global:__ash_uninstall) { __ash_uninstall }
$global:__ash_saved_prompt = $function:prompt
$global:__ash_history_id = (Get-History -Count 1).Id
$global:__ash_prompt = {
    $ashOK = $?
    $ashCode = if ($ashOK) { 0 } else { 1 }
    $ashHistory = Get-History -Count 1
    if ($ashHistory -and $ashHistory.Id -ne $global:__ash_history_id) {
        $global:__ash_history_id = $ashHistory.Id
        $ashCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ashHistory.CommandLine))
        [Console]::Write("$([char]27)]777;ash;__NONCE__;CMD;$ashCommand$([char]7)")
    }
    if ($PWD.Provider.Name -eq 'FileSystem') {
        $ashDirectory = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
        [Console]::Write("$([char]27)]777;ash;__NONCE__;PWD;$ashDirectory$([char]7)")
    }
    [Console]::Write("$([char]27)]777;ash;__NONCE__;D;$ashCode$([char]7)$([char]27)]777;ash;__NONCE__;A$([char]7)")
    $ashText = & $global:__ash_saved_prompt
    return "$ashText$([char]27)]777;ash;__NONCE__;B$([char]7)"
}
Set-Item Function:\global:prompt $global:__ash_prompt
function global:__ash_uninstall {
    if ($function:prompt -eq $global:__ash_prompt) { Set-Item Function:\global:prompt $global:__ash_saved_prompt }
    Remove-Variable __ash_saved_prompt, __ash_prompt, __ash_history_id -Scope Global -ErrorAction SilentlyContinue
    Remove-Item Function:\global:__ash_uninstall
    [Console]::Write("$([char]27)]777;ash;__NONCE__;U$([char]7)")
}
[Console]::Write("$([char]27)]777;ash;__NONCE__;READY;powershell$([char]7)")
