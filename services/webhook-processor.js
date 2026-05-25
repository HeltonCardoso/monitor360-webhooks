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
    // ✅ AGORA jsonCompleto É O JSON COMPLETO DA API!
    const jsonCompleto = await anymarketApi.buscarDetalhesPedido(idAnyMarket);
    
    if (!jsonCompleto) {
      console.warn(`⚠️ Não conseguiu buscar dados da API AnyMarket ${idAnyMarket}`);
      return;
    }

    // 2️⃣ EXTRAIR APENAS O NECESSÁRIO PARA O SISTEMA (numero_marketplace, etc)
    const infoEssencial = anymarketApi.extrairInfoRelevante(jsonCompleto);

    if (!infoEssencial || !infoEssencial.numero_marketplace) {
      console.error(`❌ Não conseguiu extrair numero_marketplace do pedido AnyMarket ${idAnyMarket}`);
      return;
    }

    const numeroMarketplace = infoEssencial.numero_marketplace;

    console.log(`✅ Marketplace ID obtido: ${numeroMarketplace}`);
    console.log(`🏪 Marketplace: ${infoEssencial.marketplace}`);
    console.log(`📊 Status: ${event} → ${STATUS_MAP.ANYMARKET[event] || event}`);

    // 3️⃣ SALVAR MAPEAMENTO
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_anymarket, numero_marketplace, marketplace_origem)
       VALUES ($1, $2, $3)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_anymarket = $1,
         marketplace_origem = $3,
         atualizado_em = NOW()`,
      [idAnyMarket, numeroMarketplace, infoEssencial.marketplace]
    );

    // 4️⃣ NORMALIZAR STATUS
    const normalizedStatus = STATUS_MAP.ANYMARKET[event] || event;

    // 5️⃣ SALVAR TRACKING - ✅ dados_completos RECEBE O JSON COMPLETO!
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
        JSON.stringify(jsonCompleto)  // ✅ AGORA É O JSON COMPLETO!
      ]
    );

    console.log(`✅ ANYMARKET ${numeroMarketplace} salvo com status ${normalizedStatus}`);

    // 6️⃣ PAID_WAITING_DELIVERY = AnyMarket confirmou envio
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
          JSON.stringify(jsonCompleto)  // ✅ JSON COMPLETO TAMBÉM
        ]
      );
      console.log(`↩️ [RETORNO_ANYMARKET] Pedido ${numeroMarketplace} confirmado como enviado`);
    }

    // 7️⃣ VERIFICAR ANOMALIA: FATURADO_APOS_ENVIO (exceto ME2)
    if (event === 'INVOICED') {
      const jetEnviado = await pool.query(
        `SELECT id FROM tracking_events 
         WHERE pedido_id = $1 AND origem = 'JET' AND status = 'ENVIADO' LIMIT 1`,
        [numeroMarketplace]
      );

      if (jetEnviado.rows.length) {
        // ✅ Usa infoEssencial (já tem shippingtype)
        const pedidoIsMe2 = infoEssencial.produtos?.some(item =>
          (item.shippingtype || '').toLowerCase().includes('me2')
        );
        
        if (!pedidoIsMe2) {
          console.warn(`⚠️ Pedido ${numeroMarketplace} ficou FATURADO após JET enviar (não é ME2)`);
          await anomalyDetector.createAnomaly(
            numeroMarketplace,
            'FATURADO_APOS_ENVIO',
            'ANYMARKET',
            infoEssencial.marketplace,
            { detalhes: 'AnyMarket ficou como Faturado após JET já ter confirmado envio' }
          );
        } else {
          console.log(`ℹ️ Pedido ${numeroMarketplace} ME2 - aguardando bipagem da etiqueta`);
        }
      }
    }

    // 8️⃣ VERIFICAR PIPELINE
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

    const dedupKeyJet = `jet-${idInterno}-${Event}`;
    if (isDuplicate(dedupKeyJet)) {
      console.log(`⏭️ Ignorando duplicata JET: ${idInterno} - ${Event}`);
      return;
    }

    // 1️⃣ BUSCAR DADOS COMPLETOS NA API
    // ✅ AGORA jsonCompleto É O JSON COMPLETO DA API!
    const jsonCompleto = await jetApi.buscarDetalhesPedido(numeroPedido);
    
    if (!jsonCompleto) {
      console.warn(`⚠️ Não conseguiu buscar dados da API JET ${numeroPedido}`);
      await salvarWebhookJET(idInterno, numeroPedido, Event, EventOccurredAt, payload);
      return;
    }

    // 2️⃣ EXTRAIR APENAS O NECESSÁRIO PARA O SISTEMA
    const infoEssencial = jetApi.extrairInfoRelevante(jsonCompleto);

    if (!infoEssencial || !infoEssencial.numero_marketplace) {
      console.warn(`⚠️ Não conseguiu extrair numero_marketplace do pedido JET ${numeroPedido}`);
      await salvarWebhookJET(idInterno, numeroPedido, Event, EventOccurredAt, payload);
      return;
    }

    const numeroMarketplace = infoEssencial.numero_marketplace;
    const normalizedStatus = STATUS_MAP.JET[Event] || Event;

    console.log(`✅ Marketplace ID: ${numeroMarketplace}`);
    console.log(`🏪 Marketplace: ${infoEssencial.marketplace}`);
    console.log(`📊 Status: ${Event} → ${normalizedStatus}`);

    // ─── 3. SALVAR EVENTO JET - ✅ dados_completos RECEBE O JSON COMPLETO! ───
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
        JSON.stringify(jsonCompleto)  // ✅ AGORA É O JSON COMPLETO!
      ]
    );

    console.log(`✅ JET ${numeroPedido} - Evento ${Event} salvo`);

    // ─── 4. SALVAR MAPEAMENTO ─────────────────────────────────────────
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
       (id_jet, numero_marketplace)
       VALUES ($1, $2)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_jet = $1,
         atualizado_em = NOW()`,
      [numeroPedido, numeroMarketplace]
    );

    // ─── 5. TRATAR EVENTOS ESPECÍFICOS E INFERIR ONCLICK ──────────────

    // Pedido entrou em produção
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
          numeroMarketplace,
          'ONCLICK',
          'EM_PRODUCAO',
          new Date(EventOccurredAt),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event }),
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, json_completo_jet: jsonCompleto })
        ]
      );
      console.log(`🏭 [ONCLICK] Pedido ${numeroMarketplace} em produção (via JET.EmProducao)`);
    }

    // Pedido foi enviado
    if (Event === 'Pedido.Enviado') {
      // Inferir saída da ONCLICK
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
          JSON.stringify({ inferido_de: 'JET', evento_jet: Event, json_completo_jet: jsonCompleto })
        ]
      );
      console.log(`📦 [ONCLICK] Pedido ${numeroMarketplace} faturado e enviado (via JET.Enviado)`);

      // Gravar RETORNO_JET
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
          JSON.stringify(jsonCompleto)  // ✅ JSON COMPLETO
        ]
      );
      console.log(`↩️ [RETORNO_JET] Pedido ${numeroMarketplace} confirmado como enviado`);
    }

    // ─── 6. VERIFICAR ANOMALIA: ENVIADO_SEM_PRODUCAO ───────────────────
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
          infoEssencial.marketplace,
          { detalhes: 'JET enviou o pedido mas ele nunca passou pelo status EM_PRODUCAO na ONCLICK' }
        );
      }
    }

    // ─── 7. VERIFICAR PIPELINE COMPLETO ────────────────────────────────
    console.log(`📊 Verificando pipeline...`);
    await anomalyDetector.checkPipelineStatus(numeroMarketplace);

  } catch (error) {
    console.error('❌ Erro ao processar JET:', error.message);
  }
};

// Função auxiliar para salvar webhook sem dados da API
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
        JSON.stringify({ erro: 'Não foi possível buscar dados da API JET', webhook_original: payload })
      ]
    );

    console.log(`✅ JET ${numeroPedido} salvo (sem dados da API)`);
  } catch (error) {
    console.error('❌ Erro ao salvar webhook JET:', error.message);
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