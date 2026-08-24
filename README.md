---
title: E.V.A — Gemini 3D Avatar Assistant
emoji: 👩
colorFrom: orange
colorTo: white
sdk: docker
app_port: 7860
pinned: false
thumbnail: https://huggingface.co/spaces/victor/gemma-avatar/resolve/main/thumbnail.webp
short_description: Asistente 3D en español con voz local y Gemini API — lista para descargar y usar
---

# E.V.A — Entidad de Verificación Administrativa

Asistente 3D con **Gemini API**, voz propia (TTS local) y reconocimiento de voz
(STT local). Habla o escribe **en español**: E.V.A responde en voz alta con su
voz natural, los labios se mueven sincronizados con el audio y usa **gestos,
expresiones y cambios de ánimo durante toda la conversación**.

Especialización: asistente de redacción empresarial — verificación de la norma
**GTC 185**, gestión del desempeño de empresas estudiantiles, órdenes ejecutivas
y reglamento de escarapelas. Matriz de personalidad: **normativa · analítica ·
amable · enérgica**. Modelo de chat: `gemini-3.5-flash`, con **fallback
automático** (`gemini-3.6-flash` → `gemini-3-flash-preview` → `gemini-2.5-flash`)
si el modelo primario no está disponible.

---

## 📦 Uso sin instalar nada (paquete descargable)

Descarga el paquete (`make-package.sh` genera `dist/EVA-avatar-<fecha>.zip`),
descomprímelo donde quieras y haz **doble clic** según tu sistema:

| Sistema | Archivo |
| --- | --- |
| Windows | `Iniciar-EVA-WINDOWS.bat` |
| macOS | `Iniciar-EVA-MAC.command` *(clic derecho → Abrir la primera vez)* |
| Linux | `iniciar-eva-linux.sh` |

El lanzador:

1. Descarga solo, la primera vez (~300 MB en total): motor Bun, librerías web,
   paquetes Piper/Whisper en un entorno aislado (`.venv`). Nada se instala en tu
   sistema; todo queda dentro de la carpeta.
2. Arranca el servidor de voz y el servidor web.
3. Abre tu navegador en <http://localhost:3000>.
4. **Pega tu clave de Gemini API** en el panel inferior derecho y pulsa
   **Verify**. Consíguela gratis en <https://aistudio.google.com/apikey>.

Para detener E.V.A: `Cerrar-EVA-WINDOWS.bat` (Windows) o cierra la ventana del
lanzador (macOS/Linux). Las siguientes veces arranca en segundos.

> El micrófono funciona directo en `localhost`. Si abres la app desde otro
> equipo/celular por IP, los navegadores exigen HTTPS para el micrófono.

---

## Cómo funciona

```
hablas → micrófono (MediaRecorder) → /api/stt → faster-whisper (local)
                                                        ↓ texto
escuchas ← Piper TTS "Daniela" (local) ← /api/tts ← proxy Bun ← Gemini 3.5 Flash
   ↑
labios + gestos + expresiones sincronizados (TalkingHead, en el navegador)
```

- **Chat — Gemini REST** (`generateContent`): la clave vive en el servidor y no
  llega al navegador; también puede cargarse desde el panel de la interfaz
  (se verifica contra la API y se adopta en caliente, sin reiniciar). Thinking
  en nivel `minimal` y respuestas cortas para conversación hablada.
- **Fallback de modelos**: si el modelo activo falla (404, cuota, sobrecarga),
  se recorre la cadena hasta encontrar uno funcional y se recuerda.
- **Voz — Piper TTS** local (CPU, sin clave): voz **Daniela** es_AR 22 kHz
  (~108 MB ONNX incluido en el paquete).
- **Voz→texto — faster-whisper** local: modelo `base` configurable con la
  variable `WHISPER_MODEL`.
- **Avatar — TalkingHead + three.js**: lip-sync desde el audio real
  (`speakAudio`) más coreografía continua (gestos de mano, emojis faciales y
  ánimos cada pocos segundos mientras habla), además de las herramientas que el
  modelo invoca entre frases: `set_mood`, `make_hand_gesture`,
  `make_facial_expression`.

## Desarrollo manual (opcional)

Requisitos: [Bun](https://bun.sh), Python 3.8+ con `pip`.

```bash
bun install
pip install piper-tts faster-whisper     # o usar el venv del lanzador
bun run dev                              # TTS (:5000) + web (:3000), hot-reload
bun run start                            # sin hot-reload
bun run dev:stop                         # detener ambos puertos
bun test                                 # suite offline (mock de Gemini)
bun run typecheck                        # tsc --noEmit
bash make-package.sh                     # genera dist/EVA-avatar-<fecha>.zip
```

Variables de entorno opcionales:

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(vacía — se puede cargar desde la UI)* | Clave de Google AI Studio |
| `GEMINI_CHAT_MODEL` | `gemini-3.5-flash` | Modelo principal (luego aplican los fallbacks) |
| `PORT` | `3000` | Puerto del servidor web |
| `TTS_URL` | `http://127.0.0.1:5000` | Servicio Python de voz |
| `WHISPER_MODEL` | `base` | Modelo Whisper STT (`tiny`…`large-v3`) |
| `TTS_PORT` | `5000` | Puerto del servicio de voz |

## Producción / Docker

```bash
docker build -t gemma-avatar .
docker run --rm -p 7860:7860 -e GEMINI_API_KEY="TU_CLAVE" gemma-avatar
```

## Solución de problemas

| Síntoma | Solución |
| --- | --- |
| "Address already in use" al iniciar | Ejecuta `bun run dev:stop` (o `Cerrar-EVA-WINDOWS.bat`) y vuelve a iniciar. |
| Micrófono no graba | Usa `http://localhost:3000` (no IP); concede permiso al navegador; revisa que ningún otro programa use el micrófono. |
| Primera respuesta tarda mucho | La primera ejecución descarga el modelo Whisper (~145 MB); espera al mensaje `[server] Whisper model loaded.` |
| "Respuesta vacía" de Gemini | Ya mitigado automáticamente; si persiste, reinicia y verifica la clave en el panel. |
| Quiero otra voz | Descarga otro modelo de [Piper voices](https://github.com/rhasspy/piper/blob/master/VOICES.md) y ajusta las rutas en `tts_server.py`. |

## Estructura

```
index.ts                     Servidor Bun: frontend empaquetado + /api/config + /api/chat
                             (+ fallback de modelos) + /api/verify-key + /api/tts + /api/stt
index.html                   Shell de la app (escenario 3D, subtítulos, micrófono, panel de clave)
src/app.js                   Lógica UI: chat con bucle de herramientas, STT, TTS, coreografía
src/avatar.js                AvatarStage: TalkingHead, lip-sync por audio, gestos y expresiones
src/style.css                Estilos (paleta naranja, gradiente animado)
public/avatars/*.glb         Modelo 3D de E.V.A (se sirve en runtime)
voices/                      Voz Piper Daniela (~108 MB ONNX)
tts_server.py                Servicio Python: Piper TTS + faster-whisper STT (puerto 5000)
Iniciar-EVA-*.{bat,command}  Lanzadores de doble clic (Windows/macOS)
iniciar-eva-linux.sh         Lanzador de doble clic (Linux)
Cerrar-EVA-WINDOWS.bat       Detiene E.V.A en Windows
make-package.sh              Genera el ZIP distribuible en dist/
test/                        Pruebas offline del servidor (bun test)
```
