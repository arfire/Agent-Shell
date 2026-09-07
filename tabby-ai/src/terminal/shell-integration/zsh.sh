[[ -o interactive ]] || return 1
(( $+functions[__ash_uninstall] )) && __ash_uninstall
__ash_saved_prompt=$PROMPT
__ash_capture_status () { __ash_status=$?; return "$__ash_status"; }
__ash_precmd () {
    local ash_status=$__ash_status
    printf '\033]777;ash;__NONCE__;PWD;%s\007' "$(printf '%s' "$PWD" | base64 | tr -d '\r\n')"
    printf '\033]777;ash;__NONCE__;D;%s\007' "$ash_status"
    if [[ $PROMPT != *'777;ash;__NONCE__;'* ]]; then
        __ash_saved_prompt=$PROMPT
        PROMPT=$'%{\e]777;ash;__NONCE__;A\a%}'"$PROMPT"$'%{\e]777;ash;__NONCE__;B\a%}'
    fi
    return "$ash_status"
}
__ash_preexec () {
    printf '\033]777;ash;__NONCE__;CMD;%s\007' "$(printf '%s' "$1" | base64 | tr -d '\r\n')"
    printf '\033]777;ash;__NONCE__;C\007'
}
__ash_uninstall () {
    precmd_functions=(${${precmd_functions:#__ash_precmd}:#__ash_capture_status})
    preexec_functions=(${preexec_functions:#__ash_preexec})
    [[ $PROMPT == *'777;ash;__NONCE__;'* ]] && PROMPT=$__ash_saved_prompt
    unset __ash_saved_prompt __ash_status
    unfunction __ash_precmd __ash_capture_status __ash_preexec __ash_uninstall
    printf '\033]777;ash;__NONCE__;U\007'
}
precmd_functions=(__ash_capture_status $precmd_functions __ash_precmd)
preexec_functions+=(__ash_preexec)
printf '\033]777;ash;__NONCE__;READY;zsh\007'
