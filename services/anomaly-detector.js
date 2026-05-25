// services/anomaly-detector.js
const pool = require('../config/database');
const notification = require('./notification');
const { SLA_ENTRE_ESTAGIOS, PRAZO_DESPACHO_MARKETPLACE, TIPOS_ANOMALIA } = require('../config/constants');
const { calcularPrazoDespacho, formatarHoras } = require('./date-utils');

const createAnomaly = async (pedido_id, tipo, origem_falha, marketplace, metadata = {}) => {
  try {
    // Verifica se já existe anomalia NÃO RESOLVIDA do mesmo tipo
    const existing = await pool.query(
      `SELECT id FROM anomalias 
       WHERE pedido_id = $1 AND tipo = $2 AND resolvida = false 
       LIMIT 1`,
      [pedido_id, tipo]
    );

    if (existing.rows.length) {
      console.log(`ℹ️ Anomalia ${tipo} para pedido ${pedido_id} já existe (não resolvida)`);
      return;
    }

    // ✅ VERSÃO CORRIGIDA - SEM a coluna metadata
    await pool.query(
      `INSERT INTO anomalias (pedido_id, tipo, origem_falha, marketplace, criado_em)
       VALUES ($1, $2, $3, $4, NOW())`,
      [pedido_id, tipo, origem_falha, marketplace]
    );

    const infoAnomalia = TIPOS_ANOMALIA[tipo] || { descricao: tipo, severidade: 'MEDIUM' };
    
    let mensagem = `
╔═══════════════════════════════════════════════════════════════╗
║                      🚨 ANOMALIA DETECTADA                      ║
╠═══════════════════════════════════════════════════════════════╣
║ 📦 Pedido:      ${pedido_id.padEnd(50)}║
║ ⚠️ Tipo:        ${tipo.padEnd(50)}║
║ 📝 Descrição:   ${infoAnomalia.descricao.padEnd(50)}║
║ 📍 Origem:      ${origem_falha.padEnd(50)}║
║ 🏪 Marketplace: ${(marketplace || 'N/A').padEnd(50)}║
`;

    if (metadata.detalhes) {
      mensagem += `║ 📋 Detalhes:    ${metadata.detalhes.substring(0, 47).padEnd(50)}║\n`;
    }
    if (metadata.tempo_decorrido) {
      mensagem += `║ ⏱️  Decorrido:    ${formatarHoras(parseFloat(metadata.tempo_decorrido)).padEnd(50)}║\n`;
    }
    if (metadata.prazo_total) {
      mensagem += `║ 📅 Prazo total: ${formatarHoras(parseFloat(metadata.prazo_total)).padEnd(50)}║\n`;
    }
    if (metadata.horas_restantes && parseFloat(metadata.horas_restantes) > 0) {
      mensagem += `║ ⏳ Restante:    ${formatarHoras(parseFloat(metadata.horas_restantes)).padEnd(50)}║\n`;
    }

    mensagem += `╚═══════════════════════════════════════════════════════════════╝`;

    await notification.sendAlert(mensagem, infoAnomalia.severidade);
    
    console.log(`✅ Anomalia ${tipo} criada para pedido ${pedido_id}`);
  } catch (error) {
    console.error('Erro ao criar anomalia:', error);
  }
};

const checkPipelineStatus = async (pedido_id) => {
  try {
    // Busca todos os eventos do pedido
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

    // Buscar dados completos do pedido para calcular prazo
    const pedidoQuery = await pool.query(`
      SELECT 
        dados_completos,
        dados_completos->>'marketplace' as marketplace
      FROM tracking_events
      WHERE pedido_id = $1 AND origem = 'ANYMARKET'
      ORDER BY timestamp DESC
      LIMIT 1
    `, [pedido_id]);

    if (!pedidoQuery.rows.length) {
      console.log(`⚠️ Pedido ${pedido_id} sem dados ANYMARKET, não é possível verificar pipeline`);
      return;
    }

    const dadosCompletos = pedidoQuery.rows[0].dados_completos;
    const marketplace = pedidoQuery.rows[0].marketplace || 'default';

    // 🔥 CALCULA O PRAZO REAL DO PEDIDO
    const prazoInfo = calcularPrazoDespacho(dadosCompletos, marketplace);
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📊 ANALISANDO PEDIDO ${pedido_id}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`🏪 Marketplace: ${marketplace}`);
    console.log(`📅 Prazo de despacho: ${prazoInfo.prazoHoras.toFixed(1)} horas (${formatarHoras(prazoInfo.prazoHoras)})`);
    console.log(`📍 Fonte do prazo: ${prazoInfo.fonte}`);
    console.log(`🎯 Data limite: ${prazoInfo.dataLimite.toLocaleString('pt-BR')}`);
    console.log(`   ${prazoInfo.isPrazoReal ? '✅ Prazo REAL do pedido' : '⚠️ Prazo FALLBACK (padrão do marketplace)'}`);

    // Status finais - ignorar verificações
    const statusFinais = ['ENTREGUE', 'CANCELADO', 'CONCLUDED', 'CANCELED'];
    const anymarketEvent = events.rows.find(r => r.origem === 'ANYMARKET');
    const statusAtual = anymarketEvent?.status || '';
    
    if (statusFinais.includes(statusAtual)) {
      console.log(`ℹ️ Pedido finalizado (${statusAtual}) — pipeline encerrado`);
      console.log(`${'═'.repeat(60)}\n`);
      return;
    }

    // ─── PIPELINE VISUAL ───────────────────────────────────────────────
    const stages = ['ANYMARKET', 'JET', 'ONCLICK', 'RETORNO_JET', 'RETORNO_ANYMARKET'];
    console.log(`\n📊 Pipeline do pedido:`);
    stages.forEach(stage => {
      const evento = events.rows.find(r => r.origem === stage);
      const icone = evento ? '✅' : '⏳';
      const tempo = evento ? new Date(evento.ultimo_evento).toLocaleString('pt-BR') : '-';
      const status = evento?.status ? ` [${evento.status}]` : '';
      console.log(`   ${icone} ${stage.padEnd(14)} ${status.padEnd(20)} ${evento ? `(${tempo})` : ''}`);
    });

    // ─── VERIFICAÇÃO 1: AnyMarket → JET (SLA: 2h) ─────────────────────
    const temAnymarket = origens.includes('ANYMARKET');
    const temJet = origens.includes('JET');

    if (temAnymarket && !temJet) {
      const eventoAnymarket = events.rows.find(r => r.origem === 'ANYMARKET');
      const horasEsperando = (agora - new Date(eventoAnymarket.ultimo_evento)) / (1000 * 60 * 60);
      const sla = SLA_ENTRE_ESTAGIOS.ANYMARKET_para_JET.horas;

      console.log(`\n🔍 [1/3] VERIFICANDO INTEGRAÇÃO JET`);
      console.log(`   ⏱️  Aguardando JET: ${horasEsperando.toFixed(1)}h / ${sla}h`);

      if (horasEsperando > sla) {
        console.log(`   ⚠️ SLA ULTRAPASSADO! Criando anomalia...`);
        await createAnomaly(pedido_id, 'NAO_INTEGROU_JET', 'ANYMARKET', marketplace, {
          detalhes: `Pedido não integrou na JET após ${horasEsperando.toFixed(1)}h (SLA: ${sla}h)`,
          tempo_decorrido: horasEsperando.toFixed(1),
          sla_horas: sla
        });
      } else {
        console.log(`   ✅ Dentro do SLA (${horasEsperando.toFixed(1)}h < ${sla}h)`);
      }
    }

    // ─── VERIFICAÇÃO 2: JET → ONCLICK (entrada na produção - SLA: 1h) ──
    const temOnclick = origens.includes('ONCLICK');
    
    if (temJet && !temOnclick) {
      const eventoJet = events.rows.find(r => r.origem === 'JET');
      const horasEsperando = (agora - new Date(eventoJet.ultimo_evento)) / (1000 * 60 * 60);
      const sla = SLA_ENTRE_ESTAGIOS.JET_para_ONCLICK.horas;

      console.log(`\n🔍 [2/3] VERIFICANDO ENTRADA NA ONCLICK`);
      console.log(`   ⏱️  Aguardando ONCLICK: ${horasEsperando.toFixed(1)}h / ${sla}h`);

      if (horasEsperando > sla) {
        console.log(`   ⚠️ SLA ULTRAPASSADO! Criando anomalia...`);
        await createAnomaly(pedido_id, 'NAO_ENTROU_ONCLICK', 'JET', marketplace, {
          detalhes: `Pedido integrado na JET mas não entrou na Onclick após ${horasEsperando.toFixed(1)}h (SLA: ${sla}h)`,
          tempo_decorrido: horasEsperando.toFixed(1),
          sla_horas: sla
        });
      } else {
        console.log(`   ✅ Dentro do SLA (${horasEsperando.toFixed(1)}h < ${sla}h)`);
      }
    }

    // ─── VERIFICAÇÃO 3: ONCLICK → ENVIO (prazo DINÂMICO do pedido) ────
    if (temOnclick) {
      const eventoOnclick = events.rows.find(r => r.origem === 'ONCLICK');
      const tempoDecorrido = (agora - new Date(eventoOnclick.ultimo_evento)) / (1000 * 60 * 60);
      const temEnvio = origens.includes('RETORNO_JET') || origens.includes('ENVIADO');
      
      if (temEnvio) {
        console.log(`\n✅ Pedido já foi enviado! Pipeline completo.`);
        console.log(`${'═'.repeat(60)}\n`);
        return;
      }
      
      // 🔥 USA O PRAZO REAL DO PEDIDO (calculado acima)
      const limiteEnvioHoras = prazoInfo.prazoHoras;
      const percentualPrazo = (tempoDecorrido / limiteEnvioHoras) * 100;
      const prazoVencido = tempoDecorrido > limiteEnvioHoras;
      
      // Configura alerta preventivo (80% do prazo, apenas para prazos > 4h)
      const config = PRAZO_DESPACHO_MARKETPLACE[marketplace] || PRAZO_DESPACHO_MARKETPLACE.default;
      const alertaPercentual = config.alerta_percentual || 80;
      const alertaPrevio = percentualPrazo > alertaPercentual && limiteEnvioHoras > 4;
      
      console.log(`\n🔍 [3/3] VERIFICANDO PRAZO DE ENVIO`);
      console.log(`   ⏱️  Tempo em produção: ${tempoDecorrido.toFixed(1)}h (${formatarHoras(tempoDecorrido)})`);
      console.log(`   📅 Prazo total: ${limiteEnvioHoras.toFixed(1)}h (${formatarHoras(limiteEnvioHoras)})`);
      console.log(`   📊 Percentual: ${percentualPrazo.toFixed(0)}%`);
      console.log(`   🎯 Alerta aos: ${alertaPercentual}% do prazo`);
      
      if (prazoVencido) {
        // 🔴 CRÍTICO: Passou do prazo!
        const atrasoHoras = (tempoDecorrido - limiteEnvioHoras).toFixed(1);
        console.log(`\n   🔴 PEDIDO ATRASADO! Atraso de ${atrasoHoras}h`);
        await createAnomaly(pedido_id, 'ATRASO_ENVIO_PRAZO', 'ONCLICK', marketplace, {
          detalhes: `Pedido NÃO foi enviado. Atraso de ${atrasoHoras}h em relação ao prazo de despacho.`,
          tempo_decorrido: tempoDecorrido.toFixed(1),
          prazo_total: limiteEnvioHoras.toFixed(1),
          horas_restantes: 0,
          atraso_horas: atrasoHoras,
          fonte_prazo: prazoInfo.fonte
        });
        
        await notification.sendAlert(
          `🚨 PEDIDO ATRASADO! Pedido ${pedido_id} ultrapassou prazo de despacho em ${atrasoHoras}h`,
          'URGENT'
        );
        
      } else if (alertaPrevio) {
        // ⚠️ ALERTA PREVENTIVO
        const horasRestantes = (limiteEnvioHoras - tempoDecorrido).toFixed(1);
        console.log(`\n   ⚠️ Pedido próximo do prazo! Faltam ${formatarHoras(parseFloat(horasRestantes))}`);
        await createAnomaly(pedido_id, 'PROXIMO_PRAZO_ENVIO', 'ONCLICK', marketplace, {
          detalhes: `Pedido próximo do prazo de despacho. Faltam ${formatarHoras(parseFloat(horasRestantes))} para o prazo vencer.`,
          tempo_decorrido: tempoDecorrido.toFixed(1),
          prazo_total: limiteEnvioHoras.toFixed(1),
          horas_restantes: horasRestantes,
          percentual: percentualPrazo.toFixed(0),
          fonte_prazo: prazoInfo.fonte
        });
        
        await notification.sendAlert(
          `⚠️ Pedido ${pedido_id} próximo do prazo! Faltam ${formatarHoras(parseFloat(horasRestantes))} para o prazo de despacho.`,
          'WARNING'
        );
        
      } else {
        console.log(`   ✅ Dentro do prazo: ${percentualPrazo.toFixed(0)}% do prazo consumido`);
      }
    }

    console.log(`${'═'.repeat(60)}\n`);

  } catch (error) {
    console.error('❌ Erro ao verificar pipeline:', error);
  }
};

module.exports = {
  createAnomaly,
  checkPipelineStatus
};