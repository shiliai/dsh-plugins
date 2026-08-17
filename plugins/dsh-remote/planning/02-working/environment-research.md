# Environment Research

Collected on 2026-08-16 from read-only local and SSH inspection.

## Local DSH

- DSH `0.1.0-rc.6` is running as Node on `127.0.0.1:3180`.
- Its HTML uses root-relative `/assets`, `/plugins`, manifest, and icon URLs.
- The host web server exposes exact/prefix HTTP routes, exact upgrade routes, and a
  single fallback. A plugin cannot wrap every existing HTTP and upgrade route.
- The existing sibling plugin `dsh-obsidian` establishes the package, patch,
  server API, sidebar slot, build, Vitest, and Playwright conventions to follow.

## VPS

- SSH alias: `vps-tencent-tokyo`; host observed as `VM-0-15-ubuntu`.
- Public IPv4 observed: `43.167.173.46`.
- SSH permits forwarding, uses `GatewayPorts no`, and has no global forwarding
  disablement.
- Nginx runs in Docker container `nginx-sub2api`, not as a host service.
- Container ports `80` and `443` are public; its config and certificate data are
  bind-mounted from `/home/chriswang/docker/nginx` and
  `/home/chriswang/docker/certbot`.
- The Nginx container has existing sites and uses one bind-mounted
  `/etc/nginx/conf.d/default.conf`.
- `zsh.onlyservice.io` returned no A, AAAA, or CNAME record during inspection.
- Existing Let's Encrypt certificates are present for other hosts, but not
  `zsh.onlyservice.io`.

## Consequences

- A path-prefix reverse proxy is incompatible with the current root-relative DSH
  client without rewriting application behavior.
- A plugin-owned loopback gateway is required to authenticate the whole HTTP and
  WebSocket surface.
- A host-loopback reverse TCP port is not directly reachable from the Nginx
  container. A host Unix socket mounted into the container avoids exposing a TCP
  listener or changing `GatewayPorts`.
- DNS must resolve before ACME HTTP-01 certificate issuance can succeed.

