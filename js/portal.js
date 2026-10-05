/* ============================================================
   PORTAL SEC. HACIENDA · lógica del portal
   Misma lógica que la versión anterior (check_clave → suite →
   solicitud predial → WhatsApp + guardado en segundo plano →
   consume_clave), con:
     · navegación local al instante (sin esperar al servidor);
     · botón ocupado + escudo desde el primer toque (sin doble envío);
     · tiempo límite y UN reintento solo en la lectura (check_clave) y
       solo ante falla de red; la escritura nunca se repite a ciegas;
     · una respuesta de una sesión vieja nunca pisa la nueva;
     · medios servidos desde el propio repo (cero Cloudinary).
   ============================================================ */
(function () {
  'use strict';

  /* ================== CONFIG ================== */
  var API_BASE = 'https://script.google.com/macros/s/AKfycbz-h1rD7PxKd9Vd1PUnFFIujQa-Z-9XEBmNWGKnNdGXDQFPGQK1fNaNCiKJzDdb1apDZw/exec';
  var WA_SOLICITAR_SUITE = 'https://wa.link/07wrxo';
  var WA_HACIENDA = 'https://wa.me/573015291277';
  var URL_PSE = 'https://flandes.hassqlservice.com/ImpuestosEntidadOld.aspx';
  var LIMITE_LECTURA_MS = 25000;
  var LIMITE_ESCRITURA_MS = 45000;

  /* ================== MEDICIÓN DE PANTALLA ================== */
  var MED = [];
  function medir_(ruta, t0, kb) {
    var ms = Math.round(performance.now() - t0);
    MED.push({ ruta: ruta, ms: ms, kb: kb || 0, t: Date.now() });
    if (MED.length > 50) MED.shift();
    try { console.info('[portal] ' + ruta + ' ' + ms + ' ms' + (kb ? ' · ' + kb + ' KB' : '')); } catch (e) {}
  }
  window.PORTAL_MEDICION = MED;

  /* ================== SONIDOS (del repo) ================== */
  var SOUNDS = {
    question: 'sound/pregunta.mp3',
    info: 'sound/info.mp3',
    success: 'sound/exito.mp3',
    error: 'sound/error.mp3',
    warning: 'sound/error.mp3',
    login: 'sound/entrar.mp3',
    logout: 'sound/salir.mp3',
    back: 'sound/toque.mp3',
    menu: 'sound/menu.mp3',
    wpp_inicio: 'sound/whatsapp-inicio.mp3',
    wpp_alerta: 'sound/whatsapp-alerta.mp3'
  };
  function playSoundOnce(url) {
    try { var a = new Audio(url); a.preload = 'auto'; a.play().catch(function () {}); } catch (e) {}
  }
  var autoAudio = null;
  function stopAutoAudio_() {
    try { if (autoAudio) { autoAudio.pause(); autoAudio.currentTime = 0; } } catch (_) {}
  }
  function playAutoAudio_(url) {
    try {
      stopAutoAudio_();
      if (!autoAudio) { autoAudio = new Audio(); autoAudio.preload = 'auto'; }
      autoAudio.src = url;
      var p = autoAudio.play();
      if (p && p.catch) p.catch(function () {});
    } catch (_) { /* el navegador puede bloquear el autoplay: no rompe nada */ }
  }

  /* Todas las alertas con sonido */
  if (window.Swal && typeof Swal.fire === 'function') {
    var fireOriginal = Swal.fire.bind(Swal);
    Swal.fire = function (options) {
      try {
        var icon = options && (options.icon || options.type);
        if (icon && SOUNDS[icon]) playSoundOnce(SOUNDS[icon]);
      } catch (_) {}
      return fireOriginal.apply(null, arguments);
    };
  }
  function alerta_(o) {
    if (window.Swal) return Swal.fire(o);
    window.alert((o.title || '') + (o.text ? '\n' + o.text : ''));
    return Promise.resolve({ isConfirmed: true });
  }

  /* ================== TEMA ================== */
  var raiz = document.documentElement;
  document.getElementById('ph-tema').addEventListener('click', function () {
    var t = raiz.getAttribute('data-tema') === 'oscuro' ? 'claro' : 'oscuro';
    raiz.setAttribute('data-tema', t);
    try { localStorage.setItem('portalhac.tema', t); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'oscuro' ? '#0a1c15' : '#06402B');
  });

  /* ================== CARGANDO ================== */
  var loader = document.getElementById('loader');
  var loaderTxt = document.getElementById('ph-cargando-txt');
  var loadingCount = 0, loaderTimer = null;
  function startLoading(txt) {
    loadingCount++;
    if (txt) loaderTxt.textContent = txt;
    if (loadingCount === 1) loaderTimer = setTimeout(function () { loader.hidden = false; loaderTimer = null; }, 150);
  }
  function stopLoading() {
    if (loadingCount === 0) return;
    loadingCount--;
    if (loadingCount === 0) {
      if (loaderTimer) { clearTimeout(loaderTimer); loaderTimer = null; }
      loader.hidden = true;
      loaderTxt.textContent = 'Un momento…';
    }
  }
  function ocupado_(btn, si) {
    if (!btn) return;
    if (si) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
    else { btn.removeAttribute('aria-busy'); btn.disabled = false; }
  }

  /* ================== VISTAS ================== */
  var btnAtras = document.getElementById('ph-atras');
  function showView(id) {
    var vs = document.querySelectorAll('.ph-vista');
    for (var i = 0; i < vs.length; i++) vs[i].classList.remove('activa');
    var el = document.getElementById(id);
    if (el) el.classList.add('activa');
    btnAtras.hidden = (id !== 'view-predial');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  btnAtras.addEventListener('click', function () {
    playSoundOnce(SOUNDS.back);
    showView(session.whatsappFull ? 'view-suite' : 'view-login');
  });

  /* ================== UTIL ================== */
  function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }
  function bindNumericSanitizer(id, maxLen) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      var raw = onlyDigits(el.value);
      el.value = maxLen ? raw.slice(0, maxLen) : raw;
    });
  }
  function validateTwoWords_(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean).length >= 2;
  }
  function escapeHtml_(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function openWhatsAppNoBlock_(url) {
    /* Debe correr dentro del toque del usuario o el navegador lo bloquea */
    try { return !!window.open(url, '_blank', 'noopener,noreferrer'); } catch (_) { return false; }
  }

  /* ================== ESTADO ================== */
  var session = { whatsappFull: '' };
  var sesionGen = 0;            /* sube en cada salida: respuestas viejas no pisan la nueva */
  var predialDraft = null;
  var enviando = false;

  function resetToLogin_() {
    sesionGen++;
    session.whatsappFull = '';
    predialDraft = null;
    try { resetLoginWpp_(); } catch (_) {}
    try { resetPredialForm_(); } catch (_) {}
    showView('view-login');
  }
  function goWhatsappAfterReset_(url) {
    resetToLogin_();
    window.open(url, '_blank');
  }

  /* ================== API ================== */
  function conLimite_(url, opts, ms) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).finally(function () { if (t) clearTimeout(t); });
  }
  function leerJson_(r, ruta, t0) {
    return r.text().then(function (txt) {
      medir_(ruta, t0, Math.round(txt.length / 102.4) / 10);
      try { return JSON.parse(txt); }
      catch (e) { throw new Error('El servidor no respondió como se esperaba. Intenta de nuevo.'); }
    });
  }
  /* Lectura: un reintento SOLO si falló la red (no si el servidor contestó) */
  function apiGetFromGs_(params, conCargando) {
    if (conCargando !== false) startLoading('Validando tu acceso…');
    var qs = new URLSearchParams(params || {}).toString();
    var url = API_BASE + (qs ? ('?' + qs) : '');
    var t0 = performance.now();
    function intento(n) {
      return conLimite_(url, { method: 'GET' }, LIMITE_LECTURA_MS)
        .catch(function (e) { if (n < 1) return intento(n + 1); throw e; });
    }
    return intento(0)
      .then(function (r) { return leerJson_(r, 'GET ' + (params && params.op), t0); })
      .catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('El servidor tardó demasiado. Revisa tu conexión e intenta de nuevo.');
        if (e instanceof TypeError) throw new Error('Sin conexión. Revisa tu internet e intenta de nuevo.');
        throw e;
      })
      .finally(function () { if (conCargando !== false) stopLoading(); });
  }
  /* Escritura: nunca se reintenta (no se duplica la solicitud) */
  function apiPostToGs_(body) {
    var t0 = performance.now();
    return conLimite_(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }, LIMITE_ESCRITURA_MS).then(function (r) { return leerJson_(r, 'POST solicitud', t0); });
  }

  /* ================== PAÍS Y WHATSAPP ================== */
  var COUNTRIES = [
    { name: 'Colombia 🇨🇴', code: '57', nationalLen: 10 },
    { name: 'Estados Unidos 🇺🇸', code: '1', nationalLen: 10 },
    { name: 'España 🇪🇸', code: '34', nationalLen: 9 },
    { name: 'Portugal 🇵🇹', code: '351', nationalLen: 9 },
    { name: 'Argentina 🇦🇷', code: '54', nationalLen: 10 },
    { name: 'Bolivia 🇧🇴', code: '591', nationalLen: 8 },
    { name: 'Brasil 🇧🇷', code: '55', nationalLen: 11 },
    { name: 'Chile 🇨🇱', code: '56', nationalLen: 9 },
    { name: 'Costa Rica 🇨🇷', code: '506', nationalLen: 8 },
    { name: 'Cuba 🇨🇺', code: '53', nationalLen: 8 },
    { name: 'República Dominicana 🇩🇴', code: '1', nationalLen: 10 },
    { name: 'Ecuador 🇪🇨', code: '593', nationalLen: 9 },
    { name: 'El Salvador 🇸🇻', code: '503', nationalLen: 8 },
    { name: 'Guatemala 🇬🇹', code: '502', nationalLen: 8 },
    { name: 'Honduras 🇭🇳', code: '504', nationalLen: 8 },
    { name: 'México 🇲🇽', code: '521', nationalLen: 10 },
    { name: 'Nicaragua 🇳🇮', code: '505', nationalLen: 8 },
    { name: 'Panamá 🇵🇦', code: '507', nationalLen: 8 },
    { name: 'Paraguay 🇵🇾', code: '595', nationalLen: 9 },
    { name: 'Perú 🇵🇪', code: '51', nationalLen: 9 },
    { name: 'Uruguay 🇺🇾', code: '598', nationalLen: 8 },
    { name: 'Venezuela 🇻🇪', code: '58', nationalLen: 10 },
    { name: 'Italia 🇮🇹', code: '39', nationalLen: 10 },
    { name: 'Reino Unido 🇬🇧', code: '44', nationalLen: 10 },
    { name: 'Alemania 🇩🇪', code: '49', nationalLen: 11 }
  ];
  var choicesPaisLogin = null, choicesBarrio = null;

  function getCountryByCode_(code) {
    for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i].code === String(code || '')) return COUNTRIES[i];
    return null;
  }
  function initPaisLoginChoicesOnce_() {
    var sel = document.getElementById('pais-login');
    if (!sel || choicesPaisLogin) return;
    sel.innerHTML = '';
    var ph = new Option('Selecciona tu país', '', true, true); ph.disabled = true; sel.appendChild(ph);
    COUNTRIES.forEach(function (c) { sel.appendChild(new Option(c.name + ' (' + c.code + ')', c.code)); });
    if (window.Choices) {
      choicesPaisLogin = new Choices(sel, { searchEnabled: true, itemSelectText: '', shouldSort: false, searchPlaceholderValue: 'Buscar país' });
    }
  }
  function setWppLoginUIForCountry_(country) {
    var pref = document.getElementById('prefijo-login');
    var hint = document.getElementById('wpp-hint-login');
    var wpp = document.getElementById('whatsapp-login');
    pref.value = country ? country.code : '';
    if (country) {
      hint.innerHTML = 'Indicativo <b>' + country.code + '</b> + número nacional de <b>' + country.nationalLen + '</b> dígitos.';
      wpp.value = onlyDigits(wpp.value).slice(0, country.nationalLen);
      wpp.setAttribute('maxlength', String(country.nationalLen));
    } else {
      hint.textContent = '';
      wpp.removeAttribute('maxlength');
    }
  }
  function resetLoginWpp_() {
    initPaisLoginChoicesOnce_();
    try {
      if (choicesPaisLogin) { choicesPaisLogin.removeActiveItems(); choicesPaisLogin.setChoiceByValue(''); }
      else document.getElementById('pais-login').value = '';
    } catch (_) { document.getElementById('pais-login').value = ''; }
    document.getElementById('whatsapp-login').value = '';
    setWppLoginUIForCountry_(null);
  }

  (function () {
    var el = document.getElementById('whatsapp-login');
    function maxLen() {
      var c = getCountryByCode_(document.getElementById('pais-login').value);
      return c ? c.nationalLen : 15;
    }
    /* Pegar: toma los últimos N dígitos (el número con indicativo cabe) */
    el.addEventListener('paste', function (e) {
      e.preventDefault();
      var raw = onlyDigits((e.clipboardData || window.clipboardData).getData('text'));
      var n = maxLen();
      el.value = raw.length > n ? raw.slice(-n) : raw;
    });
    el.addEventListener('input', function () {
      var raw = onlyDigits(el.value), n = maxLen();
      el.value = raw.length > n ? raw.slice(0, n) : raw;
    });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') document.getElementById('btn-login').click(); });
  })();

  document.getElementById('pais-login').addEventListener('change', function () {
    setWppLoginUIForCountry_(getCountryByCode_(document.getElementById('pais-login').value));
  });

  /* ================== INGRESO ================== */
  var btnLogin = document.getElementById('btn-login');
  btnLogin.addEventListener('click', function () {
    if (btnLogin.getAttribute('aria-busy') === 'true') return;
    var country = getCountryByCode_(document.getElementById('prefijo-login').value && document.getElementById('pais-login').value);
    if (!country) { alerta_({ icon: 'info', title: 'SELECCIONA TU PAÍS' }); return; }

    var national = onlyDigits(document.getElementById('whatsapp-login').value);
    if (national.length !== country.nationalLen) {
      alerta_({ icon: 'error', title: 'WhatsApp inválido', text: 'Para ' + country.name + ' debes ingresar ' + country.nationalLen + ' dígitos (sin indicativo).' });
      return;
    }
    var whatsappFull = country.code + national;
    var gen = sesionGen;
    var t0 = performance.now();
    ocupado_(btnLogin, true);

    apiGetFromGs_({ op: 'check_clave', whatsapp: whatsappFull })
      .then(function (claveRes) {
        if (gen !== sesionGen) return;                    /* sesión vieja: se ignora */
        if (String(claveRes && claveRes.status || '').toLowerCase() !== 'success') {
          throw new Error((claveRes && claveRes.message) || 'No fue posible validar el acceso');
        }
        if (!claveRes.exists) {
          return alerta_({
            icon: 'info',
            title: 'Debes solicitar esta Suite desde nuestro WhatsApp Oficial',
            text: 'Toca el botón',
            showCancelButton: true,
            confirmButtonText: 'Ir a WhatsApp',
            cancelButtonText: 'Cerrar',
            didOpen: function () { playAutoAudio_(SOUNDS.wpp_alerta); }
          }).then(function (r) {
            if (r.isConfirmed) { playSoundOnce(SOUNDS.back); goWhatsappAfterReset_(WA_SOLICITAR_SUITE); }
          });
        }
        session.whatsappFull = whatsappFull;
        stopAutoAudio_();
        playSoundOnce(SOUNDS.login);
        showView('view-suite');
        medir_('pantalla ingreso→suite', t0);
      })
      .catch(function (e) {
        if (gen !== sesionGen) return;
        alerta_({ icon: 'error', title: 'Error', text: String(e && e.message || e) });
      })
      .finally(function () { ocupado_(btnLogin, false); });
  });

  /* ================== SUITE ================== */
  document.getElementById('btn-logout').addEventListener('click', function () {
    playSoundOnce(SOUNDS.logout);
    resetToLogin_();
  });

  function initBarrioChoices_() {
    if (choicesBarrio || !window.Choices) return;
    var el = document.getElementById('barrio');
    if (el) choicesBarrio = new Choices(el, { searchEnabled: true, itemSelectText: '', shouldSort: false, searchPlaceholderValue: 'Buscar barrio, vereda o conjunto' });
  }

  document.getElementById('btn-go-predial').addEventListener('click', function () {
    playSoundOnce(SOUNDS.back);
    initBarrioChoices_();
    resetPredialForm_();
    showView('view-predial');
  });

  document.getElementById('btn-go-pse').addEventListener('click', function () {
    playSoundOnce(SOUNDS.back);
    window.open(URL_PSE, '_blank', 'noopener,noreferrer');
    resetToLogin_();
  });

  /* ================== PREDIAL ================== */
  bindNumericSanitizer('documento', 10);
  bindNumericSanitizer('codigo', 30);

  function resetPredialForm_() {
    ['documento', 'nombre', 'codigo', 'solicitud'].forEach(function (id) { document.getElementById(id).value = ''; });
    try {
      if (choicesBarrio) { choicesBarrio.removeActiveItems(); choicesBarrio.setChoiceByValue(''); }
      else document.getElementById('barrio').value = '';
    } catch (_) { document.getElementById('barrio').value = ''; }
  }

  document.getElementById('btn-predial-cancelar').addEventListener('click', function () {
    playSoundOnce(SOUNDS.back);
    resetToLogin_();
  });

  var btnGuardar = document.getElementById('btn-predial-guardar');
  btnGuardar.addEventListener('click', function () {
    if (enviando || btnGuardar.getAttribute('aria-busy') === 'true') return;   /* escudo anti doble envío */

    if (!session.whatsappFull) {
      alerta_({ icon: 'warning', title: 'Sesión inválida', text: 'Debes iniciar sesión nuevamente.' })
        .then(function () { playSoundOnce(SOUNDS.back); resetToLogin_(); });
      return;
    }

    var documento = onlyDigits(document.getElementById('documento').value);
    var nombre = String(document.getElementById('nombre').value || '').trim();
    var barrio = String(document.getElementById('barrio').value || '').trim();
    var codigo = onlyDigits(document.getElementById('codigo').value);
    var solicitud = String(document.getElementById('solicitud').value || '').trim();

    if (documento.length < 6 || documento.length > 10) { alerta_({ icon: 'warning', title: 'Documento/NIT inválido', text: 'Debe tener entre 6 y 10 dígitos.' }); return; }
    if (!validateTwoWords_(nombre)) { alerta_({ icon: 'warning', title: 'Nombre inválido', text: 'Debe contener mínimo 2 palabras.' }); return; }
    if (!barrio) { alerta_({ icon: 'warning', title: 'Ubicación requerida', text: 'Selecciona el barrio, vereda o conjunto.' }); return; }
    if (codigo && (codigo.length < 14 || codigo.length > 30)) { alerta_({ icon: 'error', title: 'Código catastral inválido', text: 'Debe tener entre 14 y 30 dígitos.' }); return; }

    predialDraft = { documento: documento, nombre: nombre, barrio: barrio, codigo: codigo, solicitud: solicitud, whatsappFull: session.whatsappFull };

    var resumenHtml =
      '<div class="ph-resumen">' +
      '<div><b>NOMBRE O RAZÓN SOCIAL</b><span>' + escapeHtml_(predialDraft.nombre) + '</span></div>' +
      '<div><b>DOCUMENTO / NIT</b><span>' + escapeHtml_(predialDraft.documento) + '</span></div>' +
      '<div><b>UBICACIÓN DEL PREDIO</b><span>' + escapeHtml_(predialDraft.barrio) + '</span></div>' +
      '<div><b>CÓDIGO CATASTRAL</b><span>' + escapeHtml_(predialDraft.codigo || 'No suministrado') + '</span></div>' +
      '<div><b>SOLICITUD</b><span>' + escapeHtml_(predialDraft.solicitud || 'No suministrado') + '</span></div>' +
      '<div><b>WHATSAPP</b><span>' + escapeHtml_(predialDraft.whatsappFull) + '</span></div>' +
      '</div>';

    alerta_({
      icon: 'info',
      title: 'Confirma tu solicitud',
      html: resumenHtml,
      showCancelButton: true,
      confirmButtonText: 'Enviar',
      cancelButtonText: 'Corregir'
    }).then(function (r) {
      if (!r.isConfirmed) { playSoundOnce(SOUNDS.back); return; }
      if (enviando) return;
      enviando = true;
      ocupado_(btnGuardar, true);

      var payload = {
        nombre: predialDraft.nombre,
        documento: predialDraft.documento,
        barrio: predialDraft.barrio,
        whatsapp: predialDraft.whatsappFull,
        codigo: predialDraft.codigo ? predialDraft.codigo : 'N/A',
        solicitud: predialDraft.solicitud ? predialDraft.solicitud : 'Recibo de impuesto predial'
      };

      /* WhatsApp se abre YA, dentro del toque, para que no lo bloquee el navegador */
      openWhatsAppNoBlock_(WA_HACIENDA);

      startLoading('Enviando tu solicitud…');
      var t0 = performance.now();
      apiPostToGs_(payload)
        .then(function (res) {
          if (String(res && res.status || '').toLowerCase() !== 'success') throw new Error((res && res.message) || 'Error guardando');
          medir_('guardado solicitud', t0);
          if (res.pending) return;                                 /* ya tenía una pendiente */
          /* Consumir CLAVE en segundo plano: no bloquea al usuario */
          apiGetFromGs_({ op: 'consume_clave', whatsapp: payload.whatsapp }, false).catch(function () {});
        })
        .catch(function (e) {
          var msg = (e && e.name === 'AbortError') ? 'El servidor tardó demasiado. Escríbenos por WhatsApp para confirmar tu solicitud.' : String(e && e.message || e);
          return alerta_({ icon: 'error', title: 'Error', text: msg }).catch(function () {});
        })
        .finally(function () {
          stopLoading();
          enviando = false;
          ocupado_(btnGuardar, false);
          predialDraft = null;
          resetToLogin_();
        });
    });
  });

  /* ================== FIRMA ANIMADA: solo corre cuando se ve ================== */
  (function () {
    var v = document.querySelector('.ph-placa__video');
    if (!v) return;
    if (!('IntersectionObserver' in window)) { v.preload = 'auto'; v.play().catch(function () {}); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { if (v.preload === 'none') v.preload = 'auto'; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    }, { rootMargin: '120px' }).observe(v);
  })();

  /* ================== VERSIÓN EN EL PIE ================== */
  try { document.getElementById('ph-version').textContent = 'v' + (window.APP_VERSION || ''); } catch (e) {}

  /* ================== ARRANQUE ================== */
  initPaisLoginChoicesOnce_();
  resetLoginWpp_();
  /* El barrio se arma al entrar a la solicitud (no estorba el primer pintado) */
  if ('requestIdleCallback' in window) requestIdleCallback(initBarrioChoices_, { timeout: 2500 });
  else setTimeout(initBarrioChoices_, 1200);

  window.addEventListener('load', function () {
    playAutoAudio_(SOUNDS.wpp_inicio);
    medir_('carga del portal (load)', 0);
  });

  /* ================== SERVICE WORKER (modo fresco) ================== */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});
    });
  }
})();
