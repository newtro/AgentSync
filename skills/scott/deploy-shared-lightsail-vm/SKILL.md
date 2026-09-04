---
name: deploy-shared-lightsail-vm
description: Safely deploy, redeploy, or operate an app on the user's shared Ubuntu 24.04 Lightsail VM behind Caddy and PostgreSQL. Use when the user asks to deploy to the shared VM, add a site or subdomain, set up a systemd service, configure Caddy or Cloudflare DNS, or synchronize an app database to that VM.
---

# Deploy to the Shared Lightsail VM

Use this workflow for the user's shared production VM. It hosts many sites behind one Caddy reverse proxy and shared PostgreSQL 16. Treat unrelated sites and data as out of scope.

## Non-negotiable safeguards

- Survey the host before changing it. Use direct SSH to the configured `vm` host when available.
- Never restart Caddy. Validate its configuration, then reload it only: `caddy validate` followed by `caddy reload`.
- Never freely restart PostgreSQL. Create a dedicated role and database for each app; never alter existing databases or roles.
- Bind app services to loopback unless an explicit exception is approved. Route public traffic through Caddy.
- Use a dedicated directory, service name, port, database role, database, hostname, and deploy key for every app.
- Resolve exact targets and ask for approval before any destructive, billable, credential, DNS, firewall, database-overwrite, or broadly visible action.
- Do not expose credentials or copy their values into logs, chat, source control, or service definitions.

## Survey first

Inspect Node version, free disk, Caddy/PostgreSQL health, existing non-template databases, and the proposed port. Confirm the port, service name, hostname, database, and role do not collide. Check the repository for deploy guidance and required generated assets before making a server change.

## Deploy workflow

1. **Plan and isolate** — Choose the dedicated names and a loopback port. Confirm the app's persistence, backup, and rollback strategy.
2. **Provision data only when needed** — Create a dedicated PostgreSQL role and database. Keep generated passwords in the target app's protected environment file, not shell history or output.
3. **Get immutable source to the host** — Prefer a repository-specific read-only deploy key and clone into `/opt/<app>`. Verify all required assets are actually available to the server build.
4. **Build and configure** — Use the project-supported runtime commands. For this shared VM, prefer `npm install` over `npm ci` when Windows-produced lockfiles cause optional-native-dependency drift. Protect environment files with owner-only permissions.
5. **Run as a dedicated systemd service** — Use a real production entrypoint, `User=ubuntu`, an explicit working directory, restart policy, and loopback listener. Enable only the dedicated service. Verify its loopback health endpoint before proxy changes.
6. **Add a dedicated Caddy site only if public HTTPS is approved** — Back up the Caddyfile, add only the new site block, validate, then reload; never restart. Use same-origin API/WebSocket routing and static SPA fallback when applicable.
7. **Configure DNS only if approved** — Use a dedicated DNS-only record for Caddy-managed TLS unless the approved architecture requires another mode. Do not alter unrelated DNS records.
8. **Verify and hand off** — Check service health, loopback behavior, public TLS, logs, and rollback. Record what changed, the deployed revision, service/hostname, and recovery steps without secrets.

## Redeployments

Confirm the target app and revision. Pull the intended source, install/build, apply only reviewed migrations, restart only that app's service, and verify health. Do not restart Caddy or PostgreSQL as part of a normal redeploy.

## Database imports

Treat a database import as destructive. Require explicit confirmation of source, target, and overwrite intent. For newer local PostgreSQL versions to the VM's PostgreSQL 16, prefer a data-only plain dump, load it into the dedicated target database while the target app is stopped, then verify key table counts before starting the target service. Never use this process against an unrelated shared database.

## Recovery and failure handling

- On failed build or health check, leave unrelated services unchanged; inspect the app's logs and use its documented rollback path.
- On Caddy validation failure, do not reload; restore only the dedicated change and validate again.
- On migration or import failure, keep the affected app stopped and preserve evidence; do not restart shared PostgreSQL as a recovery shortcut.
- For large operations, use a bounded background job and poll its log rather than holding an interactive session indefinitely.

## Completion evidence

Report the dedicated service and hostname in human terms, health and TLS results, deploy revision, data migration status, rollback route, and any remaining risk. Never claim success merely because a process started.
