// services/webhook-processor.js
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
    const idAnyMarket = content.id;

    // Busca o campo em todos os nomes possíveis que a AnyMarket pode enviar
    const numeroMarketplace =
      content.marketPlaceId   ||
      content.marketplaceId   ||
      content.MarketPlaceId   ||
      content.externalId      ||
      content.orderId         ||
      content.numeroPedido    ||
      null;

    console.log(`📥 WEBHOOK ANYMARKET RECEBIDO!`);
    console.log(`🔍 Campos disponíveis em content:`, Object.keys(content || {}));
    console.log(`🔄 Processando AnyMarket: ${idAnyMarket} - Marketplace: ${numeroMarketplace} - ${event}`);

    // Abortar antes de tentar inserir com null
    if (!numeroMarketplace) {
      console.error(`❌ Campo numero_marketplace ausente. Payload content completo:`, JSON.stringify(content, null, 2));
      throw new Error(`numero_marketplace não encontrado no payload AnyMarket. ID anymarket: ${idAnyMarket}`);
    }

    // Salvar o mapeamento
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_anymarket, numero_marketplace, marketplace_origem)
       VALUES ($1, $2, $3)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_anymarket = $1,
         atualizado_em = NOW()`,
      [idAnyMarket, numeroMarketplace, content.marketPlace || content.marketplace || null]
    );

    // Buscar dados completos
    const dadosCompletos = await anymarketApi.buscarDetalhesPedido(idAnyMarket);
    const infoRelevante = anymarketApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido AnyMarket ${idAnyMarket}`);
      await salvarWebhookAnyMarket(idAnyMarket, numeroMarketplace, event, payload);
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
        numeroMarketplace,
        'ANYMARKET',
        normalizedStatus,
        new Date(),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ AnyMarket ${numeroMarketplace} armazenado`);

    const jetCheck = await pool.query(
      `SELECT id FROM tracking_events 
       WHERE pedido_id = $1 AND origem = $2 LIMIT 1`,
      [numeroMarketplace, 'JET']
    );

    if (!jetCheck.rows.length) {
      await anomalyDetector.createAnomaly(
        numeroMarketplace,
        'NAO_INTEGROU_JET',
        'ANYMARKET',
        infoRelevante.marketplace
      );
    }

    await anomalyDetector.checkPipelineStatus(numeroMarketplace);

  } catch (error) {
    console.error('❌ Erro ao processar AnyMarket:', error.message);
  }
};

const salvarWebhookAnyMarket = async (idAnyMarket, numeroMarketplace, event, payload) => {
  try {
    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = EXCLUDED.status,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload`,
      [
        uuidv4(),
        numeroMarketplace,
        'ANYMARKET',
        normalizedStatus,
        new Date(),
        JSON.stringify(payload),
        JSON.stringify(payload)
      ]
    );

    console.log(`✅ AnyMarket ${numeroMarketplace} armazenado (sem dados da API)`);
  } catch (error) {
    console.error('❌ Erro ao salvar webhook AnyMarket:', error.message);
  }
};

const processJETEvent = async (payload) => {
  try {
    const { Id: idInterno, ModifiedId: numeroPedido, Event, EventOccurredAt } = payload;

    console.log(`📥 WEBHOOK JET RECEBIDO!`);
    console.log(`🔄 Processando JET: ${idInterno} - Pedido: ${numeroPedido} - ${Event}`);

    const dadosCompletos = await jetApi.buscarDetalhesPedido(numeroPedido);
    const infoRelevante = jetApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido JET ${numeroPedido}`);
      await salvarWebhookJET(idInterno, numeroPedido, Event, EventOccurredAt, payload);
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
        infoRelevante.numero_marketplace,
        'JET',
        normalizedStatus,
        new Date(EventOccurredAt),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ JET ${numeroPedido} armazenado`);

    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_jet, numero_marketplace)
       VALUES ($1, $2)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_jet = $1,
         atualizado_em = NOW()`,
      [numeroPedido, infoRelevante.numero_marketplace]
    );

    if (normalizedStatus === 'ENVIADO') {
      const onclickCheck = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = $2 AND status = $3`,
        [infoRelevante.numero_marketplace, 'ONCLICK', 'FATURADO']
      );

      if (!onclickCheck.rows.length) {
        await anomalyDetector.createAnomaly(
          infoRelevante.numero_marketplace,
          'FATUROU_NAO_RETORNOU',
          'JET',
          null
        );
      }
    }

    await anomalyDetector.checkPipelineStatus(infoRelevante.numero_marketplace);

  } catch (error) {
    console.error('❌ Erro ao processar JET:', error.message);
  }
};

const salvarWebhookJET = async (idInterno, numeroPedido, event, eventOccurredAt, payload) => {
  try {
    const normalizedStatus = STATUS_MAP.JET[event] || event;

    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem) DO UPDATE SET
         status = EXCLUDED.status,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload`,
      [
        uuidv4(),
        numeroPedido,
        'JET',
        normalizedStatus,
        new Date(eventOccurredAt),
        JSON.stringify(payload),
        JSON.stringify(payload)
      ]
    );

    console.log(`✅ JET ${numeroPedido} armazenado (sem dados da API)`);
  } catch (error) {
    console.error('❌ Erro ao salvar webhook JET:', error.message);
  }
};

const processOnclickEvent = async (payload) => {
  try {
    const { pedido_id, status, invoice_number } = payload;

    console.log(`📥 WEBHOOK ONCLICK RECEBIDO!`);
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
          `SELECT id FROM tracking_events 
           WHERE pedido_id = $1 AND origem = $2 AND timestamp > NOW() - INTERVAL '2 hours'`,
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