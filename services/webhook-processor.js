// services/webhook-processor.js
const pool = require('../config/database');
const anomalyDetector = require('./anomaly-detector');
const notification = require('./notification');
const jetApi = require('./jet-api');
const anymarketApi = require('./anymarket-api');
const onclickApi = require('./onclick-api');
const { STATUS_MAP, SLA_ENTRE_ESTAGIOS } = require('../config/constants');
const { v4: uuidv4 } = require('uuid');

// Cache de deduplicação — evita processar o mesmo webhook duas vezes
const recentlyProcessed = new Map();
const isDuplicate = (key) => {
  const last = recentlyProcessed.get(key);
  if (last && Date.now() - last < 30000) return true; // 30 segundos
  recentlyProcessed.set(key, Date.now());
  return false;
};

// Verifica se o pedido é do tipo ME2 (Mercado Livre coleta normal)
const isMe2 = (infoRelevante) => {
  const produtos = infoRelevante?.produtos || [];
  return produtos.some(item =>
    (item.shippingtype || '').toLowerCase().includes('me2')
  );
};

const processAnyMarketEvent = async (payload) => {
  try {
    const { content, event } = payload;
    const idAnyMarket = content?.id;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📥 WEBHOOK ANYMARKET RECEBIDO!`);
    console.log(`   Evento: ${event}`);
    console.log(`   ID AnyMarket: ${idAnyMarket}`);

    // Ignora duplicatas
    const dedupKey = `anymarket-${idAnyMarket}-${event}`;
    if (isDuplicate(dedupKey)) {
      console.log(`⏭️ Ignorando duplicata AnyMarket: ${idAnyMarket} - ${event}`);
      return;
    }

    if (!idAnyMarket) {
      console.error(`❌ Webhook AnyMarket sem content.id`);
      return;
    }

    // 1️⃣ BUSCAR DADOS COMPLETOS NA API
    const dadosCompletos = await anymarketApi.buscarDetalhesPedido(idAnyMarket);
    const infoRelevante = anymarketApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido AnyMarket ${idAnyMarket}`);
      return;
    }

    const numeroMarketplace = infoRelevante.numero_marketplace;

    if (!numeroMarketplace) {
      console.error(`❌ numero_marketplace ausente mesmo após busca na API`);
      return;
    }

    console.log(`✅ Marketplace ID obtido: ${numeroMarketplace}`);
    console.log(`🏪 Marketplace: ${infoRelevante.marketplace}`);
    console.log(`📊 Status: ${event} → ${STATUS_MAP.ANYMARKET[event] || event}`);

    // 2️⃣ SALVAR MAPEAMENTO
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_anymarket, numero_marketplace, marketplace_origem)
       VALUES ($1, $2, $3)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_anymarket = $1,
         marketplace_origem = $3,
         atualizado_em = NOW()`,
      [idAnyMarket, numeroMarketplace, infoRelevante.marketplace]
    );

    // 3️⃣ NORMALIZAR STATUS
    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;

    // 4️⃣ SALVAR TRACKING
    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
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

    console.log(`✅ ANYMARKET ${numeroMarketplace} salvo com status ${normalizedStatus}`);

    // 5️⃣ PAID_WAITING_DELIVERY = AnyMarket confirmou envio → RETORNO_ANYMARKET
    if (event === 'PAID_WAITING_DELIVERY') {
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          numeroMarketplace,
          'RETORNO_ANYMARKET',
          'ENVIADO',
          new Date(),
          JSON.stringify(payload),
          JSON.stringify(infoRelevante)
        ]
      );
      console.log(`↩️ [RETORNO_ANYMARKET] Pedido ${numeroMarketplace} confirmado como enviado`);
    }

    // 6️⃣ VERIFICAR ANOMALIA: FATURADO_APOS_ENVIO (exceto ME2)
    if (event === 'INVOICED') {
      const jetEnviado = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = 'JET' AND status = 'ENVIADO' LIMIT 1`,
        [numeroMarketplace]
      );

      if (jetEnviado.rows.length) {
        const pedidoIsMe2 = isMe2(infoRelevante);
        if (!pedidoIsMe2) {
          console.warn(`⚠️ Pedido ${numeroMarketplace} ficou FATURADO após JET enviar (não é ME2)`);
          await anomalyDetector.createAnomaly(
            numeroMarketplace,
            'FATURADO_APOS_ENVIO',
            'ANYMARKET',
            infoRelevante.marketplace,
            { detalhes: 'AnyMarket ficou como Faturado após JET já ter confirmado envio' }
          );
        } else {
          console.log(`ℹ️ Pedido ${numeroMarketplace} ME2 - aguardando bipagem da etiqueta`);
        }
      }
    }

    // 7️⃣ VERIFICAR PIPELINE (NÃO CRIA ANOMALIA IMEDIATAMENTE)
    // A criação de anomalia será feita pelo checkPipelineStatus() baseado no SLA
    console.log(`📊 Verificando pipeline...`);
    await anomalyDetector.checkPipelineStatus(numeroMarketplace);

  } catch (error) {
    console.error('❌ Erro ao processar AnyMarket:', error.message);
  }
};

const processJETEvent = async (payload) => {
  try {
    const { Id: idInterno, ModifiedId: numeroPedido, Event, EventOccurredAt } = payload;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📥 WEBHOOK JET RECEBIDO!`);
    console.log(`   Evento: ${Event}`);
    console.log(`   ID Interno: ${idInterno}`);
    console.log(`   Número Pedido: ${numeroPedido}`);

    // Ignora duplicatas
    const dedupKeyJet = `jet-${idInterno}-${Event}`;
    if (isDuplicate(dedupKeyJet)) {
      console.log(`⏭️ Ignorando duplicata JET: ${idInterno} - ${Event}`);
      return;
    }

    // Busca dados completos do pedido na API da JET
    const dadosCompletos = await jetApi.buscarDetalhesPedido(numeroPedido);
    const infoRelevante = jetApi.extrairInfoRelevante(dadosCompletos);

    if (!infoRelevante) {
      console.warn(`⚠️ Não conseguiu extrair info do pedido JET ${numeroPedido}`);
      await salvarWebhookJET(idInterno, numeroPedido, Event, EventOccurredAt, payload);
      return;
    }

    const numeroMarketplace = infoRelevante.numero_marketplace;
    const normalizedStatus = STATUS_MAP.JET[Event] || Event;

    console.log(`✅ Marketplace ID: ${numeroMarketplace}`);
    console.log(`🏪 Marketplace: ${infoRelevante.marketplace}`);
    console.log(`📊 Status: ${Event} → ${normalizedStatus}`);

    // ─── 1. SALVAR EVENTO JET ─────────────────────────────────────────
    await pool.query(
      `INSERT INTO tracking_events 
       (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload,
         dados_completos = EXCLUDED.dados_completos`,
      [
        uuidv4(),
        numeroMarketplace,
        'JET',
        normalizedStatus,
        new Date(EventOccurredAt),
        JSON.stringify(payload),
        JSON.stringify(infoRelevante)
      ]
    );

    console.log(`✅ JET ${numeroPedido} - Evento ${Event} salvo`);

    // ─── 2. SALVAR MAPEAMENTO ─────────────────────────────────────────
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_jet, numero_marketplace)
       VALUES ($1, $2)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_jet = $1,
         atualizado_em = NOW()`,
      [numeroPedido, numeroMarketplace]
    );

    // ─── 3. TRATAR EVENTOS ESPECÍFICOS E INFERIR ONCLICK ──────────────

    // 🔥 CASO 1: Pedido entrou em produção (EM_PRODUCAO)
    if (Event === 'Pedido.EmProducao') {
      // INFERE que o pedido está na ONCLICK
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          numeroMarketplace,
          'ONCLICK',
          'EM_PRODUCAO',
          new Date(EventOccurredAt),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event }),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, pedido_jet: numeroPedido })
        ]
      );
      
      console.log(`🏭 [ONCLICK] Pedido ${numeroMarketplace} em produção (via JET.EmProducao)`);
    }

    // 🔥 CASO 2: Pedido foi enviado/faturado (ENVIADO)
    if (Event === 'Pedido.Enviado') {
      // 3a: INFERE que o pedido SAIU da ONCLICK
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          numeroMarketplace,
          'ONCLICK',
          'FATURADO_ENVIADO',
          new Date(EventOccurredAt),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event }),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, pedido_jet: numeroPedido })
        ]
      );
      
      console.log(`📦 [ONCLICK] Pedido ${numeroMarketplace} faturado e enviado (via JET.Enviado)`);

      // 3b: GRAVA RETORNO_JET (confirmação de envio)
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload, dados_completos) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           payload = EXCLUDED.payload`,
        [
          uuidv4(),
          numeroMarketplace,
          'RETORNO_JET',
          'CONFIRMADO',
          new Date(EventOccurredAt),
          JSON.stringify(payload),
          JSON.stringify(infoRelevante)
        ]
      );
      
      console.log(`↩️ [RETORNO_JET] Pedido ${numeroMarketplace} confirmado como enviado`);
    }

    // ─── 4. VERIFICAR ANOMALIA: ENVIADO_SEM_PRODUCAO ───────────────────
    if (normalizedStatus === 'ENVIADO') {
      const onclickCheck = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = 'ONCLICK' AND status = 'EM_PRODUCAO'`,
        [numeroMarketplace]
      );

      if (!onclickCheck.rows.length) {
        console.warn(`⚠️ Pedido ${numeroMarketplace} foi enviado sem nunca ter entrado em produção`);
        await anomalyDetector.createAnomaly(
          numeroMarketplace,
          'ENVIADO_SEM_PRODUCAO',
          'JET',
          infoRelevante.marketplace,
          { detalhes: 'JET enviou o pedido mas ele nunca passou pelo status EM_PRODUCAO na ONCLICK' }
        );
      }
    }

    // ─── 5. VERIFICAR PIPELINE COMPLETO ────────────────────────────────
    console.log(`📊 Verificando pipeline...`);
    await anomalyDetector.checkPipelineStatus(numeroMarketplace);

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

    console.log(`✅ JET ${numeroPedido} salvo (sem dados da API)`);
  } catch (error) {
    console.error('❌ Erro ao salvar webhook JET:', error.message);
  }
};

const processOnclickEvent = async (payload) => {
  try {
    const { pedido_id, status } = payload;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📥 WEBHOOK ONCLICK RECEBIDO!`);
    console.log(`   Pedido: ${pedido_id}`);
    console.log(`   Status: ${status}`);

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

    console.log(`✅ ONCLICK ${pedido_id} salvo com status ${normalizedStatus}`);

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