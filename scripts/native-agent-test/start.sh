#!/bin/sh
set -eu
: "${ASH_TEST_PASSWORD:?A disposable test password is required}"
for user in ashbash ashzsh ashfish; do
    printf '%s:%s\n' "$user" "$ASH_TEST_PASSWORD" | chpasswd
done
unset ASH_TEST_PASSWORD
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=no
