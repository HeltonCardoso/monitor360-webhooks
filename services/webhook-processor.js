const pool = require('../config/database');
const anomalyDetector = require('./anomaly-detector');
const notification = require('./notification');
const jetApi = require('./jet-api');
const anymarketApi = require('./anymarket-api');
const onclickApi = require('./onclick-api');
const { STATUS_MAP } = require('../config/constants');
const { v4: uuidv4 } = require('uuid');

const processAnyMarketEvent = async (payload) => {
  try {
    const { content, event } = payload;
    const pedido_id = content.id;
    
    console.log(`🔄 Processando AnyMarket: ${pedido_id} - ${event}`);

    const dadosCompletos = await anymarketApi.buscarDetalhesPedido(pedido_id);
    const infoRelevante = anymarketApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido AnyMarket ${pedido_id}`);
      return;
    }

    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;
    
    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = EXCLUDED.status,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload,
         dados_completos = EXCLUDED.dados_completos`,
      [
        uuidv4(),
        pedido_id,
        'ANYMARKET',
        normalizedStatus,
        new Date(),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ AnyMarket ${pedido_id} armazenado`);

    const jetCheck = await pool.query(
      'SELECT id FROM tracking_events WHERE pedido_id = $1 AND origem = $2 LIMIT 1',
      [pedido_id, 'JET']
    );

    if (!jetCheck.rows.length) {
      await anomalyDetector.createAnomaly(
        pedido_id,
        'NAO_INTEGROU_JET',
        'ANYMARKET',
        infoRelevante.marketplace
      );
    }

    await anomalyDetector.checkPipelineStatus(pedido_id);
  } catch (error) {
    console.error('❌ Erro ao processar AnyMarket:', error.message);
  }
};

const processJETEvent = async (payload) => {
  try {
    const { Id: pedido_id, Event, EventOccurredAt } = payload;
    
    console.log(`🔄 Processando JET: ${pedido_id} - ${Event}`);

    const dadosCompletos = await jetApi.buscarDetalhesPedido(pedido_id);
    const infoRelevante = jetApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido JET ${pedido_id}`);
      return;
    }

    const normalizedStatus = STATUS_MAP.JET[Event] || Event;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = EXCLUDED.status,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload,
         dados_completos = EXCLUDED.dados_completos`,
      [
        uuidv4(),
        pedido_id,
        'JET',
        normalizedStatus,
        new Date(EventOccurredAt),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ JET ${pedido_id} armazenado`);

    if (normalizedStatus === 'ENVIADO') {
      const onclickCheck = await pool.query(
        `SELECT id FROM tracking_events WHERE pedido_id = $1 AND origem = $2 AND status = $3`,
        [pedido_id, 'ONCLICK', 'FATURADO']
      );

      if (!onclickCheck.rows.length) {
        await anomalyDetector.createAnomaly(
          pedido_id,
          'FATUROU_NAO_RETORNOU',
          'JET',
          null
        );
      }
    }

    await anomalyDetector.checkPipelineStatus(pedido_id);
  } catch (error) {
    console.error('❌ Erro ao processar JET:', error.message);
  }
};

const processOnclickEvent = async (payload) => {
  try {
    const { pedido_id, status, invoice_number } = payload;
    
    console.log(`🔄 Processando Onclick: ${pedido_id} - ${status}`);

    const infoRelevante = onclickApi.extrairInfoRelevante(payload);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido Onclick ${pedido_id}`);
      return;
    }

    const normalizedStatus = STATUS_MAP.ONCLICK[status] || status;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = EXCLUDED.status,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload,
         dados_completos = EXCLUDED.dados_completos`,
      [
        uuidv4(),
        pedido_id,
        'ONCLICK',
        normalizedStatus,
        new Date(),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ Onclick ${pedido_id} armazenado`);

    if (normalizedStatus === 'FATURADO') {
      setTimeout(async () => {
        const jetReturn = await pool.query(
          `SELECT id FROM tracking_events WHERE pedido_id = $1 AND origem = $2 AND timestamp > NOW() - INTERVAL '2 hours'`,
          [pedido_id, 'JET']
        );

        if (!jetReturn.rows.length) {
          await anomalyDetector.createAnomaly(
            pedido_id,
            'FATUROU_NAO_RETORNOU',
            'ONCLICK',
            null
          );
          await notification.sendAlert(
            `Pedido ${pedido_id} faturado mas não retornou a JET`,
            'CRITICAL'
          );
        }
      }, 2 * 60 * 60 * 1000);
    }

    await anomalyDetector.checkPipelineStatus(pedido_id);
  } catch (error) {
    console.error('❌ Erro ao processar Onclick:', error.message);
  }
};

module.exports = {
  processAnyMarketEvent,
  processJETEvent,
  processOnclickEvent
};