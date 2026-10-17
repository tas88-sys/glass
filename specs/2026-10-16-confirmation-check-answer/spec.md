---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-16-confirmation-check-answer
  spec_name: confirmation-check-answer
  status: completed
  phase: done
  created: 2026-10-16
  updated: 2026-10-16

summary:
  goals:
    - {id: G1, description: "A turn that tells the candidate something and ends only checking they are following ('…, está bem?') gets one short sentence the candidate would say back, not a recap", priority: HIGH}
    - {id: G2, description: "The answer speaks as the candidate: never offers back what the interviewer offered", priority: HIGH}
  constraints:
    - {id: C1, description: "Every other turn's messages stay byte for byte (the career SC-005 tests)", type: TECHNICAL}
    - {id: C2, description: "No transcript text in this public repo: tests and examples are invented turns of the same shape", type: SECURITY}
  decisions:
    - {id: D1, decision: "A rule added to the instruction, not a gate: the turn still reaches the model, which decides between one line and a full answer", rationale: "The tag says nothing about the rest of the turn: 'Me explica a diferença entre processo e thread, ok?' is a real question. A gate would drop it; the rule says 'otherwise answer as above'"}
    - {id: D2, decision: "One line, not PASSIVE", rationale: "Offered to the owner that way after the session; an acknowledgment line is harmless and confirms the panel heard the turn"}
    - {id: D3, decision: "Detected on the tail only: a tag word after a comma or period, or alone, before the final '?'; a capitalized name after it is ignored", rationale: "The STT writes '…, está bem?' and '…está Ana?'. Requiring the separator keeps 'Qual é o caminho certo?' out"}
    - {id: D4, decision: "Not on the personal and ambiguous routes", rationale: "'Então você liderou a migração, certo?' checks the candidate's own work: it asks for a confirmation or a correction, with detail"}
---

# Confirmation check answer

## Problem

In a real session on 2026-10-16, two of the four live answers were for turns where the interviewer
explained something and closed with "…, está bem?":

- After the next steps of the process, the panel showed "Entendi, tudo claro." and three bullets
  restating what the interviewer had just said. The candidate said "perfeito".
- After "se precisar falar comigo é só mandar mensagem, está bem?", the panel showed "Sim, pode me
  contatar … a qualquer momento": the interviewer's offer, in the candidate's mouth.

Both passed the gate on the '?' and Jev's asks (0.63 and 0.69, above the veto: its instructions count
"a check that they should confirm" as asking). The instruction then asked for a headline and
supporting bullets.

## Functional requirements

- **FR-001 Detection.** `endsWithConfirmationCheck(text)` (`questionGate.js`) is true when the turn
  ends with a tag check before its final '?': está/tá (bem, bom, certo, ok, claro), ok, certo,
  beleza, combinado, pode ser, tudo bem/certo, entendeu, ficou claro, faz sentido, né, não é,
  correto, right, okay, sounds good, makes sense, got it. The tag stands after a comma or period, or
  alone; a capitalized name after it is ignored.
- **FR-002 Rule.** `makeLiveAnswer` adds `CONFIRMATION_CHECK_RULE` after the PASSIVE line when the
  asking turn (the record's turn, else the question) ends with a check and the route is neither
  personal nor ambiguous. The rule asks for one short sentence the candidate would say back if the
  turn tells something rather than asking about the candidate's experience or knowledge, and to
  speak as the candidate; otherwise to answer as usual.
- **FR-003 Unchanged elsewhere.** Without a check, the messages are the same bytes as before.

## Files

- `src/features/listen/summary/questionGate.js`: `endsWithConfirmationCheck`.
- `src/features/listen/summary/summaryService.js`: `CONFIRMATION_CHECK_RULE` and its use in
  `makeLiveAnswer`.
- Tests: `questionGate.test.js` (checks and non-checks), `liveAnswerCareer.test.js` (the rule on the
  general route and with career off, from the record's turn, not on personal or ambiguous, and
  unchanged bytes otherwise).

## Verification

- `npm test`: 1527/1527.
- The session replayed with `scripts/replay-career-session.js --router jev --answers-for armed`
  (Groq `openai/gpt-oss-120b`, the model that answered live), one run: the two check turns got
  "Perfeito, ficou claro." and "Perfeito, obrigado."; the two real questions kept their full
  answers.
