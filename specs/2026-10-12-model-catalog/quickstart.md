# Quickstart: Model Catalog

**Spec**: `2026-10-12-model-catalog`

## 1. Tests

```bash
npm test
node --test src/features/common/ai/__tests__/modelCatalog.test.js
node --test src/features/common/services/__tests__/modelStateService.catalog.test.js
```

## 2. Live probe of the catalog (Groq key in `.env`, reads the model list only)

```bash
node -e '
require("dotenv").config({quiet:true});
const c=require("./src/features/common/ai/modelCatalog");
(async()=>{
  c.configure({ fetchers: c.defaultFetchers() });
  await c.refresh("groq", process.env.GROQ_API_KEY, { force: true });
  for (const id of ["qwen/qwen3.8-27b","openai/gpt-oss-120b"]) console.log(id, JSON.stringify(c.capabilities("groq", id)));
  console.log("providerOf:", c.providerOf("openai/gpt-oss-120b"));
})();'
```

Expected: Qwen `vision: true, maxOutput: 16384`, gpt-oss `vision: false, maxOutput: 65536`, every `source` `api`, and `providerOf: groq`.

## 3. Live probe of the learned key limit (two refused Groq requests, no tokens)

Run an Ask-shaped request with a tiny image through `groq.createStreamingLLM({ …, visionOnly: true })` twice (the script is in research R6). Expected: the first logs `outcome=too-large … limit=1000`; the second logs `skip model=qwen/qwen3.8-27b reason=key-output-limit limit=1000 requested=16384` and makes no request.

## 4. In the app (`npm start`)

1. Settings → the Groq field holding `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`.
2. Under the field, "What each model can do" lists the five models:
   - Qwen: "sees images · max output 16,384 · reasoning";
   - gpt-oss: "text only · max output 65,536 · reasoning";
   - Gemini models: "sees images (default)", with their max output.
   - After the first Ask with a screenshot, Qwen shows "your key allows 1,000 output tokens/min — long answers go to the next model".
3. Replace Qwen with `qwen/qwen3.8-27b-typo` and save: the line warns "Groq has no model with this ID". Put the right ID back.
4. Edit on `gemini-3.5-flash-lite` → Sees images: No. The line shows "text only (override)". Refresh keeps it. Reset to automatic.
5. Ask with a screenshot (System Design): the log shows, on the first Ask, Qwen refused and Gemini answering with the image; on the next Ask, `skip model=qwen/qwen3.8-27b reason=key-output-limit` and Gemini answering, with no Groq request.
6. Optional, with a Claude model in a list: its line shows the API values (confirms the Anthropic shape live, research R3).
7. Log lines to look for: `[Model Catalog] refresh provider=groq models=N`, `[Model Catalog] loaded N models` on the next start.
