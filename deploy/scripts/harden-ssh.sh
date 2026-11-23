#!/usr/bin/env bash
# ==============================================================================
# SSH HARDENING SCRIPT
# ==============================================================================
set -euo pipefail

DEPLOY_PUBKEY="${1:-}"

if [ -z "$DEPLOY_PUBKEY" ]; then
    echo "Usage: sudo bash harden-ssh.sh '<SSH_PUBLIC_KEY>'"
    exit 1
fi

mkdir -p /home/deploy/.ssh
echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
sort -u /home/deploy/.ssh/authorized_keys -o /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

cat <<EOF > /etc/ssh/sshd_config.d/99-deploy-only.conf
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
EOF

systemctl restart ssh || systemctl restart sshd
echo "SSH hardened. Root login disabled. Deploy user key installed."
