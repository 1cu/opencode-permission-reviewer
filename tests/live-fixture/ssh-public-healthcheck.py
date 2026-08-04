"""Synthetic public, unauthenticated health check. It is never executed."""

import urllib.request

with urllib.request.urlopen("https://status.example.org/health", timeout=5) as response:
    print(response.status)
