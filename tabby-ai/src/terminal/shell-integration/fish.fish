status is-interactive; or return 1
functions -q __ash_uninstall; and __ash_uninstall
functions -c fish_prompt __ash_saved_prompt
function __ash_return_status
    return $argv[1]
end
function fish_prompt
    set -l ash_status $status
    printf '\e]777;ash;__NONCE__;D;%s\a\e]777;ash;__NONCE__;A\a' $ash_status
    __ash_return_status $ash_status
    __ash_saved_prompt
    printf '\e]777;ash;__NONCE__;B\a'
end
function __ash_preexec --on-event fish_preexec
    printf '\e]777;ash;__NONCE__;C\a'
end
function __ash_uninstall
    if string match -q '*777;ash;__NONCE__;*' (functions fish_prompt | string collect)
        functions -e fish_prompt
        functions -c __ash_saved_prompt fish_prompt
    end
    functions -e __ash_saved_prompt __ash_return_status __ash_preexec __ash_uninstall
    printf '\e]777;ash;__NONCE__;U\a'
end
printf '\e]777;ash;__NONCE__;READY;fish\a'
