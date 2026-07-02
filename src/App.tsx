import { useState, useEffect, useRef, useCallback } from 'react'

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
  varAmp: number
}
interface Decel {
  type: 'variable' | 'late' | 'early' | 'prolonged'
  time: number
  depth: number
  duration: number
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
interface CTGConfig {
  segments: Segment[]
  cycling: boolean
  autoAccels: boolean
  accels: Accel[]
  duration: number
  decels: Decel[]
  contractions: Contraction[]
  activeSegTime: number
  artifactLevel: number      // 0–100, intensidad de pérdida de señal / artefacto
  artifactExpulsive: boolean // concentrar el artefacto hacia el expulsivo (final)
  paper: boolean             // estilo papel real (true) o pantalla oscura (false)
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
    segLine: (a: boolean) => a ? 'rgba(37,99,235,0.7)' : 'rgba(37,99,235,0.3)',
    segTri:  (a: boolean) => a ? 'rgba(37,99,235,0.9)' : 'rgba(37,99,235,0.4)',
    segText: (a: boolean) => a ? '#2563eb' : 'rgba(37,99,235,0.55)',
    toco: 'rgba(40,40,52,0.9)', tocoFill: 'rgba(40,40,52,0.05)',
    fhr: '#151522', fhrGlow: 'rgba(0,0,0,0)', fhrGlowBlur: 0,
  } : {
    bg: '#050816',
    hMinor: 'rgba(71,85,105,0.20)',  hMajor: 'rgba(100,116,139,0.32)',
    vMinor: 'rgba(71,85,105,0.22)',  vMajor: 'rgba(100,116,139,0.42)',
    tocoSep: 'rgba(100,116,139,0.3)', tocoH:  'rgba(71,85,105,0.18)',
    timeLabel: 'rgba(100,116,139,0.65)',
    fhrLabelBox: 'rgba(30,41,59,0.85)', fhrLabelText: 'rgba(100,116,139,0.6)',
    segLine: (a: boolean) => a ? 'rgba(34,211,238,0.7)' : 'rgba(34,211,238,0.25)',
    segTri:  (a: boolean) => a ? 'rgba(34,211,238,0.9)' : 'rgba(34,211,238,0.35)',
    segText: (a: boolean) => a ? '#22d3ee' : 'rgba(34,211,238,0.5)',
    toco: 'rgba(251,191,36,0.9)', tocoFill: 'rgba(251,191,36,0.06)',
    fhr: '#6EE7FF', fhrGlow: 'rgba(110,231,255,0.35)', fhrGlowBlur: 3,
  }
}

const varLabel = (amp: number) => {
  if (amp < 2)   return 'Ausente'
  if (amp < 6)   return 'Mínima'
  if (amp <= 25) return 'Normal'
  return 'Marcada'
}
const varColor = (amp: number) => {
  if (amp < 2)   return '#ef4444'
  if (amp < 6)   return '#f59e0b'
  if (amp <= 25) return '#22d3ee'
  return '#a78bfa'
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
  if (!next) return { baseline: cur.baseline, varAmp: cur.varAmp }
  const transStart = next.time - TRANSITION_MIN
  if (t >= transStart) {
    const p = smoothstep(0, 1, (t - transStart) / TRANSITION_MIN)
    return { baseline: lerp(cur.baseline, next.baseline, p), varAmp: lerp(cur.varAmp, next.varAmp, p) }
  }
  return { baseline: cur.baseline, varAmp: cur.varAmp }
}

// ── Waveform utils ────────────────────────────────────────
const variabilityAt = (x: number, amp: number) => {
  const slow = Math.sin(x / 17) + 0.6 * Math.sin(x / 6.3) + 0.4 * Math.sin(x / 2.7)
  const beat = hash(x) * 1.2
  return ((slow / 2.0) + beat * 0.5) * (amp / 2)
}
const cyclingFactor = (min: number) => 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((min / 4) * Math.PI))

// ── Deceleration drop ─────────────────────────────────────
function decelDropAt(t: number, x: number, decels: Decel[]) {
  let drop = 0
  decels.forEach((d, i) => {
    const seed   = i * 47.3
    const depth  = d.depth
    const durMin = d.duration / 60
    const startT = d.time
    const endT   = startT + durMin

    if (d.type === 'variable') {
      const ramp = 5 / 60
      if (t >= startT && t < startT + ramp)
        drop = Math.max(drop, smoothstep(0, 1, (t - startT) / ramp) * depth)
      else if (t >= startT + ramp && t < endT - ramp)
        drop = Math.max(drop, depth + hash(x * 0.4 + seed) * depth * 0.07)
      else if (t >= endT - ramp && t < endT)
        drop = Math.max(drop, smoothstep(0, 1, (endT - t) / ramp) * depth)

    } else if (d.type === 'late') {
      const lag = 30 / 60
      const s = startT + lag, e = endT + lag, mid = s + (e - s) / 2
      if (t >= s && t < mid)  drop = Math.max(drop, smoothstep(0, 1, (t - s) / (mid - s)) * depth)
      else if (t >= mid && t <= e) drop = Math.max(drop, smoothstep(0, 1, (e - t) / (e - mid)) * depth)

    } else if (d.type === 'early') {
      if (t >= startT && t <= endT)
        drop = Math.max(drop, Math.sin(((t - startT) / durMin) * Math.PI) * depth)

    } else if (d.type === 'prolonged') {
      const ramp = 0.25
      if (t >= startT && t < startT + ramp)
        drop = Math.max(drop, smoothstep(0, 1, (t - startT) / ramp) * depth)
      else if (t >= startT + ramp && t < endT - ramp)
        drop = Math.max(drop, depth + hash(x * 0.2 + seed) * depth * 0.05)
      else if (t >= endT - ramp && t <= endT)
        drop = Math.max(drop, smoothstep(0, 1, (endT - t) / ramp) * depth)
    }
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

// ── Draw CTG ──────────────────────────────────────────────
function drawCTG(canvas: HTMLCanvasElement, config: CTGConfig) {
  const { segments, cycling, autoAccels, accels, duration, decels, contractions, activeSegTime, artifactLevel, artifactExpulsive, paper } = config
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
  // Horizontal TOCO cada 25 UA
  ;[25, 50, 75].forEach(p => {
    ctx.strokeStyle = th.tocoH; ctx.lineWidth = 0.5
    const y = tocoToPx(p)
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
  })
  // Etiquetas de tiempo cada 3 min (sobre las líneas oscuras)
  ctx.fillStyle = th.timeLabel; ctx.font = '9px system-ui'; ctx.textAlign = 'center'
  for (let m = 3; m <= duration; m += 3) ctx.fillText(m + "'", m * PX_PER_MIN, CANVAS_H - 3)
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

  // TOCO
  const tocoPath: number[] = []
  for (let x = 0; x < W; x++) {
    const t = x / PX_PER_MIN
    let toco = 2 + hash(x * 0.05) * 1.5
    contractions.forEach(c => { toco += gaussian(t, c.time, c.duration * 0.48, c.amplitude) })
    tocoPath.push(clamp(toco, 0, 100))
  }
  ctx.strokeStyle = th.toco; ctx.lineWidth = 1.5
  ctx.beginPath()
  tocoPath.forEach((v, x) => { const y = tocoToPx(v); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
  ctx.stroke()
  ctx.fillStyle = th.tocoFill
  ctx.beginPath()
  tocoPath.forEach((v, x) => { const y = tocoToPx(v); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
  ctx.lineTo(W, TOCO_BOTTOM); ctx.lineTo(0, TOCO_BOTTOM); ctx.closePath(); ctx.fill()

  // FHR
  ctx.strokeStyle = th.fhr; ctx.lineWidth = 1.8
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
    const cf   = cycling ? cyclingFactor(t) : 1
    const v    = variabilityAt(x * 0.5, sv.varAmp * cf)
    const drop = decelDropAt(t, x, decels)
    const rise = accelRiseAt(t, x, accels)
    let fhr = drop > 15
      ? sv.baseline - drop + hash(x * 0.9) * (sv.varAmp * 0.15)
      : sv.baseline + v - drop + rise
    if (autoAccels && drop < 5 && rise < 5) {
      const trig = Math.sin(x / 23) + 0.7 * Math.sin(x / 11.3)
      if (trig > 1.4) fhr += (10 + hash(x * 0.07) * 5) * Math.max(0, Math.sin(Math.PI * ((trig - 1.4) / 0.6)))
    }
    if (artifactLevel > 0) fhr += artifactNoise(t, x, duration, artifactLevel, artifactExpulsive)
    const y = fhrToPx(clamp(fhr, FHR_MIN, FHR_MAX))
    if (!penDown) { ctx.moveTo(x, y); penDown = true }
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.shadowBlur = 0
}

// ── Slider ────────────────────────────────────────────────
function Slider({ label, value, min, max, step = 1, unit = '', onChange, color = '#22d3ee', note }: {
  label: string; value: number; min: number; max: number; step?: number
  unit?: string; onChange: (v: number) => void; color?: string; note?: string
}) {
  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs text-slate-400">{label}</label>
        <div className="text-right">
          <span className="text-xs font-bold" style={{ color }}>{value}{unit ? ' ' + unit : ''}</span>
          {note && <span className="text-xs ml-1.5 opacity-70" style={{ color }}>· {note}</span>}
        </div>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={ev => onChange(Number(ev.target.value))}
        className="w-full h-1.5 cursor-pointer rounded-full"
        style={{ accentColor: color }}
      />
    </div>
  )
}

// ── Toggle ────────────────────────────────────────────────
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs text-slate-400">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: value ? '#0891b2' : '#334155' }}
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
  return (
    <div>
      <label className="text-[10px] text-slate-500 block mb-1">{label}</label>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={ev => onChange(Number(ev.target.value))}
        className="w-full bg-slate-950 border border-slate-800 text-white text-xs rounded-md px-2 py-1.5 outline-none focus:border-cyan-600"
      />
    </div>
  )
}

// ── SectionTitle ──────────────────────────────────────────
function SectionTitle({ children, color = '#475569' }: { children: React.ReactNode; color?: string }) {
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest mb-2.5 mt-4 pb-1.5 border-b border-slate-900"
      style={{ color, letterSpacing: 2 }}>
      {children}
    </p>
  )
}

// ── DecelCard ─────────────────────────────────────────────
function DecelCard({ decel, index, onChange, onRemove }: {
  decel: Decel; index: number; onChange: (d: Decel) => void; onRemove: () => void
}) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 mb-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-cyan-400">Desacel. #{index + 1}</span>
        <button onClick={onRemove} className="text-slate-600 hover:text-red-400 text-base leading-none transition-colors">×</button>
      </div>
      <div className="mb-2">
        <label className="text-[10px] text-slate-500 block mb-1">Tipo</label>
        <select
          value={decel.type}
          onChange={ev => onChange({ ...decel, type: ev.target.value as Decel['type'] })}
          className="w-full bg-slate-900 border border-slate-800 text-white text-xs rounded-md px-2 py-1.5 outline-none focus:border-cyan-600"
        >
          <option value="variable">Variable (barorreceptora)</option>
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
    </div>
  )
}

// ── AccelCard ─────────────────────────────────────────────
function AccelCard({ accel, index, onChange, onRemove }: {
  accel: Accel; index: number; onChange: (a: Accel) => void; onRemove: () => void
}) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 mb-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-emerald-400">Acel. #{index + 1}</span>
        <button onClick={onRemove} className="text-slate-600 hover:text-red-400 text-base leading-none transition-colors">×</button>
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
function ContractionCard({ c, index, onChange, onRemove }: {
  c: Contraction; index: number; onChange: (c: Contraction) => void; onRemove: () => void
}) {
  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 mb-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-amber-400">Contracción #{index + 1}</span>
        <button onClick={onRemove} className="text-slate-600 hover:text-red-400 text-base leading-none transition-colors">×</button>
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
  const uaC  = paper ? 'rgba(40,40,52,0.6)'   : 'rgba(251,191,36,0.5)'
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
      <div style={{
        position: 'absolute', top: TOCO_TOP + 4, left: 0, width: AXIS_W - 4,
        textAlign: 'right', fontSize: 8, color: uaC, fontWeight: 'bold'
      }}>UA</div>
    </div>
  )
}

// ── App ───────────────────────────────────────────────────
let nextId = 1

export default function App() {
  const [segments,      setSegments]      = useState<Segment[]>([{ id: 0, time: 0, baseline: 140, varAmp: 8 }])
  const [activeSegId,   setActiveSegId]   = useState(0)
  const [cycling,       setCycling]       = useState(true)
  const [autoAccels,    setAutoAccels]    = useState(false)
  const [accels,        setAccels]        = useState<Accel[]>([])
  const [duration,      setDuration]      = useState(20)
  const [decels,        setDecels]        = useState<Decel[]>([])
  const [contractions,  setContractions]  = useState<Contraction[]>([])
  const [artifactLevel,     setArtifactLevel]     = useState(0)
  const [artifactExpulsive, setArtifactExpulsive] = useState(true)
  const [paper,         setPaper]         = useState(true)
  const [sidebarTab,    setSidebarTab]    = useState<'trazado' | 'accels' | 'decels' | 'contracciones'>('trazado')

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeSeg = segments.find(s => s.id === activeSegId) ?? segments[0]

  useEffect(() => {
    if (!canvasRef.current) return
    drawCTG(canvasRef.current, {
      segments, cycling, autoAccels, accels, duration, decels, contractions,
      activeSegTime: activeSeg?.time ?? 0,
      artifactLevel, artifactExpulsive, paper
    })
  }, [segments, cycling, autoAccels, accels, duration, decels, contractions, activeSegId, artifactLevel, artifactExpulsive, paper])

  const updateSeg = (field: keyof Segment, value: number) => {
    setSegments(prev => prev.map(s => s.id === activeSegId ? { ...s, [field]: value } : s))
  }

  const handleCanvasClick = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const px   = ev.clientX - rect.left
    const t    = parseFloat((px / PX_PER_MIN).toFixed(1))
    if (t < 0.1 || t > duration - 0.1) return

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
      varAmp:   Math.round(inherited.varAmp * 10) / 10
    }
    setSegments(prev => [...prev, newSeg].sort((a, b) => a.time - b.time))
    setActiveSegId(newSeg.id)
    setSidebarTab('trazado')
  }, [segments, duration])

  const removeSeg = (id: number) => {
    if (id === 0) return
    setSegments(prev => prev.filter(s => s.id !== id))
    setActiveSegId(0)
  }

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ segments, cycling, autoAccels, accels, duration, decels, contractions, artifact: { level: artifactLevel, expulsive: artifactExpulsive } }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = 'trazado-ctg.json'; a.click()
  }
  const exportPNG = () => {
    if (!canvasRef.current) return
    const a = document.createElement('a')
    a.href = canvasRef.current.toDataURL('image/png'); a.download = 'trazado-ctg.png'; a.click()
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#0B1120' }}>

      {/* ── SIDEBAR ── */}
      <div className="w-68 shrink-0 flex flex-col border-r border-slate-900 overflow-y-auto" style={{ width: 272, background: '#0D1321' }}>

        {/* Header */}
        <div className="px-4 py-3.5 border-b border-slate-900">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-cyan-400" style={{ boxShadow: '0 0 8px rgba(34,211,238,0.7)' }} />
            <span className="text-sm font-bold text-white">CTG <span className="text-cyan-400">Creator</span></span>
          </div>
          <p className="text-[10px] text-slate-600">Haz clic en el trazado para agregar un punto de quiebre</p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-900">
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
                borderBottomColor: sidebarTab === tab.key ? '#22d3ee' : 'transparent',
                color: sidebarTab === tab.key ? '#22d3ee' : '#475569',
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
            <Toggle label="Cycling fetal"  value={cycling} onChange={setCycling} />
            <Toggle label="Aceleraciones automáticas"  value={autoAccels}  onChange={setAutoAccels} />
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
            <p className="text-[10px] text-slate-700 -mt-1 mb-1">Simula la pérdida de contacto real (movimiento materno, pujo)</p>

            <SectionTitle color="#22d3ee">Puntos de quiebre ({segments.length})</SectionTitle>
            <p className="text-[10px] text-slate-700 -mt-2 mb-2">Haz clic en el trazado para agregar</p>

            {segments.map(seg => (
              <div
                key={seg.id}
                onClick={() => setActiveSegId(seg.id)}
                className="px-3 py-2 rounded-lg mb-1.5 cursor-pointer border transition-all"
                style={{
                  borderColor: seg.id === activeSegId ? '#22d3ee' : '#1e293b',
                  background:  seg.id === activeSegId ? 'rgba(34,211,238,0.05)' : 'rgba(15,23,42,0.5)'
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold" style={{ color: seg.id === activeSegId ? '#22d3ee' : '#94a3b8' }}>
                    {seg.time === 0 ? 'Inicio (min 0)' : `Desde min ${seg.time.toFixed(1)}`}
                  </span>
                  {seg.id !== 0 && (
                    <button
                      onClick={ev => { ev.stopPropagation(); removeSeg(seg.id) }}
                      className="text-slate-600 hover:text-red-400 text-sm leading-none transition-colors"
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
                background: 'rgba(34,211,238,0.03)',
                borderColor: 'rgba(34,211,238,0.15)'
              }}>
                <p className="text-[10px] font-bold text-cyan-500 uppercase tracking-widest mb-3">
                  {activeSeg.time === 0 ? 'Editando: inicio' : `Editando: desde min ${activeSeg.time.toFixed(1)}`}
                </p>
                <Slider
                  label="FCF Basal" value={activeSeg.baseline}
                  min={60} max={210} step={1} unit="lpm" color="#6EE7FF"
                  onChange={v => updateSeg('baseline', v)}
                />
                <Slider
                  label="Variabilidad" value={activeSeg.varAmp}
                  min={0} max={30} step={0.5} unit="lpm"
                  color={varColor(activeSeg.varAmp)}
                  note={varLabel(activeSeg.varAmp)}
                  onChange={v => updateSeg('varAmp', v)}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Aceleraciones tab ── */}
        {sidebarTab === 'accels' && (
          <div className="flex-1 px-3.5 py-3">
            {accels.length === 0 && (
              <p className="text-[10px] text-slate-600 mb-2">Aceleración: subida ≥ 15 lpm sobre la basal durante ≥ 15 s (feto de término).</p>
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
              className="w-full py-2 rounded-lg border border-dashed border-slate-700 text-slate-500 text-xs hover:border-emerald-600 hover:text-emerald-500 transition-colors mt-1"
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
              />
            ))}
            <button
              onClick={() => setDecels(d => [...d, { type: 'variable', time: parseFloat((duration * 0.3).toFixed(1)), depth: 35, duration: 45 }])}
              className="w-full py-2 rounded-lg border border-dashed border-slate-700 text-slate-500 text-xs hover:border-cyan-600 hover:text-cyan-500 transition-colors mt-1"
            >+ Agregar desaceleración</button>
          </div>
        )}

        {/* ── Contracciones tab ── */}
        {sidebarTab === 'contracciones' && (
          <div className="flex-1 px-3.5 py-3">
            {contractions.map((c, i) => (
              <ContractionCard
                key={i} c={c} index={i}
                onChange={v => setContractions(prev => prev.map((x, j) => j === i ? v : x))}
                onRemove={() => setContractions(prev => prev.filter((_, j) => j !== i))}
              />
            ))}
            <button
              onClick={() => setContractions(c => [...c, { time: parseFloat((duration * 0.3).toFixed(1)), duration: 0.8, amplitude: 80 }])}
              className="w-full py-2 rounded-lg border border-dashed border-slate-700 text-slate-500 text-xs hover:border-amber-500 hover:text-amber-400 transition-colors mt-1"
            >+ Agregar contracción</button>
          </div>
        )}

        {/* Export */}
        <div className="px-3.5 py-3 border-t border-slate-900 space-y-2">
          <button onClick={exportJSON}
            className="w-full py-2.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold transition-colors">
            ↓  Exportar JSON
          </button>
          <button onClick={exportPNG}
            className="w-full py-2.5 rounded-lg border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white text-xs font-semibold transition-colors">
            ↓  Exportar PNG
          </button>
        </div>
      </div>

      {/* ── CANVAS AREA ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <div className="px-5 py-2.5 border-b border-slate-900 flex items-center gap-4 shrink-0" style={{ background: '#0D1321' }}>
          <span className="text-[10px] text-slate-700 font-bold uppercase tracking-widest">Vista previa</span>
          <span className="text-xs font-bold" style={{ color: '#6EE7FF' }}>FCF {activeSeg?.baseline ?? 140} lpm</span>
          <span className="text-xs font-semibold" style={{ color: varColor(activeSeg?.varAmp ?? 8) }}>
            Var. {varLabel(activeSeg?.varAmp ?? 8)}
          </span>
          {segments.length > 1 && <span className="text-xs text-cyan-600">{segments.length} segmentos</span>}
          {accels.length > 0 && <span className="text-xs text-emerald-400">{accels.length} acel.</span>}
          {decels.length > 0 && <span className="text-xs text-purple-400">{decels.length} desacel.</span>}
          {contractions.length > 0 && <span className="text-xs text-amber-500">{contractions.length} contrac.</span>}
          <span className="ml-auto text-[10px] px-2.5 py-1 rounded-full border border-slate-800 text-slate-600">
            clic en el trazado → punto de quiebre
          </span>
        </div>

        {/* Canvas */}
        <div className="flex-1 overflow-auto p-4">
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
        <div className="px-5 py-1.5 border-t border-slate-900 flex items-center">
          <span className="text-[9px] text-slate-800">■ FCF cian  ·  ■ TOCO ámbar  ·  Escala 1 cm/min  ·  ▲ = marcador de segmento</span>
          <span className="ml-auto text-[9px] text-slate-800">CTG Creator — FetalPhysio Tools</span>
        </div>
      </div>
    </div>
  )
}
