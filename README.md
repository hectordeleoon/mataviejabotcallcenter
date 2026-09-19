# MATAVIEJA Community Call Center Bot

Bot de Discord para las sesiones de juego de los viernes con la comunidad de Kick.

## Flujo

1. Una persona entra a `⏳・ESPERA-PARA-JUGAR`.
2. El bot entra al canal y pone la **música de espera en bucle**.
3. El bot publica una solicitud en `🎛️・SOLICITUDES`.
4. MATAVIEJA pulsa **ACEPTAR** o **DECLINAR**.
5. Al aceptar, el bot comprueba que la persona sigue en espera, le asigna `🎮 INVITADO` y la mueve a `🎮・JUEGO-CON-LA-COMUNIDAD`.
6. Cuando el jugador sale de la sala de juego, el bot le quita `🎮 INVITADO`.
7. Cuando la sala de espera queda vacía, el bot se desconecta y para la música.

## Requisitos

- Node.js 18.17 o superior.
- Un bot creado en Discord Developer Portal con scopes `bot` y `applications.commands`.
- Permisos del bot: View Channels, Send Messages, Embed Links, Read Message History, Move Members, **Connect**, **Speak**, Manage Roles.
- El rol del bot debe estar **por encima** del rol `🎮 INVITADO`.

## Instalación

```bash
npm install
cp .env.example .env
```

Rellena `.env` con los IDs reales y el token. Nunca publiques `.env` ni tu token.

```bash
npm start
```

## Música de espera

Coloca tu pista en `assets/espera.mp3` (mp3, ogg, wav o m4a) y ajusta en `.env`:

```env
WAITING_MUSIC_ENABLED=true
WAITING_MUSIC_PATH=./assets/espera.mp3
WAITING_MUSIC_VOLUME=0.25
WAITING_MUSIC_SELF_DEAF=true
```

- El bot **solo** entra al canal de espera cuando hay al menos una persona humana dentro.
- La pista se repite infinitamente hasta que la sala queda vacía.
- Usa música **libre de derechos** (Pixabay Music, Free Music Archive, YouTube Audio Library). Música comercial puede dar problemas si la sesión se graba o se emite en Kick.
- `assets/*.mp3` está en `.gitignore` para no subir audio pesado a GitHub. Si quieres desplegar con la pista incluida, quita esa línea del `.gitignore`.

### Dependencias de audio

`@discordjs/voice`, `@discordjs/opus`, `libsodium-wrappers` y `ffmpeg-static` se instalan con `npm install`. No necesitas instalar FFmpeg aparte.

## Cómo obtener IDs

`Ajustes de usuario → Avanzado → Modo desarrollador`, luego clic derecho sobre servidor, canal, rol o usuario → **Copiar ID**.

## Comportamiento de viernes

`FRIDAY_ONLY=true` limita la creación automática de solicitudes al día indicado en `EVENT_DAY` (0 = domingo, 5 = viernes) según `TIME_ZONE`. Para probar cualquier día:

```env
FRIDAY_ONLY=false
```

La música de espera funciona todos los días, independientemente de `FRIDAY_ONLY`.

## Comando manual

`/callcenter-panel` publica un panel informativo en el canal de solicitudes. Solo usuarios o roles autorizados pueden ejecutarlo.

## Notas

- Las solicitudes se guardan en memoria. Si el bot se reinicia, las pendientes se pierden.
- El bot no elimina ni expulsa usuarios.
- Si falla el movimiento al canal de juego, el bot revierte el rol asignado.
