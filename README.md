# Mock Coding

**[Try it live →](https://mockcoding.dev)**

[![Live demo](https://img.shields.io/badge/mockcoding.dev-emerald?style=for-the-badge)](https://mockcoding.dev)
[![Next.js](https://img.shields.io/badge/Next.js-16-000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

A coding interview simulator. You get a problem, talk through your approach out loud, write real code in a real editor, and an AI interviewer ("Alex") listens, pushes back, and writes a structured scorecard at the end grounded in what you actually did.

The point is everything a normal chat window can't do: a real editor, your code executed against **visible and hidden** test cases, voice think-aloud, code snapshots over time, and timing — all fed back into final feedback so it cites evidence instead of handing out generic praise.

Python-only execution. BYOK (bring your own API key) or server env keys. Built on Next.js + the Vercel AI SDK.

---

## What it does

A session moves through five phases. The interviewer drives the conversation; the app owns the phase (it controls the editor lock, timers, and which controls show).

1. **Clarifying** — editor locked. Alex presents the problem and answers clarifying questions.
2. **Planning** — editor still locked. You state an approach and its time/space complexity; Alex pushes on tradeoffs before letting you code.
3. **Coding** — editor unlocks. You write Python and run it against the visible examples. Ambient voice transcription runs in the background; code snapshots are captured periodically (in memory).
4. **Follow-up** — after you submit, Alex grades hidden edge cases and asks a capped number of focused questions about your specific solution; solving cleanly can escalate the problem into a harder variant.
5. **Feedback** — a written scorecard streams in, built from the transcript, snapshots, test history, and pacing.

The editor is locked during clarifying/planning, unlocks at coding, and never re-locks.

---

## The idea

**The model owns the conversation. The app owns the evidence.**

A normal chat is already good at running a flexible clarify → approach → code → follow-up conversation. This app is worth building only because it gives the model things chat can't see: a real editor, Judge0 execution against visible *and* hidden tests, timing, voice think-aloud, solution snapshots, and feedback grounded in that evidence. So the conversation isn't scripted — one strong system prompt plus live state, and tools that only read evidence and run code.

---

## Stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Editor | Monaco (`@monaco-editor/react`) |
| AI orchestration | Vercel AI SDK 6 (`streamText` + tool calling) |
| Interviewer / feedback models | Cohere North Mini Code (free) on OpenRouter; automatic recovery to Gemini 3.1 Flash-Lite on transient OpenRouter errors |
| Voice in | OpenAI `gpt-4o-mini-transcribe` by default or OpenRouter Whisper Large V3 Turbo when using an OpenRouter key — ambient 30s chunks during coding + push-to-talk mic |
| Voice out | OpenAI `gpt-4o-mini-tts` by default, ElevenLabs, or free OpenRouter Deepgram Flux TTS |
| Code execution | Judge0 — Python 3 only; public CE endpoint by default, override via `JUDGE0_API_URL` |
| Limits / analytics | Upstash Redis — rate limiting, signup capture, funnel/rating stats, BYOK "at capacity" gate (all optional, fail-open) |
| Question bank | `data/questions.demo.json` (local, gitignored) |
| Persistence | localStorage — full session restored on refresh; during local development, snapshots are also saved under `local-debug/interviews/` and interviewer diagnostics append to `local-debug/debug.jsonl` |

---

## Run it locally

```bash
git clone https://github.com/yyrichy/mock-interview-lab.git
cd mock-interview-lab
npm install
# copy .env.example → .env.local and add OPENROUTER_API_KEY + GEMINI_API_KEY
# copy data/questions.example.json → data/questions.demo.json and add your questions
npm run dev      # http://localhost:3000
```

**Question bank.** The app loads its questions from `data/questions.demo.json`
(gitignored — it's yours to fill in). Copy the tracked template
`data/questions.example.json` to `data/questions.demo.json` and replace the
placeholder with your own questions. The template documents the full schema:
`candidateDescription` is shown to the candidate, while `interviewerContext` and
every `hiddenTestCases` array are server-only grading data that never reach the
browser or get read aloud. A handful of questions with sharp hidden tests beats
many shallow ones.

The default interviewer and feedback model is **Cohere North Mini Code (free)** through OpenRouter. If OpenRouter returns a rate limit, server error, or network failure before producing a response, the app retries that turn with **Gemini 3.1 Flash-Lite** using `GEMINI_API_KEY`. Only that Gemini model is used for recovery; OpenAI, Anthropic, and Groq adapters remain in code but are not selectable in the interview UI. Add both keys to `.env.local` (or use the API Keys drawer for OpenRouter). OpenRouter speech uses Whisper at $0.000003 per second (about $0.011 per hour) and free Flux TTS.

```
OPENROUTER_API_KEY=...    # North Mini Code interviewer + Whisper STT + Flux TTS
GEMINI_API_KEY=...        # fallback interviewer + feedback; fixed model: gemini-3.1-flash-lite
OPENAI_API_KEY=...        # optional speech provider only
NEXT_PUBLIC_SITE_URL=...  # optional; canonical URL for OG tags (defaults to the mockcoding.dev)
GEMINI_API_KEY=...        # optional alternate interviewer model
GROQ_API_KEY=...          # optional alternate interviewer model
ANTHROPIC_API_KEY=...     # optional alternate interviewer model
ELEVENLABS_API_KEY=...    # optional alternate TTS engine
# JUDGE0_API_URL=...       # optional; defaults to the public Judge0 CE endpoint
# UPSTASH_REDIS_REST_URL / _TOKEN   # optional; enables limits + analytics
# BYOK_SESSION_THRESHOLD=...        # optional; session count before at-capacity gate
```

See `.env.example` for the full set (TTS engine selection, Judge0 auth headers incl. RapidAPI, the at-capacity override, and the stats token). Keys in `.env.local` are read server-side only by the API routes — never sent to the browser, logged, or persisted.

**BYOK.** The **API Keys** button in the chat panel opens a drawer where you paste per-provider keys. They're stored only in your browser's localStorage and forwarded to the server per request via the `x-provider-key` header (server prefers the header over env, and never logs or persists it). This lets you run without setting any env vars.

**Local debug archive.** When running `npm run dev`, full interview snapshots
are written to `local-debug/interviews/<questionId>-<startedAt>.json` (one file
per attempt, updated as the session changes). Interviewer and feedback request
metadata, tool/step diagnostics, generation timings, and errors append to
`local-debug/debug.jsonl`. The folder is git-ignored and is not written in
production. Interview snapshots include your chat, code, transcript, test
results, final feedback, and timing; treat them as private and delete
`local-debug/` when you no longer need them. The debug log records error
messages after API-key redaction but does not copy raw chat or transcript text.

---

## Project structure

```
app/
  page.tsx                      landing page
  questions/page.tsx            question browser
  interview/[questionId]/         interview session (page + loading)
  at-capacity/page.tsx            BYOK "at capacity" gate
  api/
    interviewer/route.ts        the single interviewer brain — every conversational turn
    feedback/route.ts             final grounded scorecard generation
    judge0/route.ts               Judge0 code-execution proxy
    transcribe/route.ts           OpenAI / OpenRouter transcription proxy
    tts/route.ts                  TTS proxy (OpenAI / OpenRouter / ElevenLabs)
    local-debug/session          development-only local session archive
    rating, signup, stats         funnel + analytics endpoints (Upstash-backed)

components/
  InterviewWorkspace.tsx        owns session state, phase transitions, timers (UI)
  ChatPanel.tsx                 conversation UI, model picker, voice controls, BYOK trigger
  Editor.tsx                    Monaco wrapper
  TestResultsPanel.tsx, ResizableTestResultsSection.tsx   run results
  FeedbackScreen.tsx, ScorecardWidget.tsx                 final feedback
  AssistantMessageBody.tsx      markdown rendering of Alex's messages
  ByokDrawer.tsx, ByokGate.tsx, AtCapacity.tsx            BYOK keys + capacity gate
  QuestionBrowser.tsx, ChatToggleButton.tsx, ErrorBoundary.tsx

lib/
  interviewer-prompt.ts         system prompt + per-turn context assembly
  interviewer-tools.ts          grounding tools (read code / transcript / tests, run tests)
  interviewer-model.ts          provider/model resolution for a turn
  feedback.ts                   evidence assembly + final feedback generation
  ai-models.ts, providers/*     model presets + per-provider adapters
  ai-client.ts, ai-errors.ts, resolve-provider-key.ts   client fetch, error mapping, server key resolution
  byok.ts, byok-mode.ts         BYOK storage + at-capacity mode
  judge0.ts                     code execution (batched submissions)
  speech.ts, groq-ambient.ts, coding-voice-report.ts    transcription helpers, ambient loop, think-aloud summary
  local-debug-archive.ts        git-ignored development snapshots + JSONL diagnostics
  session-state.ts, phase-config.ts, chat.ts            session types + phase budgets
  round-config.ts, interview-limits.ts, follow-up-config.ts,
  coding-escalation.ts, planning-coding-invite.ts       pacing, limits, follow-up + phase-transition helpers
  questions.ts                  question-bank loader
  interview-session-storage.ts, snapshots.ts            session persistence + code snapshots
  stats.ts                      Upstash-backed counters
  hooks/                        usePersistedState, useGroqAmbient, useFocusMicRecorder,
                                useCodeAutosave, useCodingShortcuts, useTickInterval,
                                useInterviewSessionAutosave

data/
  questions.demo.json           your local question bank (gitignored)
  questions.example.json        tracked schema template
public/
  og.png                        Open Graph preview image
```

---

## Docs

- [`docs/PROJECT-NOTES.md`](./docs/PROJECT-NOTES.md) — architecture and design in depth
- [`CLAUDE.md`](./CLAUDE.md), [`AGENTS.md`](./AGENTS.md) — conventions for AI coding assistants working in this repo

---

## Notes

- **Mock voice/fallback e2e:** install Chromium once with `npx playwright install chromium`, then run `npm run test:e2e`. The browser flow supplies a generated tone and mocks transcription/interviewer APIs; separate middleware checks simulate OpenRouter 429s and verify Gemini recovery without provider calls.
- **Real Whisper integration:** run `npm run test:e2e:whisper` with `OPENROUTER_API_KEY` in `.env.local`. It plays a short generated speech clip into the mock microphone and sends the resulting recording through the real OpenRouter Whisper endpoint; the interviewer stays mocked. It reports word error rate against the clip's known phrase and uses a small amount of API usage. The clip is synthesized speech, so it does not measure recognition of your own voice or room noise.
- **Live interview e2e:** run `npm run test:e2e:live` with `OPENROUTER_API_KEY` and `GEMINI_API_KEY` in `.env.local`. It uses default North Mini Code and Gemini 3.1 Flash-Lite recovery, then sends generated speech through real Whisper and verifies the interviewer responds using that transcript. It makes real provider calls. The speech is synthetic and the test cannot assess your own mic/audio quality. Free model latency and availability vary.
- **Python only.** Judge0 runs the candidate's Python (language 71) against visible and hidden cases; hidden inputs/expected values never reach the browser or the model.
