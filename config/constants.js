// config/constants.js

// Mapeamento de status entre sistemas
const STATUS_MAP = {
  ANYMARKET: {
    'PENDING':              'PENDENTE',
    'PAID_WAITING_SHIP':    'PAGO_AGUARDANDO_ENVIO',
    'INVOICED':             'FATURADO',
    'PAID_WAITING_DELIVERY':'ENVIADO',
    'CONCLUDED':            'ENTREGUE',
    'CANCELED':             'CANCELADO',
    // legados
    'WAITING_PAYMENT':      'AGUARDANDO_PAGAMENTO',
    'PAYMENT_REPROVED':     'PAGAMENTO_REPROVADO',
    'error':                'ERRO'
  },
  JET: {
    'Pedido.Pago': 'PAGO',
    'Pedido.Aprovado': 'APROVADO',
    'Pedido.EmProducao': 'EM_PRODUCAO',   // entrou na Onclick
    'Pedido.Enviado': 'ENVIADO',           // faturou e saiu da Onclick
    'Pedido.Entregue': 'ENTREGUE',
    'Pedido.Cancelado': 'CANCELADO',
    'new': 'NOVO',
    'processing': 'PROCESSANDO',
    'shipped': 'ENVIADO',
    'delivered': 'ENTREGUE',
    'cancelled': 'CANCELADO'
  },
  // Status da Onclick inferidos via JET (não recebemos webhooks diretos)
  ONCLICK_INFERIDO: {
    'Pedido.EmProducao': 'EM_PRODUCAO',    // JET → Onclick recebeu o pedido
    'Pedido.Enviado': 'FATURADO_ENVIADO'   // JET → Onclick faturou e enviou
  },
  ONCLICK: {
    'draft': 'RASCUNHO',
    'confirmed': 'CONFIRMADO',
    'invoiced': 'FATURADO',
    'shipped': 'ENVIADO',
    'delivered': 'ENTREGUE',
    'cancelled': 'CANCELADO'
  }
};

// SLA por marketplace (em horas)
const SLA_CONFIG = {
  'mercado-livre': { max_hours: 24, alert_at: 20 },
  'shopee':        { max_hours: 24, alert_at: 20 },
  'b2brazil':      { max_hours: 48, alert_at: 40 },
  'default':       { max_hours: 24, alert_at: 20 }
};

// Estágios principais — são os que realmente gravam em tracking_events
// Cada sistema grava com sua origem ao receber e processar o webhook
const PIPELINE_STAGES = [
  'ANYMARKET',  // 1. Pedido chega pelo marketplace via AnyMarket
  'JET',        // 2. JET integra o pedido no ERP
  'ONCLICK'     // 3. Onclick fatura/expede o pedido
];

// Estágios de retorno — confirmações de volta para o marketplace
// Ainda não implementados como webhooks, monitorados via SLA
const PIPELINE_STAGES_RETORNO = [
  'RETORNO_JET',          // JET confirma envio de volta
  'RETORNO_ANYMARKET',    // AnyMarket atualiza status no marketplace
  'RETORNO_MARKETPLACE'   // Marketplace confirma atualização
];

// Tempo máximo (horas) para cada estágio avançar antes de considerar travado
const SLA_ENTRE_ESTAGIOS = {
  ANYMARKET_para_JET:     { horas: 1,  descricao: 'AnyMarket → JET' },
  JET_para_ONCLICK:       { horas: 2,  descricao: 'JET → Onclick' },
  ONCLICK_para_RETORNO:   { horas: 4,  descricao: 'Onclick → Retorno' }
};

module.exports = {
  STATUS_MAP,
  SLA_CONFIG,
  PIPELINE_STAGES,
  PIPELINE_STAGES_RETORNO,
  SLA_ENTRE_ESTAGIOS
};