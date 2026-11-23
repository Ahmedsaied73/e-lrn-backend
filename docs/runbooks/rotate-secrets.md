# Runbook: Secret Rotation Manual

This manual provides the step-by-step procedure to rotate all credentials securely.

---

## 1. Rotating JWT & Refresh Token Secrets (`JWTSECRET`, `REFRESH_TOKEN_SECRET`)

> [!WARNING]
> Rotating `JWTSECRET` invalidates all currently active 15-minute access tokens. Rotating `REFRESH_TOKEN_SECRET` invalidates all 7-day refresh tokens, requiring all logged-in students and admins to re-authenticate once.

1. Generate new 64-character hexadecimal secrets:
   ```bash
   NEW_JWT=$(openssl rand -hex 32)
   NEW_REFRESH=$(openssl rand -hex 32)
   ```
2. Update `.env` on the VPS:
   ```bash
   ssh deploy@<VPS_IP>
   nano /opt/teacher-app/.env
   # Update JWTSECRET and REFRESH_TOKEN_SECRET
   ```
3. Restart API container to reload configuration:
   ```bash
   docker compose restart api
   ```

---

## 2. Rotating PostgreSQL Password (`POSTGRES_PASSWORD`)

1. Generate new database password:
   ```bash
   NEW_PG_PASS=$(openssl rand -hex 24)
   ```
2. Update PostgreSQL internal role:
   ```bash
   docker compose exec postgres psql -U postgres -c "ALTER USER app_user WITH PASSWORD '${NEW_PG_PASS}';"
   ```
3. Update `POSTGRES_PASSWORD` and `DATABASE_URL` in `/opt/teacher-app/.env`.
4. Restart dependent containers:
   ```bash
   docker compose up -d --no-deps api worker backup postgres-exporter
   ```

---

## 3. Rotating Redis Password (`REDIS_PASSWORD`)

1. Generate new Redis password:
   ```bash
   NEW_REDIS_PASS=$(openssl rand -hex 24)
   ```
2. Update `.env` on the VPS with new `REDIS_PASSWORD`.
3. Recreate the Redis container with the new command line password:
   ```bash
   docker compose up -d --no-deps --force-recreate redis
   ```
4. Restart API, Worker, and Redis-exporter:
   ```bash
   docker compose up -d --no-deps api worker redis-exporter
   ```

---

## 4. Rotating Cloudflare Origin CA Certificates

1. In Cloudflare Dashboard -> **SSL/TLS** -> **Origin Server** -> Generate a new Origin Certificate.
2. Save certificate and key locally.
3. Upload to VPS replacing `/etc/ssl/cloudflare/origin.pem` and `origin.key`.
4. Reload Nginx without downtime:
   ```bash
   docker compose exec nginx nginx -s reload
   ```
5. Revoke the old certificate in the Cloudflare dashboard.

---

## 5. Rotating Deploy SSH Keys

1. Generate a new SSH keypair:
   ```bash
   ssh-keygen -t ed25519 -C "deploy-$(date +%Y%m%d)" -f id_ed25519_deploy
   ```
2. Append the new public key to `/home/deploy/.ssh/authorized_keys` on all VPS instances.
3. Update GitHub Actions secrets `CANARY_SSH_KEY` and `FLEET_SSH_KEY`.
4. Test a dry-run deploy via GitHub Actions.
5. Remove the old public key from `/home/deploy/.ssh/authorized_keys`.
