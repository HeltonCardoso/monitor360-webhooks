const pool = require('../config/database');
const notification = require('./notification');
const { SLA_CONFIG, PIPELINE_STAGES } = require('../config/constants');


const createAnomaly = async (pedido_id, tipo, origem_falha, marketplace) => {
  try {
    await pool.query(
      `INSERT INTO anomalias (pedido_id, tipo, origem_falha, marketplace, criado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (pedido_id, tipo) DO NOTHING`,
      [pedido_id, tipo, origem_falha, marketplace]
    );

    // Enviar notificação
    const mensagem = `
      🚨 ANOMALIA DETECTADA
      Pedido: ${pedido_id}
      Tipo: ${tipo}
      Origem: ${origem_falha}
      Marketplace: ${marketplace || 'N/A'}
    `;

    await notification.sendAlert(mensagem, 'CRITICAL');
  } catch (error) {
    console.error('Erro ao criar anomalia:', error);
  }
};

const checkPipelineStatus = async (pedido_id) => {
  try {
    const events = await pool.query(
      `SELECT origem, MAX(timestamp) as ultimo_evento
       FROM tracking_events
       WHERE pedido_id = $1
       GROUP BY origem
       ORDER BY ultimo_evento DESC`,
      [pedido_id]
    );

    const origens = events.rows.map(r => r.origem);
    const ultimoEvento = events.rows[0]?.ultimo_evento;

    // Verificar se está travado
    const horasParado = (Date.now() - new Date(ultimoEvento)) / (1000 * 60 * 60);
    if (horasParado > 4) {
      await createAnomaly(
        pedido_id,
        'TRAVADO',
        origens[0],
        null
      );
    }

    // Verificar sequência esperada
    const esperado = PIPELINE_STAGES;
    const faltando = esperado.filter(s => !origens.includes(s));

    if (faltando.length > 0) {
      console.log(`Pedido ${pedido_id} faltando estágios: ${faltando.join(', ')}`);
    }
  } catch (error) {
    console.error('Erro ao verificar pipeline:', error);
  }
};

module.exports = {
  createAnomaly,
  checkPipelineStatus
};