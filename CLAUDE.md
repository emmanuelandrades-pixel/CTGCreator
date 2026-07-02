# CTG Creator — Contexto para nueva sesión de Claude Code

**Versión del documento:** Julio 2026  
**Proyecto hermano:** FetalPhysio (emmanuelandrades-pixel/FetalPhysio)  
**Repositorio:** emmanuelandrades-pixel/CTGCreator  
**Autora:** Emma (Emmanuel Andrades Rodríguez) — Universidad de Talca

---

## 1. QUÉ ES ESTE PROYECTO

**CTG Creator** es una herramienta web interactiva para crear trazados CTG (cardiotocografía) de forma visual. Es independiente de FetalPhysio pero comparte su motor de trazado.

### Doble propósito
1. **Simulación clínica:** proyectar trazados personalizados en pantalla durante simulaciones con fantomas de alta fidelidad
2. **Generación de casos:** crear configs JSON para agregar nuevos casos clínicos a FetalPhysio

### Stack tecnológico
| Tecnología | Uso |
|---|---|
| React 18 + TypeScript | Framework UI |
| Vite | Build + dev server |
| Tailwind CSS | Estilos (CDN en index.html) |
| HTML5 Canvas | Motor de trazado CTG |
| Vercel | Hosting (conectado a GitHub main) |

---

## 2. ESTRUCTURA DE ARCHIVOS

```
CTGCreator/
├── src/
│   ├── App.tsx          ← toda la app (componentes + motor CTG)
│   └── main.tsx         ← entry point React
├── index.html           ← Tailwind CDN aquí
├── vite.config.ts
├── tsconfig.json        ← strict: false (importante)
├── package.json
└── CLAUDE.md            ← este archivo
```

### Comando de build
```bash
npm run build   # vite build
npm run dev     # desarrollo local
```

---

## 3. ARQUITECTURA DE LA APP

Un solo archivo `src/App.tsx`. No hay backend, no hay base de datos.

### Componentes principales
- **`App`** — componente raíz, maneja todo el estado
- **`drawCTG(canvas, config)`** — función pura que dibuja el trazado en Canvas
- **`Slider`**, **`Toggle`**, **`NumberInput`** — controles UI reutilizables
- **`DecelCard`** — tarjeta de configuración de una desaceleración
- **`ContractionCard`** — tarjeta de configuración de una contracción
- **`YAxis`** — overlay de eje Y fijo con etiquetas FCF
- **`SectionTitle`** — título de sección en el sidebar

### Estado global (en `App`)
```typescript
segments: Segment[]        // puntos de quiebre del trazado
activeSegId: number        // segmento seleccionado actualmente
cycling: boolean           // cycling fetal on/off
accels: boolean            // aceleraciones on/off
duration: number           // duración en minutos (5–40)
decels: Decel[]            // lista de desaceleraciones
contractions: Contraction[] // lista de contracciones
sidebarTab: string         // pestaña activa del sidebar
```

---

## 4. SISTEMA DE SEGMENTOS (FUNCIONALIDAD CENTRAL)

La característica principal: el usuario hace clic en cualquier punto del trazado y crea un "punto de quiebre" desde el cual la FCF basal y la variabilidad pueden ser diferentes.

### Tipo Segment
```typescript
interface Segment {
  id: number
  time: number    // minuto donde inicia este segmento
  baseline: number // FCF basal en lpm (60–210)
  varAmp: number  // amplitud de variabilidad en lpm (0–30)
}
```

### Interpolación entre segmentos
`getSegmentValues(segments, t)` — para cada tiempo t, busca el segmento activo y aplica una transición suave de 24 segundos (`TRANSITION_MIN = 0.4`) usando `smoothstep` hacia el siguiente segmento.

### Click handler
`handleCanvasClick` — calcula el minuto a partir de la posición X del clic, crea un nuevo segmento heredando los valores del segmento anterior, lo inserta ordenado por tiempo.

---

## 5. MOTOR CTG (drawCTG)

Idéntico en filosofía al de FetalPhysio. Función pura que dibuja en Canvas.

### Constantes de escala
```typescript
const FHR_TOP    = 22      // px superior FCF
const FHR_BOTTOM = 262     // px inferior FCF
const TOCO_TOP   = 280     // px superior TOCO
const TOCO_BOTTOM= 370     // px inferior TOCO
const CANVAS_H   = 388     // altura total canvas
const PX_PER_MIN = 60      // píxeles por minuto (escala real CTG)
const AXIS_W     = 44      // ancho del eje Y overlay
```

### Mapeos
```typescript
fhrToPx(fhr)  = FHR_TOP  + (210 - fhr)  / 160 * (FHR_BOTTOM - FHR_TOP)
tocoToPx(p)   = TOCO_BOTTOM - (p / 100) * (TOCO_BOTTOM - TOCO_TOP)
```

### Hash determinista (sin Math.random)
```typescript
const hash = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return (s - Math.floor(s)) - 0.5 }
```

### Variabilidad
```typescript
const variabilityAt = (x, amp) => {
  const slow = Math.sin(x/17) + 0.6*Math.sin(x/6.3) + 0.4*Math.sin(x/2.7)
  const beat = hash(x) * 1.2
  return ((slow/2.0) + beat*0.5) * (amp/2)
}
```
- `amp` viene de `Segment.varAmp` (0–30 lpm)
- Etiquetas clínicas: Ausente < 2, Mínima < 6, Normal ≤ 25, Marcada > 25

### Cycling fetal
```typescript
const cyclingFactor = (min) => 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((min/4) * Math.PI))
```
Modula la amplitud de variabilidad. Toggle on/off en sidebar.

### Marcadores de segmento en canvas
Línea vertical cian punteada + triángulo ▲ en la parte superior + etiqueta con el minuto. El segmento activo se dibuja más brillante.

---

## 6. TIPOS DE DESACELERACIÓN

```typescript
interface Decel {
  type: 'variable' | 'late' | 'early' | 'prolonged'
  time: number      // minuto de inicio
  depth: number     // profundidad en lpm
  duration: number  // duración en segundos
}
```

### Morfologías implementadas en `decelDropAt(t, x, decels)`

**`variable`** (barorreceptora):
- Caída abrupta 5 seg (smoothstep)
- Nadir plano con jitter `hash * depth * 0.07`
- Recuperación abrupta 5 seg

**`late`** (quimiorreceptora):
- Lag de 30 seg desde inicio
- Forma V suave con smoothstep
- Suprime variabilidad si drop > 15 lpm

**`early`** (espejo contracción):
- Forma senoidal `Math.sin(p * π)`
- Sincronizada con el inicio/fin de contracción

**`prolonged`** (> 2 min):
- Rampa de entrada/salida 15 seg
- Nadir mantenido con micro-jitter

---

## 7. CONTRACCIONES (TOCO)

```typescript
interface Contraction {
  time: number       // minuto de inicio del pico
  duration: number   // duración en minutos
  amplitude: number  // amplitud en UA (20–100)
}
```

Dibujadas como gaussianas: `gaussian(t, c.time, c.duration * 0.48, c.amplitude)`  
Con relleno semitransparente ámbar bajo la curva.

---

## 8. INTERFAZ DE USUARIO

### Layout
```
┌─────────────────┬─────────────────────────────────┐
│  SIDEBAR (272px)│  CANVAS AREA (flex-1)            │
│                 │  [top bar con stats]             │
│  Header         │                                  │
│  Tabs           │  [canvas scrollable horizontal]  │
│  ─────────────  │                                  │
│  Tab: Trazado   │  [bottom bar]                    │
│  Tab: Desacel.  │                                  │
│  Tab: Contrac.  │                                  │
│  ─────────────  │                                  │
│  Exportar JSON  │                                  │
│  Exportar PNG   │                                  │
└─────────────────┴─────────────────────────────────┘
```

### Sidebar — Tab "Trazado"
- Slider duración (5–40 min)
- Toggle cycling fetal
- Toggle aceleraciones
- Lista de segmentos (clickeables para seleccionar)
- Panel de edición del segmento activo:
  - Slider FCF Basal (60–210 lpm) — color `#6EE7FF`
  - Slider Variabilidad (0–30 lpm) — color dinámico según nivel

### Paleta de colores
| Elemento | Color |
|---|---|
| Fondo principal | `#0B1120` |
| Fondo sidebar/topbar | `#0D1321` |
| Fondo canvas | `#050816` |
| FCF | `#6EE7FF` |
| TOCO | `rgba(251,191,36,0.9)` |
| Acento cian | `#22d3ee` |
| Segmento activo | `rgba(34,211,238,0.05)` border `#22d3ee` |
| Variabilidad ausente | `#ef4444` |
| Variabilidad mínima | `#f59e0b` |
| Variabilidad normal | `#22d3ee` |
| Variabilidad marcada | `#a78bfa` |

### Canvas
- Scroll horizontal para trazados largos
- Cursor `crosshair` sobre el canvas
- Overlay `YAxis` con eje Y sticky (fhrToPx para posicionamiento absoluto)
- Click en canvas → `handleCanvasClick` → nuevo segmento

---

## 9. EXPORTACIÓN

### JSON
```json
{
  "segments": [...],
  "cycling": true,
  "accels": false,
  "duration": 20,
  "decels": [...],
  "contractions": [...]
}
```
Compatible con el formato de config de FetalPhysio (con adaptación mínima).

### PNG
`canvas.toDataURL('image/png')` — captura el trazado completo en su resolución nativa.

---

## 10. RESTRICCIONES TÉCNICAS

- **Tailwind dinámico NO funciona** — no usar `bg-${color}-500`. Usar estilos inline para colores dinámicos.
- **`strict: false`** en tsconfig — el archivo original tiene tipos relajados, no activar strict.
- **Sin Math.random()** — usar siempre la función `hash(n)` para reproducibilidad.
- **Canvas scroll horizontal** — el canvas se mide por `duration * PX_PER_MIN` px de ancho. El wrapper debe tener `overflow: auto`.

---

## 11. PENDIENTES Y PRÓXIMOS PASOS

### Funcionalidad pendiente
- [ ] **Modo simulación a pantalla completa** — proyectar el trazado en fullscreen para usar en sala de simulación con fantomas
- [ ] **Trazado animado en tiempo real** — el trazado corre de izquierda a derecha como un monitor real
- [ ] **Generación desde archivos .dat/.hea** — analizar trazados reales de PhysioNet para extraer parámetros morfológicos y mejorar el motor
- [ ] **Biblioteca de trazados** — guardar configs JSON en localStorage y recuperarlos
- [ ] **Importar JSON** — cargar un config guardado previamente
- [ ] **Modo comparación** — ver dos trazados lado a lado
- [ ] **Aceleraciones manuales** — agregar aceleraciones en minutos específicos (hoy son automáticas)

### Mejoras de morfología pendientes
- [ ] **Hombros en desaceleraciones variables** — shoulder previo y posterior (implementados en FetalPhysio v12 pero no portados aquí aún)
- [ ] **Variabilidad suprimida durante tardías** — ya parcialmente implementado (drop > 15 lpm suprime var), perfeccionar
- [ ] **Desaceleraciones variables complicadas** — nadir bifásico, prolongación del nadir

### Análisis de trazados reales (.dat/.hea)
Emma tiene 29 trazados reales categorizados por tipo de desaceleración (formato PhysioNet WFDB). El plan es:
1. Script Python para leer `.dat` + `.hea` y extraer parámetros morfológicos
2. Estadísticas por categoría (timing, profundidad, duración, pendientes)
3. Actualizar las constantes del motor con valores reales

---

## 12. RELACIÓN CON FETALPHYSIO

| Aspecto | FetalPhysio | CTG Creator |
|---|---|---|
| Propósito | Educación CTG para estudiantes | Crear y simular trazados |
| Repo | emmanuelandrades-pixel/FetalPhysio | emmanuelandrades-pixel/CTGCreator |
| Motor CTG | CTGCanvas (mismo algoritmo) | drawCTG (mismo algoritmo) |
| Config format | `{ baseline, variability, cycling, decelType, contractions[] }` | `{ segments[], cycling, accels, decels[], contractions[] }` |
| Exportación | No exporta | JSON + PNG |
| Estado | Producción en Vercel | En desarrollo |

El JSON exportado por CTG Creator puede adaptarse al formato de casos de FetalPhysio con ajuste mínimo.
