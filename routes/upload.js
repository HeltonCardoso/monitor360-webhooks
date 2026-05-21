// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('../config/database');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── DETECÇÃO DE MARKETPLACE ─────────────────────────────────────────────────
function detectarMarketplace(workbook, fileName) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  const header = (rows[0] || []).map(c => String(c || '').toLowerCase());
  const name = (fileName || '').toLowerCase();

  // Amazon: arquivo .txt com TSV
  if (name.endsWith('.txt') || header.includes('order-id') || header.includes('order-item-id'))
    return 'AMAZON';

  // MadeiraMadeira: coluna "Pedido Site MM"
  if (header.some(h => h.includes('pedido site mm')) || header.includes('id do seller'))
    return 'MADEIRAMADEIRA';

  // Magazine Luiza: coluna "Número do pedido" + padrão LU-
  if (header.some(h => h.includes('número do pedido') || h.includes('numero do pedido') || h.includes('número do pacote')))
    return 'MAGAZINE_LUIZA';

  // WebContinental: coluna "Pedido Parceiro" + "IdWebContinental"
  if (header.some(h => h.includes('pedido parceiro') || h.includes('idwebcontinental') || h.includes('parceiro portal')))
    return 'WEBCONTINENTAL';

  return 'DESCONHECIDO';
}

// ── PARSERS ─────────────────────────────────────────────────────────────────

// Amazon: TSV, campo order-id é a chave
// Um pedido pode ter múltiplos itens (mesmo order-id) — agrupar
function parseAmazon(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  const pedidosMap = new Map();
  for (const row of rows) {
    const orderId = row['order-id']?.toString().trim();
    if (!orderId) continue;

    if (!pedidosMap.has(orderId)) {
      pedidosMap.set(orderId, {
        pedido_id_original:    orderId,
        pedido_id_normalizado: orderId, // Amazon não tem sufixo
        marketplace:           'AMAZON',
        status:                'N/A', // Amazon não exporta status no relatório
        valor_total:           0,
        cliente:               row['buyer-name']?.toString().trim() || 'N/A',
        data:                  row['purchase-date']?.toString().slice(0, 10) || null
      });
    }

    // Soma valor dos itens do mesmo pedido
    const item = pedidosMap.get(orderId);
    const preco = parseFloat(row['item-price']) || 0;
    const frete = parseFloat(row['shipping-price']) || 0;
    item.valor_total += preco + frete;
  }

  return Array.from(pedidosMap.values()).map(p => ({
    ...p,
    valor_total: parseFloat(p.valor_total.toFixed(2))
  }));
}

// MadeiraMadeira: CSV separado por ; encoding latin-1
// Campos: Pedido (ID interno MM), Pedido Site MM (ID no site), Cliente, Valor Pedido, Status
function parseMadeiraMadeira(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map(row => {
    const pedidoMM   = row['Pedido']?.toString().trim();         // ID interno MM
    const pedidoSite = row['Pedido Site MM']?.toString().trim(); // ID no site MM
    const valor      = parseFloat(String(row['Valor Pedido'] || '0').replace(',', '.')) || 0;

    return {
      pedido_id_original:    pedidoMM   || pedidoSite || null,
      pedido_id_normalizado: pedidoSite || pedidoMM   || null,
      marketplace:           'MADEIRAMADEIRA',
      status:                row['Status']?.toString().trim() || 'DESCONHECIDO',
      valor_total:           valor,
      cliente:               row['Cliente']?.toString().trim().substring(0, 100) || 'N/A',
      data:                  row['Data Pedido']?.toString().slice(0, 10) || null
    };
  });
}

// Magazine Luiza: CSV com colunas bem definidas
// Campos: Número do pedido (LU-xxx), Número do pacote (LU-xxx-N), Nome do cliente, Valor total do Pacote, Status pacote
function parseMagazineLuiza(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  // Localiza as colunas independente de maiúsculas/acentos
  const findCol = (row, patterns) => {
    for (const key of Object.keys(row)) {
      const norm = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (patterns.some(p => norm.includes(p))) return key;
    }
    return null;
  };

  return rows.map(row => {
    const colPedido  = findCol(row, ['numero do pedido', 'numero do pacote', 'pedido']);
    const colCliente = findCol(row, ['nome do cliente', 'cliente']);
    const colValor   = findCol(row, ['valor total do pacote', 'valor total']);
    const colStatus  = findCol(row, ['status pacote', 'status']);
    const colData    = findCol(row, ['data do pacote', 'data']);

    const rawId = row[colPedido]?.toString().trim() || null;
    // Normaliza: LU-1536470110239990-6 → LU-1536470110239990
    const normId = rawId ? rawId.replace(/-\d+$/, '') : null;

    // Valor vem como "R$ 844,88" — limpar
    const valorRaw = row[colValor]?.toString() || '0';
    const valor = parseFloat(
      valorRaw.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()
    ) || 0;

    return {
      pedido_id_original:    rawId,
      pedido_id_normalizado: normId,
      marketplace:           'MAGAZINE_LUIZA',
      status:                row[colStatus]?.toString().trim() || 'DESCONHECIDO',
      valor_total:           valor,
      cliente:               row[colCliente]?.toString().trim().substring(0, 100) || 'N/A',
      data:                  row[colData]?.toString().slice(0, 10) || null
    };
  });
}

// WebContinental: XLSX com colunas bem definidas
// Campos: Pedido Parceiro (ID no marketplace), Pedido Site, Cliente, Total do Pedido, Status Atual, Data Criação
// O ID do marketplace está em "Pedido Marketplace" ou "Pedido Parceiro"
function parseWebContinental(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map(row => {
    // Pedido Marketplace é o ID real no marketplace (Amazon, Magalu etc.)
    // Pedido Parceiro é o ID interno da WebContinental
    const pedidoMkt      = row['Pedido Marketplace']?.toString().trim();
    const pedidoParceiro = row['Pedido Parceiro']?.toString().trim();
    const pedidoSite     = row['Pedido Site']?.toString().trim();

    // Usa o mais específico disponível
    const idOriginal    = pedidoParceiro || pedidoSite || null;
    const idNormalizado = pedidoParceiro || pedidoSite || null;

    const valorRaw = row['Total do Pedido']?.toString() || '0';
    const valor = parseFloat(
      valorRaw.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()
    ) || 0;

    // Detecta qual marketplace real é via "Integração" ou "Loja"
    const integracao = row['Integração']?.toString().trim() || '';
    const loja       = row['Loja']?.toString().trim() || '';
    let marketplaceReal = 'WEBCONTINENTAL';
    if (integracao.toLowerCase().includes('amazon') || loja.toLowerCase().includes('amazon'))
      marketplaceReal = 'AMAZON';
    else if (integracao.toLowerCase().includes('magalu') || integracao.toLowerCase().includes('magazine'))
      marketplaceReal = 'MAGAZINE_LUIZA';

    return {
      pedido_id_original:    idOriginal,
      pedido_id_normalizado: idNormalizado,
      marketplace:           marketplaceReal,
      status:                row['Status Atual']?.toString().trim() || 'DESCONHECIDO',
      valor_total:           valor,
      cliente:               row['Cliente']?.toString().trim().substring(0, 100) || 'N/A',
      data:                  row['Data Criação']?.toString().slice(0, 10) || null
    };
  });
}

// ── ROTA GET (página de upload) ─────────────────────────────────────────────
router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comparar Planilha — Monitor360</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#0a0e17;--surface:#111827;--surface2:#1a2332;--border:#1e2d40;--accent:#00d4ff;--success:#00e676;--warning:#ffab00;--danger:#ff1744;--text:#e2e8f0;--muted:#64748b}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:13px;min-height:100vh;padding:32px}
    .page-title{font-family:'Syne',sans-serif;font-weight:800;font-size:22px;color:var(--text);margin-bottom:24px}
    .page-title span{color:var(--accent)}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:16px}
    .card-header{padding:10px 16px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
    .card-body{padding:20px}
    .upload-area{border:2px dashed var(--border);border-radius:6px;padding:48px;text-align:center;cursor:pointer;transition:all .2s}
    .upload-area:hover,.upload-area.drag-over{border-color:var(--accent);background:rgba(0,212,255,.04)}
    .upload-icon{font-size:40px;margin-bottom:12px;opacity:.4}
    .upload-label{color:var(--muted);font-size:13px;margin-top:8px}
    .upload-label span{color:var(--accent)}
    .btn-primary{background:var(--accent);border:none;color:#0a0e17;padding:10px 24px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-weight:700;cursor:pointer;font-size:13px}
    .badge-mkt{display:inline-block;padding:3px 10px;border-radius:3px;font-size:11px;font-weight:600}
    .badge-AMAZON{background:rgba(255,153,0,.15);color:#ff9900}
    .badge-MAGAZINE_LUIZA{background:rgba(100,181,246,.15);color:#64b5f6}
    .badge-WEBCONTINENTAL{background:rgba(0,212,255,.15);color:var(--accent)}
    .badge-MADEIRAMADEIRA{background:rgba(0,230,118,.15);color:var(--success)}
    .badge-DESCONHECIDO{background:rgba(100,116,139,.15);color:var(--muted)}
    .metric-val{font-family:'Syne',sans-serif;font-size:32px;font-weight:800;line-height:1}
    .metric-label{color:var(--muted);font-size:11px;margin-top:4px}
    .tbl{width:100%;border-collapse:collapse}
    .tbl th{padding:8px 12px;text-align:left;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
    .tbl td{padding:9px 12px;border-bottom:1px solid rgba(30,45,64,.5);vertical-align:middle}
    .tbl tr:hover td{background:rgba(0,212,255,.03)}
    .tbl tr:last-child td{border-bottom:none}
    code{background:var(--surface2);padding:2px 6px;border-radius:3px;font-size:11px;color:var(--accent)}
    .loading{display:none;text-align:center;padding:40px;color:var(--muted)}
    .spinner{display:inline-block;width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin-right:8px;vertical-align:middle}
    @keyframes spin{to{transform:rotate(360deg)}}
    .alert-info{background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.2);border-radius:4px;padding:10px 14px;color:var(--accent);font-size:12px;margin-bottom:16px}
  </style>
</head>
<body>
  <div style="max-width:1100px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/" style="color:var(--muted);text-decoration:none;font-size:12px">← Dashboard</a>
    </div>
    <div class="page-title">COMPARAR <span>PLANILHA</span></div>

    <div class="alert-info">
      ℹ️ Formatos suportados: <strong>Amazon</strong> (.txt TSV) · <strong>MadeiraMadeira</strong> (.csv) · <strong>Magazine Luiza</strong> (.csv) · <strong>WebContinental</strong> (.xlsx)
    </div>

    <div class="card">
      <div class="card-header">📂 Upload da Planilha</div>
      <div class="card-body">
        <div class="upload-area" id="uploadArea">
          <div class="upload-icon">📊</div>
          <div style="font-size:15px;font-weight:600">Arraste o arquivo aqui</div>
          <div class="upload-label">ou <span>clique para selecionar</span></div>
          <input type="file" id="fileInput" accept=".csv,.txt,.xlsx,.xls" style="display:none">
        </div>
      </div>
    </div>

    <div class="loading" id="loading">
      <div><span class="spinner"></span>Processando planilha...</div>
    </div>

    <div id="results"></div>
  </div>

<script>
const uploadArea = document.getElementById('uploadArea');
const fileInput  = document.getElementById('fileInput');
const loading    = document.getElementById('loading');
const results    = document.getElementById('results');

uploadArea.onclick = () => fileInput.click();
uploadArea.ondragover = e => { e.preventDefault(); uploadArea.classList.add('drag-over'); };
uploadArea.ondragleave = () => uploadArea.classList.remove('drag-over');
uploadArea.ondrop = e => { e.preventDefault(); uploadArea.classList.remove('drag-over'); if(e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); };
fileInput.onchange = e => { if(e.target.files[0]) upload(e.target.files[0]); };

const badges = {
  AMAZON:         '<span class="badge-mkt badge-AMAZON">Amazon</span>',
  MAGAZINE_LUIZA: '<span class="badge-mkt badge-MAGAZINE_LUIZA">Magazine Luiza</span>',
  WEBCONTINENTAL: '<span class="badge-mkt badge-WEBCONTINENTAL">WebContinental</span>',
  MADEIRAMADEIRA: '<span class="badge-mkt badge-MADEIRAMADEIRA">MadeiraMadeira</span>',
  DESCONHECIDO:   '<span class="badge-mkt badge-DESCONHECIDO">?</span>'
};

async function upload(file) {
  const fd = new FormData();
  fd.append('planilha', file);
  loading.style.display = 'block';
  results.innerHTML = '';
  try {
    const r = await fetch('/upload/compare', { method: 'POST', body: fd });
    const d = await r.json();
    render(d);
  } catch(e) {
    results.innerHTML = '<div class="card card-body" style="color:var(--danger)">❌ ' + e.message + '</div>';
  } finally {
    loading.style.display = 'none';
  }
}

function fmt(v) { return 'R$ ' + parseFloat(v||0).toFixed(2).replace('.',',').replace(/\B(?=(\\d{3})+(?!\\d))/g,'.'); }

function render(d) {
  if (d.error) {
    results.innerHTML = '<div class="card card-body" style="color:var(--warning)">⚠️ ' + d.error + (d.debug ? '<br><small>'+JSON.stringify(d.debug)+'</small>' : '') + '</div>';
    return;
  }

  const total  = d.total_planilha;
  const integ  = d.total_integrados;
  const nao    = d.nao_integrados?.length || 0;
  const taxa   = total > 0 ? ((integ/total)*100).toFixed(1) : 0;

  let html = '';

  // Resumo
  html += '<div class="card"><div class="card-body">';
  html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px">';
  html += '<div><div class="metric-val" style="color:var(--accent)">' + total + '</div><div class="metric-label">Total na Planilha</div></div>';
  html += '<div><div class="metric-val" style="color:var(--success)">' + integ + '</div><div class="metric-label">Integrados</div></div>';
  html += '<div><div class="metric-val" style="color:var(--warning)">' + nao + '</div><div class="metric-label">Não Integrados</div></div>';
  html += '<div><div class="metric-val" style="color:var(--accent)">' + taxa + '%</div><div class="metric-label">Taxa de Integração</div></div>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--muted)">Marketplace detectado: ' + (badges[d.tipo_planilha]||d.tipo_planilha) + ' &nbsp;|&nbsp; Arquivo: ' + (d.nome_arquivo||'-') + '</div>';
  html += '</div></div>';

  // Tabela não integrados
  if (nao > 0) {
    html += '<div class="card"><div class="card-header" style="justify-content:space-between"><span>⚠️ PEDIDOS NÃO INTEGRADOS (' + nao + ')</span></div>';
    html += '<div style="overflow-x:auto"><table class="tbl"><thead><tr>';
    html += '<th>ID na Planilha</th><th>ID Normalizado</th><th>Marketplace</th><th>Status</th><th>Valor</th><th>Cliente</th><th>Data</th>';
    html += '</tr></thead><tbody>';
    d.nao_integrados.slice(0, 100).forEach(p => {
      html += '<tr>';
      html += '<td><code>' + (p.pedido_id_original||'N/A') + '</code></td>';
      html += '<td><code>' + (p.pedido_id_normalizado||'-') + '</code></td>';
      html += '<td>' + (badges[p.marketplace]||p.marketplace) + '</td>';
      html += '<td style="color:var(--muted)">' + (p.status||'-') + '</td>';
      html += '<td>' + fmt(p.valor_total) + '</td>';
      html += '<td style="color:var(--muted)">' + (p.cliente?.substring(0,40)||'-') + '</td>';
      html += '<td style="color:var(--muted)">' + (p.data||'-') + '</td>';
      html += '</tr>';
    });
    if (nao > 100) html += '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:12px">... e mais ' + (nao-100) + ' pedidos</td></tr>';
    html += '</tbody></table></div></div>';
  } else {
    html += '<div class="card card-body" style="text-align:center;padding:40px;color:var(--success)">✅ Todos os pedidos da planilha foram integrados!</div>';
  }

  results.innerHTML = html;
}
</script>
</body>
</html>`);
});

// ── ROTA POST ────────────────────────────────────────────────────────────────
router.post('/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const fileName = req.file.originalname || '';
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer', codepage: 1252 });

    if (!workbook.SheetNames.length)
      return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });

    const tipoPlanilha = detectarMarketplace(workbook, fileName);
    console.log(`📋 Marketplace detectado: ${tipoPlanilha} | Arquivo: ${fileName}`);

    let pedidos = [];
    switch (tipoPlanilha) {
      case 'AMAZON':         pedidos = parseAmazon(workbook);         break;
      case 'MADEIRAMADEIRA': pedidos = parseMadeiraMadeira(workbook); break;
      case 'MAGAZINE_LUIZA': pedidos = parseMagazineLuiza(workbook);  break;
      case 'WEBCONTINENTAL': pedidos = parseWebContinental(workbook); break;
      default:
        return res.status(400).json({
          error: `Marketplace não reconhecido. Formatos suportados: Amazon (.txt), MadeiraMadeira (.csv), Magazine Luiza (.csv), WebContinental (.xlsx)`,
          debug: { fileName, primeiraColuna: Object.keys(xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])[0]||{})[0] }
        });
    }

    // Filtra linhas vazias / inválidas
    const validos = pedidos.filter(p =>
      p.pedido_id_original &&
      p.pedido_id_original !== 'undefined' &&
      p.pedido_id_original !== 'null' &&
      p.pedido_id_original.length >= 4
    );

    console.log(`📋 Pedidos válidos: ${validos.length} de ${pedidos.length}`);

    if (!validos.length)
      return res.status(400).json({ error: 'Nenhum ID de pedido encontrado na planilha.' });

    // Monta todos os IDs possíveis para busca no banco
    const idsSet = new Set();
    for (const p of validos) {
      if (p.pedido_id_original)    idsSet.add(p.pedido_id_original);
      if (p.pedido_id_normalizado) idsSet.add(p.pedido_id_normalizado);
    }
    const ids = Array.from(idsSet);

    // Busca no banco
    const result = await pool.query(
      `SELECT DISTINCT pedido_id FROM tracking_events WHERE pedido_id = ANY($1::text[])
       UNION
       SELECT DISTINCT numero_marketplace FROM pedidos_mapeamento WHERE numero_marketplace = ANY($1::text[])`,
      [ids]
    );
    const integradosSet = new Set(result.rows.map(r => r.pedido_id || r.numero_marketplace));

    const naoIntegrados = validos.filter(p =>
      !integradosSet.has(p.pedido_id_original) &&
      !integradosSet.has(p.pedido_id_normalizado)
    );

    res.json({
      tipo_planilha:    tipoPlanilha,
      nome_arquivo:     fileName,
      total_planilha:   validos.length,
      total_integrados: validos.length - naoIntegrados.length,
      ids_encontrados:  result.rows.length,
      nao_integrados:   naoIntegrados.map(p => ({
        pedido_id_original:    p.pedido_id_original,
        pedido_id_normalizado: p.pedido_id_normalizado,
        marketplace:           p.marketplace,
        status:                p.status,
        valor_total:           p.valor_total,
        cliente:               p.cliente,
        data:                  p.data
      }))
    });

  } catch (error) {
    console.error('Erro upload:', error);
    res.status(500).json({ error: 'Erro ao processar: ' + error.message });
  }
});

module.exports = router;