/* =====================================================================
   tateti-3d.js  —  DIBUJO 3D, CÁMARA, PICKING y PUNTERO
   ---------------------------------------------------------------------
   Todo lo que tiene que ver con VER el juego y TOCARLO:
     * Escena3D       dibuja el tablero y las fichas con p5 (WEBGL), anima
                      caídas, deslizamientos y giros, y maneja la cámara.
     * Picking        saber qué casilla tocó la persona, dibujando la escena
                      en un buffer oculto donde cada casilla tiene un color
                      único (y después leyendo el color del pixel tocado).
     * ControlPuntero arrastrar = girar la cámara; toque corto = clic de juego
                      (mouse y dedo con el mismo código: Pointer Events).
   No sabe nada de las reglas: la lógica está en tateti-logica.js.
   Sus funciones de dibujo reciben `g` (el lienzo donde dibujar): puede ser
   la ventana (p5 en modo global) o el buffer oculto del picking.
   ===================================================================== */

/* ===================== CONSTANTES DE CONFIGURACIÓN ===================== */

const CONFIG_3D = {
  // --- Tablero (medidas en unidades 3D, más o menos "píxeles") ---
  TAM_CASILLA: 100,        // lado de cada baldosa
  SEPARACION: 6,           // hueco entre baldosas
  ALTO_BALDOSA: 12,        // grosor de cada baldosa
  MARGEN_BASE: 24,         // cuánto sobresale la base oscura alrededor
  ALTO_BASE: 26,           // grosor de la base oscura

  // --- Fichas (el círculo y la cruz tienen EXACTAMENTE el mismo alto) ---
  ALTO_FICHA: 18,
  RADIO_ANILLO: 29,        // radio del anillo (del centro al centro del tubo)
  LARGO_BARRA: 82,         // largo de cada barra de la cruz
  GROSOR_BARRA: 15,        // ancho de cada barra de la cruz

  // --- Colores [R, G, B] ---
  COLOR_J1: [60, 220, 120],      // círculo verde
  COLOR_J2: [240, 72, 72],       // cruz roja
  COLOR_CELESTE: [70, 215, 255], // casillas a las que se puede mover
  COLOR_DORADO: [255, 202, 40],  // línea ganadora
  COLOR_BALDOSA_A: [62, 70, 94],
  COLOR_BALDOSA_B: [50, 57, 79],
  COLOR_BASE: [26, 29, 41],
  COLOR_BASE_INFERIOR: [15, 17, 25],

  // --- Animaciones ---
  ALTURA_CAIDA: 320,       // desde qué altura caen las fichas al colocarse
  CAIDA_DURACION_MS: 430,  // más o menos cuánto tarda la caída
  REBOTE: 0.28,            // cuánto rebota al tocar el tablero (0 = nada)
  SUAVIZADO_DESLIZAR: 15,  // más alto = se desliza más rápido (por segundo)
  SUAVIZADO_ELEVAR: 18,    // lo mismo para subir/bajar la ficha elegida
  ELEVACION_SELECCION: 26, // cuánto se levanta la ficha elegida
  SALTO_MAXIMO: 22,        // cuánto "salta" una ficha mientras se desliza
  VELOCIDAD_PULSO: 0.0052, // velocidad del pulso celeste y dorado
  GIRO_RETRASO_MS: 650,    // espera antes de girar el tablero tras una jugada
  GIRO_DURACION_MS: 800,   // duración del giro de 90°
  DELAY_LINEA_MS: 480,     // espera para pintar la línea ganadora de dorado

  // --- Puntero (mouse / dedo) ---
  UMBRAL_ARRASTRE_PX: 9,   // si se mueve más que esto, es arrastre y no toque
  MAX_TOQUE_MS: 1500,      // un toque más largo que esto no cuenta como clic (tolera celulares lentos)

  // --- Cámara ---
  CAMARA: {
    FOV: Math.PI / 4,      // campo de visión vertical
    YAW_INICIAL: 0,
    PITCH_INICIAL: 0.95,   // inclinación inicial (radianes; 0 = al ras, 1.57 = desde arriba)
    PITCH_MIN: 0.2,
    PITCH_MAX: 1.5,
    ZOOM_MIN: 0.6,
    ZOOM_MAX: 1.9,
    SENSIBILIDAD_X: 0.0085,
    SENSIBILIDAD_Y: 0.0065,
    MARGEN: 1.12,          // 1 = ajusta justito el tablero; más = más lejos (deja lugar al HUD)
  },

  // --- Picking (selección por color) ---
  PICKING_PASO: 25,        // diferencia de rojo entre una casilla y la siguiente
  PICKING_TOLERANCIA: 7,
};

/* ============================== UTILIDADES ============================== */

function mezclarColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Posición (x, z) del centro de una casilla 0..8 en el plano del tablero.
function posicionCasilla(i) {
  const paso = CONFIG_3D.TAM_CASILLA + CONFIG_3D.SEPARACION;
  const fila = Math.floor(i / 3), col = i % 3;
  return { x: (col - 1) * paso, z: (fila - 1) * paso };
}

// Color único para el picking: cada casilla tiene un rojo distinto, verde y azul en 0.
function colorPicking(celda) { return [(celda + 1) * CONFIG_3D.PICKING_PASO, 0, 0]; }

// Al revés: de un pixel [r,g,b,a] saca la casilla, o -1 si no es ninguna.
function casillaDesdePixel(px) {
  if (!px || px[3] === 0) return -1;
  if (px[1] > 6 || px[2] > 6) return -1;
  const idx = Math.round(px[0] / CONFIG_3D.PICKING_PASO) - 1;
  if (idx < 0 || idx > 8) return -1;
  return Math.abs(px[0] - (idx + 1) * CONFIG_3D.PICKING_PASO) <= CONFIG_3D.PICKING_TOLERANCIA ? idx : -1;
}

function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

/* ============================== ESCENA 3D ============================== */

class Escena3D {
  constructor() {
    const C = CONFIG_3D.CAMARA;
    this.yaw = C.YAW_INICIAL;
    this.pitch = C.PITCH_INICIAL;
    this.zoom = 1;

    this.fichas = [];          // fichas visuales: {jugador, celda, x, z, caida, vy, elev}
    this.seleccion = -1;       // casilla de la ficha elegida (o -1)
    this.destinos = [];        // casillas celestes
    this.linea = null;         // casillas de la línea ganadora
    this.lineaDesde = 0;       // desde qué momento (reloj) se pinta de dorado
    this.reloj = 0;            // milisegundos acumulados (para los pulsos y retrasos)

    this.giroActual = 0;       // ángulo actual del tablero (radianes)
    this.giroTween = null;     // {desde, hasta, t0, dur} mientras gira
    this.giroPendiente = null; // {hasta, cuando} giro programado
  }

  /* ---------------------------- Estado visual ---------------------------- */

  // Coloca las fichas según un estado lógico, sin animar las fichas (inicio / revancha).
  // `animarGiro`: true en una revancha (el tablero vuelve girando suavemente a su posición
  // original); false en una partida nueva (se acomoda al instante y se puede jugar enseguida).
  reiniciar(estado, animarGiro) {
    this.fichas = [];
    for (let i = 0; i < 9; i++) {
      const v = estado.tablero[i];
      if (v) this.fichas.push(this._nuevaFicha(v, i, false));
    }
    this.seleccion = -1; this.destinos = []; this.linea = null;
    this.giroPendiente = null;
    if (animarGiro) {
      this.irAGiro(0, 0);
    } else {
      this.giroTween = null;
      this.giroActual = 0;
    }
  }

  _nuevaFicha(jugador, celda, cayendo) {
    const p = posicionCasilla(celda);
    return {
      jugador, celda, x: p.x, z: p.z,
      caida: cayendo ? CONFIG_3D.ALTURA_CAIDA : 0, // altura sobre el tablero (0 = apoyada)
      vy: 0, elev: 0, salto: 0,
    };
  }

  // Anima una jugada: la ficha nueva cae, o la ficha elegida se desliza.
  jugada(jugada, jugador) {
    if (jugada.tipo === 'poner') {
      this.fichas.push(this._nuevaFicha(jugador, jugada.a, true));
    } else {
      const f = this.fichas.find((x) => x.celda === jugada.de && x.jugador === jugador);
      if (f) f.celda = jugada.a; // el resto lo hace actualizar() deslizándola
    }
    this.seleccion = -1; this.destinos = [];
  }

  setSeleccion(celda, destinos) { this.seleccion = celda; this.destinos = destinos || []; }

  setLinea(linea, retrasoMs) {
    this.linea = linea;
    this.lineaDesde = this.reloj + (retrasoMs === undefined ? CONFIG_3D.DELAY_LINEA_MS : retrasoMs);
  }

  // Programa un giro del tablero hasta `rotacion` cuartos de vuelta (con una pausa antes).
  irAGiro(rotacion, retrasoMs) {
    const hasta = rotacion * Math.PI / 2;
    if (!retrasoMs) { this._empezarGiro(hasta); this.giroPendiente = null; }
    else this.giroPendiente = { hasta, cuando: this.reloj + retrasoMs };
  }

  _empezarGiro(hasta) {
    if (Math.abs(hasta - this.giroActual) < 1e-4) { this.giroTween = null; return; }
    this.giroTween = { desde: this.giroActual, hasta, t0: this.reloj, dur: CONFIG_3D.GIRO_DURACION_MS };
  }

  // ¿Hay un giro en marcha o programado? (mientras tanto no se acepta ningún toque)
  girando() { return !!this.giroTween || !!this.giroPendiente; }

  /* ------------------------------ Animación ------------------------------ */

  // `dt` = milisegundos desde el cuadro anterior (deltaTime de p5). Todo se interpola con dt,
  // así la animación dura lo mismo en un celular lento que en una compu rápida.
  actualizar(dt) {
    const C = CONFIG_3D;
    this.reloj += dt;
    const s = dt / 1000;

    // Giro del tablero
    if (this.giroPendiente && this.reloj >= this.giroPendiente.cuando) {
      this._empezarGiro(this.giroPendiente.hasta);
      this.giroPendiente = null;
    }
    if (this.giroTween) {
      const g = this.giroTween;
      const t = Math.min(1, (this.reloj - g.t0) / g.dur);
      this.giroActual = g.desde + (g.hasta - g.desde) * easeInOutCubic(t);
      if (t >= 1) { this.giroActual = g.hasta; this.giroTween = null; }
    }

    // Fichas
    const kDesliz = 1 - Math.exp(-C.SUAVIZADO_DESLIZAR * s);
    const kElev = 1 - Math.exp(-C.SUAVIZADO_ELEVAR * s);
    const G = (2 * C.ALTURA_CAIDA) / (C.CAIDA_DURACION_MS * C.CAIDA_DURACION_MS); // gravedad
    for (const f of this.fichas) {
      // Deslizamiento hacia la casilla destino
      const p = posicionCasilla(f.celda);
      const dx = p.x - f.x, dz = p.z - f.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.15) { f.x = p.x; f.z = p.z; } else { f.x += dx * kDesliz; f.z += dz * kDesliz; }
      const saltoObjetivo = Math.min(C.SALTO_MAXIMO, dist * 0.32); // se levanta mientras viaja
      f.salto += (saltoObjetivo - f.salto) * kElev;

      // Caída con gravedad y un rebotecito
      if (f.caida > 0 || f.vy !== 0) {
        f.vy += G * dt;
        f.caida -= f.vy * dt;
        if (f.caida <= 0) {
          f.caida = 0;
          if (f.vy > 0.25) f.vy = -f.vy * C.REBOTE; else f.vy = 0;
        }
      }

      // Elevación de la ficha elegida
      const objetivo = (f.celda === this.seleccion) ? C.ELEVACION_SELECCION : 0;
      f.elev += (objetivo - f.elev) * kElev;
    }
  }

  /* -------------------------------- Cámara -------------------------------- */

  arrastrar(dx, dy) {
    const C = CONFIG_3D.CAMARA;
    this.yaw -= dx * C.SENSIBILIDAD_X;
    this.pitch = Math.max(C.PITCH_MIN, Math.min(C.PITCH_MAX, this.pitch + dy * C.SENSIBILIDAD_Y));
  }

  acercar(factor) {
    const C = CONFIG_3D.CAMARA;
    this.zoom = Math.max(C.ZOOM_MIN, Math.min(C.ZOOM_MAX, this.zoom * factor));
  }

  centrarCamara() {
    this.yaw = CONFIG_3D.CAMARA.YAW_INICIAL;
    this.pitch = CONFIG_3D.CAMARA.PITCH_INICIAL;
    this.zoom = 1;
  }

  // Pone la cámara en `g`. La distancia se calcula para que el tablero ENTRE entero en la
  // pantalla, sea apaisada (compu) o vertical (celular).
  aplicarCamara(g) {
    const C = CONFIG_3D.CAMARA;
    const w = g.width, h = g.height, aspecto = w / h;
    const paso = CONFIG_3D.TAM_CASILLA + CONFIG_3D.SEPARACION;
    const radio = (paso * 3 / 2) * Math.SQRT2 + CONFIG_3D.MARGEN_BASE; // el tablero girando cabe en este círculo
    const fovH = 2 * Math.atan(Math.tan(C.FOV / 2) * aspecto);
    const fovMin = Math.min(C.FOV, fovH);
    const dist = (radio / Math.sin(fovMin / 2)) * C.MARGEN / this.zoom;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const ex = dist * cp * Math.sin(this.yaw);
    const ey = -dist * sp;                      // en p5 WEBGL "arriba" es y NEGATIVA
    const ez = dist * cp * Math.cos(this.yaw);
    g.perspective(C.FOV, aspecto, 10, 8000);
    g.camera(ex, ey - 10, ez, 0, -10, 0, 0, 1, 0);
  }

  /* -------------------------------- Dibujo -------------------------------- */

  _luces(g) {
    g.ambientLight(105, 110, 128);
    g.directionalLight(255, 248, 238, -0.35, 0.85, -0.45); // luz principal desde arriba
    g.directionalLight(80, 100, 160, 0.55, 0.35, 0.6);     // luz de relleno, azulada
  }

  // Dibuja la escena en `g` (la ventana).
  dibujar(g) {
    this.aplicarCamara(g);
    g.noStroke();
    this._luces(g);
    g.push();
    g.rotateY(this.giroActual);
    this._dibujarTablero(g, false);
    this._dibujarFichas(g, false);
    g.pop();
  }

  // Dibuja la escena en el buffer de picking: cada casilla de un color plano único.
  dibujarPicking(pg) {
    pg.background(0);
    this.aplicarCamara(pg);
    pg.noLights();
    pg.noStroke();
    pg.push();
    pg.rotateY(this.giroActual);
    this._dibujarTablero(pg, true);
    this._dibujarFichas(pg, true);
    pg.pop();
  }

  _dibujarTablero(g, picking) {
    const C = CONFIG_3D;
    const paso = C.TAM_CASILLA + C.SEPARACION;
    const ladoTablero = 3 * C.TAM_CASILLA + 2 * C.SEPARACION;
    const pulso = 0.5 + 0.5 * Math.sin(this.reloj * C.VELOCIDAD_PULSO);

    if (!picking) {
      // Base oscura debajo (la parte de arriba queda un poco más abajo que las baldosas,
      // así los huecos entre baldosas se ven como ranuras).
      const hundido = C.ALTO_BALDOSA * 0.55;
      g.push();
      g.translate(0, hundido + C.ALTO_BASE / 2, 0);
      g.fill(...C.COLOR_BASE);
      g.box(ladoTablero + 2 * C.MARGEN_BASE, C.ALTO_BASE, ladoTablero + 2 * C.MARGEN_BASE);
      g.pop();
      g.push();
      g.translate(0, hundido + C.ALTO_BASE + 7, 0);
      g.fill(...C.COLOR_BASE_INFERIOR);
      g.box(ladoTablero + 2 * C.MARGEN_BASE + 26, 14, ladoTablero + 2 * C.MARGEN_BASE + 26);
      g.pop();
    }

    const lineaActiva = this.linea && this.reloj >= this.lineaDesde;
    for (let i = 0; i < 9; i++) {
      const p = posicionCasilla(i);
      let col;
      if (picking) {
        col = colorPicking(i);
      } else {
        col = ((Math.floor(i / 3) + (i % 3)) % 2 === 0) ? C.COLOR_BALDOSA_A : C.COLOR_BALDOSA_B;
        if (lineaActiva && this.linea.indexOf(i) !== -1) col = mezclarColor(col, C.COLOR_DORADO, 0.35 + 0.15 * pulso);
      }
      g.push();
      g.translate(p.x, C.ALTO_BALDOSA / 2, p.z);
      g.fill(...col);
      g.box(C.TAM_CASILLA, C.ALTO_BALDOSA, C.TAM_CASILLA);
      g.pop();

      // Placa celeste que late sobre las casillas a las que se puede mover.
      if (!picking && this.destinos.indexOf(i) !== -1) {
        const lado = C.TAM_CASILLA * (0.74 + 0.12 * pulso);
        g.push();
        g.translate(p.x, -2, p.z);
        g.fill(...mezclarColor(C.COLOR_CELESTE, [255, 255, 255], 0.15 * pulso));
        g.box(lado, 4, lado);
        g.pop();
      }
    }
  }

  _dibujarFichas(g, picking) {
    const C = CONFIG_3D;
    const pulso = 0.5 + 0.5 * Math.sin(this.reloj * C.VELOCIDAD_PULSO);
    const lineaActiva = this.linea && this.reloj >= this.lineaDesde;
    const PI = Math.PI;

    for (const f of this.fichas) {
      let col;
      if (picking) {
        col = colorPicking(f.celda);
      } else {
        col = f.jugador === 1 ? C.COLOR_J1 : C.COLOR_J2;
        if (f.celda === this.seleccion) col = mezclarColor(col, [255, 255, 255], 0.28);
        if (lineaActiva && this.linea.indexOf(f.celda) !== -1) {
          col = mezclarColor(C.COLOR_DORADO, [255, 255, 255], 0.22 * pulso);
        }
      }
      // y negativa = hacia arriba. La ficha apoyada tiene su base en y = 0.
      const yCentro = -(C.ALTO_FICHA / 2) - f.caida - f.elev - f.salto;
      g.push();
      g.translate(f.x, yCentro, f.z);
      g.fill(...col);
      if (f.jugador === 1) {
        // Círculo: anillo (torus) acostado. Su "grosor" 2*tubo = ALTO_FICHA.
        g.rotateX(PI / 2);
        g.torus(C.RADIO_ANILLO, C.ALTO_FICHA / 2, 30, 14);
      } else {
        // Cruz: dos barras cruzadas en X, del mismo alto que el anillo.
        g.push();
        g.rotateY(PI / 4);
        g.box(C.LARGO_BARRA, C.ALTO_FICHA, C.GROSOR_BARRA);
        g.pop();
        g.push();
        g.rotateY(-PI / 4);
        g.box(C.LARGO_BARRA, C.ALTO_FICHA, C.GROSOR_BARRA);
        g.pop();
      }
      g.pop();
    }
  }

  /* ------------------------------- Picking ------------------------------- */

  // ¿Qué casilla hay en el punto (x, y) de la pantalla? Devuelve 0..8 o -1.
  // `pg` es el buffer oculto (createGraphics WEBGL, sin antialias, pixelDensity(1)).
  elegir(pg, x, y) {
    if (x < 0 || y < 0 || x >= pg.width || y >= pg.height) return -1;
    this.dibujarPicking(pg);
    return casillaDesdePixel(pg.get(Math.floor(x), Math.floor(y)));
  }

  // (Solo para pruebas) centro en pantalla de cada casilla según el buffer de picking.
  centroidesPicking(pg) {
    this.dibujarPicking(pg);
    pg.loadPixels();
    const w = pg.width, h = pg.height, px = pg.pixels;
    const suma = []; for (let i = 0; i < 9; i++) suma.push([0, 0, 0]);
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const o = (y * w + x) * 4;
        const c = casillaDesdePixel([px[o], px[o + 1], px[o + 2], px[o + 3]]);
        if (c >= 0) { suma[c][0] += x; suma[c][1] += y; suma[c][2]++; }
      }
    }
    return suma.map((s) => (s[2] ? { x: s[0] / s[2], y: s[1] / s[2], n: s[2] } : null));
  }
}

/* ============================== PUNTERO ============================== */

// Arrastrar (mouse o dedo) gira la cámara; un toque corto sin arrastre es un "clic de juego".
// Con dos dedos se hace zoom (pellizco). La rueda del mouse también hace zoom.
class ControlPuntero {
  constructor(elemento, escena, alToque) {
    this.el = elemento;
    this.escena = escena;
    this.alToque = alToque;       // función (x, y) con coordenadas relativas al lienzo
    this.punteros = new Map();    // id → {x, y}
    this.inicio = null;           // dónde y cuándo empezó el toque
    this.movido = false;          // ¿se arrastró lo suficiente como para no ser un toque?
    this.multitactil = false;     // ¿hubo dos dedos en este gesto?
    this.distPellizco = 0;

    elemento.style.touchAction = 'none'; // el navegador no debe hacer scroll/zoom por su cuenta
    elemento.addEventListener('pointerdown', (e) => this._abajo(e));
    elemento.addEventListener('pointermove', (e) => this._mover(e));
    elemento.addEventListener('pointerup', (e) => this._arriba(e, true));
    elemento.addEventListener('pointercancel', (e) => this._arriba(e, false));
    elemento.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.escena.acercar(Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });
    elemento.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _relativo(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _abajo(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this.el.setPointerCapture(e.pointerId); } catch (err) { /* no pasa nada */ }
    this.punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.punteros.size === 1) {
      this.inicio = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.movido = false;
      this.multitactil = false;
    } else {
      this.multitactil = true;
      this.distPellizco = this._distanciaDedos();
    }
  }

  _distanciaDedos() {
    const v = Array.from(this.punteros.values());
    return v.length >= 2 ? Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y) : 0;
  }

  _mover(e) {
    const previo = this.punteros.get(e.pointerId);
    if (!previo) return;
    const dx = e.clientX - previo.x, dy = e.clientY - previo.y;
    previo.x = e.clientX; previo.y = e.clientY;

    if (this.punteros.size === 1) {
      if (!this.movido && Math.hypot(e.clientX - this.inicio.x, e.clientY - this.inicio.y) > CONFIG_3D.UMBRAL_ARRASTRE_PX) {
        this.movido = true;
      }
      if (this.movido) this.escena.arrastrar(dx, dy);
    } else if (this.punteros.size === 2) {
      const d = this._distanciaDedos();
      if (this.distPellizco > 0 && d > 0) this.escena.acercar(d / this.distPellizco);
      this.distPellizco = d;
      this.movido = true;
    }
  }

  _arriba(e, esLevantar) {
    if (!this.punteros.has(e.pointerId)) return;
    this.punteros.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch (err) { /* nada */ }
    if (this.punteros.size > 0) { this.distPellizco = this._distanciaDedos(); return; }

    const esToque = esLevantar && !this.movido && !this.multitactil && this.inicio &&
      (performance.now() - this.inicio.t) < CONFIG_3D.MAX_TOQUE_MS;
    if (esToque) {
      const p = this._relativo(e);
      this.alToque(p.x, p.y);
    }
    this.inicio = null;
  }
}
