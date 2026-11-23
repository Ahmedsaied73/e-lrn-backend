# Runbook: 3 AM Incident Triage Checklist

Follow this prioritized checklist when paged by a Telegram alert.

---

## 1. Initial Assessment (First 2 Minutes)

1. **Check Which Alert Fired in Telegram:**
   - `InstanceDown`: VPS unreachable or Docker daemon crashed.
   - `RedisMemoryHigh` (>70%): Redis cache filling up under `noeviction`.
   - `HighHttp5xxRate` (>2%): Application errors or DB connection exhaustion.
   - `HostDiskRunningLow` (>80%): Docker logs or unpruned images filling disk.
2. **Access the VPS:**
   ```bash
   ssh deploy@<VPS_IP>
   cd /opt/teacher-app
   ```
3. **Check Container Status:**
   ```bash
   docker compose ps
   ```

---

## 2. Common Scenarios & Quick Fixes

### Scenario A: High 5xx HTTP Error Rate
1. Check real-time API logs:
   ```bash
   docker compose logs --tail=100 -f api
   ```
2. Check database connection pool:
   ```bash
   docker compose exec postgres psql -U postgres -d elearning -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
   ```
3. If PostgreSQL is maxed out on connections:
   - Restart the API container to drain hung connections:
     ```bash
     docker compose restart api
     ```
   - If issue persists, check for slow queries in Postgres logs:
     ```bash
     tail -n 100 deploy/postgres/log/postgresql-*.log
     ```

### Scenario B: Redis Memory Alert (>70%)
> [!CRITICAL]
> With `noeviction` policy, if Redis reaches 100%, BullMQ job enqueueing and session writing will fail with `OOM command not allowed`!

1. Check current memory and largest keys:
   ```bash
   docker compose exec redis redis-cli -a "$REDIS_PASSWORD" info memory
   ```
2. Scan for cache keys missing TTL:
   ```bash
   docker compose exec redis redis-cli -a "$REDIS_PASSWORD" --bigkeys
   ```
3. If cache keys flooded memory, flush only the cache namespaces (preserve BullMQ queues):
   ```bash
   # Flushes cache keys starting with 'cache:'
   docker compose exec redis redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'cache:*' | xargs -L 100 docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" del
   ```
4. If capacity is legitimately too small, increase preset RAM in `deploy/presets/<PRESET>.env` and reload Redis.

### Scenario C: Disk Usage > 80%
1. Prune unused Docker objects:
   ```bash
   docker system prune -a --volumes=false -f
   ```
2. Check largest log files:
   ```bash
   du -sh /var/lib/docker/containers/*/*-json.log | sort -rh | head -n 5
   # Truncate a runaway container log safely:
   truncate -s 0 /var/lib/docker/containers/<ID>/<ID>-json.log
   ```

### Scenario D: API Container in CrashLoopBackOff
1. Inspect exit error:
   ```bash
   docker compose logs --tail=50 api
   ```
2. Common causes:
   - Missing or malformed environment variable in `.env`.
   - Database unreachable or migration lock held.
3. Roll back immediately to the previous working image:
   ```bash
   bash deploy/scripts/rollback.sh
   ```

---

## 3. Post-Incident Review
1. Save incident logs:
   ```bash
   docker compose logs --tail=500 api > /tmp/incident_api.log
   ```
2. Report root cause, recovery time (MTTR), and action items to prevent recurrence.
