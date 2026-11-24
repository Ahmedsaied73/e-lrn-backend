# Complete VPS Deployment Guide — أكاديمية التميز (Hostinger + Cloudflare)

> **Goal:** Deploy the backend to a dedicated Hostinger VPS for a teacher, fully containerized, secure behind Cloudflare, with automated backups to Cloudflare R2 and instant error alerts to Telegram.

---

## Table of Contents
1. [Phase 1: External Services & Account Setup (Getting `.env` Keys)](#phase-1-external-services-setup)
   - [1.1 Hostinger VPS Provisioning](#11-hostinger-vps-provisioning)
   - [1.2 Cloudflare DNS & Origin CA SSL Setup](#12-cloudflare-dns--origin-ca-ssl-setup)
   - [1.3 Cloudflare R2 Bucket (for Backups)](#13-cloudflare-r2-bucket-for-backups)
   - [1.4 Healthchecks.io (Missed-Backup Alerts)](#14-healthchecksio-missed-backup-alerts)
   - [1.5 Telegram Bot Setup (for Alerts)](#15-telegram-bot-setup-for-alerts)
   - [1.6 Bunny.net Stream Setup (Video Hosting & 5 Keys)](#16-bunnynet-stream-setup)
   - [1.7 Google Gemini API Setup (AI Essay Grader)](#17-google-gemini-api-setup)
   - [1.8 Supabase Storage Setup (Quiz & Course Thumbnails)](#18-supabase-storage-setup)
   - [1.9 Auto-Generated Passwords & Secrets (No Account Needed)](#19-auto-generated-passwords--secrets)
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
   - **Token Name:** `backup-teacher1-token` (best practice: one token per teacher).
   - **Permissions:** **Object Read & Write** (do **NOT** select Admin Read & Write).
   - **Specify bucket(s):** Apply strictly to `teacher-backups`.
   - Note down:
     - **Access Key ID**
     - **Secret Access Key**
     - **Endpoint URL** (e.g. `https://<account-id>.r2.cloudflarestorage.com`)

---

### 1.4 Healthchecks.io (Missed-Backup Alerts)
To ensure you are alerted if a scheduled daily backup fails to run (e.g. VPS power loss or crond stopped):
1. Create a free account on **[healthchecks.io](https://healthchecks.io)**.
2. Click **Add Check**:
   - **Name:** `backup-teacher1`
   - **Schedule:** Period `24 hours`, Grace time `2 hours`.
3. Set up notification integrations (Telegram / Email).
4. Copy your unique Ping URL (e.g. `https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
   - Add this URL to `.env` as `HEALTHCHECK_URL=https://hc-ping.com/...`.
   - `backup.sh` automatically pings `/start` at kickoff, pings the base URL on success, and `/fail` on error. If no ping is received for 26 hours, Healthchecks.io fires an alert.

---

### 1.5 Telegram Bot (for Alerts)
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`, choose a name and username (e.g. `AkademiaAlertsBot`).
3. Save the **Bot Token** (e.g. `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).
4. Start a chat with your new bot (or add it to your private alerts group).
5. Find your Chat ID:
   - Message `@userinfobot` or forward a message to `@getidsbot` to get your numeric **Chat ID** (e.g. `123456789` or `-1001234567890`).

---

### 1.6 Bunny.net Stream Setup (Video Hosting & 5 Keys)
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

### 1.7 Google Gemini API Setup (AI Essay Grader)
1. Go to **[aistudio.google.com](https://aistudio.google.com/)** and sign in with any Google account.
2. Click the **Get API key** button in the left sidebar.
3. Click **Create API key** -> select or create a project -> click **Create API key in existing project**.
4. Copy the generated key (starts with `AIzaSy...`).
   - Paste into: **`GEMINI_API_KEY`**.
   *(The free tier provides generous daily quota for student essay evaluations).*

---

### 1.8 Supabase Storage Setup (Quiz & Course Thumbnails)
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

### 1.9 Auto-Generated Passwords & Secrets (No Account Needed)
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
This single command updates Ubuntu, installs Docker CE + Compose, configures the UFW firewall (locking ports 80/443 strictly to Cloudflare IPs), enables Fail2ban, sets up a 2GB swap file, creates the `deploy` user with passwordless sudo & docker privileges, and hardens SSH by **disabling root login completely** (`PermitRootLogin no`).

```bash
# Run once as root to provision the server and install your deploy SSH key:
ssh root@<HOSTINGER_VPS_IP> 'bash -s' < deploy/scripts/provision-vps.sh "$(cat ~/.ssh/id_rsa.pub)"
```
> **Security Note:** Once this script completes, root SSH is disabled. All subsequent commands use the `deploy` user.

---

### 2.2 Install Cloudflare Origin CA Certificates
Transfer the `origin.pem` and `origin.key` files you saved in Step 1.2 directly into `/opt/teacher-app/deploy/nginx/ssl/` (which is owned by the `deploy` user):

```bash
# Copy certificates as deploy user (no root permissions needed):
scp origin.pem deploy@<HOSTINGER_VPS_IP>:/opt/teacher-app/deploy/nginx/ssl/origin.pem
scp origin.key deploy@<HOSTINGER_VPS_IP>:/opt/teacher-app/deploy/nginx/ssl/origin.key

# Set strict permissions:
ssh deploy@<HOSTINGER_VPS_IP> "chmod 644 /opt/teacher-app/deploy/nginx/ssl/origin.pem && chmod 600 /opt/teacher-app/deploy/nginx/ssl/origin.key"
```

---

### 2.3 Copy Project Deployment Files to the VPS
Copy only `docker-compose.yml` and the `deploy/` template directory to `/opt/teacher-app/` on the VPS (excluding `.git`, logs, and source files):

```bash
rsync -avz --exclude '.git' --exclude '*.log' --exclude '.env*' deploy/ docker-compose.yml deploy@<HOSTINGER_VPS_IP>:/opt/teacher-app/
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
FRONTEND_URL=https://teacherdomain.com

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
sudo nano /root/.config/rclone/rclone.conf
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
Save and secure it: `sudo chmod 600 /root/.config/rclone/rclone.conf`.

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

### What the Backup Does NOT Cover
The daily backup contains a complete, encrypted dump of the **PostgreSQL relational database** (all users, courses, quiz structures, attempts, grades, enrollments, and transactions). It does **NOT** cover:
1. **Supabase Storage:** Quiz and course thumbnail images live in your Supabase bucket. They are not stored on the VPS disk.
2. **Bunny.net Stream:** All uploaded video files, transcoded renditions, and thumbnails live directly inside Bunny.net Stream. They are not stored on the VPS disk.
3. **Redis:** In-memory cache, active rate-limit counters, and ephemeral BullMQ queue jobs are lost on server restore (students will receive a fresh session upon logging in; any AI grading jobs in flight at failure time will need to be re-evaluated).

### Full Disaster Recovery (Restoring onto a Fresh Server)
> ⚠️ **CRITICAL PREREQUISITE:** Restoring onto a new server **REQUIRES your `BACKUP_ENCRYPTION_PASSPHRASE` and R2 credentials** saved in your external password manager. GPG AES-256 encrypted backups CANNOT be decrypted without this passphrase.

If the VPS hardware fails completely:
1. Provision a new VPS following Phase 2 (`provision-vps.sh` + copy deployment files).
2. Configure `/root/.config/rclone/rclone.conf` with your R2 credentials.
3. Create `/opt/teacher-app/.env` containing your database secrets and `BACKUP_ENCRYPTION_PASSPHRASE`.
4. Start PostgreSQL:
   ```bash
   docker compose up -d postgres
   ```
5. Restore the latest backup from Cloudflare R2:
   ```bash
   bash deploy/scripts/restore.sh latest
   ```
6. Start the full application stack:
   ```bash
   docker compose up -d
   ```
7. Update Cloudflare DNS `api` record to the new VPS IP.
   - **Target Recovery Time (RTO):** Target under one hour, to be confirmed by a real restore drill on your infrastructure.

---

## Phase 7: Central Monitoring Server Setup (Option 1: Loki + Telegram)

To monitor all your teacher instances in one central dashboard, provision a small **€3.79/month VPS** (e.g. Hetzner CX22 or Hostinger KVM 1):

### 7.1 Security Architecture & Port Bindings

#### Monitoring Server Port Bindings
| Service | Container Port | Host Port Binding | Cross-Host Access Rule |
|---|---|---|---|
| **Loki** | `3100` | `${LOKI_BIND_IP:-127.0.0.1}:3100` | Set `LOKI_BIND_IP=<MONITORING_TAILSCALE_IP>` so teacher VPS Promtail can push logs. |
| **Prometheus** | `9090` | `${PROMETHEUS_BIND_IP:-127.0.0.1}:9090` | Localhost or Admin Tailscale IP. Scrapes teacher nodes over Tailscale. |
| **Alertmanager** | `9093` | `${ALERTMANAGER_BIND_IP:-127.0.0.1}:9093` | Localhost or Admin Tailscale IP. Outbound alerts to Telegram API. |
| **Grafana** | `3000` | `${GRAFANA_BIND_IP:-127.0.0.1}:3000` | Localhost SSH tunnel or Admin Tailscale IP. Never exposed on 0.0.0.0. |

#### Teacher VPS Port Bindings
| Service | Container Port | Host Port Binding | Cross-Host Access Rule |
|---|---|---|---|
| **Nginx** | `80, 443` | `0.0.0.0:80, 0.0.0.0:443` | Publicly reachable ONLY from Cloudflare IPs (enforced by UFW). |
| **Node Exporter** | `9100` | `${TAILSCALE_IP:-127.0.0.1}:9100` | Scraped strictly by central Prometheus over Tailscale. |
| **cAdvisor** | `8080` | `${TAILSCALE_IP:-127.0.0.1}:8080` | Scraped strictly by central Prometheus over Tailscale. |
| **Postgres Exporter** | `9187` | `${TAILSCALE_IP:-127.0.0.1}:9187` | Scraped strictly by central Prometheus over Tailscale. |
| **Redis Exporter** | `9121` | `${TAILSCALE_IP:-127.0.0.1}:9121` | Scraped strictly by central Prometheus over Tailscale. |
| **Promtail** | None (client) | No host ports | Outbound HTTP push to `http://<MONITORING_TAILSCALE_IP>:3100/loki/api/v1/push`. |
| **Postgres / Redis / API** | `5432, 6379, 3005` | None (internal bridge) | Never published to the host; reachable only within the internal Docker network. |

#### Tailscale Mesh VPN & Zero-Trust ACL Rules
Connect the central monitoring server to each teacher VPS over Tailscale:
```bash
# Run on both monitoring server and each teacher VPS:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In your **Tailscale Admin Console -> Access Controls**, enforce strict tag-based boundaries:
```json
{
  "tagOwners": {
    "tag:monitoring": ["autogroup:admin"],
    "tag:teacher-vps": ["autogroup:admin"]
  },
  "acls": [
    // 1. Prometheus on monitoring server can scrape metrics from teacher nodes
    {
      "action": "accept",
      "src": ["tag:monitoring"],
      "dst": ["tag:teacher-vps:9100,8080,9187,9121"]
    },
    // 2. Promtail on teacher nodes can push logs to Loki on monitoring server
    {
      "action": "accept",
      "src": ["tag:teacher-vps"],
      "dst": ["tag:monitoring:3100"]
    },
    // 3. Admin user can access Grafana, Prometheus, Alertmanager, and SSH
    {
      "action": "accept",
      "src": ["autogroup:admin"],
      "dst": ["tag:monitoring:22,3000,9090,9093", "tag:teacher-vps:22"]
    }
  ]
}
```

### 7.2 Starting the Monitoring Suite
1. On the monitoring VPS, navigate to `deploy/monitoring/`:
2. Launch the stack:
   ```bash
   docker compose -f docker-compose.monitoring.yml up -d
   ```
3. Access Grafana securely:
   - **Option A (SSH Tunnel):** Run on your local computer: `ssh -L 3000:127.0.0.1:3000 deploy@<MONITORING_VPS_IP>`, then open `http://localhost:3000` in your browser.
   - **Option B (Tailscale):** Set `GRAFANA_BIND_IP=<MONITORING_TAILSCALE_IP>` in `.env` and browse directly to `http://<MONITORING_TAILSCALE_IP>:3000`.
   - Default login: `admin` / password from `GRAFANA_ADMIN_PASSWORD`.

### 7.3 Rate-Limiting & Alert Grouping
Alertmanager (`alertmanager.yml`) is preconfigured with smart rate-limiting to prevent notification storms:
- `group_by: ['alertname', 'tenant', 'severity']`
- `group_wait: 30s` (batches initial bursts)
- `group_interval: 5m` (batches follow-up notifications)
- `repeat_interval: 4h` (suppresses recurring alerts for the same issue for 4 hours)

### 7.4 External Uptime Checks (Independent Verifier)
Host a lightweight uptime monitor (e.g. **UptimeRobot** free tier or **Uptime Kuma** on a separate independent provider):
- **Probe URL:** `https://api.teacherdomain.com/healthz`
- **Interval:** 60 seconds
- **Alert Channel:** Telegram or Email
- This alerts you immediately if Cloudflare DNS, CDN edge, or the host VPS network drops completely, independent of internal monitoring.

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
