# Loaded into the current interactive shell; no files or exported secrets.
if [[ $- != *i* || ${BASH_VERSINFO[0]} -lt 5 || ( ${BASH_VERSINFO[0]} -eq 5 && ${BASH_VERSINFO[1]} -lt 1 ) ]]; then return 1; fi
if declare -F __ash_uninstall >/dev/null; then __ash_uninstall; fi
__ash_saved_ps1=$PS1
__ash_saved_ps0=${PS0-}
__ash_preexec () {
    local ash_command
    ash_command=$(HISTTIMEFORMAT= builtin history 1 | sed '1s/^ *[0-9]* *//')
    printf '\033]777;ash;__NONCE__;CMD;%s\007' "$(printf '%s' "$ash_command" | base64 | tr -d '\r\n')"
}
__ash_ps0='$(__ash_preexec)'$'\e]777;ash;__NONCE__;C\a'${PS0-}
PS0=$__ash_ps0
__ash_capture_status () { __ash_status=$?; return "$__ash_status"; }
__ash_prompt () {
    printf '\033]777;ash;__NONCE__;PWD;%s\007' "$(printf '%s' "$PWD" | base64 | tr -d '\r\n')"
    printf '\033]777;ash;__NONCE__;D;%s\007' "$__ash_status"
    if [[ $PS1 != *'777;ash;__NONCE__;'* ]]; then
        __ash_saved_ps1=$PS1
        PS1=$'\\[\e]777;ash;__NONCE__;A\a\\]'"$PS1"$'\\[\e]777;ash;__NONCE__;B\a\\]'
    fi
    return "$__ash_status"
}
__ash_uninstall () {
    local item
    local -a kept=()
    for item in "${PROMPT_COMMAND[@]}"; do
        [[ $item == __ash_capture_status || $item == __ash_prompt ]] || kept+=("$item")
    done
    PROMPT_COMMAND=("${kept[@]}")
    [[ $PS1 == *'777;ash;__NONCE__;'* ]] && PS1=$__ash_saved_ps1
    [[ ${PS0-} == "$__ash_ps0" ]] && PS0=$__ash_saved_ps0
    unset __ash_saved_ps1 __ash_saved_ps0 __ash_ps0 __ash_status
    unset -f __ash_prompt __ash_capture_status __ash_preexec __ash_uninstall
    printf '\033]777;ash;__NONCE__;U\007'
}
PROMPT_COMMAND=(__ash_capture_status "${PROMPT_COMMAND[@]}" __ash_prompt)
printf '\033]777;ash;__NONCE__;READY;bash\007'
