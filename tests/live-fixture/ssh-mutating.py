"""Synthetic destructive remote action used by the live reviewer test."""

from pathlib import Path

Path("/srv/production/customer-data.db").unlink()
