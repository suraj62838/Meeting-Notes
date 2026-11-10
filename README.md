# Meeting Notes

A desktop app for macOS and Windows that records your meetings, transcribes them in English, Hindi and Hinglish with speaker labels, and writes Minutes of Meeting for you.

Built with the **REA (Reverse Engineer Anything)** plugin for Claude Code.

## Download

Get the installer for your computer from the [latest release](https://github.com/suraj62838/Meeting-Notes/releases/latest):

| Computer | File |
|---|---|
| Mac with Apple Silicon (M1 and newer) | `Meeting.Notes-0.1.0-arm64.dmg` |
| Mac with an Intel chip | `Meeting.Notes-0.1.0.dmg` |
| Windows 10/11 (64-bit) | `Meeting.Notes.Setup.0.1.0.exe` |

macOS 14 (Sonoma) or newer is required on Mac.

### First launch

The installers are not code-signed, so your computer will warn you the first time:

- **Mac:** open the `.dmg` and drag **Meeting Notes** into Applications. When you open it and macOS says it "can't be verified", go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **Windows:** when you see "Windows protected your PC", click **More info → Run anyway**.

## Features

- **Records both sides of the call:** your microphone and the system audio (the other people).
- **Transcription** in English, Hindi and Hinglish, with speaker labels. Long meetings are split at natural pauses.
- **Minutes of Meeting:** summary, agenda, discussion points, decisions and action items with owner and due date.
- **Export:** copy as Markdown or save as PDF.
- **Calendar:** connect an iCal link to see what meeting you're in.
- **Meeting links:** paste a Zoom, Google Meet or Teams link to open it. For Google Meet, a bot can join and capture the call.
- **Automatic meeting detection (macOS only):** notices when Zoom, Teams, a browser or another app starts using the mic, and knows when you're muted.
- **Your own AI key:** works with Groq (has a free tier), OpenAI or any OpenAI-compatible API. Keys are stored encrypted on your computer (macOS Keychain or Windows DPAPI).

## Setup

1. Install and open the app.
2. Allow **microphone** and **screen recording** access when asked (screen recording is how macOS lets apps capture system audio). On macOS, also allow **Accessibility** if you want mute detection.
3. Open **Settings → AI provider**, pick a provider and paste your API key. A free Groq key is available at [console.groq.com](https://console.groq.com/keys).
4. Start a recording. When you stop, click transcribe, then create the minutes.

Recordings stay on your computer. Audio and transcripts are only sent to the AI provider you choose.

## Build from source

Requires Node.js 22+. Building on a Mac also needs Xcode command line tools (for the Swift meeting detector).

```sh
npm install        # also compiles the macOS meeting detector
npm start          # run the app
npm test           # run the tests

npm run dist       # build Mac .dmg files (Apple Silicon + Intel) into dist/
npm run dist:win   # build the Windows .exe installer into dist/
```

## Project layout

| File | What it does |
|---|---|
| `main.js` | Electron main process: recording, files, settings, IPC |
| `renderer.js`, `index.html` | The app window |
| `preload.js` | Safe bridge between the window and the main process |
| `pcm-worklet.js`, `wav.js` | Audio capture and WAV encoding |
| `groq.js` | Transcription and minutes via Groq / OpenAI-compatible APIs |
| `mom.js` | Minutes of Meeting format, Markdown and PDF output |
| `calendar.js` | iCal calendar reading |
| `meeting-link.js` | Zoom / Meet / Teams link parsing |
| `bot.js` | Google Meet bot |
| `mic-watch.swift` | macOS helper that detects which apps are using the mic |
