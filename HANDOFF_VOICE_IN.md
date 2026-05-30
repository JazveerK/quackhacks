# PhysioFusion — Voice IN brief (Agent C)

Hands-free voice commands for the dashboard. The user (patient) talks to the
app while squatting; their voice triggers a small fixed vocabulary of
commands. Voice runs entirely in the browser — no backend changes needed.

## Why Web Speech API (not Whisper)

This is **command spotting**, not transcription:
- Four fixed words to detect.
- Must feel instant (no 1–3s server round-trip).
- Demo runs on one laptop in Chrome you control.
- Sending audio to a remote Whisper API costs latency per utterance and
  adds a network failure mode.

Web Speech API is built into Chrome/Edge, runs locally, returns words
faster than the user can finish saying them, and matches against a
four-word whitelist where minor accuracy issues don't matter.

Save Whisper for the *conversational* voice agent if you build it later.

## Wake word + vocab

| Spoken | Backend WS command | Notes |
|---|---|---|
| "Hey coach, end set" | `{"cmd":"end_set"}` | Manual set termination |
| "Hey coach, next set" | `{"cmd":"reset_set"}` | Start next set with same profile |
| "Hey coach, reset" | `{"cmd":"reset_set"}` | Same; just a different verbal trigger |
| "Hey coach, how am I doing" | (frontend-only) | TTS reads current `rep_count` / `tempo` / `depth_state` aloud |

Wake word: **"Hey coach"**. We use a wake word (not always-on
command-listening) because the dashboard runs at a hackathon booth — random
crowd chatter saying "reset" or "end" cannot be allowed to fire the command.

## Recognition flow

1. Start a `webkitSpeechRecognition` instance with `continuous = true`,
   `interimResults = true`, `lang = "en-US"`.
2. On each `onresult`, look at the most recent transcript. If the words
   "hey coach" appear, **arm** for the next ~3 seconds — set a flag.
3. While armed, scan transcripts for any of the four commands. On match:
   - send the corresponding WS command (or call the local TTS for
     "how am I doing"),
   - clear the armed flag immediately,
   - briefly visually confirm in the UI (e.g. a small toast: "End set").
4. If 3s pass without a recognized command, disarm.
5. Re-arm on the next "hey coach".

This two-step (wake → command) cuts false fires dramatically without
needing a heavy on-device wake-word model.

## Fallback layers (don't skip — the demo will thank you)

1. **Push-to-talk**: hold **spacebar** to force "armed" state regardless of
   wake word. Lets a judge bypass voice entirely.
2. **On-screen button per command**: render four buttons on the dashboard
   (End Set / Next Set / Reset / How am I doing). If voice flakes at the
   booth, clicking the button takes the exact same code path.
3. **Mic-denied / unsupported browser**: silently disable voice, log a
   one-line notice in the corner. The on-screen buttons keep everything
   working.

Always-on rule: every voice command MUST have a button equivalent. Voice is
a feature, not a load-bearing dependency.

## Code sketch

```js
// voice.js — drop into your dashboard
const SUPPORTED = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
const WS = /* your existing /ws WebSocket */;

const COMMANDS = {
  "end set":          () => WS.send(JSON.stringify({ cmd: "end_set" })),
  "next set":         () => WS.send(JSON.stringify({ cmd: "reset_set" })),
  "reset":            () => WS.send(JSON.stringify({ cmd: "reset_set" })),
  "how am i doing":   () => speakCurrentStatus(),
};

let armed = false;
let armedUntil = 0;

function arm() {
  armed = true;
  armedUntil = Date.now() + 3000;
  showToast("Listening…");
}

function tryCommand(transcript) {
  const t = transcript.toLowerCase().trim();
  // Wake word: arm and continue scanning the same transcript.
  if (t.includes("hey coach")) arm();
  if (!armed || Date.now() > armedUntil) return;
  for (const phrase in COMMANDS) {
    if (t.includes(phrase)) {
      armed = false;
      showToast(phrase);
      COMMANDS[phrase]();
      return;
    }
  }
}

if (SUPPORTED) {
  const R = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
  R.continuous = true;
  R.interimResults = true;
  R.lang = "en-US";
  R.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    if (last && last[0]) tryCommand(last[0].transcript);
  };
  R.onend = () => R.start();  // restart if Chrome stops it (it will)
  R.start();
}

// Push-to-talk fallback
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) arm();
});

function speakCurrentStatus() {
  // Read the latest state from your live state cache.
  const s = window.latestState;
  if (!s) return;
  const utter = new SpeechSynthesisUtterance(
    `${s.rep_count} of ${s.rep_target} reps. Last rep ${s.depth_state.replace("_"," ")}.`
  );
  speechSynthesis.speak(utter);
}
```

The four on-screen buttons just call the same handlers in `COMMANDS`.

## Tuning tips

- **Confidence threshold**: Web Speech doesn't expose it well; rely on
  the wake-word arming + tight whitelist instead.
- **Restart loop**: Chrome stops `webkitSpeechRecognition` after long
  silence — always re-`start()` in `onend`.
- **Throttle "how am I doing"** — don't let it talk over the agent
  debrief; check `phase === "DEBRIEF"` and skip if so.
- **Wake-word case**: `t.toLowerCase()` because Web Speech sometimes
  capitalizes mid-sentence.

## Things to NOT do

- Don't add OpenAI Whisper or ElevenLabs STT for these commands. That's
  picking the slowest tool for the smallest job. Save them for the
  conversational agent if you build it.
- Don't make voice load-bearing. Buttons stay on screen.
- Don't fire commands without arming. A booth visitor saying "reset
  please" can't be allowed to wipe a set mid-demo.
- Don't speak status while the AI debrief is playing — they'll talk over
  each other.
