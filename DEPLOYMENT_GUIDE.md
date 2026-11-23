# Complete VPS Deployment Guide — أكاديمية التميز (Hostinger + Cloudflare)

> **Goal:** Deploy the backend to a dedicated Hostinger VPS for a teacher, fully containerized, secure behind Cloudflare, with automated backups to Cloudflare R2 and instant error alerts to Telegram.

---

## Table of Contents
1. [Phase 1: External Services & Account Setup (Getting `.env` Keys)](#phase-1-external-services-setup)
   - [1.1 Hostinger VPS Provisioning](#11-hostinger-vps-provisioning)
   - [1.2 Cloudflare DNS & Origin CA SSL Setup](#12-cloudflare-dns--origin-ca-ssl-setup)
   - [1.3 Cloudflare R2 Bucket (for Backups)](#13-cloudflare-r2-bucket-for-backups)
   - [1.4 Telegram Bot Setup (for Alerts)](#14-telegram-bot-setup-for-alerts)
   - [1.5 Bunny.net Stream Setup (Video Hosting & 5 Keys)](#15-bunnynet-stream-setup)
   - [1.6 Google Gemini API Setup (AI Essay Grader)](#16-google-gemini-api-setup)
   - [1.7 Supabase Storage Setup (Quiz & Course Thumbnails)](#17-supabase-storage-setup)
   - [1.8 Auto-Generated Passwords & Secrets (No Account Needed)](#18-auto-generated-passwords--secrets)
2. [Phase 2: VPS Server Commissioning (First-Time Server Setup)](#phase-2-vps-server-commissioning)
   - [2.1 Run the Provisioning Script](#21-run-the-provisioning-script)
   - [2.2 Install Cloudflare Origin CA Certificates](#22-install-cloudflare-origin-ca-certificates)
   - [2.3 Copy Project Files to the VPS](#23-copy-project-files-to-the-vps)
3. [Phase 3: Tenant Configuration & Stack Launch](#phase-3-tenant-configuration--stack-launch)
   - [3.1 Run the Tenant Initializer Wizard](#31-run-the-tenant-initializer-wizard)
   - [3.2 Configure `.env` Secrets](#32-configure-env-secrets)
   - [3.3 Configure `rclone` for Cloudflare R2 Backups](#33-configure-rclone-for-cloudflare-r2-backups)
   - [3.4 Start the Application Stack](#34-start-the-application-stack)
4. [Phase 4: Post-Deployment Verification Checklist](#phase-4-post-deployment-verification-checklist)
5. [Phase 5: Deploying Future Updates (CI/CD & CLI)](#phase-5-deploying-future-updates)
   - [5.1 GitHub Actions (Zero-Downtime Auto-Deploy)](#51-github-actions-zero-downtime-auto-deploy)
   - [5.2 Manual CLI Deploy](#52-manual-cli-deploy)
   - [5.3 Emergency 1-Command Rollback](#53-emergency-1-command-rollback)
6. [Phase 6: Backups & Disaster Recovery](#phase-6-backups--disaster-recovery)
7. [Phase 7: Central Monitoring Server Setup (Optional €3.79/mo Node)](#phase-7-central-monitoring-server-setup)

---

## Phase 1: External Services Setup

### 1.1 Hostinger VPS Provisioning
1. Log into your **Hostinger hPanel** -> **VPS**.
2. Order or create a new VPS:
   - **Plan:** KVM 4 (4 vCPU AMD, 8 GB RAM, 100 GB NVMe) or KVM 2.
   - **Location:** **France** or **Germany** (nearest to Egypt with 55–70ms latency).
   - **Operating System:** **Ubuntu 24.04 64-bit** (or Ubuntu 22.04 LTS).
   - **Root Password:** Set a strong temporary password.
   - **SSH Key:** (Optional) Add your local SSH public key.
3. Once created, note the **VPS Public IPv4 Address** (e.g. `185.123.45.67`).

---

### 1.2 Cloudflare DNS & Origin CA SSL Setup
Ahmed manages the domain in his Cloudflare account. The teacher never touches DNS.

#### A. Add DNS Record
1. In the Cloudflare Dashboard, select the teacher's domain (e.g. `teacherdomain.com`).
2. Go to **DNS** -> **Records** -> **Add Record**:
   - **Type:** `A`
   - **Name:** `api`
   - **IPv4 Address:** `<YOUR_HOSTINGER_VPS_IP>`
   - **Proxy status:** **Proxied (Orange Cloud)** (Crucial for CDN, DDoS, WAF, and Cairo edge caching).
   - Click **Save**.

#### B. Set SSL/TLS to Full (Strict)
1. Go to **SSL/TLS** -> **Overview**.
2. Select encryption mode: **Full (strict)**.
3. Go to **Edge Certificates**:
   - Enable **Always Use HTTPS**: `ON`.
   - Minimum TLS Version: `TLS 1.2`.

#### C. Generate Cloudflare Origin CA Certificate
1. Go to **SSL/TLS** -> **Origin Server** -> click **Create Certificate**.
2. Keep the default settings:
   - Key type: `RSA (2048)`
   - Hostnames: `*.teacherdomain.com`, `teacherdomain.com`
   - Certificate validity: `15 years`
3. Click **Create**.
4. You will see two text boxes:
   - **Origin Certificate:** Copy the entire block (including `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----`) and save it locally on your computer as **`origin.pem`**.
   - **Private Key:** Copy the entire block (including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`) and save it locally on your computer as **`origin.key`**.
5. Click **OK**.

---

### 1.3 Cloudflare R2 Bucket (for Backups)
1. In Cloudflare Dashboard, click **R2** in the left sidebar.
2. Click **Create bucket**:
   - **Bucket name:** `teacher-backups`
   - **Location:** Automatic (or Western Europe).
3. Click **Manage R2 API Tokens** -> **Create API token**:
   - **Permissions:** Admin Read & Write.
   - Note down:
     - **Access Key ID**
     - **Secret Access Key**
     - **Endpoint URL** (e.g. `https://<account-id>.r2.cloudflarestorage.com`)

---

### 1.4 Telegram Bot (for Alerts)
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`, choose a name and username (e.g. `AkademiaAlertsBot`).
3. Save the **Bot Token** (e.g. `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Start a chat with your new bot (or add it to your private alerts group).
5. Find your Chat ID:
   - Message `@userinfobot` or forward a message to `@getidsbot` to get your numeric **Chat ID** (e.g. `123456789` or `-1001234567890`).

---

### 1.5 Bunny.net Stream Setup (Video Hosting & 5 Keys)
Create an account on **[bunny.net](https://bunny.net)**:
1. Click **Stream** in the left sidebar -> **Add Video Library**:
   - Name: `teacher1-videos` (or teacher's name).
   - Storage region: **Falkenstein (Germany)** or **London**.
2. Click your newly created library:
   - **`BUNNY_STREAM_LIBRARY_ID`**: Displayed at the top right under the library name (numeric, e.g. `245812`).
3. In the left sub-menu, click **API & Security**:
   - **`BUNNY_STREAM_API_KEY`**: Click the eye icon next to **API Key** and copy it.
   - Scroll down to **Security** -> Enable **URL Token Authentication** (or Token Authentication). Copy the key into: **`BUNNY_STREAM_TOKEN_KEY`**.
4. In the left sub-menu, click **Delivery & CDN**:
   - **`BUNNY_STREAM_HOSTNAME`**: Copy the Pull Zone hostname (e.g. `vz-b819f2a0-8e1.b-cdn.net`).
5. In the left sub-menu, click **Webhooks**:
   - Click **Add Webhook** -> Set URL to `https://api.teacherdomain.com/webhooks/bunny/stream`.
   - Copy the secret key into: **`BUNNY_STREAM_WEBHOOK_KEY`**.

---

### 1.6 Google Gemini API Setup (AI Essay Grader)
1. Go to **[aistudio.google.com](https://aistudio.google.com/)** and sign in with any Google account.
2. Click the **Get API key** button in the left sidebar.
3. Click **Create API key** -> select or create a project -> click **Create API key in existing project**.
4. Copy the generated key (starts with `AIzaSy...`).
   - Paste into: **`GEMINI_API_KEY`**.
   *(The free tier provides generous daily quota for student essay evaluations).*

---

### 1.7 Supabase Storage Setup (Quiz & Course Thumbnails)
*(For hosting course cards, teacher photos, and quiz question diagrams)*:
1. Go to **[supabase.com](https://supabase.com)** and create a project (Free tier).
2. Go to **Project Settings** -> **API**:
   - **`SUPABASE_URL`**: Copy the Project URL (`https://xxxxxxxxxxxx.supabase.co`).
   - **`SUPABASE_SERVICE_KEY`**: Under "Project API keys", reveal `service_role` (secret) and copy it.
3. Go to **Storage** (left sidebar) -> click **New bucket**:
   - Name: `quiz-images`
   - Set **Public bucket**: **ON**.
   - Click **Save**.

---

### 1.8 Auto-Generated Passwords & Secrets (No Account Needed)
When you run `add-tenant.sh` in Phase 3, the script **automatically generates** secure random 64-character keys:
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `JWTSECRET`
- `REFRESH_TOKEN_SECRET`
- `BACKUP_ENCRYPTION_PASSPHRASE` (used by GPG to encrypt daily backups)
- `METRICS_TOKEN` (used by central Prometheus)
- `ADMIN_EMAIL` & `ADMIN_PASSWORD`: You choose these yourself for the teacher (e.g. `admin@teacherdomain.com` / `TeacherPassword2026!`). The server creates this admin account automatically on first boot.

---

## Phase 2: VPS Server Commissioning

Run these commands from your local computer terminal (PowerShell, macOS, or Linux).

### 2.1 Run the Provisioning Script
This single command updates Ubuntu, installs Docker CE + Compose, configures the UFW firewall (locking ports 80/443 strictly to Cloudflare IPs), enables Fail2ban, sets up a 2GB swap file, and creates the unprivileged `deploy` user.

```bash
# Replace with your Hostinger VPS IP and your personal SSH public key:
ssh root@<HOSTINGER_VPS_IP> 'bash -s' < deploy/scripts/provision-vps.sh "$(cat ~/.ssh/id_rsa.pub)"
```

---

### 2.2 Install Cloudflare Origin CA Certificates
Transfer the `origin.pem` and `origin.key` files you saved in Step 1.2 to the VPS:

```bash
# Create directory on VPS:
ssh root@<HOSTINGER_VPS_IP> "mkdir -p /etc/ssl/cloudflare && chmod 700 /etc/ssl/cloudflare"

# Copy certificates:
scp origin.pem root@<HOSTINGER_VPS_IP>:/etc/ssl/cloudflare/origin.pem
scp origin.key root@<HOSTINGER_VPS_IP>:/etc/ssl/cloudflare/origin.key

# Set strict permissions:
ssh root@<HOSTINGER_VPS_IP> "chmod 644 /etc/ssl/cloudflare/origin.pem && chmod 600 /etc/ssl/cloudflare/origin.key"
```

---

### 2.3 Copy Project Files to the VPS
Copy the deployment template into `/opt/teacher-app`:

```bash
rsync -avz --exclude '.env' --exclude 'node_modules' --exclude '.git' ./ deploy@<HOSTINGER_VPS_IP>:/opt/teacher-app/
```

---

## Phase 3: Tenant Configuration & Stack Launch

SSH into your VPS as the `deploy` user:

```bash
ssh deploy@<HOSTINGER_VPS_IP>
cd /opt/teacher-app
```

### 3.1 Run the Tenant Initializer Wizard
Run `add-tenant.sh` with your tenant slug, domain, and sizing preset (3000, 4000, 6000, 8000, or 10000):

```bash
# Syntax: bash deploy/scripts/add-tenant.sh <SLUG> <API_DOMAIN> <PRESET>
bash deploy/scripts/add-tenant.sh teacher1 api.teacherdomain.com 3000
```

**What this automatically does:**
- Generates `deploy/nginx/site.conf` customized for `api.teacherdomain.com`.
- Tunes PostgreSQL `postgresql.conf` using the `3000.env` preset (shared buffers, work mem, max connections).
- Creates `/opt/teacher-app/.env` with cryptographically secure random passwords for PostgreSQL, Redis, JWT secrets, and backup encryption.
- Sets file permissions to `chmod 600 .env`.

---

### 3.2 Configure `.env` Secrets
Open `/opt/teacher-app/.env` in `nano`:

```bash
nano /opt/teacher-app/.env
```

Review and fill in the missing service keys:
```ini
# ── Domain & Frontend ──
DOMAIN_NAME=api.teacherdomain.com
FRONTEND_URL=https://teacherdomain.com,https://*.vercel.app

# ── Admin Account (Auto-seeded on first boot) ──
ADMIN_EMAIL=admin@teacherdomain.com
ADMIN_PASSWORD=SetAStrongPasswordHere2026!
ADMIN_NAME="الأستاذ / اسم المعلم"
ADMIN_PHONE="01012345678"

# ── Bunny.net Stream (Video) ──
BUNNY_STREAM_API_KEY=your-bunny-stream-full-api-key
BUNNY_STREAM_LIBRARY_ID=123456
BUNNY_STREAM_TOKEN_KEY=your-bunny-token-authentication-key
BUNNY_STREAM_HOSTNAME=vz-xxxxxx.b-cdn.net
BUNNY_STREAM_WEBHOOK_KEY=your-bunny-webhook-signing-key

# ── AI Essay Grader ──
GEMINI_API_KEY=AIzaSy...your-gemini-api-key
AI_GRADER_ENABLED=true

# ── Backups & Telegram Alerts ──
BACKUP_STORAGE_DEST=r2:teacher-backups/teacher1
TELEGRAM_BOT_TOKEN=7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=123456789
```
Save and exit: `Ctrl + O`, `Enter`, `Ctrl + X`.

---

### 3.3 Configure `rclone` for Cloudflare R2 Backups
The automated backup container uses `rclone` to sync encrypted database dumps to Cloudflare R2.

On the VPS, create the `rclone` config file:
```bash
sudo mkdir -p /root/.config/rclone
sudo nano /root/.rclone.conf
```

Paste this configuration (fill in your R2 credentials from Step 1.3):
```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <YOUR_R2_ACCESS_KEY_ID>
secret_access_key = <YOUR_R2_SECRET_ACCESS_KEY>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
```
Save and secure it: `sudo chmod 600 /root/.rclone.conf`.

---

### 3.4 Start the Application Stack
Launch all containers in detached mode:

```bash
cd /opt/teacher-app
docker compose up -d
```

Check container status:
```bash
docker compose ps
```
**Expected output:**
```
NAME                           IMAGE                         STATUS
teacher-app-api-1              e-learning-platform           Up (healthy)
teacher-app-worker-1           e-learning-platform           Up
teacher-app-postgres-1         postgres:16-alpine            Up (healthy)
teacher-app-redis-1            redis:7-alpine                Up (healthy)
teacher-app-nginx-1            nginx:1.25-alpine             Up (healthy)
teacher-app-backup-1           alpine:3.19                   Up
teacher-app-node-exporter-1    prom/node-exporter:v1.7.0     Up
teacher-app-cadvisor-1         gcr.io/cadvisor/cadvisor      Up
teacher-app-postgres-exporter  postgres-exporter             Up
teacher-app-redis-exporter-1   redis_exporter                Up
teacher-app-promtail-1         grafana/promtail:2.9.4        Up
```

---

## Phase 4: Post-Deployment Verification Checklist

Run these quick checks to ensure everything is operating smoothly:

### 1. Test Public Liveness (`/healthz`)
```bash
curl -i https://api.teacherdomain.com/healthz
# Expected: HTTP/2 200 OK
# {"status":"ok","uptime":...}
```

### 2. Test Database Readiness (`/readyz`)
```bash
curl -i https://api.teacherdomain.com/readyz
# Expected: HTTP/2 200 OK
# {"status":"ok","db":"up","uptime":...,"ms":...}
```

### 3. Verify Admin Account Created
Inspect the API logs:
```bash
docker compose logs api | grep "admin"
# Expected: [INFO] Default admin initialized or already exists.
```

### 4. Test Backup Drill
Trigger an on-demand encrypted backup to Cloudflare R2:
```bash
bash deploy/scripts/backup.sh
```
Check Telegram: You should immediately receive a message:
> 💾 **BACKUP SUCCESS:** Database dump for `teacher1` uploaded to storage.

Verify the restore drill in a test container:
```bash
bash deploy/scripts/restore-test.sh
```
Check Telegram: You should receive:
> 🛡️ **BACKUP DRILL PASSED:** `teacher1` backup verified. Restored X users in Ys.

---

## Phase 5: Deploying Future Updates

### 5.1 GitHub Actions (Zero-Downtime Auto-Deploy)
Whenever you push code changes to the `main` branch:
1. GitHub Actions automatically builds the container image and tags it with the Git commit SHA.
2. It SSHes to your Canary instance, deploys, and verifies `/readyz`.
3. If Canary passes, it rolls out to your teacher VPS hosts sequentially.
4. Each VPS runs `deploy.sh`:
   - Takes an automated pre-deploy database snapshot.
   - Runs `npx prisma migrate deploy`.
   - Starts a standby container to verify `/readyz` passes.
   - Gracefully reloads Nginx upstream with zero dropped connections.
   - Dispatches a Telegram notification.

---

### 5.2 Manual CLI Deploy (On VPS)
To deploy a new image tag manually from the VPS terminal:
```bash
ssh deploy@<HOSTINGER_VPS_IP>
cd /opt/teacher-app
bash deploy/scripts/deploy.sh --tag <GIT_COMMIT_SHA>
```

---

### 5.3 Emergency 1-Command Rollback
If an update has a critical bug or unexpected behavior:
```bash
ssh deploy@<HOSTINGER_VPS_IP>
cd /opt/teacher-app

# Instantly rolls back to the previous image tag:
bash deploy/scripts/rollback.sh
```

---

## Phase 6: Backups & Disaster Recovery

### Schedule
Backups run automatically inside the `backup` container every night at **03:00 AM UTC**:
- Compressed with `gzip -9`.
- Encrypted with AES-256 GPG using `BACKUP_ENCRYPTION_PASSPHRASE`.
- Synced to Cloudflare R2 bucket: `r2:teacher-backups/<teacher-slug>/daily/`.
- Automatic retention: 7 daily copies, 4 weekly copies, 3 monthly copies.

### Full Disaster Recovery (Restoring onto a Fresh Server)
If the VPS hardware fails completely:
1. Provision a new VPS following Phase 2.
2. Start PostgreSQL:
   ```bash
   docker compose up -d postgres
   ```
3. Restore the latest backup from Cloudflare R2:
   ```bash
   bash deploy/scripts/restore.sh latest
   ```
4. Start the full application stack:
   ```bash
   docker compose up -d
   ```
5. Update Cloudflare DNS `api` record to the new VPS IP. **Total Recovery Time (RTO): < 10 minutes.**

---

## Phase 7: Central Monitoring Server Setup (Option 1: Loki + Telegram)

To monitor all your teacher instances in one place, provision a small **€3.79/month VPS** (e.g. Hetzner CX22 or Hostinger KVM 1):

1. On the monitoring VPS, copy `deploy/monitoring/docker-compose.monitoring.yml`.
2. Start the monitoring suite:
   ```bash
   docker compose -f docker-compose.monitoring.yml up -d
   ```
3. Open Grafana: `http://<MONITORING_VPS_IP>:3000` (User: `admin`, Password: set in `.env`).
4. **How Alerts Work:**
   - Promtail on each teacher VPS ships logs to this server.
   - Loki Ruler scans for `[ERROR]`, `[FATAL]`, or HTTP 5xx.
   - Alertmanager immediately fires a formatted card to your Telegram Bot.
   - You can search, filter, and trace logs live inside Grafana without logging into the teacher's server.

---

## Summary of Useful Commands

| Task | Command |
|---|---|
| View live API logs | `docker compose logs -f api` |
| View live Worker logs | `docker compose logs -f worker` |
| Check container health | `docker compose ps` |
| Restart API cleanly | `docker compose restart api` |
| Reload Nginx (zero downtime) | `docker compose exec nginx nginx -s reload` |
| Manual backup | `bash deploy/scripts/backup.sh` |
| Verify backup drill | `bash deploy/scripts/restore-test.sh` |
| Emergency rollback | `bash deploy/scripts/rollback.sh` |
| Update Cloudflare IPs | `bash deploy/scripts/update-cloudflare-ips.sh` |
