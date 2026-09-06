FROM alpine:3.22
RUN apk add --no-cache openssh bash zsh fish vim less procps python3 \
    && ssh-keygen -A \
    && mkdir -p /run/sshd \
    && adduser -D -s /bin/bash ashbash \
    && adduser -D -s /bin/zsh ashzsh \
    && adduser -D -s /usr/bin/fish ashfish
COPY start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
