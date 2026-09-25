"""Enable working Telegram IPv6 egress without exposing either database."""
import pathlib
import sys

target = pathlib.Path(sys.argv[1]).resolve() / "compose.production.yml"
content = target.read_text(encoding="utf-8")
if "telegram_egress:" in content:
    raise SystemExit("Telegram egress is already configured; inspect instead of overwriting")
old = '    extra_hosts:\n      - "api.telegram.org:149.154.167.220"\n'
if content.count(old) != 2:
    raise RuntimeError("Unexpected app/poller host configuration")
content = content.replace(old, "    environment:\n      NODE_OPTIONS: --dns-result-order=ipv6first --no-network-family-autoselection\n")
for old, new in [
    ("      - backend\n      - web\n\n  caddy:", "      - backend\n      - web\n      - telegram_egress\n\n  caddy:"),
    ("      - web\n\n  tools:", "      - web\n      - telegram_egress\n\n  tools:"),
    ("  web:\n\nvolumes:", "  web:\n  telegram_egress:\n    enable_ipv6: true\n\nvolumes:"),
]:
    if content.count(old) != 1:
        raise RuntimeError("Unexpected network configuration")
    content = content.replace(old, new)
target.write_text(content, encoding="utf-8")
print("Telegram IPv6 egress configured for website app and poller")
