// Mapeamento de status entre sistemas
const STATUS_MAP = {
  ANYMARKET: {
    'pending': 'PENDENTE',
    'processing': 'PROCESSANDO',
    'shipped': 'ENVIADO',
    'delivered': 'ENTREGUE',
    'cancelled': 'CANCELADO',
    'error': 'ERRO'
  },
  JET: {
    'new': 'NOVO',
    'processing': 'PROCESSANDO',
    'shipped': 'ENVIADO',
    'delivered': 'ENTREGUE',
    'cancelled': 'CANCELADO'
  },
  ONLICK: {
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
  'shopee': { max_hours: 24, alert_at: 20 },
  'b2brazil': { max_hours: 48, alert_at: 40 },
  'default': { max_hours: 24, alert_at: 20 }
};

// Estágios do fluxo
const PIPELINE_STAGES = [
  'MARKETPLACE',
  'ANYMARKET',
  'JET',
  'ONLICK',
  'RETORNO_JET',
  'RETORNO_ANYMARKET',
  'RETORNO_MARKETPLACE'
];

module.exports = {
  STATUS_MAP,
  SLA_CONFIG,
  PIPELINE_STAGES
};