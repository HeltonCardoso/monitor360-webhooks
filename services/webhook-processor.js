const pool = require('../config/database');
const anomalyDetector = require('./anomaly-detector');
const notification = require('./notification');
const { STATUS_MAP } = require('../config/constants');


const processAnyMarketEvent = async (pedido_id, status, marketplace) => {
  // Normalizar status
  const normalizedStatus = STATUS_MAP.ANYMARKET[status] || status;

  // Verificar se pedido existe em JET
  const jetCheck = await pool.query(
    'SELECT id FROM tracking_events WHERE pedido_id = $1 AND origem = $2 LIMIT 1',
    [pedido_id, 'JET']
  );

  if (!jetCheck.rows.length) {
    // Alerta: pedido em AnyMarket mas não em JET
    await anomalyDetector.createAnomaly(
      pedido_id,
      'NAO_INTEGROU_JET',
      'ANYMARKET',
      marketplace
    );
  }

  // Detectar outros padrões de falha
  await anomalyDetector.checkPipelineStatus(pedido_id);
};

const processJETEvent = async (pedido_id, status) => {
  const normalizedStatus = STATUS_MAP.JET[status] || status;

  // Verificar se pedido foi faturado em Onlick
  if (normalizedStatus === 'ENVIADO') {
    const onlickCheck = await pool.query(
      `SELECT id FROM tracking_events 
       WHERE pedido_id = $1 AND origem = $2 AND status = $3`,
      [pedido_id, 'ONLICK', 'FATURADO']
    );

    if (!onlickCheck.rows.length) {
      await anomalyDetector.createAnomaly(
        pedido_id,
        'FATUROU_NAO_RETORNOU',
        'JET',
        null
      );
    }
  }

  await anomalyDetector.checkPipelineStatus(pedido_id);
};

const processOnlickEvent = async (pedido_id, status, invoiceNumber) => {
  const normalizedStatus = STATUS_MAP.ONLICK[status] || status;

  if (normalizedStatus === 'FATURADO') {
    // Registrar faturamento
    await pool.query(
      `UPDATE tracking_events 
       SET payload = jsonb_set(payload, '{invoice_number}', $1)
       WHERE pedido_id = $2 AND origem = $3`,
      [JSON.stringify(invoiceNumber), pedido_id, 'ONLICK']
    );

    // Verificar se retornou para JET em até 2 horas
    setTimeout(async () => {
      const jetReturn = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = $2 
         AND timestamp > NOW() - INTERVAL '2 hours'`,
        [pedido_id, 'JET']
      );

      if (!jetReturn.rows.length) {
        await anomalyDetector.createAnomaly(
          pedido_id,
          'FATUROU_NAO_RETORNOU',
          'ONLICK',
          null
        );
        await notification.sendAlert(
          `Pedido ${pedido_id} faturado mas não retornou a JET`,
          'CRITICAL'
        );
      }
    }, 2 * 60 * 60 * 1000); // 2 horas
  }

  await anomalyDetector.checkPipelineStatus(pedido_id);
};

module.exports = {
  processAnyMarketEvent,
  processJETEvent,
  processOnlickEvent
};