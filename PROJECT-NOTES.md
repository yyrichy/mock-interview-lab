# Mock Coding — Architecture & Design

A coding-interview simulator. The model runs the interview conversation; the app
captures and serves objective evidence the model could not otherwise see —
executed code, hidden-test results, timing, voice think-aloud, and solution
snapshots — and uses that evidence to write grounded final feedback.

---

## Core principle

**The model owns the conversation. The app owns the evidence.**

A general chat model is already better at running a flexible clarify → approach →
code → follow-up → feedback conversation than any hand-built state machine. This
app earns its keep by giving the model what chat cannot: a real editor, Judge0
execution against visible *and hidden* tests, timing, ambient voice transcription,
periodic code snapshots, and a final assessment grounded in all of it.

So the conversation is not scripted and the model is not gated behind a
phase/tool-permission matrix. The model gets one strong system prompt plus live
state (current code, last test results, phase, elapsed time) and speaks naturally.
Tools exist only to read evidence and run code.

---

## Session shape

A session has five phases. They drive the **UI** — which controls show, whether
the editor is locked, which timers run — and are passed to the model as context so
it knows roughly where things are.

| Phase | Editor | What happens |
|---|---|---|
| `clarifying` | locked | Alex presents the problem and answers clarifying questions. |
| `planning` | locked | The candidate states an approach + time/space complexity; Alex probes tradeoffs. |
| `coding` | unlocked | The candidate writes Python and runs it against visible examples. Ambient transcription + code snapshots run. |
| `followUp` | unlocked | After submit, hidden cases are graded; Alex asks focused questions; a clean solve can escalate into a harder variant. |
| `feedback` | unlocked | A written scorecard streams in, built from collected evidence. |

The editor is locked during `clarifying`/`planning`, unlocks at `coding`, and
never re-locks.

---

## The one interviewer brain — `POST /api/interviewer`

A single route and a single agent context handle **every** conversational turn for
**every** phase: opening, clarifying, planning guidance, coding nudges, follow-up
probing, wrap-up. It is built on the Vercel AI SDK `streamText` with tool calling.

- System prompt + live state in; natural interviewer text out.
- The model decides, from state, when to clarify, ask for an approach, let the
  candidate code, probe follow-ups, or wrap up. These are not separate endpoints.
- Key files: `lib/interviewer-prompt.ts` (system prompt + per-turn context
  assembly), `lib/interviewer-tools.ts` (grounding tools), `lib/interviewer-model.ts`
  (per-turn provider/model resolution).

Interviewer turns are output-capped to bound per-turn cost; the feedback path is
uncapped.

### Phase is app metadata, not a handcuff

`InterviewWorkspace` owns the phase and is the only place it mutates — and only for
the UI. The model never calls a tool to change phase, start a follow-up, or trigger
feedback. Instead, phase advances from lightweight inline tokens the model emits and
the client strips before display:

- `[->planning]` — the candidate is done clarifying; move to approach.
- `[->coding]` — the plan is sufficient (stated approach + stated complexity); unlock the editor.
- `[segment-complete]` — a correct solution's review/follow-up is finished; advance the interview.

Phase budgets live in `lib/phase-config.ts` (clarifying 5 min, planning 8 min,
coding 35 min) and inject a one-time nudge when exceeded. A fallback in
`lib/planning-coding-invite.ts` advances to coding if the model verbally releases
the candidate but forgets the `[->coding]` token.

### Grounding tools (`lib/interviewer-tools.ts`)

Read-only / execution only. No control tools, no phase gating.

| Tool | Purpose |
|---|---|
| `read_current_code` | Exact current editor contents — required before commenting on code. |
| `read_recent_transcript` | Last N transcript lines, on demand. |
| `get_test_results` | Last Judge0 run (hidden-case input/expected redacted). |
| `run_tests` | Execute via Judge0 (respects the per-session run cap). |

A tool call produces zero words to the candidate; the model calls a tool silently,
then speaks using the result as if it already knew. Every turn still ends with a
candidate-facing message — there are never silent, tool-only turns.

### Per-turn context

```
System prompt + candidate-facing question        always
Active follow-up variant identity                 while a variant is live
Full chat history, verbatim                        always (no summarization)
Current code                                       coding / follow-up
Phase + elapsed time + last test summary           always
Transcript                                         on demand, via tool
```

The full chat history is sent verbatim every turn. An interview transcript is
small, and exact memory matters more than token savings — lossy compression erased
task identity (which variant is currently active). There is no rolling summary and
no history windowing.

---

## Final feedback — `POST /api/feedback`

The one genuinely non-conversational, evidence-heavy job. A single grounded
generation over the full transcript, code snapshots, test-run history, final code,
and pacing (`lib/feedback.ts`). It must cite real evidence — e.g. "solved the
baseline in 14 minutes, failed the empty-input hidden case twice, went quiet during
coding" — never generic praise.

Communication scoring is calibrated by `lib/coding-voice-report.ts`: it counts
think-aloud utterances/words during the coding phase, and negligible think-aloud
hard-caps the communication score so silent coding cannot read as strong
communication.

---

## AI providers & models

Uniform per-provider adapters live under `lib/providers/*` (OpenAI, Groq, Gemini,
Anthropic). Model presets are defined in `lib/ai-models.ts`:

- **OpenRouter Qwen3.8 27B (free)** — default interviewer + feedback model.
- **OpenAI GPT-5.4 Mini**, **Groq Llama 3.3 70B**, **Gemini 2.5 Flash**, and
  **Claude Sonnet 4.6** — selectable in the chat panel's model picker (persisted
  to localStorage).

Because a selectable provider (Groq) can be a weak structured tool-caller, the
architecture leans on prompt + state rather than heavy tool orchestration: few
tools, no control-flow tools, never a silent/tool-only turn, and defensive guards
around tool-call failures so a weak caller degrades gracefully.

BYOK keys are pasted in the **API Keys** drawer (`components/ByokDrawer.tsx`),
stored in localStorage, and forwarded per request via the `x-provider-key` header.
The server (`lib/resolve-provider-key.ts`) prefers the header over env and never
logs or persists it.

---

## Voice

**Transcription (in).** `POST /api/transcribe` proxies OpenAI `gpt-4o-mini-transcribe`
on the server key (or a prefix-validated BYOK OpenAI key). Two capture modes during
coding: an ambient loop (`lib/groq-ambient.ts` + `useGroqAmbient`) that posts ~30s
chunks, and a push-to-talk focused mic (`useFocusMicRecorder`) that posts a single
blob. (The `groq-*` names are historical — there is no Groq in the speech path.)

**Text-to-speech (out).** `POST /api/tts` — one contract (text in, `audio/mpeg`
out) behind two engines: OpenAI `gpt-4o-mini-tts` (default, same metered key) or
ElevenLabs. Selection: the `TTS_PROVIDER` env override wins; otherwise ElevenLabs
is used when its key is set, else OpenAI.

---

## Code execution — Judge0

`POST /api/judge0` → `lib/judge0.ts` → a Judge0 instance. Python only (language 71).
It defaults to the public CE endpoint and is provider-agnostic via `JUDGE0_API_URL`
plus a generic auth-header hook, so it points at self-hosted, Sulu, or RapidAPI
("Judge0 CE") instances by config alone.

Each run executes the candidate's code against the question's test cases. Visible
and hidden cases run as two parallel **batch** submissions (`/submissions/batch`),
falling back to one-submission-per-case if an instance doesn't support batching.
Requests retry with backoff on transient failures.

Hidden-test inputs and expected values are server-only: they never reach the
browser, and they're redacted from any tool result returned to the model. Failed
hidden cases are surfaced to the model by their human-readable description only, so
it can probe the specific edge case without seeing the data.

---

## Persistence

`lib/interview-session-storage.ts` + `useInterviewSessionAutosave` persist the full
session (chat, code, transcript, timers, run state) to localStorage per question,
restored on refresh and cleared after final feedback or a reset. `lib/snapshots.ts`
captures code+transcript snapshots periodically (every ~15s, capped) and samples
them for the feedback evidence.

---

## Question bank

`data/questions.demo.json`, loaded via `lib/questions.ts`. Each question carries a
`candidateDescription` (shown to the candidate) and server-only grading context plus
hidden test cases (never sent to the model as candidate-facing context). Questions
can define follow-up variants with their own entry function and test sets, which the
follow-up flow grades against instead of the baseline. The instrumentation is only
as good as these — a handful of questions with excellent hidden tests and pitfalls
beats many shallow ones.

---

## Operational concerns

Upstash Redis (optional, fail-open) backs per-IP rate limiting, signup capture, the
funnel/rating stats (`lib/stats.ts`, readable via a token-gated `/api/stats`), and a
BYOK **"at capacity"** gate. When the gate trips — automatically on an OpenAI
`insufficient_quota` error or past a start-count threshold, or manually via
`BYOK_MODE` — new visitors are routed to `/at-capacity` to bring their own OpenAI
key or join a waitlist, rather than spending the server key. With Upstash unset,
everything fails open: no limiting, no analytics, BYOK gate off.

---

## Conventions

- No `any` types. Server-only secrets; BYOK via `x-provider-key`, never logged or persisted.
- New AI logic belongs in `lib/interviewer-prompt.ts` / `lib/interviewer-tools.ts`.
- Only `InterviewWorkspace` mutates phase, and only for the UI.
- Hidden test data is never sent to the model; hidden input/expected is redacted in any tool return.
- No automated test suite — `npm run lint` is the gate; the interview loop is verified by running `npm run dev`.
