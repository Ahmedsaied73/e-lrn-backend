#!/usr/bin/env bash
# ==============================================================================
# NGINX CONFIGURATION SYNTAX VALIDATOR — أكاديمية التميز
# ==============================================================================
# Validates that Nginx templates and configurations compile cleanly with nginx -t.
# Usage:
#   bash deploy/tests/test-nginx-config.sh
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR="/tmp/nginx-syntax-test"

echo "=== Testing Nginx Site Configuration Syntax ==="

rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/conf.d" "$TEST_DIR/ssl" "$TEST_DIR/logs"

# Generate a temporary self-signed certificate for the syntax test
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TEST_DIR/ssl/origin.key" \
  -out "$TEST_DIR/ssl/origin.pem" \
  -days 1 -subj '/CN=api.test.local' 2>/dev/null

export DOMAIN_NAME=api.test.local
# shellcheck disable=SC2016
envsubst '${DOMAIN_NAME}' < "$PROJECT_ROOT/deploy/nginx/site.conf.template" > "$TEST_DIR/conf.d/site.conf"
sed -i "s|/etc/ssl/cloudflare|$TEST_DIR/ssl|g" "$TEST_DIR/conf.d/site.conf"

cp "$PROJECT_ROOT/deploy/nginx/upstream.conf" "$TEST_DIR/conf.d/upstream.conf"
# For syntax check outside docker network, use 127.0.0.1 for upstream to avoid DNS lookup failure
sed -i "s/server api:3005/server 127.0.0.1:3005/g" "$TEST_DIR/conf.d/upstream.conf"
cp "$PROJECT_ROOT/deploy/nginx/cloudflare-ips.conf" "$TEST_DIR/conf.d/cloudflare-ips.conf"

cat << NGINX_CONF > "$TEST_DIR/nginx.conf"
user $(whoami);
pid $TEST_DIR/nginx.pid;
error_log $TEST_DIR/logs/error.log warn;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    log_format json_combined escape=json '{"status":\$status}';
    access_log $TEST_DIR/logs/access.log json_combined;

    include $TEST_DIR/conf.d/cloudflare-ips.conf;

    limit_req_zone \$binary_remote_addr zone=api_general:10m rate=30r/s;
    limit_req_zone \$binary_remote_addr zone=auth_limit:10m rate=5r/s;

    map \$http_upgrade \$connection_upgrade {
        default upgrade;
        '' close;
    }

    include $TEST_DIR/conf.d/upstream.conf;
    include $TEST_DIR/conf.d/site.conf;
}
NGINX_CONF

# Temporarily ensure 'api' hostname resolves if running outside docker network
if ! grep -q "127.0.0.1 api" /etc/hosts 2>/dev/null; then
  echo "Note: Upstream 'api' will be tested via nginx config check."
fi

nginx -t -c "$TEST_DIR/nginx.conf"
echo "=== Nginx Configuration Syntax: PASSED ==="
