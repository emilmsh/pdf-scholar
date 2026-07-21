// Small stroke-based icons in the style of PDF Expert's minimal line icons.
interface IconProps {
  size?: number
  className?: string
}

function Svg({
  size = 18,
  className,
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}

export const IconChevronLeft = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
)

export const IconChevronDown = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)

export const IconPlus = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const IconMinus = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
)

export const IconFitWidth = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7 8l-4 4 4 4M17 8l4 4-4 4M3 12h18" />
  </Svg>
)

export const IconFitPage = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="6.5" y="3.5" width="11" height="17" rx="1.5" />
    <path d="M2.5 8.5v-5h5" />
    <path d="M21.5 15.5v5h-5" />
  </Svg>
)

export const IconActualSize = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5.5 9l2.5-2v10" />
    <path d="M16 9l2.5-2v10" />
    <path d="M12 10.4v.01M12 14.6v.01" />
  </Svg>
)

export const IconExpand = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
)

export const IconDocument = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const IconFolderOpen = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5.5a2 2 0 0 0-1.94 1.5L2 17.5V7z" />
    <path d="M2 17.5L3.56 11.5A2 2 0 0 1 5.5 10H21a1 1 0 0 1 .97 1.24l-1.4 5.76A2 2 0 0 1 18.63 19H4a2 2 0 0 1-2-1.5z" />
  </Svg>
)

export const IconTextSettings = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 18L10.5 5h1L18 18M6.5 13.5h9" />
  </Svg>
)

export const IconFullscreen = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
)

/** Toolbar pinned: an angled thumbtack, driven in */
export const IconPin = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 4h6l-1 2v4l3 3H7l3-3V6z" />
    <path d="M12 16v5" />
  </Svg>
)

/** Toolbar unpinned: the tack lying on its side */
export const IconPinOff = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 9v6l2-1h4l3 3V6l-3 3H6z" />
    <path d="M16 12h5" />
  </Svg>
)

/** Presentation / slideshow: a screen with a play triangle */
export const IconPresent = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M10 8.5l4 2.5-4 2.5z" fill="currentColor" stroke="none" />
    <path d="M12 16v4M9 20h6" />
  </Svg>
)

/** Edge rail toggle — reveal the left (contents) panel */
export const IconPanelLeft = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4z" fill="currentColor" stroke="none" opacity="0.28" />
  </Svg>
)

/** Edge rail toggle — reveal the right (assistant) panel */
export const IconPanelRight = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
    <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4z" fill="currentColor" stroke="none" opacity="0.28" />
  </Svg>
)

export const IconSidebar = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9.5 4v16" />
  </Svg>
)

export const IconSearch = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.8-4.8" />
  </Svg>
)

export const IconPen = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </Svg>
)

export const IconMarker = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    {/* Chisel-tip highlighter over the line it just drew */}
    <path d="M14.5 4l5.5 5.5-8.5 8.5H7v-4.5z" />
    <path d="M12 6.5L17.5 12" />
    <path d="M4 21h16" />
  </Svg>
)

export const IconTextMarkup = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    {/* "A" over a highlight bar — the text-anchored markup tool */}
    <path d="M7 14.5L12 3.5l5 11" />
    <path d="M8.6 11h6.8" />
    <rect x="5" y="18" width="14" height="3.4" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)

/* Text-markup family: the same letter "A" with each markup applied, so the
   four variants read as siblings in the markup menus. */

export const IconMarkupHighlight = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="4.5" y="7.5" width="15" height="8.8" rx="1.6" fill="currentColor" stroke="none" opacity="0.3" />
    <path d="M7.2 15.5L12 4.5l4.8 11" />
    <path d="M8.9 11.5h6.2" />
  </Svg>
)

export const IconMarkupUnderline = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.2 15.5L12 4.5l4.8 11" />
    <path d="M8.9 11.5h6.2" />
    <path d="M6 19.5h12" />
  </Svg>
)

export const IconMarkupStrikeout = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.2 15.5L12 4.5l4.8 11" />
    <path d="M5 11h14" />
  </Svg>
)

export const IconMarkupSquiggly = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.2 15.5L12 4.5l4.8 11" />
    <path d="M8.9 11.5h6.2" />
    <path d="M6 19.3q2-2.6 4 0t4 0t4 0" />
  </Svg>
)

export const IconEraser = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M20 20H8.5L3.5 15a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l5.5 5.5a2 2 0 0 1 0 2.8L14 18.3" />
    <path d="M7 11l6 6" />
  </Svg>
)

export const IconShapes = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="3" width="11" height="11" rx="1.5" />
    <circle cx="15.5" cy="15.5" r="5.5" />
  </Svg>
)

export const IconText = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 6V4h16v2M12 4v16M9 20h6" />
  </Svg>
)

export const IconShapeSquare = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="14" rx="1.5" />
  </Svg>
)

export const IconShapeCircle = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <ellipse cx="12" cy="12" rx="8.5" ry="7" />
  </Svg>
)

export const IconShapeLine = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 19L19 5" />
  </Svg>
)

export const IconShapeArrow = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 19L19 5M19 5h-7M19 5v7" />
  </Svg>
)

export const IconNote = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.5 6a2 2 0 0 1 2 -2h11a2 2 0 0 1 2 2v8.5L14 20H6.5a2 2 0 0 1 -2 -2z" />
    <path d="M14 20v-3.5a2 2 0 0 1 2 -2h3.5" />
  </Svg>
)

export const IconComment = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-6.5L7 19.5V16H6a2 2 0 0 1 -2 -2z" />
  </Svg>
)

export const IconCopy = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4.5a2 2 0 0 1 -2 -2v-8.5a2 2 0 0 1 2 -2H13a2 2 0 0 1 2 2V5" />
  </Svg>
)

export const IconGlobe = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <ellipse cx="12" cy="12" rx="4" ry="9" />
    <path d="M3.5 9h17" />
    <path d="M3.5 15h17" />
  </Svg>
)

export const IconBook = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 6.5c-1.8 -1.6 -4.2 -2 -7.5 -2v13c3.3 0 5.7 .4 7.5 2c1.8 -1.6 4.2 -2 7.5 -2v-13c-3.3 0 -5.7 .4 -7.5 2z" />
    <path d="M12 6.5v13" />
  </Svg>
)

export const IconTally = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5.5 5.5v13M9.5 5.5v13M13.5 5.5v13M17.5 5.5v13" />
    <path d="M3.5 16l17 -8" />
  </Svg>
)

export const IconCite = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M6 7.5h8M6 12h8M6 16.5h5" />
    <path d="M17.5 14.5l2.5 2.5-2.5 2.5" />
  </Svg>
)

export const IconTranslate = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3.5 6h9" />
    <path d="M8 3.5V6" />
    <path d="M11 6c-.8 3.4 -3.2 6.4 -6.5 8" />
    <path d="M5.5 9.5c1.2 2.6 3.4 4.4 6 5" />
    <path d="M12.5 20.5L16.75 11l4.25 9.5" />
    <path d="M13.9 17.5h5.7" />
  </Svg>
)

export const IconSummary = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
    <path d="M8 8h8" />
    <path d="M8 12h8" />
    <path d="M8 16h5" />
  </Svg>
)

export const IconSparkle = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 3.5c.7 3.6 2.4 5.3 6 6-3.6.7-5.3 2.4-6 6-.7-3.6-2.4-5.3-6-6 3.6-.7 5.3-2.4 6-6z" />
    <path d="M18.5 14.5c.35 1.8 1.2 2.65 3 3-1.8.35-2.65 1.2-3 3-.35-1.8-1.2-2.65-3-3 1.8-.35 2.65-1.2 3-3z" />
  </Svg>
)

export const IconGear = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.63.88 1.03 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" />
  </Svg>
)

export const IconHistory = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" />
    <path d="M3.5 4v4.5H8" />
    <path d="M12 8v4.5l3 2" />
  </Svg>
)

export const IconSave = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 3.5h11l4.5 4.5v11a1.5 1.5 0 0 1 -1.5 1.5h-14a1.5 1.5 0 0 1 -1.5 -1.5v-14A1.5 1.5 0 0 1 5 3.5z" />
    <path d="M7.5 3.5v5h8v-5" />
    <rect x="7" y="13" width="10" height="7.5" rx="1" />
  </Svg>
)

/** Save a copy to disk (download-style down arrow into a tray) */
export const IconSaveAs = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M12 3v11" />
    <path d="M7.5 9.5 12 14l4.5-4.5" />
    <path d="M4 20.5h16" />
  </Svg>
)

export const IconPrint = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7 8V3.5h10V8" />
    <rect x="3.5" y="8" width="17" height="8.5" rx="2" />
    <rect x="7" y="13.5" width="10" height="7" />
  </Svg>
)

export const IconSpeaker = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3.5 9v6h4l5 4.5v-15L7.5 9z" />
    <path d="M16 9.5a4 4 0 0 1 0 5" />
    <path d="M18.5 7a7.5 7.5 0 0 1 0 10" />
  </Svg>
)

export const IconPlay = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M7.5 4.5l12 7.5-12 7.5z" />
  </Svg>
)

export const IconPause = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M8 5v14" />
    <path d="M16 5v14" />
  </Svg>
)

/** Snip-to-explain: a scan-frame with a sparkle — "mark an area, ask AI" */
export const IconSnip = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
    <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
    <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
    <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M12 8.2l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1 1-2.3z" />
  </Svg>
)

export const IconImage = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3.5 17l4.8-4.5 3.6 3.3 3.5-3.2 5.1 4.6" />
  </Svg>
)

export const IconSend = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.5 12L3 4.5 21 12 3 19.5 4.5 12z" />
    <path d="M4.5 12H12" />
  </Svg>
)

export const IconStop = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </Svg>
)
export const IconEye = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const IconEyeOff = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4 4l16 16" />
    <path d="M10.3 5.8A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6" />
    <path d="M6.4 6.4A15.5 15.5 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.1-.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
)

export const IconArrowLeft = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
)

export const IconArrowRight = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
)

export const IconReload = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5" />
  </Svg>
)

export const IconExternal = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
)

export const IconRotateCw = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5" />
  </Svg>
)

export const IconRotateCcw = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 2.64-6.36M3 3v5h5" />
  </Svg>
)

export const IconUndo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
)

export const IconRedo = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
)

export const IconSpread = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4" width="8" height="16" rx="1" />
    <rect x="13" y="4" width="8" height="16" rx="1" />
  </Svg>
)

// The full-colour app mark: the scroll from scripts/icon.svg. This is a fixed
// brand icon (same in every theme), not a line icon — it does not use currentColor.
export const AppMark = ({
  size,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 512 512"
    className={className}
    role="img"
    aria-label="PDF Scholar"
  >
    <defs>
      <linearGradient id="am-bg" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stopColor="#0e3a3f" />
        <stop offset="1" stopColor="#18696a" />
      </linearGradient>
      <linearGradient id="am-paper" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#faf4e8" />
        <stop offset="1" stopColor="#ece0c8" />
      </linearGradient>
      <linearGradient id="am-roll" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f2e6cd" />
        <stop offset="1" stopColor="#d6c096" />
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="112" fill="url(#am-bg)" />
    <g>
      <rect x="154" y="134" width="204" height="244" rx="11" fill="url(#am-paper)" />
      <g fill="#a99c82" opacity="0.85">
        <rect x="184" y="181" width="140" height="13" rx="6.5" />
        <rect x="184" y="300" width="142" height="13" rx="6.5" />
        <rect x="184" y="332" width="100" height="13" rx="6.5" />
      </g>
      <rect x="178" y="217" width="156" height="28" rx="8" fill="#f4c56a" opacity="0.55" />
      <rect x="184" y="224" width="140" height="13" rx="6.5" fill="#a99c82" opacity="0.9" />
      <rect x="131" y="107" width="250" height="54" rx="27" fill="url(#am-roll)" />
      <ellipse cx="148" cy="134" rx="8" ry="18" fill="#b89f6f" opacity="0.55" />
      <ellipse cx="364" cy="134" rx="8" ry="18" fill="#b89f6f" opacity="0.55" />
      <rect x="131" y="351" width="250" height="54" rx="27" fill="url(#am-roll)" />
      <ellipse cx="148" cy="378" rx="8" ry="18" fill="#b89f6f" opacity="0.55" />
      <ellipse cx="364" cy="378" rx="8" ry="18" fill="#b89f6f" opacity="0.55" />
    </g>
  </svg>
)
