# VoiceTranscriber — Installation & Setup

This guide covers getting the VoiceTranscriber BetterDiscord plugin installed and transcribing a call. It's focused on setup; see the [README](README.md) for what the plugin does and the full settings reference.

---

## Requirements

- **Discord** — the desktop application (not the web version).
- **BetterDiscord** — v4 or newer (the plugin uses the standalone v4 format; it does **not** use ZeresPluginLibrary).
- **A transcription backend** — either a [Local Whisper Server](#option-a-local-whisper-server-recommended) or an [OpenAI API key](#option-b-openai-whisper-api).
- **A virtual audio cable** — to capture the *other participants*. VB-Cable / VB-Audio Virtual Cable (or VoiceMeeter). See [Audio routing](#audio-routing).

---

## Install the plugin

1. Copy `VoiceTranscriber.plugin.js` into the BetterDiscord plugins folder:
   - **Windows:** `%appdata%\BetterDiscord\plugins\`
   - **macOS / Linux:** `~/Library/Application Support/BetterDiscord/plugins/`
2. Reload Discord (`Ctrl+R`) or fully restart it.
3. Go to **User Settings → Plugins** and toggle **VoiceTranscriber** **ON**.

To update an existing install, just drop the newer `.plugin.js` over the old file and reload.

---

## Audio routing

The plugin opens **two** separate audio inputs:

1. your **microphone** (from the OS *default input* device), so your own speech is captured, and
2. the **call mix / loopback** (everyone else), captured from a virtual cable.

The plugin auto-selects the VB-Cable **"CABLE Output"** loopback (preferring the raw virtual cable over VoiceMeeter buses).

For the plugin to hear the other participants, Discord's output must go into the cable the plugin reads:

```
Discord Output  ─▶  CABLE Input  ─▶  CABLE Output  ─▶  (plugin captures this)
```

- In **Discord → Settings → Voice & Video → Output device**, select **"CABLE Input"** (the same cable whose *output* the plugin captures).
- Discord doesn't echo your own mic into its output, which is why the plugin also captures your mic separately.
- If the transcript only ever shows you, the plugin is reading a mic instead of the cable — see [Troubleshooting](#troubleshooting).

---

## Set up a transcription backend

### Option A: Local Whisper Server (recommended — self-hosted, no API key)

Run a Whisper-compatible HTTP server that accepts transcription requests and is reachable from Discord's renderer (for example [`faster-whisper-server`](https://github.com/fedirz/faster-whisper-server) in Docker behind an nginx reverse proxy that adds CORS headers). A working nginx CORS config is included at `scripts/whisper-proxy.conf`.

1. Start your Whisper server.
2. In the plugin: **Transcription Backend → Local Whisper Server**.
3. Set **Local Whisper Server URL** (default `http://localhost:9000`).
4. Click **Test Local Server** to verify it's reachable before recording.

> The server must respond with permissive CORS headers (`Access-Control-Allow-Origin`), or the browser will block the requests.

### Option B: OpenAI Whisper API

1. Create an API key at [platform.openai.com](https://platform.openai.com/).
2. In the plugin: **Transcription Backend → OpenAI Whisper API**.
3. Paste the key into **API Key**.

---

## First run

1. **Join a voice channel.**
2. Click the **record toggle** at the top-right of the "Voice Transcriber" box, or press **`Ctrl+Shift+R`**.
3. Speak and have someone else speak — lines appear in the box in real time.
4. Click the toggle again (or `Ctrl+Shift+R`) to **stop**. Transcript files are written to the **Output Directory** (default `./transcripts`), named `<Username>_<YYYY-MM-DD_HHMMSS>.<ext>` (`txt`, `md`, or `json`).

If you can see your test phrase and the other person's speech in the transcript, it's working.

---

## Settings

All options live under **User Settings → Plugins → VoiceTranscriber → settings (gear)**: backend, API key, local server URL, output directory, output format (TXT/Markdown/JSON), chunk duration, flush silence, min chunk, silence threshold, and audio input device. See the **Settings (reference)** table in the [README](README.md) for what each one does.

---

## Troubleshooting

**Only hearing yourself / no other participants** — the plugin is reading a mic instead of the cable, or Discord's output isn't routed into the captured cable.

- Check the DevTools Console (`Ctrl+Shift+I`) for:
  `AudioCapture: call stream label: "…" ; mic stream label: "…"`
  The **call stream** should be a virtual cable, not your mic.
- Confirm **Discord → Settings → Voice & Video → Output device** is **"CABLE Input"**, then fully restart Discord.
- Force the device in the plugin's **Audio Input Device** setting if auto-detect picks wrong.

**Junk words / repeated gibberish** — raise **Silence Threshold (level)**; the adaptive gate drops hiss but can be tuned.

**Transcripts labeled `call_audio` / no speaker names** — speaker attribution is best-effort and depends on Discord exposing per-user speaking state; if the console shows no `speaking event -> …` lines, names may be unavailable.

**Files not saving** — make sure **Output Directory** exists and is writable (an absolute path is safest); check the console for the exact write error.

**Plugin not loading** — the plugin uses the standalone BetterDiscord **v4** format; check the file is in the plugins folder, ends in `.plugin.js`, and that you're on BD v4.

See the [README](README.md) for more detail.

---

*This plugin is not affiliated with or endorsed by Discord Inc. Always inform participants before recording a call and respect local laws and Discord's Terms of Service.*