import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react'

// ── Tema de interfaz (claro «gris suave» / oscuro) ────────
// Independiente del estilo del trazado (papel/pantalla). Mantiene la paleta
// (acentos cian, colores FCF/TOCO/variabilidad).
interface UITheme {
  appBg: string; panelBg: string; headerText: string
  text: string; textMuted: string; textFaint: string
  border: string; borderStrong: string
  cardBg: string; inputBg: string; inputBorder: string; inputText: string
  selectBg: string
  accent: string; accentActive: string
  segActiveBg: string; segActiveBorder: string; segInactiveBg: string; segInactiveBorder: string
  editBg: string; editBorder: string
  toggleOff: string; dashed: string
  exportPrimaryBg: string; exportSecondaryText: string
  canvasArea: string
}
const uiThemeLight: UITheme = {
  appBg: '#e2e8f0', panelBg: '#f8fafc', headerText: '#1e293b',
  text: '#334155', textMuted: '#64748b', textFaint: '#94a3b8',
  border: '#e2e8f0', borderStrong: '#cbd5e1',
  cardBg: '#ffffff', inputBg: '#ffffff', inputBorder: '#cbd5e1', inputText: '#1e293b',
  selectBg: '#ffffff',
  accent: '#0891b2', accentActive: '#0e7490',
  segActiveBg: 'rgba(8,145,178,0.08)', segActiveBorder: '#0891b2',
  segInactiveBg: '#ffffff', segInactiveBorder: '#e2e8f0',
  editBg: 'rgba(8,145,178,0.05)', editBorder: 'rgba(8,145,178,0.25)',
  toggleOff: '#cbd5e1', dashed: '#cbd5e1',
  exportPrimaryBg: '#0891b2', exportSecondaryText: '#475569',
  canvasArea: '#e2e8f0',
}
const uiThemeDark: UITheme = {
  appBg: '#0B1120', panelBg: '#0D1321', headerText: '#ffffff',
  text: '#94a3b8', textMuted: '#64748b', textFaint: '#475569',
  border: '#0f172a', borderStrong: '#1e293b',
  cardBg: 'rgba(15,23,42,0.5)', inputBg: '#020617', inputBorder: '#1e293b', inputText: '#ffffff',
  selectBg: '#0f172a',
  accent: '#22d3ee', accentActive: '#22d3ee',
  segActiveBg: 'rgba(34,211,238,0.05)', segActiveBorder: '#22d3ee',
  segInactiveBg: 'rgba(15,23,42,0.5)', segInactiveBorder: '#1e293b',
  editBg: 'rgba(34,211,238,0.03)', editBorder: 'rgba(34,211,238,0.15)',
  toggleOff: '#334155', dashed: '#334155',
  exportPrimaryBg: '#0e7490', exportSecondaryText: '#94a3b8',
  canvasArea: '#0B1120',
}
const UICtx = createContext<UITheme>(uiThemeLight)
const useUI = () => useContext(UICtx)

// ── Canvas constants ──────────────────────────────────────
const FHR_TOP     = 22
const FHR_BOTTOM  = 262
const TOCO_TOP    = 280
const TOCO_BOTTOM = 370
const CANVAS_H    = 388
const PX_PER_MIN  = 60
const AXIS_W      = 44
const TRANSITION_MIN = 0.4

// ── Types ─────────────────────────────────────────────────
interface Segment {
  id: number
  time: number
  baseline: number
  varAmp: number   // amplitud pico-a-valle de variabilidad, en lpm (se lee en la graduación)
  stv: number      // textura / STV a corto plazo: 0 = liso (sinusoidal) … 1 = dentado (saltatorio)
}
interface Decel {
  type: 'variable' | 'variableComplicated' | 'variableShoulders' | 'late' | 'early' | 'prolonged'
  time: number
  depth: number
  duration: number
  onset?: number    // solo 'variable': tiempo de caída (onset→nadir) en segundos, máx 29 ("caída abrupta")
  recovery?: number // solo 'variable': tiempo de recuperación (nadir→basal) en segundos, sin límite de "abrupta"
  preShoulder?: number  // solo 'variableShoulders': amplitud del hombro previo, en lpm (15-30)
  postShoulder?: number // solo 'variableShoulders': amplitud del hombro posterior, en lpm (0-30)
}
interface Accel {
  time: number      // minuto de inicio
  amplitude: number // altura en lpm sobre la basal
  duration: number  // duración en segundos
}
interface Contraction {
  time: number
  duration: number
  amplitude: number
}
interface TocoSegment {
  id: number
  time: number
  tone: number     // tono uterino basal, en mmHg (hipotonía/hipertonía por tramo)
  noise: number    // 0–100, ruido fino continuo de la línea TOCO
  artifact: number // 0–100, probabilidad de pérdida real de señal (pen-up) del transductor
}
interface CTGConfig {
  segments: Segment[]
  accels: Accel[]
  duration: number
  decels: Decel[]
  contractions: Contraction[]
  activeSegTime: number
  artifactLevel: number      // 0–100, intensidad de pérdida de señal / artefacto FCF
  artifactExpulsive: boolean // concentrar el artefacto FCF hacia el expulsivo (final)
  paper: boolean             // estilo papel real (true) o pantalla oscura (false)
  tocoSegments: TocoSegment[]
  activeTocoSegTime: number
}

// ── Maths ─────────────────────────────────────────────────
const hash       = (n: number) => { const s = Math.sin(n * 12.9898) * 43758.5453; return (s - Math.floor(s)) - 0.5 }
const smoothstep = (a: number, b: number, t: number) => { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x) }
const clamp      = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const gaussian   = (x: number, c: number, w: number, a: number) => a * Math.exp(-0.5 * ((x - c) / w) ** 2)
const lerp       = (a: number, b: number, t: number) => a + (b - a) * t

const FHR_MIN  = 30
const FHR_MAX  = 240
const fhrToPx  = (fhr: number) => FHR_TOP  + (FHR_MAX - fhr) / (FHR_MAX - FHR_MIN) * (FHR_BOTTOM - FHR_TOP)
const tocoToPx = (p: number)   => TOCO_BOTTOM - (p / 100) * (TOCO_BOTTOM - TOCO_TOP)

// ── Temas de render (papel real / pantalla oscura) ────────
function theme(paper: boolean) {
  return paper ? {
    bg: '#fffdfa',
    hMinor: 'rgba(226,128,120,0.34)', hMajor: 'rgba(205,82,74,0.55)',
    vMinor: 'rgba(226,128,120,0.32)', vMajor: 'rgba(205,82,74,0.55)',
    tocoSep: 'rgba(205,82,74,0.45)',  tocoH:  'rgba(226,128,120,0.30)',
    timeLabel: 'rgba(150,60,55,0.8)',
    fhrLabelBox: 'rgba(255,253,250,0.8)', fhrLabelText: 'rgba(150,60,55,0.8)',
    tocoLabel: 'rgba(120,80,30,0.9)',
    segLine: (a: boolean) => a ? 'rgba(37,99,235,0.7)' : 'rgba(37,99,235,0.3)',
    segTri:  (a: boolean) => a ? 'rgba(37,99,235,0.9)' : 'rgba(37,99,235,0.4)',
    segText: (a: boolean) => a ? '#2563eb' : 'rgba(37,99,235,0.55)',
    toco: 'rgba(40,40,52,0.9)', tocoFill: 'rgba(40,40,52,0.05)',
    fhr: '#151522', fhrGlow: 'rgba(0,0,0,0)', fhrGlowBlur: 0, fhrLineWidth: 1.0,
  } : {
    bg: '#050816',
    hMinor: 'rgba(71,85,105,0.20)',  hMajor: 'rgba(100,116,139,0.32)',
    vMinor: 'rgba(71,85,105,0.22)',  vMajor: 'rgba(100,116,139,0.42)',
    tocoSep: 'rgba(100,116,139,0.3)', tocoH:  'rgba(71,85,105,0.18)',
    timeLabel: 'rgba(100,116,139,0.65)',
    fhrLabelBox: 'rgba(30,41,59,0.85)', fhrLabelText: 'rgba(100,116,139,0.6)',
    tocoLabel: 'rgba(251,191,36,0.7)',
    segLine: (a: boolean) => a ? 'rgba(34,211,238,0.7)' : 'rgba(34,211,238,0.25)',
    segTri:  (a: boolean) => a ? 'rgba(34,211,238,0.9)' : 'rgba(34,211,238,0.35)',
    segText: (a: boolean) => a ? '#22d3ee' : 'rgba(34,211,238,0.5)',
    toco: 'rgba(251,191,36,0.9)', tocoFill: 'rgba(251,191,36,0.06)',
    fhr: '#6EE7FF', fhrGlow: 'rgba(110,231,255,0.3)', fhrGlowBlur: 1.5, fhrLineWidth: 1.2,
  }
}

const varLabel = (amp: number) => {
  if (amp < 2)   return 'Ausente'
  if (amp < 5)   return 'Mínima'
  if (amp <= 25) return 'Normal'
  return 'Marcada'
}
const varColor = (amp: number) => {
  if (amp < 2)   return '#ef4444'
  if (amp < 5)   return '#f59e0b'
  if (amp <= 25) return '#22d3ee'
  return '#a78bfa'
}
const stvLabel = (k: number) => {
  if (k < 0.12) return 'Liso · sinusoidal'
  if (k < 0.45) return 'Suave'
  if (k < 0.75) return 'Dentado'
  return 'Saltatorio'
}

// ── Segment interpolation ─────────────────────────────────
function getSegmentValues(segments: Segment[], t: number) {
  let idx = 0
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].time <= t) idx = i
    else break
  }
  const cur  = segments[idx]
  const next = segments[idx + 1]
  if (!next) return { baseline: cur.baseline, varAmp: cur.varAmp, stv: cur.stv }
  const transStart = next.time - TRANSITION_MIN
  if (t >= transStart) {
    const p = smoothstep(0, 1, (t - transStart) / TRANSITION_MIN)
    return {
      baseline: lerp(cur.baseline, next.baseline, p),
      varAmp:   lerp(cur.varAmp, next.varAmp, p),
      stv:      lerp(cur.stv ?? 0.35, next.stv ?? 0.35, p),
    }
  }
  return { baseline: cur.baseline, varAmp: cur.varAmp, stv: cur.stv ?? 0.35 }
}

// ── TOCO segment interpolation (tono/ruido/artefacto por tramo) ──
function getTocoSegmentValues(tocoSegments: TocoSegment[], t: number) {
  let idx = 0
  for (let i = 0; i < tocoSegments.length; i++) {
    if (tocoSegments[i].time <= t) idx = i
    else break
  }
  const cur  = tocoSegments[idx]
  const next = tocoSegments[idx + 1]
  if (!next) return { tone: cur.tone, noise: cur.noise, artifact: cur.artifact }
  const transStart = next.time - TRANSITION_MIN
  if (t >= transStart) {
    const p = smoothstep(0, 1, (t - transStart) / TRANSITION_MIN)
    return {
      tone:     lerp(cur.tone, next.tone, p),
      noise:    lerp(cur.noise, next.noise, p),
      artifact: lerp(cur.artifact, next.artifact, p),
    }
  }
  return { tone: cur.tone, noise: cur.noise, artifact: cur.artifact }
}

// ── Waveform utils ────────────────────────────────────────
// Modelo de variabilidad de dos componentes, calibrado contra papel real (1 cm/min):
//   - slow  = ondulación lenta (variabilidad a largo plazo, LTV)
//   - beat  = jitter fino (variabilidad a corto plazo, STV)
// Cada componente está normalizado para que su banda pico-a-valle POR MINUTO sea 1,
// por lo que `amp` (varAmp) = amplitud pico-a-valle en lpm → se lee directo en la
// graduación (ej. 28 lpm ≈ 2,8 celdas de 10 lpm). El mezclador `k` (STV/textura)
// va de 0 (liso, sinusoidal) a 1 (dentado, saltatorio); corr(k) mantiene la banda
// constante al cambiar la textura. Referencias CTU-CHB: reducida ~4, normal ~15, marcada ~40.
const SLOW_NORM = 1.697
const BEAT_NORM = 0.836
// BEAT_PERIOD controla la separación de los "dientes" del jitter: ruido de valor
// (hash en rejilla gruesa + smoothstep) en vez de ruido por píxel. P=1.2 → ~6.5
// dientes/min, como en trazados reales (1001 min19-21), evitando el aspecto de
// serrucho con dientes demasiado juntos que daba el hash por píxel (~60/min).
const BEAT_PERIOD = 1.2
const valueNoise = (x: number) => {
  const i = Math.floor(x / BEAT_PERIOD)
  const f = x / BEAT_PERIOD - i
  const u = f * f * (3 - 2 * f)
  return hash(i) + (hash(i + 1) - hash(i)) * u
}
const variabilityAt = (x: number, amp: number, k: number) => {
  const slow = (Math.sin(x / 17) + 0.6 * Math.sin(x / 6.3) + 0.4 * Math.sin(x / 2.7)) / SLOW_NORM
  const beat = valueNoise(x) / BEAT_NORM
  const corr = 1 / Math.sqrt((1 - k) * (1 - k) + k * k)
  return ((1 - k) * slow + k * beat) * corr * amp
}

// ── Deceleration drop ─────────────────────────────────────
function decelDropAt(t: number, x: number, decels: Decel[]) {
  let drop = 0
  decels.forEach((d, i) => {
    const seed   = i * 47.3
    const depth  = d.depth
    const durMin = d.duration / 60
    const startT = d.time
    const endT   = startT + durMin
    let contrib = 0

    if (d.type === 'variable') {
      // Calibrado contra variables "simples" reales (CTU-CHB, ej. caso 1020):
      // onset más abrupto que la recuperación (barorreceptor: oclusión rápida,
      // reapertura algo más lenta), nadir irregular (no una ondulación fina y
      // pareja, sino saltos bruscos de ~20-30% de la profundidad — reutiliza
      // el value-noise del motor de variabilidad para esa textura "sucia"), y
      // un pequeño rebote (overshoot) sobre la basal justo al recuperar.
      const onsetRamp = Math.min(d.onset ?? 8, 29) / 60
      const recovRamp = Math.min(d.recovery ?? 12, 45) / 60
      const overshootW = 14 / 60
      if (t >= startT && t < startT + onsetRamp) {
        const p = (t - startT) / onsetRamp
        const smooth = smoothstep(0, 1, p) * depth
        // irregularidad en la caída: envolvente sin(pi*p) para que sea 0 en los
        // extremos (sin discontinuidad) y máxima a mitad de camino
        const jitter = valueNoise(x * 0.9 + seed * 7) * depth * 0.12 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (t >= startT + onsetRamp && t < endT - recovRamp) {
        const coarse = valueNoise(x * 0.6 + seed * 3) * 0.26
        const fine   = hash(x * 1.1 + seed) * 0.08
        contrib = depth * (1 + coarse + fine)
      } else if (t >= endT - recovRamp && t < endT) {
        // la recuperación no tiene el límite de "abrupta" del onset (<30s) — en
        // la literatura suele ser más lenta e irregular que la caída, e incluso
        // puede superar los 30s sin dejar de ser una variable "simple".
        const p = (endT - t) / recovRamp
        const smooth = smoothstep(0, 1, p) * depth
        const jitter = valueNoise(x * 0.7 + seed * 11) * depth * 0.14 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (t >= endT && t < endT + overshootW) {
        const p = (t - endT) / overshootW
        contrib = -Math.min(9, depth * 0.12) * Math.sin(Math.PI * p)
      }

    } else if (d.type === 'variableComplicated') {
      // Variable complicada: nadir bifásico (cae, rebote parcial, cae de nuevo)
      // + recuperación lenta, calibrado contra 1016 Ep.B (min 56.6-58.1) y 1024
      // Ventana 2 (min 61-62.7). Mismo onset abrupto que la simple, pero el
      // "plateau" tiene dos valles con un rebote parcial (no completo) entre
      // ellos, y por defecto una recuperación más lenta.
      const onsetRamp = Math.min(d.onset ?? 10, 29) / 60
      const recovRamp = Math.min(d.recovery ?? 25, 45) / 60
      const overshootW = 14 / 60
      const plateauStart = startT + onsetRamp
      const plateauEnd = endT - recovRamp
      const plateau = Math.max(0.01, plateauEnd - plateauStart)
      const bounceLevel = 0.5 // fracción de la profundidad en el rebote parcial (más alto = rebote más sutil)
      const t_n1     = plateauStart + plateau * 0.26
      const riseDur  = Math.min(plateau * 0.10, 5 / 60)
      const t_bpeak  = t_n1 + riseDur
      const holdDur  = Math.min(plateau * 0.05, 2.5 / 60)
      const t_bhold  = t_bpeak + holdDur
      const fallDur  = Math.min(plateau * 0.07, 3.5 / 60)
      const t_n2s    = t_bhold + fallDur

      if (t >= startT && t < startT + onsetRamp) {
        const p = (t - startT) / onsetRamp
        const smooth = smoothstep(0, 1, p) * depth
        const jitter = valueNoise(x * 0.9 + seed * 7) * depth * 0.12 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (t >= startT + onsetRamp && t < endT - recovRamp) {
        let levelFrac: number
        if (t < t_n1) levelFrac = 1
        else if (t < t_bpeak) levelFrac = lerp(1, bounceLevel, smoothstep(t_n1, t_bpeak, t))
        else if (t < t_bhold) levelFrac = bounceLevel
        else if (t < t_n2s)   levelFrac = lerp(bounceLevel, 1, smoothstep(t_bhold, t_n2s, t))
        else levelFrac = 1
        const coarse = valueNoise(x * 0.6 + seed * 3) * 0.22
        const fine   = hash(x * 1.1 + seed) * 0.07
        contrib = Math.max(0, depth * levelFrac * (1 + coarse + fine))
      } else if (t >= endT - recovRamp && t < endT) {
        const p = (endT - t) / recovRamp
        const smooth = smoothstep(0, 1, p) * depth
        const jitter = valueNoise(x * 0.7 + seed * 11) * depth * 0.14 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (t >= endT && t < endT + overshootW) {
        const p = (t - endT) / overshootW
        contrib = -Math.min(9, depth * 0.12) * Math.sin(Math.PI * p)
      }

    } else if (d.type === 'variableShoulders') {
      // Barorreceptora con hombros: aceleración breve ANTES de la caída
      // (calibrado contra 1024, ambas ventanas: pico +15-18 lpm justo cuando
      // la UC empieza a subir, cayendo abruptamente después). El resto de la
      // forma (onset/nadir/recuperación) es igual a la simple.
      const onsetRamp = Math.min(d.onset ?? 8, 29) / 60
      const recovRamp = Math.min(d.recovery ?? 12, 45) / 60
      const preW = 14 / 60
      const postW = 16 / 60
      const preAmp  = d.preShoulder ?? 16
      const postAmp = d.postShoulder ?? 0

      if (t >= startT - preW && t < startT) {
        const p = (t - (startT - preW)) / preW
        contrib = -preAmp * Math.sin(Math.PI * p)
      } else if (t >= startT && t < startT + onsetRamp) {
        const p = (t - startT) / onsetRamp
        const smooth = smoothstep(0, 1, p) * depth
        const jitter = valueNoise(x * 0.9 + seed * 7) * depth * 0.12 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (t >= startT + onsetRamp && t < endT - recovRamp) {
        const coarse = valueNoise(x * 0.6 + seed * 3) * 0.26
        const fine   = hash(x * 1.1 + seed) * 0.08
        contrib = depth * (1 + coarse + fine)
      } else if (t >= endT - recovRamp && t < endT) {
        const p = (endT - t) / recovRamp
        const smooth = smoothstep(0, 1, p) * depth
        const jitter = valueNoise(x * 0.7 + seed * 11) * depth * 0.14 * Math.sin(Math.PI * p)
        contrib = Math.max(0, smooth + jitter)
      } else if (postAmp > 0 && t >= endT && t < endT + postW) {
        const p = (t - endT) / postW
        contrib = -postAmp * Math.sin(Math.PI * p)
      }

    } else if (d.type === 'late') {
      const lag = 30 / 60
      const s = startT + lag, e = endT + lag, mid = s + (e - s) / 2
      if (t >= s && t < mid)  contrib = smoothstep(0, 1, (t - s) / (mid - s)) * depth
      else if (t >= mid && t <= e) contrib = smoothstep(0, 1, (e - t) / (e - mid)) * depth

    } else if (d.type === 'early') {
      if (t >= startT && t <= endT)
        contrib = Math.sin(((t - startT) / durMin) * Math.PI) * depth

    } else if (d.type === 'prolonged') {
      const ramp = 0.25
      if (t >= startT && t < startT + ramp)
        contrib = smoothstep(0, 1, (t - startT) / ramp) * depth
      else if (t >= startT + ramp && t < endT - ramp)
        contrib = depth + hash(x * 0.2 + seed) * depth * 0.05
      else if (t >= endT - ramp && t <= endT)
        contrib = smoothstep(0, 1, (endT - t) / ramp) * depth
    }

    if (Math.abs(contrib) > Math.abs(drop)) drop = contrib
  })
  return drop
}

// ── Aceleración (subida sobre la basal) ───────────────────
function accelRiseAt(t: number, x: number, accels: Accel[]) {
  let rise = 0
  accels.forEach((a, i) => {
    const seed   = i * 31.7
    const durMin = a.duration / 60
    const startT = a.time
    const endT   = startT + durMin
    if (t >= startT && t <= endT) {
      const p     = (t - startT) / durMin        // 0..1
      const shape = Math.sin(p * Math.PI)         // hump redondeado 0..1..0
      const eased = Math.pow(shape, 0.7)          // ascenso algo más marcado, cima redondeada
      rise = Math.max(rise, a.amplitude * eased + hash(x * 0.5 + seed) * a.amplitude * 0.05)
    }
  })
  return rise
}

// ── Artefacto / pérdida de señal ──────────────────────────
// Modela la pérdida de contacto típica del registro real (la madre se mueve,
// sobre todo en el expulsivo). Determinista (sin Math.random), reproducible.
function signalLost(t: number, duration: number, level: number, expulsive: boolean) {
  if (level <= 0) return false
  let p = level / 100
  if (expulsive) {
    const knee = duration * 0.6
    p *= t < knee ? 0.1 : 0.1 + 0.9 * smoothstep(knee, duration, t)
  } else {
    p *= 0.5
  }
  // zonas "malas" cada ~15 s; solo algunas se degradan
  const zone = hash(Math.floor(t * 4) * 0.13) + 0.5
  if (zone > 0.35 + 0.65 * p) return false
  // dentro de una zona mala, huecos en sub-tramos de ~2.5 s
  const sub = hash(Math.floor(t * 24) * 1.7) + 0.5
  return sub < 0.4 + 0.6 * p
}
function artifactNoise(t: number, x: number, duration: number, level: number, expulsive: boolean) {
  let p = level / 100
  if (expulsive) {
    const knee = duration * 0.6
    p *= t < knee ? 0.15 : 0.15 + 0.85 * smoothstep(knee, duration, t)
  }
  let n = hash(x * 1.3) * 3 * p              // ruido leve continuo
  const zone = hash(Math.floor(t * 4) * 0.13) + 0.5
  if (zone < 0.35 + 0.65 * p) {             // spikes ocasionales en zonas malas
    const spike = hash(x * 2.7)
    if (Math.abs(spike) > 0.42) n += spike * 18 * p
  }
  return n
}

// ── TOCO: ruido de línea y artefacto ──────────────────────
// La traza de TOCO real nunca es perfectamente lisa: hay un temblor fino
// continuo (tono uterino inquieto, respiración materna) que `tocoNoiseAt`
// reproduce mezclando dos frecuencias de hash. `tocoSignalLost` modela
// pérdida real de señal del transductor externo (se despega/mueve el
// cinturón) igual que `signalLost` para la FCF: el trazo se interrumpe
// (pen-up) en vez de solo añadir ruido.
const tocoNoiseAt = (x: number, amt: number) => {
  const n1 = hash(x * 0.05) * 1.5
  const n2 = hash(x * 0.37) * 0.7
  return (n1 + n2) * (amt / 40)
}
function tocoSignalLost(t: number, level: number) {
  if (level <= 0) return false
  const p = level / 100
  const zone = hash(Math.floor(t * 3) * 0.19) + 0.5
  if (zone > 0.3 + 0.6 * p) return false
  const sub = hash(Math.floor(t * 20) * 1.3) + 0.5
  return sub < 0.35 + 0.55 * p
}

// ── Draw CTG ──────────────────────────────────────────────
function drawCTG(canvas: HTMLCanvasElement, config: CTGConfig) {
  const { segments, accels, duration, decels, contractions, activeSegTime, artifactLevel, artifactExpulsive, paper, tocoSegments, activeTocoSegTime } = config
  const th = theme(paper)
  const W = Math.round(duration * PX_PER_MIN)
  canvas.width  = W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = th.bg
  ctx.fillRect(0, 0, W, CANVAS_H)

  // Grid — papel CTG chileno, 1 cm/min
  ctx.setLineDash([])
  // Horizontal FCF: línea fina cada 10 lpm, marcada cada 30 lpm
  for (let fhr = FHR_MIN; fhr <= FHR_MAX; fhr += 10) {
    const y = fhrToPx(fhr)
    const major = fhr % 30 === 0
    ctx.strokeStyle = major ? th.hMajor : th.hMinor
    ctx.lineWidth   = major ? 0.8 : 0.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
  }
  // Vertical tiempo: línea clara cada 0,5 cm (0,5 min), oscura cada 3 min
  for (let half = 0; half <= duration * 2; half++) {
    const x = (half / 2) * PX_PER_MIN
    const major = half % 6 === 0   // cada 3 min
    ctx.strokeStyle = major ? th.vMajor : th.vMinor
    ctx.lineWidth   = major ? 1.0 : 0.5
    ctx.beginPath(); ctx.moveTo(x, FHR_TOP);   ctx.lineTo(x, FHR_BOTTOM + 10); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x, TOCO_TOP - 6); ctx.lineTo(x, TOCO_BOTTOM);  ctx.stroke()
  }
  // Separador FCF / TOCO
  ctx.strokeStyle = th.tocoSep; ctx.lineWidth = 1; ctx.setLineDash([3, 5])
  ctx.beginPath(); ctx.moveTo(0, TOCO_TOP - 6); ctx.lineTo(W, TOCO_TOP - 6); ctx.stroke()
  ctx.setLineDash([])
  // Horizontal TOCO cada 25 mmHg (0–100); bordes 0 y 100 algo más marcados
  ;[0, 25, 50, 75, 100].forEach(p => {
    ctx.strokeStyle = th.tocoH; ctx.lineWidth = (p === 0 || p === 100) ? 0.7 : 0.5
    const y = tocoToPx(p)
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
  })
  // Etiquetas de tiempo cada 3 min (sobre las líneas oscuras)
  ctx.fillStyle = th.timeLabel; ctx.font = '9px system-ui'; ctx.textAlign = 'center'
  for (let m = 3; m <= duration; m += 3) ctx.fillText(m + "'", m * PX_PER_MIN, CANVAS_H - 3)
  // Escala FCF (lpm) reimpresa cada 10 min
  ctx.font = '8.5px system-ui'; ctx.textAlign = 'right'
  for (let m = 10; m <= duration; m += 10) {
    ;[240, 210, 180, 150, 120, 90, 60, 30].forEach(fhr => {
      const y = fhrToPx(fhr)
      ctx.fillStyle = th.fhrLabelBox
      ctx.fillRect(m * PX_PER_MIN - 28, y - 7, 26, 13)
      ctx.fillStyle = th.fhrLabelText
      ctx.fillText(String(fhr), m * PX_PER_MIN - 4, y + 4)
    })
  }
  // Escala TOCO reimpresa cada 5 min, ALTERNANDO mmHg / kPa (papel chileno):
  // eje izq (0') mmHg · 5' kPa · 10' mmHg · 15' kPa …  Unidad al pie de cada columna.
  // 1 kPa = 7.5 mmHg → kPa 2,4,…12 en mmHg 15,30,…90
  ctx.font = '8px system-ui'; ctx.textAlign = 'right'
  for (let m = 5; m <= duration; m += 5) {
    const xr = m * PX_PER_MIN
    const isKpa = (m / 5) % 2 === 1   // 5,15,25 → kPa ; 10,20 → mmHg
    const ticks = isKpa ? [2, 4, 6, 8, 10, 12] : [25, 50, 75, 100]
    const unit  = isKpa ? 'kPa' : 'mmHg'
    ticks.forEach(v => {
      const y = tocoToPx(isKpa ? v * 7.5 : v)
      ctx.fillStyle = th.fhrLabelBox
      ctx.fillRect(xr - 22, y - 6, 20, 12)
      ctx.fillStyle = th.tocoLabel
      ctx.fillText(String(v), xr - 4, y + 3)
    })
    ctx.fillStyle = th.fhrLabelBox
    ctx.fillRect(xr - 28, TOCO_BOTTOM - 11, 28, 11)
    ctx.fillStyle = th.tocoLabel
    ctx.fillText(unit, xr - 4, TOCO_BOTTOM - 2)
  }

  // Segment markers
  segments.slice(1).forEach(seg => {
    const x = seg.time * PX_PER_MIN
    const isActive = seg.time === activeSegTime
    ctx.strokeStyle = th.segLine(isActive)
    ctx.lineWidth   = isActive ? 1.5 : 1
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(x, FHR_TOP - 5); ctx.lineTo(x, FHR_BOTTOM + 15); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = th.segTri(isActive)
    ctx.beginPath(); ctx.moveTo(x - 5, FHR_TOP - 5); ctx.lineTo(x + 5, FHR_TOP - 5); ctx.lineTo(x, FHR_TOP + 5); ctx.closePath(); ctx.fill()
    ctx.fillStyle = th.segText(isActive)
    ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'left'
    ctx.fillText(seg.time.toFixed(1) + "'", x + 4, FHR_TOP + 3)
  })

  // TOCO segment markers (tono/ruido/artefacto) — triángulo hacia abajo, color ámbar
  tocoSegments.slice(1).forEach(seg => {
    const x = seg.time * PX_PER_MIN
    const isActive = seg.time === activeTocoSegTime
    ctx.strokeStyle = isActive ? 'rgba(245,158,11,0.8)' : 'rgba(245,158,11,0.3)'
    ctx.lineWidth   = isActive ? 1.5 : 1
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(x, TOCO_TOP - 6); ctx.lineTo(x, TOCO_BOTTOM + 8); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = isActive ? 'rgba(245,158,11,0.95)' : 'rgba(245,158,11,0.45)'
    ctx.beginPath(); ctx.moveTo(x - 5, TOCO_BOTTOM + 8); ctx.lineTo(x + 5, TOCO_BOTTOM + 8); ctx.lineTo(x, TOCO_BOTTOM - 2); ctx.closePath(); ctx.fill()
    ctx.fillStyle = isActive ? '#b45309' : 'rgba(180,83,9,0.5)'
    ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'left'
    ctx.fillText(seg.time.toFixed(1) + "'", x + 4, TOCO_BOTTOM + 6)
  })

  // TOCO
  const tocoPath: { v: number; lost: boolean }[] = []
  for (let x = 0; x < W; x++) {
    const t  = x / PX_PER_MIN
    const tv = getTocoSegmentValues(tocoSegments, t)
    let toco = tv.tone + tocoNoiseAt(x, tv.noise)
    contractions.forEach(c => { toco += gaussian(t, c.time, c.duration * 0.48, c.amplitude) })
    const lost = tv.artifact > 0 && tocoSignalLost(t, tv.artifact)
    tocoPath.push({ v: clamp(toco, 0, 100), lost })
  }
  // Relleno bajo la curva: silueta continua (representa la actividad uterina real,
  // independiente de si el transductor perdió contacto)
  ctx.fillStyle = th.tocoFill
  ctx.beginPath()
  tocoPath.forEach((p, x) => { const y = tocoToPx(p.v); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
  ctx.lineTo(W, TOCO_BOTTOM); ctx.lineTo(0, TOCO_BOTTOM); ctx.closePath(); ctx.fill()
  // Trazo: se interrumpe (pen-up) donde hay pérdida real de señal por artefacto
  ctx.strokeStyle = th.toco; ctx.lineWidth = 1.5
  ctx.beginPath()
  let tocoPenDown = false
  tocoPath.forEach((p, x) => {
    if (p.lost) { tocoPenDown = false; return }
    const y = tocoToPx(p.v)
    if (!tocoPenDown) { ctx.moveTo(x, y); tocoPenDown = true } else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // FHR
  ctx.strokeStyle = th.fhr; ctx.lineWidth = th.fhrLineWidth
  ctx.shadowColor = th.fhrGlow; ctx.shadowBlur = th.fhrGlowBlur
  ctx.beginPath()
  let penDown = false
  for (let x = 0; x < W; x++) {
    const t    = x / PX_PER_MIN
    // artefacto: pérdida de señal → se interrumpe el trazo (pen-up)
    if (artifactLevel > 0 && signalLost(t, duration, artifactLevel, artifactExpulsive)) {
      penDown = false
      continue
    }
    const sv   = getSegmentValues(segments, t)
    const v    = variabilityAt(x * 0.5, sv.varAmp, sv.stv)
    const drop = decelDropAt(t, x, decels)
    const rise = accelRiseAt(t, x, accels)
    let fhr = drop > 15
      ? sv.baseline - drop + hash(x * 0.9) * (sv.varAmp * 0.15)
      : sv.baseline + v - drop + rise
    if (artifactLevel > 0) fhr += artifactNoise(t, x, duration, artifactLevel, artifactExpulsive)
    const y = fhrToPx(clamp(fhr, FHR_MIN, FHR_MAX))
    if (!penDown) { ctx.moveTo(x, y); penDown = true }
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.shadowBlur = 0
}

// ── Exportación PNG con tamaño físico real (solo para descarga) ──
// Papel a 1 cm/min. Banda FCF: 8 cm · banda de escala: 1 cm · banda TOCO: 4 cm.
// Se renderiza en un canvas aparte a 300 DPI y se incrusta esa resolución
// en el propio PNG (chunk pHYs), para que "imprimir a tamaño real" respete
// estas medidas exactas — independiente del tamaño en pantalla.
const EXPORT_DPI     = 300
const EXPORT_PX_CM   = EXPORT_DPI / 2.54
const EXPORT_FHR_CM  = 8
const EXPORT_MID_CM  = 1
const EXPORT_TOCO_CM = 4

function buildExportCanvas(config: CTGConfig): HTMLCanvasElement {
  const { segments, accels, duration, decels, contractions, artifactLevel, artifactExpulsive, tocoSegments } = config
  const th = theme(true) // siempre estilo papel: pensado para imprimir

  const pxCm = EXPORT_PX_CM
  const pxPerMin = pxCm // velocidad real del papel: 1 cm/min
  const fhrH  = Math.round(EXPORT_FHR_CM  * pxCm)
  const midH  = Math.round(EXPORT_MID_CM  * pxCm)
  const tocoH = Math.round(EXPORT_TOCO_CM * pxCm)
  const marginTop    = Math.round(0.12 * pxCm)
  const marginBottom = Math.round(0.34 * pxCm)
  const axisW = Math.round(1.15 * pxCm)

  const fhrTop     = marginTop
  const fhrBottom  = fhrTop + fhrH
  const midTop     = fhrBottom
  const midBottom  = midTop + midH
  const tocoTop    = midBottom
  const tocoBottom = tocoTop + tocoH
  const canvasH    = tocoBottom + marginBottom

  const contentW = Math.round(duration * pxPerMin)
  const W = axisW + contentW

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = canvasH
  const ctx = canvas.getContext('2d')!

  const fhrToPxL  = (fhr: number) => fhrTop + (FHR_MAX - fhr) / (FHR_MAX - FHR_MIN) * (fhrBottom - fhrTop)
  const tocoToPxL = (p: number)   => tocoBottom - (p / 100) * (tocoBottom - tocoTop)

  ctx.fillStyle = th.bg
  ctx.fillRect(0, 0, W, canvasH)

  // Grid FCF
  for (let fhr = FHR_MIN; fhr <= FHR_MAX; fhr += 10) {
    const y = fhrToPxL(fhr)
    const major = fhr % 30 === 0
    ctx.strokeStyle = major ? th.hMajor : th.hMinor
    ctx.lineWidth = major ? 1.2 : 0.7
    ctx.beginPath(); ctx.moveTo(axisW, y); ctx.lineTo(W, y); ctx.stroke()
  }
  // Grid TOCO
  ;[0, 25, 50, 75, 100].forEach(p => {
    ctx.strokeStyle = th.tocoH; ctx.lineWidth = (p === 0 || p === 100) ? 1.0 : 0.7
    const y = tocoToPxL(p)
    ctx.beginPath(); ctx.moveTo(axisW, y); ctx.lineTo(W, y); ctx.stroke()
  })
  // Verticales: finas cada 0.5 min, oscuras cada 3 min, cruzan las tres bandas
  for (let half = 0; half <= duration * 2; half++) {
    const x = axisW + (half / 2) * pxPerMin
    const major = half % 6 === 0
    ctx.strokeStyle = major ? th.vMajor : th.vMinor
    ctx.lineWidth = major ? 1.6 : 0.7
    ctx.beginPath(); ctx.moveTo(x, fhrTop); ctx.lineTo(x, tocoBottom); ctx.stroke()
  }
  // Separadores entre bandas
  ctx.strokeStyle = th.tocoSep; ctx.lineWidth = 1.3
  ;[fhrBottom, midBottom].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() })

  // Escala FCF fija (eje izquierdo)
  ctx.font = `${Math.round(pxCm * 0.095)}px system-ui`; ctx.textAlign = 'right'; ctx.fillStyle = th.fhrLabelText
  ;[240, 210, 180, 150, 120, 90, 60, 30].forEach(fhr => ctx.fillText(String(fhr), axisW - 6, fhrToPxL(fhr) + 4))
  // Escala TOCO fija (eje izquierdo, mmHg)
  ctx.font = `${Math.round(pxCm * 0.09)}px system-ui`; ctx.fillStyle = th.tocoLabel
  ;[100, 75, 50, 25, 0].forEach(mmhg => ctx.fillText(String(mmhg), axisW - 6, tocoToPxL(mmhg) + 4))
  ctx.font = `bold ${Math.round(pxCm * 0.08)}px system-ui`
  ctx.fillText('mmHg', axisW - 6, tocoBottom - 4)

  // Escala FCF reimpresa cada 10 min
  ctx.font = `${Math.round(pxCm * 0.085)}px system-ui`; ctx.textAlign = 'right'
  for (let m = 10; m <= duration; m += 10) {
    const xr = axisW + m * pxPerMin
    ;[240, 210, 180, 150, 120, 90, 60, 30].forEach(fhr => {
      const y = fhrToPxL(fhr)
      ctx.fillStyle = th.fhrLabelBox
      ctx.fillRect(xr - pxCm * 0.28, y - pxCm * 0.065, pxCm * 0.26, pxCm * 0.13)
      ctx.fillStyle = th.fhrLabelText
      ctx.fillText(String(fhr), xr - pxCm * 0.04, y + pxCm * 0.03)
    })
  }
  // Escala TOCO reimpresa cada 5 min, alternando mmHg/kPa
  ctx.font = `${Math.round(pxCm * 0.08)}px system-ui`; ctx.textAlign = 'right'
  for (let m = 5; m <= duration; m += 5) {
    const xr = axisW + m * pxPerMin
    const isKpa = (m / 5) % 2 === 1
    const ticks = isKpa ? [2, 4, 6, 8, 10, 12] : [25, 50, 75, 100]
    const unit  = isKpa ? 'kPa' : 'mmHg'
    ticks.forEach(v => {
      const y = tocoToPxL(isKpa ? v * 7.5 : v)
      ctx.fillStyle = th.fhrLabelBox
      ctx.fillRect(xr - pxCm * 0.22, y - pxCm * 0.06, pxCm * 0.2, pxCm * 0.12)
      ctx.fillStyle = th.tocoLabel
      ctx.fillText(String(v), xr - pxCm * 0.04, y + pxCm * 0.03)
    })
    ctx.fillStyle = th.fhrLabelBox
    ctx.fillRect(xr - pxCm * 0.28, tocoBottom - pxCm * 0.11, pxCm * 0.26, pxCm * 0.1)
    ctx.fillStyle = th.tocoLabel
    ctx.fillText(unit, xr - pxCm * 0.04, tocoBottom - pxCm * 0.02)
  }

  // Banda intermedia (1 cm): velocidad de registro, "1 cm/min" cada 20 min
  ctx.textAlign = 'center'
  ctx.font = `bold ${Math.round(midH * 0.4)}px system-ui`; ctx.fillStyle = th.timeLabel
  for (let m = 0; m <= duration; m += 20) {
    const xr = axisW + m * pxPerMin + (m === 0 ? pxCm * 0.9 : 0)
    ctx.fillText('1 cm/min', xr, midTop + midH * 0.63)
  }

  // Etiquetas de minuto (debajo de la banda TOCO)
  ctx.fillStyle = th.timeLabel; ctx.font = `${Math.round(pxCm * 0.09)}px system-ui`; ctx.textAlign = 'center'
  for (let m = 3; m <= duration; m += 3) ctx.fillText(m + "'", axisW + m * pxPerMin, canvasH - marginBottom * 0.25)

  // TOCO (curva) — xSec mantiene el ruido/artefacto calibrado en "segundos"
  // reales, independiente de la resolución de exportación.
  const tocoPath: { v: number; lost: boolean }[] = []
  for (let px = 0; px < contentW; px++) {
    const t = px / pxPerMin
    const xSec = t * 60
    const tv = getTocoSegmentValues(tocoSegments, t)
    let toco = tv.tone + tocoNoiseAt(xSec, tv.noise)
    contractions.forEach(c => { toco += gaussian(t, c.time, c.duration * 0.48, c.amplitude) })
    const lost = tv.artifact > 0 && tocoSignalLost(t, tv.artifact)
    tocoPath.push({ v: clamp(toco, 0, 100), lost })
  }
  ctx.fillStyle = th.tocoFill
  ctx.beginPath()
  tocoPath.forEach((p, i) => { const x = axisW + i, y = tocoToPxL(p.v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
  ctx.lineTo(W, tocoBottom); ctx.lineTo(axisW, tocoBottom); ctx.closePath(); ctx.fill()
  ctx.strokeStyle = th.toco; ctx.lineWidth = 1.5
  ctx.beginPath()
  let tocoPenDown = false
  tocoPath.forEach((p, i) => {
    const x = axisW + i
    if (p.lost) { tocoPenDown = false; return }
    const y = tocoToPxL(p.v)
    if (!tocoPenDown) { ctx.moveTo(x, y); tocoPenDown = true } else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // FCF (curva)
  ctx.strokeStyle = th.fhr; ctx.lineWidth = th.fhrLineWidth
  ctx.shadowColor = th.fhrGlow; ctx.shadowBlur = th.fhrGlowBlur
  ctx.beginPath()
  let penDown = false
  for (let px = 0; px < contentW; px++) {
    const t = px / pxPerMin
    const xSec = t * 60
    if (artifactLevel > 0 && signalLost(t, duration, artifactLevel, artifactExpulsive)) { penDown = false; continue }
    const sv   = getSegmentValues(segments, t)
    const v    = variabilityAt(xSec * 0.5, sv.varAmp, sv.stv)
    const drop = decelDropAt(t, xSec, decels)
    const rise = accelRiseAt(t, xSec, accels)
    let fhr = drop > 15
      ? sv.baseline - drop + hash(xSec * 0.9) * (sv.varAmp * 0.15)
      : sv.baseline + v - drop + rise
    if (artifactLevel > 0) fhr += artifactNoise(t, xSec, duration, artifactLevel, artifactExpulsive)
    const x = axisW + px
    const y = fhrToPxL(clamp(fhr, FHR_MIN, FHR_MAX))
    if (!penDown) { ctx.moveTo(x, y); penDown = true }
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.shadowBlur = 0

  return canvas
}

// ── PNG: incrustar DPI real (chunk pHYs) ──────────────────
function crc32(buf: Uint8Array): number {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function addPhysChunk(pngBytes: Uint8Array, dpi: number): Uint8Array {
  const pxPerMeter = Math.round(dpi / 0.0254)
  const typeAndData = new Uint8Array(13)
  typeAndData.set([0x70, 0x48, 0x59, 0x73], 0) // 'pHYs'
  new DataView(typeAndData.buffer).setUint32(4, pxPerMeter, false)
  new DataView(typeAndData.buffer).setUint32(8, pxPerMeter, false)
  typeAndData[12] = 1 // unidad: metro
  const crc = crc32(typeAndData)
  const chunk = new Uint8Array(4 + 13 + 4)
  new DataView(chunk.buffer).setUint32(0, 9, false) // longitud de datos = 9
  chunk.set(typeAndData, 4)
  new DataView(chunk.buffer).setUint32(17, crc, false)

  const insertAt = 33 // firma PNG (8) + chunk IHDR completo (4+4+13+4=25)
  const out = new Uint8Array(pngBytes.length + chunk.length)
  out.set(pngBytes.subarray(0, insertAt), 0)
  out.set(chunk, insertAt)
  out.set(pngBytes.subarray(insertAt), insertAt + chunk.length)
  return out
}

// ── Slider ────────────────────────────────────────────────
function Slider({ label, value, min, max, step = 1, unit = '', onChange, color, note }: {
  label: string; value: number; min: number; max: number; step?: number
  unit?: string; onChange: (v: number) => void; color?: string; note?: string
}) {
  const U = useUI()
  const c = color ?? U.accent
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs" style={{ color: U.textMuted }}>{label}</label>
        <div className="text-right">
          <span className="text-xs font-bold" style={{ color: c }}>{value}{unit ? ' ' + unit : ''}</span>
          {note && <span className="text-xs ml-1.5 opacity-70" style={{ color: c }}>· {note}</span>}
        </div>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={ev => onChange(Number(ev.target.value))}
        className="w-full h-1.5 cursor-pointer rounded-full"
        style={{ accentColor: c }}
      />
    </div>
  )
}

// ── Toggle ────────────────────────────────────────────────
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const U = useUI()
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs" style={{ color: U.textMuted }}>{label}</span>
      <button
        onClick={() => onChange(!value)}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: value ? U.accent : U.toggleOff }}
      >
        <span
          className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-all"
          style={{ marginLeft: value ? 19 : 3 }}
        />
      </button>
    </div>
  )
}

// ── NumberInput ───────────────────────────────────────────
function NumberInput({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void
}) {
  const U = useUI()
  return (
    <div>
      <label className="text-[10px] block mb-1" style={{ color: U.textFaint }}>{label}</label>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={ev => onChange(Number(ev.target.value))}
        className="w-full text-xs rounded-md px-2 py-1.5 outline-none border"
        style={{ background: U.inputBg, borderColor: U.inputBorder, color: U.inputText }}
      />
    </div>
  )
}

// ── SectionTitle ──────────────────────────────────────────
function SectionTitle({ children, color }: { children: React.ReactNode; color?: string }) {
  const U = useUI()
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest mb-2.5 mt-4 pb-1.5 border-b"
      style={{ color: color ?? U.textMuted, borderColor: U.border, letterSpacing: 2 }}>
      {children}
    </p>
  )
}

// ── DecelCard ─────────────────────────────────────────────
function DecelCard({ decel, index, onChange, onRemove, onDuplicate }: {
  decel: Decel; index: number; onChange: (d: Decel) => void; onRemove: () => void; onDuplicate: () => void
}) {
  const U = useUI()
  return (
    <div className="rounded-lg p-3 mb-2 border" style={{ background: U.cardBg, borderColor: U.borderStrong }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold" style={{ color: U.accent }}>Desacel. #{index + 1}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onDuplicate}
            title="Duplicar desaceleración"
            className="hover:text-cyan-500 text-xs leading-none transition-colors"
            style={{ color: U.textFaint }}
          >⧉</button>
          <button onClick={onRemove} className="hover:text-red-400 text-base leading-none transition-colors" style={{ color: U.textFaint }}>×</button>
        </div>
      </div>
      <div className="mb-2">
        <label className="text-[10px] block mb-1" style={{ color: U.textFaint }}>Tipo</label>
        <select
          value={decel.type}
          onChange={ev => onChange({ ...decel, type: ev.target.value as Decel['type'] })}
          className="w-full text-xs rounded-md px-2 py-1.5 outline-none border"
          style={{ background: U.selectBg, borderColor: U.inputBorder, color: U.inputText }}
        >
          <option value="variable">Barorreceptora simple</option>
          <option value="variableComplicated">Barorreceptora complicada (nadir bifásico)</option>
          <option value="variableShoulders">Barorreceptora con hombros</option>
          <option value="late">Tardía (quimiorreceptora)</option>
          <option value="early">Precoz (espejo)</option>
          <option value="prolonged">Prolongada (&gt; 2 min)</option>
        </select>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberInput label="Inicio (min)"    value={decel.time}     min={0.5} max={60}  step={0.5} onChange={v => onChange({ ...decel, time: v })} />
        <NumberInput label="Profund. (lpm)"  value={decel.depth}    min={10}  max={90}  step={5}   onChange={v => onChange({ ...decel, depth: v })} />
        <NumberInput label="Duración (seg)"  value={decel.duration} min={15}  max={300} step={5}   onChange={v => onChange({ ...decel, duration: v })} />
      </div>
      {(decel.type === 'variable' || decel.type === 'variableComplicated' || decel.type === 'variableShoulders') && (() => {
        const defOnset = decel.type === 'variableComplicated' ? 10 : 8
        const defRecov = decel.type === 'variableComplicated' ? 25 : 12
        return (
          <div className="mt-2">
            <Slider
              label="Tiempo de caída (onset→nadir)" value={decel.onset ?? defOnset}
              min={2} max={29} step={1} unit="s" color={U.accent}
              note="abrupta: <30s"
              onChange={v => onChange({ ...decel, onset: v })}
            />
            <Slider
              label="Tiempo de recuperación (nadir→basal)" value={decel.recovery ?? defRecov}
              min={3} max={45} step={1} unit="s" color={U.accent}
              note={(decel.recovery ?? defRecov) > 30 ? 'sin límite (>30s ok)' : undefined}
              onChange={v => onChange({ ...decel, recovery: v })}
            />
            {decel.type === 'variableShoulders' && (
              <>
                <Slider
                  label="Hombro previo (amplitud)" value={decel.preShoulder ?? 16}
                  min={15} max={30} step={1} unit="lpm" color={U.accent}
                  onChange={v => onChange({ ...decel, preShoulder: v })}
                />
                <Slider
                  label="Hombro posterior (amplitud)" value={decel.postShoulder ?? 0}
                  min={0} max={30} step={1} unit="lpm" color={U.accent}
                  note={(decel.postShoulder ?? 0) === 0 ? 'ausente' : undefined}
                  onChange={v => onChange({ ...decel, postShoulder: v })}
                />
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ── AccelCard ─────────────────────────────────────────────
function AccelCard({ accel, index, onChange, onRemove }: {
  accel: Accel; index: number; onChange: (a: Accel) => void; onRemove: () => void
}) {
  const U = useUI()
  return (
    <div className="rounded-lg p-3 mb-2 border" style={{ background: U.cardBg, borderColor: U.borderStrong }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-emerald-500">Acel. #{index + 1}</span>
        <button onClick={onRemove} className="hover:text-red-400 text-base leading-none transition-colors" style={{ color: U.textFaint }}>×</button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberInput label="Inicio (min)"    value={accel.time}      min={0.5} max={60}  step={0.5} onChange={v => onChange({ ...accel, time: v })} />
        <NumberInput label="Amplitud (lpm)"  value={accel.amplitude} min={10}  max={45}  step={5}   onChange={v => onChange({ ...accel, amplitude: v })} />
        <NumberInput label="Duración (seg)"  value={accel.duration}  min={15}  max={120} step={5}   onChange={v => onChange({ ...accel, duration: v })} />
      </div>
    </div>
  )
}

// ── ContractionCard ───────────────────────────────────────
function ContractionCard({ c, index, onChange, onRemove, onDuplicate }: {
  c: Contraction; index: number; onChange: (c: Contraction) => void; onRemove: () => void; onDuplicate: () => void
}) {
  const U = useUI()
  return (
    <div className="rounded-lg p-3 mb-2 border" style={{ background: U.cardBg, borderColor: U.borderStrong }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-amber-500">Contracción #{index + 1}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onDuplicate}
            title="Duplicar contracción"
            className="hover:text-amber-500 text-xs leading-none transition-colors"
            style={{ color: U.textFaint }}
          >⧉</button>
          <button onClick={onRemove} className="hover:text-red-400 text-base leading-none transition-colors" style={{ color: U.textFaint }}>×</button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberInput label="Inicio (min)"    value={c.time}      min={0.5} max={60}  step={0.5} onChange={v => onChange({ ...c, time: v })} />
        <NumberInput label="Duración (min)"  value={c.duration}  min={0.3} max={2.5} step={0.1} onChange={v => onChange({ ...c, duration: v })} />
        <NumberInput label="Amplitud (UA)"   value={c.amplitude} min={20}  max={100} step={5}   onChange={v => onChange({ ...c, amplitude: v })} />
      </div>
    </div>
  )
}

// ── Y-axis overlay ────────────────────────────────────────
function YAxis({ paper }: { paper: boolean }) {
  const bg   = paper ? '#fffdfa' : '#050816'
  const fhrC = paper ? 'rgba(150,60,55,0.85)' : 'rgba(148,163,184,0.75)'
  const uaC  = paper ? 'rgba(120,80,30,0.9)'  : 'rgba(251,191,36,0.6)'
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, width: AXIS_W, height: CANVAS_H,
      pointerEvents: 'none', zIndex: 10,
      background: `linear-gradient(to right, ${bg} 65%, transparent)`
    }}>
      {[240, 210, 180, 150, 120, 90, 60, 30].map(fhr => (
        <div key={fhr} style={{
          position: 'absolute', top: fhrToPx(fhr) - 7, left: 0, width: AXIS_W - 4,
          textAlign: 'right', fontSize: 9, color: fhrC
        }}>{fhr}</div>
      ))}
      {/* Graduación TOCO en mmHg (escala principal, papel chileno); unidad abajo */}
      {[100, 75, 50, 25].map(mmhg => (
        <div key={'t' + mmhg} style={{
          position: 'absolute', top: tocoToPx(mmhg) - 6, left: 0, width: AXIS_W - 4,
          textAlign: 'right', fontSize: 8, color: uaC
        }}>{mmhg}</div>
      ))}
      <div style={{
        position: 'absolute', top: TOCO_BOTTOM - 10, left: 0, width: AXIS_W - 4,
        textAlign: 'right', fontSize: 7, color: uaC, fontWeight: 'bold'
      }}>mmHg</div>
    </div>
  )
}

// ── Splash screen ─────────────────────────────────────────
// Portada animada al cargar: la esfera del logo entra con un pulso de
// brillo y, debajo, un trazado CTG (FCF cian + TOCO ámbar) se "dibuja"
// solo (stroke-dasharray con pathLength=1, cross-browser sin medir el
// path real). Se desvanece a los ~1.7s dejando ver el editor.
function SplashScreen({ visible }: { visible: boolean }) {
  // Estilos de layout inline (no clases Tailwind): este overlay debe cubrir
  // la pantalla siempre, incluso si el CDN de Tailwind tarda en cargar o falla.
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: '#0B1120', opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 500ms ease',
      }}
    >
      <style>{`
        @keyframes splashPop  { 0% { transform: scale(0.75); opacity: 0 } 60% { transform: scale(1.06); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
        @keyframes splashGlow { 0%,100% { filter: drop-shadow(0 0 6px rgba(34,211,238,0.35)) } 50% { filter: drop-shadow(0 0 22px rgba(34,211,238,0.65)) } }
        @keyframes splashDraw { to { stroke-dashoffset: 0 } }
        @keyframes splashFadeUp { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
        .splash-logo       { animation: splashPop 0.6s cubic-bezier(.2,.9,.3,1.3) both, splashGlow 2.2s ease-in-out 0.6s infinite; }
        .splash-trace-cyan  { stroke-dasharray: 1; stroke-dashoffset: 1; animation: splashDraw 1.1s 0.35s cubic-bezier(.4,0,.2,1) forwards; }
        .splash-trace-amber { stroke-dasharray: 1; stroke-dashoffset: 1; animation: splashDraw 1.1s 0.55s cubic-bezier(.4,0,.2,1) forwards; }
        .splash-word    { opacity: 0; animation: splashFadeUp 0.5s 0.9s ease-out forwards; }
        .splash-credit  { opacity: 0; animation: splashFadeUp 0.5s 1.2s ease-out forwards; }
      `}</style>
      <img src="/logo-icon.png" alt="CTG Creator" width={120} height={120} className="splash-logo" />
      <svg viewBox="0 0 400 60" width={260} height={40} style={{ marginTop: 18 }}>
        <path d="M0,30 L60,30 L75,8 L90,52 L105,30 L160,30 L178,14 L192,46 L206,30 L400,30"
          fill="none" stroke="#22d3ee" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"
          pathLength={1} className="splash-trace-cyan" />
        <path d="M0,52 L120,52 Q170,20 220,20 Q270,20 320,52 L400,52"
          fill="none" stroke="#f59e0b" strokeWidth={3} strokeLinecap="round"
          pathLength={1} className="splash-trace-amber" />
      </svg>
      <div className="splash-word" style={{ marginTop: 14, fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>
        CTG <span style={{ color: '#22d3ee' }}>Creator</span>
      </div>
      <div className="splash-credit" style={{ marginTop: 6, fontSize: 10.5, color: 'rgba(148,163,184,0.75)', textAlign: 'center' }}>
        Herramienta educativa de simulación CTG · Desarrollado por Emmanuel Andrades, Universidad de Talca
      </div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────
let nextId = 1
let nextTocoId = 1

export default function App() {
  const [segments,      setSegments]      = useState<Segment[]>([{ id: 0, time: 0, baseline: 140, varAmp: 12, stv: 0.35 }])
  const [activeSegId,   setActiveSegId]   = useState(0)
  const [accels,        setAccels]        = useState<Accel[]>([])
  const [duration,      setDuration]      = useState(20)
  const [decels,        setDecels]        = useState<Decel[]>([])
  const [contractions,  setContractions]  = useState<Contraction[]>([])
  const [artifactLevel,     setArtifactLevel]     = useState(0)
  const [artifactExpulsive, setArtifactExpulsive] = useState(true)
  const [tocoSegments,    setTocoSegments]    = useState<TocoSegment[]>([{ id: 0, time: 0, tone: 10, noise: 35, artifact: 0 }])
  const [activeTocoSegId, setActiveTocoSegId] = useState(0)
  const [paper,         setPaper]         = useState(true)
  const [darkUI,        setDarkUI]        = useState(false)
  const [sidebarTab,    setSidebarTab]    = useState<'trazado' | 'accels' | 'decels' | 'contracciones'>('trazado')
  const [showSplash,     setShowSplash]     = useState(true)
  const [splashVisible,  setSplashVisible]  = useState(true)

  useEffect(() => {
    const fade    = setTimeout(() => setSplashVisible(false), 3500)
    const unmount = setTimeout(() => setShowSplash(false), 4000)
    return () => { clearTimeout(fade); clearTimeout(unmount) }
  }, [])

  const U = darkUI ? uiThemeDark : uiThemeLight

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeSeg = segments.find(s => s.id === activeSegId) ?? segments[0]
  const activeTocoSeg = tocoSegments.find(s => s.id === activeTocoSegId) ?? tocoSegments[0]

  useEffect(() => {
    if (!canvasRef.current) return
    drawCTG(canvasRef.current, {
      segments, accels, duration, decels, contractions,
      activeSegTime: activeSeg?.time ?? 0,
      artifactLevel, artifactExpulsive, paper,
      tocoSegments, activeTocoSegTime: activeTocoSeg?.time ?? 0,
    })
  }, [segments, accels, duration, decels, contractions, activeSegId, artifactLevel, artifactExpulsive, paper, tocoSegments, activeTocoSegId])

  const updateSeg = (field: keyof Segment, value: number) => {
    setSegments(prev => prev.map(s => s.id === activeSegId ? { ...s, [field]: value } : s))
  }
  const updateTocoSeg = (field: keyof TocoSegment, value: number) => {
    setTocoSegments(prev => prev.map(s => s.id === activeTocoSegId ? { ...s, [field]: value } : s))
  }

  const handleCanvasClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px   = ev.clientX - rect.left
    const py   = ev.clientY - rect.top
    const t    = parseFloat((px / PX_PER_MIN).toFixed(1))
    if (t < 0.1 || t > duration - 0.1) return

    const inTocoPanel = py > (FHR_BOTTOM + TOCO_TOP) / 2

    if (inTocoPanel) {
      const tooClose = tocoSegments.some(s => Math.abs(s.time - t) < 0.3)
      if (tooClose) {
        const nearest = tocoSegments.reduce((a, b) => Math.abs(a.time - t) < Math.abs(b.time - t) ? a : b)
        setActiveTocoSegId(nearest.id)
        setSidebarTab('contracciones')
        return
      }
      const inherited = getTocoSegmentValues(tocoSegments, t)
      const newSeg: TocoSegment = {
        id:       nextTocoId++,
        time:     t,
        tone:     Math.round(inherited.tone),
        noise:    Math.round(inherited.noise),
        artifact: Math.round(inherited.artifact),
      }
      setTocoSegments(prev => [...prev, newSeg].sort((a, b) => a.time - b.time))
      setActiveTocoSegId(newSeg.id)
      setSidebarTab('contracciones')
      return
    }

    const tooClose = segments.some(s => Math.abs(s.time - t) < 0.3)
    if (tooClose) {
      const nearest = segments.reduce((a, b) => Math.abs(a.time - t) < Math.abs(b.time - t) ? a : b)
      setActiveSegId(nearest.id)
      return
    }

    const inherited = getSegmentValues(segments, t)
    const newSeg: Segment = {
      id:       nextId++,
      time:     t,
      baseline: Math.round(inherited.baseline),
      varAmp:   Math.round(inherited.varAmp * 10) / 10,
      stv:      inherited.stv,
    }
    setSegments(prev => [...prev, newSeg].sort((a, b) => a.time - b.time))
    setActiveSegId(newSeg.id)
    setSidebarTab('trazado')
  }, [segments, tocoSegments, duration])

  const removeSeg = (id: number) => {
    if (id === 0) return
    setSegments(prev => prev.filter(s => s.id !== id))
    setActiveSegId(0)
  }
  const removeTocoSeg = (id: number) => {
    if (id === 0) return
    setTocoSegments(prev => prev.filter(s => s.id !== id))
    setActiveTocoSegId(0)
  }

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({
      segments, accels, duration, decels, contractions,
      artifact: { level: artifactLevel, expulsive: artifactExpulsive },
      tocoSegments,
    }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = 'trazado-ctg.json'; a.click()
  }
  const exportPNG = () => {
    const exportCanvas = buildExportCanvas({
      segments, accels, duration, decels, contractions,
      activeSegTime: 0, artifactLevel, artifactExpulsive, paper: true,
      tocoSegments, activeTocoSegTime: 0,
    })
    exportCanvas.toBlob(blob => {
      if (!blob) return
      blob.arrayBuffer().then(buf => {
        const withDpi = addPhysChunk(new Uint8Array(buf), EXPORT_DPI)
        const finalBlob = new Blob([withDpi], { type: 'image/png' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(finalBlob); a.download = 'trazado-ctg.png'; a.click()
      })
    }, 'image/png')
  }

  return (
    <UICtx.Provider value={U}>
    {showSplash && <SplashScreen visible={splashVisible} />}
    <div className="flex h-screen overflow-hidden" style={{ background: U.appBg }}>

      {/* ── SIDEBAR ── */}
      <div className="w-68 shrink-0 flex flex-col border-r overflow-y-auto" style={{ width: 272, background: U.panelBg, borderColor: U.border }}>

        {/* Header */}
        <div className="px-4 py-3.5 border-b" style={{ borderColor: U.border }}>
          <div className="flex items-center gap-2 mb-1">
            <img src="/logo-icon.png" alt="" width={26} height={26} style={{ borderRadius: 6 }} />
            <span className="text-sm font-bold" style={{ color: U.headerText }}>CTG <span style={{ color: U.accent }}>Creator</span></span>
            <button
              onClick={() => setDarkUI(v => !v)}
              title={darkUI ? 'Cambiar a interfaz clara' : 'Cambiar a interfaz oscura'}
              className="ml-auto text-sm leading-none rounded-md px-1.5 py-1 border transition-colors"
              style={{ borderColor: U.borderStrong, color: U.textMuted }}
            >{darkUI ? '☀️' : '🌙'}</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: U.border }}>
          {([
            { key: 'trazado',       label: 'Trazado' },
            { key: 'accels',        label: `Acel. (${accels.length})` },
            { key: 'decels',        label: `Desac. (${decels.length})` },
            { key: 'contracciones', label: `Contr. (${contractions.length})` }
          ] as const).map(tab => (
            <button
              key={tab.key}
              onClick={() => setSidebarTab(tab.key)}
              className="flex-1 py-2 text-[9px] font-semibold border-b-2 transition-all"
              style={{
                borderBottomColor: sidebarTab === tab.key ? U.accent : 'transparent',
                color: sidebarTab === tab.key ? U.accentActive : U.textFaint,
                background: 'transparent'
              }}
            >{tab.label}</button>
          ))}
        </div>

        {/* ── Trazado tab ── */}
        {sidebarTab === 'trazado' && (
          <div className="flex-1 px-3.5 py-3">
            <SectionTitle>Duración del trazado</SectionTitle>
            <Slider label="Duración" value={duration} min={5} max={40} unit="min" onChange={setDuration} />
            <Toggle label="Papel real (impresión)" value={paper} onChange={setPaper} />

            <SectionTitle color="#f59e0b">Artefacto / pérdida de señal</SectionTitle>
            <Slider
              label="Intensidad" value={artifactLevel}
              min={0} max={100} step={5} unit="%"
              color={artifactLevel === 0 ? '#475569' : '#f59e0b'}
              note={artifactLevel === 0 ? 'Limpio' : artifactLevel <= 30 ? 'Leve' : artifactLevel <= 60 ? 'Moderado' : 'Marcado'}
              onChange={setArtifactLevel}
            />
            <Toggle label="Concentrar en expulsivo" value={artifactExpulsive} onChange={setArtifactExpulsive} />
            <p className="text-[10px] -mt-1 mb-1" style={{ color: U.textFaint }}>Simula la pérdida de contacto real (movimiento materno, pujo)</p>

            <SectionTitle color={U.accent}>Puntos de quiebre ({segments.length})</SectionTitle>
            <p className="text-[10px] -mt-2 mb-2" style={{ color: U.textFaint }}>Haz clic en el trazado para agregar</p>

            {segments.map(seg => (
              <div
                key={seg.id}
                onClick={() => setActiveSegId(seg.id)}
                className="px-3 py-2 rounded-lg mb-1.5 cursor-pointer border transition-all"
                style={{
                  borderColor: seg.id === activeSegId ? U.segActiveBorder : U.segInactiveBorder,
                  background:  seg.id === activeSegId ? U.segActiveBg : U.segInactiveBg
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold" style={{ color: seg.id === activeSegId ? U.accentActive : U.text }}>
                    {seg.time === 0 ? 'Inicio (min 0)' : `Desde min ${seg.time.toFixed(1)}`}
                  </span>
                  {seg.id !== 0 && (
                    <button
                      onClick={ev => { ev.stopPropagation(); removeSeg(seg.id) }}
                      className="hover:text-red-400 text-sm leading-none transition-colors" style={{ color: U.textFaint }}
                    >×</button>
                  )}
                </div>
                <div className="flex gap-3 mt-1">
                  <span className="text-[10px]" style={{ color: '#6EE7FF' }}>FCF {seg.baseline} lpm</span>
                  <span className="text-[10px]" style={{ color: varColor(seg.varAmp) }}>
                    Var. {seg.varAmp} lpm · {varLabel(seg.varAmp)}
                  </span>
                </div>
              </div>
            ))}

            {/* Active segment sliders */}
            {activeSeg && (
              <div className="mt-3 p-3 rounded-xl border" style={{
                background: U.editBg,
                borderColor: U.editBorder
              }}>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: U.accentActive }}>
                  {activeSeg.time === 0 ? 'Editando: inicio' : `Editando: desde min ${activeSeg.time.toFixed(1)}`}
                </p>
                <Slider
                  label="FCF Basal" value={activeSeg.baseline}
                  min={60} max={210} step={1} unit="lpm" color="#6EE7FF"
                  onChange={v => updateSeg('baseline', v)}
                />
                <Slider
                  label="Variabilidad (amplitud)" value={activeSeg.varAmp}
                  min={0} max={90} step={0.5} unit="lpm"
                  color={varColor(activeSeg.varAmp)}
                  note={varLabel(activeSeg.varAmp)}
                  onChange={v => updateSeg('varAmp', v)}
                />
                <Slider
                  label="STV / textura" value={Math.round((activeSeg.stv ?? 0.35) * 100)}
                  min={0} max={100} step={5} unit="%"
                  color="#38bdf8"
                  note={stvLabel(activeSeg.stv ?? 0.35)}
                  onChange={v => updateSeg('stv', v / 100)}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Aceleraciones tab ── */}
        {sidebarTab === 'accels' && (
          <div className="flex-1 px-3.5 py-3">
            {accels.length === 0 && (
              <p className="text-[10px] mb-2" style={{ color: U.textFaint }}>Aceleración: subida ≥ 15 lpm sobre la basal durante ≥ 15 s (feto de término).</p>
            )}
            {accels.map((a, i) => (
              <AccelCard
                key={i} accel={a} index={i}
                onChange={v => setAccels(prev => prev.map((x, j) => j === i ? v : x))}
                onRemove={() => setAccels(prev => prev.filter((_, j) => j !== i))}
              />
            ))}
            <button
              onClick={() => setAccels(a => [...a, { time: parseFloat((duration * 0.3).toFixed(1)), amplitude: 20, duration: 30 }])}
              className="w-full py-2 rounded-lg border border-dashed text-xs hover:border-emerald-500 hover:text-emerald-500 transition-colors mt-1"
              style={{ borderColor: U.dashed, color: U.textMuted }}
            >+ Agregar aceleración</button>
          </div>
        )}

        {/* ── Desaceleraciones tab ── */}
        {sidebarTab === 'decels' && (
          <div className="flex-1 px-3.5 py-3">
            {decels.map((d, i) => (
              <DecelCard
                key={i} decel={d} index={i}
                onChange={v => setDecels(prev => prev.map((x, j) => j === i ? v : x))}
                onRemove={() => setDecels(prev => prev.filter((_, j) => j !== i))}
                onDuplicate={() => setDecels(prev => {
                  const dupTime = parseFloat(Math.min(d.time + d.duration / 60 + 2, duration - 0.5).toFixed(1))
                  const dup: Decel = { ...d, time: dupTime }
                  return [...prev.slice(0, i + 1), dup, ...prev.slice(i + 1)]
                })}
              />
            ))}
            <button
              onClick={() => setDecels(d => {
                let nextTime: number
                if (d.length === 0) {
                  nextTime = 1
                } else {
                  const last = d[d.length - 1]
                  nextTime = last.time + last.duration / 60 + 2
                }
                nextTime = Math.min(parseFloat(nextTime.toFixed(1)), duration - 0.5)
                return [...d, { type: 'variable', time: nextTime, depth: 35, duration: 45, onset: 8, recovery: 12 }]
              })}
              className="w-full py-2 rounded-lg border border-dashed text-xs hover:border-cyan-500 hover:text-cyan-500 transition-colors mt-1"
              style={{ borderColor: U.dashed, color: U.textMuted }}
            >+ Agregar desaceleración</button>
          </div>
        )}

        {/* ── Contracciones tab ── */}
        {sidebarTab === 'contracciones' && (
          <div className="flex-1 px-3.5 py-3">
            <SectionTitle color="#f59e0b">Motor general TOCO ({tocoSegments.length})</SectionTitle>
            <p className="text-[10px] -mt-2 mb-2" style={{ color: U.textFaint }}>Haz clic en el panel TOCO del trazado para agregar un punto de quiebre</p>

            {tocoSegments.map(seg => (
              <div
                key={seg.id}
                onClick={() => setActiveTocoSegId(seg.id)}
                className="px-3 py-2 rounded-lg mb-1.5 cursor-pointer border transition-all"
                style={{
                  borderColor: seg.id === activeTocoSegId ? '#f59e0b' : U.segInactiveBorder,
                  background:  seg.id === activeTocoSegId ? 'rgba(245,158,11,0.08)' : U.segInactiveBg
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold" style={{ color: seg.id === activeTocoSegId ? '#b45309' : U.text }}>
                    {seg.time === 0 ? 'Inicio (min 0)' : `Desde min ${seg.time.toFixed(1)}`}
                  </span>
                  {seg.id !== 0 && (
                    <button
                      onClick={ev => { ev.stopPropagation(); removeTocoSeg(seg.id) }}
                      className="hover:text-red-400 text-sm leading-none transition-colors" style={{ color: U.textFaint }}
                    >×</button>
                  )}
                </div>
                <div className="flex gap-3 mt-1">
                  <span className="text-[10px] text-amber-600">Tono {seg.tone} mmHg</span>
                  <span className="text-[10px]" style={{ color: U.textFaint }}>Ruido {seg.noise}%</span>
                  <span className="text-[10px]" style={{ color: U.textFaint }}>Artef. {seg.artifact}%</span>
                </div>
              </div>
            ))}

            {activeTocoSeg && (
              <div className="mt-3 p-3 rounded-xl border" style={{ background: 'rgba(245,158,11,0.05)', borderColor: 'rgba(245,158,11,0.25)' }}>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: '#b45309' }}>
                  {activeTocoSeg.time === 0 ? 'Editando: inicio' : `Editando: desde min ${activeTocoSeg.time.toFixed(1)}`}
                </p>
                <Slider
                  label="Tono uterino (basal)" value={activeTocoSeg.tone}
                  min={0} max={30} step={1} unit="mmHg" color="#f59e0b"
                  note={activeTocoSeg.tone < 8 ? 'Hipotónico' : activeTocoSeg.tone > 15 ? 'Hipertónico' : 'Normal'}
                  onChange={v => updateTocoSeg('tone', v)}
                />
                <Slider
                  label="Ruido de línea" value={activeTocoSeg.noise}
                  min={0} max={100} step={5} unit="%" color="#f59e0b"
                  note={activeTocoSeg.noise === 0 ? 'Lisa' : activeTocoSeg.noise <= 40 ? 'Sutil' : activeTocoSeg.noise <= 70 ? 'Visible' : 'Marcado'}
                  onChange={v => updateTocoSeg('noise', v)}
                />
                <Slider
                  label="Artefacto (pérdida de señal)" value={activeTocoSeg.artifact}
                  min={0} max={100} step={5} unit="%" color="#f59e0b"
                  note={activeTocoSeg.artifact === 0 ? 'Limpio' : activeTocoSeg.artifact <= 40 ? 'Leve' : activeTocoSeg.artifact <= 70 ? 'Moderado' : 'Marcado'}
                  onChange={v => updateTocoSeg('artifact', v)}
                />
              </div>
            )}

            <SectionTitle color="#f59e0b">Contracciones ({contractions.length})</SectionTitle>
            {contractions.map((c, i) => (
              <ContractionCard
                key={i} c={c} index={i}
                onChange={v => setContractions(prev => prev.map((x, j) => j === i ? v : x))}
                onRemove={() => setContractions(prev => prev.filter((_, j) => j !== i))}
                onDuplicate={() => setContractions(prev => {
                  const dup: Contraction = { ...c, time: Math.min(c.time + 2, duration - 0.5) }
                  return [...prev.slice(0, i + 1), dup, ...prev.slice(i + 1)]
                })}
              />
            ))}
            <button
              onClick={() => setContractions(c => {
                const nextTime = c.length === 0 ? 2 : c[c.length - 1].time + 2
                return [...c, { time: Math.min(nextTime, duration - 0.5), duration: 0.8, amplitude: 80 }]
              })}
              className="w-full py-2 rounded-lg border border-dashed text-xs hover:border-amber-500 hover:text-amber-500 transition-colors mt-1"
              style={{ borderColor: U.dashed, color: U.textMuted }}
            >+ Agregar contracción</button>
          </div>
        )}

        {/* Export */}
        <div className="px-3.5 py-3 border-t space-y-2" style={{ borderColor: U.border }}>
          <button onClick={exportJSON}
            className="w-full py-2.5 rounded-lg text-white text-xs font-semibold transition-colors"
            style={{ background: U.exportPrimaryBg }}>
            ↓  Exportar JSON
          </button>
          <button onClick={exportPNG}
            className="w-full py-2.5 rounded-lg border text-xs font-semibold transition-colors"
            style={{ borderColor: U.borderStrong, color: U.exportSecondaryText }}>
            ↓  Exportar PNG
          </button>
        </div>
      </div>

      {/* ── CANVAS AREA ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <div className="px-5 py-2.5 border-b flex items-center gap-4 shrink-0" style={{ background: U.panelBg, borderColor: U.border }}>
          <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: U.textFaint }}>Vista previa</span>
          <span className="text-xs font-bold" style={{ color: darkUI ? '#6EE7FF' : '#0e7490' }}>FCF {activeSeg?.baseline ?? 140} lpm</span>
          <span className="text-xs font-semibold" style={{ color: varColor(activeSeg?.varAmp ?? 8) }}>
            Var. {varLabel(activeSeg?.varAmp ?? 8)}
          </span>
          {segments.length > 1 && <span className="text-xs" style={{ color: U.accentActive }}>{segments.length} segmentos</span>}
          {tocoSegments.length > 1 && <span className="text-xs text-amber-600">{tocoSegments.length} tramos TOCO</span>}
          {accels.length > 0 && <span className="text-xs text-emerald-500">{accels.length} acel.</span>}
          {decels.length > 0 && <span className="text-xs text-purple-500">{decels.length} desacel.</span>}
          {contractions.length > 0 && <span className="text-xs text-amber-500">{contractions.length} contrac.</span>}
          <span className="ml-auto text-[10px] px-2.5 py-1 rounded-full border" style={{ borderColor: U.borderStrong, color: U.textMuted }}>
            clic en FCF/TOCO → punto de quiebre
          </span>
        </div>

        {/* Canvas */}
        <div className="flex-1 overflow-auto p-4" style={{ background: U.canvasArea }}>
          <div
            className="relative inline-block"
            style={{ minWidth: '100%', cursor: 'crosshair' }}
            onClick={handleCanvasClick}
          >
            <YAxis paper={paper} />
            <canvas
              ref={canvasRef}
              style={{
                display: 'block', marginLeft: AXIS_W, borderRadius: 10,
                border: paper ? '1px solid rgba(205,82,74,0.25)' : '1px solid rgba(110,231,255,0.07)',
                boxShadow: '0 8px 40px rgba(0,0,0,0.6)'
              }}
            />
          </div>
        </div>

        {/* Bottom bar */}
        <div className="px-5 py-1.5 border-t flex items-center" style={{ background: U.panelBg, borderColor: U.border }}>
          <span className="text-[9px]" style={{ color: U.textFaint }}>■ FCF  ·  ■ TOCO  ·  Escala 1 cm/min  ·  ▲ = marcador de segmento</span>
          <span className="ml-auto text-[9px]" style={{ color: U.textFaint }}>Herramienta educativa de simulación CTG · Desarrollado por Emmanuel Andrades, Universidad de Talca</span>
        </div>
      </div>
    </div>
    </UICtx.Provider>
  )
}
