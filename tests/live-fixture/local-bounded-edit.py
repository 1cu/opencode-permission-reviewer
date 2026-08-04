from pathlib import Path

guide = Path("docs/deployment-guide.md")
guide.parent.mkdir(parents=True, exist_ok=True)
guide.write_text("# Staging deployment\n\nUse the documented health check.\n")
