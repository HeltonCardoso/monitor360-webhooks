// services/spreadsheet-import.js
const xlsx = require('xlsx');
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class SpreadsheetImport {
  /**
   * Detecta automaticamente o formato da planilha
   * @param {Buffer} fileBuffer - Buffer do arquivo
   * @returns {Object} Dados extraídos
   */
  detectAndParse(fileBuffer) {
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet);
    
    if (rawData.length === 0) return null;
    
    // Detecta mapeamento de colunas baseado nos cabeçalhos
    const firstRow = rawData[0];
    const columnMapping = this.autoDetectColumns(firstRow);
    
    return {
      marketplace: this.detectMarketplace(firstRow),
      columnMapping,
      orders: rawData.map(row => this.extractOrder(row, columnMapping))
    };
  }
  
  autoDetectColumns(row) {
    const mapping = {
      pedidoId: null,
      status: null,
      valor: null,
      data: null,
      cliente: null,
      produto: null
    };
    
    const keys = Object.keys(row).map(k => k.toLowerCase());
    
    // Mapeamento inteligente
    const patterns = {
      pedidoId: ['pedido', 'order', 'id', 'número', 'numero', 'orderid'],
      status: ['status', 'situação', 'situacao', 'estado'],
      valor: ['valor', 'total', 'amount', 'price'],
      data: ['data', 'date', 'criado', 'created'],
      cliente: ['cliente', 'customer', 'comprador', 'buyer'],
      produto: ['produto', 'product', 'item', 'sku']
    };
    
    for (const [field, patternsList] of Object.entries(patterns)) {
      for (const key of keys) {
        if (patternsList.some(p => key.includes(p))) {
          mapping[field] = Object.keys(row).find(k => k.toLowerCase() === key);
          break;
        }
      }
    }
    
    return mapping;
  }
  
  detectMarketplace(row) {
    const rowStr = JSON.stringify(row).toLowerCase();
    if (rowStr.includes('mercado livre') || rowStr.includes('mercadolivre')) return 'MERCADO_LIVRE';
    if (rowStr.includes('shopee')) return 'SHOPEE';
    if (rowStr.includes('magalu') || rowStr.includes('magazine')) return 'MAGAZINE_LUIZA';
    if (rowStr.includes('amazon')) return 'AMAZON';
    return 'OUTRO';
  }
  
  extractOrder(row, mapping) {
    return {
      pedido_id: row[mapping.pedidoId]?.toString() || row['Pedido']?.toString() || 'N/A',
      status: row[mapping.status] || row['Status'] || 'DESCONHECIDO',
      valor_total: parseFloat(row[mapping.valor]?.toString().replace(/[^\d,.-]/g, '').replace(',', '.')) || 0,
      data_pedido: row[mapping.data] || new Date().toISOString(),
      cliente: row[mapping.cliente] || row['Cliente'] || 'N/A',
      produto: row[mapping.produto] || row['Produto'] || 'N/A',
      marketplace: this.detectMarketplace(row)
    };
  }
  
  /**
   * Compara pedidos da planilha com os integrados
   */
  async compareWithIntegrated(fileBuffer) {
    const parsed = this.detectAndParse(fileBuffer);
    if (!parsed) return { error: 'Não foi possível ler a planilha' };
    
    const spreadsheetOrders = parsed.orders;
    
    // Busca pedidos integrados no banco
    const pedidoIds = spreadsheetOrders.map(o => o.pedido_id);
    const integratedResult = await pool.query(
      `SELECT DISTINCT te.pedido_id, te.origem, te.status, pm.marketplace_origem
       FROM tracking_events te
       LEFT JOIN pedidos_mapeamento pm ON te.pedido_id = pm.numero_marketplace
       WHERE te.pedido_id = ANY($1::text[])`,
      [pedidoIds]
    );
    
    const integratedMap = new Map();
    integratedResult.rows.forEach(row => {
      integratedMap.set(row.pedido_id, row);
    });
    
    // Classifica pedidos
    const resultados = {
      total_planilha: spreadsheetOrders.length,
      total_integrados: 0,
      nao_integrados: [],
      parcialmente_integrados: [],
      estatisticas_por_marketplace: {}
    };
    
    for (const order of spreadsheetOrders) {
      const integrado = integratedMap.get(order.pedido_id);
      
      if (!integrado) {
        resultados.nao_integrados.push({
          ...order,
          motivo: 'Pedido não encontrado no sistema'
        });
      } else {
        resultados.total_integrados++;
        
        // Verifica se o fluxo está completo
        const fluxoCompleto = await this.checkFluxoCompleto(order.pedido_id);
        if (!fluxoCompleto.completo) {
          resultados.parcialmente_integrados.push({
            ...order,
            estagio_atual: fluxoCompleto.ultimo_estagio,
            faltando: fluxoCompleto.faltando
          });
        }
      }
      
      // Estatísticas por marketplace
      const mkt = order.marketplace;
      if (!resultados.estatisticas_por_marketplace[mkt]) {
        resultados.estatisticas_por_marketplace[mkt] = { total: 0, integrados: 0 };
      }
      resultados.estatisticas_por_marketplace[mkt].total++;
      if (integrado) resultados.estatisticas_por_marketplace[mkt].integrados++;
    }
    
    // Salva o histórico da comparação
    await this.saveComparisonHistory(resultados, parsed.marketplace);
    
    return resultados;
  }
  
  async checkFluxoCompleto(pedidoId) {
    const events = await pool.query(
      `SELECT DISTINCT origem FROM tracking_events WHERE pedido_id = $1`,
      [pedidoId]
    );
    
    const origens = events.rows.map(r => r.origem);
    const expectedStages = ['ANYMARKET', 'JET', 'ONCLICK'];
    const completedStages = expectedStages.filter(s => origens.includes(s));
    
    return {
      completo: origens.includes('RETORNO_ANYMARKET'),
      ultimo_estagio: origens[origens.length - 1] || 'NENHUM',
      faltando: expectedStages.filter(s => !origens.includes(s))
    };
  }
  
  async saveComparisonHistory(resultados, marketplace) {
    await pool.query(`
      INSERT INTO comparacoes_planilhas 
      (id, realizada_em, marketplace_detectado, total_pedidos, total_integrados, 
       nao_integrados_count, detalhes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      uuidv4(),
      new Date(),
      marketplace,
      resultados.total_planilha,
      resultados.total_integrados,
      resultados.nao_integrados.length,
      JSON.stringify({
        nao_integrados: resultados.nao_integrados.slice(0, 50),
        parcialmente_integrados: resultados.parcialmente_integrados.slice(0, 50),
        estatisticas: resultados.estatisticas_por_marketplace
      })
    ]);
  }
}

module.exports = new SpreadsheetImport();