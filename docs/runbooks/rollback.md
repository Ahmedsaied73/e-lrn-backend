# Runbook: Emergency Rollback

Use this runbook when a deployment causes unexpected application regressions, high 5xx error spikes, or database deadlocks.

---

## 1. Automatic Rollback (Built-in)

`deploy.sh` automatically rolls back if `/readyz` fails during deployment. The previous active container is never interrupted if the new container cannot boot or reach the database.

---

## 2. Manual 1-Command Rollback

To immediately revert a running VPS to its previous image:

```bash
ssh deploy@<VPS_IP>
cd /opt/teacher-app

# 1. Instant rollback to previous tag recorded in .previous_tag:
bash deploy/scripts/rollback.sh

# 2. Or rollback to an explicit older git SHA:
bash deploy/scripts/rollback.sh --tag 9a8b7c6d5e4f
```

---

## 3. Database Migration Rollback Considerations

Prisma migrations follow the **expand-and-contract** design:
- Additive changes (new columns with default/null, new tables) are backward-compatible with the previous application tag.
- If a migration added a column that broke queries, you can restore the pre-deploy database snapshot created by `deploy.sh`:

```bash
cd /opt/teacher-app
# List available pre-deploy backups:
rclone lsf "${BACKUP_STORAGE_DEST}/pre-deploy"

# Restore pre-deploy snapshot:
bash deploy/scripts/restore.sh "${BACKUP_STORAGE_DEST}/pre-deploy/<SNAPSHOT_NAME>.gpg"
```

---

## 4. Post-Rollback Verification

1. Verify process health:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env ps
   curl -s http://127.0.0.1:3005/readyz
   ```
2. Verify Nginx response:
   ```bash
   curl -I https://api.<teacherdomain.com>/readyz
   ```
3. Check application logs for lingering errors:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env logs --tail=100 -f api
   ```
