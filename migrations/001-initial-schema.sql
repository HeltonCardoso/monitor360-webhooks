-- Tabela de eventos de rastreamento
CREATE TABLE IF NOT EXISTS tracking_events (
  id UUID PRIMARY KEY,
  pedido_id VARCHAR(50) NOT NULL,
  origem VARCHAR(20) NOT NULL, -- 'ANYMARKET', 'JET', 'ONLICK'
  status VARCHAR(50) NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  payload JSONB,
  criado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(pedido_id, origem, status, timestamp)
);

CREATE INDEX idx_tracking_pedido_id ON tracking_events(pedido_id);
CREATE INDEX idx_tracking_origem ON tracking_events(origem);
CREATE INDEX idx_tracking_timestamp ON tracking_events(timestamp DESC);

-- Tabela de anomalias
CREATE TABLE IF NOT EXISTS anomalias (
  id SERIAL PRIMARY KEY,
  pedido_id VARCHAR(50) NOT NULL,
  tipo VARCHAR(50) NOT NULL, -- 'NAO_INTEGROU', 'FATUROU_NAO_RETORNOU', 'TRAVADO'
  origem_falha VARCHAR(20),
  marketplace VARCHAR(50),
  tempo_atraso_horas INT,
  criado_em TIMESTAMP DEFAULT NOW(),
  resolvido_em TIMESTAMP,
  UNIQUE(pedido_id, tipo)
);

CREATE INDEX idx_anomalias_pedido_id ON anomalias(pedido_id);
CREATE INDEX idx_anomalias_tipo ON anomalias(tipo);
CREATE INDEX idx_anomalias_criado_em ON anomalias(criado_em DESC);

-- Tabela de configuração de SLA
CREATE TABLE IF NOT EXISTS sla_config (
  id SERIAL PRIMARY KEY,
  marketplace VARCHAR(50) UNIQUE,
  tempo_maximo_horas INT,
  alerta_em_horas INT,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- Tabela de logs
CREATE TABLE IF NOT EXISTS logs (
  id SERIAL PRIMARY KEY,
  nivel VARCHAR(20), -- 'INFO', 'WARNING', 'ERROR'
  mensagem TEXT,
  contexto JSONB,
  criado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_logs_criado_em ON logs(criado_em DESC);