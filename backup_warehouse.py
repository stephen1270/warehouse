#!/usr/bin/env python3
"""
Warehouse — nightly backup script.

Exports the entire Supabase kv_store table (every restaurant, wine,
cheese, spirits, pantry, tinned-fish, and music entry) to a dated JSON
file, and prunes backups older than RETENTION_DAYS.

Uses only the Python standard library — no pip installs needed, so
this keeps working even if the environment running it is bare-bones.

Auth note: this uses the same publishable/anon key already embedded
client-side in every Warehouse HTML page (safe to keep in this script
too — it's not a new exposure, just the same public key). It works
because kv_store's Row Level Security policy already allows public
SELECT; no service-role key is needed or used.
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

# --- Configuration -----------------------------------------------------

SUPABASE_URL = "https://psbdjeyianlhfkgwwsvt.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_fmEJD4dXEZF0elMTqgfhIg_nH-dCQn_"

# Adjust this if your Warehouse folder lives somewhere else or under a
# different capitalization — this assumes ~/Desktop/warehouse/Backups.
BACKUP_DIR = os.path.expanduser("~/Desktop/warehouse/Backups")

RETENTION_DAYS = 7
PAGE_SIZE = 500  # rows per request; paginates automatically if the table grows past this

FILENAME_RE = re.compile(r"^warehouse_backup_(\d{4}-\d{2}-\d{2})\.json$")


def log(message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {message}"
    print(line)
    log_path = os.path.join(BACKUP_DIR, "backup.log")
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # logging failure shouldn't crash the backup itself


def fetch_all_rows():
    """Pages through kv_store via PostgREST's Range header and returns
    every row as {'key', 'value' (parsed JSON), 'updated_at'}."""
    rows = []
    offset = 0
    while True:
        url = (
            f"{SUPABASE_URL}/rest/v1/kv_store"
            f"?select=key,value,updated_at&order=key.asc"
        )
        req = urllib.request.Request(url, method="GET")
        req.add_header("apikey", SUPABASE_ANON_KEY)
        req.add_header("Authorization", f"Bearer {SUPABASE_ANON_KEY}")
        req.add_header("Range-Unit", "items")
        req.add_header("Range", f"{offset}-{offset + PAGE_SIZE - 1}")
        # Python's default User-Agent (Python-urllib/3.x) appears to get
        # blocked at Supabase's edge — curl with the exact same request
        # succeeds, so this pretends to be curl instead.
        req.add_header("User-Agent", "curl/8.0")

        with urllib.request.urlopen(req, timeout=60) as resp:
            page = json.loads(resp.read().decode("utf-8"))

        if not page:
            break

        for row in page:
            try:
                parsed_value = json.loads(row["value"])
            except (TypeError, ValueError):
                parsed_value = row["value"]  # keep raw if it doesn't parse
            rows.append({
                "key": row["key"],
                "updated_at": row["updated_at"],
                "value": parsed_value,
            })

        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    return rows


def prune_old_backups():
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    removed = 0
    for name in os.listdir(BACKUP_DIR):
        m = FILENAME_RE.match(name)
        if not m:
            continue
        try:
            file_date = datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if file_date < cutoff:
            try:
                os.remove(os.path.join(BACKUP_DIR, name))
                removed += 1
            except OSError as e:
                log(f"Could not remove old backup {name}: {e}")
    return removed


def main():
    os.makedirs(BACKUP_DIR, exist_ok=True)

    try:
        rows = fetch_all_rows()
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        log(f"BACKUP FAILED — could not fetch data: {e}")
        sys.exit(1)

    today = datetime.now().strftime("%Y-%m-%d")
    out_path = os.path.join(BACKUP_DIR, f"warehouse_backup_{today}.json")

    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=0)
    except OSError as e:
        log(f"BACKUP FAILED — could not write {out_path}: {e}")
        sys.exit(1)

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    removed = prune_old_backups()
    log(f"Backup OK — {len(rows)} rows, {size_mb:.1f}MB, saved to {out_path}. Pruned {removed} old backup(s).")


if __name__ == "__main__":
    main()
