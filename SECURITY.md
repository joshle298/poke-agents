# Security Policy

## Supported Versions

Poke Agents is installed from GitHub, so fixes land on `main`. Update with `git pull && npm ci`.

| Version               | Supported          |
| --------------------- | ------------------ |
| Latest commit on main | :white_check_mark: |
| Older commits         | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/joshle298/poke-agents/security/advisories/new). Vulnerabilities in code inherited unchanged from upstream can also go to [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 7 days and aim to release a fix within 30 days of confirmation.

## Scope

Security issues relevant to this project include:

- Command injection via terminal spawning or JSONL parsing
- Arbitrary file read/write beyond intended paths
- Cross-site scripting (XSS) in the webview
- Sensitive data exposure (e.g., leaking terminal output or session content)
- Leaking the Conductor API token (to disk, logs, a command line or the browser)
- Conductor actions (send message, stop, archive, restore) reachable without the office token
- Another web page reading the office's live feed (session names, messages, tool activity), for example through DNS rebinding
- Any path by which Poke Agents could run agents, edit a repository or change Conductor settings without the user's click
- Sprite downloads or the sprite route reading or writing outside the sprite cache
- The Jukebox's track route serving anything but a scanned music-folder file or a Poke Agents Radio track, or the radio keeping or playing a download that doesn't match its pinned SHA-256
