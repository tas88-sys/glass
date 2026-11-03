<#
  Mock interview that validates Glass "System Design - Live" v1 (docs/future-work.md item 18.11)
  in the real app: a behavioral part on Live Answer, the design round in System Design - Live,
  every key rule (also pressed out of order), and back to Default.

  It speaks the interviewer's lines through the default audio output, so Glass Listen
  captures them as "Them" (Windows loopback). You speak your lines into the mic ("Me"),
  and type into Ask or press keys only where a step says so.

  Each step: briefing -> Enter -> the interviewer speaks -> what to do -> Enter ->
    AUTO checks: read from the Glass log (the "[SD Live] ..." lines the app writes for every
                 key, send, refusal, hint, stored kit and probe), PASS or FAIL by themselves;
    YOUR checks: what only your eyes can see (Enter = OK, n = not OK).
  At the end: a summary, and a report with every result and the log lines of each step.

  The AUTO checks need the log: start Glass from the desktop shortcut (npm run shortcut:win)
  or with scripts/windows/start-glass.ps1. Both write %LOCALAPPDATA%\glass-logs\glass.log.
  `npm start` in a terminal writes no file: the AUTO checks are then skipped.

  WEAR HEADPHONES: on speakers the mic also hears the voice, and the transcript gets
  the interviewer's lines twice, once as "Me".

  Usage:  npm run practice:sd-live [-- -Step 5 -Rate -2 -Log <path>]
          powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/sd-live-interviewer.ps1 [-Step 5]
  Docs:   docs/LIVE_INSIGHTS_AND_ASK.md, flow 3 (System Design - Live); docs/future-work.md, item 18.11.
#>
param(
    [int]$Step = 0,      # start at this step (0 = setup)
    [int]$Rate = 0,      # voice speed, -10 (slow) .. 10 (fast)
    [string]$Log = (Join-Path $env:LOCALAPPDATA 'glass-logs\glass.log')
)

$voice = New-Object -ComObject SAPI.SpVoice
$voice.Rate = $Rate
$en = $voice.GetVoices() | Where-Object { $_.GetAttribute('Language') -match '409|809' } | Select-Object -First 1
if ($en) { $voice.Voice = $en }

# ---------------------------------------------------------------- the Glass log

# A mark is the log's length and its first bytes: Glass restarted by the shortcut moves
# glass.log to glass.prev.log and starts a new one, which the first bytes tell apart.
function Read-LogHead([System.IO.FileStream]$fs, [int]$n) {
    $buf = New-Object byte[] $n
    $fs.Seek(0, 'Begin') | Out-Null
    $got = $fs.Read($buf, 0, $n)
    return [System.Text.Encoding]::UTF8.GetString($buf, 0, $got)
}
function Open-Log {
    if (-not (Test-Path $Log)) { return $null }
    try { return [System.IO.File]::Open($Log, 'Open', 'Read', [System.IO.FileShare]'ReadWrite, Delete') } catch { return $null }
}
function Get-LogMark {
    $fs = Open-Log
    if (-not $fs) { return @{ len = 0; head = '' } }
    try {
        $len = $fs.Length
        return @{ len = $len; head = (Read-LogHead $fs ([int][Math]::Min($len, 256))) }
    } finally { $fs.Close() }
}
function Read-LogSince($mark) {
    $fs = Open-Log
    if (-not $fs) { return @() }
    try {
        $start = $mark.len
        if ($fs.Length -lt $mark.len) { $start = 0 }
        elseif ($mark.head.Length -gt 0) {
            $headNow = Read-LogHead $fs ([System.Text.Encoding]::UTF8.GetByteCount($mark.head))
            if ($headNow -ne $mark.head) { $start = 0 }   # a new log: Glass was restarted
        }
        $fs.Seek($start, 'Begin') | Out-Null
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        return @($sr.ReadToEnd() -split "`r?`n")
    } finally { $fs.Close() }
}

# The lines the app writes (src/features/ask/askService.js, summary/summaryService.js).
$P = @{
    modeOn       = '\[SD Live\] mode: system_design_live'
    modeDefault  = '\[SD Live\] mode: default '
    keyCtrlEnter = '\[SD Live\] key: Ctrl\+Enter'
    keyIgnored   = '\[SD Live\] key: .*ignored, Ask is closing'
    send         = '\[SD Live\] ask: send '
    sendOpening  = '\[SD Live\] ask: send .*\(kit request: opening\)'
    sendDesign   = '\[SD Live\] ask: send .*\(kit request: design\)'
    sendNoKit    = '\[SD Live\] ask: send .*\(kit request: no\)'
    refused      = '\[SD Live\] ask: refused'
    dropped      = '\[SD Live\] ask: a second empty send'
    hint         = '\[SD Live\] ask: hint only'
    openingKit   = '\[SD Live\] ask: opening kit stored'
    designKit    = '\[SD Live\] ask: design kit stored'
    anyKit       = '\[SD Live\] ask: (opening|design) kit stored'
    notAKit      = '\[SD Live\] ask: answer done, not a kit'
    closeCancel  = '\[SD Live\] close Ask .*kit being written is cancelled'
    silent       = '\[SD Live\] lane: them turn, no design kit'
    probe        = '\[SD Live\] lane: probe #'
    sdLane       = '\[SD Live\] (lane|ask):'
    them         = 'Transcription complete: Them'
    askError     = '\[AskService\] (Error during message processing|Error while processing stream)|\[live-answer\] stream error|Uncaught|TypeError'
}

# ---------------------------------------------------------------- results

$results = New-Object System.Collections.ArrayList
$stepLogs = @{}
$haveLog = $true

function Add-Result($n, $kind, $check, $result, $detail) {
    [void]$results.Add([pscustomobject]@{ Step = $n; Kind = $kind; Check = $check; Result = $result; Detail = $detail })
}

function Test-Expect($n, $lines, $e) {
    $count = @($lines | Where-Object { $_ -match $e.p }).Count
    $min = 0; if ($null -ne $e.min) { $min = $e.min }
    $max = -1; if ($null -ne $e.max) { $max = $e.max }
    $want = if ($max -eq 0) { 'none' } elseif ($max -lt 0) { "at least $min" } elseif ($min -eq 0) { "at most $max" } elseif ($min -eq $max) { "exactly $min" } else { "$min to $max" }
    if ($e.info) {
        Write-Host ("  INFO  {0}: {1}" -f $e.what, $count) -ForegroundColor DarkGray
        Add-Result $n 'auto' $e.what 'INFO' "found $count"
        return
    }
    $ok = ($count -ge $min) -and (($max -lt 0) -or ($count -le $max))
    if ($ok) {
        Write-Host ("  PASS  {0} (found {1})" -f $e.what, $count) -ForegroundColor Green
        Add-Result $n 'auto' $e.what 'PASS' "found $count, wanted $want"
    } else {
        Write-Host ("  FAIL  {0} (found {1}, wanted {2})" -f $e.what, $count, $want) -ForegroundColor Red
        if ($e.why) { Write-Host "        $($e.why)" -ForegroundColor Red }
        Add-Result $n 'auto' $e.what 'FAIL' "found $count, wanted $want. $($e.why)"
    }
}

function Wait-Enter([string]$msg) { Write-Host ""; Read-Host $msg | Out-Null }

function Show-Block([string]$title, [string[]]$lines, [string]$color = 'Cyan') {
    Write-Host ""
    Write-Host $title -ForegroundColor $color
    foreach ($l in $lines) { Write-Host "  $l" }
}

function Ask-Checks($n, [string[]]$checks) {
    if (-not $checks -or $checks.Count -eq 0) { return }
    Write-Host ""
    Write-Host 'YOUR CHECKS (Enter = OK, n = not OK):' -ForegroundColor Cyan
    foreach ($c in $checks) {
        Write-Host "  - $c"
        $a = Read-Host '    OK?'
        if ($a -match '^\s*n') {
            $note = Read-Host '    What did you see?'
            Add-Result $n 'you' $c 'FAIL' $note
        } else {
            Add-Result $n 'you' $c 'PASS' ''
        }
    }
}

# ---------------------------------------------------------------- the steps
# Each step: brief (read and do first), say (your lines, before the interviewer),
# interviewer / interviewers (spoken), action (after the interviewer), expect (AUTO
# checks on the log lines of this step), check (YOUR checks).

$steps = @(
    @{
        n = 0; title = 'SETUP (once)'
        brief = @(
            '1. Headphones on. Quit Glass if it is running, then start it from the desktop shortcut',
            '   "Glass" (or scripts/windows/start-glass.ps1), so it writes the log this script reads.',
            '2. Settings: STT language English (US). Live features: Answer only (Live Insights off).',
            '3. Ask mode: Default (the pill reads "Ask").',
            '4. Close anything on the MAIN screen that shows a problem statement or numbers:',
            '   every Ask also sends a screenshot of the main screen.',
            '5. Open the interview VM window (no VM here: open Notepad instead), where you can click it.',
            '6. Press Listen in Glass.'
        )
        expect = @(
            @{ what = 'The log has the mode line (this build writes [SD Live] lines)'; p = $P.modeDefault; min = 1; whole = $true
               why = 'Start Glass from the shortcut, from this branch, with the Ask mode on Default.' }
        )
        check = @()
    },
    @{
        n = 1; title = 'STEP 1 - Behavioral part (Default, Live Answer from your notes)'
        brief = @('Answer each question aloud from what Live Answer shows; nothing to type.')
        interviewers = @(
            "Thanks for joining. To start, tell me about a time you disagreed with a teammate.",
            "What is a project you are proud of, and what was your part in it?"
        )
        action = @('Nothing to type. Read the Live Answer aloud after each question.')
        expect = @(
            @{ what = 'The interviewer was transcribed'; p = $P.them; min = 1; why = 'Check the headphones, Listen and the audio output.' },
            @{ what = 'No System Design - Live line in Default'; p = $P.sdLane; max = 0 }
        )
        check = @(
            'Each question got a Live Answer in the Listen window, from your notes ("from:" line).',
            'The Live Answer pane has NO "SD Live" badge.'
        )
    },
    @{
        n = 2; title = 'STEP 2 - The design round starts: switch the mode (one click)'
        brief = @('The interviewer announces the design round.')
        interviewer = "Great, thanks. Now let's move to a system design exercise."
        action = @('Hover the caret next to the Ask pill and pick "System Design - Live". The pill reads "Ask - SD Live".')
        expect = @(
            @{ what = 'The mode changed to System Design - Live'; p = $P.modeOn; min = 1 }
        )
        check = @('The Live Answer pane shows the "SD Live" badge next to "Live Answer", with no answer yet.')
    },
    @{
        n = 3; title = 'STEP 3 - Restart Glass with SD Live saved'
        brief = @(
            '1. In Glass press Stop. Then Settings > Quit.',
            '2. Start Glass again from the desktop shortcut. Wait for the header.',
            '3. Press Listen.'
        )
        action = @('Nothing else.')
        expect = @(
            @{ what = 'Glass started again in System Design - Live (the saved mode)'; p = $P.modeOn; min = 1
               why = 'No mode line after the restart: was Glass started from the shortcut?' }
        )
        check = @(
            'The pill reads "Ask - SD Live" right after the restart.',
            'The Live Answer pane shows the "SD Live" badge.'
        )
    },
    @{
        n = 4; title = 'STEP 4 - Misuse: keys out of order before any kit (expect: nothing sent)'
        brief = @('Nothing is on Ask yet. Press the keys quickly, as by mistake.')
        action = @(
            'a) Ctrl+Enter, then Esc: 10 times in a row, fast.',
            'b) Esc and right after it (within a quarter second) Ctrl+Enter: 3 times.',
            'c) Click the Ask button in the header 4 times.',
            'End with Ask closed (Esc, or click Ask once more).'
        )
        expect = @(
            @{ what = 'Glass received Ctrl+Enter'; p = $P.keyCtrlEnter; min = 1 },
            @{ what = 'No request was sent'; p = $P.send; max = 0
               why = 'Esc closes Ask only when Ask has the keyboard focus; otherwise the 2nd Ctrl+Enter is the defined "opening" request. Look at the log lines in the report.' },
            @{ what = 'No kit stored'; p = $P.anyKit; max = 0 },
            @{ what = 'Keys ignored during the closing fade'; p = $P.keyIgnored; info = $true }
        )
        check = @('Ask opened and closed; no answer, never "Thinking...".')
    },
    @{
        n = 5; title = 'STEP 5 - The problem (expect: OPENING KIT, typed; a 2nd request refused)'
        brief = @('Listen to the whole problem first.')
        interviewer = "Today I'd like you to design a Twitter-like social network. Let's focus on the home feed."
        action = @(
            'Ctrl+Enter (opens Ask), type:  twitter   then Enter.',
            'WHILE the kit is still being written: Ctrl+Enter (shows the box), type  uber, Enter (misuse).',
            'Let the kit finish. Then delete "uber" from the box.'
        )
        expect = @(
            @{ what = 'One request: "twitter" sent as "opening: twitter"'; p = "\[SD Live\] ask: send 'twitter' .+ 'opening: twitter'"; min = 1; max = 1 },
            @{ what = 'Only one request was sent'; p = $P.send; max = 1 },
            @{ what = '"uber" was refused while the kit was written'; p = $P.refused; min = 1
               why = 'Type "uber" sooner, while the kit is still streaming.' },
            @{ what = 'The opening kit was stored'; p = $P.openingKit; min = 1; max = 1 },
            @{ what = 'Live Answer stayed silent on the problem (no design kit)'; p = $P.silent; min = 1 },
            @{ what = 'No probe'; p = $P.probe; max = 0 },
            @{ what = 'No Ask error'; p = $P.askError; max = 0 }
        )
        check = @(
            'Opening kit in Ask: Frame, Scope, Questions, Assumptions, Estimates, Check-in. Its first line restates the problem.',
            'Ask showed "A kit is still being written. Close Ask to cancel it." and "uber" stayed in the box.',
            'Nothing new appeared in the Live Answer pane.'
        )
    },
    @{
        n = 6; title = 'STEP 6 - Clarify (no Ask)'
        brief = @('Say aloud, from the kit on screen, then press Enter:')
        say = @(
            'The two Frame lines (the restatement ending "Is that right?", then the agenda).',
            'Two of the Questions, e.g. "Which features are in scope?" and "How many daily users?"'
        )
        interviewer = "Yes, that's right. Keep it to posting tweets, following people, and the home timeline. Assume about 10 million daily active users, all in the US. Skip search, direct messages and ads."
        action = @('Nothing to type.')
        expect = @(
            @{ what = 'Live Answer silent on the answers (no design kit yet)'; p = $P.silent; min = 1 },
            @{ what = 'No probe'; p = $P.probe; max = 0 },
            @{ what = 'No request sent'; p = $P.send; max = 0 }
        )
        check = @('The Listen transcript shows your lines as Me and the answer as Them.')
    },
    @{
        n = 7; title = 'STEP 7 - The design kit by keys, with the VM focused (expect: DESIGN KIT)'
        brief = @('First say aloud:')
        say = @('The Check-in line: "To sum up: we are building ... Anything you would change before I design?"')
        interviewer = "That sounds right. Go ahead with the high-level design."
        action = @(
            'Click inside the VM window (or Notepad), so IT has the keyboard focus.',
            'With NOTHING in the Ask box: Ctrl+Enter twice.',
            '(One press shows the box over the kit, the other sends it; one request goes out either way.)'
        )
        expect = @(
            @{ what = 'Ctrl+Enter reached Glass while the VM had the focus'; p = $P.keyCtrlEnter; min = 2
               why = 'The VM keeps Ctrl+Enter. In the interview, click the Ask box and press Enter instead (typed path).' },
            @{ what = 'The empty send asked for the design kit'; p = "\[SD Live\] ask: send '' .+ 'design' \(kit request: design\)"; min = 1; max = 1 },
            @{ what = 'The design kit was stored'; p = $P.designKit; min = 1 },
            @{ what = 'No Ask error'; p = $P.askError; max = 0 }
        )
        check = @(
            'Design kit: Requirements used, API, Design, Deep dives, Check against requirements, Next questions.',
            'Requirements used: 10 million DAU, US only and the 3 features, marked (confirmed).',
            'Note its Decisions line (e.g. push fan-out, pull for celebrities, timelines in Redis): the probes must agree with it.'
        )
    },
    @{
        n = 8; title = 'STEP 8 - Misuse after the design kit: a stray pair, then a held key (expect: hint only)'
        brief = @('The design kit is on screen. Press the keys as if by mistake.')
        action = @(
            'a) With nothing in the box: Ctrl+Enter twice.',
            'b) Hold Ctrl+Enter down for 2 seconds.'
        )
        expect = @(
            @{ what = 'No request was sent'; p = $P.send; max = 0 },
            @{ what = 'The hint was shown'; p = $P.hint; min = 1 },
            @{ what = 'No kit stored (the design kit stays)'; p = $P.anyKit; max = 0 }
        )
        check = @(
            'Ask showed "Design kit done. Type `design` to update it after a change."',
            'The design kit stayed on screen; no "Thinking...".'
        )
    },
    @{
        n = 9; title = 'STEP 9 - Esc and Ctrl+\ while a kit is written (expect: the kit is kept)'
        brief = @('The interviewer adds a detail; you ask for the design again.')
        interviewer = "One more thing: tweets can include images."
        action = @(
            'Type  design  into Ask, Enter (box hidden? Ctrl+Enter once shows it). WHILE it is written:',
            '  press Esc (nothing happens: Esc closes Ask only when it shows no answer),',
            '  press Ctrl+\ (every Glass window hides), wait 2 seconds, Ctrl+\ again (they come back).',
            'Let the kit finish.'
        )
        expect = @(
            @{ what = '"design" sent as a design kit request'; p = "\[SD Live\] ask: send 'design' .+ 'design' \(kit request: design\)"; min = 1; max = 1 },
            @{ what = 'The new design kit was stored'; p = $P.designKit; min = 1 },
            @{ what = 'Nothing was cancelled'; p = $P.closeCancel; max = 0 }
        )
        check = @('A new design kit, complete; images appear in it (e.g. object storage).')
    },
    @{
        n = 10; title = 'STEP 10 - Closing Ask cancels a kit (expect: nothing stored, the kit before stays)'
        brief = @('Ask for the design again and cancel it.')
        action = @(
            'Type  design  into Ask, Enter. As soon as text starts to appear: click the close (X) button of Ask.',
            'Then Ctrl+Enter once: Ask opens.'
        )
        expect = @(
            @{ what = 'Closing cancelled the kit being written'; p = $P.closeCancel; min = 1
               why = 'Close Ask sooner, while the kit is still being written.' },
            @{ what = 'Nothing stored'; p = $P.anyKit; max = 0 }
        )
        check = @('Ask reopened with an EMPTY box.')
    },
    @{
        n = 11; title = 'STEP 11 - A probe answered by itself, and a deep dive (expect: PROBE in Listen)'
        brief = @('Say the line under the diagram aloud, then press Enter and listen.')
        say = @('The "> ..." line under the ASCII diagram.')
        interviewer = "Let's go deeper. What happens when a celebrity with 50 million followers posts a tweet?"
        action = @(
            'Read the Live Answer aloud.',
            'Then type  deep dive celebrity fan-out  into Ask, Enter (box hidden? Ctrl+Enter once shows it). Let it finish.'
        )
        expect = @(
            @{ what = 'A probe was answered (the kit from step 9 is still stored)'; p = $P.probe; min = 1 },
            @{ what = 'Live Answer was never silent for lack of a kit'; p = $P.silent; max = 0 },
            @{ what = 'The deep dive was sent as typed'; p = "\[SD Live\] ask: send 'deep dive celebrity fan-out' .+ \(kit request: no\)"; min = 1 },
            @{ what = 'The deep dive did not replace the design kit'; p = $P.anyKit; max = 0 },
            @{ what = 'The deep dive finished'; p = $P.notAKit; min = 1 }
        )
        check = @(
            'Listen: a PROBE (no headings, a "> ..." line, 2-3 bullets, "Trade-off:"), at most ~90 words.',
            'It agrees with your Decisions line (e.g. pull or hybrid for celebrities).',
            'Ask: "## Deep dive: ..."'
        )
    },
    @{
        n = 12; title = 'STEP 12 - Another probe (expect: PROBE in Listen)'
        brief = @('Read the probe aloud after it comes.')
        interviewer = "Okay. And what if the timeline cache cluster goes down?"
        action = @('Nothing to type. Read the probe aloud.')
        expect = @(
            @{ what = 'A probe was answered'; p = $P.probe; min = 1 },
            @{ what = 'No request sent'; p = $P.send; max = 0 }
        )
        check = @(
            'A PROBE about YOUR cache (e.g. the Redis timelines, replicas, rebuild).',
            'One answer for the question; it replaced the previous one on top.'
        )
    },
    @{
        n = 13; title = 'STEP 13 - The interviewer changes a requirement (expect: probe, then a new DESIGN KIT)'
        brief = @('Listen. The probe for this line comes from the OLD design; that is expected.')
        interviewer = "Good. Now suppose we launch in Europe too, and the feed has to survive a full region outage."
        action = @('Type  design  into Ask, Enter (box hidden? Ctrl+Enter once shows it). Let it finish.')
        expect = @(
            @{ what = '"design" sent as a design kit request'; p = $P.sendDesign; min = 1; max = 1 },
            @{ what = 'The new design kit was stored'; p = $P.designKit; min = 1 },
            @{ what = 'Probe for the change (from the old design)'; p = $P.probe; info = $true }
        )
        check = @(
            'Ask: a new design kit with Europe and the region outage (confirmed); multi-region appears.',
            'Note its new Decisions line.'
        )
    },
    @{
        n = 14; title = 'STEP 14 - A probe against the new design (expect: PROBE in Listen)'
        brief = @('Say one line about the region failover, then press Enter and listen.')
        say = @('Any line from the new kit, e.g. the one under the diagram.')
        interviewer = "Why not just use a single SQL database for the tweets?"
        action = @('Nothing to type.')
        expect = @(
            @{ what = 'A probe was answered'; p = $P.probe; min = 1 }
        )
        check = @('The probe agrees with the step-13 design (two regions), not the earlier one.')
    },
    @{
        n = 15; title = 'STEP 15 - A new problem typed after the design kit (expect: OPENING KIT, Live Answer silent)'
        brief = @(
            'BEFORE pressing Enter here: type  opening: uber  into Ask, Enter (box hidden? Ctrl+Enter once shows it),',
            '  and let the kit finish.',
            'Then press Enter: the interviewer asks a question.'
        )
        interviewer = "How would you match riders with nearby drivers?"
        action = @('Nothing to type.')
        expect = @(
            @{ what = '"opening: uber" sent as an opening kit request'; p = "\[SD Live\] ask: send 'opening: uber' .+ 'opening: uber' \(kit request: opening\)"; min = 1 },
            @{ what = 'The opening kit replaced the design kit'; p = $P.openingKit; min = 1 },
            @{ what = 'Live Answer silent on the question (no design kit now)'; p = $P.silent; min = 1 },
            @{ what = 'No probe'; p = $P.probe; max = 0 }
        )
        check = @(
            'Ask: an opening kit for Uber.',
            'Nothing new in the Live Answer pane for the question.'
        )
    },
    @{
        n = 16; title = 'STEP 16 - Back to the behavioral part (one click)'
        brief = @('BEFORE pressing Enter here: pick "Default" in the mode picker. The pill reads "Ask".')
        interviewer = "Thanks, that was great. One last question: why do you want to join us?"
        action = @('Read the Live Answer aloud.')
        expect = @(
            @{ what = 'The mode changed to Default'; p = $P.modeDefault; min = 1 },
            @{ what = 'No System Design - Live line after the switch'; p = $P.sdLane; max = 0 }
        )
        check = @(
            'The "SD Live" badge is gone.',
            'Live Answer answered from your notes ("from:" line), not as a probe.'
        )
    },
    @{
        n = 17; title = 'STEP 17 - New session: text from Default is cleared, and a held key asks once (expect: one OPENING KIT)'
        brief = @(
            '1. In Glass press Stop, then Listen (a new session: no kit, empty transcript).',
            '2. Still in Default: close Ask with its X if it is open. Ctrl+Enter opens Ask; type  hello',
            '   in the box. Do NOT press Enter.',
            '3. Pick "System Design - Live". Look at the box: it must be empty now.',
            '4. Close Ask with its close (X) button.'
        )
        interviewer = "Let's do one more. Design a URL shortener."
        action = @(
            'With Ask closed: HOLD Ctrl+Enter down for 2 seconds.',
            'If Ask only opened and nothing is being written, press Ctrl+Enter once more.'
        )
        expect = @(
            @{ what = 'The held key sent exactly one request, the opening kit'; p = $P.sendOpening; min = 1; max = 1 },
            @{ what = 'Only one request in total'; p = $P.send; max = 1 },
            @{ what = 'The opening kit was stored'; p = $P.openingKit; min = 1 },
            @{ what = 'Live Answer silent (no design kit in this new session)'; p = $P.silent; min = 1 },
            @{ what = 'No probe'; p = $P.probe; max = 0 },
            @{ what = 'Repeats refused or dropped while the kit was written'; p = "$($P.refused)|$($P.dropped)"; info = $true }
        )
        check = @(
            'Switching to SD Live emptied the box ("hello" was gone).',
            'One opening kit for the URL shortener, read from the transcript; its first line restates it.'
        )
    },
    @{
        n = 18; title = 'STEP 18 - Wrap up'
        brief = @('Pick "Default" in the mode picker, then press Stop in Glass.')
        action = @('Nothing else.')
        expect = @(
            @{ what = 'The mode is back to Default'; p = $P.modeDefault; min = 1 },
            @{ what = 'No Ask error in this step'; p = $P.askError; max = 0 }
        )
        check = @()
    }
)

# ---------------------------------------------------------------- run

foreach ($s in $steps) {
    if ($s.n -lt $Step) { continue }
    Clear-Host
    $mark = Get-LogMark
    Show-Block $s.title $s.brief 'Yellow'
    if ($s.say -and $s.say.Count -gt 0) { Show-Block 'YOU SAY (into the mic):' $s.say 'Green' }

    if ($s.n -eq 0) {
        Wait-Enter 'Press Enter when Listen is running'
    } else {
        Wait-Enter 'Press Enter when ready (the screen clears before the interviewer speaks)'
        Clear-Host
        Write-Host $s.title -ForegroundColor Yellow
        $lines = @()
        if ($s.interviewers) { $lines = $s.interviewers } elseif ($s.interviewer) { $lines = @($s.interviewer) }
        $i = 0
        foreach ($line in $lines) {
            $i++
            Write-Host "Interviewer speaking..." -ForegroundColor Magenta
            [void]$voice.Speak($line)
            Start-Sleep -Milliseconds 1500   # let STT finish the turn
            if ($i -lt $lines.Count) { Wait-Enter 'Answer aloud, then press Enter for the next question' }
        }
        Show-Block 'DO:' $s.action 'White'
        Wait-Enter 'Press Enter when done (and any answer has finished streaming)'
        Start-Sleep -Milliseconds 1200       # let the last log lines land
    }

    # AUTO checks on this step's log lines.
    Write-Host ""
    Write-Host 'AUTO CHECKS (from the Glass log):' -ForegroundColor Cyan
    if (-not (Test-Path $Log)) {
        if ($haveLog) { Write-Host "  No log at $Log : AUTO checks skipped (start Glass from the shortcut)." -ForegroundColor DarkYellow }
        $haveLog = $false
        foreach ($e in $s.expect) { Add-Result $s.n 'auto' $e.what 'SKIP' 'no log' }
    } else {
        $logLines = Read-LogSince $mark
        $whole = $null
        foreach ($e in $s.expect) {
            if ($e.whole) {
                if (-not $whole) { $whole = Read-LogSince @{ len = 0; head = '' } }
                Test-Expect $s.n $whole $e
            } else {
                Test-Expect $s.n $logLines $e
            }
        }
        $stepLogs[$s.n] = @($logLines | Where-Object { $_ -match '\[SD Live\]|Transcription complete|\[AskService\] (Error|Stream)|\[live-answer\] stream error|Uncaught|TypeError' })
    }

    Ask-Checks $s.n $s.check
    Wait-Enter 'Press Enter for the next step'
}

# ---------------------------------------------------------------- summary and report

Clear-Host
$fail = @($results | Where-Object { $_.Result -eq 'FAIL' })
$pass = @($results | Where-Object { $_.Result -eq 'PASS' })
$skip = @($results | Where-Object { $_.Result -eq 'SKIP' })
Write-Host "Done: $($pass.Count) passed, $($fail.Count) failed, $($skip.Count) skipped." -ForegroundColor $(if ($fail.Count) { 'Red' } else { 'Green' })
foreach ($f in $fail) { Write-Host ("  FAIL  step {0} [{1}] {2}: {3}" -f $f.Step, $f.Kind, $f.Check, $f.Detail) -ForegroundColor Red }

$outDir = Join-Path $env:LOCALAPPDATA 'glass-practice'
New-Item -ItemType Directory -Force $outDir | Out-Null
$report = Join-Path $outDir ("sd-live-{0}.md" -f (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'))
$md = New-Object System.Collections.ArrayList
[void]$md.Add("# System Design - Live practice run, $(Get-Date -Format 'yyyy-MM-dd HH:mm')")
[void]$md.Add('')
[void]$md.Add("$($pass.Count) passed, $($fail.Count) failed, $($skip.Count) skipped. Log: $Log")
foreach ($s in $steps) {
    $rs = @($results | Where-Object { $_.Step -eq $s.n })
    if ($rs.Count -eq 0) { continue }
    [void]$md.Add('')
    [void]$md.Add("## $($s.title)")
    [void]$md.Add('')
    [void]$md.Add('| Result | Who | Check | Detail |')
    [void]$md.Add('|---|---|---|---|')
    foreach ($r in $rs) { [void]$md.Add(('| {0} | {1} | {2} | {3} |' -f $r.Result, $r.Kind, ($r.Check -replace '\|', '/'), ($r.Detail -replace '\|', '/'))) }
    if ($stepLogs.ContainsKey($s.n) -and $stepLogs[$s.n].Count -gt 0) {
        [void]$md.Add('')
        [void]$md.Add('```')
        foreach ($l in ($stepLogs[$s.n] | Select-Object -First 80)) { [void]$md.Add($l) }
        [void]$md.Add('```')
    }
}
$md | Set-Content -Path $report -Encoding UTF8
Write-Host ""
Write-Host "Report: $report" -ForegroundColor Cyan
