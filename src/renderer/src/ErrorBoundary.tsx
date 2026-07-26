import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { t } from './i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Last line of defence for the renderer. Without it, a throw during render
 * unmounts the whole tree and leaves a blank white window — which looks exactly
 * like a crash the user cannot report, because the message only ever reached
 * devtools. Here they get the message, and a reload that does not lose the
 * document: annotation drafts live in the main process keyed by path, so a
 * reloaded window picks them straight back up.
 *
 * This deliberately does NOT try to recover in place. A component that threw
 * mid-render has unknown state, and re-rendering it is how you turn one bad
 * frame into a loop.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[pdfx] render error:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h1>{t('crash.title')}</h1>
        <p>{t('crash.body')}</p>
        <pre>{error.message}</pre>
        <button className="crash-reload" onClick={() => window.location.reload()}>
          {t('crash.reload')}
        </button>
      </div>
    )
  }
}
