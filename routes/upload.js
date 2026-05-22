// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Remove sufixo de pacote: LU-123-1 → LU-123, 456-01 → 456
function normalizeOrderId(id) {
  if (!id) return id;
  const s = id.toString().trim();
  const hifens = (s.match(/-/g) || []).length;
  return hifens >= 2 ? s.replace(/-\d+$/, '') : s;
}

// Limpa valor monetário: "R$ 1.234,56" → 1234.56
function parseValor(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim()) || 0;
}

// ── DETECÇÃO DE MARKETPLACE ──
// Recebe as chaves da primeira linha e detecta qual marketplace é
function detectarMarketplace(keys) {
  const joined = keys.join('|').toLowerCase();

  // Magazine Luiza: tem "número do pedido" e "data do pacote"
  if (joined.includes('número do pedido') || joined.includes('numero do pedido') ||
      joined.includes('data do pacote')) {
    return 'MAGAZINE_LUIZA';
  }

  // MadeiraMadeira: tem "Pedido" E "Pedido Site MM" (específico deles)
  if (keys.includes('Pedido Site MM') || 
      (keys.includes('Pedido') && joined.includes('id do seller'))) {
    return 'MADEIRAMADEIRA';
  }

  // WebContinental: tem "pedido parceiro" ou "parceiro portal"
  if (joined.includes('pedido parceiro') || joined.includes('parceiro portal') ||
      joined.includes('pedido_parceiro')) {
    return 'WEBCONTINENTAL';
  }

  // Amazon: tem "order-id" ou "order id"
  if (joined.includes('order-id') || joined.includes('order id') ||
      joined.includes('amazon')) {
    return 'AMAZON';
  }

  return 'DESCONHECIDO';
}

// ── MAGAZINE LUIZA ──
// Colunas: Data do Pacote, Número do pedido, Número do pacote,
//          Status pacote..., Qtd itens, Valor total dos Produtos,
//          Descontos, Frete, Valor total do Pacote, ..., Nome do cliente, ...
function extractMagalu(row) {
  const get = (key) => {
    const found = Object.keys(row).find(k =>
      k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() ===
      key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()
    );
    return found ? row[found]?.toString().trim() : null;
  };

  const numeroPedido = get('Número do pedido') || get('Numero do pedido');
  const numeroPacote = get('Número do pacote') || get('Numero do pacote');
  const status       = get('Status pacote no momento que o relatório foi solicitado') || 'DESCONHECIDO';
  const valorStr     = get('Valor total do Pacote') || get('Valor total dos Produtos do pacote');
  const cliente      = get('Nome do cliente') || 'N/A';
  const dataStr      = get('Data do Pacote');

  // Usa número do pedido como ID base (sem sufixo de pacote)
  const pedidoId = numeroPedido || numeroPacote;

  return {
    pedido_id_original:   pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MAGAZINE_LUIZA',
    status,
    valor_total: parseValor(valorStr),
    cliente: (cliente || 'N/A').substring(0, 100),
    data: dataStr || null,
    raw: row
  };
}

// ── WEBCONTINENTAL ──
// Colunas: Parceiro Portal, Parceiro, ERP Parceiro, Pedido Parceiro, Pedido Site,
//          Pedido ERP, Pedido Marketplace, Cliente, CPF, Total do Pedido,
//          ..., Status Atual, ..., Data Criação, ...
function extractWebContinental(row) {
  let pedidoId    = null;
  let pedidoSite  = null;
  let cliente     = 'N/A';
  let valor       = 0;
  let status      = 'DESCONHECIDO';
  let data        = null;

  for (const [key, value] of Object.entries(row)) {
    const k = key.toString().trim();
    const kl = k.toLowerCase();

    // ID principal: "Pedido Parceiro" (ID no ERP parceiro)
    if (k === 'Pedido Parceiro' || kl === 'pedido parceiro') {
      pedidoId = value?.toString().trim();
    }
    // ID alternativo: "Pedido Site" (ID no site da WebContinental)
    if (k === 'Pedido Site' || kl === 'pedido site') {
      pedidoSite = value?.toString().trim();
    }
    if (k === 'Cliente' || (kl === 'cliente')) {
      cliente = value?.toString().trim() || 'N/A';
    }
    if (k === 'Total do Pedido' || kl === 'total do pedido') {
      valor = parseValor(value);
    }
    if (k === 'Status Atual' || kl === 'status atual') {
      status = value?.toString().trim() || 'DESCONHECIDO';
    }
    if (k === 'Data Criação' || kl === 'data criação' || kl === 'data criacao') {
      data = value?.toString().trim() || null;
    }
  }

  // Usa Pedido Parceiro como ID principal; fallback para Pedido Site
  const idFinal = pedidoId || pedidoSite;

  return {
    pedido_id_original:    idFinal,
    pedido_id_normalizado: idFinal ? normalizeOrderId(idFinal) : null,
    marketplace: 'WEBCONTINENTAL',
    status,
    valor_total: valor,
    cliente: (cliente || 'N/A').substring(0, 100),
    data,
    raw: row
  };
}

// ── MADEIRAMADEIRA ──
// Colunas: ID do Seller, Nome do Seller, Pedido, Pedido Site MM, CPF do Cliente,
//          Cliente, Telefone, Data Pedido, ..., Valor Pedido, ..., Status, ...
// Separador: ponto-e-vírgula, encoding: latin1
function extractMadeiraMadeira(row) {
  let pedidoId = null;
  let cliente  = 'N/A';
  let valor    = 0;
  let status   = 'DESCONHECIDO';
  let data     = null;

  for (const [key, value] of Object.entries(row)) {
    const k = key.toString().trim();
    const kl = k.toLowerCase();

    // ID do pedido: coluna "Pedido" (ID interno MM) ou "Pedido Site MM"
    if (k === 'Pedido' || kl === 'pedido') {
      pedidoId = value?.toString().trim();
    }
    if (kl.includes('cliente') && !kl.includes('cpf') && !kl.includes('status')) {
      cliente = value?.toString().trim() || 'N/A';
    }
    if (kl === 'valor pedido' || kl === 'valor_pedido') {
      valor = parseValor(value);
    }
    if (k === 'Status' || kl === 'status') {
      status = value?.toString().trim() || 'DESCONHECIDO';
    }
    if (kl === 'data pedido' || kl === 'data_pedido') {
      data = value?.toString().trim() || null;
    }
  }

  return {
    pedido_id_original:    pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MADEIRAMADEIRA',
    status,
    valor_total: valor,
    cliente: (cliente || 'N/A').substring(0, 100),
    data,
    raw: row
  };
}

// ── AMAZON ──
// Formato: TSV (tab-separado), sem status explícito (todos são pedidos ativos)
// Colunas: order-id, order-item-id, purchase-date, payments-date,
//          buyer-email, buyer-name, ..., item-price, shipping-price, ...
// Um pedido pode ter múltiplas linhas (um item por linha) — agrupa pelo order-id
function extractAmazon(row) {
  let pedidoId = null;
  let cliente  = 'N/A';
  let valor    = 0;
  let data     = null;

  for (const [key, value] of Object.entries(row)) {
    const k = key.toString().trim().toLowerCase();

    if (k === 'order-id') {
      pedidoId = value?.toString().trim();
    }
    if (k === 'buyer-name') {
      cliente = value?.toString().trim() || 'N/A';
    }
    if (k === 'item-price') {
      valor += parseFloat(value?.toString().trim()) || 0;
    }
    if (k === 'purchase-date') {
      data = value?.toString().trim() || null;
    }
  }

  return {
    pedido_id_original:    pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'AMAZON',
    status: 'ATIVO', // Amazon não exporta status na planilha de pedidos
    valor_total: valor,
    cliente: (cliente || 'N/A').substring(0, 100),
    data,
    raw: row
  };
}

// ── HTML DA PÁGINA ──
router.get('/', (req, res) => res.render('upload'));

router.get('/_legacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comparar Planilha - Monitor360</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#0a0e17;--surface:#111827;--surface2:#1a2332;--border:#1e2d40;
      --accent:#00d4ff;--success:#00e676;--warning:#ffab00;--danger:#ff1744;
      --text:#e2e8f0;--muted:#64748b;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;padding:32px}
    .container{max-width:1100px;margin:0 auto}
    h1{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--accent);letter-spacing:2px;margin-bottom:24px}
    .upload-area{
      border:2px dashed var(--border);border-radius:8px;padding:48px;text-align:center;
      cursor:pointer;transition:all .2s;background:var(--surface);margin-bottom:24px;
    }
    .upload-area:hover,.upload-area.drag-over{border-color:var(--accent);background:rgba(0,212,255,.05)}
    .upload-area i{font-size:40px;color:var(--muted);margin-bottom:12px;display:block}
    .upload-area p{color:var(--muted);margin-bottom:8px}
    .upload-area strong{color:var(--text);font-size:14px}
    .supported{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px}
    .badge{display:inline-block;padding:3px 10px;border-radius:3px;font-size:11px;font-weight:600}
    .badge-magalu{background:rgba(0,123,255,.15);color:#64b5f6;border:1px solid rgba(0,123,255,.3)}
    .badge-webcontinental{background:rgba(0,230,118,.15);color:#00e676;border:1px solid rgba(0,230,118,.3)}
    .badge-madeira{background:rgba(139,90,43,.2);color:#a1887f;border:1px solid rgba(139,90,43,.3)}
    .badge-amazon{background:rgba(255,153,0,.15);color:#ffb74d;border:1px solid rgba(255,153,0,.3)}
    .badge-warning{background:rgba(255,171,0,.15);color:var(--warning);border:1px solid rgba(255,171,0,.3)}
    #loading{display:none;text-align:center;padding:32px;color:var(--muted)}
    .spinner{display:inline-block;width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin-bottom:12px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:24px;margin-bottom:16px}
    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:16px 0}
    .metric-val{font-family:'Syne',sans-serif;font-size:36px;font-weight:800}
    .metric-label{color:var(--muted);font-size:11px;margin-top:4px}
    .debug{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:12px;font-size:11px;color:var(--muted);margin:12px 0}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th{padding:8px 12px;text-align:left;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
    td{padding:10px 12px;border-bottom:1px solid rgba(30,45,64,.4);font-size:12px}
    tr:hover td{background:rgba(0,212,255,.03)}
    code{background:var(--surface2);padding:2px 6px;border-radius:3px;font-size:11px;color:var(--accent)}
    .btn-back{display:inline-block;margin-bottom:24px;color:var(--accent);text-decoration:none;font-size:12px}
    .btn-back:hover{text-decoration:underline}
  </style>
</head>
<body>
<div class="container">
  <a href="/" class="btn-back">← Voltar ao Dashboard</a>
  <h1>📊 COMPARAR PLANILHA</h1>

  <div class="upload-area" id="uploadArea">
    <i>📁</i>
    <strong>Arraste o arquivo ou clique para selecionar</strong>
    <p>CSV ou XLSX do marketplace</p>
    <div class="supported">
      <span class="badge badge-magalu">Magazine Luiza .csv</span>
      <span class="badge badge-webcontinental">WebContinental .xlsx/.csv</span>
      <span class="badge badge-madeira">MadeiraMadeira .csv</span>
      <span class="badge badge-amazon">Amazon .txt/.csv</span>
    </div>
  </div>

  <input type="file" id="fileInput" accept=".csv,.xlsx,.xls,.txt" style="display:none">

  <div id="loading">
    <div class="spinner"></div><br>Processando planilha...
  </div>

  <div id="results"></div>
</div>

<script>
const uploadArea = document.getElementById('uploadArea');
const fileInput  = document.getElementById('fileInput');
const loading    = document.getElementById('loading');
const results    = document.getElementById('results');

uploadArea.onclick = () => fileInput.click();
uploadArea.ondragover  = (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); };
uploadArea.ondragleave = () => uploadArea.classList.remove('drag-over');
uploadArea.ondrop = (e) => {
  e.preventDefault(); uploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
};
fileInput.onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); };

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('planilha', file);
  loading.style.display = 'block';
  results.innerHTML = '';
  try {
    const r = await fetch('/upload/compare', { method: 'POST', body: formData });
    const d = await r.json();
    displayResults(d);
  } catch (err) {
    results.innerHTML = '<div class="card" style="color:var(--danger)">❌ ' + err.message + '</div>';
  } finally {
    loading.style.display = 'none';
  }
}

const mktBadge = {
  MAGAZINE_LUIZA: '<span class="badge badge-magalu">Magazine Luiza</span>',
  WEBCONTINENTAL: '<span class="badge badge-webcontinental">WebContinental</span>',
  MADEIRAMADEIRA: '<span class="badge badge-madeira">MadeiraMadeira</span>',
  AMAZON:         '<span class="badge badge-amazon">Amazon</span>'
};

function displayResults(data) {
  if (data.error) {
    results.innerHTML = '<div class="card" style="color:var(--warning)">⚠️ ' + data.error +
      (data.debug ? '<br><small style="color:var(--muted)">Debug: ' + JSON.stringify(data.debug) + '</small>' : '') + '</div>';
    return;
  }

  const total = data.total_planilha;
  const integ = data.total_integrados;
  const naoInteg = data.nao_integrados?.length || 0;
  const taxa = total > 0 ? ((integ / total) * 100).toFixed(1) : 0;

  let html = '<div class="card">';
  html += '<h2 style="margin-bottom:8px">📊 Resultado — ' + (mktBadge[data.tipo_planilha] || data.tipo_planilha) + '</h2>';
  html += '<div class="metrics">';
  html += '<div><div class="metric-val" style="color:var(--accent)">' + total + '</div><div class="metric-label">Total na Planilha</div></div>';
  html += '<div><div class="metric-val" style="color:var(--success)">' + integ + '</div><div class="metric-label">Integrados</div></div>';
  html += '<div><div class="metric-val" style="color:var(--warning)">' + naoInteg + '</div><div class="metric-label">Não Integrados</div></div>';
  html += '<div><div class="metric-val" style="color:var(--accent)">' + taxa + '%</div><div class="metric-label">Taxa</div></div>';
  html += '</div>';
  html += '<div class="debug">🔍 IDs encontrados no banco: ' + (data.ids_encontrados || 0) +
          ' &nbsp;|&nbsp; IDs na planilha: ' + total +
          ' &nbsp;|&nbsp; Normalização automática de sufixos (-1, -2)</div>';

  if (naoInteg > 0) {
    html += '<h3 style="color:var(--warning);margin:16px 0 8px">⚠️ Pedidos NÃO Integrados (' + naoInteg + ')</h3>';
    html += '<div style="overflow-x:auto"><table><thead><tr>';
    html += '<th>ID Planilha</th><th>ID Normalizado</th><th>Status</th><th>Valor</th><th>Cliente</th><th>Data</th>';
    html += '</tr></thead><tbody>';
    data.nao_integrados.slice(0, 100).forEach(p => {
      html += '<tr>';
      html += '<td><code>' + (p.pedido_id_original || 'N/A') + '</code></td>';
      html += '<td><code>' + (p.pedido_id_normalizado || '-') + '</code></td>';
      html += '<td>' + (p.status || '-') + '</td>';
      html += '<td>R$ ' + (parseFloat(p.valor_total) || 0).toFixed(2).replace('.',',') + '</td>';
      html += '<td>' + (p.cliente?.substring(0,40) || '-') + '</td>';
      html += '<td style="color:var(--muted)">' + (p.data || '-') + '</td>';
      html += '</tr>';
    });
    if (naoInteg > 100) html += '<tr><td colspan="6" style="color:var(--muted);text-align:center">... e mais ' + (naoInteg - 100) + ' pedidos</td></tr>';
    html += '</tbody></table></div>';
  } else {
    html += '<div style="text-align:center;padding:40px;color:var(--success)">✅ Todos os pedidos foram integrados!</div>';
  }

  html += '</div>';
  results.innerHTML = html;
}
</script>
</body>
</html>`);
});

// ── POST /compare ──
router.post('/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    // Detecta se é CSV com ponto-e-vírgula (MadeiraMadeira usa latin1 + semicolon)
    const fileExt = req.file.originalname.toLowerCase().split('.').pop();
    const bufferStr = req.file.buffer.slice(0, 500).toString('latin1');
    const isSemicolonCsv = fileExt === 'csv' && bufferStr.includes(';');
    const isCommaCsv     = fileExt === 'csv' && !bufferStr.includes(';');
    const isTsvOrTxt = fileExt === 'txt' || fileExt === 'tsv';

    let rawData = [];

    if (isTsvOrTxt) {
      // Amazon: TSV (tab-separado)
      const text = req.file.buffer.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split('\t').map(h => h.trim());
      rawData = lines.slice(1).map(line => {
        const values = line.split('\t');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i]?.trim() || ''; });
        return obj;
      }).filter(row => Object.values(row).some(v => v));
    } else if (isSemicolonCsv) {
      // MadeiraMadeira: CSV com ; e encoding latin1
      const text = req.file.buffer.toString('latin1');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split(';').map(h => h.replace(/^"|"$/g, '').trim());
      rawData = lines.slice(1).map(line => {
        const values = line.split(';').map(v => v.replace(/^"|"$/g, '').trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || ''; });
        return obj;
      }).filter(row => Object.values(row).some(v => v));
    } else if (isCommaCsv) {
      const parseCSVLine = (line) => {
        const result = [];
        let cur = '', inQuote = false;
        for (const ch of line) {
          if (ch === '"') { inQuote = !inQuote; }
          else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
          else cur += ch;
        }
        result.push(cur.trim());
        return result;
      };
      const text = req.file.buffer.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = parseCSVLine(lines[0]);
      rawData = lines.slice(1).map(line => {
        const values = parseCSVLine(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || ''; });
        return obj;
      }).filter(row => Object.values(row).some(v => v));
    } else {
      // XLSX / XLS
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    }

    if (!rawData.length) return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });

    const keys = Object.keys(rawData[0]);
    const primeiraColuna = keys[0] || '';
    const tipoPlanilha = detectarMarketplace(keys);

    console.log('📋 Arquivo:', req.file.originalname);
    console.log('📋 Primeira coluna:', primeiraColuna);
    console.log('📋 Tipo detectado:', tipoPlanilha);
    console.log('📋 Total linhas:', rawData.length);

    if (tipoPlanilha === 'DESCONHECIDO') {
      return res.status(400).json({
        error: `⚠️ Marketplace não reconhecido. Formatos suportados: Amazon (.txt), MadeiraMadeira (.csv), Magazine Luiza (.csv), WebContinental (.xlsx)`,
        debug: { fileName: req.file.originalname, primeiraColuna, colunas: keys.slice(0, 5) }
      });
    }

    // Extrai pedidos conforme o marketplace
    const extractors = {
      MAGAZINE_LUIZA:  extractMagalu,
      WEBCONTINENTAL:  extractWebContinental,
      MADEIRAMADEIRA:  extractMadeiraMadeira,
      AMAZON:          extractAmazon
    };
    const pedidosPlanilha = rawData.map(extractors[tipoPlanilha]);

    // Filtra inválidos
    const pedidosValidos = pedidosPlanilha.filter(p =>
      p.pedido_id_original &&
      p.pedido_id_original !== 'N/A' &&
      p.pedido_id_original !== 'undefined' &&
      p.pedido_id_original.toString().length > 3
    );

    if (!pedidosValidos.length) {
      return res.status(400).json({
        error: 'Não foi possível identificar IDs de pedidos na planilha.',
        debug: { tipoPlanilha, primeiraColuna, colunas: keys.slice(0, 8), amostra: rawData[0] }
      });
    }

    console.log('📋 Pedidos válidos:', pedidosValidos.length);
    console.log('📋 Primeiros IDs:', pedidosValidos.slice(0, 3).map(p => p.pedido_id_original));

    const possiveisIds = [...new Set(
      pedidosValidos.flatMap(p => [
        p.pedido_id_original,
        p.pedido_id_normalizado,
        ...[1,2,3,4,5,6,7,8,9].map(n => `${p.pedido_id_original}-${n}`)
      ].filter(Boolean))
    )];

    const result = await pool.query(
      `SELECT DISTINCT pedido_id FROM tracking_events WHERE pedido_id = ANY($1::text[])`,
      [possiveisIds]
    );
    const integradosSet = new Set(result.rows.map(r => r.pedido_id));

    const naoIntegrados = pedidosValidos.filter(p => {
      const variantes = [
        p.pedido_id_original,
        p.pedido_id_normalizado,
        ...[1,2,3,4,5,6,7,8,9].map(n => `${p.pedido_id_original}-${n}`)
      ].filter(Boolean);
      return variantes.every(id => !integradosSet.has(id));
    });

    // Busca status atual de cada pedido integrado
    const trackResult = await pool.query(`
      SELECT DISTINCT ON (pedido_id)
        pedido_id, origem, status, timestamp
      FROM tracking_events
      WHERE pedido_id = ANY($1::text[])
      ORDER BY pedido_id, timestamp DESC
    `, [possiveisIds]);
    const trackMap = new Map();
    trackResult.rows.forEach(r => trackMap.set(r.pedido_id, r));

    // Função de comparação de status
    function compararStatus(statusMkt, statusSistema) {
      const mkt = (statusMkt || '').toLowerCase();
      const sis = (statusSistema || '').toLowerCase();
      if (mkt.includes('entregue') && sis.includes('entregue')) return 'OK';
      if ((mkt.includes('despachado') || mkt.includes('enviado') || mkt.includes('trânsito') || mkt.includes('transito')) && (sis.includes('enviad') || sis.includes('confirmado') || sis.includes('faturado'))) return 'OK';
      if ((mkt.includes('aprovado') || mkt.includes('pago')) && (sis.includes('pago') || sis.includes('aguard') || sis.includes('producao') || sis.includes('produção'))) return 'OK';
      if (mkt.includes('cancelado') && sis.includes('cancelado')) return 'OK';
      if ((mkt.includes('despachado') || mkt.includes('enviado')) && sis.includes('producao')) return 'ATRASADO';
      if (mkt.includes('entregue') && !sis.includes('entregue')) return 'ATRASADO';
      return 'DIVERGENTE';
    }

    // Separa integrados com dados de comparação
    const integrados = pedidosValidos
      .filter(p => {
        const variantes = [p.pedido_id_original, p.pedido_id_normalizado, ...[1,2,3,4,5,6,7,8,9].map(n => `${p.pedido_id_original}-${n}`)].filter(Boolean);
        return variantes.some(id => integradosSet.has(id));
      })
      .map(p => {
        const variantes = [p.pedido_id_original, p.pedido_id_normalizado, ...[1,2,3,4,5,6,7,8,9].map(n => `${p.pedido_id_original}-${n}`)].filter(Boolean);
        const matchId = variantes.find(id => trackMap.has(id));
        const track = matchId ? trackMap.get(matchId) : null;
        const comp = track ? compararStatus(p.status, track.status) : 'DIVERGENTE';
        return {
          pedido_id_original:    p.pedido_id_original,
          pedido_id_normalizado: p.pedido_id_normalizado,
          cliente:               p.cliente,
          valor_total:           p.valor_total,
          data:                  p.data,
          status_marketplace:    p.status,
          status_sistema:        track?.status || null,
          estagio_sistema:       track?.origem || null,
          ultima_atualizacao:    track?.timestamp || null,
          comparacao:            comp
        };
      });

    const resumo = {
      sincronizados: integrados.filter(p => p.comparacao === 'OK').length,
      atrasados:     integrados.filter(p => p.comparacao === 'ATRASADO').length,
      divergentes:   integrados.filter(p => p.comparacao === 'DIVERGENTE').length
    };

    res.json({
      tipo_planilha:        tipoPlanilha,
      total_planilha:       pedidosValidos.length,
      total_integrados:     integrados.length,
      total_nao_integrados: naoIntegrados.length,
      resumo_status:        resumo,
      integrados,
      nao_integrados: naoIntegrados.map(p => ({
        pedido_id_original:   p.pedido_id_original,
        pedido_id_normalizado: p.pedido_id_normalizado,
        marketplace:          p.marketplace,
        status:               p.status,
        valor_total:          p.valor_total,
        cliente:              p.cliente,
        data:                 p.data
      }))
    });

  } catch (err) {
    console.error('❌ Erro upload:', err);
    res.status(500).json({ error: 'Erro ao processar: ' + err.message });
  }
});

module.exports = router;