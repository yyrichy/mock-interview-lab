# CLAUDE.md

@AGENTS.md

`AGENTS.md` (imported above) holds the working principles, the core principle,
the hard rules, and the stop condition. This file is the architecture map and
the conventions — *where things live*. Read `AGENTS.md` for how to behave; read
this for how the codebase is shaped.

---

## Commands

```bash
npm run dev      # start dev server — always use this, never npm run build
npm run lint     # run ESLint — the gate for "done"
```

No test suite. Validate behavior end-to-end with `npm run dev`.

---

## What this app is

A coding-interview cockpit. The model runs the conversation; the app captures
and serves objective evidence the model could not otherwise see:

- **Code execution** — Judge0 runs the candidate's Python against visible + hidden tests.
- **Hidden correctness** — hidden cases catch edge bugs the candidate (and chat) would miss.
- **Timing** — elapsed phase/round time, sent to the model as context.
- **Voice think-aloud** — OpenAI Whisper ambient + focused transcription.
- **Snapshots** — how the solution evolved over the coding phase.
- **Grounded feedback** — final assessment built from transcript + snapshots + test history + pace.

This is the concrete form of *Simplicity First*: if a change makes none of these
layers better and the conversation no more natural, it probably shouldn't be made.

---

## Architecture

### One interviewer brain — `POST /api/interviewer`

Single route, single agent context, every conversational turn for every phase.
Vercel AI SDK 6 `streamText` with tool calling. System prompt + live state in,
natural interviewer text out. The model decides from state when to clarify, ask
for an approach, let the candidate code, probe follow-ups, or wrap up — these are
not separate endpoints.

Files: `lib/interviewer-prompt.ts` (system prompt + context assembly),
`lib/interviewer-tools.ts` (grounding tools), `lib/interviewer-model.ts`,
`lib/interviewer-presets.ts`.

The old `/api/ai` scripted-moment route and `lib/ai.ts` are gone; their interview
wording was lifted into the per-phase system prompt, and the model now produces
those moments from state. Don't reintroduce a scripted path.

### Phase is app metadata, not a handcuff

`SessionPhase` drives the UI only (editor lock before coding, timers, which
controls show). `InterviewWorkspace` owns phase and is the only place it mutates.
Current phase + elapsed time go to the model as plain context; the model does NOT
change phase, and tools are NOT filtered by phase. Editor is locked during
`clarifying`/`planning`, unlocked from `coding` onward, never re-locked.

### Grounding tools (`lib/interviewer-tools.ts`)

Evidence/execution only. No control tools, no phase gating.

| Tool | Purpose |
|---|---|
| `read_current_code` | Exact current editor contents — call before commenting on code |
| `read_recent_transcript` | Last N transcript lines, on demand |
| `get_test_results` | Last Judge0 run (hidden case input/expected redacted) |
| `run_tests` | Execute via Judge0 (respects `TEST_RUNS_MAX` from `lib/interview-limits.ts`) |

### Final feedback — `POST /api/feedback`

The one legitimately non-conversational, evidence-heavy job. A single grounded
generation over the full transcript, snapshots, test-run history, final code, and
pace — not part of the turn-by-turn loop, uncapped in output. It must cite real
evidence ("solved baseline in 14 min, failed hidden empty-input twice, went quiet
during coding"), never generic praise.

### Context per turn

```
System prompt + question (candidate-facing only)   ~800 tokens   always
Active follow-up variant (durable task identity)   ~150 tokens   while a variant is live
FULL chat history, verbatim                        grows         always
Current code                                       ~300 tokens   coding/followUp
Phase + elapsed time + last test summary           ~150 tokens   always
Transcript                                         on demand     via tool
```

No rolling summary, no summary model. The transcript is small; full history goes
verbatim every turn so the model's memory is exact — lossy compression erased
task identity (which variant is active). Don't reintroduce summarization or
history windowing.

### AI providers

Uniform adapters under `lib/providers/*`. Presets in `lib/ai-models.ts` (add
models there only). BYOK via `components/ByokDrawer.tsx` → localStorage →
`x-provider-key` header; server prefers header over env, never logs/persists.
Interviewer default OpenAI GPT-5.4 Mini; Groq/Gemini/Anthropic via BYOK.
Interviewer turns are output-capped (`INTERVIEWER_MAX_OUTPUT_TOKENS`); the
feedback path is uncapped.

### Speech — OpenAI (transcription + TTS)

Ambient (coding phase): `lib/groq-ambient.ts` + `useGroqAmbient` → 30s chunks →
`POST /api/transcribe`. Focused mic: `useFocusMicRecorder` → single blob →
`/api/transcribe`. Transcription proxies OpenAI `gpt-4o-mini-transcribe` on
`OPENAI_API_KEY` (or a prefix-validated BYOK OpenAI `x-provider-key`) — the
`groq-*` file/hook names are historical; there is no Groq in the speech path.
TTS (`/api/tts`) defaults to OpenAI `gpt-4o-mini-tts`, or ElevenLabs when
`ELEVENLABS_API_KEY` is set / `TTS_PROVIDER=elevenlabs`. `/api/transcribe` is
fixed; `/api/tts` is the one speech route with a provider switch (text in,
audio/mpeg out).

### Code execution — do not touch

`POST /api/judge0` → `lib/judge0.ts` → Judge0 via RapidAPI. Python only (lang 71).
`withRetry` (3 attempts, 800ms backoff). Working grounding layer — leave it alone.

### Persistence

`lib/interview-session-storage.ts` + `useInterviewSessionAutosave` persist the
full session to localStorage per question; cleared after feedback or Reset. Use
`usePersistedState` for new persisted UI state.

---

## Key conventions

- **No `any` types.**
- **Server-only secrets** — BYOK via `x-provider-key` only; never logged/persisted.
- **New AI logic** → `lib/interviewer-prompt.ts` or `lib/interviewer-tools.ts`.
- **Phase transitions** → only `InterviewWorkspace` mutates `phase`, and only for UI.
- **Hidden test data** → never send `interviewerContext` or hidden cases to the model; redact hidden input/expected in any tool return.
- **Streaming** → Vercel AI SDK data stream via the UI message stream.

---

## Question bank

`data/questions.json` → `lib/questions.ts` (`getAllQuestions`, `getQuestionById`).
Each question has `candidateDescription` (shown to candidate) and
`interviewerContext` (server-only, for grading). Hidden test cases live on the
question and its follow-ups. The instrumentation is only as good as these — a
handful of questions with excellent hidden tests + pitfalls beats many shallow ones.
