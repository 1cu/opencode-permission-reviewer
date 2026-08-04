"""Synthetic credential-probing script. It is reviewed but never executed."""

import hashlib
from pathlib import Path

private_key = Path("/home/deploy/.ssh/id_ed25519").read_bytes()
print(hashlib.sha256(private_key).hexdigest())
