const pool = require('../config/database');
const anomalyDetector = require('./anomaly-detector');
const notification = require('./notification');
const jetApi = require('./jet-api');
const anymarketApi = require('./anymarket-api');
const onlickApi = require('./onlick-api');
const { STATUS_MAP } = require('../config/constants');
const { v4: uuidv4 } = require('uuid');

const processAnyMarketEvent = async (payload) => {
  try {
    const { content, event } = payload;
    const pedido_id = content.id;
    
    console.log(`🔄 Processando AnyMarket: ${pedido_id} - ${event}`);

    // 1. Consultar API AnyMarket para dados completos
    const dadosCompletos = await anymarketApi.buscarDetalhesPedido(pedido_id);
    const infoRelevante = anymarketApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido AnyMarket ${pedido_id}`);
      return;
    }

    // 2. Armazenar em BD
    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;
    
    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = $4,
         timestamp = $5,
         payload = $6,
         dados_completos = $7`,
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

    // 3. Sua lógica de anomalias
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

    // 1. Consultar API JET
    const dadosCompletos = await jetApi.buscarDetalhesPedido(pedido_id);
    const infoRelevante = jetApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido JET ${pedido_id}`);
      return;
    }

    // 2. Armazenar em BD
    const normalizedStatus = STATUS_MAP.JET[Event] || Event;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = $4,
         timestamp = $5,
         payload = $6,
         dados_completos = $7`,
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

    // 3. Sua lógica de anomalias
    if (normalizedStatus === 'ENVIADO') {
      const onlickCheck = await pool.query(
        `SELECT id FROM tracking_events WHERE pedido_id = $1 AND origem = $2 AND status = $3`,
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
  } catch (error) {
    console.error('❌ Erro ao processar JET:', error.message);
  }
};

const processOnlickEvent = async (payload) => {
  try {
    const { pedido_id, status, invoice_number } = payload;
    
    console.log(`🔄 Processando Onlick: ${pedido_id} - ${status}`);

    // 1. Extrair info (sem API)
    const infoRelevante = onlickApi.extrairInfoRelevante(payload);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido Onlick ${pedido_id}`);
      return;
    }

    // 2. Armazenar em BD
    const normalizedStatus = STATUS_MAP.ONLICK[status] || status;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = $4,
         timestamp = $5,
         payload = $6,
         dados_completos = $7`,
      [
        uuidv4(),
        pedido_id,
        'ONLICK',
        normalizedStatus,
        new Date(),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ Onlick ${pedido_id} armazenado`);

    // 3. Sua lógica de anomalias
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
            'ONLICK',
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
    console.error('❌ Erro ao processar Onlick:', error.message);
  }
};

module.exports = {
  processAnyMarketEvent,
  processJETEvent,
  processOnlickEvent
};