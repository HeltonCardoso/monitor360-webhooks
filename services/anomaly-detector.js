// services/anomaly-detector.js
const pool = require('../config/database');
const notification = require('./notification');
const { SLA_CONFIG, PIPELINE_STAGES, PIPELINE_STAGES_RETORNO, SLA_ENTRE_ESTAGIOS } = require('../config/constants');

const createAnomaly = async (pedido_id, tipo, origem_falha, marketplace) => {
  try {
    await pool.query(
      `INSERT INTO anomalias (pedido_id, tipo, origem_falha, marketplace, criado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (pedido_id, tipo) DO NOTHING`,
      [pedido_id, tipo, origem_falha, marketplace]
    );

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
    // Busca todos os eventos do pedido ordenados por tempo
    const events = await pool.query(
      `SELECT origem, status, MAX(timestamp) as ultimo_evento
       FROM tracking_events
       WHERE pedido_id = $1
       GROUP BY origem, status
       ORDER BY ultimo_evento ASC`,
      [pedido_id]
    );

    if (!events.rows.length) return;

    const origens = events.rows.map(r => r.origem);
    const agora = Date.now();

    // Não verificar pipeline de pedidos já finalizados
    const statusFinais = ['ENTREGUE', 'CANCELADO'];
    const statusAtual = events.rows.find(r => r.origem === 'ANYMARKET')?.status || '';
    if (statusFinais.includes(statusAtual)) {
      console.log(`ℹ️  Pedido ${pedido_id} finalizado (${statusAtual}) — pipeline encerrado`);
      return;
    }

    // ─── Monta visão do pipeline ───────────────────────────────────────────
    const todoEstagio = [...PIPELINE_STAGES, ...PIPELINE_STAGES_RETORNO];
    const pipeline = todoEstagio.map(estagio => {
      const evento = events.rows.find(r => r.origem === estagio);
      return {
        estagio,
        concluido: !!evento,
        status: evento?.status || null,
        em: evento?.ultimo_evento || null
      };
    });

    // Encontra onde o pedido está agora
    const ultimoConcluido = pipeline.filter(p => p.concluido).pop();
    const proximoPendente = pipeline.find(p => !p.concluido);

    console.log(`\n📊 Pipeline do pedido ${pedido_id}:`);
    pipeline.forEach(p => {
      const icone = p.concluido ? '✅' : '⏳';
      const tempo = p.em ? new Date(p.em).toLocaleString('pt-BR') : '-';
      const status = p.status ? ` [${p.status}]` : '';
      console.log(`   ${icone} ${p.estagio}${status} ${p.em ? `(${tempo})` : ''}`);
    });

    if (proximoPendente) {
      console.log(`   ➡️  Aguardando: ${proximoPendente.estagio}\n`);
    } else {
      console.log(`   🏁 Pedido com pipeline completo!\n`);
    }

    // ─── Checagem de travamento entre estágios ─────────────────────────────

    // 1. AnyMarket recebido mas JET ainda não integrou
    const temAnymarket = origens.includes('ANYMARKET');
    const temJet = origens.includes('JET');
    const temOnclick = origens.includes('ONCLICK');

    if (temAnymarket && !temJet) {
      const eventoAnymarket = events.rows.find(r => r.origem === 'ANYMARKET');
      const horasEsperando = (agora - new Date(eventoAnymarket.ultimo_evento)) / (1000 * 60 * 60);
      const sla = SLA_ENTRE_ESTAGIOS.ANYMARKET_para_JET.horas;

      if (horasEsperando > sla) {
        console.warn(`⚠️ Pedido ${pedido_id} travado em ANYMARKET há ${horasEsperando.toFixed(1)}h (SLA: ${sla}h)`);
        await createAnomaly(pedido_id, 'NAO_INTEGROU_JET', 'ANYMARKET', null);
      }
    }

    // 2. JET integrou mas Onclick ainda não faturou
    if (temJet && !temOnclick) {
      const eventoJet = events.rows.find(r => r.origem === 'JET');
      const horasEsperando = (agora - new Date(eventoJet.ultimo_evento)) / (1000 * 60 * 60);
      const sla = SLA_ENTRE_ESTAGIOS.JET_para_ONCLICK.horas;

      if (horasEsperando > sla) {
        console.warn(`⚠️ Pedido ${pedido_id} travado em JET há ${horasEsperando.toFixed(1)}h (SLA: ${sla}h)`);
        await createAnomaly(pedido_id, 'NAO_FATUROU_ONCLICK', 'JET', null);
      }
    }

    // 3. Onclick faturou mas não houve retorno para a JET
    if (temOnclick) {
      const eventoOnclick = events.rows.find(r => r.origem === 'ONCLICK');
      const horasEsperando = (agora - new Date(eventoOnclick.ultimo_evento)) / (1000 * 60 * 60);
      const sla = SLA_ENTRE_ESTAGIOS.ONCLICK_para_RETORNO.horas;
      const temRetornoJet = origens.includes('RETORNO_JET');

      if (!temRetornoJet && horasEsperando > sla) {
        console.warn(`⚠️ Pedido ${pedido_id} faturado mas sem retorno à JET há ${horasEsperando.toFixed(1)}h (SLA: ${sla}h)`);
        await createAnomaly(pedido_id, 'FATUROU_NAO_RETORNOU', 'ONCLICK', null);
      }
    }

  } catch (error) {
    console.error('Erro ao verificar pipeline:', error);
  }
};

module.exports = {
  createAnomaly,
  checkPipelineStatus
};