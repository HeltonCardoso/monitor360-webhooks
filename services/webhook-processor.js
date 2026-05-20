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
    const idAnyMarket = content?.id;

    console.log(`📥 WEBHOOK ANYMARKET RECEBIDO!`);
    console.log(`🔄 Processando AnyMarket ID: ${idAnyMarket} - Evento: ${event}`);

    if (!idAnyMarket) {
      console.error(`❌ Webhook AnyMarket sem content.id. Payload completo:`, JSON.stringify(payload, null, 2));
      return;
    }

    // 1️⃣ BUSCAR DADOS COMPLETOS NA API (webhook só entrega o ID)
    const dadosCompletos = await anymarketApi.buscarDetalhesPedido(idAnyMarket);
    const infoRelevante = anymarketApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido AnyMarket ${idAnyMarket}`);
      return;
    }

    // 2️⃣ numero_marketplace VEM DA API, não do webhook
    const numeroMarketplace = infoRelevante.numero_marketplace;

    if (!numeroMarketplace) {
      console.error(`❌ numero_marketplace ausente mesmo após busca na API AnyMarket ${idAnyMarket}. Dados recebidos:`, JSON.stringify(infoRelevante, null, 2));
      return;
    }

    console.log(`✅ Marketplace ID obtido da API: ${numeroMarketplace}`);

    // 3️⃣ SALVAR MAPEAMENTO
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_anymarket, numero_marketplace, marketplace_origem)
       VALUES ($1, $2, $3)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_anymarket = $1,
         atualizado_em = NOW()`,
      [idAnyMarket, numeroMarketplace, infoRelevante.marketplace]
    );

    // 4️⃣ NORMALIZAR STATUS
    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;

    // 5️⃣ SALVAR TRACKING
    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
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

    console.log(`✅ AnyMarket ${numeroMarketplace} armazenado com status ${normalizedStatus}`);

    // 6️⃣ VERIFICAR ANOMALIA: pedido não integrou na JET
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

    // 7️⃣ VALIDAR PIPELINE COMPLETO
    await anomalyDetector.checkPipelineStatus(numeroMarketplace);

  } catch (error) {
    console.error('❌ Erro ao processar AnyMarket:', error.message);
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
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
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

    // ─── Inferência da Onclick via status da JET ───────────────────────────
    // Não recebemos webhooks da Onclick diretamente, então usamos os eventos da JET:
    //   Pedido.EmProducao → pedido entrou na Onclick
    //   Pedido.Enviado    → faturou na Onclick e foi enviado

    if (Event === 'Pedido.EmProducao') {
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          infoRelevante.numero_marketplace,
          'ONCLICK',
          'EM_PRODUCAO',
          new Date(EventOccurredAt),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event }),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, pedido_jet: numeroPedido })
        ]
      );
      console.log(`🏭 [ONCLICK] Pedido ${infoRelevante.numero_marketplace} entrou na Onclick (via JET EmProducao)`);
    }

    if (Event === 'Pedido.Enviado') {
      // Grava ONCLICK: faturou e enviou
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          infoRelevante.numero_marketplace,
          'ONCLICK',
          'FATURADO_ENVIADO',
          new Date(EventOccurredAt),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event }),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, pedido_jet: numeroPedido })
        ]
      );
      console.log(`📦 [ONCLICK] Pedido ${infoRelevante.numero_marketplace} faturado e enviado (via JET Enviado)`);

      // Pedido.Enviado também É o retorno da JET confirmando o envio
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          infoRelevante.numero_marketplace,
          'RETORNO_JET',
          'CONFIRMADO',
          new Date(EventOccurredAt),
          JSON.stringify(payload),
          JSON.stringify(infoRelevante)
        ]
      );
      console.log(`↩️  [RETORNO_JET] Pedido ${infoRelevante.numero_marketplace} confirmado como enviado`);
    }

    if (normalizedStatus === 'ENVIADO') {
      const onclickCheck = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = $2 AND status = $3`,
        [infoRelevante.numero_marketplace, 'ONCLICK', 'FATURADO_ENVIADO']
      );

      if (!onclickCheck.rows.length) {
        await anomalyDetector.createAnomaly(
          infoRelevante.numero_marketplace,
          'ENVIADO_SEM_FATURAMENTO',
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
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
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
    const { pedido_id, status } = payload;

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
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
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