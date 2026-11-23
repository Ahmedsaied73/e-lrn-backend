# Runbook: Onboarding a New Teacher Tenant

This runbook outlines the exact procedure to commission a new teacher VPS from scratch.

---

## 1. Domain & Cloudflare Setup (Ahmed)

1. **Purchase / Connect Domain:** Purchase the domain for the teacher or point the teacher's domain to Ahmed's Cloudflare account.
2. **DNS Records in Cloudflare:**
   - Type: `A`, Name: `api`, Content: `<VPS_PUBLIC_IPV4>`, Proxy status: **Proxied (Orange Cloud)**.
   - Type: `AAAA`, Name: `api`, Content: `<VPS_PUBLIC_IPV6>` (if available), Proxy status: **Proxied**.
3. **SSL/TLS Settings in Cloudflare:**
   - Encryption Mode: **Full (strict)**.
   - Edge Certificates: Enable **Always Use HTTPS**, **Minimum TLS Version 1.2**, **Opportunistic Encryption**.
4. **Origin CA Certificate:**
   - In Cloudflare Dashboard -> **SSL/TLS** -> **Origin Server** -> **Create Certificate**.
   - Keep defaults (RSA 2048, validity 15 years, hostnames: `*.teacherdomain.com`, `teacherdomain.com`).
   - Copy the Certificate text to `origin.pem`.
   - Copy the Private Key text to `origin.key`.

---

## 2. Order & Provision VPS (Hetzner Cloud)

1. **Create Server:**
   - Location: Germany (**Falkenstein** or **Nuremberg**).
   - Image: **Ubuntu 24.04 LTS**.
   - Type: **CPX31** (4 vCPU AMD, 8GB RAM) for 3k–4k preset; **CPX41** (8 vCPU, 16GB RAM) for 6k.
   - SSH Key: Add Ahmed's SSH public key.
2. **Run Host Provisioning:**
   ```bash
   ssh root@<VPS_IP> 'bash -s' < deploy/scripts/provision-vps.sh '<DEPLOY_SSH_PUBKEY>'
   ```
   This will:
   - Install Docker CE & Compose plugin with JSON log rotation.
   - Configure UFW firewall (port 22 open, ports 80/443 restricted to Cloudflare IPs only).
   - Configure Fail2ban, chrony NTP, 2GB swap file.
   - Create the `deploy` user and `/opt/teacher-app` directory.

---

## 3. Configure the Tenant

1. **Copy Deployment Files to VPS:**
   ```bash
   rsync -avz --exclude '.env' --exclude 'node_modules' ./ deploy@<VPS_IP>:/opt/teacher-app/
   ```
2. **Install Cloudflare Origin CA Certificates:**
   ```bash
   ssh root@<VPS_IP> "mkdir -p /etc/ssl/cloudflare && chmod 700 /etc/ssl/cloudflare"
   scp origin.pem root@<VPS_IP>:/etc/ssl/cloudflare/origin.pem
   scp origin.key root@<VPS_IP>:/etc/ssl/cloudflare/origin.key
   ssh root@<VPS_IP> "chmod 644 /etc/ssl/cloudflare/origin.pem && chmod 600 /etc/ssl/cloudflare/origin.key"
   ```
3. **Run Tenant Initializer:**
   ```bash
   ssh deploy@<VPS_IP>
   cd /opt/teacher-app
   bash deploy/scripts/add-tenant.sh <teacher-slug> api.<teacherdomain.com> 3000
   ```
4. **Edit `.env` Secrets:**
   ```bash
   nano /opt/teacher-app/.env
   ```
   Fill in:
   - `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_STREAM_WEBHOOK_KEY`
   - `GEMINI_API_KEY`
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - Ensure permissions are strictly `600`: `chmod 600 /opt/teacher-app/.env`

---

## 4. Initial Stack Boot & Verification

1. **Start Services:**
   ```bash
   docker compose up -d
   ```
2. **Verify Container Health:**
   ```bash
   docker compose ps
   ```
   All containers (`api`, `worker`, `postgres`, `redis`, `nginx`, `backup`) should report `healthy` or `running`.
3. **Verify Public Endpoint:**
   ```bash
   curl -I https://api.<teacherdomain.com>/healthz
   # Expected: HTTP/2 200 with {"status":"ok"}
   ```
4. **Add to Fleet Deployment List:**
   Add `<VPS_IP>` to the GitHub secret `TEACHER_HOSTS` so subsequent automated GitHub Actions rollouts include this tenant.
