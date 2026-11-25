# PDF Scholar for Claude Code

When Claude tells you what a PDF says, this plugin puts a button under the
answer for every passage it cited. Press one and
[PDF Scholar](https://github.com/emilmsh/pdf-scholar) comes up on the page with
the quoted words highlighted. The buttons stay under the answer, so you can
check the claims in any order and come back to them later.

```
Self-attention connects all positions in a constant number of steps [1],
while a recurrent layer needs O(n) [2].

[1] p. 6   [2] p. 6
```

(The page reads as your machine's language writes it: `s. 6` on a Norwegian
one.)

The number in the answer, the number on the button and the number on the card
in PDF Scholar's own list are the same reference.

## What you need

- The PDF Scholar desktop app, with Claude turned on under **AI tools** in the
  settings menu, and **Read together** turned on in the same dialog. That is
  what gives Claude the `show_passage` tool; see
  [Reading together](https://github.com/emilmsh/pdf-scholar/blob/master/docs/MCP.md#reading-together).
- Claude Code, in the terminal or in the Code tab of the desktop app. Written
  for and tested with 2.1.330; its tests need that version or later.

Without the plugin everything still works. Claude writes the numbers, and you
find the matching card in PDF Scholar's list yourself.

## Install

In a Claude Code terminal session:

```
/plugin install pdf-scholar-buttons --marketplace emilmsh/pdf-scholar
```

Answer `y` to add the marketplace, then choose a scope. In the desktop app,
click **+** next to the prompt box, then **Plugins**, **Add marketplace** with
`emilmsh/pdf-scholar`, then **Add plugin**.

## What it does, exactly

- It watches the calls Claude makes to PDF Scholar's `show_passage` tool and
  notes each reference PDF Scholar numbered: the document's path, the page and
  the quoted words. That is what Claude already sent; nothing more is read from
  PDF Scholar, and nothing is sent anywhere. For a number it has not noted, it
  looks the call up in the session's own transcript.
- Under an answer that contains `[3]`, it draws a button for reference 3. A
  press calls `show_passage` again on PDF Scholar's server, asking it to show
  the passage. The reference keeps its number and no second card is made.
- A quote PDF Scholar could not find in the document is marked `✗` on its
  button.
- The notes are kept for the session only.

It adds no tool for Claude to call, changes no prompt, and touches no other
tool's calls.

## Developing

```
claude plugin validate claude-plugin
claude plugin test claude-plugin
```

Load it from the folder with `claude --plugin-dir claude-plugin`.

The plugin is deliberately not named `pdf-scholar`: that is the name of PDF
Scholar's MCP server, and a plugin's own tools live under the same
`mcp__<name>__…` names. The first release shared the name and drew no button
against the real server.

MIT, like PDF Scholar itself.
