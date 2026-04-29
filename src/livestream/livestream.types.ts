export type LivestreamRole = 'judge' | 'overlay'

export interface LivestreamRobotState {
  name: string
  maxHp: number
  currentHp: number
  controllerName: string
  controllerImage: string
  heartRate: number
}

export interface LivestreamOverlayElementsState {
  showRound: boolean
  showRobotName: boolean
  showControllerName: boolean
  showControllerImage: boolean
  showVsSymbol: boolean
  showHeartRate: boolean
  showLogo: boolean
  showTagline: boolean
}

export interface LivestreamSideAccentColors {
  left: string
  right: string
}

export interface LivestreamHudScaleState {
  topHud: number
  hpBars: number
  vsSymbol: number
  roundBadge: number
  heartRate: number
  fighterPicture: number
  centerBrand: number
}

export type LivestreamOverlayAspectMode = 'fill' | 'lock16x9'

export interface LivestreamMatchState {
  roundNumber: number
  isOverlayVisible: boolean
  isBgMockVisible: boolean
  backgroundColor: string
  overlayAspectMode: LivestreamOverlayAspectMode
  sideAccentColors: LivestreamSideAccentColors
  hudScale: LivestreamHudScaleState
  activeTheme: 'cyberpunk' | 'hologram' | 'arcade'
  overlayElements: LivestreamOverlayElementsState
  robot1: LivestreamRobotState
  robot2: LivestreamRobotState
}

export const defaultLivestreamMatchState: LivestreamMatchState = {
  roundNumber: 1,
  isOverlayVisible: true,
  isBgMockVisible: false,
  backgroundColor: '#000000',
  overlayAspectMode: 'lock16x9',
  sideAccentColors: {
    left: '#3B82F6',
    right: '#EF4444',
  },
  hudScale: {
    topHud: 1,
    hpBars: 1,
    vsSymbol: 1,
    roundBadge: 1,
    heartRate: 1,
    fighterPicture: 1,
    centerBrand: 1,
  },
  activeTheme: 'cyberpunk',
  overlayElements: {
    showRound: true,
    showRobotName: true,
    showControllerName: true,
    showControllerImage: true,
    showVsSymbol: true,
    showHeartRate: true,
    showLogo: true,
    showTagline: true,
  },
  robot1: {
    name: 'IRON CLAW',
    maxHp: 1000,
    currentHp: 1000,
    controllerName: 'CONTROLLER 01',
    controllerImage: 'https://i.pravatar.cc/300?img=11',
    heartRate: 85,
  },
  robot2: {
    name: 'STEEL FANG',
    maxHp: 1000,
    currentHp: 1000,
    controllerName: 'CONTROLLER 02',
    controllerImage: 'https://i.pravatar.cc/300?img=32',
    heartRate: 82,
  },
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const sanitizeText = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 60) : fallback

const sanitizeHexColor = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value.trim()) ? value.trim().toUpperCase() : fallback

const sanitizeTheme = (value: unknown, fallback: LivestreamMatchState['activeTheme']) => {
  if (value === 'cyberpunk' || value === 'hologram' || value === 'arcade') return value
  return fallback
}

const sanitizeOverlayAspectMode = (
  value: unknown,
  fallback: LivestreamMatchState['overlayAspectMode']
): LivestreamMatchState['overlayAspectMode'] => {
  if (value === 'fill' || value === 'lock16x9') return value
  return fallback
}

const sanitizeRobot = (candidate: unknown, fallback: LivestreamRobotState): LivestreamRobotState => {
  const source = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}

  const maxHpRaw = Number(source.maxHp)
  const maxHp = Number.isFinite(maxHpRaw) ? clamp(Math.floor(maxHpRaw), 100, 10000) : fallback.maxHp

  const currentHpRaw = Number(source.currentHp)
  const currentHp = Number.isFinite(currentHpRaw) ? clamp(Math.floor(currentHpRaw), 0, maxHp) : fallback.currentHp

  const heartRateRaw = Number(source.heartRate)

  return {
    name: sanitizeText(source.name, fallback.name),
    maxHp,
    currentHp,
    controllerName: sanitizeText(source.controllerName, fallback.controllerName),
    controllerImage: sanitizeText(source.controllerImage, fallback.controllerImage),
    heartRate: Number.isFinite(heartRateRaw) ? clamp(Math.floor(heartRateRaw), 40, 220) : fallback.heartRate,
  }
}

const sanitizeOverlayElements = (
  candidate: unknown,
  fallback: LivestreamOverlayElementsState
): LivestreamOverlayElementsState => {
  const source = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}
  return {
    showRound: typeof source.showRound === 'boolean' ? source.showRound : fallback.showRound,
    showRobotName: typeof source.showRobotName === 'boolean' ? source.showRobotName : fallback.showRobotName,
    showControllerName:
      typeof source.showControllerName === 'boolean' ? source.showControllerName : fallback.showControllerName,
    showControllerImage:
      typeof source.showControllerImage === 'boolean' ? source.showControllerImage : fallback.showControllerImage,
    showVsSymbol: typeof source.showVsSymbol === 'boolean' ? source.showVsSymbol : fallback.showVsSymbol,
    showHeartRate: typeof source.showHeartRate === 'boolean' ? source.showHeartRate : fallback.showHeartRate,
    showLogo: typeof source.showLogo === 'boolean' ? source.showLogo : fallback.showLogo,
    showTagline: typeof source.showTagline === 'boolean' ? source.showTagline : fallback.showTagline,
  }
}

const sanitizeSideAccentColors = (
  candidate: unknown,
  fallback: LivestreamSideAccentColors
): LivestreamSideAccentColors => {
  const source = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}
  return {
    left: sanitizeHexColor(source.left, fallback.left),
    right: sanitizeHexColor(source.right, fallback.right),
  }
}

const sanitizeHudScale = (
  candidate: unknown,
  fallback: LivestreamHudScaleState
): LivestreamHudScaleState => {
  const source = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}
  const clampScale = (value: unknown, fallbackValue: number) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallbackValue
    return clamp(parsed, 0.6, 1.8)
  }
  return {
    topHud: clampScale(source.topHud, fallback.topHud),
    hpBars: clampScale(source.hpBars, fallback.hpBars),
    vsSymbol: clampScale(source.vsSymbol, fallback.vsSymbol),
    roundBadge: clampScale(source.roundBadge, fallback.roundBadge),
    heartRate: clampScale(source.heartRate, fallback.heartRate),
    fighterPicture: clampScale(source.fighterPicture, fallback.fighterPicture),
    centerBrand: clampScale(source.centerBrand, fallback.centerBrand),
  }
}

export const sanitizeLivestreamState = (
  candidate: unknown,
  fallback: LivestreamMatchState = defaultLivestreamMatchState
): LivestreamMatchState => {
  const source = typeof candidate === 'object' && candidate !== null ? (candidate as Record<string, unknown>) : {}
  const roundRaw = Number(source.roundNumber)

  return {
    roundNumber: Number.isFinite(roundRaw) ? clamp(Math.floor(roundRaw), 1, 99) : fallback.roundNumber,
    isOverlayVisible: typeof source.isOverlayVisible === 'boolean' ? source.isOverlayVisible : fallback.isOverlayVisible,
    isBgMockVisible: typeof source.isBgMockVisible === 'boolean' ? source.isBgMockVisible : fallback.isBgMockVisible,
    backgroundColor: sanitizeHexColor(source.backgroundColor, fallback.backgroundColor),
    overlayAspectMode: sanitizeOverlayAspectMode(source.overlayAspectMode, fallback.overlayAspectMode),
    sideAccentColors: sanitizeSideAccentColors(source.sideAccentColors, fallback.sideAccentColors),
    hudScale: sanitizeHudScale(source.hudScale, fallback.hudScale),
    activeTheme: sanitizeTheme(source.activeTheme, fallback.activeTheme),
    overlayElements: sanitizeOverlayElements(source.overlayElements, fallback.overlayElements),
    robot1: sanitizeRobot(source.robot1, fallback.robot1),
    robot2: sanitizeRobot(source.robot2, fallback.robot2),
  }
}
