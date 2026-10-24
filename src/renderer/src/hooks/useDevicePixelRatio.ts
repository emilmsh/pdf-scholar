// The display's device pixel ratio, as React state.
//
// The page layout snaps every box edge to a whole device pixel (rotation.ts,
// issue #53), so it must know the ratio — and re-run when it changes: a
// window dragged onto a monitor of another scale, or the OS scale changed
// under a running app. `window.devicePixelRatio` fires no event of its own;
// the documented way is a media query on the current value, re-armed after
// every change since the query names the value it was armed with.
import { useEffect, useState } from 'react'

export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    let mql: MediaQueryList | null = null
    const arm = (): void => {
      mql?.removeEventListener('change', onChange)
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', onChange)
    }
    const onChange = (): void => {
      setDpr(window.devicePixelRatio || 1)
      arm()
    }
    arm()
    return () => mql?.removeEventListener('change', onChange)
  }, [])
  return dpr
}
