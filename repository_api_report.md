# Repository API Report

이 문서는 각 리포지토리 모듈의 공개 API 명세를 정리합니다. 모든 서비스 레이어는 여기에 명시된 함수 시그니처를 따라야 합니다. `uid`는 어댑터 레이어에서 자동으로 주입되므로 서비스 레이어에서 전달해서는 안 됩니다.

---

### Session Repository
**Path:** `src/common/repositories/session/`

- `getById(id: string)`
- `create(type: 'ask' | 'listen' = 'ask')`
- `getAllByUserId()`
- `updateTitle(id: string, title: string)`
- `deleteWithRelatedData(id:string)`
- `end(id: string)`
- `updateType(id: string, type: 'ask' | 'listen')`
- `touch(id: string)`
- `getOrCreateActive(requestedType: 'ask' | 'listen' = 'ask')`
- `endAllActiveSessions()`

---

### User Repository
**Path:** `src/common/repositories/user/`

- `findOrCreate(user: object)`
- `getById()`
- `saveApiKey(apiKey: string, provider: string)`
- `update(updateData: object)`
- `deleteById()`

---

### Preset Repository
**Path:** `src/common/repositories/preset/`

- `getPresets()`
- `getPresetTemplates()`
- `create(options: { title: string, prompt: string })`
- `update(id: string, options: { title: string, prompt: string })`
- `delete(id: string)`

---

### Ask Repository (AI Messages)
**Path:** `src/features/ask/repositories/`

- `addAiMessage(options: { sessionId: string, role: string, content: string, model?: string })`
- `getAllAiMessagesBySessionId(sessionId: string)`

---

### STT Repository (Transcripts)
**Path:** `src/features/listen/stt/repositories/`

- `addTranscript(options: { sessionId: string, speaker: string, text: string })`
- `getAllTranscriptsBySessionId(sessionId: string)`

---

### Summary Repository
**Path:** `src/features/listen/summary/repositories/`

- `saveSummary(options: { sessionId: string, tldr: string, text: string, bullet_json: string, action_json: string, model?: string })`
- `getSummaryBySessionId(sessionId: string)`

---

### Settings Repository (Presets)
**Path:** `src/features/settings/repositories/`
*(Note: This is largely a duplicate of the main Preset Repository and might be a candidate for future refactoring.)*

- `getPresets()`
- `getPresetTemplates()`
- `createPreset(options: { title: string, prompt: string })`
- `updatePreset(id: string, options: { title: string, prompt: string })`
- `deletePreset(id: string)` 