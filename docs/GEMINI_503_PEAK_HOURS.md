# Gemini 503s: when do they happen?

Study from 2026-10-06. It asks whether there are hours of the day, in Brasília time, when the Gemini API is more likely to return `503 Service Unavailable` ("This model is currently experiencing high demand") or to stall before the first chunk.

## Short answer

Google publishes no peak-hour figures. Public reports point most consistently to **13:00–19:00 in Brasília**, when US business hours overlap with the end of the European day. Outside that window the reports contradict each other, so no daytime window is reliably safe.

Two facts matter more than the hour:

- **Free-tier requests are dropped first.** The [AI Studio status page](https://aistudio.google.com/status) says free-tier requests use *sheddable* capacity, while billed-tier requests are protected by *critical* priority. When capacity runs short, free-tier requests are rejected first.
- **The newest Flash models fail at any hour on the free tier.** On this project's AI Studio usage dashboard (free tier, 7 days to 2026-10-06), every request to `gemini-3.5/3.6/3.7/3.8-flash` returned 503, at all hours. Only `gemini-3-flash-preview`, `gemini-3.1-flash-lite` and `gemini-3.5-flash-lite` answered.

Brazil's own traffic barely matters. The Gemini API serves every region from shared capacity, so load is driven by global demand, mostly the US, Europe and Asia.

## Reported windows

All times are converted to Brasília time (BRT, UTC-3, no daylight saving time since 2019). US Pacific time is UTC-7 until 2026-11-01.

| Source | Reported window | In BRT | Reliability |
|---|---|---|---|
| [Google AI Developers Forum, 2026-09-25](https://discuss.ai.google.dev/t/issue-report-severe-slowdowns-and-frequent-503-errors-on-gemini-flash-3-8-during-specific-hours-are-server-resources-being-intentionally-throttled/184984), `gemini-3.8-flash` | 503s and slowdowns every day, 16:00–22:00 UTC | **13:00–19:00** | Good. A Google staff reply (2026-09-29) blamed "high concurrent traffic spikes" during "peak hours" but gave no hours. |
| [Google AI Developers Forum, 2026-01-21](https://discuss.ai.google.dev/t/frequent-503-errors-service-unavailable-across-all-models/116450), several models incl. `gemini-3-flash-preview` | Worst 12:00–16:00 Madrid (CET, UTC+1) | **08:00–12:00** | Medium. One user's observation, which they linked to the US East Coast starting its day. No Google reply. |
| API-reseller blogs ([Apiyi](https://help.apiyi.com/en/gemini-api-high-demand-503-error-solution-guide-en.html), [AIFreeAPI](https://www.aifreeapi.com/en/posts/gemini-3-pro-image-503-overloaded)) | Peak 09:00–17:00 PT; off-peak 02:00–07:00 PT | Peak **13:00–21:00**; off-peak 06:00–11:00 | Weak. Their figures ("~45 % failures at peak, < 5 % off-peak") are about Gemini 3 Pro Image, and the source data isn't shown. |

The windows overlap in the afternoon in BRT. For late morning in BRT the sources disagree: one calls it the worst window and another calls it off-peak.

## Observations from this app (2026-10-06)

The app's per-attempt logs (`[Gemini Provider] attempt …`) recorded these failures:

- **10:31 and 10:33 BRT:** two `gemini-3.5-flash-lite` requests stalled about 96 s before their first chunk. There was no 503.
- **11:42 BRT:**
  - `gemini-3.5-flash-lite` hit the 25 s first-chunk timeout;
  - `gemini-3.1-flash-lite` and `gemini-3-flash-preview` returned 503 "high demand" within 3 s.

  The same models answered normally 2 minutes later.

These all happened in late morning BRT, outside the most-reported window. This supports the conclusion that no daytime window is reliably safe on the free tier. It is one day of data.

The AI Studio usage dashboard only shows daily totals, and the Cloud Console metrics charts could not be read through browser automation. So this study has no per-hour data for the project.

## Recommendations

- **Expect more 503s and slowdowns between 13:00 and 19:00 BRT.** Keep the models that actually answer at the front of the failover list. See the recommended lists in [`specs/2026-05-26-gemini-failover-design/prompt.md`](../specs/2026-05-26-gemini-failover-design/prompt.md).
- **Rely on the app's mitigations:**
  - the first-chunk timeout (25 s for Flash-Lite, 60 s for other models);
  - failover across the list;
  - the automatic second round for quick 5xx failures.

  [`ARCHITECTURE.md` §10](../ARCHITECTURE.md#10-gemini-failover) describes them.
- **For a critical session such as an interview, enable billing on the project.** Billed requests are not in the sheddable class. Changing the hour does not fix this, and on the free tier it does nothing for the newest Flash models.

## Measuring it ourselves

Start the app with timestamped logs. Every line gets the local time, and each run writes its own file:

```powershell
npm start 2>&1 | ForEach-Object { "$(Get-Date -Format 'HH:mm:ss.fff') $_" } | Tee-Object -FilePath "$env:TEMP\glass-$(Get-Date -Format 'yyyyMMdd-HHmm').log"
```

After a few days of normal use, aggregate the `attempt` lines from the `glass-*.log` files by hour and model. Count outcomes (`ok`, `transient status=503`, `timeout`) and the median `ttft`. That gives this project's real failure rate per hour, so this study can be updated with measured data instead of reports.
