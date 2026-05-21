// config/constants.js

// Mapeamento de status entre sistemas
const STATUS_MAP = {
  ANYMARKET: {
    'PENDING':              'PENDENTE',
    'PAID_WAITING_SHIP':    'PAGO_AGUARDANDO_ENVIO',
    'INVOICED':             'FATURADO',
    'PAID_WAITING_DELIVERY': 'ENVIADO',
    'CONCLUDED':            'ENTREGUE',
    'CANCELED':             'CANCELADO',
    'WAITING_PAYMENT':      'AGUARDANDO_PAGAMENTO',
    'PAYMENT_REPROVED':     'PAGAMENTO_REPROVADO',
    'error':                'ERRO'
  },
  JET: {
    'Pedido.Pago':          'PAGO',
    'Pedido.Aprovado':      'APROVADO',
    'Pedido.EmProducao':    'EM_PRODUCAO',
    'Pedido.Enviado':       'ENVIADO',
    'Pedido.Entregue':      'ENTREGUE',
    'Pedido.Cancelado':     'CANCELADO',
    'new':                  'NOVO',
    'processing':           'PROCESSANDO',
    'shipped':              'ENVIADO',
    'delivered':            'ENTREGUE',
    'cancelled':            'CANCELADO'
  },
  ONCLICK: {
    'draft':                'RASCUNHO',
    'confirmed':            'CONFIRMADO',
    'invoiced':             'FATURADO',
    'shipped':              'ENVIADO',
    'delivered':            'ENTREGUE',
    'cancelled':            'CANCELADO'
  }
};

// SLA por marketplace (em horas) - para métricas de volume
const SLA_CONFIG = {
  'MERCADO_LIVRE':    { max_hours: 24, alert_at: 20 },
  'SHOPEE':           { max_hours: 24, alert_at: 20 },
  'MADEIRA_MADEIRA':  { max_hours: 48, alert_at: 40 },
  'LEROY_MERLIN':     { max_hours: 48, alert_at: 40 },
  'default':          { max_hours: 24, alert_at: 20 }
};

// Estágios principais do pipeline
const PIPELINE_STAGES = [
  'ANYMARKET',  // 1. Pedido chega do marketplace
  'JET',        // 2. JET integra no ERP
  'ONCLICK'     // 3. Onclick produz/fatura
];

// Estágios de retorno
const PIPELINE_STAGES_RETORNO = [
  'RETORNO_JET',       // 4. JET confirma envio
  'RETORNO_ANYMARKET'  // 5. AnyMarket atualiza marketplace
];

// SLA entre estágios (integração - fixos e curtos)
const SLA_ENTRE_ESTAGIOS = {
  ANYMARKET_para_JET: { 
    horas: 2,  
    descricao: 'AnyMarket → JET (integração no ERP)',
    severidade: 'HIGH'
  },
  JET_para_ONCLICK: { 
    horas: 1,   // 1 hora para entrar na fila da Onclick
    descricao: 'JET → ONCLICK (entrada na produção)',
    severidade: 'HIGH'
  }
};

// Prazos de despacho por marketplace (fallback quando não há prazo real)
const PRAZO_DESPACHO_MARKETPLACE = {
  'MERCADO_LIVRE': {
    horas_padrao: 48,      // 2 dias
    tolerancia_horas: 12,
    alerta_percentual: 80  // Alerta aos 80% do prazo
  },
  'SHOPEE': {
    horas_padrao: 48,
    tolerancia_horas: 12,
    alerta_percentual: 80
  },
  'MADEIRA_MADEIRA': {
    horas_padrao: 72,
    tolerancia_horas: 24,
    alerta_percentual: 80
  },
  'LEROY_MERLIN': {
    horas_padrao: 72,
    tolerancia_horas: 24,
    alerta_percentual: 80
  },
  'default': {
    horas_padrao: 48,
    tolerancia_horas: 12,
    alerta_percentual: 80
  }
};

// Tipos de anomalia e suas descrições
const TIPOS_ANOMALIA = {
  NAO_INTEGROU_JET: {
    descricao: 'Pedido não integrou na JET dentro do SLA',
    severidade: 'HIGH'
  },
  NAO_ENTROU_ONCLICK: {
    descricao: 'JET integrou mas pedido não entrou na Onclick',
    severidade: 'HIGH'
  },
  PROXIMO_PRAZO_ENVIO: {
    descricao: 'Pedido próximo do prazo de despacho (alerta preventivo)',
    severidade: 'WARNING'
  },
  ATRASO_ENVIO_PRAZO: {
    descricao: 'Pedido ULTRAPASSOU o prazo de despacho',
    severidade: 'CRITICAL'
  },
  ENVIADO_SEM_PRODUCAO: {
    descricao: 'JET enviou sem pedido ter entrado na Onclick',
    severidade: 'HIGH'
  },
  FATURADO_APOS_ENVIO: {
    descricao: 'AnyMarket ficou como Faturado após envio (não é ME2)',
    severidade: 'MEDIUM'
  }
};

module.exports = {
  STATUS_MAP,
  SLA_CONFIG,
  PIPELINE_STAGES,
  PIPELINE_STAGES_RETORNO,
  SLA_ENTRE_ESTAGIOS,
  PRAZO_DESPACHO_MARKETPLACE,
  TIPOS_ANOMALIA
};