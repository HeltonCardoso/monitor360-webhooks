// controllers/dashboardController.js
const pool = require('../config/database');
const { PIPELINE_STAGES, PIPELINE_STAGES_RETORNO, SLA_ENTRE_ESTAGIOS } = require('../config/constants');

const DESCRICAO_ANOMALIA = {
  NAO_INTEGROU_JET:     'Pedido não chegou na JET dentro do prazo',
  NAO_FATUROU_ONCLICK:  'JET integrou mas Onclick não faturou',
  FATUROU_NAO_RETORNOU: 'Onclick faturou mas JET não confirmou envio',
  FATURADO_APOS_ENVIO:  'AnyMarket ficou como Faturado após envio (não é ME2)',
  ENVIADO_SEM_FATURAMENTO: 'JET enviou sem confirmação de faturamento na Onclick',
  TRAVADO:              'Pedido sem atualização por mais de 4 horas'
};

const DashboardController = {

  async getMetricasGerais(req, res) {
    try {
      // Contagem por origem
      const origemResult = await pool.query(`
        SELECT origem, COUNT(DISTINCT pedido_id) AS total
        FROM tracking_events
        WHERE origem IN ('ANYMARKET','JET','ONCLICK','RETORNO_JET','RETORNO_ANYMARKET')
        GROUP BY origem
      `);
      const metricas = { ANYMARKET: 0, JET: 0, ONCLICK: 0, RETORNO_JET: 0, RETORNO_ANYMARKET: 0 };
      origemResult.rows.forEach(r => { metricas[r.origem] = parseInt(r.total); });

      // Anomalias não resolvidas
      const anomaliasResult = await pool.query(
        `SELECT COUNT(*) AS total FROM anomalias WHERE resolvida = false`
      );
      const anomaliasNaoResolvidas = parseInt(anomaliasResult.rows[0].total);

      // Pedidos por estágio do pipeline (onde estão AGORA)
      const pipelineResult = await pool.query(`
        WITH ultimo_estagio AS (
          SELECT DISTINCT ON (pedido_id)
            pedido_id,
            origem,
            status,
            timestamp
          FROM tracking_events
          ORDER BY pedido_id, timestamp DESC
        )
        SELECT origem as estagio, COUNT(*) as total
        FROM ultimo_estagio
        GROUP BY origem
        ORDER BY total DESC
      `);
      const porEstagio = {};
      pipelineResult.rows.forEach(r => { porEstagio[r.estagio] = parseInt(r.total); });

      // Pedidos travados (sem update há mais de 1h e pipeline incompleto)
      const travadosResult = await pool.query(`
        WITH ultimo_evento AS (
          SELECT DISTINCT ON (pedido_id)
            pedido_id, origem, timestamp
          FROM tracking_events
          ORDER BY pedido_id, timestamp DESC
        ),
        pedidos_completos AS (
          SELECT pedido_id FROM tracking_events
          WHERE origem = 'RETORNO_ANYMARKET'
        )
        SELECT COUNT(*) as total
        FROM ultimo_evento u
        WHERE u.timestamp < NOW() - INTERVAL '1 hour'
          AND u.pedido_id NOT IN (SELECT pedido_id FROM pedidos_completos)
          AND u.origem NOT IN ('RETORNO_ANYMARKET','RETORNO_MARKETPLACE')
      `);
      const pedidosTravados = parseInt(travadosResult.rows[0].total);

      // Volume últimas 24h por marketplace
      const marketplaceResult = await pool.query(`
        SELECT 
          pm.marketplace_origem as marketplace,
          COUNT(DISTINCT te.pedido_id) as total
        FROM tracking_events te
        JOIN pedidos_mapeamento pm ON te.pedido_id = pm.numero_marketplace
        WHERE te.criado_em >= NOW() - INTERVAL '24 hours'
          AND te.origem = 'ANYMARKET'
          AND pm.marketplace_origem IS NOT NULL
        GROUP BY pm.marketplace_origem
        ORDER BY total DESC
      `);

      // Taxa de sincronização JET
      const taxaSync = metricas.ANYMARKET > 0
        ? ((metricas.JET / metricas.ANYMARKET) * 100).toFixed(1)
        : 0;

      // Pedidos últimas 24h
      const pedidos24hResult = await pool.query(`
        SELECT COUNT(DISTINCT pedido_id) as total
        FROM tracking_events
        WHERE criado_em >= NOW() - INTERVAL '24 hours'
          AND origem = 'ANYMARKET'
      `);

      res.json({
        success: true,
        data: {
          metricas,
          anomaliasNaoResolvidas,
          pedidosTravados,
          porEstagio,
          taxaSincronizacaoJet: parseFloat(taxaSync),
          pedidos24h: parseInt(pedidos24hResult.rows[0].total),
          porMarketplace: marketplaceResult.rows
        }
      });
    } catch (error) {
      console.error('Erro getMetricasGerais:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async getAnomalias(req, res) {
    try {
      const { limit = 20, resolvida } = req.query;
      const params = [];
      let where = 'WHERE 1=1';
      if (resolvida !== undefined) {
        params.push(resolvida === 'true');
        where += ` AND resolvida = $${params.length}`;
      }
      params.push(parseInt(limit));
      const result = await pool.query(`
        SELECT id, pedido_id, tipo, origem_falha, marketplace, criado_em, resolvida
        FROM anomalias
        ${where}
        ORDER BY criado_em DESC
        LIMIT $${params.length}
      `, params);

      const anomalias = result.rows.map(a => ({
        ...a,
        descricao: DESCRICAO_ANOMALIA[a.tipo] || a.tipo
      }));

      res.json({ success: true, anomalias });
    } catch (error) {
      console.error('Erro getAnomalias:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async getPedidosPipeline(req, res) {
    try {
      const { page = 1, limit = 20, marketplace, travados } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      // Monta pipeline por pedido
      let baseWhere = `WHERE te.origem IN ('ANYMARKET','JET','ONCLICK','RETORNO_JET','RETORNO_ANYMARKET')`;
      const params = [];

      if (marketplace) {
        params.push(marketplace);
        baseWhere += ` AND pm.marketplace_origem = $${params.length}`;
      }

      const pedidosQuery = `
        WITH eventos_pedido AS (
          SELECT 
            te.pedido_id,
            ARRAY_AGG(DISTINCT te.origem) as origens,
            MAX(te.timestamp) as ultimo_evento,
            MIN(te.timestamp) as primeiro_evento,
            pm.marketplace_origem as marketplace
          FROM tracking_events te
          LEFT JOIN pedidos_mapeamento pm ON te.pedido_id = pm.numero_marketplace
          ${baseWhere}
          GROUP BY te.pedido_id, pm.marketplace_origem
        )
        SELECT 
          pedido_id,
          origens,
          ultimo_evento,
          primeiro_evento,
          marketplace,
          EXTRACT(EPOCH FROM (NOW() - ultimo_evento))/3600 as horas_sem_update
        FROM eventos_pedido
        ${travados === 'true' ? `WHERE EXTRACT(EPOCH FROM (NOW() - ultimo_evento))/3600 > 1 AND NOT ('RETORNO_ANYMARKET' = ANY(origens))` : ''}
        ORDER BY ultimo_evento DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(parseInt(limit), offset);

      const countQuery = `
        SELECT COUNT(DISTINCT te.pedido_id) as total
        FROM tracking_events te
        LEFT JOIN pedidos_mapeamento pm ON te.pedido_id = pm.numero_marketplace
        ${baseWhere}
      `;

      const [pedidosResult, countResult] = await Promise.all([
        pool.query(pedidosQuery, params),
        pool.query(countQuery, params.slice(0, -2))
      ]);

      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        pedidos: pedidosResult.rows,
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      });
    } catch (error) {
      console.error('Erro getPedidosPipeline:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async getPedidoDetalhes(req, res) {
    try {
      const { numeroMarketplace } = req.params;
      const [mapeamento, events, anomalias] = await Promise.all([
        pool.query(`SELECT * FROM pedidos_mapeamento WHERE numero_marketplace = $1`, [numeroMarketplace]),
        pool.query(`SELECT * FROM tracking_events WHERE pedido_id = $1 ORDER BY timestamp ASC`, [numeroMarketplace]),
        pool.query(`SELECT * FROM anomalias WHERE pedido_id = $1 ORDER BY criado_em DESC`, [numeroMarketplace])
      ]);

      const anomaliasComDescricao = anomalias.rows.map(a => ({
        ...a,
        descricao: DESCRICAO_ANOMALIA[a.tipo] || a.tipo
      }));

      res.json({
        success: true,
        mapeamento: mapeamento.rows[0] || null,
        events: events.rows,
        anomalias: anomaliasComDescricao
      });
    } catch (error) {
      console.error('Erro getPedidoDetalhes:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async getGraficoStatusPorPlataforma(req, res) {
    try {
      const [statusResult, marketplaceResult, volumeResult] = await Promise.all([
        pool.query(`
          SELECT origem, status, COUNT(DISTINCT pedido_id) AS total
          FROM tracking_events
          WHERE origem IN ('ANYMARKET','JET','ONCLICK')
          GROUP BY origem, status ORDER BY origem, total DESC
        `),
        pool.query(`
          SELECT pm.marketplace_origem as marketplace, COUNT(DISTINCT pm.numero_marketplace) as total
          FROM pedidos_mapeamento pm
          WHERE pm.marketplace_origem IS NOT NULL
          GROUP BY pm.marketplace_origem ORDER BY total DESC
        `),
        pool.query(`
          SELECT 
            DATE_TRUNC('hour', timestamp) as hora,
            COUNT(DISTINCT pedido_id) as total
          FROM tracking_events
          WHERE origem = 'ANYMARKET'
            AND timestamp >= NOW() - INTERVAL '24 hours'
          GROUP BY hora ORDER BY hora ASC
        `)
      ]);

      const grouped = { ANYMARKET: [], JET: [], ONCLICK: [] };
      statusResult.rows.forEach(r => {
        if (grouped[r.origem]) grouped[r.origem].push({ status: r.status, total: parseInt(r.total) });
      });

      res.json({
        success: true,
        porStatus: grouped,
        porMarketplace: marketplaceResult.rows,
        volumeHoras: volumeResult.rows
      });
    } catch (error) {
      console.error('Erro getGraficoStatusPorPlataforma:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  async resolverAnomalia(req, res) {
    try {
      const { id } = req.params;
      await pool.query(
        `UPDATE anomalias SET resolvida = true, resolvida_em = NOW() WHERE id = $1`,
        [id]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Erro resolverAnomalia:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
};

module.exports = DashboardController;