# AGENTS.md

Mock Coding — a coding-interview simulator.
Stack: Next.js · TypeScript · Tailwind · Monaco · Vercel AI SDK 6 · Judge0 · OpenAI (Whisper + TTS).

This file is the behavioral contract and the source of truth for rules. It is
runtime-agnostic; `CLAUDE.md` imports it and adds the architecture map plus
Claude-Code specifics. When the two could drift: rules live here, "where things
live" lives in `CLAUDE.md`.

## How to work (read this first)

Four checks, before and during every change. They bias toward caution over
speed — for trivial edits, use judgment.

**1. Think before coding.** Don't assume. Don't hide confusion. Surface tradeoffs.
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, name them — don't pick one silently.
- If a simpler approach exists, say so. Push back when warranted.

**2. Simplicity first.** Minimum code that solves the problem. Nothing speculative.
- No feature, abstraction, config surface, or error-handling for cases nobody asked for.
- If you wrote 200 lines and it could be 50, rewrite it.
- "Would a senior engineer call this overcomplicated?" If yes, simplify.
- Project-specific test: a change earns its place only if it makes an *evidence
  layer* better (execution, hidden tests, timing, voice, snapshots, grounded
  feedback) or the *conversation* more natural. If it does neither, don't make it.

**3. Surgical changes.** Touch only what the request requires.
- Don't "improve" adjacent code, comments, or formatting. Match existing style even if you'd do it differently.
- Remove imports/vars/functions *your* change orphaned; leave pre-existing dead code alone (mention it, don't delete it).
- Every changed line should trace directly to the request.

**4. Goal-driven execution.** Turn the task into a verifiable goal, then loop until it's met.
- There is no automated test suite. The gate is `npm run lint` (zero errors) plus a manual run via `npm run dev`.
- Don't claim done on conversational behavior you can't prove unattended — lint
  green is the ceiling of an autonomous run; the human verifies the interview by
  running the app.

## Core principle: the model owns the conversation; the app owns the evidence

Normal chat already runs a flexible clarify → approach → code → follow-up →
feedback conversation better than any hand-built state machine. This app is
worth building ONLY because it gives the model what chat cannot see: a real
editor, Judge0 execution against visible AND hidden tests, timing, voice
think-aloud, solution snapshots, and feedback grounded in all of it.

So: don't script the conversation. Don't gate the model behind a
phase/permission matrix. Give it one strong system prompt plus live state (code,
tests, transcript, elapsed time) and let it speak. Tools exist ONLY to read
evidence and run tests.

## Architecture (one paragraph; full map in CLAUDE.md)

One interviewer brain — `POST /api/interviewer` — handles every conversational
turn. Phase is app metadata that drives the UI only; `InterviewWorkspace` owns
it and passes it to the model as context. Grounding tools read evidence and run
tests, nothing more. Final feedback is a separate grounded generation at
`POST /api/feedback`. Speech and code execution are settled utility layers.

## Hard rules

- Don't script conversational moments (opening, planningOpener, followUpOpener, forcedWrap, codingEscalationNudge, …). The model generates them from state.
- Don't gate tools by phase or bring back control-flow tools (`set_phase`, `start_follow_up_variant`, a `TOOL_PERMISSIONS` matrix, `generate_final_feedback` as a flow-driver). These were removed — keep them gone.
- Don't touch `lib/judge0.ts`, `/api/judge0`, `/api/transcribe`, `/api/tts`. Execution and speech are working layers.
- Don't send `interviewerContext` or hidden test cases to the model. Redact hidden input/expected before any tool return.
- Don't reintroduce Web Speech, local Whisper, history summarization, or windowing. Transcription is server-side hosted (OpenAI `gpt-4o-mini-transcribe`); full chat history is sent verbatim every turn.
- Don't spawn parallel sub-agents — the steps here are sequentially dependent.
- Don't run `npm run build` during development. Use `npm run dev`.
- No `any` types. Server-only secrets; BYOK via `x-provider-key` header, never logged or persisted.
- Default interviewer model is **OpenAI GPT-5.4 Mini** (hosted demo on the builder's own key — zero BYOK friction for signups). Groq, Gemini, and Anthropic stay selectable via BYOK. Because Groq is a weak structured tool-caller, lean on prompt+state, not tool orchestration: few tools, no control-flow tools, never a silent/tool-only turn, and keep the Groq guards (`noToolInput`, force-text-on-tool-failure).

## Commands

```bash
npm run dev      # start dev server — the only way to run it
npm run lint     # ESLint — the gate for "done"
```

## Stop condition (autonomous runs)

Done = code-complete AND `npm run lint` passes with zero errors. Then hand back
with a summary of what changed and a smoke-test checklist. Do NOT simulate an
interview to "verify" — the human does that by running the app.

---

**These rules are working if:** diffs touch only what the request needed, fewer
rewrites from overcomplication, and clarifying questions come before the work
rather than after a wrong guess.
