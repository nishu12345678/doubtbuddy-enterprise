# Doubtbuddy Enterprise

A runnable React + Node.js doubt-solving system based on the supplied `Doubtbuddy - Socket Implementation.xlsx` workbook (`uat_endpoints`) and partner-key screenshot. The source workbook is unchanged. Its sample credentials are not imported or used.

## Run locally

Requires Node.js 24 or newer.

```powershell
npm install
npm run setup
```

Open `.env` locally and set `OPENAI_API_KEY`. Setup creates a random `ADMIN_TOKEN` without printing it. Keep both values private. `OPENAI_MODEL` defaults to `gpt-4.1-mini`; use a Responses API model with image input available to your OpenAI project.

```powershell
npm run dev
```

Open **http://localhost:5173/admin**, enter `ADMIN_TOKEN` from `.env`, and create a partner. Copy the newly issued partner API key and shareable URL. Open the URL to use the student interface. Keys are visible in full only at creation or rotation. Partners and usage persist in `data/doubtbuddy.sqlite`.

For a local UI demonstration without an OpenAI account, set `DEMO_MODE=true` and restart. This returns a clearly labelled, fixed quadratic example for every question; it does not solve arbitrary questions. Set it back to `false` for real answers. Missing OpenAI configuration produces a visible configuration error, never a simulated successful answer.

## Features

The server now uses the supplied **DoubtBuddy Tutor** specification in `server/tutor-prompt.md`: Class 1–12, JEE and NEET level adaptation, the requested solution sections, numbered teaching steps, Hindi/Hinglish matching, image clarification, and student boundaries. `server/tutor-instructions.js` adds renderer-specific instructions and a separate JSON-only operation for suggested questions. Restart the backend after editing the prompt file. Instructions guide model behavior; they do not guarantee correctness or perfect adherence on every question.

- Socket.IO over HTTP polling and WebSocket, namespace `/doubtBuddyLLM`, matching the workbook's event names.
- Text and image questions (PNG, JPEG, WebP; maximum 5 MB decoded), including optional typed instructions with an image, such as “solve Q4.”
- Streamed Markdown and KaTeX, including inline math, display math, fractions, matrices and boxed results. Supports `$...$`, `$$...$$`, `\(...\)` and `\[...\]`; fenced code is preserved. During streaming a partial formula can remain unfinished until its closing delimiter arrives.
- Related questions, contextual follow-ups, cancellation, incomplete-answer states, reconnect attempts, and responsive layouts.
- Admin partner creation, per-minute and daily request limits, optional expiry and allowed frontend origins, key rotation, revocation and usage counters.
- Server-only OpenAI key; random partner credentials stored as SHA-256 hashes; short-lived opaque browser sessions stored hashed. Admin authentication uses a random server token.
- Tenant-scoped usage and per-socket conversation history. No broadcasts of questions or solutions. Questions, images and answers are not written to the application database.

## Staged partner API

The first text/image response is **Let's understand**, with no solution steps. The partner frontend then sends `next-step-query`, `all-steps-query`, or `solution-query` using the returned `questionId`. Structured, validated JSON contains Markdown/LaTeX fields. The included UI demonstrates this exact flow; your enterprise customers own their frontend. Existing workbook events are preserved.

See [PARTNER-API.md](docs/PARTNER-API.md) for the complete staged contract and [DigitalOcean preparation](docs/DEPLOYMENT.md) for future `socket.doubtbuddy.ai` hosting.

## Integration

See [Tutor flows](docs/TUTOR-FLOWS.md) for step-specific follow-ups, full context with long-thread summarization, language matching, student profiles, image-extraction review and reasoning-model routing.

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for the exact workbook mapping, payloads, authentication, errors, and Node/browser examples.

The browser exchanges a partner key for a one-hour session and immediately removes the `key` query parameter from the address bar. Session credentials live in memory, so a refresh requires the shared link or key again. The workbook's `login` event remains supported for existing clients. `login-success.aapiKey` is deliberately masked instead of echoing the secret.

Your customer-facing service uses WebSocket. The server calls OpenAI's streaming Responses API and streams follow-up deltas through Socket.IO; structured understanding and solution actions are buffered and validated before delivery. OpenAI's upstream HTTP stream and the downstream Socket.IO connection are separate connections. See the official [streaming documentation](https://developers.openai.com/api/docs/guides/streaming-responses) and [image input documentation](https://developers.openai.com/api/docs/guides/images-vision).

## Verification

```powershell
npm test
npm run test:browser
```

Backend tests cover authentication, workbook events, tenant isolation, input validation, per-partner rate and daily limits, session invalidation, rotation, revocation, origin restrictions, cancellation, timeout, and OpenAI streaming conversion using a mock HTTP response. Browser checks exercise partner creation, shared-link login, streaming, rendered KaTeX, suggestions, follow-ups, image upload and mobile overflow with a labelled demo provider. Browser tests use installed Microsoft Edge in headless mode. For another platform, change `channel: 'msedge'` in `tests/browser.js` or install a Playwright browser.

Live OpenAI inference, account model access and real-image solution accuracy require your API key and are not covered by the offline test suite. Model output can contain incorrect mathematics; the renderer formats it but does not prove it correct.

## Deployment

```powershell
npm ci
npm run build
npm start
```

The backend serves the production frontend on port 3001. Set `PUBLIC_URL` to the public HTTPS origin, set `ALLOWED_ORIGINS` to your permitted frontend origins, and leave `DEMO_MODE=false`. Terminate TLS at a reverse proxy that forwards WebSocket upgrades at `/socket.io/` and allows a 180-second read timeout. Set proxy access logs to omit query strings because shared URLs contain credentials. Do not use a static-only host or a function host that cannot keep WebSockets open.

Mount `data/` on a durable private volume and back up the SQLite database consistently with SQLite's backup facilities. Protect `.env` and the database with host permissions. Use a secret manager for production environment values. Restrict `/admin` and `/api/admin` at the gateway to authorized operators; this initial admin console uses one server token, not multi-user SSO/RBAC.

This implementation is a **single-instance foundation**, not a provisioned high-availability enterprise service. SQLite reservations enforce quotas atomically, but concurrent request caps, connection limits and authentication throttles are process-local. Multiple replicas need a shared transactional database, distributed throttling, the Socket.IO Redis adapter for revocation across replicas, and connection routing. Do not run multiple copies against the SQLite file. Load testing, monitoring, SSO, billing and deployment automation are not included.

Daily limits reset at midnight UTC and count accepted AI requests, including suggestions, failed requests and cancellations. Text is capped at 12,000 characters, follow-up questions at 4,000, standard output at 4,096 model tokens (8,192 for reasoning routes), five concurrent requests per partner, and one active query per socket. A socket retains the original question/image and solution; after ten follow-ups it summarizes older turns while keeping four recent pairs. Reconnecting starts a fresh conversation. Requests time out after 120 seconds. Persisted usage reflects provider-reported completed response tokens; interrupted calls may still incur provider charges not reflected in these counters. Provider accounting remains the billing source of truth.

Partner links are bearer credentials: anyone receiving one can consume that partner's allowance. Origin restrictions mitigate browser misuse but are not end-user authentication. For private enterprise integrations, keep the partner key on the customer's backend, authenticate their users there, and exchange it for a short-lived session. A session does not grant admin access. For per-user permissions or quotas, add verified user identity to session issuance.

API input is sent to OpenAI to generate the response with `store:false`. This application does not persist question content; OpenAI's own retention depends on your account and agreement. Request metadata and administrative audit events remain in SQLite; define your retention and purge schedule before a production rollout.

## Files

- `server/app.js`: HTTP admin/session endpoints and Socket.IO handlers.
- `server/store.js`: SQLite persistence, hashing, usage limits and audit events.
- `server/provider.js`: OpenAI streaming adapter and explicit demo provider.
- `src/App.jsx`: student interface and partner console.
- `src/MathMarkdown.jsx`: Markdown/LaTeX rendering without raw HTML or trusted LaTeX commands.
- `tests/`: backend and browser tests.

All fonts, scripts and math assets are served locally. Production responses include CSP, no-referrer headers, API `no-store` headers, and no credential logging.
