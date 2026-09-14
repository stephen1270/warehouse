#!/usr/bin/env python3
"""
Warehouse — nightly backup script (GitHub Actions version).

Same idea as backup_warehouse.py, adapted to run in CI instead of on a
Mac: it fetches the entire Supabase kv_store table (every restaurant,
wine, cheese, spirits, pantry, tinned-fish, and music entry) and writes
a dated JSON file into this repo checkout, where the workflow commits
it. No external drive, no launchd, no dependency on any machine being
on -- GitHub's runners do the work on schedule regardless.

Uses only the Python standard library.

Auth note: uses the same publishable/anon key already embedded
client-side in every Warehouse HTML page. It works because kv_store's
Row Level Security policy already allows public SELECT; no
service-role key is needed or used, and none should be added here --
this script and its output both end up in the repo, so anything more
privileged than the anon key would leak.
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

# Relative to the repo root -- the workflow checks out the repo and runs
# this script from there, so this lands in <repo>/backups/.
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))

# Git history already keeps every past backup forever, so pruning here
# is just about keeping the working tree (and `git status`) tidy, not
# about not losing data -- nothing pruned is actually gone, it's still
# recoverable from git log. Generous by design since disk is cheap here.
RETENTION_DAYS = 60
PAGE_SIZE = 500  # rows per request; paginates automatically if the table grows past this

FILENAME_RE = re.compile(r"^warehouse_backup_(\d{4}-\d{2}-\d{2})\.json$")


def log(message):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}")


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
        req.add_header("User-Agent", "curl/8.0")

        with urllib.request.urlopen(req, timeout=60) as resp:
            page = json.loads(resp.read().decode("utf-8"))

        if not page:
            break

        for row in page:
            try:
                parsed_value = json.loads(row["value"])
            except (TypeError, ValueError):
                parsed_value = row["value"]
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
    try:
        rows = fetch_all_rows()
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        log(f"BACKUP FAILED — could not fetch data: {e}")
        sys.exit(1)

    if not rows:
        # An empty table is suspicious for a live app with 73+ pantry
        # entries alone -- more likely a bad query/auth than a real
        # empty database. Fail loudly instead of committing an empty
        # "backup" that would silently overwrite a good one on replay.
        log("BACKUP FAILED — fetched zero rows, refusing to write an empty backup")
        sys.exit(1)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = os.path.join(BACKUP_DIR, f"warehouse_backup_{today}.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=0)

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    removed = prune_old_backups()
    log(f"Backup OK — {len(rows)} rows, {size_mb:.1f}MB, saved to {out_path}. Pruned {removed} old backup(s).")


if __name__ == "__main__":
    main()
