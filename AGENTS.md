# AGENTS.md

Mock Coding — a coding-interview simulator.
Stack: Next.js · TypeScript · Tailwind · Monaco · Vercel AI SDK 6 · Judge0 · OpenAI (transcription + TTS).

This file is the behavioral contract and the source of truth for rules.
`CLAUDE.md` imports it and adds the architecture map — *where things live*.
`PROJECT-NOTES.md` is the long-form design doc; `docs/CHANGES.md` is the
changelog. When any doc disagrees with source, source wins — and correcting the
doc is part of whatever job discovered the drift.

## Operating mode: whole jobs, one pass

Take a request all the way to done in a single run. One job =

1. **Read the actual code first** — every file you're about to change plus the
   call sites that constrain it. The docs are a map, not the territory.
2. **Make the change** (judgment defaults below).
3. **Gate:** `npm run lint` → zero errors. There is no test suite; don't invent
   one, and don't run `npm run build` — behavior is verified by the human via
   `npm run dev`.
4. **Changelog:** add a dated entry at the TOP of `docs/CHANGES.md`, matching
   the existing entries' shape: what changed per file and why, ending with lint
   status and a smoke-test checklist.
5. **Hand back:** summary + smoke-test checklist + review queue. Never
   `git add` / `commit` / `push` — the user commits.

Do not stop mid-job to ask "should I proceed?", present options and wait, or
deliver half a job with questions attached. When something is unclear, triage
it:

- **Answerable from the repo** (how X works, whether Y is used, what the local
  convention is) → read the code. Never ask the user something grep can answer.
- **A judgment call with a reversible outcome** (naming, placement, which of
  two reasonable readings, how far a fix should reach) → decide using the
  judgment defaults, put the decision on the review queue, keep moving.
- **Stop and ask only when:** the correct-looking fix would break a hard rule
  below; the action is destructive or hard to reverse (deleting files,
  rewriting the question bank, anything touching git history); or doing the
  job as you understand it would silently be a *different* job than the one
  requested.

## The review queue

End every hand-back with a `**Review queue**` section: each call you made that
a reviewer might reasonably have made differently — the decision, the
alternative you rejected, one line on why. Also list what you noticed and
deliberately did NOT touch: pre-existing dead code, stale doc claims, suspected
bugs outside the request's scope. An empty queue is a claim that nothing in
the diff needs a second opinion — make that claim honestly.

Guessing silently and asking constantly are the two failure modes. The queue is
the third path: the work ships whole, and the doubts ship with it, visibly.

## Judgment defaults

- **Simplicity first.** Minimum code that solves the problem. No speculative
  features, abstractions, config surfaces, or error handling nobody asked for.
  If you wrote 200 lines and it could be 50, rewrite before handing back.
- **Surgical changes.** Touch only what the request requires. Match existing
  style even where you'd differ. Remove only what *your* change orphaned;
  pre-existing dead code goes on the review queue, not in the diff.
- **The project test.** A change earns its place only if it makes an *evidence
  layer* better (execution, hidden tests, timing, voice, snapshots, grounded
  feedback) or the *conversation* more natural. If it does neither, don't make
  it — say so in the hand-back instead.

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

## Hard rules

- Don't script conversational moments (opening, planning opener, follow-up
  opener, forced wrap, escalation nudge, …). The model generates them from
  state.
- Don't gate tools by phase or bring back control-flow tools (`set_phase`,
  `start_follow_up_variant`, a `TOOL_PERMISSIONS` matrix,
  `generate_final_feedback` as a flow-driver). These were removed — keep them
  gone. Phase advances via inline text tokens the model emits and the client
  strips (`[->planning]`, `[->coding]`, `[segment-complete]`) — transitions are
  text, never tools.
- Don't touch `lib/judge0.ts`, `/api/judge0`, `/api/transcribe`, `/api/tts`.
  Execution and speech are settled, working layers.
- Don't send `interviewerContext` or hidden test cases to the model. Redact
  hidden input/expected before any tool return. Client components only ever
  receive `PublicQuestion` (whitelist-built in `lib/questions.ts`) — never
  widen it back toward `Question` across the client boundary.
- Don't reintroduce Web Speech, local Whisper, history summarization, or
  windowing. Transcription is server-side hosted (OpenAI
  `gpt-4o-mini-transcribe`); full chat history is sent verbatim every turn.
- Don't spawn parallel sub-agents — the steps here are sequentially dependent.
- No `any` types. Server-only secrets; BYOK via `x-provider-key` header, never
  logged or persisted.
- Default interviewer model is **OpenAI GPT-5.4 Mini** (hosted demo on the
  builder's own key — zero BYOK friction for signups). Groq, Gemini, and
  Anthropic stay selectable via BYOK. Because Groq is a weak structured
  tool-caller, lean on prompt+state, not tool orchestration: few tools, no
  control-flow tools, never a silent/tool-only turn, and keep the weak-caller
  guards (`noToolInput`, the force-text-on-failure-streak step guard, the
  empty-reply fallback stream in `/api/interviewer`).

## Commands

```bash
npm run dev      # start dev server — the only way to run it
npm run lint     # ESLint — the gate for "done"
```

## Stop condition

Done = code-complete AND `npm run lint` passes with zero errors AND
`docs/CHANGES.md` has the entry. Hand back with the summary, smoke-test
checklist, and review queue — uncommitted. Do NOT simulate an interview to
"verify" conversational behavior — the human does that by running the app.

---

**These rules are working if:** diffs touch only what the request needed, jobs
land complete in one pass instead of stalling on confirmation, and the review
queue — not silent guesses, not a chat full of questions — is where the
uncertainty shows up.
