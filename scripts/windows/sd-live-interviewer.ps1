<#
  Mock interviewer for Glass "System Design - Live" (Ask mode system_design_live).

  It speaks the interviewer's lines through the default audio output, so Glass Listen
  captures them as "them" (Windows loopback). You speak your lines into the mic ("me")
  and type into Ask. Each step: briefing -> Enter -> the console clears and the
  interviewer speaks -> type into Ask -> Enter -> what to check.

  WEAR HEADPHONES: on speakers the mic also hears the voice, and the transcript gets
  the interviewer's lines twice, once as "me".

  Usage:  npm run practice:sd-live [-- -Step 3 -Rate -2]
          powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/sd-live-interviewer.ps1 [-Step 3] [-Rate 0]
  Docs:   docs/LIVE_INSIGHTS_AND_ASK.md, flow 3 (System Design - Live).
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

$steps = @(
    @{
        n = 0; title = 'SETUP (once)'
        brief = @(
            '1. Headphones on. Glass running with your API key.',
            '2. Settings: STT language English (US). Live features: Answer + Insights (to see both lanes).',
            '3. Hover the caret next to the Ask pill and pick "System Design - Live". The pill reads "Ask - SD Live".',
            '4. Close anything on the MAIN screen that shows a problem statement or numbers:',
            '   every Ask also sends a screenshot of the main screen, and a screenshot that states',
            '   scale or targets counts as confirmed requirements.',
            '5. Press Listen in Glass. Leave it running until step 9.'
        )
        say = @(); interviewer = ''; type = ''; check = @()
    },
    @{
        n = 1; title = 'STEP 1 - The problem (expect: OPENING KIT)'
        brief = @('Nothing to say yet. Listen to the problem, then type into Ask.')
        say = @()
        interviewer = "Thanks for joining. Today I'd like you to design a Twitter-like social network. Let's focus on the feed."
        type = 'design twitter feed'
        check = @(
            'Ask shows six headings in order: Frame, Scope, Questions, Assumptions, Estimates, Check-in.',
            'At most ~450 words. Every number is marked (assumed): nobody confirmed anything yet.',
            'Estimates use per-day math: daily users x actions per day / 10^5 s, each line "-> so ...".',
            'Listen window: the live answer may ALSO answer this line. That is the other lane; ignore it here.',
            'Behind the scenes this answer is saved as the "previous answer" (it has a "## Frame" heading).'
        )
    },
    @{
        n = 2; title = 'STEP 2 - Clarify (no Ask)'
        brief = @('First say aloud, from the kit on screen:')
        say = @(
            'The two Frame lines (the restatement ending "Is that right?", then the agenda).',
            'Two of the Questions, e.g. "Which features are in scope?" and "How many daily users?"'
        )
        interviewer = "Yes, that's right. Keep it to posting tweets, following people, and the home timeline. Assume about 10 million daily active users, all in the US. Skip search, direct messages and ads."
        type = '(nothing - just listen)'
        check = @(
            'Listen transcript shows your lines as Me and the answer as Them.',
            'Those "them" lines are now CONFIRMED for the next Ask: 10M DAU, US only, 3 features in scope.'
        )
    },
    @{
        n = 3; title = 'STEP 3 - Check-in, then design (expect: DESIGN KIT)'
        brief = @('First say aloud:')
        say = @('The Check-in line: "To sum up: we are building ... Anything you would change before I design?"')
        interviewer = "That sounds right. Go ahead with the high-level design."
        type = 'design'
        check = @(
            'Six headings: Requirements used, API, Design, Deep dives, Check against requirements, Next questions.',
            'Requirements used: 10 million DAU (confirmed), US only (confirmed), the 3 features (confirmed).',
            'NO multi-region section; at most one line about it under Next questions.',
            'Numbers agree with the step-1 Estimates (the opening kit was sent as the previous answer).',
            'Note the Decisions line (e.g. push fan-out, pull for celebrities, timelines in Redis).',
            'This kit replaces the opening kit as the saved previous answer.'
        )
    },
    @{
        n = 4; title = 'STEP 4 - Deep dive (expect: DEEP DIVE)'
        brief = @('Say aloud the sentence under the diagram, then listen.')
        say = @('The "> ..." line under the ASCII diagram.')
        interviewer = "Let's go deeper. What happens when a celebrity with 50 million followers posts a tweet?"
        type = 'deep dive celebrity fan-out'
        check = @(
            'Starts with "## Deep dive: ...". No tables. At most ~300 words.',
            'Problem / Options / Pick / Switch if / Failure mode / Alert on, then a line to say aloud.',
            'The Pick agrees with the step-3 Decisions line (same threshold, same stores).',
            'The saved previous answer is still the step-3 kit (a deep dive never replaces it).'
        )
    },
    @{
        n = 5; title = 'STEP 5 - Probe (expect: PROBE)'
        brief = @('Read the deep dive line aloud, then listen.')
        say = @('The "> ..." line at the end of the deep dive.')
        interviewer = "Okay. And what if the timeline cache cluster goes down?"
        type = 'what if the timeline cache goes down?'
        check = @(
            'No headings. One "> ..." line of at most 25 words, 2-3 bullets, a "Trade-off:" line.',
            'At most ~90 words. It talks about YOUR cache from step 3 (e.g. the Redis timelines).',
            'The saved previous answer is still the step-3 kit.'
        )
    },
    @{
        n = 6; title = 'STEP 6 - The interviewer changes a requirement (expect: new DESIGN KIT)'
        brief = @('Read the probe line aloud, then listen.')
        say = @('The "> ..." line of the probe.')
        interviewer = "Good. Now suppose we launch in Europe too, and the feed has to survive a full region outage."
        type = 'design'
        check = @(
            'A new design kit that says what changed (Europe + region outage are now confirmed).',
            'Multi-region now appears, because the requirements need it.',
            'The Decisions line is updated; the rest of the step-3 design is kept where it still fits.',
            'This kit becomes the saved previous answer.'
        )
    },
    @{
        n = 7; title = 'STEP 7 - Probe against the new design (expect: PROBE)'
        brief = @('Say one line about the region failover, then listen.')
        say = @('Any line from the new kit, e.g. the one under the diagram.')
        interviewer = "Why not just use a single SQL database for the tweets?"
        type = 'why not SQL for tweets?'
        check = @(
            'Probe shape again (<= 90 words).',
            'It agrees with the STEP-6 design (two regions), not the step-3 one.'
        )
    },
    @{
        n = 8; title = 'STEP 8 (optional) - Practice drill (expect: FULL)'
        brief = @('Practice only: both kits back to back, as a study sheet.')
        say = @()
        interviewer = ''
        type = 'full'
        check = @(
            'The opening kit, then the design kit (~1,200 words). Too long for a live round.',
            'It is saved as the previous answer, so do it at the end, not mid-interview.'
        )
    },
    @{
        n = 9; title = 'STEP 9 - Reset (memory is per Listen session)'
        brief = @('In Glass press Stop, then Listen again (new session, empty transcript).')
        say = @()
        interviewer = ''
        type = 'what if the timeline cache goes down?'
        check = @(
            'The answer no longer knows your design: no 10M, no US/Europe, no Decisions from before.',
            'Stop cleared the transcript and ended the session, so the saved kit was dropped.',
            'Then press Stop in Glass. Simulation done.'
        )
    }
)

foreach ($s in $steps) {
    if ($s.n -lt $Step) { continue }
    Clear-Host
    Show-Block $s.title $s.brief 'Yellow'
    if ($s.say.Count -gt 0) { Show-Block 'YOU SAY (into the mic):' $s.say 'Green' }
    if ($s.n -eq 0) { Wait-Enter 'Press Enter when Listen is running'; continue }

    Wait-Enter 'Press Enter after you have spoken (the screen clears before the Ask)'
    Clear-Host
    if ($s.interviewer) {
        Write-Host "Step $($s.n): interviewer speaking..." -ForegroundColor Magenta
        [void]$voice.Speak($s.interviewer)
        Start-Sleep -Milliseconds 1500   # let STT finish the turn
    }
    Write-Host ""
    if ($s.type -like '(*') {
        Write-Host "NO ASK IN THIS STEP: just check the Listen transcript." -ForegroundColor White
        Wait-Enter 'Press Enter when the transcript shows the line'
    } else {
        Write-Host "TYPE IN ASK:  $($s.type)" -ForegroundColor White
        Wait-Enter 'Press Enter when the answer has finished streaming'
    }
    Show-Block 'CHECK:' $s.check 'Cyan'
    Wait-Enter 'Press Enter for the next step'
}
Write-Host "Done." -ForegroundColor Green
