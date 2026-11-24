#!/usr/bin/env bash
# ==============================================================================
# VPS PROVISIONING SCRIPT — أكاديمية التميز
# ==============================================================================
# Target OS: Ubuntu 22.04 / 24.04 LTS (Hetzner Cloud or Hostinger VPS)
# Idempotent: safe to run multiple times without destructive effects.
# Usage:
#   sudo bash provision-vps.sh <DEPLOY_PUBKEY>
# ==============================================================================

set -euo pipefail

DEPLOY_PUBKEY="${1:-}"
APP_DIR="/opt/teacher-app"

echo "=== [1/8] Updating package lists & upgrading base system ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    ufw \
    fail2ban \
    chrony \
    unattended-upgrades \
    wget \
    jq \
    rclone \
    git

echo "=== [2/8] Configuring Chrony NTP & Timezone ==="
timedatectl set-timezone UTC
systemctl enable --now chrony

echo "=== [3/8] Setting up Swap File (2GB) ==="
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "vm.swappiness=10" > /etc/sysctl.d/99-swap.conf
    echo "vm.vfs_cache_pressure=50" >> /etc/sysctl.d/99-swap.conf
    sysctl --system
    echo "Swap created and enabled."
else
    echo "Swapfile already exists. Skipping."
fi

echo "=== [4/8] Installing Docker CE & Docker Compose Plugin ==="
if ! command -v docker &> /dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Enable Docker daemon with log rotation
    mkdir -p /etc/docker
    cat <<EOF > /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  },
  "live-restore": true
}
EOF
    systemctl restart docker
    systemctl enable docker
    echo "Docker installed successfully."
else
    echo "Docker already installed. Skipping."
fi

echo "=== [5/8] Creating 'deploy' user and securing SSH ==="
if ! id "deploy" &>/dev/null; then
    useradd -m -s /bin/bash -G docker,sudo deploy
    echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/99-deploy
    chmod 440 /etc/sudoers.d/99-deploy
    echo "Created user 'deploy' with sudo and docker group access."
fi

mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh

if [ -n "$DEPLOY_PUBKEY" ]; then
    echo "$DEPLOY_PUBKEY" > /home/deploy/.ssh/authorized_keys
    chmod 600 /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh
    echo "Deploy public key installed."
fi

# SSH hardening: Disable root login completely now that deploy user is configured
cat <<EOF > /etc/ssh/sshd_config.d/99-hardening.conf
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 4
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
systemctl restart ssh || systemctl restart sshd

echo "=== [6/8] Configuring Fail2ban for SSH ==="
cat <<EOF > /etc/fail2ban/jail.local
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
EOF
systemctl enable --now fail2ban

echo "=== [7/8] Configuring UFW Firewall ==="
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Allow SSH
ufw allow 22/tcp comment 'SSH'

# Allow HTTP and HTTPS strictly from Cloudflare IP ranges
echo "Fetching official Cloudflare IP ranges..."
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
    ufw allow proto tcp from "$ip" to any port 80,443 comment 'Cloudflare IPv4'
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
    ufw allow proto tcp from "$ip" to any port 80,443 comment 'Cloudflare IPv6'
done

ufw --force enable
echo "UFW Firewall enabled with Cloudflare IP filtering."

echo "=== [8/8] Creating Application Directory Structure ==="
mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/deploy"
mkdir -p "$APP_DIR/deploy/nginx"
mkdir -p "$APP_DIR/deploy/nginx/ssl"
mkdir -p "$APP_DIR/deploy/postgres"
mkdir -p "$APP_DIR/deploy/redis"
mkdir -p "$APP_DIR/deploy/scripts"

chown -R deploy:deploy "$APP_DIR"
chmod 755 "$APP_DIR"
chmod 700 "$APP_DIR/deploy/nginx/ssl"

echo "=== VPS Provisioning Complete! ==="
echo "Application directory: $APP_DIR"
echo "Deploy user created: deploy"
