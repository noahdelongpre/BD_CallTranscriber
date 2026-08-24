# VoiceTranscriber — Discord Voice Call Transcription Plugin

A BetterDiscord plugin that transcribes Discord voice calls **in real time**. It captures the call audio and your own microphone, streams them to a Whisper speech-to-text engine, and shows the transcript live in a floating "Voice Transcriber" panel while saving per-user transcript files to disk.

Built for BetterDiscord **v4** and the standalone plugin format (no ZeresPluginLibrary dependency).

---

## What it does

- **Live transcription** — a floating "Voice Transcriber" box shows lines as they're transcribed. It has a record/stop toggle, per-participant speech indicators, and a stats bar (elapsed time, chunks processed, word count).
- **Two-stream capture** — the plugin opens *two* separate audio inputs:
  1. the **call mix / loopback** (everyone else in the call) and
  2. your **microphone** — so your own voice is captured too, without routing the mic through a cable (no echo/feedback into your headphones).
- **Per-user transcript files** — when you stop, each speaker's transcript is saved to a file (TXT / Markdown / JSON).
- **Dynamic chunking** — audio is split into chunks that are transcribed as soon as you go quiet (~2s), up to a max chunk length, instead of always waiting a fixed window.
- **Adaptive silence suppression** — background hiss/room tone is filtered out so Whisper doesn't hallucinate repeated junk.
- **Hotkey** — `Ctrl+Shift+R` toggles recording.

---

## Requirements

| Component | Notes |
|---|---|
| **Discord** | The desktop application (not the web version). |
| **BetterDiscord** | v4 or newer. |
| **A transcription backend** | Either a self-hosted **Local Whisper Server**, or an **OpenAI** API key. See [Transcription backends](#transcription-backends). |
| **A virtual audio cable** | Only needed to capture the *other participants*. A VB-Cable / VB-Audio Virtual Cable or VoiceMeeter — so the call mix can be routed to the plugin. See [Audio routing](#audio-routing). |

---

## Installation

1. Copy `VoiceTranscriber.plugin.js` into the BetterDiscord plugins folder:
   - **Windows:** `%appdata%\BetterDiscord\plugins\`
   - **macOS / Linux:** `~/Library/Application Support/BetterDiscord/plugins/`
2. Reload Discord (`Ctrl+R`) or fully restart it.
3. Go to **User Settings → Plugins** and toggle **VoiceTranscriber** **ON**.

Already have it installed? Just drop the new `.plugin.js` over the old one and reload.

---

## Audio routing (important)

The plugin captures two inputs and treats them as separate streams:

1. **Your microphone** — taken from your OS *default input* device.
2. **The call mix** — the loopback device that carries the *other participants*. The plugin auto-selects the **VB-Cable "CABLE Output"** loopback (or your manually chosen device), and prefers the raw virtual cable over VoiceMeeter buses.

For the plugin to hear **everyone else**, Discord's **Output device** must be routed into the virtual cable that the plugin reads:

```
Discord Output  ─▶  CABLE Input  ─▶  CABLE Output  ─▶  (plugin captures this)
```

- In **Discord → Settings → Voice & Video → Output device**, select **"CABLE Input"** (the *same* cable whose output the plugin captures).
- Discord does not normally echo your own mic into its output, which is why the plugin also captures your mic separately to include you.
- If you hear only yourself in the transcript, the plugin is almost certainly reading a mic instead of the cable (see [Troubleshooting](#troubleshooting)).

---

## Transcription backends

### Local Whisper Server (recommended — self-hosted, no API key)

Run a Whisper-compatible HTTP server that accepts audio transcription requests and is reachable from Discord's renderer. A common setup is [`faster-whisper-server`](https://github.com/fedirz/faster-whisper-server) in Docker behind an nginx reverse proxy that adds the CORS headers the browser fetch needs.

1. Start your Whisper server.
2. In the plugin: **Transcription Backend → Local Whisper Server**.
3. Set **Local Whisper Server URL** to its address (default `http://localhost:9000`).
4. Click **Test Local Server** to verify it's reachable before recording.

> The server must respond to the transcription endpoint with permissive CORS headers (`Access-Control-Allow-Origin`) — otherwise the browser will block the requests.

### OpenAI Whisper API

1. Create an API key at [platform.openai.com](https://platform.openai.com/).
2. In the plugin: **Transcription Backend → OpenAI Whisper API**.
3. Paste the key into **API Key**.

---

## Usage

1. **Join a voice channel.**
2. Click the **record toggle** at the top-right of the "Voice Transcriber" box, or press **`Ctrl+Shift+R`**. *(You'll be prompted to join a voice channel first if you're not in one.)*
3. Speak / have others speak — lines appear in the box in real time, attributed when possible.
4. Click the toggle again (or `Ctrl+Shift+R`) to **stop**. Transcript files are written to the output directory and the box stays open for review.

The "Voice Transcriber" box can be dragged by its header, resized from the corner, minimized, and closed with the buttons in the header.

---

## Settings (reference)

Opened via **User Settings → Plugins → VoiceTranscriber → settings (gear)**.

| Setting | Default | Purpose |
|---|---|---|
| Transcription Backend | `OpenAI Whisper API` | `0` = OpenAI API, `1` = Local Whisper Server |
| API Key | *(empty)* | OpenAI key; only needed for the OpenAI backend |
| Local Whisper Server URL | `http://localhost:9000` | Address of the local Whisper server |
| Output Directory | `./transcripts` | Where per-user transcript files are saved. *(Relative paths resolve against Discord's working directory; an absolute path is safer.)* |
| Output Format | Plain Text (.txt) | `0` = `.txt`, `1` = Markdown `.md`, `2` = JSON `.json` |
| Chunk Duration (seconds) | `30` | Max length of an audio chunk sent for transcription |
| Flush Silence (ms) | `2000` | How long of quiet ends a speaking turn and transcribes it early |
| Min Chunk (seconds) | `1` | Smallest chunk allowed to flush early |
| Silence Threshold (level) | `1500` | Minimum signal level (0–32767) treated as speech; raise to suppress more hiss |
| Audio Input Device | *(auto)* | Manually force which loopback device the plugin captures instead of auto-detecting |

---

## Transcript output

When you stop a recording, one file is written **per user** into the output directory, named:

```
<Username>_<YYYY-MM-DD_HHMMSS>.<ext>
```

- **TXT** — plain text, one line per utterance (`[HH:MM:SS] text`).
- **Markdown** — a table of `Timestamp | Text`.
- **JSON** — structured `{ user, session, channel, date, entries[] }`.

---

## Speaker attribution

Attribution is **best-effort**. The call-mix capture is a single mixed stream with no per-speaker separation, so each chunk is labeled with whoever Discord reports as most recently speaking during that window (from Discord's speaking events), with a fallback to the most recently speaking participant or, in a one-on-one call, the other participant. Your own mic stream is labeled as you. When two people talk at once, only the speaker overlapping the window the most can be assigned.

---

## Testing / development

- `scripts/verify.js` is a mocked-BD load test harness (`node scripts/verify.js`) that exercises the real load path — plugin load, settings, event wiring, capture, attribution, error bus, and cleanup. It should pass before shipping a change.
- The plugin is a single self-contained `VoiceTranscriber.plugin.js`; there is no build step.

---

## Troubleshooting

### I only hear myself in the transcript (no other participants)
The plugin is reading a microphone instead of the call mix, or Discord's output isn't routed into the captured cable.

- Open Discord DevTools (`Ctrl+Shift+I` → Console). Look for:
  `AudioCapture: call stream label: "..." ; mic stream label: "..."`
  The **call stream** should say `CABLE Output`/a virtual cable — if it says your mic, the device selection fell through.
- Confirm **Discord → Settings → Voice & Video → Output device** is set to **"CABLE Input"** (the same cable whose output the plugin captures), then fully restart Discord.
- Set **Audio Input Device** in the plugin to the correct loopback explicitly if auto-detect picks wrong.

### Junk words / repeated gibberish in the transcript
The adaptive silence gate should drop background hiss, but if it slips through, raise **Silence Threshold (level)** in settings.

### Transcript lines appear labeled `call_audio` / no speaker names
Discord's speaking-event relay can vary by version, so attribution degrades to a generic label when no speaking signal is available. Check the console for `speaking event -> <name> ...` while someone talks. If you never see it, Discord isn't exposing per-user speaking state in a way this version reads — you'll still get transcripts, just without reliable per-speaker names.

### Files not saving / "file write error"
- Make sure **Output Directory** exists and is writable; prefer an absolute path.
- Check the DevTools console for the specific error message.

### Plugin not loading / "Plugin is not a valid format"
- You must be on BetterDiscord **v4** (this uses the standalone format, not ZeresPluginLibrary).
- Verify the file is in the plugins folder and its name ends in `.plugin.js`.

---

## Disclaimer

This plugin is not affiliated with or endorsed by Discord Inc. Voice recording/transcription may be regulated or require consent where you live — always inform participants before recording a call and respect Discord's Terms of Service.