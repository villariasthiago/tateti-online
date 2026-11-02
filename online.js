/* =====================================================================
   online.js  —  TRANSPORTE ONLINE (PeerJS / WebRTC)
   ---------------------------------------------------------------------
   Este archivo es lo ÚNICO que conoce PeerJS. El juego solo usa esta
   interfaz, así que para cambiar a Firebase (u otro) se reescribe este
   archivo y no se toca nada más:

     Online.crearSala()               → crea una sala y espera al rival
     Online.unirse(codigo)            → se une a la sala de otro
     Online.enviar(mensaje)           → manda un objeto JSON al rival (true/false)
     Online.alRecibir(fn)             → fn(mensaje) cada vez que llega algo
     Online.alCambiarEstado(fn)       → fn({estado, ...}) con los cambios de estado
     Online.cerrar()                  → corta todo y libera la conexión
     Online.codigoValido(texto)       → true si tiene el formato de un código
     Online.normalizarCodigo(texto)   → mayúsculas y sin espacios

   Estados que se avisan en alCambiarEstado:
     {estado:'esperando',   codigo}      sala creada, esperando al rival
     {estado:'conectando'}               el invitado está intentando conectar
     {estado:'conectado',   rol}         rol = 'anfitrion' | 'invitado'
     {estado:'desconectado'}             se cayó una conexión que estaba andando
     {estado:'error', motivo, mensaje}   no se pudo conectar. motivo:
          'codigo-invalido' | 'sala-inexistente' | 'timeout' | 'servidor' |
          'sin-peerjs' | 'sala-ocupada' | 'otro'

   Cómo funciona (para entender):
     1) Un servidor público gratuito de PeerJS ("señalización") hace de
        "recepcionista": ayuda a que los dos navegadores se encuentren.
     2) Después los navegadores se conectan DIRECTO (WebRTC) y la partida
        viaja de uno a otro sin pasar por ningún servidor.
   ===================================================================== */
const Online = (function () {
  'use strict';

  /* ===================== CONSTANTES DE CONFIGURACIÓN ===================== */

  // Letras y números permitidos en el código de sala. Sin O, 0, I, 1 (se confunden).
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const LARGO_CODIGO = 4;

  // Se agrega adelante del código para armar el id real en el servidor. Así los ids del
  // juego no chocan con los de otras personas que usan el mismo servidor público.
  const PREFIJO_ID = 'tateti3d-';

  // Si no se logra conectar con la sala en este tiempo, se avisa error.
  const TIMEOUT_CONEXION_MS = 15000;

  // Latido: cada tanto se manda un mensajito interno para detectar si el rival se fue
  // sin avisar (por ejemplo, se le apagó el celular). Si pasa MAX_SILENCIO sin recibir
  // NADA, se considera desconectado.
  const LATIDO_CADA_MS = 4000;
  const MAX_SILENCIO_MS = 25000;

  // Cuántas veces se reintenta con otro código si el que salió ya estaba en uso.
  const REINTENTOS_CODIGO = 6;

  // Opciones de PeerJS. null = usar el servidor público gratuito de PeerJS (0.peerjs.com).
  // Si algún día querés un servidor propio:  {host:'mi-servidor.com', port:443, secure:true, path:'/'}
  // (La página también puede definir window.TATETI_PEER_OPCIONES antes de cargar este archivo;
  //  lo usamos para las pruebas con un servidor local.)
  const OPCIONES_PEER =
    (typeof window !== 'undefined' && window.TATETI_PEER_OPCIONES) || null;

  /* ============================== ESTADO ============================== */

  let peer = null;          // objeto Peer de PeerJS
  let conn = null;          // conexión de datos con el rival
  let rol = null;           // 'anfitrion' | 'invitado'
  let codigo = null;        // código de la sala
  let conectado = false;    // ¿la conexión con el rival está andando?
  let cerrando = false;     // true mientras cerramos a propósito (para no avisar "desconectado")
  let timerTimeout = null;  // timeout de conexión
  let timerLatido = null;   // intervalo del latido
  let ultimoMensaje = 0;    // cuándo llegó lo último del rival
  let cbRecibir = function () {};
  let cbEstado = function () {};

  /* ============================== UTILIDADES ============================== */

  function avisarEstado(obj) { try { cbEstado(obj); } catch (e) { console.error(e); } }

  function avisarError(motivo, mensaje) {
    limpiarTimers();
    avisarEstado({ estado: 'error', motivo: motivo, mensaje: mensaje });
  }

  function limpiarTimers() {
    if (timerTimeout) { clearTimeout(timerTimeout); timerTimeout = null; }
    if (timerLatido) { clearInterval(timerLatido); timerLatido = null; }
  }

  // Genera un código al azar con el alfabeto sin letras confusas.
  function generarCodigo() {
    let s = '';
    const azar = new Uint32Array(LARGO_CODIGO);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(azar);
    else for (let i = 0; i < LARGO_CODIGO; i++) azar[i] = Math.floor(Math.random() * 4294967296);
    for (let i = 0; i < LARGO_CODIGO; i++) s += ALFABETO.charAt(azar[i] % ALFABETO.length);
    return s;
  }

  function normalizarCodigo(texto) {
    return String(texto == null ? '' : texto).replace(/\s+/g, '').toUpperCase();
  }

  // ¿Tiene el largo justo y solo letras/números permitidos?
  function codigoValido(texto) {
    const c = normalizarCodigo(texto);
    if (c.length !== LARGO_CODIGO) return false;
    for (let i = 0; i < c.length; i++) if (ALFABETO.indexOf(c.charAt(i)) === -1) return false;
    return true;
  }

  function hayPeerJS() { return typeof Peer !== 'undefined'; }

  // Cierra la conexión y el peer sin avisar "desconectado" (cierre a propósito).
  function cerrar() {
    cerrando = true;
    limpiarTimers();
    try { if (conn) conn.close(); } catch (e) { /* nada */ }
    try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) { /* nada */ }
    conn = null; peer = null; rol = null; codigo = null; conectado = false;
    cerrando = false;
  }

  /* ===================== CONEXIÓN DE DATOS (común) ===================== */

  // Engancha los eventos de la conexión con el rival (sirve para anfitrión e invitado).
  function configurarConexion(c) {
    conn = c;

    c.on('open', function () {
      if (conn !== c) return;
      conectado = true;
      ultimoMensaje = Date.now();
      limpiarTimers(); // ya no hace falta el timeout de conexión
      timerLatido = setInterval(latido, LATIDO_CADA_MS);
      avisarEstado({ estado: 'conectado', rol: rol });
    });

    c.on('data', function (data) {
      if (conn !== c) return;
      ultimoMensaje = Date.now();
      if (data && typeof data === 'object' && data.__latido) return; // mensaje interno
      try { cbRecibir(data); } catch (e) { console.error(e); }
    });

    // 'close' = el otro cortó. 'error' = algo falló en el canal.
    c.on('close', function () { perderConexion(c); });
    c.on('error', function () { perderConexion(c); });
  }

  function perderConexion(c) {
    if (cerrando || conn !== c) return;
    const estabaConectado = conectado;
    conectado = false;
    limpiarTimers();
    if (estabaConectado) avisarEstado({ estado: 'desconectado' });
    // Si nunca llegó a conectarse, el error lo informan el timeout o el peer.
  }

  function latido() {
    if (!conn || !conectado) return;
    if (Date.now() - ultimoMensaje > MAX_SILENCIO_MS) { perderConexion(conn); return; }
    try { conn.send({ __latido: 1 }); } catch (e) { /* si falla, el silencio lo detecta */ }
  }

  function crearPeer(id) {
    // Con id → el peer queda registrado con ese nombre (anfitrión). Sin id → uno al azar (invitado).
    return id ? new Peer(id, OPCIONES_PEER || undefined) : new Peer(OPCIONES_PEER || undefined);
  }

  /* ============================ ANFITRIÓN ============================ */

  function crearSala() {
    cerrar();
    if (!hayPeerJS()) {
      avisarError('sin-peerjs', 'No se pudo cargar PeerJS. Revisá tu conexión a internet y recargá la página.');
      return;
    }
    rol = 'anfitrion';
    intentarCrearSala(0);
  }

  function intentarCrearSala(intento) {
    codigo = generarCodigo();
    const p = crearPeer(PREFIJO_ID + codigo);
    peer = p;

    // Si el servidor de PeerJS no responde en el tiempo previsto, avisamos.
    limpiarTimers();
    timerTimeout = setTimeout(function () {
      if (peer !== p) return;
      avisarError('servidor', 'No se pudo conectar con el servidor de salas. Revisá tu internet o probá con datos móviles.');
    }, TIMEOUT_CONEXION_MS);

    p.on('open', function () {
      if (peer !== p) return;
      limpiarTimers();
      avisarEstado({ estado: 'esperando', codigo: codigo });
    });

    // Llega alguien que quiere unirse.
    p.on('connection', function (c) {
      if (peer !== p) return;
      if (conn) { // sala ocupada: ya hay un rival
        c.on('open', function () { try { c.close(); } catch (e) { /* nada */ } });
        return;
      }
      configurarConexion(c);
    });

    // Si se cae la conexión con el servidor de señalización, intentamos reconectar
    // (con el P2P ya andando no importa; sirve mientras esperamos al rival).
    p.on('disconnected', function () {
      if (peer !== p || cerrando) return;
      try { if (!p.destroyed) p.reconnect(); } catch (e) { /* nada */ }
    });

    p.on('error', function (err) {
      if (peer !== p || cerrando) return;
      const tipo = err && err.type;
      if (tipo === 'unavailable-id' && intento < REINTENTOS_CODIGO) {
        // Ese código ya estaba en uso en el servidor: probamos con otro.
        try { p.destroy(); } catch (e) { /* nada */ }
        peer = null;
        intentarCrearSala(intento + 1);
        return;
      }
      if (conectado) return; // el P2P sigue andando; el error de señalización no nos afecta
      avisarError('servidor', 'No se pudo crear la sala (' + (tipo || 'error') + '). Revisá tu internet o probá con datos móviles.');
    });
  }

  /* ============================== INVITADO ============================== */

  function unirse(texto) {
    cerrar();
    const cod = normalizarCodigo(texto);
    if (!codigoValido(cod)) {
      avisarError('codigo-invalido', 'No se pudo conectar. Revisá el código: tiene ' + LARGO_CODIGO + ' letras o números (sin O, 0, I ni 1).');
      return;
    }
    if (!hayPeerJS()) {
      avisarError('sin-peerjs', 'No se pudo cargar PeerJS. Revisá tu conexión a internet y recargá la página.');
      return;
    }
    rol = 'invitado';
    codigo = cod;
    avisarEstado({ estado: 'conectando' });

    const p = crearPeer(null);
    peer = p;

    // Timeout general de 15 s para todo el proceso de conexión.
    timerTimeout = setTimeout(function () {
      if (peer !== p || conectado) return;
      cerrar();
      avisarError('timeout', 'No se pudo conectar. Revisá el código. Si está bien, puede ser el firewall de la red: probá con datos móviles.');
    }, TIMEOUT_CONEXION_MS);

    p.on('open', function () {
      if (peer !== p) return;
      // JSON como formato: simple y legible, y alcanza para mensajes chiquitos.
      const c = p.connect(PREFIJO_ID + cod, { reliable: true, serialization: 'json' });
      configurarConexion(c);
    });

    p.on('error', function (err) {
      if (peer !== p || cerrando || conectado) return;
      const tipo = err && err.type;
      if (tipo === 'peer-unavailable') {
        cerrar();
        avisarError('sala-inexistente', 'No se pudo conectar. Revisá el código: no existe ninguna sala con ese código.');
      } else if (tipo === 'network' || tipo === 'server-error' || tipo === 'socket-error' || tipo === 'socket-closed') {
        cerrar();
        avisarError('servidor', 'No se pudo conectar con el servidor de salas. Revisá tu internet o probá con datos móviles.');
      } else {
        cerrar();
        avisarError('otro', 'No se pudo conectar (' + (tipo || 'error') + '). Revisá el código y tu conexión.');
      }
    });
  }

  /* ============================ ENVIAR / EVENTOS ============================ */

  // Manda un mensaje al rival. Devuelve true si se pudo enviar.
  function enviar(mensaje) {
    if (!conn || !conectado) return false;
    try { conn.send(mensaje); return true; } catch (e) { console.error(e); return false; }
  }

  // Avisar al rival si cerramos la pestaña, para que se entere enseguida.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { if (conn || peer) cerrar(); });
  }

  return {
    crearSala: crearSala,
    unirse: unirse,
    enviar: enviar,
    cerrar: cerrar,
    alRecibir: function (fn) { cbRecibir = fn || function () {}; },
    alCambiarEstado: function (fn) { cbEstado = fn || function () {}; },
    codigoValido: codigoValido,
    normalizarCodigo: normalizarCodigo,
    generarCodigo: generarCodigo,
    ALFABETO: ALFABETO,
    LARGO_CODIGO: LARGO_CODIGO,
  };
})();

// Para poder probarlo también en Node (los tests de código usan esto).
if (typeof module === 'object' && module.exports) module.exports = Online;
