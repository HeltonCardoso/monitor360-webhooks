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
  return idStr.replace(/-\d+$/, '');
}

// Função para identificar qual tipo de planilha é
function detectSheetType(headers, firstRow) {
  const headerStr = headers.join(',').toLowerCase();
  const firstRowStr = firstRow ? JSON.stringify(firstRow).toLowerCase() : '';
  
  // 1. AMAZON - Tem colunas específicas como 'order-id', 'purchase-date'
  if (headerStr.includes('order-id') && headerStr.includes('purchase-date')) {
    return 'AMAZON';
  }
  
  // 2. MAGAZINE LUIZA - Tem 'Número do pedido' ou 'numero do pedido' ou 'LU-' no ID
  if (headerStr.includes('número do pedido') || headerStr.includes('numero do pedido')) {
    return 'MAGAZINE_LUIZA';
  }
  
  // 3. WEBCONTINENTAL - Tem 'Pedido Parceiro' ou 'Pedido Marketplace'
  if (headerStr.includes('pedido parceiro') || headerStr.includes('pedido marketplace')) {
    return 'WEBCONTINENTAL';
  }
  
  // 4. MADEIRAMADEIRA - Tem coluna 'Pedido' (exata) e 'Cliente'
  if (headers.includes('Pedido') && headers.includes('Cliente')) {
    return 'MADEIRAMADEIRA';
  }
  
  // 5. Tenta detectar pela primeira linha (para Magalu com cabeçalho em português)
  if (firstRowStr.includes('magazine luiza') || firstRowStr.includes('lu-')) {
    return 'MAGAZINE_LUIZA';
  }
  
  return 'DESCONHECIDO';
}

// Extrair dados da planilha AMAZON
function extractAmazonOrder(row) {
  let pedidoId = row['order-id'] || row['order_id'] || null;
  let cliente = row['buyer-name'] || row['buyer_name'] || 'N/A';
  let valor = 0;
  let status = 'APROVADO'; // Amazon não tem status na planilha
  let data = row['purchase-date'] || row['purchase_date'] || null;
  
  // Calcula valor total (item-price + shipping-price)
  const itemPrice = parseFloat(row['item-price'] || row['item_price'] || 0);
  const shippingPrice = parseFloat(row['shipping-price'] || row['shipping_price'] || 0);
  valor = itemPrice + shippingPrice;
  
  // Se não achou o pedido, tenta pela primeira coluna
  if (!pedidoId) {
    const values = Object.values(row);
    if (values.length > 0 && values[0] && values[0].toString().includes('-')) {
      pedidoId = values[0]?.toString();
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'AMAZON',
    status: status,
    valor_total: valor,
    cliente: cliente?.substring(0, 100) || 'N/A',
    data: data,
    raw: row
  };
}

// Extrair dados da planilha MAGAZINE LUIZA (corrigido)
function extractMagazineLuizaOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  let data = null;
  
  // Mapeia todas as chaves possíveis para cada campo
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const keyClean = lowerKey.replace(/[^a-z0-9]/g, '');
    
    // PEDIDO ID - várias possibilidades
    if (keyClean.includes('numerodopedido') || 
        keyClean.includes('numeropedido') ||
        keyClean.includes('pedido') && !keyClean.includes('pacote') ||
        key === 'Número do pedido' ||
        key === 'Numero do pedido' ||
        key === 'Pedido') {
      pedidoId = value?.toString();
    }
    
    // CLIENTE
    if (keyClean.includes('nomedocliente') || 
        keyClean.includes('cliente') ||
        key === 'Nome do cliente') {
      cliente = value?.toString() || 'N/A';
    }
    
    // VALOR TOTAL
    if (keyClean.includes('valortotaldopacote') || 
        keyClean.includes('valortotal') ||
        key === 'Valor total do Pacote') {
      const valStr = value?.toString().replace('R$', '').replace(/\./g, '').replace(',', '.').trim();
      valor = parseFloat(valStr) || 0;
    }
    
    // STATUS
    if (keyClean.includes('statuspacote') || 
        keyClean.includes('status') ||
        key === 'Status pacote no momento que o relatório foi solicitado') {
      status = value?.toString() || 'DESCONHECIDO';
    }
    
    // DATA
    if (keyClean.includes('datadopacote') || 
        keyClean.includes('data') ||
        key === 'Data do Pacote') {
      data = value;
    }
  }
  
  // Se não achou o pedido, tenta a segunda coluna (padrão Magalu)
  if (!pedidoId) {
    const values = Object.values(row);
    // Procura um valor que parece ID da Magalu (começa com LU-)
    for (const val of values) {
      const valStr = val?.toString() || '';
      if (valStr.startsWith('LU-') && valStr.length > 10) {
        pedidoId = valStr;
        break;
      }
    }
    // Se ainda não achou, pega o segundo valor
    if (!pedidoId && values.length > 1) {
      pedidoId = values[1]?.toString();
    }
  }
  
  return {
    pedido_id_original: pedidoId,
    pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null,
    marketplace: 'MAGAZINE_LUIZA',
    status: status,
    valor_total: valor,
    cliente: cliente?.substring(0, 100) || 'N/A',
    data: data,
    raw: row
  };
}

// Extrair dados da planilha WEBCONTINENTAL
function extractWebContinentalOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  let data = null;
  
  for (const [key, value] of Object.entries(row)) {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey.includes('pedido parceiro') || lowerKey.includes('pedido marketplace')) {
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
    if (lowerKey.includes('data criação') || lowerKey.includes('data criacao')) {
      data = value;
    }
  }
  
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
    cliente: cliente?.substring(0, 100) || 'N/A',
    data: data,
    raw: row
  };
}

// Extrair dados da planilha MADEIRAMADEIRA
function extractMadeiraMadeiraOrder(row) {
  let pedidoId = null;
  let cliente = 'N/A';
  let valor = 0;
  let status = 'DESCONHECIDO';
  let data = null;
  
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
    if (lowerKey.includes('data pedido')) {
      data = value;
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
    cliente: cliente?.substring(0, 100) || 'N/A',
    data: data,
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
        .badge-magalu { background: #ff0066; color: #fff; }
        .badge-webcontinental { background: #00b4d8; color: #fff; }
        .badge-madeira { background: #2d6a4f; color: #fff; }
        .badge-amazon { background: #ff9900; color: #000; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #1e2d40; }
        th { color: #64748b; font-size: 10px; text-transform: uppercase; }
        .loading { text-align: center; padding: 40px; }
        .spinner { animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .debug-box { background: #1a2332; padding: 10px; border-radius: 4px; font-size: 11px; margin-top: 10px; overflow-x: auto; }
        .supported-formats {
          display: flex; gap: 20px; margin: 20px 0; flex-wrap: wrap;
        }
        .format-badge {
          background: #1a2332; padding: 8px 16px; border-radius: 20px;
          font-size: 12px; border-left: 3px solid #00d4ff;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📤 Comparar Planilha de Vendas</h1>
        <p>Envie uma planilha (Excel/CSV) para verificar quais pedidos NÃO foram integrados no sistema.</p>
        
        <div class="supported-formats">
          <div class="format-badge">📱 Magazine Luiza</div>
          <div class="format-badge">🛒 Amazon</div>
          <div class="format-badge">💻 WebContinental</div>
          <div class="format-badge">🪵 MadeiraMadeira</div>
        </div>
        
        <div class="upload-area" id="uploadArea">
          <div style="font-size: 48px; margin-bottom: 16px;">📊</div>
          <h3>Clique ou arraste sua planilha aqui</h3>
          <p style="color: #64748b; margin-top: 8px;">Suporta .xlsx, .xls, .csv, .txt</p>
          <input type="file" id="fileInput" accept=".xlsx,.xls,.csv,.txt" style="display: none;">
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
            'MADEIRAMADEIRA': '<span class="badge badge-madeira">🪵 MadeiraMadeira</span>',
            'AMAZON': '<span class="badge badge-amazon">🛒 Amazon</span>'
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
          html += '🔍 Normalização de IDs: IDs da planilha são comparados com e sem sufixo (-1, -2)<br>';
          if (data.debug_info) {
            html += '🔍 Debug: ' + data.debug_info;
          }
          html += '</div>';
          
          if (naoIntegrados > 0) {
            html += '<h3 style="color: #ffab00; margin: 20px 0 10px;">⚠️ Pedidos NÃO Integrados (' + naoIntegrados + ')</h3>';
            html += '<div style="overflow-x: auto;"><table><thead>49ight';
            html += '<th>ID na Planilha</th><th>ID Normalizado</th><th>Marketplace</th><th>Status</th><th>Valor</th><th>Cliente</th><th>Data</th>';
            html += '</thead><tbody>';
            
            data.nao_integrados.slice(0, 50).forEach(p => {
              html += '<tr>';
              html += '<td><code>' + (p.pedido_id_original || 'N/A') + '</code></td>';
              html += '<td><code>' + (p.pedido_id_normalizado || '-') + '</code></td>';
              html += '<td>' + getMarketplaceBadge(p.marketplace) + '</td>';
              html += '<td>' + (p.status || '-') + '</td>';
              html += '<td>R$ ' + (parseFloat(p.valor_total)?.toFixed(2) || '0,00') + '</td>';
              html += '<td>' + (p.cliente?.substring(0, 40) || '-') + '</td>';
              html += '<td>' + (p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '-') + '</td>';
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

    let rawData = [];
    let tipoPlanilha = 'DESCONHECIDO';
    
    // Verifica se é arquivo TXT (formato Amazon TAB separado)
    if (req.file.originalname.endsWith('.txt')) {
      const content = req.file.buffer.toString('utf8');
      const lines = content.split('\n');
      const headers = lines[0].split('\t');
      
      rawData = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim()) {
          const values = lines[i].split('\t');
          const row = {};
          headers.forEach((header, idx) => {
            row[header] = values[idx] || '';
          });
          rawData.push(row);
        }
      }
      tipoPlanilha = 'AMAZON';
    } else {
      // Arquivo Excel/CSV normal
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      rawData = xlsx.utils.sheet_to_json(worksheet);
      
      if (rawData.length === 0) {
        return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });
      }
      
      // Detectar tipo de planilha
      const headers = Object.keys(rawData[0]);
      tipoPlanilha = detectSheetType(headers, rawData[0]);
    }
    
    console.log('📋 Tipo de planilha detectado:', tipoPlanilha);
    console.log('📋 Total de linhas:', rawData.length);

    // Extrair pedidos conforme o tipo
    let pedidosPlanilha = [];
    
    if (tipoPlanilha === 'AMAZON') {
      pedidosPlanilha = rawData.map(row => extractAmazonOrder(row));
    } else if (tipoPlanilha === 'MAGAZINE_LUIZA') {
      pedidosPlanilha = rawData.map(row => extractMagazineLuizaOrder(row));
    } else if (tipoPlanilha === 'WEBCONTINENTAL') {
      pedidosPlanilha = rawData.map(row => extractWebContinentalOrder(row));
    } else if (tipoPlanilha === 'MADEIRAMADEIRA') {
      pedidosPlanilha = rawData.map(row => extractMadeiraMadeiraOrder(row));
    } else {
      // Fallback: tenta todos os extratores
      for (const row of rawData) {
        let extracted = null;
        
        // Tenta Amazon
        const amazonTry = extractAmazonOrder(row);
        if (amazonTry.pedido_id_original && amazonTry.pedido_id_original.includes('-')) {
          extracted = amazonTry;
        } else {
          // Tenta Magalu
          const magaluTry = extractMagazineLuizaOrder(row);
          if (magaluTry.pedido_id_original && magaluTry.pedido_id_original.startsWith('LU-')) {
            extracted = magaluTry;
          } else if (magaluTry.pedido_id_original && magaluTry.pedido_id_original.length > 5) {
            extracted = magaluTry;
          } else {
            extracted = magaluTry;
          }
        }
        
        pedidosPlanilha.push(extracted);
      }
      tipoPlanilha = 'MULTIPLO';
    }

    // Filtrar pedidos válidos
    const pedidosValidos = pedidosPlanilha.filter(p => 
      p.pedido_id_original && 
      p.pedido_id_original !== 'N/A' && 
      p.pedido_id_original !== 'undefined' &&
      p.pedido_id_original.length > 3
    );
    
    if (pedidosValidos.length === 0) {
      return res.status(400).json({ 
        error: 'Não foi possível identificar os IDs dos pedidos na planilha. Verifique se há uma coluna com "Pedido", "Número do pedido", "order-id" ou similar.' 
      });
    }

    console.log(`📋 Pedidos válidos extraídos: ${pedidosValidos.length}`);

    // Lista de possíveis IDs para buscar
    const possiveisIds = [];
    for (const pedido of pedidosValidos) {
      possiveisIds.push(pedido.pedido_id_original);
      if (pedido.pedido_id_normalizado && pedido.pedido_id_normalizado !== pedido.pedido_id_original) {
        possiveisIds.push(pedido.pedido_id_normalizado);
      }
      if (!pedido.pedido_id_original.endsWith('-1')) {
        possiveisIds.push(pedido.pedido_id_original + '-1');
      }
      if (pedido.pedido_id_normalizado && !pedido.pedido_id_normalizado.endsWith('-1')) {
        possiveisIds.push(pedido.pedido_id_normalizado + '-1');
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
      const idsToCheck = [
        pedido.pedido_id_original,
        pedido.pedido_id_normalizado,
        pedido.pedido_id_original + '-1',
        pedido.pedido_id_normalizado ? pedido.pedido_id_normalizado + '-1' : null
      ].filter(id => id);
      
      const encontrados = idsToCheck.filter(id => integradosSet.has(id));
      
      if (encontrados.length === 0) {
        naoIntegrados.push(pedido);
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
          nao_integrados: naoIntegrados.slice(0, 100).map(p => ({
            id: p.pedido_id_original,
            marketplace: p.marketplace
          }))
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
        marketplace: p.marketplace,
        status: p.status,
        valor_total: p.valor_total,
        cliente: p.cliente,
        data: p.data
      }))
    });

  } catch (error) {
    console.error('Erro no upload:', error);
    res.status(500).json({ error: 'Erro ao processar planilha: ' + error.message });
  }
});

module.exports = router;