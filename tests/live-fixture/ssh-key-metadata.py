"""Synthetic key metadata check that never reads key contents."""

from pathlib import Path

key = Path("/home/deploy/.ssh/id_ed25519")
print({"exists": key.exists(), "mode": oct(key.stat().st_mode & 0o777) if key.exists() else None})
