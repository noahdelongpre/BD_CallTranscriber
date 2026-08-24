# Installation Guide

This guide walks you through installing VoiceTranscriber on Windows and macOS, step by step.

## Prerequisites

Before installing VoiceTranscriber, you need:

- **Discord** (desktop application, not web version)
- **BetterDiscord** (Discord client mod)
- **A transcription API key** (from OpenAI, Deepgram, AssemblyAI, or similar)

---

## Step 1: Install BetterDiscord

BetterDiscord is required to run the VoiceTranscriber plugin.

### Windows

1. Download BetterDiscord from [betterdiscord.app](https://betterdiscord.app/)
2. Run the installer (`BetterDiscordSetup.exe`)
3. Select your Discord installation when prompted
4. Click **Install**
5. Discord will restart automatically

*Screenshots coming soon*

### macOS

1. Download BetterDiscord from [betterdiscord.app](https://betterdiscord.app/)
2. Open the downloaded `.dmg` file
3. Drag BetterDiscord to your Applications folder
4. Open BetterDiscord and follow the setup wizard
5. Select your Discord installation when prompted
6. Click **Install**
7. Discord will restart automatically

*Screenshots coming soon*

**Verify Installation**: After Discord restarts, you should see "BetterDiscord" in User Settings (gear icon).

---

## Step 2: Install VoiceTranscriber Plugin

### Method A: BetterDiscord Plugin Store (Easiest)

1. Open Discord
2. Click the **gear icon** (User Settings) near your username
3. Scroll down to the **BetterDiscord** section
4. Click **Plugins**
5. In the search bar, type "VoiceTranscriber"
6. Click **Install** on VoiceTranscriber
7. Toggle the plugin **ON** (the switch should turn green/blue)

*Screenshots coming soon*

### Method B: Manual Installation

#### Windows

1. Download the latest release:
   - Go to [GitHub Releases](https://github.com/yourusername/Discord_Call_Transcript/releases)
   - Download `VoiceTranscriber.plugin.js`

2. Open the plugins folder:
   - Press `Win + R` to open Run dialog
   - Type: `%appdata%\BetterDiscord\plugins\`
   - Press Enter

3. Copy `VoiceTranscriber.plugin.js` into the plugins folder

4. In Discord:
   - Go to **User Settings** → **Plugins**
   - Find **VoiceTranscriber** in the list
   - Toggle it **ON**

#### macOS

1. Download the latest release:
   - Go to [GitHub Releases](https://github.com/yourusername/Discord_Call_Transcript/releases)
   - Download `VoiceTranscriber.plugin.js`

2. Open the plugins folder:
   - Open Finder
   - Press `Cmd + Shift + G`
   - Enter: `~/Library/Application Support/BetterDiscord/plugins/`
   - Press Enter

3. Copy `VoiceTranscriber.plugin.js` into the plugins folder

4. In Discord:
   - Go to **User Settings** → **Plugins**
   - Find **VoiceTranscriber** in the list
   - Toggle it **ON**

*Screenshots coming soon*

---

## Step 3: Configure the Plugin

After installation, you need to set up your API key and preferences.

### Get an API Key

Choose one of these transcription services:

#### OpenAI Whisper (Recommended for beginners)

1. Go to [platform.openai.com](https://platform.openai.com/)
2. Sign up or log in
3. Navigate to **API Keys** in the dashboard
4. Click **Create new secret key**
5. Copy the key (starts with `sk-`)
6. **Important**: Add billing information to your account

#### Deepgram

1. Go to [deepgram.com](https://deepgram.com/)
2. Sign up for a free account
3. Navigate to **API Keys**
4. Create a new API key
5. Copy the key

#### AssemblyAI

1. Go to [assemblyai.com](https://www.assemblyai.com/)
2. Sign up for an account
3. Find your API key in the dashboard
4. Copy the key

### Configure Plugin Settings

1. In Discord, go to **User Settings** (gear icon)
2. Scroll to **BetterDiscord** → **Plugins**
3. Find **VoiceTranscriber** and click the **gear icon** next to it

4. **API Key**:
   - Paste your API key from the previous step
   - No spaces before or after the key

5. **Output Directory** (optional):
   - Default: `Documents/VoiceTranscripts/`
   - Change to any folder you prefer
   - Make sure the folder exists or the plugin will create it

6. **Transcription Backend**:
   - Select the service matching your API key
   - Example: If using OpenAI key, select "OpenAI Whisper"

7. **Hotkey** (optional):
   - Default: `Ctrl+Shift+R`
   - Click the field and press your preferred key combination

8. **Output Format** (optional):
   - Default: TXT
   - Choose your preferred format for saved transcripts

9. Click **Done** to save settings

*Screenshots coming soon*

---

## Step 4: Test the Installation

Verify everything is working:

1. **Join a voice channel** in any Discord server
2. **Press Ctrl+Shift+R** (or your custom hotkey)
3. **Look for the recording indicator** (red dot or "Recording" text)
4. **Speak a test phrase**: "Testing VoiceTranscriber, one two three"
5. **Check the overlay panel** for live transcription
6. **Press Ctrl+Shift+R again** to stop recording
7. **Navigate to your output directory** and open the transcript file

If you see your test phrase in the transcript, installation was successful! 🎉

---

## First-Run Checklist

Use this checklist to ensure everything is set up correctly:

- [ ] Discord desktop app is installed (not web version)
- [ ] BetterDiscord is installed and running
- [ ] VoiceTranscriber plugin is enabled (toggle is ON)
- [ ] API key is configured and valid
- [ ] Transcription backend matches your API key provider
- [ ] Output directory is set and accessible
- [ ] Hotkey is configured (default: Ctrl+Shift+R)
- [ ] Test recording completed successfully
- [ ] Transcript file was saved to output directory

---

## Platform-Specific Notes

### Windows

**Permissions**: If transcripts aren't saving, try running Discord as administrator:
- Right-click Discord shortcut
- Select **Run as administrator**

**Firewall**: Ensure Discord and the plugin can access the internet for transcription services.

**Audio Devices**: Check Windows Sound Settings to ensure your microphone is set as the default device.

### macOS

**Microphone Access**: 
1. Go to **System Preferences** → **Security & Privacy** → **Privacy**
2. Select **Microphone**
3. Ensure Discord is checked

**File Access**:
1. Go to **System Preferences** → **Security & Privacy** → **Privacy**
2. Select **Files and Folders**
3. Ensure Discord has access to your chosen output directory

**Audio Devices**: Check **System Preferences** → **Sound** → **Input** to ensure your microphone is selected.

---

## Updating the Plugin

### Automatic Updates (Plugin Store)

If installed from the plugin store, updates are automatic:
1. Restart Discord periodically
2. Updates will install automatically

### Manual Updates

1. Download the new version from GitHub
2. Replace the old plugin file with the new one
3. Restart Discord (Ctrl+R or Cmd+R)
4. Your settings are preserved

---

## Uninstalling

### Method 1: Through Discord

1. Go to **User Settings** → **Plugins**
2. Find **VoiceTranscriber**
3. Toggle it **OFF**
4. Click the **trash icon** to delete

### Method 2: Manual Removal

1. Navigate to the plugins folder (see installation paths above)
2. Delete `VoiceTranscriber.plugin.js`
3. Restart Discord

**Note**: Your transcript files in the output directory are not deleted automatically.

---

## Common Installation Issues

### Plugin doesn't appear in the list

**Windows**:
```
Check this path exists:
%appdata%\BetterDiscord\plugins\VoiceTranscriber.plugin.js
```

**macOS**:
```
Check this path exists:
~/Library/Application Support/BetterDiscord/plugins/VoiceTranscriber.plugin.js
```

### "Plugin failed to load" error

1. Ensure BetterDiscord is up to date
2. Try reinstalling the plugin
3. Check the BetterDiscord console for error details (Ctrl+Shift+I or Cmd+Option+I)

### Discord crashes after enabling plugin

1. Disable the plugin immediately
2. Check your API key format (no extra characters)
3. Try a different output directory
4. Report the issue on GitHub with crash logs

---

## Getting Help

If you encounter issues not covered in this guide:

1. **Check the Troubleshooting section** in [README.md](README.md)
2. **Search existing issues** on [GitHub](https://github.com/yourusername/Discord_Call_Transcript/issues)
3. **Create a new issue** with:
   - Your operating system and version
   - Discord version
   - BetterDiscord version
   - Plugin version
   - Detailed description of the problem
   - Screenshots if applicable

---

## Next Steps

Once installed and configured:

- Read the [README.md](README.md) for detailed usage instructions
- Explore advanced features like multi-format export
- Join the community Discord server for support
- Consider [contributing](CONTRIBUTING.md) to the project

Happy transcribing! 🎙️
