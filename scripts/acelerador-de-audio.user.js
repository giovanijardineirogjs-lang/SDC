// ==UserScript==
// @name         Salesforce - Velocidade de Áudio
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Adiciona botões de velocidade (1x, 1.5x, 2x, 3x) aos áudios/vídeos no Salesforce
// @match        https://*.lightning.force.com/*
// @match        https://*.my.salesforce.com/*
// @match        https://*.salesforce.com/*
// @match        https://*.force.com/*
// @match        https://*.visualforce.com/*
// @match        https://*.salesforce-setup.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SPEEDS = [1, 1.5, 2, 3];
  const STORAGE_KEY = 'sf_audio_speed';
  const BAR_ATTR = 'data-sf-speed-bar';

  let currentSpeed = Number(GM_getValue(STORAGE_KEY, 1)) || 1;
  if (!SPEEDS.includes(currentSpeed)) currentSpeed = 1;

  const bars = new Set();       // todas as barras criadas
  const mediaBars = new WeakMap(); // media -> barra

  // ---------- Estilo dos botões ----------
  const BAR_STYLE = [
    'display:inline-flex',
    'gap:4px',
    'align-items:center',
    'margin:4px 0 4px 6px',
    'vertical-align:middle',
    'font-family:inherit',
  ].join(';');

  function btnStyle(active) {
    return [
      'cursor:pointer',
      'border:1px solid #0176d3',
      'border-radius:12px',
      'padding:1px 8px',
      'font-size:12px',
      'line-height:18px',
      'font-weight:600',
      active ? 'background:#0176d3' : 'background:#fff',
      active ? 'color:#fff' : 'color:#0176d3',
    ].join(';');
  }

  function label(speed) {
    return speed + 'x';
  }

  // ---------- Aplicar velocidade ----------
  function applySpeed(media, speed) {
    try {
      media.defaultPlaybackRate = speed;
      media.playbackRate = speed;
      media.preservesPitch = true;
      media.mozPreservesPitch = true;
      media.webkitPreservesPitch = true;
    } catch (e) { /* ignora */ }
  }

  function refreshBars() {
    bars.forEach((bar) => {
      if (!bar.isConnected) { bars.delete(bar); return; }
      bar.querySelectorAll('button').forEach((b) => {
        b.setAttribute('style', btnStyle(Number(b.dataset.speed) === currentSpeed));
      });
    });
  }

  function setSpeed(speed) {
    currentSpeed = speed;
    GM_setValue(STORAGE_KEY, speed);
    refreshBars();
    forEachMedia((m) => applySpeed(m, speed));
  }

  // ---------- Criação da barra ----------
  function createBar() {
    const bar = document.createElement('span');
    bar.setAttribute(BAR_ATTR, '1');
    bar.setAttribute('style', BAR_STYLE);

    SPEEDS.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label(s);
      b.dataset.speed = s;
      b.title = 'Velocidade ' + label(s);
      b.setAttribute('style', btnStyle(s === currentSpeed));
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setSpeed(s);
      });
      bar.appendChild(b);
    });

    bars.add(bar);
    return bar;
  }

  // ---------- Busca de mídia (inclui Shadow DOM abertos) ----------
  function collectMedia(root, out) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('audio, video').forEach((m) => out.push(m));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectMedia(el.shadowRoot, out);
    });
  }

  function forEachMedia(fn) {
    const list = [];
    collectMedia(document, list);
    list.forEach(fn);
  }

  function setupMedia(media) {
    // Garante que a velocidade é reaplicada quando o Salesforce recarrega/troca o src
    if (!media.dataset.sfSpeedBound) {
      media.dataset.sfSpeedBound = '1';
      ['loadedmetadata', 'loadeddata', 'play', 'playing', 'emptied'].forEach((evt) => {
        media.addEventListener(evt, () => {
          if (media.playbackRate !== currentSpeed) applySpeed(media, currentSpeed);
        });
      });
      // Se algo mudar a velocidade por fora, reaplica
      media.addEventListener('ratechange', () => {
        if (media.playbackRate !== currentSpeed) applySpeed(media, currentSpeed);
      });
    }

    applySpeed(media, currentSpeed);

    // Insere (ou reinsere, se o Lightning re-renderizou) a barra
    const existing = mediaBars.get(media);
    if (existing && existing.isConnected) return;

    const bar = createBar();
    mediaBars.set(media, bar);
    if (media.parentNode) {
      media.parentNode.insertBefore(bar, media.nextSibling);
    }
  }

  function scan() {
    forEachMedia(setupMedia);
  }

  // ---------- Execução ----------
  let timer = null;
  function scheduleScan() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 300);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Reforço periódico (cobre Shadow DOM e re-renderizações do Lightning)
  setInterval(scan, 2000);
  scan();
})();