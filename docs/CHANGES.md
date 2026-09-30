# Changes

## 2026-09-30 — Add North Mini primary with Gemini recovery

- `lib/ai-models.ts`: replace Qwen with OpenRouter `cohere/north-mini-code:free`
  and fix recovery to `gemini-3.1-flash-lite`.
- `lib/openrouter-fallback.ts` and `lib/interviewer-model.ts`: retry transient
  OpenRouter failures on Gemini before any text/tool output has been sent.
- `lib/feedback.ts`, `/api/interviewer`, and `/api/feedback`: apply the same
  no-duplicate-output recovery behavior to interviewer turns and final feedback;
  log which provider/model recovered the request without logging credentials.
- Hide other provider choices in the interview UI while leaving their adapters
  in the code. Ignore older saved model choices so this user's existing browser
  starts on the North → Gemini path.
- Updated `.env.example`, README, CLAUDE, AGENTS, and project notes to describe
  both required keys and the fixed Gemini fallback model.
- Verification: `npm run lint`, `tsc --noEmit`, mock browser e2e, and both
  simulated 429/no-replay fallback checks passed. A live North/Whisper/TTS
  conversation passed; the Gemini key also answered `OK` using the exact
  `gemini-3.1-flash-lite` model. The full app did not hit a live North failure
  during that run, so Gemini recovery was simulated at the model middleware.
- Smoke checklist: start a fresh interview with both keys configured; verify it
  starts on North and still opens/responds if the OpenRouter free model returns
  a transient failure.

## 2026-09-30 — Make Qwen the default interviewer model

- `lib/ai-models.ts`: use OpenRouter Qwen3.8 27B (free) as the default model
  for new interviews and feedback, matching the local development setup.
- `e2e/live-conversation.spec.ts`: start directly with the default model and
  assert both the opening and candidate-response turns use Qwen; no model
  selection or session reset is needed.
- Updated setup documentation and `.env.example` to identify OpenRouter as the
  default interviewer key and OpenAI as an optional alternative.
- Added an assertion to the deterministic browser flow that its first request
  uses the Qwen default.
- Verification: `npm run lint` passed. The live e2e reached Qwen without a
  picker/reset, but OpenRouter returned HTTP 429 from its shared free upstream
  pool, so the full live conversation could not be verified on this run.
- Smoke checklist: with `OPENROUTER_API_KEY` configured, open a fresh interview
  and confirm Qwen greets the candidate without changing Advanced settings.

## 2026-09-30 — Add live mock-interview e2e flow

- Added Playwright and `npm run test:e2e` with a browser test that generates a
  tone as mock microphone input, then verifies upload, mocked transcript display,
  phase progression, and a follow-up interviewer turn without provider calls.
- Added `npm run test:e2e:whisper` and a generated speech fixture to check the
  browser recording path against the real OpenRouter Whisper endpoint. It reports
  word error rate and mocks the interviewer to avoid a model call.
- Added `npm run test:e2e:live`, which selects Qwen through the UI, resets into
  a fresh session, gets a live opening with voice, submits generated speech via
  push-to-talk and real Whisper, then verifies the live interviewer reply
  includes the recognized candidate turn.
- Updated README and agent notes with all three test commands and coverage limits.
- Verification: `npm run test:e2e`, `npm run test:e2e:whisper`, and
  `npm run test:e2e:live` passed; `npm run lint` passed.
- Smoke checklist: run `npm run dev`, allow real mic access, hold and release
  the push-to-talk button, and confirm a real transcript appears in chat.

## 2026-09-29 — Replace free Laguna interviewer with Qwen3.8 27B

- `lib/ai-models.ts`: replace the OpenRouter Laguna S 2.1 preset with Qwen3.8
  27B (free), which supports the app's function tools and currently reports
  lower median latency. The picker warns users to avoid sensitive data because
  free endpoint data handling can vary.
- `README.md` and `.env.example`: document the new free interviewer and its
  privacy/availability caveat.
- Verification: `npm run lint` passed. No provider call or interview simulation
  was run; live behavior should be checked by the human through `npm run dev`.
- Smoke checklist: set an OpenRouter key, select Qwen3.8 27B in Advanced, start
  an interview, confirm it can reply and use code/test tools, then check that
  free endpoint throttling or latency is acceptable.

## 2026-09-29 — Local interview archive and debug log

- Added development-only `/api/local-debug/session` and server-side archive
  helpers. Per-attempt session snapshots are atomically written to
  `local-debug/interviews/<questionId>-<startedAt>.json`; the folder is
  git-ignored.
- `components/InterviewWorkspace.tsx`,
  `lib/interview-session-storage.ts`, and
  `lib/hooks/useInterviewSessionAutosave.ts`: archive chat, code, transcript,
  test state, final feedback, editor edits, and periodic checkpoints without
  delaying the interview.
- `app/api/interviewer/route.ts` and `app/api/feedback/route.ts`: append request,
  step, tool rejection, generation timing, empty-reply, and provider error
  diagnostics to `local-debug/debug.jsonl`; error strings redact common API key
  formats. Raw conversation text stays in the interview snapshot.
- Updated README and architecture notes with file locations and data contents.
- Verification: `npm run lint`, `npx tsc --noEmit`, and `git diff --check`
  passed. No automated test suite exists.
- Smoke checklist: run locally, start an interview, chat and edit code, then
  confirm the per-question JSON snapshot and JSONL debug log update. Confirm the
  folder does not appear in `git status`.

## 2026-09-29 — Turn-based voice interruption and interviewer pacing

- `components/ChatPanel.tsx`: a focused-mic press now stops Alex's current or
  pending audio before recording, giving the candidate a simple turn-taking
  interruption control without a Live API session.
- `lib/interviewer-prompt.ts`: clarified that Alex must stop after asking a
  question, wait for the candidate's answer, and pause after answering a
  clarification instead of jumping into the approach discussion.
- Verification: `npm run lint` passed. No automated test suite exists.
- Smoke checklist: enable Alex voice, wait for a spoken reply, hold the mic to
  stop playback and dictate; confirm transcription and the next interviewer
  response work. During clarification, confirm Alex answers and waits before
  moving into approach discussion.

## 2026-09-29 — OpenRouter interview and speech providers

- Added OpenRouter BYOK validation, model selection, and interviewer/feedback
  routing. Restored the tested Laguna S 2.1 free interviewer at the user's
  request, with a visible notice that the provider may use prompts and outputs
  for training. Removed Inkling presets because OpenRouter rejects direct app
  integration; other free models tested were unavailable or failed to return
  usable output.
- Routed speech uploads to OpenRouter Whisper when an OpenRouter key is
  selected, keeping OpenAI as the fallback.
- Added OpenRouter Deepgram Flux TTS, selected automatically with an OpenRouter
  BYOK key; retained OpenAI and ElevenLabs paths.
- Updated setup and architecture docs to describe the provider choices.
- Verification: lint, `tsc --noEmit`, and `git diff --check` passed. API smoke
  confirmed Laguna interviewer text + `read_current_code` and `run_tests` tool
  use, passing visible/hidden Two Sum cases. Separate OpenRouter smoke checks
  confirmed feedback generation, TTS audio, and correct STT.
  Browser UI smoke remains for the human; Chrome control was unavailable here.
- Smoke checklist: add an OpenRouter key in API Keys for speech; select a
  coding interviewer, start an interview, speak through the focused mic,
  check transcript text, hear an interviewer reply, and confirm final feedback
  loads.
