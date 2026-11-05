// ==UserScript==
// @name         Saúde no Campo – Painel unificado (Log + Remover atendimento)
// @namespace    https://saudenocampo.einstein.br/
// @version      2.0.0
// @description  Uma só janela com duas abas: Pesquisa de Log de Sincronização e Remover atendimento por ID.
// @match        https://saudenocampo.einstein.br/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const __antes = new Set(Array.from(document.documentElement.children));

  /* =======================================================================
   *  APLICATIVO 1 – Remover atendimento  (código original, sem alterações)
   * ======================================================================= */
  try {
(function () {
  'use strict';

  /* ===================== CONFIGURAÇÃO ===================== */
  const CFG = {
    motivoPadrao: 'Outros',          // opção do select "Motivo da remoção"
    justificativaPadrao: 'Duplicidade',
    esperaMax: 15000,                // tempo máximo (ms) esperando a tela responder
    // Seletores CSS opcionais (só preencha se a detecção automática falhar):
    sel: {
      abrirBusca: '',                // botão da lupa no topo da lista (abre o menu de busca)
      botaoRemoverLinha: ''          // botão laranja "Remover atendimento" dentro da linha
    }
  };
  /* ======================================================== */

  const ON_SITE = location.hostname === 'saudenocampo.einstein.br';
  const IS_TOP = window.top === window;
  const K_CMD = 'sc_cmd', K_EVT = 'sc_evt', K_HB = 'sc_hb', K_CLAIM = 'sc_claim';

  // ID único desta aba: o painel (janela principal) grava, e o robô (inclusive em iframes) lê.
  const TAB_ID = Math.random().toString(36).slice(2, 8);
  if (IS_TOP) { try { unsafeWindow.__scTab = TAB_ID; } catch (e) { /* ignora */ } }
  const myTab = () => { try { return unsafeWindow.top.__scTab || TAB_ID; } catch (e) { return TAB_ID; } };

  /* ---------- utilitários ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const visible = (el) =>
    !!el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
    getComputedStyle(el).visibility !== 'hidden';

  async function waitFor(fn, timeout = CFG.esperaMax, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) { /* ignora */ }
      await sleep(step);
    }
    return null;
  }

  function setValue(el, val) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try { const jq = unsafeWindow.jQuery; if (jq) jq(el).trigger('change'); } catch (e) { /* ignora */ }
  }

  /* =======================================================
   *  ROBÔ (roda no site Saúde no Campo)
   * ======================================================= */
  function startWorker() {
    let busy = false, pending = null, seq = 0;

    const TAB = Math.random().toString(36).slice(2, 8);
    let baseTitle = null;
    const markTitle = () => { if (baseTitle === null) { baseTitle = document.title; document.title = '🤖 ' + baseTitle; } };
    const restoreTitle = () => { if (baseTitle !== null) { document.title = baseTitle; baseTitle = null; } };

    const emit = (nonce, kind, text, data) => {
      if (kind === 'done' || kind === 'error' || kind === 'notfound') restoreTitle();
      GM_setValue(K_EVT, { nonce, kind, text: text || '', data: data || null, seq: ++seq, ts: Date.now() });
    };

    // Eleição entre várias abas do site que compartilham o mesmo armazenamento:
    // vence a última a gravar; abas visíveis gravam por último, então têm preferência.
    async function claim(nonce) {
      const visibleTab = document.visibilityState === 'visible';
      await sleep((visibleTab ? 300 : 0) + Math.random() * 120);
      GM_setValue(K_CLAIM, { nonce, tab: TAB, ts: Date.now() });
      await sleep(700);
      const w = GM_getValue(K_CLAIM) || {};
      return w.nonce === nonce && w.tab === TAB;
    }

    const isListPage = () => /Lista de Atendimentos/i.test(document.body ? document.body.innerText : '');

    // menu "Assistido" (td com onclick que abre o formulário de solicitações)
    function findAssistido() {
      return $$('td[onclick*="formulario-solicitacoes"], td').filter(visible)
        .find((td) => /^Assistido/i.test(norm(td.textContent)) && /AjaxPost/i.test(td.getAttribute('onclick') || ''));
    }

    async function ensureList() {
      if (isListPage()) return;
      const td = findAssistido();
      if (!td) throw new Error('Não estou na Lista de Atendimentos e não encontrei o menu "Assistido".');
      td.click();
      const ok = await waitFor(isListPage, 15000);
      if (!ok) throw new Error('Cliquei em "Assistido", mas a Lista de Atendimentos não abriu.');
      await waitStable(1000);
    }

    // batimento: avisa o painel que esta aba está pronta (na lista ou no menu "Assistido")
    setInterval(() => { if (isListPage() || findAssistido()) GM_setValue(K_HB, { ts: Date.now(), tab: myTab() }); }, 3000);

    const headName = (th) => norm(th.textContent).replace(/[^\p{L}\p{N}\s]/gu, '').trim();

    function findTable() {
      return $$('table').filter(visible).find((t) => $$('th', t).some((th) => headName(th) === 'ID'));
    }

    function getRows() {
      const t = findTable();
      if (!t) return [];
      const heads = $$('thead th', t).map(headName);
      const idx = (n) => heads.indexOf(n);
      return $$('tbody tr', t).filter(visible).map((tr) => {
        const tds = Array.from(tr.children).filter((c) => /^T[DH]$/.test(c.tagName));
        const ok = tds.length === heads.length;
        const cell = (n) => (ok && idx(n) >= 0 ? norm(tds[idx(n)].textContent) : '');
        const idCell = ok && idx('ID') >= 0 ? tds[idx('ID')] : tds[0];
        const m = norm(idCell ? idCell.textContent : '').match(/\d{3,}/);
        return {
          tr, id: m ? m[0] : '', status: cell('Status'), nome: cell('Nome'), cpf: cell('CPF'),
          raw: norm(tr.textContent).slice(0, 160)
        };
      });
    }

    const totalText = () => ((document.body.innerText.match(/Total:\s*\d+\s*registros?/i) || [''])[0]);

    async function waitStable(quiet = 1000, max = CFG.esperaMax) {
      const t0 = Date.now();
      let last = '', lastChange = Date.now();
      while (Date.now() - t0 < max) {
        const t = findTable();
        const snap = (t ? t.innerText : '') + '|' + totalText();
        const loading = /Carregando/i.test(document.body.innerText);
        if (snap !== last || loading) { last = snap; lastChange = Date.now(); }
        if (Date.now() - lastChange >= quiet) return true;
        await sleep(150);
      }
      return false;
    }

    /* ----- painel de busca (lupa) ----- */
    function findSearchPanel() {
      const inp = document.querySelector('#campo__id');
      if (!inp || !visible(inp)) return null;
      return document.querySelector('#formFiltro') || inp.closest('form') || inp.parentElement;
    }

    function findSearchToggle() {
      if (CFG.sel.abrirBusca) return document.querySelector(CFG.sel.abrirBusca);
      const inp = document.querySelector('#campo__id');
      const menu = inp ? inp.closest('.dropdown-menu, .popover') : null;
      const cands = $$('.glyphicon-search')
        .map((s) => s.closest('button, a, [data-toggle]') || s.parentElement)
        .filter((b) => b && visible(b) && !(menu && menu.contains(b)));
      return cands.find((b) => b.getBoundingClientRect().top < 140) || cands[0] || null;
    }

    async function openSearchPanel() {
      let p = findSearchPanel();
      if (p) return p;
      const toggle = findSearchToggle();
      if (!toggle) throw new Error('Não encontrei o botão da lupa no topo da lista (veja "Diagnóstico").');
      toggle.click();
      p = await waitFor(findSearchPanel, 5000);
      if (!p) throw new Error('Cliquei na lupa, mas o menu de busca não abriu.');
      return p;
    }

    const findIdInput = () => document.querySelector('#campo__id');

    function findIdButton(input) {
      const scope = input.closest('.input-group, .form-group') || input.closest('form') || document;
      const btns = $$('button, .btn', scope).filter(visible);
      const after = (b) => input.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      return btns.find((b) => after(b) && b.querySelector('.glyphicon-search')) || btns.find(after) || null;
    }

    function setSelectByRegex(sel, re, label) {
      const opt = Array.from(sel.options).find((o) => re.test(norm(o.text)));
      if (!opt) {
        throw new Error('Opção "' + label + '" não existe. Opções: ' +
          Array.from(sel.options).map((o) => norm(o.text)).join(' | '));
      }
      if (sel.value !== opt.value) setValue(sel, opt.value);
    }

    const statusSelects = (root) => $$('select', root).filter((s) =>
      Array.from(s.options).some((o) => /em aberto/i.test(o.text)));

    async function applyStatus(mode) {
      const re = mode === 'Finalizado' ? /finaliz/i : /em aberto/i;
      // 1) select de status do topo da lista (se existir fora do menu)
      if (mode !== 'Todos') {
        const top = statusSelects(document).filter(visible);
        top.forEach((s) => setSelectByRegex(s, re, mode));
        if (top.length) await waitStable(800);
      }
      // 2) menu da lupa
      let panel = await openSearchPanel();
      const cb = panel.querySelector('input[name="mostrarTodos"]');
      if (cb && cb.checked !== (mode === 'Todos')) {
        cb.click();                       // o próprio site submete o formulário (#formFiltro)
        await sleep(900);
        await waitStable(1000);
        panel = await openSearchPanel();  // a lista recarrega; reabre o menu
      }
      if (mode !== 'Todos') {
        const sel = statusSelects(panel)[0];
        if (sel) {
          const before = sel.value;
          setSelectByRegex(sel, re, mode);
          if (sel.value !== before) {
            await sleep(600);
            await waitStable(800);
            panel = await openSearchPanel();
          }
        }
      }
      return panel;
    }

    /* ----- 1) BUSCAR ----- */
    async function doSearch(cmd) {
      pending = null;
      await ensureList();
      emit(cmd.nonce, 'log', 'Aplicando status: ' + cmd.statusMode + '…');
      await applyStatus(cmd.statusMode);

      emit(cmd.nonce, 'log', 'Buscando o ID ' + cmd.id + '…');
      const input = await waitFor(() => { const i = findIdInput(); return i && visible(i) ? i : null; }, 5000);
      if (!input) throw new Error('Não encontrei o campo ID (#campo__id) no menu de busca.');
      input.focus();
      setValue(input, cmd.id);
      const btn = findIdButton(input);
      if (btn) btn.click();
      else {
        const jq = unsafeWindow.jQuery;
        if (!jq) throw new Error('Não encontrei o botão de buscar ao lado do campo ID.');
        jq('#formFiltro').submit();
      }

      await sleep(900);
      await waitStable();

      const rows = getRows();
      const exact = rows.filter((r) => r.id === cmd.id);
      if (!exact.length) {
        emit(cmd.nonce, 'notfound',
          'ID ' + cmd.id + ' NÃO localizado no status "' + cmd.statusMode + '" (' + (totalText() || 'sem total') + ').' +
          (cmd.statusMode !== 'Todos' ? ' Tente "Finalizado" ou "Todos".' : ''));
        await resetFilters();
        return;
      }
      if (exact.length > 1) {
        emit(cmd.nonce, 'error', 'Encontrei ' + exact.length + ' linhas com o ID ' + cmd.id + '. Cancelei por segurança.');
        return;
      }
      const r = exact[0];
      pending = { nonce: cmd.nonce, id: cmd.id, motivo: cmd.motivo, justificativa: cmd.justificativa };
      emit(cmd.nonce, 'found', 'ID localizado.', {
        id: r.id, status: r.status, nome: r.nome, cpf: r.cpf, raw: r.raw,
        outras: rows.length > 1 ? rows.length - 1 : 0
      });
    }

    async function resetFilters() {
      const b = $$('button, a').filter(visible).find((e) => /resetar filtros/i.test(norm(e.textContent)));
      if (b) { b.click(); await sleep(800); }
    }

    async function doCancel(cmd) {
      pending = null;
      await resetFilters();
      emit(cmd.nonce, 'done', 'Operação cancelada. Nada foi removido.');
    }

    /* ----- 2) REMOVER (só após confirmação no painel) ----- */
    const dialogs = () => $$('.modal, [role="dialog"], .swal2-popup, .bootbox').filter(visible);

    async function doRemove(cmd) {
      if (!pending || pending.nonce !== cmd.nonce) {
        throw new Error('Não há busca pendente para confirmar. Faça a busca novamente.');
      }
      const p = pending; pending = null;

      const row = getRows().find((r) => r.id === p.id);
      if (!row) throw new Error('A linha do ID ' + p.id + ' não está mais na tela. Refaça a busca.');

      emit(cmd.nonce, 'log', 'Clicando em "Remover atendimento"…');
      const icon = CFG.sel.botaoRemoverLinha
        ? row.tr.querySelector(CFG.sel.botaoRemoverLinha)
        : row.tr.querySelector('.glyphicon-ban-circle');
      if (!icon) throw new Error('Não encontrei o botão de inativar (ícone ban-circle) na linha.');
      (icon.closest('button, a') || icon).click();

      const motivo = await waitFor(() => { const m = document.querySelector('#motivoRemocao'); return m && visible(m) ? m : null; });
      if (!motivo) throw new Error('A janela "Remover Atendimento" não abriu (#motivoRemocao).');
      const modal = motivo.closest('.modal') || motivo.closest('form') || document;

      const alvo = p.motivo.toLowerCase();
      const opt = Array.from(motivo.options).find((o) => norm(o.text).toLowerCase() === alvo) ||
                  Array.from(motivo.options).find((o) => norm(o.text).toLowerCase().includes(alvo));
      if (!opt || !opt.value) {
        throw new Error('Motivo "' + p.motivo + '" não existe. Opções: ' +
          Array.from(motivo.options).map((o) => norm(o.text)).join(' | '));
      }
      setValue(motivo, opt.value);

      const ta = await waitFor(() => { const t = $$('textarea', modal).find(visible); return t || null; }, 5000);
      if (!ta) throw new Error('O campo "Justificativa" não apareceu após escolher o motivo.');
      ta.focus();
      setValue(ta, p.justificativa);

      const salvarIcon = modal.querySelector('.glyphicon-save');
      const salvar = (salvarIcon && salvarIcon.closest('button')) ||
        $$('button', modal).filter(visible).find((b) => /salvar/i.test(b.textContent));
      if (!salvar) throw new Error('Não encontrei o botão "Salvar".');
      salvar.click();

      emit(cmd.nonce, 'log', 'Confirmando o aviso (Sim)…');
      const sim = await waitFor(() =>
        $$('button').filter(visible).reverse().find((b) =>
          /^\s*sim\s*$/i.test(b.textContent) || (b.querySelector('.glyphicon-check') && /sim/i.test(b.textContent))), 6000);
      if (!sim) throw new Error('A pergunta "Deseja confirmar essa ação?" não apareceu.');
      sim.click();

      emit(cmd.nonce, 'log', 'Verificando se o registro saiu da lista…');
      const gone = await waitFor(() => {
        const m = document.querySelector('#motivoRemocao');
        return !(m && visible(m)) && !getRows().some((r) => r.id === p.id);
      }, 15000, 300);

      if (gone) emit(cmd.nonce, 'done', 'ID ' + p.id + ' REMOVIDO com sucesso.');
      else emit(cmd.nonce, 'error', 'Cliquei em "Sim", mas não consegui confirmar a remoção do ID ' + p.id +
        '. Confira na tela do sistema.');
    }

    function diag() {
      const t = findTable();
      const rows = getRows();
      return [
        'Lista de Atendimentos: ' + isListPage() + ' | menu Assistido: ' + !!findAssistido(),
        'Tabela encontrada: ' + !!t + ' | linhas: ' + rows.length,
        'Botão da lupa: ' + !!findSearchToggle() + ' | campo #campo__id: ' + !!findIdInput(),
        'Menu de busca aberto: ' + !!findSearchPanel(),
        'Checkbox mostrarTodos: ' + !!document.querySelector('input[name="mostrarTodos"]'),
        'Selects de status: ' + statusSelects(document).length,
        'Total: ' + (totalText() || '-')
      ].join('\n');
    }

    GM_addValueChangeListener(K_CMD, async (n, o, cmd) => {
      if (!cmd || !(isListPage() || findAssistido())) return;
      if (cmd.target && cmd.target !== myTab()) return;        // comando de outra aba
      if (cmd.type === 'confirm' || cmd.type === 'cancel') {
        if (!pending || pending.nonce !== cmd.nonce) return;   // não é comigo
      } else if (!(await claim(cmd.nonce))) {
        return;                                                // outra aba assumiu
      }
      if (cmd.type === 'diag') { emit(cmd.nonce, 'info', 'Aba ' + TAB + '\n' + diag()); return; }
      if (busy) { emit(cmd.nonce, 'error', 'O robô está ocupado. Aguarde e tente de novo.'); return; }
      if (cmd.type === 'search') markTitle();
      busy = true;
      try {
        if (cmd.type === 'search') await doSearch(cmd);
        else if (cmd.type === 'confirm') await doRemove(cmd);
        else if (cmd.type === 'cancel') await doCancel(cmd);
      } catch (e) {
        emit(cmd.nonce, 'error', e && e.message ? e.message : String(e));
      } finally {
        busy = false;
      }
    });
  }

  /* =======================================================
   *  PAINEL (aparece no Salesforce e no próprio site)
   * ======================================================= */
  function startPanel() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:16px;bottom:16px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:Segoe UI,Arial,sans-serif;font-size:13px}
        #fab{touch-action:none;background:#0b5cab;color:#fff;padding:9px 14px;border-radius:20px;cursor:pointer;box-shadow:0 2px 8px #0005;user-select:none}
        #card{width:330px;max-width:98vw;max-height:98vh;position:relative;display:flex;flex-direction:column;background:#fff;color:#222;border:1px solid #ccd;border-radius:10px;box-shadow:0 6px 24px #0004;overflow:hidden}
        #card[hidden]{display:none}
        .hd{background:#0b5cab;color:#fff;padding:9px 12px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;touch-action:none}
        .hd b{font-size:14px}.x{cursor:pointer;padding:0 6px}
        .bd{padding:12px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow:auto}
        #rz{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 50%,#0b5cab 50%,#0b5cab 58%,transparent 58%,transparent 72%,#0b5cab 72%,#0b5cab 80%,transparent 80%)}
        label{font-weight:600;font-size:12px;color:#445}
        input,select{width:100%;padding:7px;border:1px solid #bbc;border-radius:6px}
        .row{display:flex;gap:8px}.row>div{flex:1}
        button{padding:8px 10px;border:0;border-radius:6px;cursor:pointer;color:#fff;background:#0b5cab;font-weight:600}
        button:disabled{opacity:.5;cursor:not-allowed}
        .danger{background:#c62828}.gray{background:#667}
        #st{font-size:12px}
        #log{max-height:90px;overflow:auto;font-size:11px;color:#556;white-space:pre-wrap}
        #msg{padding:8px;border-radius:6px;display:none;white-space:pre-wrap}
        .ok{background:#e6f4ea;color:#14532d}.err{background:#fdecea;color:#7f1d1d}.warn{background:#fff4e0;color:#7a4b00}
        #conf{display:none;border:2px solid #c62828;border-radius:8px;padding:10px;background:#fff6f6}
        #conf h4{margin:0 0 6px;color:#c62828;font-size:13px}
        #conf dl{margin:0 0 8px}#conf dt{font-weight:700;display:inline}#conf dd{display:inline;margin:0}
        #conf div.l{margin:2px 0}
        a{color:#0b5cab;cursor:pointer;font-size:11px}
      </style>
      <div id="fab">🗑 Remover atendimento</div>
      <div id="card" hidden>
        <div class="hd"><b>Remover atendimento</b><span class="x" id="x">✕</span></div>
        <div class="bd">
          <div id="st"></div>
          <div><label>ID do atendimento</label><input id="id" inputmode="numeric" placeholder="ex.: 4646576"></div>
          <div class="row">
            <div><label>Status</label>
              <select id="status"><option>Em aberto</option><option>Finalizado</option><option>Todos</option></select></div>
            <div><label>Motivo</label><input id="motivo"></div>
          </div>
          <div><label>Justificativa</label><input id="just"></div>
          <button id="buscar">Buscar ID</button>
          <div id="conf">
            <h4>Confirme antes de remover</h4>
            <dl id="dados"></dl>
            <div class="row">
              <button class="danger" id="sim">Confirmar remoção</button>
              <button class="gray" id="nao">Cancelar</button>
            </div>
          </div>
          <div id="msg"></div>
          <div id="log"></div>
          <a id="diag">Diagnóstico</a>
        </div>
        <div id="rz" title="Arraste para redimensionar"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    $('motivo').value = CFG.motivoPadrao;
    $('just').value = CFG.justificativaPadrao;

    let nonce = null, timer = null;
    let lastHb = ON_SITE ? 0 : (((GM_getValue(K_HB) || {}).ts) || 0);
    GM_addValueChangeListener(K_HB, (n, o, v) => { if (v && (!ON_SITE || v.tab === TAB_ID)) lastHb = v.ts; });

    const online = () => Date.now() - lastHb < 8000;
    const paintStatus = () => {
      $('st').textContent = online()
        ? '🟢 Conectado ao Saúde no Campo'
        : '🔴 Aba do Saúde no Campo não encontrada. Abra o sistema nela e recarregue a página.';
    };
    setInterval(paintStatus, 2000); paintStatus();

    /* ----- mover e redimensionar a janela ----- */
    const K_UI = 'sc_ui';
    const card = $('card');
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    let ui = {}; try { ui = GM_getValue(K_UI) || {}; } catch (e) { /* ignora */ }
    let dragged = false;

    const toTopLeft = () => {            // troca a âncora (esquerda/embaixo) por esquerda/topo
      const r = host.getBoundingClientRect();
      host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.bottom = 'auto';
    };
    const fit = () => {                  // mantém a janela dentro da tela
      if (host.style.bottom !== 'auto') return;
      const r = host.getBoundingClientRect();
      host.style.left = clamp(r.left, 0, Math.max(0, innerWidth - r.width)) + 'px';
      host.style.top = clamp(r.top, 0, Math.max(0, innerHeight - r.height)) + 'px';
    };
    const saveUI = () => {
      const r = host.getBoundingClientRect();
      ui = { left: r.left, top: r.top, w: parseInt(card.style.width) || 0, h: parseInt(card.style.height) || 0 };
      try { GM_setValue(K_UI, ui); } catch (e) { /* ignora */ }
    };

    if (ui.w) card.style.width = clamp(ui.w, 280, innerWidth) + 'px';
    if (ui.h) card.style.height = clamp(ui.h, 220, innerHeight) + 'px';
    if (typeof ui.left === 'number') {
      host.style.left = clamp(ui.left, 0, Math.max(0, innerWidth - 80)) + 'px';
      host.style.top = clamp(ui.top, 0, Math.max(0, innerHeight - 40)) + 'px';
      host.style.bottom = 'auto';
    }

    const makeDraggable = (handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.id === 'x') return;
        dragged = false;
        const r = host.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          if (!dragged && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
          dragged = true;
          host.style.bottom = 'auto';
          host.style.left = clamp(ev.clientX - dx, 0, Math.max(0, innerWidth - 60)) + 'px';
          host.style.top = clamp(ev.clientY - dy, 0, Math.max(0, innerHeight - 40)) + 'px';
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          if (dragged) saveUI();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    };
    makeDraggable(root.querySelector('.hd'));
    makeDraggable($('fab'));

    $('rz').addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const h = $('rz');
      toTopLeft();
      const r = host.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, w0 = card.offsetWidth, h0 = card.offsetHeight;
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        card.style.width = clamp(w0 + ev.clientX - sx, 280, innerWidth - r.left) + 'px';
        card.style.height = clamp(h0 + ev.clientY - sy, 220, innerHeight - r.top) + 'px';
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        saveUI();
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });

    $('fab').onclick = () => {
      if (dragged) { dragged = false; return; }   // foi um arrastar, não um clique
      $('card').hidden = false; $('fab').style.display = 'none';
      requestAnimationFrame(fit);
    };
    $('x').onclick = () => { $('card').hidden = true; $('fab').style.display = ''; };

    const msg = (text, cls) => { const m = $('msg'); m.textContent = text; m.className = cls; m.style.display = text ? 'block' : 'none'; };
    const log = (t) => { const l = $('log'); l.textContent += t + '\n'; l.scrollTop = l.scrollHeight; };
    const lock = (v) => { $('buscar').disabled = v; };
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => { msg('Sem resposta da aba do Saúde no Campo.', 'err'); lock(false); }, ms);
    };
    const send = (type, extra) => {
      GM_setValue(K_CMD, Object.assign({ type, nonce, ts: Date.now(), target: ON_SITE ? TAB_ID : undefined }, extra || {}));
    };

    $('buscar').onclick = () => {
      const id = $('id').value.trim();
      if (!/^\d{3,}$/.test(id)) { msg('Digite um ID válido (somente números).', 'warn'); return; }
      if (!online()) { msg('A aba do Saúde no Campo não está pronta (veja o aviso vermelho acima).', 'err'); return; }
      nonce = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      $('conf').style.display = 'none'; $('log').textContent = ''; msg('', '');
      lock(true); arm(60000);
      send('search', {
        id, statusMode: $('status').value,
        motivo: $('motivo').value.trim() || CFG.motivoPadrao,
        justificativa: $('just').value.trim() || CFG.justificativaPadrao
      });
    };

    $('sim').onclick = () => { $('conf').style.display = 'none'; arm(60000); send('confirm'); };
    $('nao').onclick = () => { $('conf').style.display = 'none'; arm(15000); send('cancel'); };
    $('diag').onclick = () => { nonce = 'diag-' + Date.now(); arm(8000); send('diag'); };

    GM_addValueChangeListener(K_EVT, (n, o, e) => {
      if (!e || e.nonce !== nonce) return;
      if (e.kind === 'log') { log('• ' + e.text); arm(60000); return; }
      clearTimeout(timer);
      if (e.kind === 'found') {
        const d = e.data, box = $('dados');
        box.textContent = '';
        [['ID', d.id], ['Status', d.status || '-'], ['Nome', d.nome || '-'], ['CPF', d.cpf || '-']].forEach(([k, v]) => {
          const line = document.createElement('div'); line.className = 'l';
          const dt = document.createElement('dt'); dt.textContent = k + ': ';
          const dd = document.createElement('dd'); dd.textContent = v;
          line.append(dt, dd); box.appendChild(line);
        });
        if (!d.nome && d.raw) {
          const r = document.createElement('div'); r.className = 'l'; r.textContent = d.raw; box.appendChild(r);
        }
        $('sim').textContent = 'Remover o ID ' + d.id;
        $('conf').style.display = 'block';
        msg('ID localizado. Confira os dados e confirme.', 'ok');
        return;
      }
      if (e.kind === 'notfound') msg(e.text, 'warn');
      else if (e.kind === 'done') msg(e.text, 'ok');
      else if (e.kind === 'info') msg(e.text, 'warn');
      else msg(e.text, 'err');
      lock(false);
    });
  }

  if (ON_SITE) startWorker();
  if (IS_TOP) startPanel();
})();
  } catch (e) { console.error('[painel unificado] Remover atendimento:', e); }

  // janela criada pelo "Remover atendimento" (só existe na janela principal)
  const __rmHost = Array.from(document.documentElement.children).find((n) => !__antes.has(n) && n.shadowRoot) || null;

  /* =======================================================================
   *  APLICATIVO 2 – Busca no Log de Sincronização  (código original, sem alterações)
   *  Roda com "window" = unsafeWindow, para continuar enxergando AjaxPost,
   *  buscarEventos e jQuery da página (o original usava @grant none).
   * ======================================================================= */
  try {
    (function (window) {
(function () {
  'use strict';

  /* ============================== CONFIG ============================== */
  const CFG = {
    curlUrl: '',                        // endpoint do cURL (vazio = preencher no Insomnia)
    apiToken: '$.apiToken',             // valor literal do apiToken no cURL
    // parâmetros do log que NÃO entram no cURL (igual ao seu exemplo)
    curlExclude: ['saveForm', 'fromInstituicao', 'idAgendamento', 'idResumoFormulario', 'local_id'],
    quietMs: 800,                       // tempo sem mutação no DOM p/ considerar "carregou"
    timeoutMs: 30000,                   // timeout de cada carregamento AJAX
    storeKey: 'slf-state-v1',
  };

  // Campos do layout. Grupo null = raiz do "query". String = campo escalar.
  const LAYOUT = [
    [null, ['saveForm', 'idFormulario', 'idSolicitacao', 'idInstituicao', 'fromInstituicao', 'idAgendamento', 'idResumoFormulario', 'local_id', 'idVisita']],
    ['propriedade', ['cab_PropriedadeName', 'cab_nomePropriedade', 'cab_nomePropriedadeTecnico', 'cab_AutoPreencher', 'cab_idPropriedade']],
    ['status', ['cab_StatusVisita', 'cab_MotivoDevolucao', 'cab_MotivoReprovacao', 'cab_ObservacaoRemocao']],
    ['programa', ['cab_IdATeG', 'cab_IdSaudeCampo', 'cab_Modulo', 'cab_Grupo']],
    ['produtor', ['cab_NomeProdutor', 'cab_CPFProdutor', 'cab_Estado', 'cab_Municipio', 'cab_telefonePropriedade']],
    ['agendamento', ['cab_agendamento', 'cab_idAgenda', 'cab_idFormulario', 'cab_idInstituicao', 'cab_idSala']],
    ['atendimento', ['cab_LinkVideo', 'cab_ContatoRealizadoSucesso', 'cmp_Especialidade', 'cab_QuantidadePessoasVisita']],
    ['checkin', ['cab_FotoCheckin', 'cab_FotoCheckin_name', 'cab_DataCheckin', 'cab_HoraCheckin', 'cab_GeolocalizacaoCheckin', 'cab_idUsuarioCheckin', 'cab_GeolocalizacaoPrecisaoCheckin']],
    ['resumoVisita', 'cab_BreveResumoVisita'],
    ['proximaVisita', ['cab_PrevisaoProximaVisitaData', 'cab_PrevisaoProximaVisitaHoraInicio', 'cab_PrevisaoProximaVisitaHoraFim']],
    ['validacoes', ['cab_ValidaAlertaVistaMesmoMes', 'cab_ValidaAlertaVisitaRetroativa', 'cab_ValidaAlertaFimModulo', 'cab_validacao_alerta_visita']],
    ['periodoModulo', ['cab_FimPeriodo', 'cab_DataFimModulo', 'cab_DiasFimPeriodoModulo']],
    ['calculoVisita', ['cab_DiasProximaVisitaData', 'cab_CauculoData', 'cab_TempoDuracaoVisita']],
    ['checkout', ['cab_DataCheckout', 'cab_HoraCheckout', 'cab_GeolocalizacaoCheckout', 'cab_idUsuarioCheckout', 'cab_GeolocalizacaoPrecisaoCheckout', 'cab_FotoCheckout', 'cab_FotoCheckout_name']],
    ['tecnico', ['cab_TecnicoAtribuido']],
    ['logs', ['cab_Logs_tentativas']],
  ];

  // Nomes alternativos usados por outros formulários (ex.: 1002 usa ate_*)
  const ALIASES = {
    idVisita: ['ate_IDVisita'],
    cab_Estado: ['ate_Estado'],
    cab_Grupo: ['ate_Grupo'],
    cmp_Especialidade: ['cmp_Espec'],
  };

  /* ============================== UTILS ============================== */
  const $ = (s, r = document) => r.querySelector(s);
  const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const decodeLoose = (s) => String(s).replace(/\+/g, ' ')
    .replace(/(%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
  const esc = (s) => String(s).replace(/'/g, `'\\''`);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const getCont = () => document.getElementById('conteudo') || document.body;

  function waitQuiet(target, { quiet = CFG.quietMs, timeout = CFG.timeoutMs } = {}) {
    return new Promise((resolve) => {
      let qt = null, changed = false;
      const done = (v) => { obs.disconnect(); clearTimeout(qt); clearTimeout(tt); resolve(v); };
      const obs = new MutationObserver((muts) => {
        if (!muts.some((m) => !panel.contains(m.target))) return;
        changed = true;
        clearTimeout(qt);
        qt = setTimeout(() => done(true), quiet);
      });
      obs.observe(target, { childList: true, subtree: true, characterData: true });
      const tt = setTimeout(() => done(changed), timeout);
    });
  }

  function waitFor(fn, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        const v = fn();
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return reject(new Error('elemento não apareceu a tempo'));
        setTimeout(tick, 200);
      })();
    });
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
  }

  /* ============================== PARSER ============================== */
  function deepFind(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return { parent: obj, value: obj[key] };
    for (const v of Object.values(obj)) {
      const r = deepFind(v, key, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // Campos de usuário/técnico que o log possa ter fora do "query"
  function collectUserFields(obj, depth = 0, out = []) {
    if (!obj || typeof obj !== 'object' || depth > 5) return out.join(' | ');
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'query' || k === 'response') continue;
      if (v && typeof v === 'object') collectUserFields(v, depth + 1, out);
      else if (/usu|tecn|user|login|operador/i.test(k) && v != null && String(v).length <= 200) out.push(String(v));
    }
    return out.join(' | ');
  }

  function parseLog(text) {
    if (!text) return null;

    // 1) tenta JSON completo
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        const obj = JSON.parse(text.slice(a, b + 1));
        const q = deepFind(obj, 'query');
        if (q && q.value != null) {
          const resp = deepFind(obj, 'response');
          return {
            extra: collectUserFields(obj),
            query: q.value,
            horaSolicitado: q.parent.horaSolicitado ?? (deepFind(obj, 'horaSolicitado') || {}).value ?? '',
            code: obj.code ?? '',
            error: obj.error ?? '',
            response: resp && typeof resp.value === 'object' ? resp.value : {},
          };
        }
      } catch { /* segue p/ regex */ }
    }

    // 2) regex (log truncado / não-JSON)
    const r = { query: null, horaSolicitado: '', code: '', error: '', response: {}, extra: '' };
    r.extra = [...text.matchAll(/"([\w]*(?:usu|tecn|user|login|operador)[\w]*)"\s*:\s*"([^"]{1,200})"/gi)].map((x) => x[2]).join(' | ');
    let m = text.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try { r.query = JSON.parse('"' + m[1] + '"'); } catch { r.query = m[1]; }
    } else {
      const i = text.search(/(saveForm|idFormulario)=/);
      if (i >= 0) {
        let s = i, e = i;
        while (s > 0 && !/[\s"'<>]/.test(text[s - 1])) s--;
        while (e < text.length && !/[\s"'<>]/.test(text[e])) e++;
        r.query = text.slice(s, e);
      }
    }
    if (!r.query) return null;

    const g = (re, src = text) => { const x = src.match(re); return x ? x[1] : ''; };
    r.horaSolicitado = g(/"horaSolicitado"\s*:\s*"?(\d+)/);
    r.code = g(/"code"\s*:\s*"([^"]*)"/);
    r.error = g(/"error"\s*:\s*"([^"]*)"/);
    const ri = text.search(/"response"\s*:/);
    if (ri >= 0) {
      const rs = text.slice(ri);
      const succ = g(/"success"\s*:\s*(true|false)/, rs);
      r.response = {
        success: succ === '' ? '' : succ === 'true',
        error: g(/"error"\s*:\s*"([^"]*)"/, rs),
        idSolicitacao: g(/"idSolicitacao"\s*:\s*"?(\d+)/, rs),
      };
    }
    return r;
  }

  function toEntries(query) {
    const out = [];
    if (typeof query === 'string') {
      for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ''))) out.push([k, v]);
    } else if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (k === 'horaSolicitado') continue;
        if (Array.isArray(v)) v.forEach((x) => out.push([k, typeof x === 'object' ? JSON.stringify(x) : String(x)]));
        else if (v && typeof v === 'object') out.push([k, JSON.stringify(v)]);
        else out.push([k, v == null ? '' : String(v)]);
      }
    }
    return out;
  }

  function buildRecord(parsed) {
    const map = new Map();
    for (const [k, v] of toEntries(parsed.query)) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(v);
    }
    return { ...parsed, map };
  }

  function resolve(map, key) {
    if (map.has(key)) return { src: key, vals: map.get(key) };
    for (const al of ALIASES[key] || []) if (map.has(al)) return { src: al, vals: map.get(al) };
    return null;
  }
  const valOf = (vals) => (vals.length > 1 ? vals : vals[0]);

  function buildJson(rec) {
    const used = new Set();
    const q = {};
    for (const [grp, keys] of LAYOUT) {
      if (typeof keys === 'string') {
        const r = resolve(rec.map, keys);
        if (r) used.add(r.src);
        q[grp] = r ? valOf(r.vals) : '';
        continue;
      }
      const tgt = grp ? (q[grp] = {}) : q;
      for (const k of keys) {
        const r = resolve(rec.map, k);
        if (r) used.add(r.src);
        tgt[k] = r ? valOf(r.vals) : '';
      }
    }
    const outros = {};
    for (const [k, vals] of rec.map) {
      if (used.has(k)) continue;
      let v = valOf(vals);
      if (k === 'antecedentes' && typeof v === 'string') { try { v = JSON.parse(v); } catch { /* mantém string */ } }
      outros[k] = v;
    }
    if (Object.keys(outros).length) q.outros = outros;

    const hs = rec.horaSolicitado;
    const resp = rec.response || {};
    return {
      query: q,
      horaSolicitado: /^\d+$/.test(String(hs)) ? Number(hs) : hs,
      code: rec.code,
      error: rec.error,
      response: { success: resp.success ?? '', error: resp.error ?? '', idSolicitacao: resp.idSolicitacao ?? '' },
    };
  }

  function buildCurl(rec, { expand = true, omitEmpty = false } = {}) {
    const used = new Set();
    const lines = [];
    const add = (k, v) => {
      v = v == null ? '' : String(v);
      if (omitEmpty && v === '') return;
      lines.push(`--data '${esc(k)}=${esc(v)}'`);
    };

    add('apiToken', CFG.apiToken);
    const ordered = ['idFormulario', 'idSolicitacao', 'idInstituicao', 'idVisita',
      ...LAYOUT.slice(1).flatMap(([, k]) => (Array.isArray(k) ? k : [k]))];

    for (const k of ordered) {
      const r = resolve(rec.map, k);
      if (r) { used.add(r.src); r.vals.forEach((v) => add(k, v)); }
      else if (k === 'idVisita') {
        const s = resolve(rec.map, 'idSolicitacao');
        if (s) add('idVisita', s.vals[0]);
      }
    }

    for (const [k, vals] of rec.map) {
      if (used.has(k) || CFG.curlExclude.includes(k)) continue;
      if (k === 'antecedentes' && expand) {
        let o = null;
        try { o = JSON.parse(vals[0]); } catch { /* não é JSON */ }
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          for (const [ak, av] of Object.entries(o)) {
            if (Array.isArray(av)) {
              if (!av.length) add(ak + '[]', '');
              else av.forEach((x) => add(ak + '[]', typeof x === 'object' ? JSON.stringify(x) : x));
            } else {
              add(ak, av && typeof av === 'object' ? JSON.stringify(av) : av);
            }
          }
          continue;
        }
      }
      vals.forEach((v) => add(k, v));
    }

    const body = [
      `--url '${esc(CFG.curlUrl)}'`,
      `--header 'Content-Type: application/x-www-form-urlencoded'`,
      ...lines,
    ].map((l) => '  ' + l);
    return ['curl --request POST', ...body].join(' \\\n');
  }

  /* ============================== SCAN DA PÁGINA ============================== */
  const MARKER = /saveForm=|"query"\s*:|idFormulario=/;
  const textOf = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.textContent) || '';

  function getBlocks(root) {
    const set = new Set();
    root.querySelectorAll('tr').forEach((tr) => {
      if (panel.contains(tr)) return;
      if (tr.querySelector('td') && !tr.querySelector('tr')) set.add(tr);
    });
    root.querySelectorAll('pre,code,textarea,td,div,li,p,span').forEach((el) => {
      if (panel.contains(el) || el.closest('tr')) return;
      if (!MARKER.test(textOf(el))) return;
      if ([...el.children].some((c) => MARKER.test(textOf(c)))) return; // fica só com o menor
      set.add(el);
    });
    return [...set];
  }

  function rawOf(block) {
    const parts = [block.textContent || ''];
    block.querySelectorAll('textarea,input').forEach((i) => parts.push(i.value || ''));
    const els = [block, ...block.querySelectorAll('*')];
    for (const el of els) for (const at of el.attributes) {
      if (/^(data-|onclick|title|value)/i.test(at.name) && at.value.length > 20) parts.push(at.value);
    }
    return parts.join('\n');
  }

  // Campos usados na busca precisa
  const ID_FIELDS = ['idSolicitacao'];
  const TECH_FIELDS = ['cab_TecnicoAtribuido', 'cab_NomeTecnico', 'cab_Tecnico', 'ate_Tecnico', 'cab_TecnicoResponsavel'];

  // Busca precisa: ID = igualdade exata em idSolicitacao (query ou response);
  // técnico = só campos de técnico/usuário + colunas da linha que não são o log (nunca dentro dos dados do paciente)
  function matchRecord(rec, ctx, f) {
    if (f.id) {
      const ids = ID_FIELDS.flatMap((k) => rec.map.get(k) || []);
      if (rec.response && rec.response.idSolicitacao != null) ids.push(rec.response.idSolicitacao);
      if (!ids.some((v) => String(v).trim() === f.id)) return false;
    }
    if (f.user) {
      const hay = norm([...TECH_FIELDS.flatMap((k) => rec.map.get(k) || []), rec.extra || '', ctx || ''].join(' | '));
      if (!hay.includes(norm(f.user))) return false;
    }
    return true;
  }

  // Texto da linha fora do log (ex.: coluna "Usuário" da tabela)
  function contextOf(blk) {
    if (blk.tagName !== 'TR') return '';
    return [...blk.children].filter((td) => !MARKER.test(td.textContent || '')).map((td) => td.textContent.trim()).join(' | ');
  }

  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + str.length;
  }
  // Impressão digital do log: mesmo conteúdo + mesma hora = duplicado
  const fingerprint = (o) => (o.rec
    ? hashStr(JSON.stringify([...o.rec.map]) + '|' + o.rec.horaSolicitado + '|' + o.rec.code + '|' + o.rec.error)
    : 'raw:' + hashStr(o.raw));

  // Separa um texto com vários logs em um segmento por log
  function splitLogs(text) {
    let idx = [...text.matchAll(/"query"\s*:/g)].map((m) => m.index);
    if (idx.length < 2) {
      const alt = [...text.matchAll(/(?:^|[^\w%])saveForm=/g)].map((m) => m.index);
      if (alt.length >= 2) idx = alt;
    }
    if (idx.length < 2) return null;
    return {
      prefix: text.slice(0, idx[0]),
      segs: idx.map((s, i) => text.slice(s, idx[i + 1] ?? text.length)),
    };
  }

  function scanPage(root, f, page) {
    const out = [];
    const noFilter = !f.user && !f.id;
    for (const blk of getBlocks(root)) {
      const ctx = contextOf(blk);
      const sp = splitLogs(blk.textContent || '');
      const segs = sp ? sp.segs : [rawOf(blk)];
      const pre = sp ? sp.prefix : '';
      for (const seg of segs) {
        const parsed = parseLog(seg);
        if (!parsed) {
          // linha sem o log no DOM: só entra se o técnico bater na própria linha e não houver filtro de ID
          if (!noFilter && !f.id && f.user && norm(ctx).includes(norm(f.user))) {
            out.push({ page, rowText: ctx.slice(0, 160), raw: (blk.textContent || '').trim(), rec: null });
          }
          continue;
        }
        const rec = buildRecord(parsed);
        if (!noFilter && !matchRecord(rec, ctx + ' | ' + pre, f)) continue;
        out.push({
          page,
          rowText: (sp ? seg : (blk.innerText || blk.textContent || '')).trim().replace(/\s+/g, ' ').slice(0, 160),
          raw: (sp ? seg : (blk.textContent || '')).trim(),
          rec,
        });
      }
    }
    return out;
  }

  /* ============================== NAVEGAÇÃO ============================== */
  async function openLogPage() {
    if ($('#de') && $('#ate') && $('#conteudo .glyphicon-search')) return;
    const cont = getCont();
    const p = waitQuiet(cont);
    if (typeof window.AjaxPost === 'function') {
      window.AjaxPost('sincronizacao-auditoria', 'conteudo', '');
    } else {
      const link = [...document.querySelectorAll('a')].find((a) => /Log de Sincroniza/i.test(a.textContent));
      if (!link) throw new Error('link "Log de Sincronização" não encontrado');
      link.click();
    }
    await p;
    await waitFor(() => $('#de') && $('#ate'));
  }

  function setDate(el, v) {
    el.value = v;
    if (window.jQuery) window.jQuery(el).val(v).trigger('change');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickSearch() {
    const ic = $('#conteudo .glyphicon-search') || $('.glyphicon-search');
    if (!ic) throw new Error('botão de busca não encontrado');
    (ic.closest('button,a,input,[onclick]') || ic).click();
  }

  function getMaxPage(root) {
    let max = 1;
    for (const m of root.innerHTML.matchAll(/buscarEventos\((\d+)\)/g)) max = Math.max(max, +m[1]);
    return max;
  }

  // Página ativa na paginação do site (null se não der para identificar)
  function activePage(root) {
    const a = root.querySelector('.pagination a.active, .pagination li.active > a, .pagination li.active > span');
    const n = a ? parseInt(a.textContent, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  // Assinatura do conteúdo da listagem (sem a paginação)
  function contentSig(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('.pagination').forEach((x) => x.remove());
    return hashStr(clone.textContent || '');
  }
  function waitUntil(fn, timeout) {
    return new Promise((res) => {
      const t0 = Date.now();
      (function tick() {
        if (fn()) return res(true);
        if (Date.now() - t0 > timeout) return res(false);
        setTimeout(tick, 150);
      })();
    });
  }
  function triggerPage(n) {
    if (typeof window.buscarEventos === 'function') return window.buscarEventos(n);
    const a = $(`a[href="javascript:buscarEventos(${n})"]`);
    if (!a) throw new Error(`página ${n} não encontrada`);
    a.click();
  }
  // Só retorna true quando a página n está ativa E o conteúdo mudou de fato
  async function goToPage(n) {
    const cont = getCont();
    const before = contentSig(cont);
    for (let attempt = 1; attempt <= 3; attempt++) {
      triggerPage(n);
      const ok = await waitUntil(() => {
        const ap = activePage(cont);
        return (ap === null || ap === n) && contentSig(cont) !== before;
      }, CFG.timeoutMs / 2);
      if (ok) {
        await waitQuiet(cont, { quiet: 400, timeout: 3000 }); // deixa terminar de renderizar
        return true;
      }
    }
    return false;
  }

  /* ============================== UI ============================== */
  const css = `
#slf-panel{position:fixed;z-index:2147483646;top:80px;right:20px;width:580px;height:640px;min-width:360px;min-height:220px;resize:both;overflow:hidden;display:flex;flex-direction:column;background:#1e1f24;color:#e6e6e6;border:1px solid #3a3d46;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);font:12px/1.4 system-ui,"Segoe UI",Arial,sans-serif}
#slf-panel *{box-sizing:border-box}
#slf-panel.min{height:auto!important;min-height:0!important;width:270px!important;min-width:0!important;resize:none!important}
#slf-panel.min #slf-body{display:none}
#slf-panel.min #slf-head{border-bottom:0;border-radius:8px}
#slf-badge{display:none;background:#3b6fd8;color:#fff;border-radius:9px;padding:0 7px;font-size:11px;line-height:18px}
#slf-badge.on{display:inline-block}
.slf-date{position:relative;display:flex}
#slf-panel .slf-date input[type=text]{padding-right:30px;letter-spacing:.5px;font-variant-numeric:tabular-nums}
.slf-cal{position:absolute;right:3px;top:50%;transform:translateY(-50%);background:transparent;border:0;cursor:pointer;font-size:13px;padding:2px 4px;line-height:1;opacity:.8}
.slf-cal:hover{opacity:1}
.slf-native{position:absolute;left:0;bottom:0;width:100%;height:1px;opacity:0;pointer-events:none;border:0;padding:0;color-scheme:dark}
#slf-panel input.inv{border-color:#ff7b7b}
.slf-chip{background:#2a2c33;color:#cfd2da;border:1px solid #3a3d46;border-radius:12px;padding:2px 10px;cursor:pointer;font-size:11px}
.slf-chip:hover{border-color:#3b6fd8;color:#fff}
#slf-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2a2c33;cursor:move;user-select:none;border-bottom:1px solid #3a3d46;border-radius:8px 8px 0 0}
#slf-head b{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#slf-head button{background:#40434d;color:#e6e6e6;border:0;border-radius:4px;width:22px;height:20px;cursor:pointer;line-height:1}
#slf-body{flex:1;display:flex;flex-direction:column;gap:6px;padding:8px;min-height:0}
.slf-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#slf-panel label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#a9adb8;font-weight:normal;margin:0}
#slf-panel label.chk{flex-direction:row;align-items:center;gap:4px}
#slf-panel input[type=text]{background:#14151a;color:#e6e6e6;border:1px solid #3a3d46;border-radius:4px;padding:4px 6px;font-size:12px;height:auto;width:100%}
.slf-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.slf-btn{background:#3b6fd8;color:#fff;border:0;border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px}
.slf-btn.sec{background:#40434d}
.slf-btn:disabled{opacity:.45;cursor:default}
#slf-status{font-size:11px;color:#a9adb8;min-height:15px}
#slf-status.err{color:#ff7b7b}#slf-status.warn{color:#f0c060}#slf-status.ok{color:#7bd88f}
#slf-bar{height:4px;background:#14151a;border-radius:2px;overflow:hidden}
#slf-bar i{display:block;height:100%;width:0;background:#3b6fd8;transition:width .2s}
.slf-nav{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.slf-pg{min-width:26px;background:#2a2c33;color:#cfd2da;border:1px solid #3a3d46;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:12px}
.slf-pg.on{background:#3b6fd8;color:#fff;border-color:#3b6fd8}
.slf-pg:disabled{opacity:.4;cursor:default}
#slf-sitepg{background:#14151a;color:#e6e6e6;border:1px solid #3a3d46;border-radius:4px;padding:2px 4px;font-size:12px}
#slf-meta{font-size:11px;color:#cfd2da;background:#2a2c33;border-radius:4px;padding:3px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slf-tabs{display:flex;gap:4px;align-items:center}
.slf-tab{background:#2a2c33;color:#cfd2da;border:1px solid #3a3d46;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px}
.slf-tab.on{background:#3b6fd8;color:#fff;border-color:#3b6fd8}
.slf-out{flex:1;min-height:80px;width:100%;resize:none;background:#14151a;color:#d7dae0;border:1px solid #3a3d46;border-radius:4px;padding:6px;font:11px/1.45 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto;display:none}
.slf-out.on{display:block}
#slf-fab{position:fixed;z-index:2147483646;bottom:16px;right:16px;background:#3b6fd8;color:#fff;border:0;border-radius:18px;padding:7px 12px;font:600 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);display:none}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'slf-panel';
  panel.innerHTML = `
<div id="slf-head"><b>🔎 Log de Sincronização</b><span id="slf-badge" title="Ocorrências encontradas"></span><button id="slf-min" title="Minimizar (duplo clique no título)">–</button><button id="slf-close" title="Ocultar (Alt+Shift+L)">×</button></div>
<div id="slf-body">
  <div class="slf-grid">
    <label>Data inicial<div class="slf-date"><input type="text" id="slf-de" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off"><button type="button" class="slf-cal" data-for="slf-de" title="Abrir calendário">📅</button><input type="date" class="slf-native" tabindex="-1"></div></label>
    <label>Data final<div class="slf-date"><input type="text" id="slf-ate" inputmode="numeric" maxlength="10" placeholder="dd/mm/aaaa" autocomplete="off"><button type="button" class="slf-cal" data-for="slf-ate" title="Abrir calendário">📅</button><input type="date" class="slf-native" tabindex="-1"></div></label>
    <label>Nome do técnico<input type="text" id="slf-user" placeholder="ex.: Elisangela Pereira"></label>
    <label>ID da solicitação<input type="text" id="slf-id" placeholder="ex.: 4822001"></label>
  </div>
  <div class="slf-row">
    <span style="font-size:11px;color:#a9adb8">Período:</span>
    <button type="button" class="slf-chip" data-d="0">Hoje</button>
    <button type="button" class="slf-chip" data-d="7">7 dias</button>
    <button type="button" class="slf-chip" data-d="15">15 dias</button>
    <button type="button" class="slf-chip" data-d="30">30 dias</button>
  </div>
  <div class="slf-row">
    <label class="chk"><input type="checkbox" id="slf-first"> Parar na 1ª ocorrência</label>
    <label class="chk"><input type="checkbox" id="slf-expand" checked> Expandir antecedentes no cURL</label>
    <label class="chk"><input type="checkbox" id="slf-omit"> Omitir vazios no cURL</label>
  </div>
  <div class="slf-row">
    <button class="slf-btn" id="slf-go">Buscar</button>
    <button class="slf-btn sec" id="slf-stop" disabled>Parar</button>
    <button class="slf-btn sec" id="slf-here" title="Analisa só a página exibida agora">Analisar página atual</button>
  </div>
  <div id="slf-bar"><i></i></div>
  <div id="slf-status">Pronto.</div>
  <div class="slf-nav">
    <label class="chk">Página do site <select id="slf-sitepg"><option value="all">Todas (0)</option></select></label>
    <span style="flex:1"></span>
    <div class="slf-nav" id="slf-pager"></div>
  </div>
  <div id="slf-meta">— nenhum resultado —</div>
  <div class="slf-tabs">
    <button class="slf-tab on" data-t="json">JSON</button>
    <button class="slf-tab" data-t="curl">cURL</button>
    <button class="slf-tab" data-t="raw">Bruto</button>
    <span style="flex:1"></span>
    <button class="slf-btn sec" id="slf-conv" title="Converte o conteúdo colado na aba Bruto">Converter bruto</button>
    <button class="slf-btn" id="slf-copy">Copiar</button>
  </div>
  <textarea class="slf-out on" id="slf-o-json" readonly spellcheck="false"></textarea>
  <textarea class="slf-out" id="slf-o-curl" readonly spellcheck="false"></textarea>
  <textarea class="slf-out" id="slf-o-raw" spellcheck="false" placeholder="Log bruto da ocorrência. Também dá para colar um log aqui manualmente e clicar em 'Converter bruto'."></textarea>
</div>`;
  document.body.appendChild(panel);

  const fab = document.createElement('button');
  fab.id = 'slf-fab';
  fab.textContent = 'LOG';
  document.body.appendChild(fab);

  const ui = {
    de: $('#slf-de', panel), ate: $('#slf-ate', panel), user: $('#slf-user', panel), id: $('#slf-id', panel),
    first: $('#slf-first', panel), expand: $('#slf-expand', panel), omit: $('#slf-omit', panel),
    go: $('#slf-go', panel), stop: $('#slf-stop', panel), here: $('#slf-here', panel),
    bar: $('#slf-bar i', panel), status: $('#slf-status', panel),
    site: $('#slf-sitepg', panel), pager: $('#slf-pager', panel), meta: $('#slf-meta', panel),
    json: $('#slf-o-json', panel), curl: $('#slf-o-curl', panel), raw: $('#slf-o-raw', panel),
  };

  /* --- estado persistido --- */
  function loadState() { try { return JSON.parse(localStorage.getItem(CFG.storeKey)) || {}; } catch { return {}; } }
  function saveState() {
    const r = panel.getBoundingClientRect();
    const s = {
      left: r.left, top: r.top,
      width: panel.classList.contains('min') ? st.width : panel.offsetWidth,
      height: panel.classList.contains('min') ? st.height : panel.offsetHeight,
      min: panel.classList.contains('min'), hidden: panel.style.display === 'none',
      user: ui.user.value, id: ui.id.value, first: ui.first.checked, expand: ui.expand.checked, omit: ui.omit.checked,
    };
    Object.assign(st, s);
    try { localStorage.setItem(CFG.storeKey, JSON.stringify(st)); } catch { /* ignore */ }
  }
  const st = loadState();
  if (st.left != null) {
    panel.style.left = Math.min(Math.max(0, st.left), innerWidth - 80) + 'px';
    panel.style.top = Math.min(Math.max(0, st.top), innerHeight - 40) + 'px';
    panel.style.right = 'auto';
  }
  if (st.width) panel.style.width = st.width + 'px';
  if (st.height) panel.style.height = st.height + 'px';
  if (st.min) panel.classList.add('min');
  if (st.hidden) { panel.style.display = 'none'; fab.style.display = 'block'; }
  ui.user.value = st.user || '';
  ui.id.value = st.id || '';
  ui.first.checked = !!st.first;
  ui.expand.checked = st.expand !== false;
  ui.omit.checked = !!st.omit;
  const today = new Date();
  ui.ate.value = fmtDate(today);
  ui.de.value = fmtDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7));

  /* --- campos de data --- */
  const maskDate = (v) => {
    const d = v.replace(/\D/g, '').slice(0, 8);
    if (d.length <= 2) return d;
    if (d.length <= 4) return d.slice(0, 2) + '/' + d.slice(2);
    return d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4);
  };
  const parseBR = (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || '');
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null;
  };
  const validate = (inp) => { inp.classList.toggle('inv', inp.value !== '' && !parseBR(inp.value)); };

  [ui.de, ui.ate].forEach((inp) => {
    inp.addEventListener('input', () => {
      const digitsBefore = inp.value.slice(0, inp.selectionStart).replace(/\D/g, '').length;
      inp.value = maskDate(inp.value);
      let i = 0, c = 0;
      while (i < inp.value.length && c < digitsBefore) { if (/\d/.test(inp.value[i])) c++; i++; }
      inp.setSelectionRange(i, i);
      if (inp.value.length === 10) validate(inp); else inp.classList.remove('inv');
    });
    inp.addEventListener('blur', () => validate(inp));
    inp.addEventListener('keydown', (e) => { // ↑/↓ = ±1 dia, Shift = ±1 mês
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const d = parseBR(inp.value) || new Date();
      const step = e.key === 'ArrowUp' ? 1 : -1;
      if (e.shiftKey) d.setMonth(d.getMonth() + step); else d.setDate(d.getDate() + step);
      inp.value = fmtDate(d);
      inp.classList.remove('inv');
    });
  });

  panel.querySelectorAll('.slf-cal').forEach((btn) => {
    const txt = $('#' + btn.dataset.for, panel);
    const nat = btn.parentElement.querySelector('.slf-native');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const d = parseBR(txt.value);
      nat.value = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
      try { nat.showPicker(); } catch { nat.style.pointerEvents = 'auto'; nat.focus(); nat.click(); }
    });
    nat.addEventListener('change', () => {
      if (!nat.value) return;
      const [y, m, dd] = nat.value.split('-');
      txt.value = `${dd}/${m}/${y}`;
      txt.classList.remove('inv');
      nat.style.pointerEvents = 'none';
    });
  });

  panel.querySelectorAll('.slf-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const t = new Date();
      ui.ate.value = fmtDate(t);
      ui.de.value = fmtDate(new Date(t.getFullYear(), t.getMonth(), t.getDate() - +b.dataset.d));
      ui.de.classList.remove('inv');
      ui.ate.classList.remove('inv');
    });
  });

  /* --- arrastar --- */
  $('#slf-head', panel).addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const mv = (ev) => {
      const x = Math.max(0, Math.min(ev.clientX - dx, innerWidth - 80));
      const y = Math.max(0, Math.min(ev.clientY - dy, innerHeight - 30));
      panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); saveState(); };
    addEventListener('mousemove', mv);
    addEventListener('mouseup', up);
    e.preventDefault();
  });
  let rsT;
  new ResizeObserver(() => { clearTimeout(rsT); rsT = setTimeout(saveState, 300); }).observe(panel);

  /* --- mostrar/ocultar --- */
  const togglePanel = (show) => {
    panel.style.display = show ? 'flex' : 'none';
    fab.style.display = show ? 'none' : 'block';
    saveState();
  };
  $('#slf-close', panel).onclick = () => togglePanel(false);
  fab.onclick = () => togglePanel(true);
  const minBtn = $('#slf-min', panel);
  function setMin(on) {
    if (on && !panel.classList.contains('min')) { st.width = panel.offsetWidth; st.height = panel.offsetHeight; }
    panel.classList.toggle('min', on);
    minBtn.textContent = on ? '▢' : '–';
    minBtn.title = on ? 'Restaurar (duplo clique no título)' : 'Minimizar (duplo clique no título)';
    if (!on) { // garante que a janela restaurada caiba na tela
      const r = panel.getBoundingClientRect();
      if (r.right > innerWidth) panel.style.left = Math.max(0, innerWidth - r.width - 8) + 'px';
      if (r.bottom > innerHeight) panel.style.top = Math.max(0, innerHeight - r.height - 8) + 'px';
      panel.style.right = 'auto';
    }
    saveState();
  }
  minBtn.onclick = () => setMin(!panel.classList.contains('min'));
  $('#slf-head', panel).addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setMin(!panel.classList.contains('min')); });
  setMin(panel.classList.contains('min'));
  addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyL') togglePanel(panel.style.display === 'none');
  });

  /* --- abas --- */
  let tab = 'json';
  panel.querySelectorAll('.slf-tab').forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.t;
      panel.querySelectorAll('.slf-tab').forEach((x) => x.classList.toggle('on', x === b));
      ['json', 'curl', 'raw'].forEach((t) => ui[t].classList.toggle('on', t === tab));
    };
  });
  $('#slf-copy', panel).onclick = async () => { await copyText(ui[tab].value); setStatus(`${tab.toUpperCase()} copiado.`, 'ok'); };

  /* --- render --- */
  let results = [];
  let current = null;
  let running = false;

  function setStatus(msg, cls = '') { ui.status.textContent = msg; ui.status.className = cls; }
  function setProgress(i, n) { ui.bar.style.width = n ? Math.round((i / n) * 100) + '%' : '0'; }

  function labelOf(r) {
    if (!r.rec) return `p${r.page} • (log não está no DOM) • ${r.rowText.slice(0, 70)}`;
    const id = (resolve(r.rec.map, 'idSolicitacao') || { vals: ['?'] }).vals[0];
    const form = (resolve(r.rec.map, 'idFormulario') || { vals: ['?'] }).vals[0];
    const hs = /^\d+$/.test(String(r.rec.horaSolicitado)) ? new Date(r.rec.horaSolicitado * 1000).toLocaleString('pt-BR') : '';
    return `p${r.page} • sol ${id} • form ${form} • ${r.rec.code || ''} ${r.rec.error || ''} • ${hs}`;
  }

  let view = { site: 'all', idx: 0 };
  const resetView = () => { view = { site: 'all', idx: 0 }; current = null; };
  const filtered = () => (view.site === 'all' ? results : results.filter((r) => String(r.page) === view.site));
  const siteLabel = (p) => (p === '-' ? 'Colado' : p === 'atual' ? 'Atual' : `Pág. ${p}`);

  function renderPager(list) {
    const P = ui.pager;
    P.innerHTML = '';
    const n = list.length, i = view.idx;
    if (n <= 1) return;
    const btn = (txt, target, { on = false, dis = false, title = '' } = {}) => {
      const b = document.createElement('button');
      b.className = 'slf-pg' + (on ? ' on' : '');
      b.textContent = txt;
      b.disabled = dis;
      if (title) b.title = title;
      b.onclick = () => { view.idx = target; renderList(); };
      P.appendChild(b);
    };
    btn('«', i - 1, { dis: i === 0 });
    const win = new Set([0, n - 1]);
    for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < n) win.add(k);
    let last = -1;
    [...win].sort((a, b) => a - b).forEach((k) => {
      if (k - last > 1) {
        const s = document.createElement('span');
        s.textContent = '…';
        s.style.color = '#777';
        P.appendChild(s);
      }
      btn(String(k + 1), k, { on: k === i, title: siteLabel(String(list[k].page)) + ' do site' });
      last = k;
    });
    btn('»', i + 1, { dis: i === n - 1 });
  }

  function renderList() {
    const badge = $('#slf-badge', panel);
    badge.textContent = results.length;
    badge.classList.toggle('on', results.length > 0);
    const counts = new Map();
    results.forEach((r) => { const p = String(r.page); counts.set(p, (counts.get(p) || 0) + 1); });
    ui.site.innerHTML = [`<option value="all">Todas (${results.length})</option>`,
      ...[...counts].map(([p, c]) => `<option value="${p}">${siteLabel(p)} (${c})</option>`)].join('');
    if (view.site !== 'all' && !counts.has(view.site)) view.site = 'all';
    ui.site.value = view.site;

    const list = filtered();
    if (view.idx >= list.length) view.idx = Math.max(0, list.length - 1);
    renderPager(list);

    if (!list.length) {
      current = null;
      ui.meta.textContent = '— nenhum resultado —';
      ui.json.value = ui.curl.value = '';
      return;
    }
    const r = list[view.idx];
    if (r !== current) show(r);
    ui.meta.textContent = `Ocorrência ${view.idx + 1}/${list.length} • ${labelOf(r)}`;
    ui.meta.title = ui.meta.textContent;
  }

  function show(r) {
    current = r;
    ui.raw.value = r.raw || '';
    if (!r.rec) {
      const msg = 'A linha bate com o filtro, mas o conteúdo do log não está na página (provavelmente abre em modal/detalhe).\n'
        + 'Abra o log, copie o texto, cole na aba "Bruto" e clique em "Converter bruto".';
      ui.json.value = msg;
      ui.curl.value = msg;
      return;
    }
    renderOutputs();
  }

  function renderOutputs() {
    if (!current || !current.rec) return;
    ui.json.value = JSON.stringify(buildJson(current.rec), null, 2);
    ui.curl.value = buildCurl(current.rec, { expand: ui.expand.checked, omitEmpty: ui.omit.checked });
  }

  ui.site.onchange = () => { view.site = ui.site.value; view.idx = 0; current = null; renderList(); };
  ui.expand.onchange = ui.omit.onchange = () => { renderOutputs(); saveState(); };
  ui.first.onchange = saveState;

  $('#slf-conv', panel).onclick = () => {
    const text = ui.raw.value;
    const sp = splitLogs(text);
    const added = [];
    for (const seg of (sp ? sp.segs : [text])) {
      const parsed = parseLog(seg);
      if (parsed) added.push({ page: '-', rowText: 'colado manualmente', raw: seg.trim(), rec: buildRecord(parsed) });
    }
    if (!added.length) { setStatus('Não encontrei um "query" válido no texto bruto.', 'err'); return; }
    results.push(...added);
    view = { site: '-', idx: 0 };
    current = null;
    renderList();
    setStatus(`${added.length} log(s) convertido(s).`, 'ok');
  };

  /* --- ações --- */
  function readFilter() {
    return {
      de: ui.de.value.trim(), ate: ui.ate.value.trim(),
      user: ui.user.value.trim(), id: ui.id.value.trim().replace(/\D/g, ''),
      stopFirst: ui.first.checked,
    };
  }
  const busy = (on) => { running = on; ui.go.disabled = on; ui.here.disabled = on; ui.stop.disabled = !on; };

  ui.stop.onclick = () => { running = false; setStatus('Interrompendo…', 'warn'); };

  ui.here.onclick = () => {
    const f = readFilter();
    const seen = new Set();
    const found = scanPage(getCont(), f, activePage(getCont()) ?? 'atual');
    results = found.filter((o) => { const k = fingerprint(o); if (seen.has(k)) return false; seen.add(k); return true; });
    resetView();
    renderList();
    const dup = found.length - results.length;
    setStatus(`${results.length} ocorrência(s) na página atual${dup ? ` (${dup} duplicada(s) ignorada(s))` : ''}.`, results.length ? 'ok' : 'warn');
  };

  ui.go.onclick = async () => {
    const f = readFilter();
    const dDe = parseBR(f.de), dAte = parseBR(f.ate);
    validate(ui.de); validate(ui.ate);
    if (!dDe || !dAte) { setStatus('Data inválida — use dd/mm/aaaa.', 'err'); return; }
    if (dDe > dAte) { ui.de.classList.add('inv'); setStatus('A data inicial é maior que a final.', 'err'); return; }
    if (!f.user && !f.id) { setStatus('Informe o nome do técnico e/ou o ID da solicitação.', 'err'); return; }
    saveState();
    results = []; resetView(); renderList(); setProgress(0, 1);
    busy(true);
    try {
      setStatus('Abrindo Log de Sincronização…');
      await openLogPage();
      const cont = getCont();
      setDate($('#de'), f.de);
      setDate($('#ate'), f.ate);

      setStatus('Executando busca…');
      const p = waitQuiet(cont);
      clickSearch();
      if (!(await p)) setStatus('Sem resposta da busca (timeout) — analisando o que está na tela.', 'warn');

      let page = 1;
      let max = getMaxPage(cont);
      let scanned = 0, dup = 0;
      const seen = new Set();
      const failed = [];
      while (running && page <= max) {
        if (page > 1) {
          setStatus(`Carregando página ${page}/${max}…`);
          const ok = await goToPage(page);
          if (!running) break;
          if (!ok) { failed.push(page); page++; continue; } // nunca reanalisa a página anterior
          max = Math.max(max, getMaxPage(cont));
        }
        setStatus(`Varrendo página ${page}/${max}…`);
        setProgress(page, max);
        scanned++;
        const fresh = scanPage(cont, f, page).filter((o) => {
          const k = fingerprint(o);
          if (seen.has(k)) { dup++; return false; }
          seen.add(k);
          return true;
        });
        if (fresh.length) { results.push(...fresh); renderList(); }
        if (fresh.length && f.stopFirst) break;
        page++;
      }
      setProgress(1, 1);
      const extra = [
        dup ? `${dup} duplicada(s) ignorada(s)` : '',
        failed.length ? `página(s) que não carregaram: ${failed.join(', ')}` : '',
        !running ? 'interrompido' : '',
      ].filter(Boolean).join(' • ');
      setStatus(`${results.length} ocorrência(s) em ${scanned} página(s)${extra ? ' — ' + extra : ''}.`,
        failed.length ? 'warn' : results.length ? 'ok' : 'warn');
    } catch (e) {
      console.error('[slf]', e);
      setStatus('Erro: ' + e.message, 'err');
    } finally {
      busy(false);
    }
  };
})();
    })(unsafeWindow);
  } catch (e) { console.error('[painel unificado] Log de Sincronização:', e); }

  /* =======================================================================
   *  CASCA UNIFICADA  (código novo: só reúne as duas janelas em abas)
   *  Não altera a lógica de nenhum dos dois aplicativos.
   * ======================================================================= */
  function buildShell(rmHost, logPanel) {
    const KEY = 'scu-ui-v1';
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    let st = {};
    try { st = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { st = {}; }

    const css = `
#scu-shell{position:fixed;z-index:2147483646;top:80px;right:20px;width:600px;height:660px;min-width:340px;min-height:260px;resize:both;overflow:hidden;display:flex;flex-direction:column;background:#1e1f24;color:#e6e6e6;border:1px solid #3a3d46;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.5);font:12px system-ui,Segoe UI,Arial,sans-serif}
#scu-shell *{box-sizing:border-box}
#scu-shell.min{height:auto!important;min-height:0!important;width:270px!important;min-width:0!important;resize:none!important}
#scu-shell.min #scu-tabs,#scu-shell.min #scu-body{display:none}
#scu-shell.min #scu-head{border-bottom:0;border-radius:8px}
#scu-head{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2a2c33;cursor:move;user-select:none;border-bottom:1px solid #3a3d46;border-radius:8px 8px 0 0}
#scu-head b{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#scu-head button{background:#40434d;color:#e6e6e6;border:0;border-radius:4px;width:22px;height:20px;cursor:pointer;line-height:1;padding:0}
#scu-tabs{display:flex;gap:4px;padding:6px 8px 0;background:#2a2c33;border-bottom:1px solid #3a3d46}
.scu-tab{display:flex;align-items:center;gap:6px;background:#1e1f24;color:#a9adb8;border:1px solid #3a3d46;border-bottom:0;border-radius:6px 6px 0 0;padding:6px 12px;cursor:pointer;font:600 12px system-ui,Segoe UI,Arial,sans-serif;margin-bottom:-1px}
.scu-tab:hover{color:#fff}
.scu-tab.on{background:#3b6fd8;color:#fff;border-color:#3b6fd8}
#scu-badge{display:none;background:#fff;color:#3b6fd8;border-radius:9px;padding:0 7px;font-size:11px;line-height:18px}
#scu-badge.on{display:inline-block}
#scu-body{flex:1;min-height:0;position:relative}
.scu-pane{position:absolute;top:0;right:0;bottom:0;left:0;display:none;flex-direction:column;overflow:hidden}
.scu-pane.on{display:flex}
#scu-fab{position:fixed;z-index:2147483646;bottom:16px;right:16px;background:#3b6fd8;color:#fff;border:0;border-radius:18px;padding:8px 14px;font:600 12px system-ui,Segoe UI,Arial,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);display:none}
/* --- Pesquisa de Log: usa a janela original como conteúdo da aba --- */
#slf-fab{display:none!important}
#scu-shell #slf-head{display:none!important}
#scu-shell #slf-panel,#scu-shell #slf-panel.min{position:static!important;display:flex!important;flex:1;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;max-width:none!important;resize:none!important;border:0!important;border-radius:0!important;box-shadow:none!important}
#scu-shell #slf-panel.min #slf-body{display:flex!important}
/* --- Remover atendimento: usa a janela original como conteúdo da aba --- */
#scu-shell .scu-rm{position:static!important;display:block!important;flex:1;width:100%!important;height:100%!important;min-height:0!important}
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const shell = document.createElement('div');
    shell.id = 'scu-shell';
    shell.innerHTML = `
<div id="scu-head"><b>🌾 Saúde no Campo</b><button id="scu-min" title="Minimizar (duplo clique no título)">–</button><button id="scu-close" title="Ocultar (Alt+Shift+L)">×</button></div>
<div id="scu-tabs">
  <button class="scu-tab" data-t="log">🔎 Pesquisa de Log <span id="scu-badge" title="Ocorrências encontradas"></span></button>
  <button class="scu-tab" data-t="rem">🗑 Remover atendimento</button>
</div>
<div id="scu-body">
  <div class="scu-pane" data-p="log"></div>
  <div class="scu-pane" data-p="rem"></div>
</div>`;
    document.body.appendChild(shell);

    const fab = document.createElement('button');
    fab.id = 'scu-fab';
    fab.textContent = '🌾 Saúde no Campo';
    document.body.appendChild(fab);

    const pane = (t) => shell.querySelector('.scu-pane[data-p="' + t + '"]');
    const tabBtn = (t) => shell.querySelector('.scu-tab[data-t="' + t + '"]');

    /* --- move as janelas originais para dentro das abas --- */
    if (logPanel) pane('log').appendChild(logPanel); else tabBtn('log').style.display = 'none';
    if (rmHost) {
      rmHost.classList.add('scu-rm');
      const sr = rmHost.shadowRoot;
      if (sr) {
        const s = document.createElement('style');
        s.textContent = '#fab{display:none!important}.hd,#rz{display:none!important}'
          + '#card{width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border:0!important;border-radius:0!important;box-shadow:none!important}';
        sr.appendChild(s);
        const f = sr.getElementById('fab');
        if (f) f.click();                       // abre o cartão do "Remover atendimento"
      }
      pane('rem').appendChild(rmHost);
    } else {
      tabBtn('rem').style.display = 'none';
    }

    /* --- selo com a quantidade de ocorrências do log na aba --- */
    const lb = logPanel && logPanel.querySelector('#slf-badge');
    if (lb) {
      const tb = shell.querySelector('#scu-badge');
      const sync = () => { tb.textContent = lb.textContent; tb.classList.toggle('on', lb.classList.contains('on')); };
      new MutationObserver(sync).observe(lb, { childList: true, characterData: true, subtree: true, attributes: true });
      sync();
    }

    /* --- estado (posição, tamanho, aba) --- */
    let tab = st.tab === 'rem' ? 'rem' : 'log';
    if (tab === 'rem' && !rmHost) tab = 'log';
    if (tab === 'log' && !logPanel) tab = 'rem';

    const save = () => {
      const hidden = shell.style.display === 'none';
      const min = shell.classList.contains('min');
      if (!hidden) { const r = shell.getBoundingClientRect(); st.left = r.left; st.top = r.top; }
      if (!hidden && !min && shell.offsetWidth) { st.width = shell.offsetWidth; st.height = shell.offsetHeight; }
      st.min = min; st.hidden = hidden; st.tab = tab;
      try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignora */ }
    };

    if (st.left != null) {
      shell.style.left = clamp(st.left, 0, Math.max(0, innerWidth - 80)) + 'px';
      shell.style.top = clamp(st.top, 0, Math.max(0, innerHeight - 40)) + 'px';
      shell.style.right = 'auto';
    }
    if (st.width) shell.style.width = clamp(st.width, 340, innerWidth) + 'px';
    if (st.height) shell.style.height = clamp(st.height, 260, innerHeight) + 'px';

    /* --- abas --- */
    const setTab = (t) => {
      tab = t;
      ['log', 'rem'].forEach((k) => {
        tabBtn(k).classList.toggle('on', k === t);
        pane(k).classList.toggle('on', k === t);
      });
      save();
    };
    shell.querySelectorAll('.scu-tab').forEach((b) => { b.onclick = () => setTab(b.dataset.t); });
    setTab(tab);

    /* --- mostrar / ocultar / minimizar --- */
    const show = (on) => {
      shell.style.display = on ? 'flex' : 'none';
      fab.style.display = on ? 'none' : 'block';
      save();
    };
    const minBtn = shell.querySelector('#scu-min');
    const setMin = (on) => {
      shell.classList.toggle('min', on);
      minBtn.textContent = on ? '▢' : '–';
      minBtn.title = on ? 'Restaurar (duplo clique no título)' : 'Minimizar (duplo clique no título)';
      if (!on) {
        const r = shell.getBoundingClientRect();
        if (r.right > innerWidth) shell.style.left = Math.max(0, innerWidth - r.width - 8) + 'px';
        if (r.bottom > innerHeight) shell.style.top = Math.max(0, innerHeight - r.height - 8) + 'px';
        shell.style.right = 'auto';
      }
      save();
    };
    shell.querySelector('#scu-close').onclick = () => show(false);
    fab.onclick = () => show(true);
    minBtn.onclick = () => setMin(!shell.classList.contains('min'));
    shell.querySelector('#scu-head').addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) setMin(!shell.classList.contains('min'));
    });
    if (st.min) setMin(true);
    if (st.hidden) show(false);

    /* --- arrastar pelo título --- */
    shell.querySelector('#scu-head').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = shell.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = (ev) => {
        shell.style.left = clamp(ev.clientX - dx, 0, Math.max(0, innerWidth - 80)) + 'px';
        shell.style.top = clamp(ev.clientY - dy, 0, Math.max(0, innerHeight - 30)) + 'px';
        shell.style.right = 'auto';
      };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(); };
      addEventListener('mousemove', mv);
      addEventListener('mouseup', up);
      e.preventDefault();
    });
    let rsT;
    new ResizeObserver(() => { clearTimeout(rsT); rsT = setTimeout(save, 300); }).observe(shell);

    /* --- atalho Alt+Shift+L (o mesmo do script de log): abre/oculta a janela na aba de log --- */
    addEventListener('keydown', (e) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyL') || !logPanel) return;
      e.stopImmediatePropagation();
      const hidden = shell.style.display === 'none';
      if (hidden) { show(true); setTab('log'); }
      else if (tab !== 'log') setTab('log');
      else show(false);
    }, true);
  }

  if (window.top === window) {
    const __logPanel = document.getElementById('slf-panel');
    if (__rmHost || __logPanel) {
      try { buildShell(__rmHost, __logPanel); } catch (e) { console.error('[painel unificado] layout:', e); }
    }
  }
})();