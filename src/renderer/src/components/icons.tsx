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
