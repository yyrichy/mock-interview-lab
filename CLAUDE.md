# CLAUDE.md

@AGENTS.md

---

## Commands

```bash
npm run dev      # start dev server — always use this, never npm run build
npm run lint     # run ESLint — the gate for "done"
```

No test suite. Validate behavior by running end-to-end with `npm run dev`.

---

## What this app is

A coding-interview cockpit. The model runs the interview conversation; the app
captures and serves objective evidence the model could not otherwise see:

- **Code execution** — Judge0 runs the candidate's Python against visible + hidden tests.
- **Hidden correctness** — hidden cases catch edge bugs the candidate (and chat) would miss.
- **Timing** — elapsed phase/round time, sent to the model as context.
- **Voice think-aloud** — Groq Whisper ambient + focused transcription.
- **Snapshots** — how the solution evolved over the coding phase.
- **Grounded feedback** — final assessment built from transcript + snapshots + test history + pace.

If a change does not make one of those evidence layers better, or does not make
the conversation more natural, it probably should not be made.

---

## Architecture

### One interviewer brain — `POST /api/interviewer`

Single route, single agent context. Handles every conversational turn for every
phase. Built on Vercel AI SDK 6 `streamText` with tool calling.

- System prompt + live state in, natural interviewer text out.
- The model decides, from state, when to clarify, ask for an approach, let the
  candidate code, probe follow-ups, or wrap up. These are NOT separate endpoints.
- Files: `lib/interviewer-prompt.ts` (system prompt + context assembly),
  `lib/interviewer-tools.ts` (grounding tools), `lib/interviewer-model.ts`.

There is **no** `/api/ai` scripted-moment route in the target state — it is
confirmed dead code (a dormant fallback the client no longer calls) and is
deleted. But its prompt CRAFT is harvested first: the useful interview wording
in `lib/ai.ts`'s scripted functions (`streamOpeningMessage`,
`streamPlanningPhaseOpener`, `streamFollowUpOpener`, `streamSliceFollowUpOpener`,
`streamForcedWrapOpener`, `streamCodingEscalationNudge`, `streamFollowUpClosing`)
is lifted into the per-phase system prompt before the file is removed. The model
then produces those moments naturally from state. `getFeedback`'s evidence
assembly is preserved on the single feedback path (see below).

### Phase is app metadata, not a handcuff

`SessionPhase` still exists and still drives the **UI** (editor lock before
coding, timers, which controls show). `InterviewWorkspace` owns phase and is the
only place it mutates. The current phase + elapsed time are passed to the model
as plain context so it knows roughly where the interview is — but the model does
NOT change phase, and tools are NOT filtered by phase.

Editor is locked during `clarifying`/`planning`, unlocked from `coding` onward,
and never re-locked.

### Grounding tools (`lib/interviewer-tools.ts`)

Only evidence/execution tools remain. No control tools, no phase gating.

| Tool | Purpose |
|---|---|
| `read_current_code` | Exact current editor contents — call before commenting on code |
| `read_recent_transcript` | Last N transcript lines, on demand |
| `get_test_results` | Last Judge0 run results (hidden case input/expected redacted) |
| `run_tests` | Execute via Judge0 (respects `TEST_RUNS_MAX` from `lib/interview-limits.ts`) |

Removed: `get_session_state` (fold the small bits the model needs — phase,
elapsed, test summary — directly into the context the route already builds),
`mark_topic_probed`, `set_phase`, `start_follow_up_variant`,
`generate_final_feedback` as a flow-driver. Drop `TOOL_PERMISSIONS`,
`isToolAllowed`, and the phase-keyed permission matrix from `lib/session-state.ts`.

### Final feedback

The one legitimately non-conversational, evidence-heavy job. Generate it over
the full transcript, snapshots, test-run history, final code, and pace. Put it
wherever is cleanest in the simplified shape — a small dedicated route OR a
clearly-separated grounded path inside `/api/interviewer`. Either way it is a
single grounded generation, not part of the turn-by-turn loop. It must use real
evidence (e.g. "solved baseline in 14 min, failed hidden empty-input twice,
went quiet during coding") — never generic praise.

### Context per turn

```
System prompt + question (candidate-facing only)   ~800 tokens   always
Active follow-up variant (durable task identity)   ~150 tokens   while a variant is live
FULL chat history, verbatim                        grows         always
Current code                                       ~300 tokens   coding/followUp
Phase + elapsed time + last test summary           ~150 tokens   always
Transcript                                         on demand     via tool
```

There is NO rolling summary and no summary model. An interview transcript is
small; the full history is sent verbatim every turn so the model's memory is
exact — lossy compression was erasing task identity (which variant is active).
Do not reintroduce summarization or history windowing.

### AI providers

Uniform adapters under `lib/providers/*`. Presets in `lib/ai-models.ts` (add
models there only). BYOK via `components/ByokDrawer.tsx` → localStorage →
`x-provider-key` header; server prefers header over env, never logs/persists.

- **Interviewer default:** OpenAI GPT-5.4 Mini (demo/hosted, on the builder's own key); Groq/Gemini/Anthropic selectable via BYOK. Because Groq remains a selectable weak structured tool-caller, keep tools minimal, never allow silent/tool-only turns, and keep `run_tests` repair robust. Interviewer turns are output-capped (`INTERVIEWER_MAX_OUTPUT_TOKENS`) to bound per-turn cost; the feedback path is uncapped.

### Speech — OpenAI (transcription + TTS)

Ambient (coding phase): `lib/groq-ambient.ts` + `useGroqAmbient` → 30s chunks →
`POST /api/transcribe`. Focused mic: `useFocusMicRecorder` → single blob →
`POST /api/transcribe`. Transcription proxies OpenAI `gpt-4o-mini-transcribe` on
`OPENAI_API_KEY` (or a prefix-validated BYOK OpenAI `x-provider-key`) — the
`groq-*` file/hook names are historical; there is no Groq in the speech path.
TTS (`/api/tts`) defaults to OpenAI `gpt-4o-mini-tts` on the same metered key,
or ElevenLabs when `ELEVENLABS_API_KEY` is set / `TTS_PROVIDER=elevenlabs`. Keep
`/api/transcribe` as-is; `/api/tts` is the one speech route with a provider
switch (the OpenAI⇄ElevenLabs contract: text in, audio/mpeg out).

### Code execution — do not touch

`POST /api/judge0` → `lib/judge0.ts` → Judge0 hosted API. Python only (lang 71).
`withRetry` (3 attempts, 800ms backoff). Working grounding layer — leave it alone.

### Persistence

`lib/interview-session-storage.ts` + `useInterviewSessionAutosave` persist the
full session to localStorage per question; cleared after feedback or Reset. Use
`usePersistedState` for new persisted UI state.

---

## Key conventions

- **No `any` types.**
- **Server-only secrets** — BYOK via `x-provider-key` only; never logged/persisted.
- **New AI logic** — `lib/interviewer-prompt.ts` or `lib/interviewer-tools.ts`. `lib/ai.ts` is being deleted, not extended.
- **Phase transitions** — only `InterviewWorkspace` mutates `phase`, and only for UI.
- **Hidden test data** — never send `interviewerContext` or hidden cases to the model; redact hidden input/expected in any tool return.
- **Streaming** — Vercel AI SDK data stream via the UI message stream. The legacy `AsyncGenerator<string>` plain-text streaming path goes away with `/api/ai`.

---

## Question bank

`data/questions.json` → `lib/questions.ts` (`getAllQuestions`, `getQuestionById`).
Each question has `candidateDescription` (shown to candidate) and
`interviewerContext` (server-only, for grading). Hidden test cases live on the
question and its follow-ups. The instrumentation is only as good as these — a
handful of questions with excellent hidden tests + pitfalls beats many shallow ones.
