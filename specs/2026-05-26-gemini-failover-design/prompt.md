We need to create somekind of retry mechanism for gemini. 

often times, gemini api returns errors. THis is normally due to server degradation or real rate limit issues (429, 503, etc..)

Limits vary depending on the specific model being used,

My plan is to rotate the models at every request, following a order of priority. It means Gemini LLM Model ID and Gemini STT Model ID free-text inputs in settings should receive N models separated by comma.

For instance. Gemini LLM Model ID is set to: gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite

If a request fails, the next model in the queue should be tried and so on, until the last model is tried and the model is reset to the first one. 

This order should be followed for every request.

THe model in use should be displayed somewhere in the app.

Help me decide if this is the best approach or if I am missing something and this feature could be implemented with something else aswell.