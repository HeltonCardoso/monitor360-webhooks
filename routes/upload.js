// routes/upload.js - VERSÃO CORRIGIDA
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

function normalizeOrderId(id) {
  if (!id) return id;
  const idStr = id.toString().trim();
  return idStr.replace(/-\d+$/, '');
}

// CORREÇÃO: Extrair dados da planilha Magazine Luiza (formato problemático)
function extractMagazineLuizaOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  let data = null;
  
  // Pega a primeira célula que contém todos os dados (formato CSV em uma célula)
  const firstCell = Object.values(row)[0]?.toString() || '';
  
  // Se a primeira célula contém vírgulas, é o formato problemático
  if (firstCell.includes(',') && firstCell.includes('LU-')) {
    // Divide por vírgula, mas respeita os campos que podem ter vírgula
    const parts = firstCell.split(',');
    
    // Mapeamento das colunas baseado na ordem do CSV da Magalu
    // 0: Data do Pacote, 1: Número do pedido, 2: Número do pacote, etc.
    if (parts.length > 1) {
      // ID do pedido está na segunda posição (índice 1)
      let rawId = parts[1]?.trim();
      if (rawId) {
        // Remove aspas se existirem
        pedidoId = rawId.replace(/^["']|["']$/g, '');
      }
      
      // Cliente - procura "Nome do cliente" no conteúdo
      const clienteMatch = firstCell.match(/Nome do cliente[^,]*,([^,]*)/i);
      if (clienteMatch) {
        cliente = clienteMatch[1]?.trim() || 'N/A';
      }
      
      // Valor total - procura "Valor total do Pacote"
      const valorMatch = firstCell.match(/Valor total do Pacote[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,([^,]*)/i);
      if (valorMatch) {
        const valStr = valorMatch[1]?.replace('R$', '').trim();
        valor = parseFloat(valStr?.replace('.', '').replace(',', '.')) || 0;
      }
      
      // Status - procura "Status pacote"
      const statusMatch = firstCell.match(/Status pacote no momento que o relatório foi solicitado[^,]*,[^,]*,[^,]*,[^,]*,([^,]*)/i);
      if (statusMatch) {
        status = statusMatch[1]?.trim() || 'DESCONHECIDO';
      }
    }
  } else {
    // Formato normal de planilha
    for (const [key, value] of Object.entries(row)) {
      const lowerKey = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      
      if (lowerKey.includes('numerodopedido') || lowerKey.includes('pedido') && !lowerKey.includes('pacote')) {
        pedidoId = value?.toString();
      }
      if (lowerKey.includes('nomedocliente') || lowerKey === 'nome do cliente') {
        cliente = value?.toString() || 'N/A';
      }
      if (lowerKey.includes('valortotaldopacote') || lowerKey === 'valor total do pacote') {
        const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
        valor = parseFloat(valStr) || 0;
      }
      if (lowerKey.includes('statuspacote')) {
        status = value?.toString() || 'DESCONHECIDO';
      }
    }
  }
  
  // Fallback: procura por padrão LU-xxxx no conteúdo
  if (!pedidoId) {
    const cellContent = JSON.stringify(row);
    const luMatch = cellContent.match(/LU-\d+/);
    if (luMatch) {
      pedidoId = luMatch[0];
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MAGAZINE_LUIZA',
    status: status,
    valor_total: valor,
    cliente: cliente.substring(0, 100),
    data: data,
    raw: row
  };
}

function extractWebContinentalOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey.includes('pedido parceiro') || lowerKey === 'pedido_parceiro') {
      pedidoId = value?.toString();
    }
    if (lowerKey.includes('cliente')) {
      cliente = value?.toString() || 'N/A';
    }
    if (lowerKey.includes('total do pedido')) {
      const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
      valor = parseFloat(valStr) || 0;
    }
    if (lowerKey.includes('status atual')) {
      status = value?.toString() || 'DESCONHECIDO';
    }
  }
  
  if (!pedidoId) {
    const values = Object.values(row);
    if (values.length > 0 && values[0] && !isNaN(parseInt(values[0]))) {
      pedidoId = values[0]?.toString();
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'WEBCONTINENTAL',
    status: status,
    valor_total: valor,
    cliente: cliente.substring(0, 100),
    data: null,
    raw: row
  };
}

function extractMadeiraMadeiraOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    
    if (key === 'Pedido' || lowerKey === 'pedido') {
      pedidoId = value?.toString();
    }
    if (lowerKey.includes('cliente')) {
      cliente = value?.toString() || 'N/A';
    }
    if (lowerKey.includes('valor pedido') || lowerKey === 'valor_pedido') {
      const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
      valor = parseFloat(valStr) || 0;
    }
    if (lowerKey === 'status') {
      status = value?.toString() || 'DESCONHECIDO';
    }
  }
  
  if (!pedidoId) {
    const values = Object.values(row);
    if (values.length > 2) {
      pedidoId = values[2]?.toString();
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MADEIRAMADEIRA',
    status: status,
    valor_total: valor,
    cliente: cliente.substring(0, 100),
    data: null,
    raw: row
  };
}

// Rota GET
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
        body { background: #0a0e17; color: #e2e8f0; font-family: 'JetBrains Mono', monospace; padding: 40px; }
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
        .result-card { background: #111827; border: 1px solid #1e2d40; border-radius: 8px; padding: 20px; margin-top: 20px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
        .badge-success { background: #00e676; color: #000; }
        .badge-danger { background: #ff1744; color: #fff; }
        .badge-warning { background: #ffab00; color: #000; }
        .badge-magalu { background: #ff0066; color: #fff; }
        .badge-webcontinental { background: #00b4d8; color: #fff; }
        .badge-madeira { background: #2d6a4f; color: #fff; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #1e2d40; }
        th { color: #64748b; font-size: 10px; text-transform: uppercase; }
        .loading { text-align: center; padding: 40px; }
        .spinner { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .debug-box { background: #1a2332; padding: 10px; border-radius: 4px; font-size: 11px; margin-top: 10px; overflow-x: auto; }
        .supported-formats { display: flex; gap: 20px; margin: 20px 0; flex-wrap: wrap; }
        .format-badge { background: #1a2332; padding: 8px 16px; border-radius: 20px; font-size: 12px; border-left: 3px solid #00d4ff; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📤 Comparar Planilha de Vendas</h1>
        <p>Envie uma planilha (Excel/CSV) para verificar quais pedidos NÃO foram integrados no sistema.</p>
        
        <div class="supported-formats">
          <div class="format-badge">📱 Magazine Luiza</div>
          <div class="format-badge">💻 WebContinental</div>
          <div class="format-badge">🪵 MadeiraMadeira</div>
          <div class="format-badge">🛒 Amazon</div>
        </div>
        
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
        
        function getMarketplaceBadge(marketplace) {
          const badges = {
            'MAGAZINE_LUIZA': '<span class="badge badge-magalu">📱 Magazine Luiza</span>',
            'WEBCONTINENTAL': '<span class="badge badge-webcontinental">💻 WebContinental</span>',
            'MADEIRAMADEIRA': '<span class="badge badge-madeira">🪵 MadeiraMadeira</span>'
          };
          return badges[marketplace] || '<span class="badge badge-warning">❓ ' + marketplace + '</span>';
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
          html += '🔍 Tipo de planilha detectada: ' + getMarketplaceBadge(data.tipo_planilha) + '<br>';
          html += '🔍 IDs encontrados: ' + (data.ids_encontrados || 0) + '<br>';
          html += '🔍 Normalização: IDs com e sem sufixo (-1, -2) são comparados automaticamente';
          html += '</div>';
          
          if (naoIntegrados > 0) {
            html += '<h3 style="color: #ffab00; margin: 20px 0 10px;">⚠️ Pedidos NÃO Integrados (' + naoIntegrados + ')</h3>';
            html += '<div style="overflow-x: auto;"><table><thead>搬';
            html += '<th>ID na Planilha</th><th>ID Normalizado</th><th>Marketplace</th><th>Status</th><th>Valor</th><th>Cliente</th>';
            html += '</thead><tbody>';
            
            data.nao_integrados.slice(0, 50).forEach(p => {
              html += '<tr>';
              html += '<td><code>' + (p.pedido_id_original || 'N/A') + '</code></td>';
              html += '<td><code>' + (p.pedido_id_normalizado || '-') + '</code></td>';
              html += '<td>' + getMarketplaceBadge(p.marketplace) + '</td>';
              html += '<td>' + (p.status || '-') + '</td>';
              html += '<td>R$ ' + (parseFloat(p.valor_total)?.toFixed(2) || '0,00') + '</td>';
              html += '<td>' + (p.cliente?.substring(0, 40) || '-') + '</td>';
              html += '</tr>';
            });
            
            html += '</tbody></table></div>';
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

// Rota POST
router.post('/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    let rawData = xlsx.utils.sheet_to_json(worksheet);

    if (rawData.length === 0) {
      return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });
    }

    // Detecta se é Magazine Luiza (primeira célula contém dados CSV)
    const firstRow = rawData[0];
    const firstCell = Object.values(firstRow)[0]?.toString() || '';
    const isMagaluCsv = firstCell.includes('LU-') && firstCell.includes(',') && firstCell.includes('Data do Pacote');
    
    let tipoPlanilha = 'DESCONHECIDO';
    let pedidosPlanilha = [];
    
    if (isMagaluCsv || (firstCell.includes('LU-') && firstCell.length > 100)) {
      tipoPlanilha = 'MAGAZINE_LUIZA';
      pedidosPlanilha = rawData.map(row => extractMagazineLuizaOrder(row));
    } else if (firstCell.includes('Parceiro Portal') || firstCell.includes('Pedido Parceiro')) {
      tipoPlanilha = 'WEBCONTINENTAL';
      pedidosPlanilha = rawData.map(row => extractWebContinentalOrder(row));
    } else {
      // Tenta detectar automaticamente
      tipoPlanilha = 'WEBCONTINENTAL';
      pedidosPlanilha = rawData.map(row => extractWebContinentalOrder(row));
      
      // Se não achou IDs, tenta Magalu
      if (pedidosPlanilha.filter(p => p.pedido_id_original && p.pedido_id_original.length > 3).length === 0) {
        tipoPlanilha = 'MAGAZINE_LUIZA';
        pedidosPlanilha = rawData.map(row => extractMagazineLuizaOrder(row));
      }
    }
    
    console.log('📋 Tipo detectado:', tipoPlanilha);
    console.log('📋 Total linhas:', rawData.length);
    
    // Filtrar pedidos válidos
    const pedidosValidos = pedidosPlanilha.filter(p => 
      p.pedido_id_original && 
      p.pedido_id_original !== 'N/A' && 
      p.pedido_id_original !== 'undefined' &&
      p.pedido_id_original.length > 5
    );
    
    if (pedidosValidos.length === 0) {
      return res.status(400).json({ 
        error: 'Não foi possível identificar os IDs dos pedidos. O arquivo parece ser da Magazine Luiza mas não foi possível extrair os números. Verifique se o arquivo não está corrompido.',
        debug: { firstCell: firstCell.substring(0, 200) }
      });
    }
    
    console.log(`📋 Pedidos válidos: ${pedidosValidos.length}`);
    console.log('📋 Primeiros IDs:', pedidosValidos.slice(0, 3).map(p => p.pedido_id_original));
    
    // Buscar no banco
    const possiveisIds = [];
    for (const pedido of pedidosValidos) {
      possiveisIds.push(pedido.pedido_id_original);
      if (pedido.pedido_id_normalizado && pedido.pedido_id_normalizado !== pedido.pedido_id_original) {
        possiveisIds.push(pedido.pedido_id_normalizado);
      }
    }
    
    const result = await pool.query(
      `SELECT DISTINCT te.pedido_id 
       FROM tracking_events te
       WHERE te.pedido_id = ANY($1::text[])`,
      [possiveisIds]
    );
    
    const integradosSet = new Set(result.rows.map(r => r.pedido_id));
    
    const naoIntegrados = pedidosValidos.filter(pedido => {
      const idsToCheck = [
        pedido.pedido_id_original,
        pedido.pedido_id_normalizado
      ].filter(id => id);
      return idsToCheck.every(id => !integradosSet.has(id));
    });
    
    res.json({
      tipo_planilha: tipoPlanilha,
      total_planilha: pedidosValidos.length,
      total_integrados: pedidosValidos.length - naoIntegrados.length,
      ids_encontrados: result.rows.length,
      nao_integrados: naoIntegrados.map(p => ({
        pedido_id_original: p.pedido_id_original,
        pedido_id_normalizado: p.pedido_id_normalizado,
        marketplace: p.marketplace,
        status: p.status,
        valor_total: p.valor_total,
        cliente: p.cliente
      }))
    });
    
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro ao processar: ' + error.message });
  }
});

module.exports = router;