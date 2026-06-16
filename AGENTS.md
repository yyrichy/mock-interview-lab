# AGENTS.md

## Project
ai-interviewer — a coding interview simulator.
Stack: Next.js, TypeScript, Tailwind, Monaco Editor, Vercel AI SDK 6, Judge0, OpenAI Whisper + TTS.

## Core principle (read this first)
**The model owns the conversation. The app owns the evidence.**

Normal chat (ChatGPT/Claude) is already better at running a flexible clarify → approach → code → follow-up → feedback conversation than any hand-built state machine. This app is worth building ONLY because it gives the model things chat cannot see: a real code editor, Judge0 execution against visible AND hidden tests, timing, voice think-aloud, solution snapshots, and feedback grounded in that evidence.

So: do not script the conversation. Do not gate the model behind a phase/tool-permission matrix. Give the model one strong system prompt plus live state (code, tests, transcript, elapsed time) and let it speak naturally. Use tools ONLY to read evidence and run tests.

## Architecture (target state)
- **One interviewer brain:** `POST /api/interviewer`. It handles every conversational turn — opening, clarifying, planning, coding guidance, follow-ups, nudges. There are no per-moment scripted endpoints.
- **Phase is app metadata, not a conversation handcuff.** `InterviewWorkspace` advances phase and sends the current phase to the model as context. The model does NOT call a tool to change phase.
- **Grounding tools only:** `read_current_code`, `read_recent_transcript`, `get_test_results`, `run_tests`. These let the model see evidence and execute. They never mutate conversational flow.
- **Final feedback** is a grounded generation over the collected evidence (transcript, snapshots, test history, timing). Implement it wherever is cleanest — either a dedicated route or a grounded path in `/api/interviewer`. It is the one genuinely evidence-heavy, non-conversational job.

## Hard rules
- Do NOT script conversational moments (opening, planningOpener, followUpOpener, forcedWrap, codingEscalationNudge, etc.). The model generates these from state.
- Do NOT gate tools by phase. Drop the `TOOL_PERMISSIONS` matrix and the control tools (`set_phase`, `start_follow_up_variant`, `generate_final_feedback` as a flow-driver).
- Do NOT touch `lib/judge0.ts` or `/api/judge0`, `/api/transcribe`, `/api/tts`. Execution and speech are working grounding/utility layers.
- Do NOT send `interviewerContext` or hidden test cases to the model as candidate-facing context. Hidden test input/expected is redacted before any tool return.
- Do NOT spawn parallel sub-agents — the steps here are sequentially dependent.
- Do NOT reintroduce Web Speech or local Whisper. Server-side hosted transcription only — currently OpenAI `gpt-4o-mini-transcribe` via `/api/transcribe`.
- Default interviewer model is **OpenAI GPT-5.4 Mini** (demo/hosted — the hosted demo is deployed with the builder's own OpenAI key so the interview "just works" for signups: no BYOK friction, no weak-caller failures). **Groq, Gemini, and Anthropic remain selectable via BYOK** for self-hosters — they are simply no longer the default. Because Groq (a selectable, weak structured tool-caller) must keep working, the architecture still leans on prompt+state, not tool orchestration — fewer tools, no control-flow tools, never a silent/tool-only turn — and the Groq defensive guards (`noToolInput`, force-text-on-tool-failure) stay in place as graceful degradation.
- No `any` types. Server-only secrets; BYOK via `x-provider-key` header, never logged or persisted.
- Never run `npm run build` during development. Use `npm run dev`.

## Commands
```bash
npm run dev      # start dev server
npm run lint     # ESLint — this is the gate for "done" on an autonomous run
```
No automated test suite. Final verification of the interview loop is MANUAL via `npm run dev`.

## Stop condition (for autonomous runs)
Stop when the refactor is code-complete AND `npm run lint` passes with zero errors. Then hand back with a summary of what changed and a smoke-test checklist. **Do NOT attempt to verify the interview by simulating a session yourself** — lint green is the ceiling of what an unattended run can prove. The human verifies behavior by running the app.
