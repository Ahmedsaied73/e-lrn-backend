#!/usr/bin/env bash
# ==============================================================================
# SYNC CLOUDFLARE IP RANGES FOR NGINX
# ==============================================================================
set -euo pipefail

TARGET_CONF="${1:-/opt/teacher-app/deploy/nginx/cloudflare-ips.conf}"
TMP_CONF="/tmp/cloudflare-ips.conf"

echo "# Cloudflare IPv4 ranges" > "$TMP_CONF"
for ip in $(curl -sSL https://www.cloudflare.com/ips-v4); do
  echo "set_real_ip_from $ip;" >> "$TMP_CONF"
done

echo "" >> "$TMP_CONF"
echo "# Cloudflare IPv6 ranges" >> "$TMP_CONF"
for ip in $(curl -sSL https://www.cloudflare.com/ips-v6); do
  echo "set_real_ip_from $ip;" >> "$TMP_CONF"
done

{
  echo ""
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive on;"
} >> "$TMP_CONF"

mv "$TMP_CONF" "$TARGET_CONF"
echo "Cloudflare IPs updated in $TARGET_CONF"

# Reload Nginx if running in Docker
if docker compose ps -q nginx &>/dev/null; then
  docker compose exec -T nginx nginx -s reload || true
  echo "Nginx reloaded."
fi
