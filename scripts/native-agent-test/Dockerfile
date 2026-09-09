ARG BASE_IMAGE=alpine:3.22
FROM ${BASE_IMAGE}
RUN apk add --no-cache openssh bash zsh fish vim less procps python3 \
    && ssh-keygen -A \
    && mkdir -p /run/sshd \
    && adduser -D -s /bin/bash ashbash \
    && adduser -D -s /bin/zsh ashzsh \
    && adduser -D -s /usr/bin/fish ashfish
COPY start.sh /start.sh
RUN sed -i 's/\r$//' /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
