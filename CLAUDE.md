# CLAUDE.md

@AGENTS.md

`AGENTS.md` (imported above) holds the operating mode, judgment defaults, core
principle, hard rules, and stop condition. This file is the architecture map —
*where things live*. `PROJECT-NOTES.md` is the long-form design narrative;
`docs/CHANGES.md` is the changelog (dated entries, newest first — every job
adds one). If this map contradicts the source, the source is right; fix the map
in the same job.

---

## Commands

```bash
npm run dev      # start dev server — always this, never npm run build
npm run lint     # ESLint — the gate for "done"
npm run test:e2e        # browser test using mocked audio + AI endpoints
npm run test:e2e:whisper # opt-in integration against real Whisper
npm run test:e2e:live    # opt-in live interview using OpenRouter
```

The default e2e suite exercises push-to-talk with generated audio and mocked AI
APIs. `test:e2e:whisper` uses generated speech with the configured real Whisper
endpoint and mocks only the interviewer. Live model quality and real microphone
behavior still require a manual `npm run dev` session. `test:e2e:live` selects
Qwen through the app UI, then sends generated speech through real Whisper and
the live interviewer, with Alex voice enabled so the real TTS endpoint runs.

---

## What this app is

A coding-interview cockpit. The model runs the conversation; the app captures
and serves objective evidence the model could not otherwise see:

- **Code execution** — Judge0 runs the candidate's Python against visible + hidden tests.
- **Hidden correctness** — hidden cases catch edge bugs the candidate (and chat) would miss.
- **Timing** — elapsed phase/round time, sent to the model as context.
- **Voice think-aloud** — ambient + focused transcription during coding.
- **Snapshots** — how the solution evolved over the coding phase.
- **Grounded feedback** — final assessment built from transcript + snapshots + test history + pace.

This is the concrete form of *Simplicity first*: if a change makes none of these
layers better and the conversation no more natural, it probably shouldn't be made.

---

## Architecture

### One interviewer brain — `POST /api/interviewer`

Single route, single agent context, every conversational turn for every phase.
Vercel AI SDK 6 `streamText` with tool calling. System prompt + live state in,
natural interviewer text out. The model decides from state when to clarify, ask
for an approach, let the candidate code, probe follow-ups, or wrap up — these
are not separate endpoints.

Files: `lib/interviewer-prompt.ts` (system prompt + per-turn context assembly),
`lib/interviewer-tools.ts` (grounding tools), `lib/interviewer-model.ts`
(per-turn provider/model resolution), `lib/interviewer-presets.ts`. Turn
output is capped (`INTERVIEWER_MAX_OUTPUT_TOKENS`, `lib/interview-limits.ts`).
The route also carries the weak-caller guards: failure-streak force-text step
guard and an empty-reply plain-text fallback stream (tools disabled) so a turn
never ends with a blank bubble.

### Phase: UI metadata, advanced by inline tokens

Five phases (`lib/chat.ts`): `clarifying → planning → coding → followUp →
feedback`. Phase drives the UI only (editor lock, timers, which controls show).
`InterviewWorkspace` owns phase and is the only place it mutates. The model
never changes phase through a tool — it emits inline text tokens the client
strips and acts on:

- `[->planning]` — done clarifying, move to approach
- `[->coding]` — plan sufficient, unlock the editor
- `[segment-complete]` — a review / follow-up segment is finished, advance

Fallback: `lib/planning-coding-invite.ts` advances to coding if the model
verbally releases the candidate but forgets the token. Soft per-phase budgets
(`lib/phase-config.ts`: clarifying 5 min, planning 8 min, coding 35 min) inject
a one-time nudge when exceeded. Round length and forced-wrap thresholds:
`lib/interview-limits.ts` (60-min round) + `lib/round-config.ts` (forced verbal
wrap-up at 15 min remaining; follow-up floor 10 min, which wins ties). Editor
is locked during `clarifying`/`planning`, unlocked from `coding` onward, never
re-locked. The `followUp` phase has two segments: `slice` (mid-coding review)
and `final` (end-of-round Q&A).

### Grounding tools (`lib/interviewer-tools.ts`)

Evidence/execution only. No control tools, no phase gating.

| Tool | Purpose |
|---|---|
| `read_current_code` | Exact current editor contents — call before commenting on code |
| `read_recent_transcript` | Last N transcript lines, on demand |
| `get_test_results` | Last Judge0 run (hidden case input/expected redacted) |
| `run_tests` | Execute via Judge0 (respects `TEST_RUNS_MAX`) |

### Run vs Submit, and follow-up grading

Run (visible self-check) and Submit (visible + hidden grade) share one counter,
`TEST_RUNS_MAX` (10/session). Run is hard-blocked at the cap; Submit is NEVER
blocked — the candidate can always say "evaluate me" — it just still counts.
When a follow-up variant is active, Run/Submit send `followUpId` and
`resolveFollowUpTestSets` (`lib/questions.ts`) grades against the variant's own
`entryFunction`/`testCases`/`hiddenTestCases` when present, else the baseline's.
Active-variant identity is app-owned state (`ActiveFollowUp` in
`lib/session-state.ts`), set when a variant is scheduled and sent to the model
every turn while live.

### Final feedback — `POST /api/feedback`

The one legitimately non-conversational, evidence-heavy job. A single grounded
generation (`lib/feedback.ts`) over the full transcript, snapshots, test-run
history, final code, and pace — not part of the turn-by-turn loop, uncapped in
output. It must cite real evidence ("solved baseline in 14 min, failed hidden
empty-input twice, went quiet during coding"), never generic praise.
`lib/coding-voice-report.ts` counts think-aloud during coding and hard-caps the
communication score when it's negligible.

### Context per turn

```
System prompt + question (candidate-facing only)   always
Active follow-up variant (durable task identity)   while a variant is live
FULL chat history, verbatim                        always
Current code                                       coding/followUp
Phase + elapsed time + last test summary           always
Transcript                                         on demand, via tool
```

No rolling summary, no summary model. The transcript is small; full history
goes verbatim every turn so the model's memory is exact — lossy compression
erased task identity (which variant is active). Don't reintroduce
summarization or history windowing.

### AI providers

Uniform adapters under `lib/providers/*` (OpenAI, Groq, Gemini, Anthropic,
OpenRouter-compatible chat completions). Presets in `lib/ai-models.ts` (add
models there only); default is `openrouter-qwen3.8-27b-free`. BYOK via
`components/ByokDrawer.tsx` → localStorage →
`x-provider-key` header; server (`lib/resolve-provider-key.ts`) prefers header
over env, never logs/persists.

### Speech — OpenAI or OpenRouter (transcription + TTS)

Ambient (coding phase): `lib/groq-ambient.ts` + `useGroqAmbient` → ~30s chunks
→ `POST /api/transcribe`. Focused mic: `useFocusMicRecorder` → single blob →
same route. Transcription uses OpenRouter Whisper when a prefix-validated BYOK
OpenRouter key is sent, otherwise OpenAI `gpt-4o-mini-transcribe`. TTS similarly
selects OpenRouter Deepgram Flux (free) with an OpenRouter BYOK key, otherwise
OpenAI `gpt-4o-mini-tts` or ElevenLabs when configured. The endpoint contracts
remain audio-in/text-out and text-in/audio-out. The `groq-*` file/hook names are
historical; there is no Groq in the speech path.

### Local development archive

While running `npm run dev`, `useInterviewSessionAutosave` and session changes
write atomic per-attempt snapshots to
`local-debug/interviews/<questionId>-<startedAt>.json`. Interviewer and feedback
routes append request metadata, stream steps, tool diagnostics, generation
timings, and redacted errors to `local-debug/debug.jsonl`. The archive API route
is disabled outside development, and `/local-debug/` is git-ignored. Interview snapshots contain
candidate chat, code, transcript, test results, feedback, and timing; don't
share them without reviewing their contents.

### Code execution — do not touch

`POST /api/judge0` → `lib/judge0.ts`. Python only (lang 71). Provider-agnostic:
defaults to the public CE endpoint, overridden by `JUDGE0_API_URL` plus a
generic auth-header env pair (works with self-hosted, Sulu, or RapidAPI by
config alone). Visible and hidden cases run as two parallel batch submissions
with per-case fallback; transient failures retry with backoff. Working
grounding layer — leave it alone.

### Persistence

`lib/interview-session-storage.ts` + `useInterviewSessionAutosave` persist the
full session to localStorage per question (questionId is the session identity);
cleared after feedback or Reset. `lib/snapshots.ts` captures periodic
code+transcript snapshots for the feedback evidence. Use `usePersistedState`
for new persisted UI state.

### Ops layer (Upstash Redis, all fail-open)

Everything here degrades to "off" without Upstash env vars — an outage must
never block an interview.

- `middleware.ts` — per-IP sliding-window rate limits on the seven public API
  routes; applied at the middleware layer so the do-not-touch route files stay
  untouched.
- `/api/signup` (waitlist capture), `/api/rating` (feedback rating),
  `/api/stats` (token-gated funnel/rating counters, `lib/stats.ts`).
- **At-capacity gate** (`lib/byok-mode.ts` + `components/ByokGate.tsx`): flips
  on automatically on OpenAI `insufficient_quota` or past
  `BYOK_SESSION_THRESHOLD` starts (or manually via `BYOK_MODE`); new visitors
  route to `/at-capacity` to bring their own key or join the waitlist instead
  of spending the server key.

---

## Key conventions

- **No `any` types.**
- **Server-only secrets** — BYOK via `x-provider-key` only; never logged/persisted.
- **New AI logic** → `lib/interviewer-prompt.ts` or `lib/interviewer-tools.ts`.
- **Phase transitions** → only `InterviewWorkspace` mutates `phase`, only for UI, driven by the inline tokens above.
- **Hidden test data** → never send `interviewerContext` or hidden cases to the model; redact hidden input/expected in any tool return; browsers only ever get `PublicQuestion` (whitelist-built — a new sensitive `Question` field stays server-only unless explicitly added to `toPublicQuestion`).
- **Streaming** → Vercel AI SDK data stream via the UI message stream.
- **Session/limit constants** → `lib/interview-limits.ts`; per-round thresholds derive in `lib/round-config.ts` (no per-tier branching).

---

## Question bank

`data/questions.demo.json` is the bank that ships — it's what `lib/questions.ts`
imports (`getAllQuestions`, `getQuestionById`). `questions.json` and
`questions.example.json` in `data/` are not imported. Each question has
`candidateDescription` (shown to candidate), server-only `interviewerContext`,
an `entryFunction` Judge0 calls with unpacked test-input args, and hidden test
cases (with human-readable `description`s — those descriptions are the only
part the model may see). Follow-up variants may carry their own
`entryFunction`/`testCases`/`hiddenTestCases`; a variant whose contract differs
from the baseline's MUST set `entryFunction` and state the exact `def` line in
its prompt, or grading silently targets the baseline function. Pattern labels
come from the fixed taxonomy in `docs/question-bank-research.md`. The
instrumentation is only as good as these — a handful of questions with
excellent hidden tests + pitfalls beats many shallow ones.
