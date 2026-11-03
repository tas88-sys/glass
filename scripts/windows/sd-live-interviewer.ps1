<#
  Mock interviewer for Glass "System Design - Live" v1 (docs/future-work.md item 18.11):
  one interview, a behavioral part on Live Answer, then a design round in
  System Design - Live, then back to Default.

  It speaks the interviewer's lines through the default audio output, so Glass Listen
  captures them as "them" (Windows loopback). You speak your lines into the mic ("me"),
  and type into Ask or press keys only where a step says so. Each step: briefing ->
  Enter -> the console clears and the interviewer speaks -> what to do -> what to check.

  WEAR HEADPHONES: on speakers the mic also hears the voice, and the transcript gets
  the interviewer's lines twice, once as "me".

  Usage:  npm run practice:sd-live [-- -Step 3 -Rate -2]
          powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/sd-live-interviewer.ps1 [-Step 3] [-Rate 0]
  Docs:   docs/LIVE_INSIGHTS_AND_ASK.md, flow 3 (System Design - Live); docs/future-work.md, item 18.11.
#>
param(
    [int]$Step = 0,      # start at this step (0 = setup)
    [int]$Rate = 0       # voice speed, -10 (slow) .. 10 (fast)
)

$voice = New-Object -ComObject SAPI.SpVoice
$voice.Rate = $Rate
$en = $voice.GetVoices() | Where-Object { $_.GetAttribute('Language') -match '409|809' } | Select-Object -First 1
if ($en) { $voice.Voice = $en }

function Wait-Enter([string]$msg) { Write-Host ""; Read-Host $msg | Out-Null }

function Show-Block([string]$title, [string[]]$lines, [string]$color = 'Cyan') {
    Write-Host ""
    Write-Host $title -ForegroundColor $color
    foreach ($l in $lines) { Write-Host "  $l" }
}

# Each step: brief (read first), say (your lines, before the interviewer), interviewer
# (spoken), interviewers (several lines, each answered before the next), action (what to type
# or press after the interviewer, or nothing), check (what to look for).
$steps = @(
    @{
        n = 0; title = 'SETUP (once)'
        brief = @(
            '1. Headphones on. Glass running with your API key and career notes.',
            '2. Settings: STT language English (US). Live features: Answer only (Live Insights off).',
            '3. Ask mode: Default (the pill reads "Ask"). The design round switches it later.',
            '4. Close anything on the MAIN screen that shows a problem statement or numbers:',
            '   every Ask also sends a screenshot of the main screen.',
            '5. Press Listen in Glass. Leave it running until step 13.'
        )
        say = @(); interviewer = ''; action = @(); check = @()
    },
    @{
        n = 1; title = 'STEP 1 - Behavioral part (Default, Live Answer from your notes)'
        brief = @('Answer each question aloud from what Live Answer shows; nothing to type.')
        say = @()
        interviewers = @(
            "Thanks for joining. To start, tell me about a time you disagreed with a teammate.",
            "What is a project you are proud of, and what was your part in it?"
        )
        action = @('Nothing to type. Read the Live Answer aloud after each question.')
        check = @(
            'Each question gets a Live Answer in the Listen window, from your notes ("from:" line).',
            'The Live Answer pane has NO "SD Live" badge.'
        )
    },
    @{
        n = 2; title = 'STEP 2 - The design round starts: switch the mode (one click)'
        brief = @('The interviewer announces the design round. Switch the mode BEFORE the problem.')
        say = @()
        interviewer = "Great, thanks. Now let's move to a system design exercise."
        action = @('Hover the caret next to the Ask pill and pick "System Design - Live". The pill reads "Ask - SD Live".')
        check = @(
            'The Live Answer pane shows the "SD Live" badge next to "Live Answer".',
            'From now on Live Answer stays silent until a design kit exists.'
        )
    },
    @{
        n = 3; title = 'STEP 3 - Misuse: keys out of order before anything (expect: nothing)'
        brief = @('Nothing is on Ask yet. Press keys in a row, quickly, as by mistake.')
        say = @()
        interviewer = ''
        action = @(
            'Press Ctrl+Enter, then Esc. Repeat 5 times, fast (also Esc then Ctrl+Enter at once).',
            'End with Ask closed (Esc).'
        )
        check = @(
            'Ask opened and closed; NO answer, nothing "Thinking...".',
            'The app log has no "[AskService] SD Live:" line for these presses.'
        )
    },
    @{
        n = 4; title = 'STEP 4 - The problem (expect: OPENING KIT, typed)'
        brief = @('Listen to the whole problem first. Then open Ask (Ctrl+Enter), type, press Enter.')
        say = @()
        interviewer = "Today I'd like you to design a Twitter-like social network. Let's focus on the home feed."
        action = @(
            'Ctrl+Enter, type:  twitter   then Enter.',
            'WHILE the kit is still being written: type  uber  and press Enter (misuse).'
        )
        check = @(
            'Opening kit in Ask: Frame, Scope, Questions, Assumptions, Estimates, Check-in. Its first line restates the problem.',
            '"uber" was refused: Ask shows "A kit is still being written. Close Ask to cancel it." and "uber" stays in the box.',
            'The opening kit finished anyway. Clear "uber" from the box.',
            'Listen window: NO Live Answer for the problem line (no design kit yet).'
        )
    },
    @{
        n = 5; title = 'STEP 5 - Clarify (no Ask)'
        brief = @('First say aloud, from the kit on screen:')
        say = @(
            'The two Frame lines (the restatement ending "Is that right?", then the agenda).',
            'Two of the Questions, e.g. "Which features are in scope?" and "How many daily users?"'
        )
        interviewer = "Yes, that's right. Keep it to posting tweets, following people, and the home timeline. Assume about 10 million daily active users, all in the US. Skip search, direct messages and ads."
        action = @('Nothing to type.')
        check = @(
            'Listen transcript shows your lines as Me and the answer as Them.',
            'Live Answer is SILENT on "Assume about 10 million..." (no design kit yet).'
        )
    },
    @{
        n = 6; title = 'STEP 6 - Check-in, then design (expect: DESIGN KIT, by keys)'
        brief = @('First say aloud:')
        say = @('The Check-in line: "To sum up: we are building ... Anything you would change before I design?"')
        interviewer = "That sounds right. Go ahead with the high-level design."
        action = @('With NOTHING typed in the box: Ctrl+Enter twice (if Ask is closed: the 1st opens it, the 2nd sends).')
        check = @(
            'Design kit: Requirements used, API, Design, Deep dives, Check against requirements, Next questions.',
            'Requirements used: 10 million DAU (confirmed), US only (confirmed), the 3 features (confirmed).',
            'Note the Decisions line (e.g. push fan-out, pull for celebrities, timelines in Redis).'
        )
    },
    @{
        n = 7; title = 'STEP 7 - Misuse: a stray Ctrl+Enter pair after the design kit (expect: hint only)'
        brief = @('The design kit is on screen. Press the keys as if by mistake.')
        say = @()
        interviewer = ''
        action = @('With nothing in the box: Ctrl+Enter twice.')
        check = @(
            'Ask shows "Design kit done. Type `design` to update it after a change."',
            'The design kit stays on screen; no new request (no "Thinking...").'
        )
    },
    @{
        n = 8; title = 'STEP 8 - A probe, answered by itself (expect: PROBE in Listen)'
        brief = @('Say the line under the diagram aloud, then listen. Nothing to type.')
        say = @('The "> ..." line under the ASCII diagram.')
        interviewer = "Let's go deeper. What happens when a celebrity with 50 million followers posts a tweet?"
        action = @(
            'Nothing to type: read the Live Answer aloud.',
            'Optional, for the full deep dive: type  deep dive celebrity fan-out  into Ask, Enter.'
        )
        check = @(
            'Listen window: a PROBE answer (no headings, a "> ..." line, 2-3 bullets, "Trade-off:"), at most ~90 words.',
            'It agrees with your Decisions line (e.g. pull or hybrid for celebrities).',
            'Optional deep dive in Ask: "## Deep dive: ...", and the design kit is still the stored one.'
        )
    },
    @{
        n = 9; title = 'STEP 9 - Another probe (expect: PROBE in Listen)'
        brief = @('Read the probe aloud, then listen.')
        say = @('The "> ..." line of the probe.')
        interviewer = "Okay. And what if the timeline cache cluster goes down?"
        action = @('Nothing to type.')
        check = @(
            'A PROBE about YOUR cache from step 6 (e.g. the Redis timelines, replicas, rebuild).',
            'One answer for the question; it replaced the previous one on top.'
        )
    },
    @{
        n = 10; title = 'STEP 10 - The interviewer changes a requirement (expect: probe, then a new DESIGN KIT)'
        brief = @('Listen. The probe for this line comes from the OLD design; that is expected.')
        say = @()
        interviewer = "Good. Now suppose we launch in Europe too, and the feed has to survive a full region outage."
        action = @('Type  design  into Ask, Enter.')
        check = @(
            'Listen: a probe from the old design (US only). Expected in v1.',
            'Ask: a new design kit with Europe and the region outage (confirmed); multi-region now appears.',
            'The new Decisions line is the one the next probes use.'
        )
    },
    @{
        n = 11; title = 'STEP 11 - Probe against the new design (expect: PROBE in Listen)'
        brief = @('Say one line about the region failover, then listen.')
        say = @('Any line from the new kit, e.g. the one under the diagram.')
        interviewer = "Why not just use a single SQL database for the tweets?"
        action = @('Nothing to type.')
        check = @(
            'Probe shape again (<= 90 words).',
            'It agrees with the STEP-10 design (two regions), not the step-6 one.'
        )
    },
    @{
        n = 12; title = 'STEP 12 - Back to the behavioral part (one click)'
        brief = @('The design round ends. Switch the mode back BEFORE the next question.')
        say = @()
        interviewer = "Thanks, that was great. One last question: why do you want to join us?"
        action = @('Before the interviewer finishes: pick "Default" in the mode picker. The pill reads "Ask".')
        check = @(
            'The "SD Live" badge is gone.',
            'Live Answer answers from your notes again ("from:" line), not as a probe.'
        )
    },
    @{
        n = 13; title = 'STEP 13 - New session: the opening kit by keys (expect: OPENING KIT)'
        brief = @(
            'In Glass press Stop, then Listen again (new session: no kit, empty transcript).',
            'Switch to "System Design - Live" (badge on).'
        )
        say = @()
        interviewer = "Let's do one more. Design a URL shortener."
        action = @('With NOTHING typed: Ctrl+Enter twice.')
        check = @(
            'An opening kit for the URL shortener, read from the transcript; its first line restates it.',
            'Live Answer is silent (no design kit in this new session).',
            'Then switch back to Default and press Stop. Simulation done.'
        )
    }
)

foreach ($s in $steps) {
    if ($s.n -lt $Step) { continue }
    Clear-Host
    Show-Block $s.title $s.brief 'Yellow'
    if ($s.say.Count -gt 0) { Show-Block 'YOU SAY (into the mic):' $s.say 'Green' }
    if ($s.n -eq 0) { Wait-Enter 'Press Enter when Listen is running'; continue }

    Wait-Enter 'Press Enter when ready (the screen clears before the interviewer speaks)'
    Clear-Host
    $lines = @()
    if ($s.interviewers) { $lines = $s.interviewers } elseif ($s.interviewer) { $lines = @($s.interviewer) }
    $i = 0
    foreach ($line in $lines) {
        $i++
        Write-Host "Step $($s.n): interviewer speaking..." -ForegroundColor Magenta
        [void]$voice.Speak($line)
        Start-Sleep -Milliseconds 1500   # let STT finish the turn
        if ($i -lt $lines.Count) { Wait-Enter 'Answer aloud, then press Enter for the next question' }
    }
    Show-Block 'DO:' $s.action 'White'
    Wait-Enter 'Press Enter when done (and any answer has finished streaming)'
    Show-Block 'CHECK:' $s.check 'Cyan'
    Wait-Enter 'Press Enter for the next step'
}
Write-Host "Done." -ForegroundColor Green
