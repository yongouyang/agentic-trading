#!/usr/bin/env python3
"""XNYS archive check 1: sha256-verify every file against manifest.json.

Read-only on the archive. No zstandard needed (hashes the .zst payloads).
"""
import hashlib
import json
import os
import sys

DIR = os.path.expanduser("~/Downloads/XNYS-20260903-GYR7NW7XTP")


def main():
    with open(os.path.join(DIR, "manifest.json")) as fh:
        manifest = json.load(fh)
    files = manifest.get("files", manifest if isinstance(manifest, list) else [])
    print(f"manifest entries: {len(files)}")
    ok, bad, missing = 0, [], []
    on_disk = set(os.listdir(DIR))
    seen = set()
    for i, entry in enumerate(files):
        name = entry.get("filename") or entry.get("name") or entry.get("path")
        want = entry.get("hash") or entry.get("sha256")
        if want and want.startswith("sha256:"):
            want = want[7:]
        if name is None or want is None:
            print("UNPARSED ENTRY KEYS:", list(entry.keys()))
            print(json.dumps(entry)[:500])
            break
        seen.add(name)
        path = os.path.join(DIR, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest().lower() == want.lower():
            ok += 1
        else:
            bad.append(name)
        if (i + 1) % 250 == 0:
            print(f"  ...{i + 1}/{len(files)} ok={ok}", flush=True)
    extra = sorted(f for f in on_disk - seen if f not in (".DS_Store",))
    print(f"\nPASS: {ok}  FAIL: {len(bad)}  MISSING: {len(missing)}")
    if bad:
        print("failed files:", bad[:20])
    if missing:
        print("missing files:", missing[:20])
    print(f"on-disk files not in manifest: {len(extra)}")
    for f in extra[:20]:
        print("  EXTRA", f)
    sys.exit(0 if not bad and not missing else 1)


if __name__ == "__main__":
    main()
