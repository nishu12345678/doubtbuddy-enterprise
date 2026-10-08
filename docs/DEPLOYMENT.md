# Future DigitalOcean deployment

Local testing is the current target. No Droplet or DNS changes have been made. Use `socket.doubtbuddy.ai` when a server is provisioned.

## Local acceptance

1. Run `npm run dev`; open `http://localhost:5173/admin`.
2. Enter `ADMIN_TOKEN` from your local `.env`, create a partner, and open its learning-studio URL.
3. Submit a question. Verify understanding appears first, then try one step, all steps, final answer and a step-specific follow-up.
4. Give the customer [PARTNER-API.md](PARTNER-API.md) and a separately issued partner key. They can use the local API at port 3001 during development.

Run `npm test` and `npm run test:browser`. Opt-in live verification: `node --env-file=.env tests/live-smoke.js`. It makes two billable model calls and revokes its temporary partner key afterward.

## Single Droplet preparation

Use a Linux Droplet with Node.js 24, persistent storage and an HTTPS reverse proxy. Copy source and lockfile, run `npm ci` and `npm run build`, then run `npm start` under a service manager as an unprivileged account. Keep `.env` and `data/` private and persistent. Configure:

```dotenv
PORT=3001
PUBLIC_URL=https://socket.doubtbuddy.ai
ALLOWED_ORIGINS=https://socket.doubtbuddy.ai
DEMO_MODE=false
# Set OPENAI_API_KEY and a new random ADMIN_TOKEN privately.
```

Add customer frontend origins to each partner's allowed origins. Point the `socket` DNS A record to the Droplet's public IPv4 address. Expose ports 80/443 at the firewall and restrict direct access to 3001. Provision a valid TLS certificate for the hostname.

The following Nginx location belongs inside the TLS-enabled server block for `socket.doubtbuddy.ai`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    client_max_body_size 8m;
    proxy_buffering off;
}
```

Configure gateway logs to omit query strings (partner links can contain keys), and restrict `/admin` and `/api/admin` to operators. Apply per-client gateway throttling: the app's IP throttles see the proxy's address unless deployed directly. See [Socket.IO's reverse-proxy configuration](https://socket.io/docs/v4/reverse-proxy/). This is configuration guidance; no Linux, Nginx or DigitalOcean deployment has been executed or verified here.

After deployment, check `/api/health`, a fresh polling handshake, WebSocket upgrade, authenticated staged flow, image upload, key revocation and HTTPS from the actual customer origin. Back up SQLite consistently and monitor failures, latency and provider usage. This implementation runs as one process with SQLite. Multiple instances require a shared database, distributed limits, a Socket.IO adapter and appropriate sticky routing for polling; do not simply scale replicas against the same SQLite file. Conversations are in memory and restart/disconnect clears them.
