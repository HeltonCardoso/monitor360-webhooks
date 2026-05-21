// services/date-utils.js

/**
 * Calcula o prazo de despacho em horas a partir dos dados do pedido
 * @param {object} dadosPedido - Dados completos do pedido (da AnyMarket)
 * @param {string} marketplace - Nome do marketplace
 * @returns {object} { prazoHoras, dataLimite, fonte, isPrazoReal }
 */
function calcularPrazoDespacho(dadosPedido, marketplace) {
  const { PRAZO_DESPACHO_MARKETPLACE } = require('../config/constants');
  const PRAZO_FALLBACK_GLOBAL = 48; // 48 horas padrão absoluto
  
  let dataLimite = null;
  let fonte = 'nenhum';
  
  // 1️⃣ PRIORIDADE: tempo_despacho (prazo específico do pedido)
  if (dadosPedido?.envio?.tempo_despacho) {
    dataLimite = new Date(dadosPedido.envio.tempo_despacho);
    fonte = 'tempo_despacho';
  }
  
  // 2️⃣ ALTERNATIVA: data_estimada do rastreamento
  else if (dadosPedido?.rastreamento?.data_estimada) {
    dataLimite = new Date(dadosPedido.rastreamento.data_estimada);
    fonte = 'data_estimada';
  }
  
  // 3️⃣ ALTERNATIVA: tempo_promisso
  else if (dadosPedido?.envio?.tempo_promisso) {
    dataLimite = new Date(dadosPedido.envio.tempo_promisso);
    fonte = 'tempo_promisso';
  }
  
  // Se conseguiu extrair uma data limite válida
  if (dataLimite && !isNaN(dataLimite.getTime())) {
    const agora = new Date();
    const prazoHoras = Math.max(0, (dataLimite - agora) / (1000 * 60 * 60));
    
    return {
      prazoHoras,
      dataLimite,
      fonte,
      isPrazoReal: true
    };
  }
  
  // 4️⃣ FALLBACK: Prazo padrão por marketplace
  const config = PRAZO_DESPACHO_MARKETPLACE[marketplace] || PRAZO_DESPACHO_MARKETPLACE.default;
  const prazoHoras = config.horas_padrao;
  
  // Calcula data limite aproximada
  const dataLimiteAprox = new Date();
  dataLimiteAprox.setHours(dataLimiteAprox.getHours() + prazoHoras);
  
  return {
    prazoHoras,
    dataLimite: dataLimiteAprox,
    fonte: `fallback_${marketplace || 'global'}`,
    isPrazoReal: false
  };
}

/**
 * Formata horas para exibição amigável
 * @param {number} horas - Horas a serem formatadas
 * @returns {string} - Ex: "2 dias e 3 horas" ou "4 horas"
 */
function formatarHoras(horas) {
  if (horas >= 24) {
    const dias = Math.floor(horas / 24);
    const horasRestantes = horas % 24;
    if (horasRestantes > 0) {
      return `${dias} dia${dias > 1 ? 's' : ''} e ${horasRestantes.toFixed(0)} hora${horasRestantes > 1 ? 's' : ''}`;
    }
    return `${dias} dia${dias > 1 ? 's' : ''}`;
  }
  return `${horas.toFixed(0)} hora${horas > 1 ? 's' : ''}`;
}

/**
 * Verifica se uma data está expirada
 * @param {Date|string} dataLimite - Data limite
 * @returns {boolean}
 */
function isDataExpirada(dataLimite) {
  const limite = new Date(dataLimite);
  return limite < new Date();
}

module.exports = {
  calcularPrazoDespacho,
  formatarHoras,
  isDataExpirada
};