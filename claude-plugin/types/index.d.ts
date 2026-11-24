/** One passage PDF Scholar was asked to show: what a button needs to show it
 *  again. `n` is the number PDF Scholar gave it — the «[3]» Claude writes
 *  beside its claim, and the number on the card in PDF Scholar's own list. */
export type Reference = {
  n: number
  /** The MCP server the tool belongs to, as its tool names spell it */
  server: string
  path: string
  page: number
  quote: string
  isFound: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pdf-scholar': { references: Shaped<Reference[]> }
  }
}
