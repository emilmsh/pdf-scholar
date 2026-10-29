# Your notes in Claude Code, Claude Desktop, Codex and other AI tools

PDF Scholar can let an AI tool on your computer search what you have noted
in your papers: your highlights (with the words they mark), comments, notes
and text boxes, and your conversations with PDF Scholar's assistant, along
with the passages each answer cited. Ask Claude Code "what did I note about
identification in the minimum-wage papers?" while you write, and it looks it
up across every paper you have read in PDF Scholar, without opening a PDF.

**Nothing has to be downloaded or installed.** The server is part of the
desktop app (Windows, macOS and Linux). You connect each tool once, and the
app keeps your notes up to date for it in the background.

- [Claude Code and Claude Desktop: one click](#claude-code-and-claude-desktop)
- [Codex, opencode, Cursor, VS Code, Gemini CLI: one config entry](#other-tools)
- [ChatGPT: copy and paste](#chatgpt)
- [What a tool can read](#what-a-tool-can-read) · [Troubleshooting](#troubleshooting)

## Claude Code and Claude Desktop

1. In PDF Scholar, open the assistant (**Assistant**, top right) and click
   the model name at the top of the panel, then **API keys & providers**.
   The section is **AI tools on this computer**, just under **AI access**.
2. Click **Connect** next to Claude Code or Claude Desktop.
3. For Claude Desktop, restart it. Claude Code picks the server up the next
   time a session starts.

**Disconnect** removes PDF Scholar from that tool's configuration again. The app
changes nothing in the tool's configuration except its own `pdf-scholar` entry.

Claude Code is connected at user scope, so the server is there in every
project. If PDF Scholar cannot find the `claude` command (it looks in
`~/.local/bin` and on the PATH), the row offers **Copy command** instead; run
that line in a terminal.

## Other tools

Any tool that runs local (stdio) MCP servers can use it. In **AI tools on this
computer**, click **Copy setup**. It puts the server on your clipboard in the
common `mcpServers` form, with the real paths of your installation filled in:

```json
{
  "mcpServers": {
    "pdf-scholar": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\PDF Scholar\\PDF Scholar.exe",
      "args": ["C:\\Users\\you\\AppData\\Roaming\\PDF Scholar\\mcp\\pdf-scholar-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

The server is PDF Scholar's own executable running a small script in Node
mode (`ELECTRON_RUN_AS_NODE=1`). It opens no window and no network port, and
it does not need PDF Scholar to be open. **Copy setup** also puts the script
in place, so press it once even if you write the entry by hand.

Where each tool wants the entry:

| Tool | Where | Shape |
| --- | --- | --- |
| **Cursor** | `~/.cursor/mcp.json` | the `mcpServers` block above, as is |
| **Gemini CLI** | `~/.gemini/settings.json` | the `mcpServers` block above, as is |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | the `mcpServers` block above, as is |
| **VS Code** (Copilot) | `MCP: Open User Configuration` | `"servers"` instead of `"mcpServers"`, and `"type": "stdio"` in the entry |
| **Codex** | `~/.codex/config.toml` | TOML, below |
| **opencode** | `~/.config/opencode/opencode.json` | its own `mcp` block, below |

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.pdf-scholar]
command = 'C:\Users\you\AppData\Local\Programs\PDF Scholar\PDF Scholar.exe'
args = ['C:\Users\you\AppData\Roaming\PDF Scholar\mcp\pdf-scholar-mcp.cjs']
env = { ELECTRON_RUN_AS_NODE = "1" }
```

**opencode** (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pdf-scholar": {
      "type": "local",
      "command": [
        "C:\\Users\\you\\AppData\\Local\\Programs\\PDF Scholar\\PDF Scholar.exe",
        "C:\\Users\\you\\AppData\\Roaming\\PDF Scholar\\mcp\\pdf-scholar-mcp.cjs"
      ],
      "environment": { "ELECTRON_RUN_AS_NODE": "1" },
      "enabled": true
    }
  }
}
```

Take the two paths from **Copy setup**. For reference, they are:

| Installation | Executable | Script |
| --- | --- | --- |
| Windows installer | `%LOCALAPPDATA%\Programs\PDF Scholar\PDF Scholar.exe` | `%APPDATA%\PDF Scholar\mcp\pdf-scholar-mcp.cjs` |
| Windows portable zip | `PDF Scholar.exe` in the unpacked folder | `data\mcp\pdf-scholar-mcp.cjs` in the same folder |
| macOS | `/Applications/PDF Scholar.app/Contents/MacOS/PDF Scholar` | `~/Library/Application Support/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |
| Linux, AppImage | the `.AppImage` file itself | `~/.config/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |
| Linux, .deb | `/opt/PDF Scholar/pdf-scholar` | `~/.config/PDF Scholar/mcp/pdf-scholar-mcp.cjs` |

## ChatGPT

ChatGPT (on the web and in its desktop app) only connects to MCP servers on
the internet, not to a program on your own computer. Use **Copy for AI**
instead. It is in the **Annotations** tab of the sidebar, under the export
buttons. It copies the open document's highlights, comments and AI
conversations as text, ready to paste into ChatGPT or any other chat. This also
works in the browser extension.

## What a tool can read

The server is read-only and offers four tools:

| Tool | What it answers |
| --- | --- |
| `search_notes` | Every highlight, comment, note and AI conversation containing all the words searched for, across all papers, grouped by paper with page numbers |
| `list_documents` | The papers you have annotated or discussed, newest first, with title, DOI and counts |
| `get_document_notes` | Everything about one paper: its annotations by page and its conversations in full |
| `get_conversation` | One conversation, by the id the other tools give |

- **Never the PDFs themselves.** What a tool gets is what you marked, wrote and
  asked, plus the passages the answers cited.
- **Never images.** Pictures attached to a conversation are mentioned, not sent.
- **Nothing about a password-protected document**: neither notes nor
  conversations.
- **AI access → Off** in PDF Scholar's AI settings makes the server refuse every
  request, at once.
- What a tool reads goes to **the AI provider that tool uses**, under that
  tool's terms. That is what connecting it means. See [PRIVACY.md](PRIVACY.md).

A document's notes are recorded when you open it in PDF Scholar and whenever
its annotations change. A paper annotated before this version comes in the
first time you open it again. Annotations made in another program appear once
the file has been opened in PDF Scholar.

## Troubleshooting

- **The tool says the server failed to start.** Press **Copy setup** (or
  **Connect**) once in PDF Scholar. That puts the script in place. Then check that
  both paths in the entry exist.
- **"AI access is switched off in PDF Scholar".** Turn AI access back on in
  PDF Scholar's AI settings.
- **Claude Desktop shows no PDF Scholar tools.** Restart Claude Desktop after
  connecting.
- **Check from Claude Code:** `claude mcp list` should list `pdf-scholar` as
  connected.
- **Microsoft Store version.** A Store app cannot be started by another program,
  so the Store version cannot be connected. The installer from the
  [latest release](https://github.com/emilmsh/pdf-scholar/releases/latest) can.
  The two keep their settings and conversations separately.
- **Browser extension.** A browser extension cannot run a program on your
  computer, so it has no server. **Copy for AI** works there.
