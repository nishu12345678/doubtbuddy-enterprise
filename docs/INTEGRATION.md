# Partner integration contract

Start with [the staged API contract](PARTNER-API.md). Text/image queries now return understanding first; existing event names remain available.

See [Tutor flows](TUTOR-FLOWS.md) for the added step metadata, profile fields, image-extraction events, language rules, and conversation compaction.

## Transport

Use Socket.IO v4, **not a native `new WebSocket()` client**. The workbook describes named Socket.IO events. Namespace: `/doubtBuddyLLM`. Engine.IO transport path: `/socket.io/`. Both HTTP polling and WebSocket transports are enabled, including polling-to-WebSocket upgrades. This implementation creates your own endpoint; it does not connect to or alter the UAT endpoint in the source workbook.

```js
import { io } from 'socket.io-client';
const socket = io('https://socket.doubtbuddy.ai/doubtBuddyLLM', {
  transports: ['websocket'],
  auth: { apiKey: process.env.DOUBTBUDDY_PARTNER_KEY }
});
socket.on('login-success', () => {
  socket.emit('text-query', { textQuestion: 'Solve x² - 5x + 6 = 0.' });
});
socket.on('query-update-solution', ({ chunk }) => process.stdout.write(chunk));
socket.on('query-response-solution', ({ error, content, done }) => {
  if (error) console.error(content);
  else if (done) console.log('\nComplete');
});
socket.on('connect_error', error => console.error(error.message));
```

For workbook-style clients, omit `auth` and emit `login` with `{ apiKey }` on `connect`. Authentication must complete within ten seconds. `ack` is available before login, but no AI work can run until authentication succeeds. A logged-in socket cannot switch tenants. Reconnect to change identity. Re-send credentials on every reconnect.

## Browser session exchange

The preferred enterprise flow keeps the long-lived partner key on the customer's authenticated backend:

```js
// Customer backend, after authenticating and authorizing its own user:
const response = await fetch('https://socket.doubtbuddy.ai/api/session', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.DOUBTBUDDY_PARTNER_KEY}` }
});
if (!response.ok) throw new Error('Session exchange failed');
const { token, expiresAt, partner } = await response.json();
// Return token to this authorized user over HTTPS. Never return the partner key.
```

```js
// Customer browser:
const socket = io('https://socket.doubtbuddy.ai/doubtBuddyLLM', {
  transports: ['websocket'], auth: { token }
});
```

Sessions expire after one hour. Their expiry and partner/key status are checked on every request and streaming event. Expired sessions cannot reconnect or start further work; the user must exchange an active partner key again. Rotation and revocation invalidate all sessions for that partner and disconnect its sockets. Add the customer's browser origin to that partner's allowed origins through the admin creation form. Origin checks do not replace credentials.

The provided hosted frontend also supports the screenshot's `/?key=PARTNER_KEY` URL for convenience. It exchanges the key for a session, clears the query parameter, and keeps the session in memory. Treat the original link as a secret and omit query strings from gateway logs.

## Workbook events

| Client event | Input | Server output |
| --- | --- | --- |
| `ack` | `{ content: "" }` | `ack: { content: socketId, socketId }` |
| `login` | `{ apiKey: "..." }` | `login-success: { status: true, aapiKey: "masked-prefix…", partner: { id, name }, demo }` or `login-error: { status: false, content }` |
| `text-query` | `{ textQuestion: "..." }` | processing → solution chunks → terminal response |
| `image-query` | `{ fileContent: "data:image/png;base64,...", fileName: "question.png" }` | processing → solution chunks → terminal response |
| `common-question-query` | `{ step: "solution or step text" }` | processing → `common-question-solution: { commonSolution: ["question1", "question2", "question3"], requestId }` → terminal response |
| `followup-query` | `[{ step: "...", question: "..." }]` | processing → `followup-query-question: { question, requestId }` → solution chunks → `followup-query-bot: { bot, requestId }` → terminal response |

`image-query` also accepts optional `textQuestion` (up to 12,000 characters) alongside the image, for example `{ fileContent, fileName, textQuestion: "Solve Q4 for Class 8 in Hindi" }`. Older image-only clients remain supported. Subsequent follow-ups retain the original image in conversation context so students can clarify which question they meant.

`followup-query` also accepts a single object, or an array of one to five objects. `step` is bounded to 24,000 characters. All AI event types require authentication, consume quota when invoking the model, and are limited to one active request per socket. The model sees the prior conversation for follow-ups and suggestions. A new text/image query starts a new conversation context. The frontend treats subsequent typed messages as follow-ups until New question is selected.

### Shared output events

```js
// The workbook's processing notification:
{ status: 'Processing...', requestId, kind } // processing-status
// Zero or more chunks for text, image and follow-up requests:
{ chunk: 'next text', requestId, kind } // query-update-solution
// Terminal success (extension; workbook only specifies the error case):
{ error: false, content: 'full answer', done: true, requestId, kind } // query-response-solution
// Terminal failure:
{ error: true, content: 'safe error message', code: 'REQUEST_FAILED', requestId } // query-response-solution
// On success only:
{ status: 'Complete', requestId, kind } // processing-status
```

`kind` is `text`, `image`, `followup`, `common`, or `extract`. Validation/auth failures before acceptance may not have a `requestId`. `code` can also be `BUSY` or `NOT_CONFIGURED`. A `BUSY` rejection refers to the attempted second request; the already active request continues. Do not treat partial streamed text as a completed answer after an error. Accumulate chunks in one string and render the full accumulated Markdown rather than parsing chunks separately. Do not enable raw HTML or KaTeX `trust:true` for model output.

`query-response-solution` is emitted after `followup-query-bot` and after `common-question-solution`. Avoid appending the final full content a second time after accumulating chunks. Suggested questions are not streamed as answer chunks.

Extensions: `cancel-query` has no payload and aborts in-flight work; `reset-conversation` clears context only when idle. Disconnecting cancels active work. A failed/cancelled request still counts toward rate and daily request limits.

### Explicit compatibility decisions

- The workbook's apparent `aapiKey` spelling is preserved, but its value is masked.
- The workbook does not specify image encoding. This implementation requires a base64 data URL, not a remote URL, raw byte buffer or filesystem path. The frontend uses `FileReader.readAsDataURL`.
- The workbook does not define completion. Terminal success, request IDs, cancellation and status completion are additive extensions.
- Image MIME type and signature must match PNG/JPEG/WebP; decoded size must be at most 5 MB. Do not send SVG or image URLs. Invalid images are rejected before inference.
- The source workbook's second sheet is empty. The screenshot informs partner-key and shareable-link management; the later three-panel screenshot specifies the staged student flow implemented in the reference UI.

## Administrator API

Every administrator request requires `Authorization: Bearer ADMIN_TOKEN`. Never provide this token to a partner.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Read service/provider readiness and demo flag |
| POST | `/api/session` | Exchange partner bearer key for a one-hour session |
| GET | `/api/admin/partners` | List partner metadata and UTC-day usage, without secrets |
| POST | `/api/admin/partners` | Create partner and reveal key + URL once |
| POST | `/api/admin/partners/:id/rotate` | Replace key and invalidate existing access |
| DELETE | `/api/admin/partners/:id` | Revoke access; keep usage and audit history |

Creation body:

```json
{
  "name": "Infinity Learn",
  "dailyLimit": 1000,
  "rpm": 30,
  "origins": ["https://learn.example.com"]
}
```

Optional `expiresAt` is a future Unix timestamp in milliseconds. Origin strings must be exact HTTP(S) origins, without paths or trailing slash. The hosted application's globally configured origins are allowed for every partner. Admin mutations and session exchange use a 20-request/minute IP throttle. Socket connections/login attempts use a 40-attempt/minute IP throttle and inbound event traffic has a 120-event/minute/socket ceiling. These IP checks use the directly connected address; behind a proxy configure gateway IP throttling. The application intentionally does not blindly trust `X-Forwarded-For`.

Errors use HTTP 400 for invalid input, 401 for invalid credentials, 403 for disallowed origin, 404 for missing partner/endpoint, 413 for oversize JSON, and 429 for HTTP rate limits.
