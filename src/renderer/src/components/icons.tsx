// Small stroke-based icons in the style of PDF Expert's minimal line icons.
interface IconProps {
  size?: number
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
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
    <path d="M9 11l-6 6v4h4l6-6" />
    <path d="M14 6l4 4 3-3a2.8 2.8 0 0 0-4-4l-3 3z" />
    <path d="M9 11l4 4" />
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
