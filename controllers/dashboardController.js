const pool = require('../config/database');

const DashboardController = {
  async getMetricasGerais(req, res) {
    try {
      // Count distinct pedido_id per origem
      const countOrigemQuery = `
        SELECT origem, COUNT(DISTINCT pedido_id) AS total
        FROM tracking_events
        WHERE origem IN ('ANYMARKET', 'JET', 'ONCLICK')
        GROUP BY origem
      `;
      const origemResult = await pool.query(countOrigemQuery);
      const metricas = { ANYMARKET: 0, JET: 0, ONCLICK: 0 };
      origemResult.rows.forEach(row => {
        metricas[row.origem] = parseInt(row.total, 10);
      });

      // Count unresolved anomalies
      const anomaliasQuery = `SELECT COUNT(*) AS total FROM anomalias WHERE resolvida = false`;
      const anomaliasResult = await pool.query(anomaliasQuery);
      const anomaliasNaoResolvidas = parseInt(anomaliasResult.rows[0].total, 10);

      // Calculate taxa_sincronizacao_jet
      const totalPedidosQuery = `
        SELECT COUNT(DISTINCT pedido_id) AS total FROM tracking_events
        WHERE origem IN ('ANYMARKET', 'JET', 'ONCLICK')
      `;
      const totalPedidosResult = await pool.query(totalPedidosQuery);
      const totalPedidos = parseInt(totalPedidosResult.rows[0].total, 10);
      const jetPedidos = parseInt(metricas.JET, 10);
      const taxaSincronizacaoJet = totalPedidos > 0 ? (jetPedidos / totalPedidos) * 100 : 0;

      // Count pedidos last 24h per origem
      const last24hQuery = `
        SELECT origem, COUNT(DISTINCT pedido_id) AS total
        FROM tracking_events
        WHERE criado_em >= NOW() - INTERVAL '24 hours'
        GROUP BY origem
      `;
      const last24hResult = await pool.query(last24hQuery);
      const pedidos24h = { ANYMARKET: 0, JET: 0, ONCLICK: 0 };
      last24hResult.rows.forEach(row => {
        pedidos24h[row.origem] = parseInt(row.total, 10);
      });

      console.log('Metricas Gerais fetched successfully');
      res.json({
        success: true,
        data: {
          ANYMARKET: metricas.ANYMARKET,
          JET: metricas.JET,
          ONCLICK: metricas.ONCLICK,
          anomaliasNaoResolvidas,
          taxaSincronizacaoJet: parseFloat(taxaSincronizacaoJet.toFixed(2)),
          pedidos24h
        }
      });
    } catch (error) {
      console.error('Error in getMetricasGerais:', error);
      res.status(500).json({ success: false, error: 'Erro ao obter métricas gerais.' });
    }
  },

  async getAnomalias(req, res) {
    try {
      const { limit = 10, resolvida } = req.query;
      let query = `
        SELECT id, pedido_id, tipo, origem_falha AS origem, criado_em, resolvida
        FROM anomalias
        WHERE 1=1
      `;
      const params = [];
      if (resolvida !== undefined) {
        query += ' AND resolvida = $1';
        params.push(resolvida === 'true');
      }
      query += ' ORDER BY criado_em DESC LIMIT $' + (params.length + 1);
      params.push(parseInt(limit, 10));
      const result = await pool.query(query, params);
      console.log('Anomalias fetched successfully');
      res.json({ success: true, anomalias: result.rows });
    } catch (error) {
      console.error('Error in getAnomalias:', error);
      res.status(500).json({ success: false, error: 'Erro ao obter anomalias.' });
    }
  },

  async getPedidosPipeline(req, res) {
    try {
      const { page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;
      // Get total distinct pedidos
      const countQuery = `
        SELECT COUNT(DISTINCT pedido_id) AS total FROM tracking_events
        WHERE origem IN ('ANYMARKET', 'JET', 'ONCLICK')
      `;
      const countResult = await pool.query(countQuery);
      const total = parseInt(countResult.rows[0].total, 10);
      const totalPages = Math.ceil(total / limit);

      // Get distinct pedidos with latest status per origem
      const pedidosQuery = `
        SELECT DISTINCT ON (origem, pedido_id) pedido_id, origem, status, criado_em
        FROM tracking_events
        WHERE origem IN ('ANYMARKET', 'JET', 'ONCLICK')
        ORDER BY origem, pedido_id, criado_em DESC
        LIMIT $1 OFFSET $2
      `;
      const pedidosResult = await pool.query(pedidosQuery, [parseInt(limit, 10), parseInt(offset, 10)]);
      console.log('Pedidos pipeline fetched successfully');
      res.json({
        success: true,
        pedidos: pedidosResult.rows,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages
      });
    } catch (error) {
      console.error('Error in getPedidosPipeline:', error);
      res.status(500).json({ success: false, error: 'Erro ao obter pipeline de pedidos.' });
    }
  },

  async getPedidoDetalhes(req, res) {
    try {
      const { numeroMarketplace } = req.params;
      // Get order mapping
      const mapeamentoQuery = `
        SELECT * FROM pedidos_mapeamento WHERE numero_marketplace = $1
      `;
      const mapeamentoResult = await pool.query(mapeamentoQuery, [numeroMarketplace]);
      const mapeamento = mapeamentoResult.rows[0] || null;
      // Get tracking events
      const eventsQuery = `
        SELECT * FROM tracking_events WHERE pedido_id = $1 ORDER BY criado_em ASC
      `;
      const eventsResult = await pool.query(eventsQuery, [numeroMarketplace]);
      const events = eventsResult.rows;
      console.log('Pedido detalhes fetched successfully');
      res.json({ success: true, mapeamento, events });
    } catch (error) {
      console.error('Error in getPedidoDetalhes:', error);
      res.status(500).json({ success: false, error: 'Erro ao obter detalhes do pedido.' });
    }
  },

  async getGraficoStatusPorPlataforma(req, res) {
    try {
      const query = `
        SELECT origem, status, COUNT(DISTINCT pedido_id) AS total
        FROM tracking_events
        WHERE origem IN ('ANYMARKET', 'JET', 'ONCLICK')
        GROUP BY origem, status
        ORDER BY origem, status
      `;
      const result = await pool.query(query);
      const grouped = { ANYMARKET: [], JET: [], ONCLICK: [] };
      result.rows.forEach(row => {
        grouped[row.origem].push({ status: row.status, total: parseInt(row.total, 10) });
      });
      console.log('Grafico status por plataforma fetched successfully');
      res.json({ success: true, ...grouped });
    } catch (error) {
      console.error('Error in getGraficoStatusPorPlataforma:', error);
      res.status(500).json({ success: false, error: 'Erro ao obter gráfico de status.' });
    }
  }
};

module.exports = DashboardController;