# Deployment Validation Tests — أكاديمية التميز

This directory contains standalone, non-destructive test scripts to validate all deployment configurations, templates, and schemas locally before shipping to a teacher VPS.

---

## 1. Nginx Syntax Check

Validates that `site.conf.template`, `upstream.conf`, and `cloudflare-ips.conf` compile without syntax errors or deprecated directives.

```bash
bash deploy/tests/test-nginx-config.sh
```

**Prerequisites:** `nginx` and `openssl` (available in Linux / WSL).

---

## 2. Monitoring Configuration Check

Validates Prometheus rules (`alert.rules.yml`), Prometheus scrape config (`prometheus.yml`), and Alertmanager configuration (`alertmanager.yml`).

```bash
bash deploy/tests/test-monitoring-config.sh
```

**Prerequisites:** `promtool` and `amtool` (installed via `apt install promtool prometheus-alertmanager`).

---

## 3. Shell Script Linter (Shellcheck)

Validates that all scripts in `deploy/scripts/` conform to strict Bash POSIX standards without syntax bugs.

```bash
shellcheck deploy/scripts/*.sh
```
