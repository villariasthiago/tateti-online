/* =====================================================================
   sketch.js  —  setup/draw de p5, MENÚ y pegamento entre las partes
   ---------------------------------------------------------------------
   Acá se conecta todo:
     tateti-logica.js (reglas)  ⇄  tateti-3d.js (dibujo y toques)  ⇄  online.js (red)
   * Maneja las pantallas del menú y el HUD (textos de turno y ayuda).
   * Crea la Sesión de juego según el modo (compu, dos jugadores, online).
   * Traduce los toques en jugadas y los eventos de la Sesión en animaciones.
   ===================================================================== */

/* ===================== CONSTANTES DE CONFIGURACIÓN ===================== */

const AJUSTES_UI = {
  PENSAR_IA_MS: 650,        // pausa antes de que la compu juegue (para que se vea qué pasa)
  DEMORA_PANEL_FIN_MS: 1250, // cuánto se espera para mostrar "¡Ganaste!" y dejar ver la línea dorada
  AVISO_MS: 2400,           // cuánto dura un aviso corto ("esa casilla está ocupada")
  GIRO_MENU: 0.00011,       // velocidad con la que gira la cámara de fondo en el menú
  CLAVE_GIRATORIO: 'tateti3d.giratorio', // dónde se recuerda la opción de tablero giratorio
};

/* ================================ ESTADO ================================ */

const L = TatetiLogica;          // atajo a la lógica
let escena = null;               // Escena3D (dibujo)
let pg = null;                   // buffer oculto para el picking
let puntero = null;              // ControlPuntero
let sesion = null;               // Sesion actual (null si estamos en el menú)

let ajustes = { nivel: 'medio', giratorio: false };
let seleccion = -1;              // casilla de la ficha elegida
let destinos = [];               // casillas a las que puede ir
let idPartidaUI = 0;             // cambia cada vez que se arranca/abandona una partida (cancela timers viejos)
let iaPlanificada = false;
let timerAyuda = null;
let timerCopiar = null;

const $ = (id) => document.getElementById(id);

/* ============================ p5: setup y draw ============================ */

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  setAttributes('antialias', true);                    // bordes suaves en la pantalla principal
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  // setAttributes vuelve a crear el lienzo: lo (re)ubicamos en nuestro contenedor.
  const elemento = drawingContext.canvas;
  $('lienzo').appendChild(elemento);

  // Buffer oculto para el picking: WEBGL, SIN antialias (los colores deben quedar exactos) y
  // pixelDensity(1) (un pixel del buffer = un pixel de pantalla en coordenadas CSS).
  pg = createGraphics(windowWidth, windowHeight, WEBGL);
  pg.setAttributes('antialias', false);
  pg.pixelDensity(1);
  pg.canvas.style.display = 'none';

  escena = new Escena3D();
  puntero = new ControlPuntero(elemento, escena, alToqueEnLienzo);
  escena.reiniciar(L.crearEstado(1)); // tablero vacío para el fondo del menú

  conectarMenu();
  conectarOnline();
  mostrarPantalla('pantalla-menu');
}

function draw() {
  // Tope de 100 ms por cuadro: si la pestaña estuvo dormida no saltamos de golpe, pero en un
  // celular lento (15 cuadros/seg) las animaciones siguen durando casi lo mismo.
  const dt = Math.min(deltaTime || 16, 100);
  if (!sesion) escena.yaw += dt * AJUSTES_UI.GIRO_MENU; // en el menú el tablero gira solito de fondo
  escena.actualizar(dt);
  clear(); // transparente: se ve el degradé oscuro de la página
  escena.dibujar(window);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  pg.resizeCanvas(windowWidth, windowHeight);
  pg.pixelDensity(1);
}

/* ============================ Pantallas y menú ============================ */

const PANTALLAS = ['pantalla-menu', 'pantalla-ia', 'pantalla-online', 'pantalla-reglas'];

function mostrarPantalla(id) {
  PANTALLAS.forEach((p) => $(p).classList.toggle('oculto', p !== id));
}

function conectarMenu() {
  // Opción de tablero giratorio (se recuerda entre visitas).
  try { ajustes.giratorio = localStorage.getItem(AJUSTES_UI.CLAVE_GIRATORIO) === '1'; } catch (e) { /* nada */ }
  const alCambiarGiro = (valor) => {
    ajustes.giratorio = valor;
    $('chk-giratorio').checked = valor;
    $('chk-giratorio-online').checked = valor;
    try { localStorage.setItem(AJUSTES_UI.CLAVE_GIRATORIO, valor ? '1' : '0'); } catch (e) { /* nada */ }
  };
  alCambiarGiro(ajustes.giratorio);
  $('chk-giratorio').addEventListener('change', (e) => alCambiarGiro(e.target.checked));
  $('chk-giratorio-online').addEventListener('change', (e) => alCambiarGiro(e.target.checked));

  $('btn-ia').addEventListener('click', () => mostrarPantalla('pantalla-ia'));
  $('btn-dos').addEventListener('click', () => iniciarPartida('dos'));
  $('btn-online').addEventListener('click', () => { reiniciarPantallaOnline(); mostrarPantalla('pantalla-online'); });
  $('btn-reglas').addEventListener('click', () => mostrarPantalla('pantalla-reglas'));

  document.querySelectorAll('.btn-nivel').forEach((b) => {
    b.addEventListener('click', () => { ajustes.nivel = b.dataset.nivel; iniciarPartida('ia'); });
  });
  document.querySelectorAll('[data-volver]').forEach((b) => {
    b.addEventListener('click', () => mostrarPantalla('pantalla-menu'));
  });

  $('btn-menu').addEventListener('click', () => {
    if (sesion && sesion.modo === 'online' && !sesion.estado.terminada &&
        !window.confirm('¿Salir de la partida online? Tu rival se va a quedar sin partida.')) return;
    volverAlMenu();
  });
  $('btn-fin-menu').addEventListener('click', volverAlMenu);
  $('btn-vista').addEventListener('click', () => escena.centrarCamara());
  $('btn-revancha').addEventListener('click', () => { if (sesion) sesion.pedirRevancha(); actualizarPanelFin(); });
}

function volverAlMenu() {
  Online.cerrar();
  sesion = null;
  idPartidaUI++;
  iaPlanificada = false;
  limpiarSeleccion();
  $('fin').classList.add('oculto');
  $('hud').classList.add('oculto');
  escena.reiniciar(L.crearEstado(1));
  reiniciarPantallaOnline();
  mostrarPantalla('pantalla-menu');
}

/* ============================ Iniciar una partida ============================ */

// modo: 'ia' | 'dos' | 'online'.  extra: {miJugador, giratorio}
function iniciarPartida(modo, extra) {
  extra = extra || {};
  idPartidaUI++;
  iaPlanificada = false;
  limpiarSeleccion();
  sesion = new L.Sesion({
    modo: modo,
    miJugador: extra.miJugador || 1,           // en 'ia' el humano siempre es el 1 (círculo verde)
    giratorio: extra.giratorio !== undefined ? extra.giratorio : ajustes.giratorio,
    enviar: (m) => Online.enviar(m),
    alEvento: alEventoSesion,
  });
  escena.reiniciar(sesion.estado);
  escena.centrarCamara();
  mostrarPantalla(null);
  $('fin').classList.add('oculto');
  $('hud').classList.remove('oculto');
  $('hud-conexion').classList.toggle('oculto', modo !== 'online');
  $('hud-conexion').classList.add('ok');
  $('hud-conexion').textContent = 'Conectado';
  actualizarHUD();
  planificarIA();
}

/* ============================ Eventos de la Sesión ============================ */

function alEventoSesion(ev) {
  switch (ev.tipo) {
    case 'jugada': {
      limpiarSeleccion();
      escena.jugada(ev.jugada, ev.jugador);
      if (ev.despues.terminada) {
        escena.setLinea(ev.despues.linea);
        const mia = idPartidaUI;
        setTimeout(() => { if (mia === idPartidaUI && sesion && sesion.estado.terminada) mostrarFin(); },
          AJUSTES_UI.DEMORA_PANEL_FIN_MS);
      }
      actualizarHUD();
      planificarIA();
      break;
    }
    case 'giro':
      escena.irAGiro(ev.rotacion, CONFIG_3D.GIRO_RETRASO_MS);
      actualizarHUD();
      break;
    case 'reinicio':
      limpiarSeleccion();
      $('fin').classList.add('oculto');
      escena.reiniciar(sesion.estado, true); // revancha: el tablero vuelve girando suavemente
      actualizarHUD();
      planificarIA();
      break;
    case 'revancha':
      actualizarPanelFin();
      break;
    case 'config':
      actualizarHUD();
      break;
  }
}

/* ============================== Toques y jugadas ============================== */

function alToqueEnLienzo(x, y) {
  if (!sesion || $('fin').classList.contains('oculto') === false) return;
  manejarToque(escena.elegir(pg, x, y));
}

function limpiarSeleccion() {
  seleccion = -1; destinos = [];
  if (escena) escena.setSeleccion(-1, []);
}

function manejarToque(celda) {
  const e = sesion.estado;
  if (e.terminada || escena.girando()) return;
  if (celda < 0) { if (seleccion >= 0) { limpiarSeleccion(); actualizarHUD(); } return; }
  if (!sesion.puedeJugar()) {
    if (sesion.modo === 'online') avisoCorto(sesion.esperandoGiro ? 'El tablero está girando...' : 'Esperá: es el turno del rival.');
    return;
  }
  const jug = e.turno;
  if (L.faseDe(e, jug) === 'colocar') {
    if (e.tablero[celda] !== 0) { avisoCorto('Esa casilla está ocupada. Elegí una vacía.'); return; }
    sesion.jugar({ tipo: 'poner', a: celda });
    return;
  }
  // Fase de mover
  if (e.tablero[celda] === jug) {
    if (seleccion === celda) { limpiarSeleccion(); actualizarHUD(); return; } // tocar de nuevo = soltar
    seleccion = celda;
    destinos = L.adyacentes(celda).filter((a) => e.tablero[a] === 0);
    escena.setSeleccion(seleccion, destinos);
    if (destinos.length === 0) avisoCorto('Esa ficha está bloqueada. Probá con otra.');
    else actualizarHUD();
  } else if (seleccion >= 0 && destinos.indexOf(celda) !== -1) {
    sesion.jugar({ tipo: 'mover', de: seleccion, a: celda });
  } else if (e.tablero[celda] === 0) {
    avisoCorto(seleccion < 0 ? 'Primero tocá una ficha tuya.' : 'Solo podés ir a una casilla celeste: al lado, sin diagonales.');
  } else {
    avisoCorto('Esa ficha es del rival. Tocá una tuya.');
  }
}

/* ================================ La compu ================================ */

function planificarIA() {
  if (!sesion || sesion.modo !== 'ia' || sesion.estado.terminada) return;
  const ia = 3 - sesion.miJugador;
  if (sesion.estado.turno !== ia || iaPlanificada) return;
  iaPlanificada = true;
  const mia = idPartidaUI;
  const intentar = () => {
    if (mia !== idPartidaUI || !sesion) { iaPlanificada = false; return; }
    if (escena.girando()) { setTimeout(intentar, 120); return; } // esperar a que termine de girar
    iaPlanificada = false;
    const jugada = L.elegirJugadaIA(sesion.estado, ajustes.nivel); // responde en menos de 1,5 s
    if (jugada) sesion.jugar(jugada, ia);
  };
  setTimeout(intentar, AJUSTES_UI.PENSAR_IA_MS);
}

/* =================================== HUD =================================== */

function iconoFicha(jugador) {
  return jugador === 1
    ? '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="none" stroke="#3cdc78" stroke-width="5"/></svg>'
    : '<svg viewBox="0 0 32 32"><path d="M7 7L25 25M25 7L7 25" stroke="#f04848" stroke-width="5" stroke-linecap="round"/></svg>';
}
const NOMBRE_FICHA = { 1: 'círculo verde', 2: 'cruz roja' };

function textoAyuda(e, jug) {
  if (L.faseDe(e, jug) === 'colocar') {
    return 'Tocá una casilla vacía para poner tu ficha (te quedan ' + (L.CONFIG.FICHAS_POR_JUGADOR - e.colocadas[jug]) + ').';
  }
  return seleccion >= 0
    ? 'Ahora tocá una casilla celeste para mover la ficha.'
    : 'Tocá una ficha tuya y movela a una casilla vacía de al lado (sin diagonales).';
}

function actualizarHUD() {
  if (!sesion) return;
  const e = sesion.estado;
  const turno = $('hud-turno'), ayuda = $('hud-ayuda');
  let txt = '', clase = 'rival', ayudaTxt = '';
  let jugadorIcono = sesion.miJugador;
  let rolTxt = '';

  if (sesion.modo === 'dos') {
    jugadorIcono = e.turno;
    rolTxt = 'Jugador ' + e.turno + '<small>' + NOMBRE_FICHA[e.turno] + '</small>';
    if (e.terminada) { txt = 'Fin de la partida'; clase = 'fin'; }
    else { txt = 'Turno del Jugador ' + e.turno + ' (' + NOMBRE_FICHA[e.turno] + ')'; clase = 'mio'; ayudaTxt = textoAyuda(e, e.turno); }
  } else {
    rolTxt = 'Sos el ' + sesion.miJugador + '<small>' + NOMBRE_FICHA[sesion.miJugador] + '</small>';
    if (e.terminada) { txt = 'Fin de la partida'; clase = 'fin'; }
    else if (sesion.modo === 'online' && sesion.esperandoGiro) { txt = 'El tablero está girando...'; clase = 'rival'; }
    else if (sesion.puedeJugar()) { txt = 'Tu turno'; clase = 'mio'; ayudaTxt = textoAyuda(e, sesion.miJugador); }
    else if (sesion.modo === 'ia') { txt = 'Piensa la compu...'; clase = 'rival'; ayudaTxt = 'Podés girar la cámara mientras esperás.'; }
    else { txt = 'Turno del rival'; clase = 'rival'; ayudaTxt = 'Podés girar la cámara mientras esperás.'; }
  }

  turno.textContent = txt;
  turno.className = 'turno ' + clase;
  if (!timerAyuda) ayuda.textContent = ayudaTxt;
  $('hud-ficha').innerHTML = iconoFicha(jugadorIcono);
  $('hud-rol').innerHTML = rolTxt;
  $('hud-giro').classList.toggle('oculto', !sesion.giratorio);
  $('hud-giro').textContent = 'Tablero giratorio';
}

// Un aviso que reemplaza un ratito el texto de ayuda.
function avisoCorto(msg) {
  const ayuda = $('hud-ayuda');
  ayuda.textContent = msg;
  if (timerAyuda) clearTimeout(timerAyuda);
  timerAyuda = setTimeout(() => { timerAyuda = null; actualizarHUD(); }, AJUSTES_UI.AVISO_MS);
}

/* ============================== Fin de partida ============================== */

function mostrarFin() {
  const e = sesion.estado;
  let titulo, texto, mal = false;
  if (e.ganador === 0) {
    titulo = '¡Empate!';
    texto = 'Pasaron ' + L.CONFIG.MAX_MOVIMIENTOS + ' movimientos sin ganador.';
  } else if (sesion.modo === 'dos') {
    titulo = '¡Ganó el Jugador ' + e.ganador + '! 🎉';
    texto = e.razon === 'sinJugadas' ? 'El otro se quedó sin jugadas posibles.' : 'Armó 3 en línea.';
  } else if (e.ganador === sesion.miJugador) {
    titulo = '¡Ganaste! 🎉';
    texto = e.razon === 'sinJugadas' ? 'Tu rival se quedó sin jugadas posibles.' : 'Armaste 3 en línea.';
  } else {
    mal = true;
    titulo = sesion.modo === 'ia' ? 'Ganó la compu' : 'Ganó tu rival';
    texto = e.razon === 'sinJugadas' ? 'Te quedaste sin jugadas posibles.' : 'Armó 3 en línea. ¡La próxima sale!';
  }
  $('fin-titulo').textContent = titulo;
  $('fin-texto').textContent = texto;
  $('fin').classList.toggle('mal', mal);
  $('fin').classList.remove('oculto');
  $('btn-revancha').classList.remove('oculto');
  actualizarPanelFin();
}

// Texto y estado del botón de revancha según lo que pidió cada uno.
function actualizarPanelFin() {
  const b = $('btn-revancha');
  if (!sesion || !sesion.estado.terminada || $('fin').classList.contains('oculto')) return;
  b.disabled = false;
  if (sesion.modo !== 'online') { b.textContent = 'Revancha'; return; }
  if (sesion.yoPedi) { b.disabled = true; b.textContent = 'Esperando al rival...'; }
  else if (sesion.rivalPidio) { b.textContent = 'Aceptar revancha'; $('fin-texto').textContent = '¡Tu rival quiere la revancha!'; }
  else { b.textContent = 'Pedir revancha'; }
}

function mostrarDesconexion() {
  $('fin-titulo').textContent = 'El rival se desconectó';
  $('fin-texto').textContent = 'La partida online terminó. Volvé al menú para crear otra sala o unirte a una.';
  $('fin').classList.add('mal');
  $('fin').classList.remove('oculto');
  $('btn-revancha').classList.add('oculto');
  $('hud-conexion').classList.remove('ok');
  $('hud-conexion').textContent = 'Desconectado';
  if (sesion) actualizarHUD();
}

/* ============================== Pantalla online ============================== */

function mostrarPasoOnline(paso) {
  $('online-inicio').classList.toggle('oculto', paso !== 'inicio');
  $('online-sala').classList.toggle('oculto', paso !== 'sala');
  $('online-conectando').classList.toggle('oculto', paso !== 'conectando');
}

function mensajeOnline(texto, esOk) {
  const m = $('online-msg');
  if (!texto) { m.classList.add('oculto'); m.textContent = ''; return; }
  m.textContent = texto;
  m.classList.toggle('ok', !!esOk);
  m.classList.remove('oculto');
}

function reiniciarPantallaOnline() {
  mostrarPasoOnline('inicio');
  mensajeOnline('');
  $('btn-copiar').textContent = '📋 Copiar';
}

function conectarOnline() {
  $('btn-crear-sala').addEventListener('click', () => {
    mensajeOnline('');
    mostrarPasoOnline('sala');
    $('codigo-sala').textContent = '····';
    $('online-sala-estado').textContent = 'Creando la sala...';
    Online.crearSala();
  });

  const conectar = () => {
    mensajeOnline('');
    const cod = Online.normalizarCodigo($('input-codigo').value);
    $('input-codigo').value = cod;
    if (!Online.codigoValido(cod)) {
      mensajeOnline('No se pudo conectar. Revisá el código: tiene 4 letras o números (nunca O, 0, I ni 1).');
      return;
    }
    Online.unirse(cod);
  };
  $('btn-conectar').addEventListener('click', conectar);
  $('input-codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') conectar(); });
  $('input-codigo').addEventListener('input', (e) => { e.target.value = Online.normalizarCodigo(e.target.value); });

  $('btn-online-volver').addEventListener('click', () => {
    if (!$('online-inicio').classList.contains('oculto')) { mostrarPantalla('pantalla-menu'); return; }
    Online.cerrar(); // estaba esperando o conectando: cancelar y volver al paso 1
    reiniciarPantallaOnline();
  });

  $('btn-copiar').addEventListener('click', copiarCodigo);

  Online.alRecibir((mensaje) => { if (sesion) sesion.recibir(mensaje); });

  Online.alCambiarEstado((info) => {
    switch (info.estado) {
      case 'esperando':
        mostrarPasoOnline('sala');
        $('codigo-sala').textContent = info.codigo;
        $('online-sala-estado').textContent = 'Esperando rival...';
        break;
      case 'conectando':
        mostrarPasoOnline('conectando');
        $('online-conectando-texto').textContent = 'Conectando con la sala...';
        break;
      case 'conectado':
        if (info.rol === 'anfitrion') {
          iniciarPartida('online', { miJugador: 1, giratorio: ajustes.giratorio });
          sesion.enviarConfigInicial(); // le cuenta al invitado si hay tablero giratorio
        } else {
          iniciarPartida('online', { miJugador: 2, giratorio: false }); // lo decide el anfitrión
          sesion.saludar();
        }
        break;
      case 'desconectado':
        if (sesion && sesion.modo === 'online') mostrarDesconexion();
        break;
      case 'error':
        reiniciarPantallaOnline();
        mensajeOnline(info.mensaje);
        break;
    }
  });
}

function copiarCodigo() {
  const cod = $('codigo-sala').textContent.trim();
  if (!Online.codigoValido(cod)) return;
  const listo = () => {
    $('btn-copiar').textContent = '✓ ¡Copiado!';
    if (timerCopiar) clearTimeout(timerCopiar);
    timerCopiar = setTimeout(() => { $('btn-copiar').textContent = '📋 Copiar'; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cod).then(listo, () => copiaAlternativa(cod, listo));
  } else {
    copiaAlternativa(cod, listo);
  }
}

// Plan B para navegadores sin la API moderna del portapapeles.
function copiaAlternativa(texto, listo) {
  const t = document.createElement('textarea');
  t.value = texto; t.style.position = 'fixed'; t.style.opacity = '0';
  document.body.appendChild(t); t.select();
  try { if (document.execCommand('copy')) listo(); } catch (e) { /* nada */ }
  document.body.removeChild(t);
}

/* ==================== Ganchos para las pruebas automáticas ==================== */
// (No afectan al juego: solo dejan mirar el estado desde la consola o desde un navegador de prueba.)
window.__tateti = {
  get sesion() { return sesion; },
  get escena() { return escena; },
  get seleccion() { return seleccion; },
  get destinos() { return destinos; },
  centroides: () => escena.centroidesPicking(pg),
  picking: () => ({ ancho: pg.width, alto: pg.height, antialias: pg.drawingContext.getContextAttributes().antialias, densidad: pg.pixelDensity() }),
};
