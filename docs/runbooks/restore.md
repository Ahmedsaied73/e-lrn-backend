# Runbook: Database Restore & Disaster Recovery

This runbook covers restoring a tenant database from backup in the event of data corruption, accidental deletion, or complete VPS hardware failure.

---

## 1. Backup Structure & Retention in Object Storage (Cloudflare R2)

Backups are encrypted using AES256 GPG before leaving the VPS:
```
r2:teacher-backups/<tenant-slug>/
├── daily/          # Retained for 7 days
├── weekly/         # Retained for 4 weeks (taken on Sundays)
├── monthly/        # Retained for 3 months (taken on the 1st of each month)
└── pre-deploy/     # Retained for 3 days
```

---

## 2. Standard Restore Procedure (Existing VPS)

1. **SSH to Tenant VPS:**
   ```bash
   ssh deploy@<VPS_IP>
   cd /opt/teacher-app
   ```
2. **Stop Application Containers (Prevents In-Flight Writes):**
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env stop api worker
   ```
3. **Restore Latest Daily Backup:**
   ```bash
   bash deploy/scripts/restore.sh latest
   ```
4. **Or Restore a Specific Archive:**
   ```bash
   # List available archives in storage:
   rclone lsf "r2:teacher-backups/<tenant-slug>/daily"

   # Restore specific file:
   bash deploy/scripts/restore.sh "r2:teacher-backups/<tenant-slug>/daily/teacher_daily_2026-11-23_030000.sql.gz.gpg"
   ```
5. **Restart Application Services:**
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env start api worker
   docker compose -f deploy/docker-compose.yml --env-file .env logs --tail=50 -f api
   ```

---

## 3. Catastrophic Disaster Recovery (Rebuilding on a Fresh VPS)

If the entire VPS is destroyed:
1. Spin up a new VPS on Hostinger/Hetzner.
2. Follow `docs/runbooks/add-tenant.md` to run `provision-vps.sh` and set up `.env` with the same `BACKUP_ENCRYPTION_PASSPHRASE`.
3. Start the Postgres service only:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env up -d postgres
   ```
4. Restore the latest backup:
   ```bash
   bash deploy/scripts/restore.sh latest
   ```
5. Run Prisma migrate to verify schema integrity:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env run --rm --no-deps api npx prisma migrate deploy
   ```
6. Start the full stack:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env up -d
   ```
7. Update DNS in Cloudflare to point to the new VPS IP.

---

## 4. Automated Restore Drill (Weekly Integrity Check)

The template includes an automated restore test script that verifies backups without touching production data:

```bash
bash deploy/scripts/restore-test.sh
```

**What it does:**
1. Spins up a temporary disposable Postgres container.
2. Downloads and decrypts the latest backup from Cloudflare R2.
3. Restores it into the disposable container.
4. Queries table row counts (`User`, `Course`) and verifies student records.
5. Measures and logs Recovery Time (RTO).
6. Automatically destroys the disposable container.
7. Dispatches a Telegram report with verified row counts and duration.
