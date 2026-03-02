# ✅ Minimal Voice-Only Implementation Path (Reference)

> EN: This is an English handoff translation/annotation of `backend/语音对话精简实现路径.md`.  
> EN: It describes a **voice ↔ text** minimal implementation route, intentionally omitting vision/UI-heavy steps while keeping extension points for later.

---

## 0 ▸ Phase Map

| Phase | Output | Key work & checkpoints |
| --- | --- | --- |
| A. Environment ready | Local or Codespace runs; `.env` filled | API key, public port |
| B. O Server | Temporary JWT / Token service | 15 min TTL, CORS |
| C. Realtime connection | Frontend can record + play back in realtime | WebSocket or WebRTC |
| D. Event system | Filter deltas, dev log panel | `mitt` ↔ SDK events |
| E. Voice UX | Dual captions + voice hints | guardrails, cost tracking |

Notes:
- The core is voice/text only; vision interfaces (e.g. `agent.addImage()`) are not used here.

---

## 1 ▸ Preparation

1. **API Key**: Create one in OpenAI console (or use a relay/proxy key if needed).
2. **Repository**: Use your own project or a practice repo; Codespaces is convenient (public ports).
3. Minimal `.env` example:

```bash
OPENAI_API_KEY=sk-your-key
NEXT_PUBLIC_O_SERVER_URL=https://<your-codespace-3001>.github.dev

# Optional relay/proxy
OPENAI_API_BASE=https://api.gptsapi.net/v1
```

---

## 2 ▸ O Server (Issue short-lived tokens)

Goal: the frontend should **not** expose the long-lived main API key; it only receives a short-lived token.

- Route: `POST /token`
- Return: `{ token, expires_in }`

Pseudo-code (fastify):

```ts
app.post('/token', async (_, reply) => {
  const token = await openai.realtime.generateToken({ ttl: '15m' });
  reply.send({ token, expires_in: 900 });
});
```

Security:
- Local/dev can skip auth.
- Production should add signed headers, OAuth, or equivalent access control.

---

## 3 ▸ Frontend skeleton (Next.js + shadcn/ui)

### 3.1 Dependencies

```bash
pnpm add @openai/agents-sdk @openai/realtime
pnpm add mitt framer-motion
```

### 3.2 Core components

| File | Purpose |
| --- | --- |
| `lib/realtime.ts` | Fetch token and create connection |
| `components/CallButton.tsx` | Start/stop recording |
| `components/Transcript.tsx` | Live captions |
| `components/EventLog.tsx` | Filtered event panel |

---

## 4 ▸ Realtime connection & audio pipeline

```ts
const { token } = await fetch('/api/token').then(r => r.json());

const conn = new RealtimeConnection({
  authToken: token,
  // If using WS, the SDK typically picks ws://realtime.openai.com/stream internally
});

// Record
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
conn.sendAudio(stream);

// Playback
const audio = new Audio();
audio.srcObject = conn.audioStream;  // synthesized speech output from SDK
```

**WebSocket vs WebRTC**
- WS: quicker integration; SDK supports it out of the box.
- WebRTC: even lower latency; requires SDP/ICE, but SDK often provides wrappers.

---

## 5 ▸ Event system (recommended)

```ts
import mitt from 'mitt';
export const bus = mitt();

// Only keep important events
conn.on('server_message', evt => {
  if (evt.type.endsWith('_delta')) return;  // drop incremental deltas
  bus.emit('rt_event', evt);
});
```

- `EventLog` subscribes to `rt_event` and shows in dev mode.
- If logs are noisy, disable via `NEXT_PUBLIC_LOG_LEVEL=minimal`.

---

## 6 ▸ Agents SDK integration (optional)

```ts
const agent = new Agent({
  model: 'gpt-4o-audio-preview',
  guardrails,
  tools: [/* your functions */],
});

agent.on('transcript', t => bus.emit('subtitle', t));
agent.on('audio', chunk => conn.play(chunk));
```

Keep only voice-related hooks; vision events are not needed for voice-only.

---

## 7 ▸ UX & Guardrails

| Goal | Practice |
| --- | --- |
| Limit chit-chat / control cost | Track `usage.seconds`; after threshold show toast + voice reminder |
| Visible state | Top bar shows recording / stop / function calls |
| Accessibility | Put system tips into captions and also synthesize audio |
| Fallback strategy | On `error` event, TTS: “I didn't catch that, could you repeat?” |

---

## 8 ▸ Deployment

1. Dev/demo: Codespace public URL.
2. Production: host frontend + O Server on Vercel (store `OPENAI_API_KEY` as Secret).
3. Monitoring: log O Server with `pino` and ship to Logflare or similar.

---

## 9 ▸ Optional extensions

- Multi-language switch: `agent.setSystemPrompt()` dynamically inserts target-language instructions.
- Offline captions: IndexedDB + Service Worker.
- Vision later: add `<input type="file">` + `agent.addImage()` if needed.

---

## 🔒 Security reminders

- Never put keys in frontend code.
- Do not commit `.env` to Git.
- Rotate keys regularly.

