// controllers/dashboardController.js

const pool = require('../config/database');

const dashboardController = {
  // 📊 MÉTRICAS GERAIS
  async getMetricasGerais(req, res) {
    try {
      console.log('📊 Buscando métricas gerais...');

      // Total por plataforma
      const totalPorPlataforma = await pool.query(`
        SELECT 
          origem,
          COUNT(DISTINCT pedido_id) as total,
          COUNT(CASE WHEN status = 'PAGO' THEN 1 END) as pago,
          COUNT(CASE WHEN status = 'ENVIADO' THEN 1 END) as enviado,
          COUNT(CASE WHEN status = 'FATURADO' THEN 1 END) as faturado
        FROM tracking_events
        WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY origem
        ORDER BY total DESC
      `);

      // Total de anomalias
      const anomalias = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN resolvido = false THEN 1 END) as nao_resolvidas
        FROM anomalias
      `);

      // Taxa de sincronização
      const sincronizacao = await pool.query(`
        SELECT 
          COUNT(DISTINCT pedido_id) as total_pedidos,
          COUNT(DISTINCT CASE WHEN origem = 'ANYMARKET' THEN pedido_id END) as em_anymarket,
          COUNT(DISTINCT CASE WHEN origem = 'JET' THEN pedido_id END) as em_jet,
          COUNT(DISTINCT CASE WHEN origem = 'ONCLICK' THEN pedido_id END) as em_onclick,
          ROUND(
            (COUNT(DISTINCT CASE WHEN origem = 'JET' THEN pedido_id END)::NUMERIC / 
             COUNT(DISTINCT pedido_id) * 100)::NUMERIC, 2
          ) as taxa_sincronizacao_jet
        FROM tracking_events
        WHERE timestamp > NOW() - INTERVAL '7 days'
      `);

      // Pedidos últimas 24h
      const ultimas24h = await pool.query(`
        SELECT 
          COUNT(DISTINCT pedido_id) as total,
          origem
        FROM tracking_events
        WHERE timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY origem
      `);

      res.json({
        totalPorPlataforma: totalPorPlataforma.rows,
        anomalias: anomalias.rows[0],
        sincronizacao: sincronizacao.rows[0],
        ultimas24h: ultimas24h.rows
      });

    } catch (error) {
      console.error('❌ Erro ao buscar métricas:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  // 🚨 ANOMALIAS
  async getAnomalias(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const resolvido = req.query.resolvido === 'false' ? false : null;

      console.log(`🚨 Buscando anomalias (limit: ${limit})...`);

      let query = `
        SELECT 
          id,
          pedido_id,
          tipo_anomalia,
          descricao_anomalia,
          origem,
          criado_em,
          resolvido,
          resolvido_em
        FROM anomalias
      `;

      const params = [];

      if (resolvido !== null) {
        query += ` WHERE resolvido = $1`;
        params.push(resolvido);
      }

      query += ` ORDER BY criado_em DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);

      res.json({
        total: result.rows.length,
        anomalias: result.rows
      });

    } catch (error) {
      console.error('❌ Erro ao buscar anomalias:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  // 📋 PEDIDOS COM PIPELINE
  async getPedidosPipeline(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;
      const anomaliaOnly = req.query.anomalia === 'true';

      console.log(`📋 Buscando pedidos (page: ${page}, limit: ${limit})...`);

      let whereClause = '';
      if (anomaliaOnly) {
        whereClause = 'WHERE anomalia = true';
      }

      const result = await pool.query(`
        SELECT 
          pedido_id,
          status_marketplace,
          status_anymarket,
          status_jet,
          status_onclick,
          anomalia,
          tipo_anomalia,
          descricao_anomalia,
          marketplace_origem,
          valor_total,
          cliente_nome,
          atualizado_em
        FROM pedidos_pipeline
        ${whereClause}
        ORDER BY atualizado_em DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await pool.query(`
        SELECT COUNT(*) as total FROM pedidos_pipeline ${whereClause}
      `);

      res.json({
        page,
        limit,
        total: parseInt(countResult.rows[0].total),
        pedidos: result.rows
      });

    } catch (error) {
      console.error('❌ Erro ao buscar pedidos:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  // 🔍 DETALHES DO PEDIDO
  async getPedidoDetalhes(req, res) {
    try {
      const { numeroMarketplace } = req.params;

      console.log(`🔍 Buscando detalhes do pedido: ${numeroMarketplace}`);

      // Buscar pipeline
      const pipeline = await pool.query(`
        SELECT * FROM pedidos_pipeline WHERE pedido_id = $1
      `, [numeroMarketplace]);

      // Buscar eventos
      const eventos = await pool.query(`
        SELECT 
          origem,
          status,
          timestamp,
          dados_completos
        FROM tracking_events
        WHERE pedido_id = $1
        ORDER BY timestamp DESC
      `, [numeroMarketplace]);

      // Buscar mapeamento
      const mapeamento = await pool.query(`
        SELECT * FROM pedidos_mapeamento WHERE numero_marketplace = $1
      `, [numeroMarketplace]);

      res.json({
        pipeline: pipeline.rows[0],
        eventos: eventos.rows,
        mapeamento: mapeamento.rows[0]
      });

    } catch (error) {
      console.error('❌ Erro ao buscar detalhes:', error.message);
      res.status(500).json({ error: error.message });
    }
  },

  // 📈 GRÁFICO STATUS POR PLATAFORMA
  async getGraficoStatusPorPlataforma(req, res) {
    try {
      console.log('📈 Buscando dados para gráfico...');

      const result = await pool.query(`
        SELECT 
          origem,
          status,
          COUNT(DISTINCT pedido_id) as total
        FROM tracking_events
        WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY origem, status
        ORDER BY origem, total DESC
      `);

      // Transformar em formato para gráfico
      const grafico = {};
      result.rows.forEach(row => {
        if (!grafico[row.origem]) {
          grafico[row.origem] = [];
        }
        grafico[row.origem].push({
          status: row.status,
          total: row.total
        });
      });

      res.json(grafico);

    } catch (error) {
      console.error('❌ Erro ao buscar gráfico:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
};

module.exports = dashboardController;