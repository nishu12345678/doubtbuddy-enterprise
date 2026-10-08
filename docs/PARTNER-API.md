# DoubtBuddy staged API — version 2

Local service: `http://localhost:3001`. Planned production origin: `https://socket.doubtbuddy.ai` (not deployed). Socket.IO namespace `/doubtBuddyLLM`, transport path `/socket.io/`, Engine.IO v4. Both polling and WebSocket work. The customer owns the frontend; `src/GuidedAnswer.jsx` and `src/MathMarkdown.jsx` are working reference components.

## Connect and ask

Install `socket.io-client` v4 in a JavaScript client. Register handlers before connecting:

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3001/doubtBuddyLLM', {
  path: '/socket.io/',
  transports: ['polling', 'websocket'],
  auth: { apiKey: partnerKey }, // Our issued key, never the OpenAI key
  autoConnect: false
});
let questionId;
socket.on('query-response-solution', result => {
  if (result.error) return showError(result.content);
  if (result.stage === 'understanding') questionId = result.questionId;
  renderResult(result); // Replace pending content; don't append the same stream twice
});
socket.on('connect_error', error => showError(error.message));
socket.on('login-success', () => {
  socket.emit('text-query', {
    textQuestion: 'Solve 7x + 3 = 38.',
    profile: { classLevel: 'Class 8', language: 'English' }
  });
});
socket.connect();
// Wire each button to one of these handlers, after understanding arrives:
const nextStep = () => socket.emit('next-step-query', { questionId });
const allSteps = () => socket.emit('all-steps-query', { questionId });
const finalAnswer = () => socket.emit('solution-query', { questionId });
```

`showError` and `renderResult` are customer frontend functions. For production browser clients, prefer exchanging the partner key from the customer's authenticated backend for a one-hour session; pass `auth: { token }`. See [authentication and admin endpoints](INTEGRATION.md). Never embed OpenAI credentials or the admin token in a frontend.

## Stages and response fields

All staged successes use this envelope:

```json
{
  "schemaVersion": 2,
  "error": false,
  "done": true,
  "requestId": "unique-response-uuid",
  "questionId": "original-understanding-uuid",
  "kind": "text",
  "stage": "understanding",
  "content": "Readable Markdown fallback",
  "data": {}
}
```

UUID placeholders above are illustrative; send the actual server-issued `questionId`.

| Client event | Result stage | `data` fields | Optional typed event |
| --- | --- | --- | --- |
| `text-query` / `image-query` | `understanding` | `title`, `question`, `content`, `canProceed`, `nextStepLabel`, `allStepsLabel`, `solutionLabel` | `query-understanding` |
| `next-step-query` | `step` | `title`, `step: {number,title,content}` or `null`, `totalSteps`, `hasMoreSteps` | `query-step-solution` |
| `all-steps-query` | `all-steps` | `title`, `steps: [{number,title,content}]`, `totalSteps`, `hasMoreSteps: false` | `query-all-steps-solution` |
| `solution-query` | `final-answer` | `title`, `finalAnswer`, `quickCheck` | `query-final-solution` |

Each typed event is also delivered through the preserved `query-response-solution` event with the same request ID. Subscribe to one result channel or deduplicate by `requestId`. Understanding also sends a single readable `query-update-solution` chunk for legacy consumers. Structured responses never stream raw JSON fragments. Follow-ups continue to stream Markdown chunks.

Render understanding as the first card. When `canProceed` is false, hide action buttons and let the student clarify with `followup-query`; a successful clarification returns a new understanding and question ID. Otherwise show the three localized button labels. The first action generates and caches a consistent solution plan on the server. Next-step reveals one step per request; all-steps reveals every step; final-answer reveals the result and check. No remaining plan is sent to the frontend early. All-steps advances the cursor to the end; next-step then returns `step: null`. The mathematical result may naturally occur in the last working step.

New questions replace the active flow. Question IDs only work on the socket that created them. Disable actions while a request is running. A follow-up invalidates the cached plan so corrections are reflected in later actions. Cached reveals do not consume additional AI quota; requests that invoke OpenAI do. Requests are not idempotent: repeating next-step advances the cursor, so do not automatically retry it after an ambiguous network failure. Reconnection currently starts a new conversation.

## Step follow-ups, images, and rendering

Place “Ask about this step” beside each rendered step heading. Use server fields directly rather than parsing the title:

```js
socket.emit('followup-query', {
  question: 'Why did you subtract 3?',
  step_number: String(step.number),
  step_title: step.title,
  answer_id: result.requestId
});
// General doubt: omit step metadata.
socket.emit('followup-query', { question: 'Explain that more simply.' });
```

History includes the original text/image, revealed solution, and follow-ups. After ten follow-ups, older turns are summarized while retaining original context and recent turns. The tutor focuses on the requested doubt and uses the current student's language, including localized display labels. Machine field names stay English. See [Tutor flows](TUTOR-FLOWS.md) for profiles and optional image extraction/review.

`image-query` accepts `{fileContent: "data:image/png;base64,...", fileName, textQuestion?, extractedText?, profile?}`. PNG/JPEG/WebP only, maximum 5 MB decoded. `image-extract` accepts the same image input and emits `image-extraction-result` plus the terminal event. Review/edit its text before submitting it with the original image.

Render Markdown with KaTeX or MathJax. JSON parsers already decode escaped backslashes; do not strip or double-unescape them. Support `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`. Reference rendering disables raw HTML and trusted LaTeX commands. The tutor uses plain LaTeX chemistry rather than requiring `\ce{}`. If customers choose to support `\ce{}`, install their renderer's mhchem extension. Render numbers and buttons in the student's language when providing frontend-owned UI text.

## Errors and the earlier HTTP 400

Send objects (recommended) or JSON-encoded event payloads; malformed JSON returns a structured application error without disconnecting an authenticated socket. Errors arrive on `query-response-solution` with `error: true`, `done: true`, `stage: "error"`, `content`, and `code`. Earlier validation failures may lack a request ID. Do not mark partial output as complete after an error.

The `/socket.io/` URL is an Engine.IO endpoint, not a REST endpoint accepting arbitrary question JSON. A copied polling `sid` belongs to an existing live session. Start a fresh handshake rather than reusing the old curl SID:

```sh
curl 'http://localhost:3001/socket.io/?EIO=4&transport=polling'
```

This returns a handshake beginning with `0` and a new SID. Use a Socket.IO-compatible client to handle framing, namespace login, heartbeats, and upgrades. Android must use an Engine.IO-v4-compatible Socket.IO client; plain OkHttp JSON calls alone do not implement the protocol. Local tests confirm fresh polling works and an unknown SID gives HTTP 400. This does not establish the cause of the old hosted service's failure. See [official connection troubleshooting](https://socket.io/docs/v4/troubleshooting-connection-issues/).
