#!/bin/sh
set -eu

case "${1:-}" in
  '') set -- --quiet ;;
  --dry-run) set -- --dry-run ;;
  *) echo "dsh-remote: expected no argument or --dry-run" >&2; exit 2 ;;
esac

docker run --rm \
  -v __CERTBOT_CONFIG__:/etc/letsencrypt \
  -v __CERTBOT_WEBROOT__:/var/www/certbot \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  --cert-name __DOMAIN__ -d __DOMAIN__ \
  --non-interactive --agree-tos --no-eff-email --keep-until-expiring "$@"

docker exec __NGINX_CONTAINER__ nginx -t
docker exec __NGINX_CONTAINER__ nginx -s reload
