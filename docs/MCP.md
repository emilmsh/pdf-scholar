# Your notes in Claude, Codex and other AI tools

PDF Scholar can let an AI tool on your computer search what you have noted
in your papers: your highlights (with the words they mark), comments, notes
and text boxes, and your conversations with PDF Scholar's assistant, along
with the passages each answer cited. Ask Claude Code "what did I note about
identification in the minimum-wage papers?" while you write, and it looks it
up across every paper you have read in PDF Scholar, without opening a PDF.

**Nothing has to be downloaded or installed.** MCP, the standard these tools
use to reach other programs, is built into them. What a tool needs is a line
in its own settings that names a program to start. Here the program is part
of the PDF Scholar desktop app (Windows, macOS and Linux), and PDF Scholar
writes that line for you when you turn a tool on.

- [Turning a tool on: Claude and Codex](#turning-a-tool-on)
- [Other tools that support MCP](#other-tools)
- [A tool that cannot connect: copy and paste](#a-tool-that-cannot-connect)
- [Turning it off, and keeping things out](#turning-it-off-and-keeping-things-out)
- [What a tool can read](#what-a-tool-can-read) · [Troubleshooting](#troubleshooting)

## Turning a tool on

1. In PDF Scholar, open the settings menu (the gear at the top right) and
   choose **AI tools (Claude, Codex …)**.
2. Turn on the switch for the tool:
   - **Claude** covers Claude Code and Claude Desktop together. Claude Code is
     told through its own `claude mcp add` command, at user scope, so the
     server is there in every project. Claude Desktop's
     `claude_desktop_config.json` gets the entry.
   - **Codex** covers the Codex CLI and Codex in the ChatGPT desktop app,
     which both read `~/.codex/config.toml`. In the ChatGPT app, switch to
     Codex: an ordinary ChatGPT chat runs in OpenAI's cloud and cannot start
     a program on your computer, so it never sees PDF Scholar (checked
     2026-10-29).
3. Start a new session in the tool. Claude Desktop needs a restart.

PDF Scholar changes nothing in a tool's configuration except its own
`pdf-scholar` entry, and refuses to touch a configuration file it cannot
read. Then ask the tool something that needs your notes. Mentioning
"PDF Scholar" or "my notes" helps it pick the right tool. In Claude Code,
`/mcp` (or `claude mcp list` in a terminal) shows `pdf-scholar` as connected.

All switches are off until you turn one on. When a switch goes on, PDF
Scholar also reads, in the background, the annotations of the papers in your
recent list that it has not read since they last changed. That way, papers
you marked up before the tools existed come in too, without being opened
again.

## Turning it off, and keeping things out

Everything is in the same dialog.

- **A tool:** turn its switch off. That removes PDF Scholar from the tool's
  configuration, and the server refuses that tool from the same moment, even
  if the entry is still somewhere. Each entry PDF Scholar writes names the
  tool it is for (`--client claude`), so one switch never lets another tool in.
- **One document:** each document with notes or conversations has its own
  switch under **What the tools may read**. In the sidebar's **Annotations**
  tab, **Change** next to "Shared with AI tools" opens the dialog on that
  document.
- **A whole folder:** **Keep a folder out …** under **Folders kept out**.
  Everything in it is covered, including files added later. Each folder is
  listed with a × to let it back in.

A document kept out gives a tool neither its notes nor its conversations.
Another conversation that drew on it shows it only as "a conversation",
without its name.

If PDF Scholar cannot find the `claude` command (it looks in `~/.local/bin`
and on the PATH), the Claude row offers **Copy command** instead. Run that
line in a terminal.

## Other tools

Any tool that runs local (stdio) MCP servers can use it. Turn on **Other
tools**, then click **Copy setup**. It puts the server on your clipboard in the
common `mcpServers` form, with the real paths of your installation filled in:

```json
{
  "mcpServers": {
    "pdf-scholar": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\PDF Scholar\\PDF Scholar.exe",
      "args": ["C:\\Users\\you\\AppData\\Roaming\\PDF Scholar\\mcp\\pdf-scholar-mcp.cjs", "--client", "other"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

The server is PDF Scholar's own executable running a small script in Node
mode (`ELECTRON_RUN_AS_NODE=1`). It opens no window and no network port, and
it does not need PDF Scholar to be open. A tool set up by hand is removed from
its own configuration by hand, but turning **Other tools** off shuts it out at
once.

Where the entry goes, and in what shape, is up to each tool. Look in its own
documentation for how it adds an MCP server. Many take the `mcpServers` block
above as it is; a tool with a form of its own needs the same three things:
the command, the arguments and the environment variable.

The paths in the entry, for reference:

| Installation | Executable | Script |
| --- | --- | --- |
| Windows installer | `%LOCALAPPDATA%\Programs\PDF Scholar\PDF Scholar.exe` | `%APPDATA%\PDF Scholar\mcp\pdf-scholar-mcp.cjs` |
| Windows portable zip | `PDF Scholar.exe` in the unpacked folder | `data\mcp\pdf-scholar-mcp.cjs` in the same folder |
| macOS | `/Applications/PDF Scholar.app/Contents/MacOS/PDF Scholar` | `~/Library/Application Support/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |
| Linux, AppImage | the `.AppImage` file itself | `~/.config/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |
| Linux, .deb | `/opt/PDF Scholar/pdf-scholar` | `~/.config/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |

## A tool that cannot connect

A chat in the browser cannot start a program on your computer, and neither
can a tool that does not support MCP. Use **Copy for AI** instead. It is in
the **Annotations** tab of the sidebar, under the export buttons. It copies
the open document's highlights, comments and AI conversations as text, ready
to paste into any chat. This also works in the browser extension.

## What a tool can read

The server is read-only and offers four tools:

| Tool | What it answers |
| --- | --- |
| `search_notes` | Every highlight, comment, note and AI conversation containing all the words searched for, across all papers, grouped by paper with page numbers |
| `list_documents` | The papers you have annotated or discussed, newest first, with title, DOI, counts and a short id |
| `get_document_notes` | Everything about one paper, by its id or words from its name: its annotations by page and its conversations in full |
| `get_conversation` | One conversation, by the id the other tools give |

- **Never the PDFs themselves.** What a tool gets is what you marked, wrote and
  asked, plus the passages the answers cited.
- **Never images.** Pictures attached to a conversation are mentioned, not sent.
- **Never where a file lives.** A document is named by its file name and a short
  id. No path and no folder name is sent, since a folder can be named after a
  client. A mark's author is not sent either.
- **Nothing about a password-protected document or one you kept out**: neither
  notes nor conversations.
- **A tool whose switch is off** has every request refused, at once. The
  switches are separate from **AI access** in the assistant's settings, which
  governs PDF Scholar's own assistant.
- What a tool reads goes to **the AI provider that tool uses**, under that
  tool's terms. That is what turning it on means. See [PRIVACY.md](PRIVACY.md).

A document's notes are recorded when you open it in PDF Scholar and whenever
its annotations change. Papers in your recent list are also read in the
background while a tool is on, as described above. Older papers outside the
recent list come in the first time you open them again.

## Troubleshooting

- **The tool says the server failed to start.** Turn its switch off and on
  again in PDF Scholar. That puts the script back in place. For a tool set up
  by hand, check that both paths in the entry exist.
- **"PDF Scholar is not sharing with this tool".** Turn on its switch under
  **AI tools** in PDF Scholar's settings menu. A hand-made entry without
  `--client` answers to **Other tools**.
- **Claude Desktop shows no PDF Scholar tools.** Restart Claude Desktop after
  turning Claude on.
- **Check from Claude Code:** `claude mcp list` should list `pdf-scholar` as
  connected.
- **Microsoft Store version.** A Store app cannot be started by another program,
  so the Store version cannot be connected. The installer from the
  [latest release](https://github.com/emilmsh/pdf-scholar/releases/latest) can.
  The two keep their settings and conversations separately.
- **Browser extension.** A browser extension cannot run a program on your
  computer, so it has no server. **Copy for AI** works there.
