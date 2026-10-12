# Edge Cases: Model Catalog

**Spec**: `2026-10-12-model-catalog`. "Test" names the file that covers the case (`modelCatalog` = `ai/__tests__/modelCatalog.test.js`, `state` = `services/__tests__/modelStateService.catalog.test.js`).

## Resolution

| ID | Case | Expected | Test |
|---|---|---|---|
| E1 | Nothing known about a model | Provider default: Groq no images; Gemini, Anthropic images; max output and reasoning null (`source` `default` / `unknown`) | modelCatalog |
| E2 | The API reported a value | It wins over the default (`source: api`) | modelCatalog |
| E3 | An override is set | It wins over the API; null goes back to automatic | modelCatalog, state |
| E4 | A bad override (unknown field, non-boolean, maxOutput ≤ 0, provider without a catalog) | Rejected with a message; nothing stored | modelCatalog, state |
| E5 | A refresh after an override | The override is kept, in memory and in the table | modelCatalog |
| E6 | Gemini model | `vision: null` from the API, so the default (images) applies | gemini |

## Lists and lookups

| ID | Case | Expected | Test |
|---|---|---|---|
| E7 | Two refreshes within 24 h | One read; `force` or 24 h later reads again | modelCatalog |
| E8 | Two refreshes at once | One read | modelCatalog |
| E9 | A refresh fails | What is known is kept; a log line | modelCatalog |
| E10 | A model leaves the list | It becomes unknown and is looked up alone next time | modelCatalog |
| E11 | An alias the list does not name | `getModel` finds it; it is listed under the alias | modelCatalog, anthropicRequest, gemini |
| E12 | An ID the provider does not have | Recorded as missing; not looked up again within 24 h; Settings warns | modelCatalog, state |
| E13 | `ensureKnown` slower than its timeout | The caller goes on after 2 s; the lookup finishes in the background | modelCatalog |
| E14 | No fetchers (tests, before startup) | Nothing is fetched | modelCatalog |
| E15 | Anthropic retired model / Groq inactive model / Gemini embedding model | Left out of the list | anthropicRequest, groqRequest, gemini |
| E16 | Gemini key | In the `x-goog-api-key` header, never in the URL | gemini |

## Provider of an ID

| ID | Case | Expected | Test |
|---|---|---|---|
| E17 | Only one provider lists the ID, whatever its shape (`allam-2-7b`) | That provider | factory, state |
| E18 | Several providers list it | The context (Settings field or current run); else the first | modelCatalog, factory |
| E19 | No provider lists it | The prefix, logged once per ID | factory |

## Providers

| ID | Case | Expected | Test |
|---|---|---|---|
| E20 | A new Groq model reported as seeing images | It gets the screenshot; no code change | groqRequest, providerChain |
| E21 | Groq catalog says `reasoning: false` | No reasoning field | groqRequest |
| E22 | Groq 429 OTPM | The limit is stored for the model | groq |
| E23 | Next request with a cap over the learned limit | The model is skipped with no call; none left: `KEY_OUTPUT_LIMIT` | groq |
| E24 | Cap under the limit (Live Answer 900) | The model runs | groq |
| E25 | Learned limit older than 24 h, or a new key | Ignored / cleared; the model is tried | groq, modelCatalog, state |
| E26 | Anthropic model with no effort levels, or unknown | No effort; the floor applies when it thinks or is unknown | anthropicRequest |
| E27 | Anthropic cap over the model's `max_tokens` | Capped | anthropicRequest |
| E28 | Anthropic 400 on the beta, resend accepted | The model is marked; the beta is not sent to it again; other models still get it | anthropic |
| E29 | Anthropic 400 on the beta, resend fails too | The resend's error; nothing recorded | anthropic |
| E30 | `visionOnly` and no model of the provider sees images (Anthropic, Gemini, Groq) | `NO_VISION_MODEL` before any call | anthropic, gemini, groq |
