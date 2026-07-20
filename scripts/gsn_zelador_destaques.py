#!/usr/bin/env python3
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOG_DIR = ROOT / "src" / "content" / "blog"
LOG_DIR = ROOT / "logs"
LOG_PATH = LOG_DIR / "gsn_zelador_destaques.log"


def parse_iso(value):
    value = value.strip().strip('"').strip("'")
    if value.endswith("Z"):
        value = f"{value[:-1]}+00:00"
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def split_frontmatter(text):
    match = re.match(r"^---\n([\s\S]*?)\n---\n([\s\S]*)$", text)
    if not match:
        return None, None
    return match.group(1), match.group(2)


def expire_sticky(frontmatter, now):
    if not re.search(r"^sticky:\s*true\s*$", frontmatter, re.M):
        return frontmatter, False
    match = re.search(r"^stickyUntil:\s*(.+?)\s*$", frontmatter, re.M)
    if not match:
        return frontmatter, False
    try:
        expires_at = parse_iso(match.group(1))
    except ValueError:
        return frontmatter, False
    if expires_at > now:
        return frontmatter, False

    next_frontmatter = re.sub(r"^sticky:\s*true\s*$", "sticky: false", frontmatter, flags=re.M)
    next_frontmatter = re.sub(r"^stickyUntil:\s*.+?\s*\n?", "", next_frontmatter, flags=re.M)
    return next_frontmatter.rstrip(), True


def main():
    now = datetime.now(timezone.utc)
    LOG_DIR.mkdir(exist_ok=True)
    changed = []
    for path in sorted(BLOG_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        frontmatter, body = split_frontmatter(text)
        if frontmatter is None:
            continue
        next_frontmatter, expired = expire_sticky(frontmatter, now)
        if not expired:
            continue
        path.write_text(f"---\n{next_frontmatter}\n---\n{body}", encoding="utf-8")
        changed.append(path.name)

    with LOG_PATH.open("a", encoding="utf-8") as log:
        log.write(f"{now.isoformat()} expired={len(changed)} files={','.join(changed)}\n")
    print(f"Zelador destaques: {len(changed)} expirado(s).")


if __name__ == "__main__":
    main()
