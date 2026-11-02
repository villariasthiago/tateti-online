/* =====================================================================
   tateti-logica.js  —  LÓGICA PURA del Ta-Te-Ti 3D de 3 fichas
   ---------------------------------------------------------------------
   * No usa p5 ni el DOM: funciona igual en el navegador y en Node.
   * Es DETERMINISTA: el mismo estado + la misma jugada dan siempre el
     mismo resultado. Por eso, en el modo online, los dos navegadores
     solo necesitan intercambiarse las jugadas (mensajes chiquitos).
   * Contiene tres cosas:
       1) Las reglas (estado, jugadas legales, aplicar jugada, ganador).
       2) La IA (negamax con poda alfa-beta).
       3) La "Sesión": coordina una partida (local, contra la compu u
          online), valida lo que llega por la red, maneja la revancha y
          los giros del tablero.
   ===================================================================== */
(function (raiz, fabrica) {
  // Truco para que el mismo archivo sirva en el navegador (global) y en Node (require).
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.TatetiLogica = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ===================== CONSTANTES DE CONFIGURACIÓN ===================== */

  const CONFIG = {
    // Cantidad de fichas que tiene cada jugador (y que debe alinear).
    FICHAS_POR_JUGADOR: 3,

    // ¿Se puede mover en diagonal? false = solo horizontal/vertical (regla del juego).
    // (Las LÍNEAS GANADORAS sí incluyen las diagonales; esto es solo para MOVER.)
    DIAGONALES_PARA_MOVER: false,

    // Si se juegan tantas jugadas sin ganador, es empate.
    // Se cuentan TODAS las jugadas (las de colocar y las de mover).
    MAX_MOVIMIENTOS: 40,

    // Profundidad de búsqueda de la IA según el nivel (en "jugadas" de a una).
    PROFUNDIDAD: { facil: 1, medio: 3, dificil: 6 },

    // Probabilidad de que la IA juegue al azar, según el nivel (0 a 1).
    PROB_AZAR: { facil: 0.35, medio: 0, dificil: 0 },

    // Tiempo máximo que la IA puede "pensar" (milisegundos). El requisito es < 1500 ms.
    TIEMPO_MAX_IA_MS: 1200,

    // Valor de una victoria para la IA (número grande; se le resta la distancia
    // para que prefiera ganar rápido y perder lo más tarde posible).
    VALOR_VICTORIA: 10000,
  };

  // Las 8 líneas ganadoras (filas, columnas y diagonales). Casillas 0..8:
  //   0 1 2
  //   3 4 5
  //   6 7 8
  const LINEAS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],   // filas
    [0, 3, 6], [1, 4, 7], [2, 5, 8],   // columnas
    [0, 4, 8], [2, 4, 6],              // diagonales
  ];

  /* ============================== REGLAS ============================== */

  // Casillas vecinas de una casilla (para MOVER). Ortogonales, y diagonales si se habilita.
  function adyacentes(casilla, diagonales) {
    if (diagonales === undefined) diagonales = CONFIG.DIAGONALES_PARA_MOVER;
    const fila = Math.floor(casilla / 3), col = casilla % 3;
    const res = [];
    for (let df = -1; df <= 1; df++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (df === 0 && dc === 0) continue;
        if (!diagonales && df !== 0 && dc !== 0) continue; // descarta diagonales
        const f = fila + df, c = col + dc;
        if (f < 0 || f > 2 || c < 0 || c > 2) continue;
        res.push(f * 3 + c);
      }
    }
    return res;
  }

  // Estado inicial. `empieza` es 1 o 2 (quién juega primero).
  // estado = {
  //   tablero: [9 números]  0 = vacía, 1 = jugador 1 (círculo), 2 = jugador 2 (cruz)
  //   turno: 1 | 2           a quién le toca (si la partida terminó, es el que NO ganó)
  //   colocadas: [0, n1, n2] cuántas fichas puso cada jugador (el índice 0 no se usa)
  //   movimientos: número de jugadas hechas
  //   terminada, ganador (0 = nadie), linea (las 3 casillas ganadoras o null),
  //   razon: '' | 'linea' | 'empate' | 'sinJugadas'
  // }
  function crearEstado(empieza) {
    return {
      tablero: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      turno: empieza === 2 ? 2 : 1,
      colocadas: [0, 0, 0],
      movimientos: 0,
      terminada: false,
      ganador: 0,
      linea: null,
      razon: '',
    };
  }

  function clonarEstado(e) {
    return {
      tablero: e.tablero.slice(),
      turno: e.turno,
      colocadas: e.colocadas.slice(),
      movimientos: e.movimientos,
      terminada: e.terminada,
      ganador: e.ganador,
      linea: e.linea ? e.linea.slice() : null,
      razon: e.razon,
    };
  }

  // 'colocar' mientras al jugador le queden fichas por poner; después 'mover'.
  function faseDe(estado, jugador) {
    return estado.colocadas[jugador] < CONFIG.FICHAS_POR_JUGADOR ? 'colocar' : 'mover';
  }

  // Lista de jugadas legales para el jugador al que le toca.
  //   {tipo:'poner', a}          o          {tipo:'mover', de, a}
  function jugadasLegales(estado) {
    if (estado.terminada) return [];
    const res = [];
    const t = estado.tablero, j = estado.turno;
    if (faseDe(estado, j) === 'colocar') {
      for (let a = 0; a < 9; a++) if (t[a] === 0) res.push({ tipo: 'poner', a });
    } else {
      for (let de = 0; de < 9; de++) {
        if (t[de] !== j) continue;
        const vecinas = adyacentes(de);
        for (let k = 0; k < vecinas.length; k++) {
          if (t[vecinas[k]] === 0) res.push({ tipo: 'mover', de, a: vecinas[k] });
        }
      }
    }
    return res;
  }

  // ¿La jugada viene con la forma correcta? (importante para lo que llega por la red:
  // nunca confiamos en que el otro mande algo bien armado).
  function jugadaBienFormada(j) {
    if (!j || typeof j !== 'object') return false;
    const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 8;
    if (j.tipo === 'poner') return ok(j.a);
    if (j.tipo === 'mover') return ok(j.de) && ok(j.a);
    return false;
  }

  // ¿La jugada es legal en este estado? (misma validación para jugadas propias y del rival)
  function esLegal(estado, jugada) {
    if (!jugadaBienFormada(jugada) || estado.terminada) return false;
    const t = estado.tablero, j = estado.turno;
    const fase = faseDe(estado, j);
    if (jugada.tipo === 'poner') return fase === 'colocar' && t[jugada.a] === 0;
    return fase === 'mover' &&
      t[jugada.de] === j &&
      t[jugada.a] === 0 &&
      adyacentes(jugada.de).indexOf(jugada.a) !== -1;
  }

  // Devuelve la línea ganadora de `jugador` ([a,b,c]) o null.
  function lineaGanadora(tablero, jugador) {
    for (let i = 0; i < LINEAS.length; i++) {
      const L = LINEAS[i];
      if (tablero[L[0]] === jugador && tablero[L[1]] === jugador && tablero[L[2]] === jugador) return L.slice();
    }
    return null;
  }

  // Aplica una jugada y DEVUELVE UN ESTADO NUEVO (el original no se modifica).
  // Lanza un error si la jugada es ilegal: quien llama debe validar antes.
  function aplicarJugada(estado, jugada) {
    if (!esLegal(estado, jugada)) throw new Error('Jugada ilegal: ' + JSON.stringify(jugada));
    const e = clonarEstado(estado);
    const jugador = estado.turno;
    if (jugada.tipo === 'poner') {
      e.tablero[jugada.a] = jugador;
      e.colocadas[jugador]++;
    } else {
      e.tablero[jugada.de] = 0;
      e.tablero[jugada.a] = jugador;
    }
    e.movimientos++;
    e.turno = 3 - jugador; // pasa el turno

    // 1) ¿Armó 3 en línea? (también vale al colocar)
    const linea = lineaGanadora(e.tablero, jugador);
    if (linea) {
      e.terminada = true; e.ganador = jugador; e.linea = linea; e.razon = 'linea';
      return e;
    }
    // 2) ¿Se pasó el límite de movimientos?
    if (e.movimientos >= CONFIG.MAX_MOVIMIENTOS) {
      e.terminada = true; e.razon = 'empate';
      return e;
    }
    // 3) ¿Al que le toca no le quedan jugadas? Pierde.
    if (jugadasLegales(e).length === 0) {
      e.terminada = true; e.ganador = jugador; e.razon = 'sinJugadas';
      return e;
    }
    return e;
  }

  /* ================================ IA ================================ */

  // Evaluación para hojas no terminales, desde el punto de vista de quien juega (estado.turno).
  // Idea: sumar puntos por líneas "abiertas" propias (sin fichas rivales) y restar las del rival.
  function evaluar(estado) {
    const yo = estado.turno, el = 3 - yo, t = estado.tablero;
    let s = 0;
    for (let i = 0; i < LINEAS.length; i++) {
      const L = LINEAS[i];
      let m = 0, o = 0;
      for (let k = 0; k < 3; k++) {
        const v = t[L[k]];
        if (v === yo) m++; else if (v === el) o++;
      }
      if (m > 0 && o === 0) s += (m === 2 ? 10 : 1);
      else if (o > 0 && m === 0) s -= (o === 2 ? 10 : 1);
    }
    if (t[4] === yo) s += 3; else if (t[4] === el) s -= 3; // el centro vale
    return s;
  }

  // Negamax con poda alfa-beta. Devuelve el valor desde el punto de vista de estado.turno.
  // `ctx` lleva el límite de tiempo y la cuenta de nodos; `ply` es la distancia a la raíz.
  function negamax(estado, prof, alfa, beta, ctx, ply) {
    ctx.nodos++;
    if ((ctx.nodos & 1023) === 0 && ctx.ahora() > ctx.limite) ctx.abortado = true;
    if (ctx.abortado) return 0;

    if (estado.terminada) {
      if (estado.ganador === 0) return 0; // empate
      return estado.ganador === estado.turno
        ? CONFIG.VALOR_VICTORIA - ply
        : -(CONFIG.VALOR_VICTORIA - ply);
    }
    if (prof === 0) return evaluar(estado);

    const jugadas = jugadasLegales(estado);
    let mejor = -Infinity;
    for (let i = 0; i < jugadas.length; i++) {
      const v = -negamax(aplicarJugada(estado, jugadas[i]), prof - 1, -beta, -alfa, ctx, ply + 1);
      if (ctx.abortado) return 0;
      if (v > mejor) mejor = v;
      if (v > alfa) alfa = v;
      if (alfa >= beta) break; // poda: el rival nunca dejaría llegar acá
    }
    return mejor;
  }

  // Busca en la raíz a profundidad `prof` y devuelve TODAS las jugadas con el mejor valor.
  // Para que los empates sean exactos usamos la ventana (mejor-1, +inf): como los valores
  // son enteros, todo lo que valga >= mejor se calcula exacto.
  function buscarRaiz(estado, jugadas, prof, ctx) {
    let mejorValor = -Infinity;
    let mejores = [];
    for (let i = 0; i < jugadas.length; i++) {
      const alfaRaiz = mejorValor - 1;
      const v = -negamax(aplicarJugada(estado, jugadas[i]), prof - 1, -Infinity, -alfaRaiz, ctx, 1);
      if (ctx.abortado) return null;
      if (v > mejorValor) { mejorValor = v; mejores = [jugadas[i]]; }
      else if (v === mejorValor) mejores.push(jugadas[i]);
    }
    return { valor: mejorValor, mejores };
  }

  // Elige la jugada de la compu.
  //   nivel: 'facil' | 'medio' | 'dificil'
  //   opc (opcional): { rng, ahora, tiempoMaxMs }  (para poder testear con azar controlado)
  // Usa "profundización iterativa": busca a profundidad 1, luego 2, 3... y si se acaba el
  // tiempo se queda con la última profundidad completa. Así SIEMPRE responde a tiempo.
  function elegirJugadaIA(estado, nivel, opc) {
    opc = opc || {};
    const rng = opc.rng || Math.random;
    const ahora = opc.ahora || (() => Date.now());
    const jugadas = jugadasLegales(estado);
    if (jugadas.length === 0) return null;

    // Nivel fácil: a veces juega cualquier cosa.
    const pAzar = CONFIG.PROB_AZAR[nivel] || 0;
    if (pAzar > 0 && rng() < pAzar) return jugadas[Math.floor(rng() * jugadas.length)];

    const profMax = CONFIG.PROFUNDIDAD[nivel] || 1;
    const ctx = {
      nodos: 0, abortado: false, ahora,
      limite: ahora() + (opc.tiempoMaxMs !== undefined ? opc.tiempoMaxMs : CONFIG.TIEMPO_MAX_IA_MS),
    };
    let mejores = jugadas;
    for (let d = 1; d <= profMax; d++) {
      const r = buscarRaiz(estado, jugadas, d, ctx);
      if (r === null) break;              // se acabó el tiempo: nos quedamos con la anterior
      mejores = r.mejores;
      if (r.valor >= CONFIG.VALOR_VICTORIA - 100) break; // ya encontró una victoria forzada
    }
    // Entre las jugadas igual de buenas, una al azar.
    return mejores[Math.floor(rng() * mejores.length)];
  }

  /* ============================== SESIÓN ==============================
     Una Sesión maneja UNA serie de partidas (con revanchas). Sirve para los tres modos:
       modo 'ia'     → el humano es `miJugador`, la compu juega el otro (la IA la
                       dispara la interfaz con elegirJugadaIA y llama a jugar(j, jugadorIA)).
       modo 'dos'    → dos personas en el mismo dispositivo.
       modo 'online' → miJugador = 1 (anfitrión) o 2 (invitado). Cada navegador
                       tiene su propia Sesión y se mandan mensajes JSON:
         {tipo:'hola'}                                  invitado → anfitrión, al conectar
         {tipo:'config', giratorio, giro, n}            anfitrión → invitado
         {tipo:'jugada', jugada:{tipo:'poner', a}}      cualquiera, en su turno
         {tipo:'jugada', jugada:{tipo:'mover', de, a}}
         {tipo:'revancha'}                              pedido y aceptación
     Todo lo que llega se VALIDA con las mismas reglas; si no es legal, se ignora.
     ===================================================================== */
  class Sesion {
    // opc: { modo, miJugador, enviar(msg), aleatorio(), giratorio, alEvento(ev) }
    constructor(opc) {
      opc = opc || {};
      this.modo = opc.modo || 'dos';
      this.miJugador = opc.miJugador || 1;
      // El anfitrión es quien decide los giros al azar (en local, somos nosotros mismos).
      this.esAnfitrion = this.modo !== 'online' || this.miJugador === 1;
      this.enviar = opc.enviar || function () {};
      this.aleatorio = opc.aleatorio || Math.random;
      this.giratorio = !!opc.giratorio;
      this.alEvento = opc.alEvento || function () {};
      this.inicial = 1;       // quién empieza la partida actual (alterna en cada revancha)
      this.partida = 1;       // número de partida
      this._nuevaPartida();
    }

    _nuevaPartida() {
      this.estado = crearEstado(this.inicial);
      this.rotacion = 0;           // giros de 90° acumulados del tablero (puede ser negativo)
      this.esperandoGiro = false;  // el invitado espera el giro que decide el anfitrión
      this.yoPedi = false;         // pedí revancha
      this.rivalPidio = false;     // el rival pidió revancha
    }

    _emitir(ev) { this.alEvento(ev); }

    // El anfitrión online avisa la configuración. Se llama al conectarse el invitado.
    enviarConfigInicial() {
      if (this.modo === 'online' && this.esAnfitrion) {
        // giro 0 y n 0 = "configuración inicial de la partida" (todavía no se jugó nada).
        this.enviar({ tipo: 'config', giratorio: this.giratorio, giro: 0, n: 0 });
      }
    }

    // El invitado saluda al conectarse (así el anfitrión sabe cuándo mandar la config).
    saludar() {
      if (this.modo === 'online' && !this.esAnfitrion) this.enviar({ tipo: 'hola' });
    }

    // ¿Esta persona puede jugar ahora (en este dispositivo)?
    puedeJugar() {
      if (this.estado.terminada) return false;
      if (this.modo === 'dos') return true;
      if (this.estado.turno !== this.miJugador) return false;
      if (this.modo === 'online' && this.esperandoGiro) return false;
      return true;
    }

    // Juega una jugada LOCAL (del usuario, o de la IA si se pasa `como`).
    // Devuelve true si se aplicó.
    jugar(jugada, como) {
      const quien = como || (this.modo === 'dos' ? this.estado.turno : this.miJugador);
      if (this.estado.terminada || this.estado.turno !== quien) return false;
      if (this.modo === 'online' && (quien !== this.miJugador || this.esperandoGiro)) return false;
      if (!esLegal(this.estado, jugada)) return false;
      // Primero se manda la jugada, después (si somos anfitrión) el giro: ese es el orden.
      if (this.modo === 'online') this.enviar({ tipo: 'jugada', jugada: jugada });
      this._aplicar(jugada, 'local');
      return true;
    }

    // Aplica una jugada ya validada y se ocupa del giro del tablero.
    _aplicar(jugada, origen) {
      const antes = this.estado;
      this.estado = aplicarJugada(antes, jugada);
      this._emitir({ tipo: 'jugada', jugada, jugador: antes.turno, antes, despues: this.estado, origen });
      if (this.giratorio && !this.estado.terminada) {
        if (this.esAnfitrion) {
          const giro = this.aleatorio() < 0.5 ? -1 : 1; // 90° a izquierda o derecha
          this.rotacion += giro;
          if (this.modo === 'online') {
            this.enviar({ tipo: 'config', giratorio: true, giro: giro, n: this.estado.movimientos });
          }
          this._emitir({ tipo: 'giro', giro, rotacion: this.rotacion });
        } else {
          this.esperandoGiro = true; // el invitado espera el mensaje del anfitrión
        }
      }
    }

    // Entrada de mensajes de la red. Devuelve true si el mensaje se aceptó.
    recibir(msg) {
      if (this.modo !== 'online' || !msg || typeof msg !== 'object') return false;
      switch (msg.tipo) {
        case 'hola':
          // Solo tiene sentido responder si la partida todavía no empezó.
          if (!this.esAnfitrion || this.estado.movimientos !== 0) return false;
          this.enviarConfigInicial();
          return true;
        case 'config': return this._recibirConfig(msg);
        case 'jugada': return this._recibirJugada(msg.jugada);
        case 'revancha': return this._recibirRevancha();
        default: return false;
      }
    }

    _recibirJugada(jugada) {
      const rival = 3 - this.miJugador;
      if (this.estado.terminada || this.estado.turno !== rival) return false; // no es su turno
      if (this.esperandoGiro) return false;
      if (!esLegal(this.estado, jugada)) return false; // jugada ilegal: se ignora
      // Nos quedamos solo con los campos conocidos (por si vinieran campos de más).
      const limpia = jugada.tipo === 'poner'
        ? { tipo: 'poner', a: jugada.a }
        : { tipo: 'mover', de: jugada.de, a: jugada.a };
      this._aplicar(limpia, 'remota');
      return true;
    }

    _recibirConfig(m) {
      if (this.esAnfitrion) return false; // solo el anfitrión decide; el invitado no puede mandar config
      if (typeof m.giratorio !== 'boolean') return false;
      // Configuración inicial (giro 0, al comienzo de la partida).
      if (m.giro === 0 && m.n === 0 && this.estado.movimientos === 0) {
        this.giratorio = m.giratorio;
        this._emitir({ tipo: 'config', giratorio: this.giratorio });
        return true;
      }
      // Giro después de una jugada: tiene que corresponder a la jugada que estamos esperando.
      if (this.esperandoGiro && m.giratorio === true && (m.giro === 1 || m.giro === -1) &&
          m.n === this.estado.movimientos) {
        this.esperandoGiro = false;
        this.rotacion += m.giro;
        this._emitir({ tipo: 'giro', giro: m.giro, rotacion: this.rotacion });
        return true;
      }
      return false;
    }

    // Pide revancha. En local/IA reinicia directo; online espera que el rival también la pida.
    pedirRevancha() {
      if (!this.estado.terminada || this.yoPedi) return false;
      this.yoPedi = true;
      if (this.modo === 'online') {
        this.enviar({ tipo: 'revancha' });
        if (this.rivalPidio) this._reiniciar();
        else this._emitir({ tipo: 'revancha', yoPedi: true, rivalPidio: false });
      } else {
        this._reiniciar();
      }
      return true;
    }

    _recibirRevancha() {
      if (!this.estado.terminada || this.rivalPidio) return false;
      this.rivalPidio = true;
      if (this.yoPedi) this._reiniciar();
      else this._emitir({ tipo: 'revancha', yoPedi: false, rivalPidio: true });
      return true;
    }

    // Nueva partida: empieza el OTRO jugador.
    _reiniciar() {
      this.inicial = 3 - this.inicial;
      this.partida++;
      this._nuevaPartida();
      this._emitir({ tipo: 'reinicio', inicial: this.inicial });
    }

    // Foto del estado (para comparar dos sesiones en los tests).
    instantanea() {
      return JSON.stringify({
        e: this.estado, rot: this.rotacion, ini: this.inicial, p: this.partida, g: this.giratorio,
      });
    }
  }

  return {
    CONFIG, LINEAS,
    adyacentes, crearEstado, clonarEstado, faseDe, jugadasLegales, jugadaBienFormada,
    esLegal, lineaGanadora, aplicarJugada, evaluar, elegirJugadaIA, Sesion,
  };
});
