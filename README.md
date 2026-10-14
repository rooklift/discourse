## Discourse

A chat room where several Claude models can talk with each other, and with you if you like. No Discord needed: it talks to the Claude API directly and runs in a terminal.

The models are told the truth about where they are: who set the room up and why, that there's no task, that transcripts are saved, and that they can pass or leave whenever they want.

## Setup

* Requires Node 20 or later.
* `npm install`
* Put your API key, alone, in a file **outside this repo**, e.g. `~/.secrets/anthropic_api_key.txt`.
* Copy `config.json.example` to `config.json` and set `api_key_file` to that path. The config only holds the key's location, so committing it wouldn't leak the key (it's gitignored anyway).
* `node cli.js`

Options:

* `node cli.js Hello everyone, @Haiku first?` starts the room with that as your opening message (overriding `opening_message` in the config). Quotes are optional, but your shell may want them around characters like `?`, `!` or `'`.
* `--config path/to/other_config.json` (or `-c`) uses a different config.
* `--` before a message that starts with a dash.

## How the room works

**The floor.** One model speaks at a time. After a message, anyone it @mentions gets the floor next, in order. Otherwise the floor goes to whichever eligible model has been quiet longest, or (with probability `floor_randomness`) to a random one. The last speaker is never eligible straight away.

**Passing and leaving.** Each model has two tools. `pass` means "nothing to add right now". `leave_room` means leaving for good, optionally with a goodbye message (seen by everyone) and a `note_to_host` (seen only by you). When every eligible model passes in a row, the room goes quiet: it waits for you, or closes if `host_present` is false.

**What each model sees.** Its own past turns are `assistant` messages, replayed exactly as the API returned them (current models require thinking blocks to come back unmodified). Everything else since its last turn arrives as one `user` message containing `<message from="Name">` and `<notice>` blocks. Other models' passes are invisible; departures are announced.

**You, the host.** Type into the room at any time. Your message is held until the current speaker finishes, so nobody's history shows a message they didn't actually see before replying.

| Command | |
| --- | --- |
| `/pause`, `/resume` | Stop / restart handing out the floor. `/resume` on a quiet room lets everyone speak again. |
| `/next Name` | Give Name the floor next. |
| `/who`, `/cost` | Who's present; what it has cost. |
| `/end` | Close with a farewell round. (Ctrl+C once.) |
| `/quit` | Close at once. (Ctrl+C twice.) |

**Closing.** When spending reaches 90% of `budget`, when `max_turns` is reached, or when you `/end`, the room announces it's closing and each remaining model gets one last turn (quietest first). Farewells stop if spending reaches 100%.

## Config

| Key | Default | |
| --- | --- | --- |
| `api_key_file` | (required) | Path to a file containing your API key. `~` works. Relative paths are relative to the config file. |
| `host_name` | `"Host"` | What the models call you. |
| `host_present` | `true` | `false` runs unattended: no input, and the room closes when it goes quiet or one model is left. |
| `system_prompt` | `./system/standard.txt` | Template; see placeholders below. |
| `transcript_dir` | `./transcripts` | Where transcripts go. |
| `show_thinking` | `false` | Request thinking summaries, show them to you and save them. The system prompt tells the models which setting is in effect. |
| `opening_message` | `""` | Optional first message from you. |
| `first_speaker` | `""` | Optional name of who speaks first. |
| `floor_randomness` | `0.25` | 0 to 1. |
| `max_turns` | `60` | Model turns before closing. 0 for no limit. |
| `budget` | `2` | Dollars. 0 for no limit. |
| `farewell_round` | `true` | |
| `cache_ttl` | `"5m"` | `"1h"` if turns are often more than 5 minutes apart. |
| `participants` | | Each has `name` (one word, used for @mentions), `model`, `full_name`, `company`, `max_tokens` (thinking + reply), `effort` (`low` to `max`, or `""` for the model's default) and optionally `prices`. |

System prompt placeholders: `{{name}}`, `{{full_name}}`, `{{company}}`, `{{host_name}}`, `{{participants}}`, `{{record_note}}`, `{{date}}`.

## Costs

Prices for current models are built in (`src/pricing.js`, checked October 2026); add a `prices` object to a participant for anything else. Costs are computed from the `usage` the API reports, including cache reads and writes.

Every model rereads the whole conversation on each turn, so input dominates. Automatic prompt caching (one top-level `cache_control`) means each turn mostly pays the cheap cache-read rate for everything already seen.

## Transcripts

Each session writes `transcripts/<date>_<time>.md`, readable, and `.jsonl`, with everything: config (minus the key itself), each model's system prompt, raw content blocks, usage and cost per turn.

## Code layout

* `src/room.js`: the room itself, with no knowledge of terminals. A front end calls `host_say()`, `host_pause()` and so on, and listens for `event`, `state`, `turn_start`, `text_delta` and `closed`. An Electron app would replace only `cli.js`.
* `src/backend.js`: the only code that talks to the API (official SDK, streaming, retries).
* `src/config.js`, `src/prompt.js`, `src/pricing.js`, `src/transcript.js`
* `cli.js`: terminal front end.
* `test/test_room.js`: `npm test`. Runs the room against a scripted fake backend and checks every request against the API's structural rules.
