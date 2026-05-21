// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// Configurar multer para memória
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

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
        .btn { 
          background: #1a2332; 
          border: 1px solid #1e2d40; 
          color: #00d4ff; 
          padding: 10px 20px; 
          border-radius: 4px; 
          cursor: pointer;
          font-family: monospace;
        }
        .btn:hover { background: #00d4ff; color: #0a0e17; }
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
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #1e2d40; }
        th { color: #64748b; font-size: 10px; text-transform: uppercase; }
        .loading { text-align: center; padding: 40px; }
        .spinner { animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📤 Comparar Planilha de Vendas</h1>
        <p>Envie uma planilha (Excel/CSV) para verificar quais pedidos NÃO foram integrados no sistema.</p>
        
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
          
          if (naoIntegrados > 0) {
            html += '<h3 style="color: #ffab00; margin: 20px 0 10px;">⚠️ Pedidos NÃO Integrados (' + naoIntegrados + ')</h3>';
            html += '<div style="overflow-x: auto;"><table><thead><tr>';
            html += '<th>ID Pedido</th><th>Marketplace</th><th>Status</th><th>Valor</th><th>Cliente</th>';
            html += '</tr></thead><tbody>';
            
            data.nao_integrados.slice(0, 50).forEach(p => {
              html += '<tr>';
              html += '<td><code>' + (p.pedido_id || 'N/A') + '</code></td>';
              html += '<td><span class="badge badge-warning">' + (p.marketplace || 'N/A') + '</span></td>';
              html += '<td>' + (p.status || '-') + '</td>';
              html += '<td>R$ ' + (parseFloat(p.valor_total)?.toFixed(2) || '0,00') + '</td>';
              html += '<td>' + (p.cliente?.substring(0, 30) || '-') + '</td>';
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

    // Extrair IDs dos pedidos (tenta várias colunas comuns)
    const pedidosPlanilha = rawData.map(row => {
      let pedidoId = null;
      // Tenta encontrar a coluna de ID do pedido
      const keys = Object.keys(row);
      for (const key of keys) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('pedido') || lowerKey.includes('order') || 
            lowerKey.includes('id') || lowerKey.includes('código') || 
            lowerKey.includes('numero') || lowerKey === 'número') {
          pedidoId = row[key]?.toString();
          break;
        }
      }
      // Se não achou, usa a primeira coluna
      if (!pedidoId && keys.length > 0) {
        pedidoId = row[keys[0]]?.toString();
      }
      
      return {
        pedido_id: pedidoId || 'N/A',
        raw: row
      };
    }).filter(p => p.pedido_id !== 'N/A');

    if (pedidosPlanilha.length === 0) {
      return res.status(400).json({ error: 'Não foi possível identificar os IDs dos pedidos na planilha. Certifique-se de ter uma coluna com "Pedido", "ID" ou "Order".' });
    }

    const pedidoIds = pedidosPlanilha.map(p => p.pedido_id);

    // Buscar no banco quais já existem
    const result = await pool.query(
      `SELECT DISTINCT te.pedido_id 
       FROM tracking_events te
       WHERE te.pedido_id = ANY($1::text[])`,
      [pedidoIds]
    );

    const integradosSet = new Set(result.rows.map(r => r.pedido_id));
    
    const naoIntegrados = pedidosPlanilha.filter(p => !integradosSet.has(p.pedido_id));

    // Salvar histórico
    try {
      await pool.query(`
        INSERT INTO comparacoes_planilhas 
        (id, realizada_em, total_pedidos, total_integrados, nao_integrados_count, detalhes)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        uuidv4(),
        new Date(),
        pedidosPlanilha.length,
        pedidosPlanilha.length - naoIntegrados.length,
        naoIntegrados.length,
        JSON.stringify({ nao_integrados: naoIntegrados.slice(0, 100) })
      ]);
    } catch (err) {
      console.error('Erro ao salvar histórico:', err.message);
    }

    res.json({
      total_planilha: pedidosPlanilha.length,
      total_integrados: pedidosPlanilha.length - naoIntegrados.length,
      nao_integrados: naoIntegrados.map(p => ({
        pedido_id: p.pedido_id,
        marketplace: p.raw.Marketplace || p.raw.marketplace || 'DESCONHECIDO',
        status: p.raw.Status || p.raw.status || 'DESCONHECIDO',
        valor_total: parseFloat(p.raw.Valor || p.raw.valor || 0),
        cliente: p.raw.Cliente || p.raw.cliente || 'N/A'
      }))
    });

  } catch (error) {
    console.error('Erro no upload:', error);
    res.status(500).json({ error: 'Erro ao processar planilha: ' + error.message });
  }
});

module.exports = router;