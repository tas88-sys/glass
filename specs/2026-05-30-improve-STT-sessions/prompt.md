# Issue

My STT sessions are kind of flaky, several times transcribing not working or interminttet. I'm using Deepgram Nova-3. Logs show up like this.

Error sending system audio: Error: Their STT session not active
    at SttService.sendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:577:19)
    at SttService.handleSendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:67:24)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:151:47
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)
Error sending user audio: Error: User STT session not active
    at SttService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:552:19)
    at ListenService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:213:38)
    at ListenService.handleSendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:273:46)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:149:100
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)
Error sending user audio: Error: User STT session not active
    at SttService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:552:19)
    at ListenService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:213:38)
    at ListenService.handleSendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:273:46)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:149:100
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)
Error sending system audio: Error: Their STT session not active
    at SttService.sendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:577:19)
    at SttService.handleSendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:67:24)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:151:47
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)
Error sending system audio: Error: Their STT session not active
    at SttService.sendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:577:19)
    at SttService.handleSendSystemAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:67:24)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:151:47
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)
Error sending user audio: Error: User STT session not active
    at SttService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\stt\sttService.js:552:19)
    at ListenService.sendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:213:38)
    at ListenService.handleSendMicAudioContent (C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\features\listen\listenService.js:273:46)
    at C:\Users\thiago.soeiro\Documents\repos\glass\glass\src\bridge\featureBridge.js:149:100
    at WebContents.<anonymous> (node:electron/js2c/browser_init:2:82957)
    at WebContents.emit (node:events:519:28)


Explore this repo docs and any useful info so we can create a spec to fix this issue (if really a issue in the first place)


### REQUIRED STEPS

After finishing investigation, RIGOROUSLY challenge every assumption and assertion you did.                                                                                                                                  

Double-check and DEEP review everything. Only stop your analysis when you are 100% CONFIDENT that all reasoning is sound and the conclusions make sense.

Examine all claims with maximum rigor.

Query every possible resource before drawing conclusions.

Ensure the output includes sufficient EVIDENCE to support your arguments.

Seek clarifications.

Surface inconsistencies.

Don't assume. State your assumptions explicitly.

Don't hide confusion. 

Surface tradeoffs.

Push hard on every question.

Push back when you should.

Use your judgment.

Apply ultrathink at every step. 