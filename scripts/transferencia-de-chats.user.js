// ==UserScript==
// @name         Einstein - Painel Unificado (Respostas Rápidas + Registro de Chats + Transferência)
// @namespace    https://tampermonkey.net/
// @version      3.4.0
// @description  Janela única com três abas: Respostas Rápidas, Registro de Chats (Protocolo + CPF + Tratativa) e Transferência automática para a fila no Salesforce.
// @match        https://*.lightning.force.com/*
// @match        https://*.salesforce.com/*
// @match        https://*.force.com/*
// @match        https://*.sde.einstein.br/index.php?/*
// @match        https://*.sde.einstein.br/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // A aba "Respostas" só faz sentido no Salesforce (o Registro também roda no SDE)
  const IS_SALESFORCE = /(^|\.)(salesforce|force)\.com$/i.test(location.hostname);

  /* =====================================================================
   *  CONFIGURAÇÕES DO REGISTRO (ajuste aqui se o Salesforce mudar o HTML)
   * ===================================================================== */
  const CONFIG = {
    // Formato do protocolo (ex.: MS-01815030)
    protocoloRegex: /\b(MS-\d+)\b/i,

    // Seletores onde o título (protocolo) da aba ATIVA costuma aparecer.
    // O primeiro que encontrar um "MS-xxxxxxx" visível é usado.
    seletoresAbaAtiva: [
      '.oneConsoleTab.slds-is-active .title',
      'li.slds-is-active .title',
      '.tabItem.slds-is-active .title',
      '.slds-tabs_default__item.slds-is-active .title',
      '[aria-selected="true"] .title',
    ],

    // Seletor geral dos títulos (usado como alternativa)
    seletorTitulo: 'span.title.slds-truncate',

    // Elementos onde o CPF aparece dentro do chat
    seletorMensagemCPF: 'p',

    // Intervalo de verificação automática (ms)
    intervaloScan: 2000,

    // Qual CPF usar caso existam vários na conversa: 'ultimo' ou 'primeiro'
    escolhaCPF: 'ultimo',
  };

  const hooks = {}; // ganchos preenchidos por módulos definidos mais abaixo (ex.: aba Transferir)

  const KEY_DATA = 'sfchat_entries_v1';
  const KEY_UI = 'sfchat_ui_v1';

  /* =====================================================================
   *  Armazenamento
   * ===================================================================== */
  const load = (key, def) => {
    try {
      const v = GM_getValue(key);
      return v ? JSON.parse(v) : def;
    } catch (e) {
      return def;
    }
  };
  const save = (key, val) => {
    try {
      GM_setValue(key, JSON.stringify(val));
    } catch (e) {
      console.warn('[Painel Einstein] erro ao salvar', e);
    }
  };

  // Garante uma única instância do script (evita painéis/intervalos duplicados
  // caso o script seja reinstalado/atualizado sem recarregar a página)
  const TOKEN = String(Date.now()) + Math.random();
  document.documentElement.dataset.sfchatToken = TOKEN;
  const oldHost = document.getElementById('sfchat-host');
  if (oldHost) oldHost.remove();
  const isAtiva = () => document.documentElement.dataset.sfchatToken === TOKEN;

  const normProto = (p) => String(p || '').trim().toUpperCase();

  // Remove duplicados: 1 registro por protocolo (mescla CPF e tratativa se houver)
  function dedupe(list) {
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach((e) => {
      const key = normProto(e && e.protocol);
      if (!key) return;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, Object.assign({ cpf: '', note: '', createdAt: Date.now() }, e, { protocol: key }));
        return;
      }
      if (!cur.cpf && e.cpf) cur.cpf = e.cpf;
      if (e.note && !(cur.note || '').includes(e.note)) {
        cur.note = cur.note ? cur.note + '\n' + e.note : e.note;
      }
    });
    return [...map.values()];
  }

  let entries = dedupe(load(KEY_DATA, []));
  let ui = Object.assign(
    { left: null, top: 110, width: 380, height: 520, minimized: false, tab: IS_SALESFORCE ? 'msgs' : 'reg' },
    load(KEY_UI, {})
  );
  if (!IS_SALESFORCE) ui.tab = 'reg';
  let activeProtocol = null;

  /* =====================================================================
   *  Utilitários
   * ===================================================================== */
  const isVisible = (el) => {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };

  const validaCPF = (raw) => {
    const d = raw.replace(/\D/g, '');
    if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    const calc = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += parseInt(d[i], 10) * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return calc(9) === parseInt(d[9], 10) && calc(10) === parseInt(d[10], 10);
  };

  const copiar = (texto) => {
    try {
      GM_setClipboard(texto, 'text');
    } catch (e) {
      navigator.clipboard && navigator.clipboard.writeText(texto);
    }
  };

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  };

  /* =====================================================================
   *  Captura de dados no Salesforce (Registro)
   * ===================================================================== */
  function getProtocoloAtivo() {
    // 1) Aba ativa
    for (const sel of CONFIG.seletoresAbaAtiva) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (!isVisible(el)) continue;
        const m = (el.textContent || '').match(CONFIG.protocoloRegex);
        if (m) return m[1].toUpperCase();
      }
    }
    // 2) Alternativa: só aceita se houver exatamente 1 título visível com protocolo
    const achados = new Set();
    document.querySelectorAll(CONFIG.seletorTitulo).forEach((el) => {
      if (!isVisible(el)) return;
      const m = (el.textContent || '').match(CONFIG.protocoloRegex);
      if (m) achados.add(m[1].toUpperCase());
    });
    return achados.size === 1 ? [...achados][0] : null;
  }

  function getCPFVisivel() {
    const re = /^\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\s*$/;
    const candidatos = [];
    document.querySelectorAll(CONFIG.seletorMensagemCPF).forEach((p) => {
      if (!isVisible(p)) return;
      const m = (p.textContent || '').match(re);
      if (m) candidatos.push(m[1]);
    });
    if (!candidatos.length) return null;

    const validos = candidatos.filter(validaCPF);
    const lista = validos.length ? validos : candidatos;
    return CONFIG.escolhaCPF === 'primeiro' ? lista[0] : lista[lista.length - 1];
  }

  /* =====================================================================
   *  JANELA ÚNICA (Shadow DOM para não conflitar com o CSS do Salesforce)
   * ===================================================================== */
  const host = h('div', { id: 'sfchat-host' });
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;';
  const root = host.attachShadow({ mode: 'open' });

  const style = h('style', {});
  style.textContent = `
    * { box-sizing: border-box; font-family: "Segoe UI", Arial, sans-serif; }
    .panel {
      position: fixed; display: flex; flex-direction: column;
      background: #fff; color: #222; border: 1px solid #b8c4d6;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.28);
      overflow: hidden; resize: both; min-width: 300px; min-height: 120px;
      font-size: 13px;
    }
    .panel.min { resize: none; height: auto !important; min-height: 0; }
    .header {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      background: #0b5cab; color: #fff; cursor: move; user-select: none; flex: none;
    }
    .header .title { flex: 1; font-weight: 600; font-size: 13px; }
    .hbtn {
      background: rgba(255,255,255,.18); color: #fff; border: 0; border-radius: 4px;
      width: 24px; height: 24px; cursor: pointer; font-size: 14px; line-height: 1;
    }
    .hbtn:hover { background: rgba(255,255,255,.35); }

    /* ----- Abas ----- */
    .tabs { display: flex; background: #eaf0f8; border-bottom: 1px solid #c9d3df; flex: none; }
    .tab {
      flex: 1; border: 0; background: transparent; padding: 8px 6px; cursor: pointer;
      font-size: 12px; font-weight: 600; color: #44546a; border-bottom: 3px solid transparent;
    }
    .tab:hover { background: #dde8f5; }
    .tab.on { color: #0b5cab; background: #fff; border-bottom-color: #0b5cab; }
    .tab .count {
      background: #0b5cab; color: #fff; border-radius: 10px;
      padding: 1px 7px; font-size: 11px; margin-left: 4px;
    }
    .pane { display: none; flex: 1 1 auto; min-height: 0; flex-direction: column; }
    .pane.on { display: flex; }
    .panel.min .tabs, .panel.min .pane { display: none; }

    /* ----- Registro de Chats ----- */
    .body { flex: 1; overflow-y: auto; padding: 8px; background: #f3f5f9; }
    .empty { text-align: center; color: #667; padding: 24px 8px; font-size: 12px; }
    .card {
      background: #fff; border: 1px solid #d5dce8; border-left: 4px solid #9aa8bf;
      border-radius: 8px; padding: 8px; margin-bottom: 8px;
    }
    .card.active { border-left-color: #2e844a; box-shadow: 0 0 0 2px rgba(46,132,74,.18); }
    .row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .lbl { width: 62px; font-size: 11px; font-weight: 600; color: #556; flex: none; }
    .row input {
      flex: 1; min-width: 0; padding: 4px 6px; border: 1px solid #c3cddd;
      border-radius: 4px; font-size: 13px;
    }
    .badge {
      font-size: 10px; background: #2e844a; color: #fff; border-radius: 8px;
      padding: 1px 6px; margin-left: 6px; display: none;
    }
    .card.active .badge { display: inline-block; }
    .proto { font-weight: 700; color: #0b5cab; flex: 1; font-size: 13px; }
    .mini {
      border: 1px solid #c3cddd; background: #f7f9fc; border-radius: 4px;
      padding: 2px 7px; cursor: pointer; font-size: 11px; color: #334;
    }
    .mini:hover { background: #e6edf7; }
    .mini.del:hover { background: #fde3e3; border-color: #e0a0a0; }
    textarea {
      width: 100%; min-height: 70px; resize: vertical; padding: 6px;
      border: 1px solid #c3cddd; border-radius: 4px; font-size: 13px;
    }
    textarea:focus, .row input:focus { outline: 2px solid #8ab8ea; border-color: #8ab8ea; }
    .footer {
      display: flex; gap: 6px; padding: 8px; background: #fff;
      border-top: 1px solid #d5dce8; flex: none;
    }
    .fbtn {
      flex: 1; padding: 6px; border-radius: 5px; border: 1px solid #c3cddd;
      background: #f7f9fc; cursor: pointer; font-size: 12px;
    }
    .fbtn:hover { background: #e6edf7; }
    .fbtn.danger:hover { background: #fde3e3; }
  `;
  root.appendChild(style);

  const countEl = h('span', { class: 'count', text: '0' });
  const btnMin = h('button', { class: 'hbtn', title: 'Minimizar / Restaurar', text: '–' });
  const header = h(
    'div',
    { class: 'header' },
    h('span', { class: 'title', text: '🏥 Suporte Einstein' }),
    btnMin
  );

  // Abas (mousedown preventDefault mantém o foco na caixa de mensagem do chat)
  const tabMsgs = h('button', { class: 'tab', text: '💬 Respostas' });
  const tabReg = h('button', { class: 'tab' }, '📋 Registro', countEl);
  const tabTf = h('button', { class: 'tab', text: '🔁 Transferir' });
  [tabMsgs, tabReg, tabTf].forEach((t) => t.addEventListener('mousedown', (e) => e.preventDefault()));
  const tabsBar = h('div', { class: 'tabs' }, IS_SALESFORCE ? tabMsgs : null, tabReg, IS_SALESFORCE ? tabTf : null);
  if (!IS_SALESFORCE) tabsBar.style.display = 'none';

  const listEl = h('div', { class: 'body' });
  const btnCopyAll = h('button', { class: 'fbtn', text: '📄 Copiar tudo' });
  const btnClear = h('button', { class: 'fbtn danger', text: '🗑 Limpar tudo' });
  const footer = h('div', { class: 'footer' }, btnCopyAll, btnClear);
  const paneReg = h('div', { class: 'pane' }, listEl, footer);
  const paneMsgs = h('div', { class: 'pane' });
  const paneTf = h('div', { class: 'pane' });

  const panel = h('div', { class: 'panel' }, header, tabsBar, paneMsgs, paneReg, paneTf);
  root.appendChild(panel);

  /* ---------- Posição / tamanho ---------- */
  function aplicaLayout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (ui.left === null) ui.left = Math.max(10, vw - ui.width - 20);
    ui.width = Math.min(Math.max(ui.width, 300), vw - 10);
    ui.height = Math.min(Math.max(ui.height, 120), vh - 10);
    ui.left = Math.min(Math.max(ui.left, 0), vw - 100);
    ui.top = Math.min(Math.max(ui.top, 0), vh - 40);

    panel.style.left = ui.left + 'px';
    panel.style.top = ui.top + 'px';
    panel.style.width = ui.width + 'px';
    if (!ui.minimized) panel.style.height = ui.height + 'px';
    panel.classList.toggle('min', ui.minimized);
    btnMin.textContent = ui.minimized ? '□' : '–';
  }
  const saveUI = debounce(() => save(KEY_UI, ui), 300);

  /* ---------- Troca de aba ---------- */
  function setTab(t) {
    if ((t === 'msgs' || t === 'tf') && !IS_SALESFORCE) t = 'reg';
    ui.tab = t;
    tabMsgs.classList.toggle('on', t === 'msgs');
    tabReg.classList.toggle('on', t === 'reg');
    tabTf.classList.toggle('on', t === 'tf');
    paneMsgs.classList.toggle('on', t === 'msgs');
    paneReg.classList.toggle('on', t === 'reg');
    paneTf.classList.toggle('on', t === 'tf');
    saveUI();
    if (t === 'tf' && typeof hooks.tfRefresh === 'function') hooks.tfRefresh(true);
  }
  tabMsgs.addEventListener('click', () => setTab('msgs'));
  tabReg.addEventListener('click', () => setTab('reg'));
  tabTf.addEventListener('click', () => setTab('tf'));

  // Arrastar
  let drag = null;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - ui.left, dy: e.clientY - ui.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    ui.left = e.clientX - drag.dx;
    ui.top = e.clientY - drag.dy;
    aplicaLayout();
  });
  window.addEventListener('mouseup', () => {
    if (drag) {
      drag = null;
      saveUI();
    }
  });

  // Redimensionar (resize nativo do CSS + observer para guardar o tamanho)
  new ResizeObserver(() => {
    if (ui.minimized) return;
    const r = panel.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      ui.width = Math.round(r.width);
      ui.height = Math.round(r.height);
      saveUI();
    }
  }).observe(panel);

  // Minimizar
  btnMin.addEventListener('click', () => {
    ui.minimized = !ui.minimized;
    aplicaLayout();
    saveUI();
  });
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    ui.minimized = !ui.minimized;
    aplicaLayout();
    saveUI();
  });

  /* =====================================================================
   *  ABA REGISTRO DE CHATS
   * ===================================================================== */

  /* ---------- Cards de cada chat ---------- */
  const cards = new Map(); // protocolo -> { card, cpfInput, noteTA }
  const persist = () => save(KEY_DATA, entries);
  const persistDebounced = debounce(persist, 300);

  function atualizaContador() {
    countEl.textContent = String(entries.length);
    let empty = listEl.querySelector('.empty');
    if (!entries.length) {
      if (!empty) {
        listEl.appendChild(
          h('div', {
            class: 'empty',
            text: 'Nenhum chat registrado ainda. Clique em um chat no Salesforce para capturar o Protocolo e o CPF.',
          })
        );
      }
    } else if (empty) {
      empty.remove();
    }
  }

  function criaCard(entry) {
    const cpfInput = h('input', { type: 'text', placeholder: 'CPF (não encontrado)' });
    cpfInput.value = entry.cpf || '';
    cpfInput.addEventListener('input', () => {
      entry.cpf = cpfInput.value.trim();
      persistDebounced();
    });

    const noteTA = h('textarea', { placeholder: 'Descreva a tratativa realizada neste chat...' });
    noteTA.value = entry.note || '';
    noteTA.addEventListener('input', () => {
      entry.note = noteTA.value;
      persistDebounced();
    });

    const btnCopyProto = h('button', { class: 'mini', title: 'Copiar protocolo', text: 'Copiar' });
    btnCopyProto.addEventListener('click', () => copiar(entry.protocol));

    const btnCopyCpf = h('button', { class: 'mini', title: 'Copiar CPF', text: 'Copiar' });
    btnCopyCpf.addEventListener('click', () => copiar((cpfInput.value || '').replace(/\D/g, '')));

    const btnDel = h('button', { class: 'mini del', title: 'Remover este chat', text: '✕' });
    btnDel.addEventListener('click', () => {
      if (!confirm('Remover o registro ' + entry.protocol + '?')) return;
      entries = entries.filter((e) => e !== entry);
      const c = cards.get(entry.protocol);
      if (c) c.card.remove();
      cards.delete(entry.protocol);
      persist();
      atualizaContador();
    });

    const card = h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'proto', text: entry.protocol }),
        h('span', { class: 'badge', text: 'ativo' }),
        btnCopyProto,
        btnDel
      ),
      h('div', { class: 'row' }, h('span', { class: 'lbl', text: 'CPF' }), cpfInput, btnCopyCpf),
      h('div', { class: 'lbl', text: 'Tratativa' }),
      noteTA
    );

    cards.set(entry.protocol, { card, cpfInput, noteTA });
    return card;
  }

  function renderTudo() {
    cards.forEach((c) => c.card.remove());
    cards.clear();
    entries.forEach((e) => listEl.appendChild(criaCard(e)));
    atualizaContador();
    marcaAtivo();
  }

  function marcaAtivo() {
    cards.forEach((c, proto) => c.card.classList.toggle('active', proto === activeProtocol));
  }

  /* ---------- Botões do rodapé ---------- */
  btnCopyAll.addEventListener('click', () => {
    if (!entries.length) return;
    const txt = entries
      .slice()
      .reverse()
      .map(
        (e) =>
          `Protocolo: ${e.protocol}\nCPF: ${e.cpf || '-'}\nTratativa: ${e.note || '-'}`
      )
      .join('\n--------------------\n');
    copiar(txt);
    btnCopyAll.textContent = '✔ Copiado!';
    setTimeout(() => (btnCopyAll.textContent = '📄 Copiar tudo'), 1500);
  });

  btnClear.addEventListener('click', () => {
    if (!entries.length) return;
    if (!confirm('Apagar TODOS os registros? Essa ação não pode ser desfeita.')) return;
    entries = [];
    persist();
    renderTudo();
  });

  /* =====================================================================
   *  Lógica principal: detectar chat ativo e registrar
   * ===================================================================== */
  function scan() {
    if (!isAtiva()) {
      clearInterval(scanTimer);
      return;
    }
    const proto = normProto(getProtocoloAtivo());
    if (!proto) return;

    // Um único registro por protocolo: se já existe, apenas reutiliza
    let entry = entries.find((e) => normProto(e.protocol) === proto);
    if (!entry) {
      entry = { protocol: proto, cpf: '', note: '', createdAt: Date.now() };
      entries.unshift(entry);
      listEl.prepend(criaCard(entry));
      persist();
      atualizaContador();
    }

    if (!entry.cpf) {
      const cpf = getCPFVisivel();
      if (cpf) {
        entry.cpf = cpf;
        const c = cards.get(proto);
        if (c) c.cpfInput.value = cpf;
        persist();
      }
    }

    if (activeProtocol !== proto) {
      activeProtocol = proto;
      marcaAtivo();
      const c = cards.get(proto);
      if (c) c.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Ao clicar em qualquer lugar da página (fora do painel), reavalia algumas vezes
  document.addEventListener(
    'click',
    (e) => {
      if (!isAtiva() || e.composedPath().includes(host)) return;
      [400, 1200, 2500].forEach((t) => setTimeout(scan, t));
    },
    true
  );

  // Verificação periódica (cobre carregamento tardio das mensagens)
  const scanTimer = setInterval(scan, CONFIG.intervaloScan);

  window.addEventListener('resize', aplicaLayout);

  /* =====================================================================
   *  ABA RESPOSTAS RÁPIDAS (mensagens prontas)
   * ===================================================================== */
  function initMensagens() {
    /* ------------------------------------------------------------------ *
     *  MENSAGENS PADRÃO (protocol: true => exige o campo "Protocolo")
     * ------------------------------------------------------------------ */
    const DEFAULT_MESSAGES = [
      {
        id: 'saudacao',
        title: '1. Saudação',
        protocol: false,
        text: 'Olá, bem-vindo(a) ao suporte técnico do Einstein Hospital Israelita. Em que posso ajudar?'
      },
      {
        id: 'inatividade',
        title: '2. Inatividade',
        protocol: true,
        text: 'Por tempo de inatividade, esta conversa será encerrada!\nSuporte Técnico Digital do Einstein Hospital Israelita agradece o seu contato!'
      },
      {
        id: 'encerramento',
        title: '3. Encerramento',
        protocol: true,
        text: 'Suporte Técnico Digital do Einstein Hospital Israelita agradece o seu contato!'
      },
      {
        id: 'encerramento-transf',
        title: '4. Encerramento transferência',
        protocol: true,
        text: 'Como já encerramos nosso horário de atendimento, este chat será finalizado por enquanto.\nMas fique tranquilo(a): amanhã continuaremos acompanhando o seu caso e retornaremos por aqui assim que tivermos uma atualização.'
      },
      {
        id: 'geoloc-erro',
        title: '5. GEOLOC ERRO',
        protocol: false,
        text: 'Por se tratar de uma área rural, pode haver locais com pouca ou nenhuma recepção de sinal de GPS. Caso isso ocorra, peço que tente se deslocar para outro ponto da propriedade e verifique se o sinal é restabelecido.\nEssa situação está relacionada à disponibilidade do sinal de GPS na região e não a uma falha do sistema. Por conta dessas ocorrências, foi implementada a mensagem "Não foi possível obter a localização". Caso o técnico não consiga obter a localização, essa informação será registrada na visita, permitindo que a supervisão tenha ciência do ocorrido.\nEssa situação não impedirá a continuidade da visita. Em relação à aprovação ou reprovação, caberá à supervisão avaliar o cenário e definir a tratativa adequada.'
      },
      {
        id: 'divergencia-geo',
        title: '6. Divergência Geo',
        protocol: false,
        text: 'O celular estima a localização combinando diferentes recursos. O GPS recebe sinais de satélites e costuma funcionar melhor ao ar livre, com visão mais livre do céu. Quando o sinal de GPS está fraco ou indisponível, o aparelho pode tentar estimar a posição usando redes Wi‑Fi e antenas de telefonia próximas. A internet pode ajudar o aparelho a obter essa estimativa mais rapidamente, mas estar conectado à internet, por si só, não garante que a localização será precisa.\nNo modo avião, o comportamento depende do aparelho e das configurações: GPS e Wi‑Fi podem continuar ativos ou ser reativados separadamente. Sem internet e com GPS fraco, a localização pode demorar, ficar imprecisa ou não ser obtida. Por isso, aparelhos diferentes — ou o mesmo aparelho em locais e condições diferentes — podem apresentar resultados distintos.\nTambém pode haver uma posição anterior disponível no aparelho ou no navegador quando uma nova leitura demora. Na tecnologia PWA, o aplicativo pode receber a posição informada pelos serviços de localização do próprio aparelho; isso não significa necessariamente que o PWA mantenha um histórico ou use sempre uma localização em cache. Para saber qual posição foi usada em cada check-in ou checkout, precisamos analisar os registros técnicos daquela visita.\nComo não temos evidências suficientes para confirmar a causa desta divergência, não é possível afirmar que ela ocorreu por causa do modo avião, da conexão ou de cache. Como prevenção, recomendamos deixar os serviços de localização ativados, permitir o acesso à localização para o navegador/aplicativo e aguardar a captura da posição antes de registrar o check-in e o checkout.'
      },
      {
        id: 'inativar-domicilio',
        title: '7. Inativar domicílio',
        protocol: false,
        text: 'Para inativar o domicílio:\n1. Acesse "Propriedade";\n2. Clique em "Listar domicílios";\n3. Localize o domicílio X/Desejado;\n4. Na coluna da esquerda, selecione o ícone amarelo para inativar o domicílio.'
      },
      {
        id: 'reativar-domicilio',
        title: '8. Reativar domicílio',
        protocol: false,
        text: 'Para verificar e reativar o domicílio, siga estes passos:\n1. Acesse "Propriedade";\n2. Clique em "Listar domicílios";\n3. Na opção "Inativos", altere para "Sim";\n4. Localize o domicílio X/Desejado;\n5. Na coluna da esquerda, selecione o ícone verde para reativar o domicílio.'
      },
      {
        id: 'remover-historico-duo',
        title: '9. Remover histórico Duo',
        protocol: false,
        text: 'O histórico de atendimento do assistido com o status EM ABERTO é possível remover pelo seu próprio sistema:\n1. Na página inicial do seu sistema online, selecione "Assistidos";\n2. Selecione "Listar atendimentos";\n3. Selecione a lupa no canto superior direito e busque pelo ID que me informou;\n4. Selecione o botão vermelho, coloque o motivo da remoção e o histórico será removido.'
      }
    ];

    /* ------------------------------------------------------------------ *
     *  ESTADO / PERSISTÊNCIA
     * ------------------------------------------------------------------ */
    const KEY_MSGS = 'ei_messages_v1';

    let messages = loadMsgs(KEY_MSGS, null) || clone(DEFAULT_MESSAGES);
    let protocolValue = '';
    let filterText = '';
    let editing = null; // null | {id|null, ...}
    let lastEditable = null;

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function loadMsgs(k, d) {
      try { const v = GM_getValue(k, null); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    }
    function saveMsgs(k, v) { try { GM_setValue(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }

    /* ------------------------------------------------------------------ *
     *  ESTILOS (dentro do mesmo Shadow DOM da janela)
     * ------------------------------------------------------------------ */
    const css = `
    #ei-panel{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;background:#fff;color:#1f2937;
      font:13px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow:hidden}
    #ei-panel *{box-sizing:border-box}
    #ei-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
    .ei-tools{padding:8px 10px;border-bottom:1px solid #e5eaf0;display:flex;flex-direction:column;gap:6px;flex:0 0 auto;background:#f6f9fc}
    .ei-row{display:flex;gap:6px}
    .ei-tools input,.ei-edit input[type=text],.ei-edit textarea{width:100%;border:1px solid #b8c4d2;border-radius:6px;padding:6px 8px;font:inherit;color:inherit;background:#fff}
    .ei-tools input:focus,.ei-edit input:focus,.ei-edit textarea:focus{outline:2px solid #7fb2ea;border-color:#0b5cab}
    .ei-proto{border-color:#e0a100!important;background:#fffbea!important}
    .ei-btn{border:1px solid #b8c4d2;background:#fff;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit}
    .ei-btn:hover{background:#eef4fb}
    .ei-btn.primary{background:#0b5cab;color:#fff;border-color:#0b5cab}
    .ei-btn.primary:hover{background:#094c8d}
    .ei-btn.danger{color:#b42318;border-color:#f0b4ae}
    #ei-list{flex:1 1 auto;overflow:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
    .ei-item{display:flex;gap:4px}
    .ei-use{flex:1;text-align:left;border:1px solid #c9d3df;background:#fff;border-radius:6px;padding:8px 10px;cursor:pointer;font:inherit;font-weight:500;color:#0b3d75}
    .ei-use:hover{background:#e8f1fc;border-color:#0b5cab}
    .ei-use small{display:block;font-weight:400;color:#6b7280;margin-top:2px}
    .ei-tag{display:inline-block;background:#fff1c2;color:#7a5600;border-radius:4px;padding:0 5px;font-size:11px;margin-left:6px;font-weight:600}
    .ei-editbtn{border:1px solid #c9d3df;background:#fff;border-radius:6px;padding:0 9px;cursor:pointer}
    .ei-editbtn:hover{background:#eef4fb}
    .ei-edit{flex:1 1 auto;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
    .ei-edit label{font-weight:600;font-size:12px;color:#374151}
    .ei-edit textarea{flex:1 1 auto;min-height:140px;resize:vertical}
    .ei-check{display:flex;gap:6px;align-items:center;font-weight:400!important}
    .ei-foot{font-size:11px;color:#6b7280;padding:4px 10px 6px;border-top:1px solid #e5eaf0;flex:0 0 auto;display:flex;justify-content:space-between}
    .ei-foot a{color:#0b5cab;cursor:pointer;text-decoration:underline}
    #ei-toast{position:fixed;z-index:100000;left:50%;bottom:30px;transform:translateX(-50%);background:#111827;color:#fff;
      padding:8px 14px;border-radius:8px;font:13px -apple-system,Segoe UI,Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s}
    #ei-toast.show{opacity:1}
    `;
    const msgStyle = document.createElement('style');
    msgStyle.textContent = css;
    root.appendChild(msgStyle);

    /* ------------------------------------------------------------------ *
     *  HELPERS DE DOM
     * ------------------------------------------------------------------ */
    function hh(tag, attrs, ...kids) {
      const el = document.createElement(tag);
      for (const k in (attrs || {})) {
        const v = attrs[k];
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = v;
        else el.setAttribute(k, v);
      }
      kids.flat().forEach(c => { if (c != null) el.append(c.nodeType ? c : document.createTextNode(c)); });
      return el;
    }

    const toastEl = hh('div', { id: 'ei-toast' });
    root.appendChild(toastEl);
    let toastTimer;
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    /* ------------------------------------------------------------------ *
     *  CAIXA DE MENSAGEM DO SALESFORCE (busca em Shadow DOM)
     * ------------------------------------------------------------------ */
    const msgPanel = hh('div', { id: 'ei-panel' });
    paneMsgs.appendChild(msgPanel);

    function isEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      // ignora qualquer campo da própria janela (Respostas e Registro)
      if (el.getRootNode && el.getRootNode() === root) return false;
      const t = el.tagName;
      if (t === 'TEXTAREA') return !el.disabled && !el.readOnly;
      if (t === 'INPUT') return ['text', 'search', ''].includes((el.type || '').toLowerCase()) && !el.disabled && !el.readOnly;
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      return ce === '' || ce === 'true' || ce === 'plaintext-only';
    }

    function isVisibleMsg(el) {
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function deepCollect(rootNode, out) {
      rootNode.querySelectorAll('*').forEach(el => {
        if (isEditable(el)) out.push(el);
        if (el.shadowRoot) deepCollect(el.shadowRoot, out);
      });
      return out;
    }

    document.addEventListener('focusin', e => {
      if (!isAtiva()) return;
      const t = e.composedPath ? e.composedPath()[0] : e.target;
      if (isEditable(t)) lastEditable = t;
    }, true);

    function findTarget() {
      if (lastEditable && lastEditable.isConnected && isVisibleMsg(lastEditable)) return lastEditable;
      const all = deepCollect(document, []).filter(isVisibleMsg);
      const hint = /mensag|message|chat|digit|type|escreva|responder/i;
      const hinted = all.filter(el => hint.test(
        (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
        (el.getAttribute('data-placeholder') || '') + ' ' + (el.className || '')
      ));
      const pool = hinted.length ? hinted : [];
      return pool.length ? pool[pool.length - 1] : null;
    }

    function insertInto(el, text) {
      el.focus();
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        document.execCommand('selectAll', false, null);
        if (!document.execCommand('insertText', false, text)) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
        }
      }
    }

    async function copyText(text) {
      try { GM_setClipboard(text, 'text'); return true; } catch (e) { /* fallback */ }
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
    }

    /* ------------------------------------------------------------------ *
     *  AÇÃO: USAR MENSAGEM
     * ------------------------------------------------------------------ */
    function compose(m) {
      let t = m.text;
      if (m.protocol) {
        const p = protocolValue.trim();
        if (!p) return null;
        t += '\n\nProtocolo da conversa: ' + p;
      }
      return t;
    }

    async function useMessage(m) {
      const text = compose(m);
      if (text === null) {
        toast('⚠️ Informe o Protocolo da conversa antes.');
        const f = msgPanel.querySelector('#ei-proto');
        if (f) f.focus();
        return;
      }
      const copied = await copyText(text);
      const target = findTarget();
      if (target) {
        insertInto(target, text);
        toast('✅ Inserida na caixa de mensagem' + (copied ? ' e copiada' : ''));
      } else {
        toast(copied ? '📋 Copiada! (cole com Ctrl+V — clique na caixa de mensagem uma vez para a inserção automática)' : '❌ Não foi possível copiar.');
      }
    }

    /* ------------------------------------------------------------------ *
     *  RENDER
     * ------------------------------------------------------------------ */
    function render() {
      msgPanel.textContent = '';
      const body = hh('div', { id: 'ei-body' });
      msgPanel.appendChild(body);
      if (editing) renderEditor(body); else renderList(body);
    }

    function renderList(body) {
      const protoInput = hh('input', {
        id: 'ei-proto', type: 'text', class: 'ei-proto', placeholder: 'Protocolo da conversa (Salesforce)',
        value: protocolValue,
        oninput: e => { protocolValue = e.target.value; }
      });
      const clearBtn = hh('button', {
        class: 'ei-btn', title: 'Limpar protocolo (nova conversa)',
        onclick: () => { protocolValue = ''; protoInput.value = ''; protoInput.focus(); }
      }, '✕');
      const search = hh('input', {
        type: 'text', placeholder: '🔎 Buscar mensagem…', value: filterText,
        oninput: e => { filterText = e.target.value; refreshItems(); }
      });
      const addBtn = hh('button', {
        class: 'ei-btn primary',
        onclick: () => { editing = { id: null, title: '', text: '', protocol: false }; render(); }
      }, '+ Nova mensagem');

      body.appendChild(hh('div', { class: 'ei-tools' },
        hh('div', { class: 'ei-row' }, protoInput, clearBtn),
        search,
        addBtn
      ));

      const list = hh('div', { id: 'ei-list' });
      body.appendChild(list);

      body.appendChild(hh('div', { class: 'ei-foot' },
        hh('span', {}, 'Mensagens com 🔖 usam o protocolo'),
        hh('a', {
          onclick: () => {
            if (confirm('Restaurar as mensagens padrão? Suas edições e mensagens novas serão perdidas.')) {
              messages = clone(DEFAULT_MESSAGES); saveMsgs(KEY_MSGS, messages); render();
            }
          }
        }, 'restaurar padrão')
      ));

      refreshItems();
    }

    function refreshItems() {
      const list = msgPanel.querySelector('#ei-list');
      if (!list) return;
      list.textContent = '';
      const q = filterText.trim().toLowerCase();
      const shown = messages.filter(m => !q || (m.title + ' ' + m.text).toLowerCase().includes(q));
      if (!shown.length) list.appendChild(hh('div', { style: 'color:#6b7280;padding:8px' }, 'Nenhuma mensagem encontrada.'));
      shown.forEach(m => {
        const preview = m.text.replace(/\s+/g, ' ').slice(0, 70) + (m.text.length > 70 ? '…' : '');
        const useBtn = hh('button', {
          class: 'ei-use', title: m.text,
          // mousedown preventDefault mantém o foco na caixa de mensagem do Salesforce
          onmousedown: e => e.preventDefault(),
          onclick: () => useMessage(m)
        },
          hh('span', {}, m.title, m.protocol ? hh('span', { class: 'ei-tag' }, '🔖 protocolo') : null),
          hh('small', {}, preview)
        );
        const editBtn = hh('button', {
          class: 'ei-editbtn', title: 'Editar',
          onclick: () => { editing = clone(m); render(); }
        }, '✎');
        list.appendChild(hh('div', { class: 'ei-item' }, useBtn, editBtn));
      });
    }

    function renderEditor(body) {
      const isNew = editing.id === null;
      const titleIn = hh('input', { type: 'text', value: editing.title, placeholder: 'Ex.: 10. Nova mensagem' });
      const textIn = hh('textarea', { placeholder: 'Texto da mensagem…' });
      textIn.value = editing.text;
      const protoChk = hh('input', { type: 'checkbox', checked: !!editing.protocol });

      const saveBtn = hh('button', {
        class: 'ei-btn primary',
        onclick: () => {
          const title = titleIn.value.trim();
          const text = textIn.value.trim();
          if (!title || !text) { toast('⚠️ Preencha título e mensagem.'); return; }
          const data = { title, text, protocol: protoChk.checked };
          if (isNew) messages.push(Object.assign({ id: 'm' + Date.now() }, data));
          else messages = messages.map(m => m.id === editing.id ? Object.assign({}, m, data) : m);
          saveMsgs(KEY_MSGS, messages);
          editing = null; render(); toast('💾 Salvo.');
        }
      }, 'Salvar');
      const cancelBtn = hh('button', { class: 'ei-btn', onclick: () => { editing = null; render(); } }, 'Cancelar');
      const delBtn = isNew ? null : hh('button', {
        class: 'ei-btn danger',
        onclick: () => {
          if (!confirm('Excluir esta mensagem?')) return;
          messages = messages.filter(m => m.id !== editing.id);
          saveMsgs(KEY_MSGS, messages); editing = null; render();
        }
      }, 'Excluir');
      const up = isNew ? null : hh('button', { class: 'ei-btn', title: 'Mover para cima', onclick: () => move(-1) }, '↑');
      const down = isNew ? null : hh('button', { class: 'ei-btn', title: 'Mover para baixo', onclick: () => move(1) }, '↓');

      function move(dir) {
        const i = messages.findIndex(m => m.id === editing.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= messages.length) return;
        [messages[i], messages[j]] = [messages[j], messages[i]];
        saveMsgs(KEY_MSGS, messages);
        toast('↕️ Posição alterada');
      }

      body.appendChild(hh('div', { class: 'ei-edit' },
        hh('strong', {}, isNew ? 'Nova mensagem' : 'Editar mensagem'),
        hh('label', {}, 'Título'), titleIn,
        hh('label', {}, 'Mensagem'), textIn,
        hh('label', { class: 'ei-check' }, protoChk, 'Incluir Protocolo da conversa no final'),
        hh('div', { class: 'ei-row', style: 'flex-wrap:wrap' }, saveBtn, cancelBtn, up, down, delBtn)
      ));
      titleIn.focus();
    }

    render();
  }

  /* =====================================================================
   *  Inicialização
   * ===================================================================== */
  document.documentElement.appendChild(host);
  if (IS_SALESFORCE) initMensagens();
  aplicaLayout();
  setTab(ui.tab === 'msgs' || ui.tab === 'tf' ? ui.tab : 'reg');
  renderTudo();
  persist(); // grava a lista já sem duplicados

  // Sincroniza com outras abas do Salesforce abertas (evita sobrescrever/duplicar)
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(KEY_DATA, (name, oldV, newV, remote) => {
      if (!remote || !isAtiva()) return;
      const foco = root.activeElement;
      if (foco && (foco.tagName === 'TEXTAREA' || foco.tagName === 'INPUT')) return;
      try {
        entries = dedupe(JSON.parse(newV));
        renderTudo();
      } catch (e) {}
    });
  }


  /* =====================================================================
   *  [NOVO] Fechamento automático do registro quando a aba do chat é fechada
   *  (bloco adicional: nenhuma linha do código original foi alterada)
   * ===================================================================== */
  const AUTO_CLOSE = {
    ativo: true,          // false = desliga o fechamento automático
    intervalo: 1500,      // de quanto em quanto tempo verifica as abas (ms)
    varredurasAusente: 3, // nº de verificações seguidas sem a aba para considerar fechada
  };

  // Seletores de abas do console (todas as abas, não só a ativa)
  const SELETORES_TODAS_ABAS = [
    '.oneConsoleTab',
    'li.tabItem',
    '.slds-tabs_default__item',
    '[role="tab"]',
    '.tabHeader',
    ...CONFIG.seletoresAbaAtiva,
    CONFIG.seletorTitulo,
  ].join(',');

  const protocoloRegexGlobal = new RegExp(CONFIG.protocoloRegex.source, 'gi');
  const abertosVistos = new Set(); // protocolos que já foram vistos com aba aberta
  const ausencias = new Map();     // protocolo -> verificações seguidas sem aba

  // Lista os protocolos que ainda têm aba aberta no Salesforce
  function protocolosAbertos() {
    const achados = new Set();
    const els = document.querySelectorAll(SELETORES_TODAS_ABAS);
    els.forEach((el) => {
      const txt = [
        el.textContent || '',
        el.getAttribute('title') || '',
        el.getAttribute('aria-label') || '',
      ].join(' ');
      for (const m of txt.matchAll(protocoloRegexGlobal)) {
        achados.add(normProto(m[1]));
      }
    });
    return { achados, total: els.length };
  }

  // Remove o registro (dados + card) da aplicação
  function fecharRegistro(proto) {
    const antes = entries.length;
    entries = entries.filter((e) => normProto(e.protocol) !== proto);
    if (entries.length === antes) return;
    const c = cards.get(proto);
    if (c) c.card.remove();
    cards.delete(proto);
    if (activeProtocol === proto) activeProtocol = null;
    persist();
    atualizaContador();
  }

  function verificaAbasFechadas() {
    if (!isAtiva()) {
      clearInterval(autoCloseTimer);
      return;
    }
    if (!AUTO_CLOSE.ativo) return;

    const { achados, total } = protocolosAbertos();
    // Segurança: se nenhuma aba/título foi encontrado, a página provavelmente
    // ainda está carregando — não remove nada.
    if (!total) return;

    achados.forEach((p) => {
      abertosVistos.add(p);
      ausencias.delete(p);
    });

    [...abertosVistos].forEach((p) => {
      if (achados.has(p)) return;
      const n = (ausencias.get(p) || 0) + 1;
      if (n >= AUTO_CLOSE.varredurasAusente) {
        abertosVistos.delete(p);
        ausencias.delete(p);
        fecharRegistro(p);
      } else {
        ausencias.set(p, n);
      }
    });
  }

  const autoCloseTimer = setInterval(verificaAbasFechadas, AUTO_CLOSE.intervalo);


  /* =====================================================================
   *  [NOVO] ABA TRANSFERIR — transferência automática dos chats para a fila
   *  Usa os protocolos capturados na aba "Registro".
   *  Fluxo por chat: abre a aba do chat -> confere protocolo ativo ->
   *  escreve a mensagem + protocolo -> confere o texto -> Enviar ->
   *  confirma a mensagem no histórico do chat -> Transferir (change_owner) ->
   *  pesquisa "Campo" -> seleciona a fila -> Avançar -> Transferir.
   * ===================================================================== */
  if (IS_SALESFORCE) (function initTransferencia() {
    const TRANSF = {
      mensagem:
        'Como já encerramos nosso horário de atendimento, este chat será finalizado por enquanto.\n' +
        'Mas fique tranquilo(a): amanhã continuaremos acompanhando o seu caso e retornaremos por aqui assim que tivermos uma atualização.',
      rotuloProtocolo: 'Protocolo da conversa: ',
      buscaFila: 'Campo',
      tituloFila: 'WhatsApp Suporte - Saúde no Campo',

      timeoutPasso: 15000,        // espera máxima por cada elemento (ms)
      timeoutConfirmEnvio: 20000, // espera máxima para a mensagem aparecer no chat (ms)
      pausaEntreChats: 2500,      // pausa entre um chat e outro (ms)

      seletorBotaoEnviar: 'button.messaging-send-button, button[title="Enviar"][aria-label="Enviar"]',
      seletorIconeTransferir: '[data-key="change_owner"]',
      seletorBuscaFila: 'input[placeholder="Pesquisar filas"], input[aria-label="Pesquisar filas"]',
      seletorAvancar: 'button[title="Avançar"], button[aria-label="Avançar"]',
      seletorTransferirFinal: 'button.slds-button_brand[title="Transferir"], button.slds-button_brand[aria-label="Transferir"]',
      seletorCancelar: 'button[title="Cancelar"], button[aria-label="Cancelar"]',
    };

    const montaMensagem = (proto) => TRANSF.mensagem + '\n\n' + TRANSF.rotuloProtocolo + proto;
    const normTxt = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const tf = {
      sel: new Set(),       // protocolos marcados
      status: new Map(),    // protocolo -> { tipo: 'run'|'ok'|'erro'|'teste', txt }
      rodando: false,
      abortar: false,
      log: [],
      assinatura: '',
    };
    if (typeof ui.tfTeste !== 'boolean') ui.tfTeste = false;
    if (typeof ui.tfConfirmar !== 'boolean') ui.tfConfirmar = false;

    /* ---------------- Busca profunda (atravessa Shadow DOM) ---------------- */
    function raizes() {
      const out = [document];
      const visita = (r) => {
        r.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot && el !== host) {
            out.push(el.shadowRoot);
            visita(el.shadowRoot);
          }
        });
      };
      visita(document);
      return out;
    }
    function deepAll(sel, rs) {
      const set = new Set();
      (rs || raizes()).forEach((r) => r.querySelectorAll(sel).forEach((el) => set.add(el)));
      return [...set];
    }
    const paiDeep = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
    function closestDeep(el, sel) {
      while (el) {
        const c = el.closest ? el.closest(sel) : null;
        if (c) return c;
        const r = el.getRootNode && el.getRootNode();
        el = r && r.host ? r.host : null;
      }
      return null;
    }
    function contemDeep(anc, el) {
      while (el) {
        if (el === anc) return true;
        el = paiDeep(el);
      }
      return false;
    }
    const habilitado = (b) => b && isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

    function clicar(el) {
      try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      // Simula o mouse na posição real do elemento (alguns componentes LWC exigem)
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      // Obs.: sem "view: window" — no Tampermonkey o "window" é um sandbox e quebra o evento
      const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
      const ptr = { pointerType: 'mouse', isPrimary: true, pointerId: 1 };
      const disparar = (Tipo, nome, extra) => {
        try { el.dispatchEvent(new Tipo(nome, Object.assign({}, o, extra || {}))); return true; } catch (e) { return false; }
      };
      disparar(PointerEvent, 'pointerover', ptr);
      disparar(MouseEvent, 'mouseover');
      disparar(PointerEvent, 'pointerdown', Object.assign({ buttons: 1 }, ptr));
      disparar(MouseEvent, 'mousedown', { buttons: 1 });
      try { if (typeof el.focus === 'function') el.focus(); } catch (e) {}
      disparar(PointerEvent, 'pointerup', ptr);
      disparar(MouseEvent, 'mouseup');
      if (!disparar(MouseEvent, 'click') && typeof el.click === 'function') el.click();
    }

    function setValorNativo(el, texto) {
      const protoEl = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(protoEl, 'value').set.call(el, texto);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'o' }));
    }

    async function esperar(fn, timeout, desc) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (tf.abortar) throw new Error('Interrompido pelo usuário');
        let v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return v;
        await sleep(350);
      }
      throw new Error('Tempo esgotado: ' + desc);
    }

    /* ---------------- Passo 1: abrir a aba do chat ---------------- */
    async function abrirAbaDoChat(proto) {
      if (normProto(getProtocoloAtivo()) === proto) return;
      const re = new RegExp('\\b' + proto.replace(/[-]/g, '\\-') + '\\b', 'i');
      const todos = deepAll('a[role="tab"], [role="tab"], .tabHeader, li.oneConsoleTabItem a').filter((el) =>
        re.test((el.getAttribute('title') || '') + ' ' + (el.textContent || ''))
      );
      const alvo = todos.find(isVisible) || todos[0];
      if (!alvo) throw new Error('Aba do chat não encontrada no console (a conversa está aberta?)');
      clicar(alvo);
      await esperar(() => normProto(getProtocoloAtivo()) === proto, 10000, 'ativar a aba do chat');
      await sleep(900);
    }

    /* ---------------- Passo 2: caixa de mensagem + Enviar ---------------- */
    const SEL_CAMPO = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
    function acharComposer() {
      const rs = raizes();
      const botoes = deepAll(TRANSF.seletorBotaoEnviar, rs).filter(isVisible);
      if (!botoes.length) return null;
      const campos = deepAll(SEL_CAMPO, rs).filter((c) => isVisible(c) && !c.disabled && !c.readOnly);
      for (const btn of botoes) {
        let anc = paiDeep(btn);
        for (let i = 0; i < 15 && anc; i++, anc = paiDeep(anc)) {
          const dentro = campos.filter((c) => contemDeep(anc, c));
          if (dentro.length) return { btn, campo: dentro[dentro.length - 1] };
        }
      }
      return null;
    }
    const lerCampo = (c) => (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT' ? c.value : c.innerText) || '';

    function inserirTexto(campo, texto) {
      campo.focus();
      if (campo.tagName === 'TEXTAREA' || campo.tagName === 'INPUT') {
        setValorNativo(campo, texto);
      } else {
        document.execCommand('selectAll', false, null);
        if (!document.execCommand('insertText', false, texto)) {
          campo.textContent = texto;
          campo.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: texto, inputType: 'insertText' }));
        }
      }
    }

    // Conta quantas mensagens VISÍVEIS no histórico contêm "Protocolo da conversa: <proto>"
    function contaMensagensComProtocolo(proto) {
      const needle = normTxt(TRANSF.rotuloProtocolo + proto).toUpperCase();
      const achados = new Set();
      raizes().forEach((r) => {
        const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (!n.nodeValue || n.nodeValue.toUpperCase().indexOf(proto) === -1) continue;
          const p = n.parentElement;
          if (!p) continue;
          if (closestDeep(p, SEL_CAMPO + ', [role="tab"], .tabHeader, .oneConsoleTab')) continue;
          if (!isVisible(p)) continue;
          let el = p;
          for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
            if (normTxt(el.textContent).toUpperCase().includes(needle)) {
              achados.add(p);
              break;
            }
          }
        }
      });
      return achados.size;
    }

    async function enviarMensagem(proto) {
      const texto = montaMensagem(proto);
      const needle = TRANSF.rotuloProtocolo + proto;

      const comp = await esperar(acharComposer, TRANSF.timeoutPasso, 'caixa de mensagem do chat');
      await sleep(600); // histórico termina de carregar

      const antes = contaMensagensComProtocolo(proto);
      if (antes > 0) {
        log(proto, 'ℹ Mensagem com este protocolo já existe no chat — não será reenviada.');
        return;
      }

      const rascunho = normTxt(lerCampo(comp.campo));
      if (rascunho && rascunho !== normTxt(texto)) {
        throw new Error('A caixa de mensagem tem um rascunho digitado — chat ignorado para não apagá-lo');
      }
      if (normProto(getProtocoloAtivo()) !== proto) throw new Error('A aba ativa mudou antes de escrever a mensagem');

      inserirTexto(comp.campo, texto);
      await sleep(500);

      // Conferência ANTES de enviar: texto correto + protocolo certo + mesmo chat ativo
      const atual = lerCampo(comp.campo);
      const protosNoTexto = (atual.match(/MS-\d+/gi) || []).map(normProto);
      if (!normTxt(atual).includes(normTxt(needle)) || protosNoTexto.some((p) => p !== proto)) {
        throw new Error('O texto na caixa não confere com o protocolo ' + proto + ' — envio cancelado');
      }
      if (normProto(getProtocoloAtivo()) !== proto) throw new Error('A aba ativa mudou antes do envio — envio cancelado');

      const btn = await esperar(() => {
        const c = acharComposer();
        return c && habilitado(c.btn) ? c.btn : null;
      }, 8000, 'botão Enviar ficar habilitado');
      btn.click();
      // Verificação simples: o Enviar foi aceito quando a caixa de mensagem esvazia
      await esperar(() => {
        const c = acharComposer();
        return c && !normTxt(lerCampo(c.campo)).includes(normTxt(needle));
      }, 10000, 'a caixa de mensagem não esvaziou após clicar em Enviar (mensagem pode não ter sido enviada)');
      await sleep(1000);
    }

    /* ---------------- Passo 3: transferir para a fila ---------------- */
    function cancelarModal() {
      const b = deepAll(TRANSF.seletorCancelar).find(habilitado);
      if (b) clicar(b);
    }

    /* ---------------- Seleção da fila (HTML: div.list-item-display > span[title]) ---------------- */
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\s ]+/g, ' ').trim().toLowerCase();

    // Retorna o span[title] da fila desejada que estiver visível
    function acharOpcaoFila() {
      const alvo = semAcento(TRANSF.tituloFila);
      return deepAll('.list-item-display span[title], span[title]')
        .filter((el) => !contemDeep(host, el) && isVisible(el))
        .find((el) => semAcento(el.getAttribute('title')) === alvo) || null;
    }

    // Item clicável: o "div.list-item-display" e seus pais imediatos
    // (para antes de chegar no elemento que contém a lista inteira)
    function alvosDeClique(span) {
      const item = closestDeep(span, '.list-item-display') || span;
      const lista = [];
      const add = (el) => { if (el && !lista.includes(el)) lista.push(el); };
      // 1º: o "botão" da fila = ícone (div.image-container / slds-media__figure)
      const figura = item.querySelector && item.querySelector('.image-container, .slds-media__figure');
      if (figura) {
        add(figura);
        add(figura.querySelector('lightning-icon'));
        const icone = figura.querySelector('lightning-icon');
        const sr = icone && icone.shadowRoot;
        add((sr && sr.querySelector('svg[data-key="queue"], span')) || figura.querySelector('svg[data-key="queue"]'));
      }
      add(item);
      let el = paiDeep(item);
      for (let i = 0; i < 4 && el; i++, el = paiDeep(el)) {
        const qtd = el.querySelectorAll ? el.querySelectorAll('.list-item-display').length : 0;
        if (qtd > 1) break; // chegou na lista inteira — não sobe mais
        add(el);
      }
      add(span);
      return lista;
    }

    function itemMarcado(span) {
      let el = span;
      for (let i = 0; i < 7 && el; i++, el = paiDeep(el)) {
        if (!el.getAttribute) continue;
        if (['aria-selected', 'aria-checked', 'aria-pressed'].some((a) => el.getAttribute(a) === 'true')) return true;
        if (/(^|[\s_-])(selected|checked)(\b|$)|slds-is-selected/i.test(String(el.className || ''))) return true;
        if (i <= 4 && el.querySelector &&
            el.querySelector('[data-key="check"], [icon-name="utility:check"], [icon-name="utility:success"]')) return true;
      }
      return false;
    }

    // Descreve o item e seus pais (para diagnóstico no log se a seleção falhar)
    function descreveItem(span) {
      const partes = [];
      let el = span;
      for (let i = 0; i < 7 && el; i++, el = paiDeep(el)) {
        if (!el.tagName) continue;
        const attrs = ['role', 'aria-selected', 'aria-checked', 'tabindex', 'data-item-id', 'data-is-selected']
          .filter((a) => el.getAttribute(a) != null).map((a) => a + '=' + el.getAttribute(a)).join(' ');
        partes.push(el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + (attrs ? '[' + attrs + ']' : ''));
      }
      return partes.join(' < ');
    }

    async function digitarBusca(busca, texto) {
      busca.focus();
      setValorNativo(busca, '');
      let parcial = '';
      for (const ch of texto) {
        parcial += ch;
        busca.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
        setValorNativo(busca, parcial);
        busca.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
        await sleep(120);
      }
    }

    async function selecionarFila(proto, busca) {
      // 1) Aguarda a fila aparecer; se a pesquisa não disparou, digita de novo letra por letra
      let span;
      try {
        span = await esperar(acharOpcaoFila, 4000, 'resultado da pesquisa');
      } catch (e) {
        if (tf.abortar) throw e;
        log(proto, 'Resultado não apareceu — digitando a pesquisa novamente…');
        await digitarBusca(busca, TRANSF.buscaFila);
        span = await esperar(acharOpcaoFila, TRANSF.timeoutPasso, 'fila "' + TRANSF.tituloFila + '" nos resultados');
      }
      log(proto, 'Fila localizada. Selecionando…');
      await sleep(500);

      // Opção da lista: <div class="slds-listbox__option ... list-item" data-item-id="..." data-is-selected="...">
      const SEL_OPCAO = '.slds-listbox__option[data-item-id], [data-item-id].list-item, .slds-listbox__option, [role="option"]';
      const opcaoAtual = () => {
        const s = acharOpcaoFila();
        return s ? closestDeep(s, SEL_OPCAO) : null;
      };
      const botaoAvancar = () => deepAll(TRANSF.seletorAvancar).find(isVisible) || null;
      const estado = () => {
        const op = opcaoAtual();
        const av = botaoAvancar();
        return {
          sel: op ? op.getAttribute('data-is-selected') : null,
          aria: op ? op.getAttribute('aria-selected') : null,
          avancar: !!(av && habilitado(av)),
          avDesc: av ? ('disabled=' + av.disabled + ' aria-disabled=' + av.getAttribute('aria-disabled')) : 'não encontrado',
        };
      };
      const antes = estado();
      const selecionou = () => {
        const e = estado();
        if (!antes.avancar && e.avancar) return true;                    // Avançar foi liberado
        if (antes.sel !== 'true' && e.sel === 'true') return true;        // data-is-selected virou true
        if (antes.aria !== 'true' && e.aria === 'true') return true;
        return false;
      };
      log(proto, 'Antes: data-is-selected=' + antes.sel + ' | Avançar ' + antes.avDesc);

      // UM clique por vez, sempre na opção da lista (evita marcar/desmarcar)
      const tentativas = [
        ['clique na opção', () => { const op = opcaoAtual(); if (op) clicar(op); }],
        ['Enter na opção', () => {
          const op = opcaoAtual(); if (!op) return;
          op.focus();
          const ko = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
          op.dispatchEvent(new KeyboardEvent('keydown', ko));
          op.dispatchEvent(new KeyboardEvent('keyup', ko));
        }],
        ['clique no nome', () => { const s = acharOpcaoFila(); if (s) clicar(s); }],
      ];
      for (const [nome, acao] of tentativas) {
        if (tf.abortar) throw new Error('Interrompido pelo usuário');
        if (selecionou()) break;
        acao();
        await sleep(1500);
        const e = estado();
        log(proto, nome + ' → data-is-selected=' + e.sel + ' | Avançar ' + e.avDesc);
        if (selecionou()) { log(proto, '✔ Fila "' + TRANSF.tituloFila + '" selecionada.'); return; }
        if (antes.avancar) {
          // Avançar já estava liberado antes: não dá para confirmar pela tela; segue
          log(proto, 'Avançar já estava liberado — seguindo.');
          return;
        }
      }
      if (selecionou()) { log(proto, '✔ Fila "' + TRANSF.tituloFila + '" selecionada.'); return; }

      // Plano B: espera você clicar na fila manualmente e continua sozinho
      log(proto, '👉 Não consegui selecionar sozinho. CLIQUE NA FILA na janela do Salesforce — o script continua em seguida (até 60 s).');
      const s0 = acharOpcaoFila() || span;
      log(proto, 'Diagnóstico do item: ' + descreveItem(s0));
      await esperar(selecionou, 60000, 'seleção manual da fila');
      log(proto, '✔ Fila selecionada manualmente. Continuando…');
    }

    async function transferirParaFila(proto) {
      if (normProto(getProtocoloAtivo()) !== proto) throw new Error('A aba ativa mudou antes da transferência');

      const botaoTransf = await esperar(() => {
        const icones = deepAll(TRANSF.seletorIconeTransferir).filter(isVisible);
        for (const i of icones) {
          const b = closestDeep(i, 'button, a, [role="button"]');
          if (b && isVisible(b)) return b;
        }
        return null;
      }, TRANSF.timeoutPasso, 'botão de transferência (change_owner)');
      clicar(botaoTransf);

      const busca = await esperar(() => deepAll(TRANSF.seletorBuscaFila).find(isVisible), TRANSF.timeoutPasso, 'campo "Pesquisar filas"');
      await sleep(600); // janela termina de carregar
      busca.focus();
      setValorNativo(busca, TRANSF.buscaFila);
      log(proto, 'Pesquisando fila "' + TRANSF.buscaFila + '"…');

      await selecionarFila(proto, busca);

      const avancar = await esperar(() => deepAll(TRANSF.seletorAvancar).find(habilitado), TRANSF.timeoutPasso, 'botão Avançar');
      clicar(avancar);

      const final = await esperar(() => deepAll(TRANSF.seletorTransferirFinal).find(habilitado), TRANSF.timeoutPasso, 'botão Transferir');

      if (normProto(getProtocoloAtivo()) !== proto) {
        cancelarModal();
        throw new Error('A aba ativa mudou antes de confirmar a transferência — cancelado');
      }
      if (ui.tfTeste) {
        cancelarModal();
        return 'teste';
      }
      if (ui.tfConfirmar && !confirm('Transferir o chat ' + proto + ' para "' + TRANSF.tituloFila + '"?')) {
        cancelarModal();
        throw new Error('Transferência cancelada por você');
      }
      clicar(final);

      // Aguarda o modal fechar / a aba do chat sair do console
      try {
        await esperar(
          () => !deepAll(TRANSF.seletorTransferirFinal).some(isVisible) || !protocolosAbertos().achados.has(proto),
          TRANSF.timeoutPasso,
          'fechamento da janela de transferência'
        );
      } catch (e) {
        if (tf.abortar) throw e;
        log(proto, '⚠ Transferir foi clicado, mas a janela não fechou — confira manualmente.');
      }
      return 'ok';
    }

    /* ---------------- Execução em lote ---------------- */
    async function executar(lista) {
      tf.rodando = true;
      tf.abortar = false;
      atualizaBotoes();
      log('', '▶ Iniciando: ' + lista.join(', ') + (ui.tfTeste ? ' (MODO TESTE)' : ''));

      for (const proto of lista) {
        if (tf.abortar) break;
        setStatus(proto, 'run', 'em andamento…');
        try {
          log(proto, 'Abrindo a aba do chat…');
          await abrirAbaDoChat(proto);
          log(proto, 'Aba ativa confere (' + proto + '). Escrevendo mensagem…');
          await enviarMensagem(proto);
          log(proto, '✔ Mensagem com o protocolo enviada.');
          const r = await transferirParaFila(proto);
          if (r === 'teste') {
            setStatus(proto, 'teste', 'teste ok (não transferido)');
            log(proto, '🧪 Modo teste: chegou até "Transferir" e cancelou.');
          } else {
            setStatus(proto, 'ok', 'transferido');
            tf.sel.delete(proto);
            log(proto, '✅ Transferido para "' + TRANSF.tituloFila + '".');
          }
        } catch (e) {
          setStatus(proto, 'erro', 'erro');
          log(proto, '✖ ' + (e && e.message ? e.message : e));
          try { cancelarModal(); } catch (x) {}
        }
        if (!tf.abortar) await sleep(TRANSF.pausaEntreChats);
      }

      log('', tf.abortar ? '⏹ Interrompido.' : '■ Concluído.');
      tf.rodando = false;
      tf.abortar = false;
      atualizaBotoes();
      refresh(true);
    }

    /* ---------------- Interface ---------------- */
    const css = `
      .tf-top{display:flex;align-items:center;gap:6px;padding:8px;background:#f6f9fc;border-bottom:1px solid #e5eaf0;flex:none;font-size:12px}
      .tf-top label{display:flex;align-items:center;gap:4px;cursor:pointer}
      .tf-top .sp{flex:1}
      .tf-list{flex:1 1 auto;overflow:auto;padding:6px 8px;background:#f3f5f9;min-height:60px}
      .tf-item{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #d5dce8;border-radius:7px;padding:6px 8px;margin-bottom:6px;cursor:pointer}
      .tf-item.off{opacity:.6}
      .tf-item .p{font-weight:700;color:#0b5cab}
      .tf-item .c{color:#556;font-size:11px}
      .tf-item .info{flex:1;min-width:0}
      .pill{font-size:10px;border-radius:8px;padding:1px 6px;white-space:nowrap}
      .pill.aberta{background:#e3f4e8;color:#2e844a}
      .pill.fechada{background:#eceff3;color:#667}
      .pill.run{background:#fff1c2;color:#7a5600}
      .pill.ok{background:#2e844a;color:#fff}
      .pill.teste{background:#dbeafe;color:#1e40af}
      .pill.erro{background:#fde3e3;color:#b42318}
      .tf-opts{display:flex;flex-direction:column;gap:3px;padding:6px 8px;border-top:1px solid #e5eaf0;font-size:12px;flex:none;background:#fff}
      .tf-opts label{display:flex;align-items:center;gap:6px;cursor:pointer}
      .tf-actions{display:flex;gap:6px;padding:0 8px 8px;background:#fff;flex:none}
      .tf-go{flex:1;padding:7px;border-radius:5px;border:1px solid #0b5cab;background:#0b5cab;color:#fff;font-weight:600;cursor:pointer;font-size:12px}
      .tf-go:disabled{opacity:.5;cursor:default}
      .tf-stop{padding:7px 10px;border-radius:5px;border:1px solid #f0b4ae;background:#fff;color:#b42318;cursor:pointer;font-size:12px}
      .tf-log{height:110px;flex:none;overflow:auto;background:#111827;color:#d1d5db;font:11px/1.4 Consolas,monospace;padding:6px 8px;white-space:pre-wrap}
      .tf-loghead{display:flex;justify-content:space-between;font-size:11px;padding:3px 8px;background:#1f2937;color:#9ca3af;flex:none}
      .tf-loghead a{color:#93c5fd;cursor:pointer}
    `;
    root.appendChild(h('style', { text: css }));

    const chkTodos = h('input', { type: 'checkbox' });
    const lblQtd = h('span', { class: 'sp' });
    const btnAtualizar = h('button', { class: 'mini', title: 'Atualizar lista', text: '🔄' });
    const top = h('div', { class: 'tf-top' }, h('label', {}, chkTodos, 'Todos'), lblQtd, btnAtualizar);

    const listaEl = h('div', { class: 'tf-list' });

    const chkTeste = h('input', { type: 'checkbox' });
    const chkConf = h('input', { type: 'checkbox' });
    chkTeste.checked = ui.tfTeste;
    chkConf.checked = ui.tfConfirmar;
    const opts = h('div', { class: 'tf-opts' },
      h('label', {}, chkTeste, 'Modo teste (faz tudo, mas cancela em vez de clicar em Transferir)'),
      h('label', {}, chkConf, 'Pedir confirmação antes de cada transferência')
    );
    const btnGo = h('button', { class: 'tf-go' });
    const btnStop = h('button', { class: 'tf-stop', text: '⏹ Parar' });
    const actions = h('div', { class: 'tf-actions' }, btnGo, btnStop);

    const linkLimpar = h('a', { text: 'limpar' });
    const logEl = h('div', { class: 'tf-log' });
    const logHead = h('div', { class: 'tf-loghead' }, h('span', { text: 'Log' }), linkLimpar);

    paneTf.append(top, listaEl, opts, actions, logHead, logEl);

    function log(proto, msg) {
      const d = new Date();
      const hora = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      tf.log.push(hora + (proto ? ' [' + proto + '] ' : ' ') + msg);
      if (tf.log.length > 300) tf.log.shift();
      logEl.textContent = tf.log.join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
    function setStatus(proto, tipo, txt) {
      tf.status.set(proto, { tipo, txt });
      refresh(true);
    }
    function atualizaBotoes() {
      const n = [...tf.sel].filter((p) => entries.some((e) => normProto(e.protocol) === p)).length;
      btnGo.textContent = tf.rodando ? '⏳ Transferindo…' : '🔁 Transferir selecionados (' + n + ')';
      btnGo.disabled = tf.rodando || n === 0;
      btnStop.style.display = tf.rodando ? '' : 'none';
      chkTeste.disabled = chkConf.disabled = tf.rodando;
    }

    function refresh(forcar) {
      if (!isAtiva()) return;
      const abertos = protocolosAbertos().achados;
      const protos = entries.map((e) => normProto(e.protocol));
      // remove seleção de protocolos que saíram do Registro
      [...tf.sel].forEach((p) => { if (!protos.includes(p)) tf.sel.delete(p); });

      const assin = JSON.stringify([protos, [...abertos], [...tf.sel], [...tf.status]]);
      if (!forcar && assin === tf.assinatura) return;
      tf.assinatura = assin;

      listaEl.textContent = '';
      if (!entries.length) {
        listaEl.appendChild(h('div', { class: 'empty', text: 'Nenhuma conversa no Registro. Abra os chats no Salesforce para que o protocolo seja capturado.' }));
      }
      entries.forEach((e) => {
        const p = normProto(e.protocol);
        const aberta = abertos.has(p);
        const st = tf.status.get(p);
        const chk = h('input', { type: 'checkbox' });
        chk.checked = tf.sel.has(p);
        chk.disabled = tf.rodando;
        const alterna = (v) => {
          if (tf.rodando) return;
          v ? tf.sel.add(p) : tf.sel.delete(p);
          refresh(true);
        };
        chk.addEventListener('change', () => alterna(chk.checked));
        const pill = st
          ? h('span', { class: 'pill ' + st.tipo, text: st.txt })
          : h('span', { class: 'pill ' + (aberta ? 'aberta' : 'fechada'), text: aberta ? 'aba aberta' : 'aba não encontrada' });
        const item = h('div', { class: 'tf-item' + (aberta ? '' : ' off') },
          chk,
          h('div', { class: 'info' },
            h('div', { class: 'p', text: p }),
            h('div', { class: 'c', text: 'CPF: ' + (e.cpf || '-') })
          ),
          pill
        );
        item.addEventListener('click', (ev) => { if (ev.target !== chk) alterna(!tf.sel.has(p)); });
        listaEl.appendChild(item);
      });

      const n = entries.filter((e) => tf.sel.has(normProto(e.protocol))).length;
      lblQtd.textContent = n + ' de ' + entries.length + ' selecionado(s)';
      chkTodos.checked = entries.length > 0 && n === entries.length;
      chkTodos.disabled = tf.rodando;
      atualizaBotoes();
    }
    hooks.tfRefresh = refresh;

    chkTodos.addEventListener('change', () => {
      if (tf.rodando) return;
      if (chkTodos.checked) entries.forEach((e) => tf.sel.add(normProto(e.protocol)));
      else tf.sel.clear();
      refresh(true);
    });
    btnAtualizar.addEventListener('click', () => { tf.status.clear(); refresh(true); });
    chkTeste.addEventListener('change', () => { ui.tfTeste = chkTeste.checked; saveUI(); });
    chkConf.addEventListener('change', () => { ui.tfConfirmar = chkConf.checked; saveUI(); });
    linkLimpar.addEventListener('click', () => { tf.log = []; logEl.textContent = ''; });
    btnStop.addEventListener('click', () => { tf.abortar = true; log('', 'Parando após o passo atual…'); });

    btnGo.addEventListener('click', () => {
      if (tf.rodando) return;
      const lista = entries.map((e) => normProto(e.protocol)).filter((p) => tf.sel.has(p));
      if (!lista.length) return;
      const aviso = ui.tfTeste ? '\n\n(MODO TESTE: nada será transferido)' : '';
      if (!confirm('Enviar a mensagem de encerramento e transferir ' + lista.length + ' chat(s) para "' +
        TRANSF.tituloFila + '"?\n\n' + lista.join('\n') + aviso)) return;
      lista.forEach((p) => tf.status.delete(p));
      executar(lista);
    });

    const tfTimer = setInterval(() => {
      if (!isAtiva()) { clearInterval(tfTimer); return; }
      if (ui.tab === 'tf' && !ui.minimized) refresh(false);
    }, 1500);

    refresh(true);
  })();

  setTimeout(scan, 1500);
})();