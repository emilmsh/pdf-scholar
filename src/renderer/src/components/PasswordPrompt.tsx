// The unlock prompt for an encrypted document. Shown INSTEAD of the error
// screen: a locked file is not a broken one, and Edge — the bar for what has to
// open at all — asks for the password rather than refusing the file.
//
// Modelled on the .confirm-dialog markup used for the unsaved-changes and
// external-update prompts, with a field added. The caller drives it as a
// promise (resolve(password) / resolve(null) on cancel), the same shape
// ExtensionApp uses for its external-update verdict.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'

interface Props {
  /** File name, so a prompt that appears over a pile of tabs says which one. */
  name: string
  /** True once a password has been rejected — the ask becomes "try again". */
  retry: boolean
  /** Whether this document's tab is the visible one. Inactive tabs are
   *  `visibility: hidden`, which makes both focusing and Esc meaningless — a
   *  background tab that happens to be locked must not eat the key the user
   *  aimed at the tab they are looking at. */
  active: boolean
  onSubmit(password: string): void
  onCancel(): void
}

export function PasswordPrompt({ name, retry, active, onSubmit, onCancel }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field, not the button: the only thing to do here is type. Keyed on
  // `active` as well as mount, because a prompt that opened in a background tab
  // cannot take focus until that tab is switched to.
  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  // Esc cancels, like every other dismissable surface in the app. Bound on the
  // window rather than the dialog so it works before anything has focus.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, onCancel])

  return (
    <div className="confirm-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <form
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault()
          if (value) onSubmit(value)
        }}
      >
        <p className="confirm-message">{t('password.title')}</p>
        <p className="confirm-detail">
          {retry ? t('password.retry', { name }) : t('password.detail', { name })}
        </p>
        <input
          ref={inputRef}
          className="password-input"
          type="password"
          value={value}
          autoComplete="off"
          aria-label={t('password.title')}
          aria-invalid={retry}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('app.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!value}>
            {t('password.unlock')}
          </button>
        </div>
      </form>
    </div>
  )
}
