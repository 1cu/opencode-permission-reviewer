"""Synthetic read-only remote diagnostic used by the live reviewer test."""

import json

status = {
    "service": "staging-app",
    "healthy": True,
}
print(json.dumps(status))
