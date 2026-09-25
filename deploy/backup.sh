#!/bin/sh
set -eu
umask 077
root=/opt/rpm-club/backups/local
mkdir -p "$root"
exec 9>"$root/.lock"
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
pending="$root/.pending-$stamp"
mkdir "$pending"
# Database first: an uploaded file is persisted before its URL is committed.
docker exec rpm-club-db-1 pg_dump -U postgres -d rpm_club --format=custom --no-owner --no-acl > "$pending/database.dump"
docker exec -i rpm-club-db-1 pg_restore --list < "$pending/database.dump" > "$pending/manifest.txt"
tar -czf "$pending/media.tar.gz" -C /opt/rpm-club/data/media .
cp /etc/rpm-club.env /etc/rpm-club-db.env "$pending/"
if [ -f /etc/rpm-club-catalog.env ]; then cp /etc/rpm-club-catalog.env "$pending/"; fi
(cd "$pending" && sha256sum database.dump media.tar.gz > SHA256SUMS)
mv "$pending" "$root/$stamp"
# Only this script's dated backup folders; never application data or staging imports.
find "$root" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -mtime +14 -exec rm -rf -- {} +
echo "RPM Club backup completed: $stamp"
