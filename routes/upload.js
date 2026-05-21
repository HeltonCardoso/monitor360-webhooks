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

// Função para normalizar ID (remove sufixos como -1, -2)
function normalizeOrderId(id) {
  if (!id) return id;
  const idStr = id.toString().trim();
  // Remove sufixos como -1, -2, -3 no final
  return idStr.replace(/-\d+$/, '');
}

// Função para identificar qual tipo de planilha é
function detectSheetType(headers) {
  const headerStr = headers.join(',').toLowerCase();
  
  // Planilha da Magazine Luiza
  if (headerStr.includes('número do pedido') || headerStr.includes('numero do pedido')) {
    return 'MAGAZINE_LUIZA';
  }
  
  // Planilha da WebContinental
  if (headerStr.includes('pedido parceiro') || headerStr.includes('pedido marketplace')) {
    return 'WEBCONTINENTAL';
  }
  
  return 'DESCONHECIDO';
}

// Extrair dados da planilha Magazine Luiza
function extractMagazineLuizaOrder(row) {
  // Encontra a coluna correta do número do pedido
  let pedidoId = null;
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase().includes('número do pedido') || key.toLowerCase().includes('numero do pedido')) {
      pedidoId = value?.toString();
      break;
    }
  }
  
  // Se não achou, tenta por posição (segunda coluna geralmente)
  if (!pedidoId) {
    const values = Object.values(row);
    if (values.length > 1) {
      pedidoId = values[1]?.toString();
    }
  }
  
  // Extrai outros dados
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('nome do cliente')) {
      cliente = value?.toString() || 'N/A';
    }
    if (lowerKey.includes('valor total do pacote') || lowerKey.includes('valor total')) {
      const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
      valor = parseFloat(valStr) || 0;
    }
    if (lowerKey.includes('status pacote') || lowerKey.includes('status')) {
      status = value?.toString() || 'DESCONHECIDO';
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MAGAZINE_LUIZA',
    status: status,
    valor_total: valor,
    cliente: cliente,
    raw: row
  };
}

// Extrair dados da planilha WebContinental
function extractWebContinentalOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    
    // PEDIDO PARCEIRO ou PEDIDO MARKETPLACE é o ID
    if (lowerKey.includes('pedido parceiro') || lowerKey.includes('pedido marketplace')) {
      pedidoId = value?.toString();
    }
    // CLIENTE
    if (lowerKey.includes('cliente')) {
      cliente = value?.toString() || 'N/A';
    }
    // TOTAL DO PEDIDO
    if (lowerKey.includes('total do pedido')) {
      const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
      valor = parseFloat(valStr) || 0;
    }
    // STATUS ATUAL
    if (lowerKey.includes('status atual')) {
      status = value?.toString() || 'DESCONHECIDO';
    }
  }
  
  // Se não achou o pedido, tenta a primeira coluna
  if (!pedidoId) {
    const values = Object.values(row);
    if (values.length > 0) {
      pedidoId = values[0]?.toString();
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'WEBCONTINENTAL',
    status: status,
    valor_total: valor,
    cliente: cliente,
    raw: row
  };
}

// Rota GET - Página de upload
router.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Comparar Planilha - Monitor360</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: #0a0e17;
          color: #e2e8f0;
          font-family: 'JetBrains Mono', monospace;
          padding: 40px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: #00d4ff; margin-bottom: 20px; font-family: 'Syne', sans-serif; }
        .upload-area {
          border: 2px dashed #1e2d40;
          border-radius: 8px;
          padding: 60px 40px;
          text-align: center;
          cursor: pointer;
          background: #111827;
          margin: 20px 0;
          transition: all .3s;
        }
        .upload-area:hover { border-color: #00d4ff; background: rgba(0,212,255,.05); }
        .upload-area.drag-over { border-color: #00d4ff; background: rgba(0,212,255,.1); }
        .result-card {
          background: #111827;
          border: 1px solid #1e2d40;
          border-radius: 8px;
          padding: 20px;
          margin-top: 20px;
        }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
        .badge-success { background: #00e676; color: #000; }
        .badge-danger { background: #ff1744; color: #fff; }
        .badge-warning { background: #ffab00; color: #000; }
        .badge-info { background: #00d4ff; color: #000; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #1e2d40; }
        th { color: #64748b; font-size: 10px; text-transform: uppercase; }
        .loading { text-align: center; padding: 40px; }
        .spinner { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .debug-box { background: #1a2332; padding: 10px; border-radius: 4px; font-size: 11px; margin-top: 10px; overflow-x: auto; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📤 Comparar Planilha de Vendas</h1>
        <p>Envie uma planilha (Excel/CSV) para verificar quais pedidos NÃO foram integrados no sistema.</p>
        <p style="color: #00d4ff; font-size: 12px;">✅ Suporta planilhas da Magazine Luiza e WebContinental</p>
        
        <div class="upload-area" id="uploadArea">
          <div style="font-size: 48px; margin-bottom: 16px;">📊</div>
          <h3>Clique ou arraste sua planilha aqui</h3>
          <p style="color: #64748b; margin-top: 8px;">Suporta .xlsx, .xls, .csv</p>
          <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" style="display: none;">
        </div>
        
        <div id="loading" style="display: none;" class="loading">
          <div class="spinner">⏳</div>
          <p>Processando planilha...</p>
        </div>
        
        <div id="results"></div>
        
        <a href="/" style="color: #00d4ff; text-decoration: none; display: inline-block; margin-top: 20px;">← Voltar ao Dashboard</a>
      </div>
      
      <script>
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const loading = document.getElementById('loading');
        const results = document.getElementById('results');
        
        uploadArea.onclick = () => fileInput.click();
        uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); };
        uploadArea.ondragleave = () => uploadArea.classList.remove('drag-over');
        uploadArea.ondrop = (e) => {
          e.preventDefault();
          uploadArea.classList.remove('drag-over');
          if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
        };
        fileInput.onchange = (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); };
        
        async function uploadFile(file) {
          const formData = new FormData();
          formData.append('planilha', file);
          
          loading.style.display = 'block';
          results.innerHTML = '';
          
          try {
            const response = await fetch('/upload/compare', { method: 'POST', body: formData });
            const data = await response.json();
            displayResults(data);
          } catch (error) {
            results.innerHTML = '<div class="result-card" style="color: #ff1744;">❌ Erro: ' + error.message + '</div>';
          } finally {
            loading.style.display = 'none';
          }
        }
        
        function displayResults(data) {
          if (data.error) {
            results.innerHTML = '<div class="result-card" style="color: #ffab00;">⚠️ ' + data.error + '</div>';
            return;
          }
          
          const total = data.total_planilha;
          const integrados = data.total_integrados;
          const naoIntegrados = data.nao_integrados?.length || 0;
          const taxa = total > 0 ? ((integrados / total) * 100).toFixed(1) : 0;
          
          let html = '<div class="result-card">';
          html += '<h2>📊 Resultado da Comparação</h2>';
          html += '<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 20px 0;">';
          html += '<div><strong style="font-size: 32px; color: #00d4ff;">' + total + '</strong><br/>Total Pedidos</div>';
          html += '<div><strong style="font-size: 32px; color: #00e676;">' + integrados + '</strong><br/>Integrados</div>';
          html += '<div><strong style="font-size: 32px; color: #ffab00;">' + naoIntegrados + '</strong><br/>NÃO Integrados</div>';
          html += '<div><strong style="font-size: 32px; color: #00d4ff;">' + taxa + '%</strong><br/>Taxa de Integração</div>';
          html += '</div>';
          
          html += '<div class="debug-box">';
          html += '🔍 Tipo de planilha detectada: <strong>' + (data.tipo_planilha || 'DESCONHECIDO') + '</strong><br>';
          html += '🔍 Normalização de IDs: IDs da planilha são comparados com e sem sufixo (-1, -2)';
          html += '</div>';
          
          if (naoIntegrados > 0) {
            html += '<h3 style="color: #ffab00; margin: 20px 0 10px;">⚠️ Pedidos NÃO Integrados (' + naoIntegrados + ')</h3>';
            html += '<div style="overflow-x: auto;"><table><thead><tr>';
            html += '<th>ID na Planilha</th><th>ID Normalizado</th><th>IDs no Banco</th><th>Marketplace</th><th>Status</th><th>Valor</th><th>Cliente</th>';
            html += '</tr></thead><tbody>';
            
            data.nao_integrados.slice(0, 50).forEach(p => {
              html += '<tr>';
              html += '<td><code>' + (p.pedido_id_original || 'N/A') + '</code></td>';
              html += '<td><code>' + (p.pedido_id_normalizado || '-') + '</code></td>';
              html += '<td>' + (p.ids_encontrados?.join(', ') || '-') + '</td>';
              html += '<td><span class="badge badge-warning">' + (p.marketplace || 'N/A') + '</span></td>';
              html += '<td>' + (p.status || '-') + '</td>';
              html += '<td>R$ ' + (parseFloat(p.valor_total)?.toFixed(2) || '0,00') + '</td>';
              html += '<td>' + (p.cliente?.substring(0, 40) || '-') + '</td>';
              html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            if (naoIntegrados > 50) html += '<p style="color: #64748b; margin-top: 10px;">... e mais ' + (naoIntegrados - 50) + ' pedidos</p>';
          } else {
            html += '<div style="text-align: center; padding: 40px; color: #00e676;">✅ Todos os pedidos da planilha foram integrados com sucesso!</div>';
          }
          
          html += '</div>';
          results.innerHTML = html;
        }
      </script>
    </body>
    </html>
  `);
});

// Rota POST - Processar upload
router.post('/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    // Ler a planilha
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet);

    if (rawData.length === 0) {
      return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });
    }

    // Detectar tipo de planilha
    const headers = Object.keys(rawData[0]);
    const tipoPlanilha = detectSheetType(headers);
    
    console.log('📋 Tipo de planilha detectado:', tipoPlanilha);
    console.log('📋 Headers:', headers);

    // Extrair pedidos conforme o tipo
    let pedidosPlanilha = [];
    
    if (tipoPlanilha === 'MAGAZINE_LUIZA') {
      pedidosPlanilha = rawData.map(row => extractMagazineLuizaOrder(row));
    } else if (tipoPlanilha === 'WEBCONTINENTAL') {
      pedidosPlanilha = rawData.map(row => extractWebContinentalOrder(row));
    } else {
      // Fallback: tenta detectar automaticamente
      pedidosPlanilha = rawData.map(row => {
        let pedidoId = null;
        const values = Object.values(row);
        if (values.length > 0) pedidoId = values[0]?.toString();
        if (values.length > 1 && !pedidoId) pedidoId = values[1]?.toString();
        
        return {
          pedido_id_original: pedidoId,
          pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
          marketplace: 'DESCONHECIDO',
          status: 'DESCONHECIDO',
          valor_total: 0,
          cliente: 'N/A',
          raw: row
        };
      });
    }

    // Filtrar pedidos válidos
    const pedidosValidos = pedidosPlanilha.filter(p => p.pedido_id_original && p.pedido_id_original !== 'N/A');
    
    if (pedidosValidos.length === 0) {
      return res.status(400).json({ error: 'Não foi possível identificar os IDs dos pedidos na planilha.' });
    }

    // Lista de possíveis IDs para buscar (original e normalizado)
    const possiveisIds = [];
    for (const pedido of pedidosValidos) {
      possiveisIds.push(pedido.pedido_id_original);
      if (pedido.pedido_id_normalizado && pedido.pedido_id_normalizado !== pedido.pedido_id_original) {
        possiveisIds.push(pedido.pedido_id_normalizado);
      }
      // Também busca com sufixo -1 (caso o banco tenha e a planilha não)
      if (!pedido.pedido_id_original.endsWith('-1')) {
        possiveisIds.push(pedido.pedido_id_original + '-1');
      }
    }

    // Buscar no banco
    const result = await pool.query(
      `SELECT DISTINCT te.pedido_id 
       FROM tracking_events te
       WHERE te.pedido_id = ANY($1::text[])`,
      [possiveisIds]
    );

    const integradosSet = new Set(result.rows.map(r => r.pedido_id));
    
    // Verificar cada pedido
    const naoIntegrados = [];
    for (const pedido of pedidosValidos) {
      // Verifica se algum dos possíveis IDs está no banco
      const idsToCheck = [
        pedido.pedido_id_original,
        pedido.pedido_id_normalizado,
        pedido.pedido_id_original + '-1',
        pedido.pedido_id_normalizado + '-1'
      ].filter(id => id);
      
      const encontrados = idsToCheck.filter(id => integradosSet.has(id));
      
      if (encontrados.length === 0) {
        naoIntegrados.push({
          ...pedido,
          ids_encontrados: encontrados
        });
      }
    }

    // Salvar histórico
    try {
      await pool.query(`
        INSERT INTO comparacoes_planilhas 
        (id, realizada_em, marketplace_detectado, total_pedidos, total_integrados, nao_integrados_count, detalhes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        uuidv4(),
        new Date(),
        tipoPlanilha,
        pedidosValidos.length,
        pedidosValidos.length - naoIntegrados.length,
        naoIntegrados.length,
        JSON.stringify({ 
          nao_integrados: naoIntegrados.slice(0, 100),
          tipo_planilha: tipoPlanilha 
        })
      ]);
    } catch (err) {
      console.error('Erro ao salvar histórico:', err.message);
    }

    res.json({
      tipo_planilha: tipoPlanilha,
      total_planilha: pedidosValidos.length,
      total_integrados: pedidosValidos.length - naoIntegrados.length,
      nao_integrados: naoIntegrados.map(p => ({
        pedido_id_original: p.pedido_id_original,
        pedido_id_normalizado: p.pedido_id_normalizado,
        ids_encontrados: p.ids_encontrados,
        marketplace: p.marketplace,
        status: p.status,
        valor_total: p.valor_total,
        cliente: p.cliente
      }))
    });

  } catch (error) {
    console.error('Erro no upload:', error);
    res.status(500).json({ error: 'Erro ao processar planilha: ' + error.message });
  }
});

module.exports = router;