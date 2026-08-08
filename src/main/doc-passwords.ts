// Passwords for encrypted documents, held for the session and nowhere else.
//
// A locked file is unlocked once, in the renderer: pdf.js refuses the bytes,
// the user types the password, pdf.js accepts it. The write engine then needs
// the same secret to open the draft — the draft is a byte copy of the original
// and is therefore encrypted the same way — so the renderer hands it over
// through `doc:unlock` and main keeps it here, keyed by the draft path the
// engine actually opens.
//
// In memory ON PURPOSE. The app's other state lives in plain JSON next to the
// recents list (src/main/storage.ts), and a document password written there
// would outlive both the session and anything the user agreed to. Losing these
// on quit is the feature, not a limitation.
const passwords = new Map<string, string>()

export function rememberPassword(key: string, password: string): void {
  passwords.set(key, password)
}

export function passwordFor(key: string): string | undefined {
  return passwords.get(key)
}

export function forgetPassword(key: string): void {
  passwords.delete(key)
}
