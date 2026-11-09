<div align="center">

# ⭕ Ta-Te-Ti 3D

### Tres fichas, un tablero que se mueve. Pensá antes de mover.

<br>

<a href="https://villariasthiago.github.io/tateti-online/">
  <img src="https://img.shields.io/badge/%E2%96%B6%20%20JUGAR%20AHORA-Contra%20la%20compu%20%C2%B7%20Online-2f6bff?style=for-the-badge&labelColor=151925" alt="Jugar ahora" height="56">
</a>

<br><br>

🔗 **[villariasthiago.github.io/tateti-online](https://villariasthiago.github.io/tateti-online/)**

**👆 Hacé click y jugá, sin instalar nada 👆**

<br>

![modo](https://img.shields.io/badge/modo-contra%20la%20compu-3cdc78?style=flat-square)
![modo](https://img.shields.io/badge/modo-2%20jugadores-46d7ff?style=flat-square)
![modo](https://img.shields.io/badge/modo-online-f04848?style=flat-square)
![hecho con](https://img.shields.io/badge/hecho%20con-p5.js%20+%20PeerJS-ffca28?style=flat-square&labelColor=151925)

</div>

---

## ✨ ¿Qué es?

Una versión del Ta-Te-Ti con **tres fichas por jugador** y un tablero 3D que **gira 90° al azar después de cada jugada**. Hay que volver a ubicarse en cada turno, así que además de ser un juego sirve como entrenamiento de **rotación mental y planificación**.

## 🎮 Cómo se juega

1. **Colocar:** cada jugador tiene 3 fichas y las pone de a una por turno en casillas vacías.
2. **Mover:** cuando ya están las 6 fichas, en cada turno hay que mover una propia a una casilla vacía de al lado (arriba, abajo, izquierda o derecha, no en diagonal).
3. **Ganar:** armá **3 en línea** (fila, columna o diagonal), incluso al colocar.
4. **Empate:** si pasan 40 movimientos sin ganador.

Arrastrá con el mouse o el dedo para girar la vista, y usá la rueda o el pellizco para acercar. Un toque corto es una jugada.

## 🕹️ Modos

| | Modo | Detalle |
|---|---|---|
| 🤖 | **Contra la compu** | Tres dificultades: 🙂 fácil, 🤔 medio (te bloquea y aprovecha errores) y 😈 difícil (piensa varias jugadas por delante). |
| 👥 | **Dos jugadores** | Los dos en el mismo dispositivo. |
| 🌐 | **Online** | Uno crea una sala y le pasa el código al rival, que lo escribe en **Unirme a una sala**. Cada uno juega desde su casa. |
| 🔄 | **Tablero giratorio** | Opcional: se puede desactivar el giro. |

> [!NOTE]
> El modo online conecta un navegador con otro (WebRTC, con [PeerJS](https://peerjs.com/)). En redes con firewall, como el wifi de escuelas o trabajos, la conexión puede fallar. Si pasa, probá con datos móviles.

## 🛠️ Cómo está hecho

Un sitio estático con [p5.js](https://p5js.org/) para el tablero 3D y PeerJS para el juego online. No hay servidor propio.

```
index.html          Página y menús
sketch.js           Menús y conexión entre las partes
tateti-logica.js    Reglas del juego (lógica pura)
tateti-3d.js        Dibujo 3D, cámara y toques
online.js           Conexión entre dos navegadores
style.css           Estilos
```

---

## 👋 Más proyectos

<div align="center">

<a href="https://villariasthiago.github.io/e-portfolio/#inicio">
  <img src="https://img.shields.io/badge/%F0%9F%8C%90%20%20Mi%20portafolio-ver%20otros%20proyectos-46e3c9?style=for-the-badge&labelColor=8f7bff" alt="Mi portafolio">
</a>

</div>
