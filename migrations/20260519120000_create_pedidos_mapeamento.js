// migrations/20260519120000_create_pedidos_mapeamento.js

const pool = require('../config/database');

async function up() {
  try {
    console.log('🔄 Criando tabela pedidos_mapeamento...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_mapeamento (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        
        -- IDs em cada plataforma
        id_anymarket BIGINT,
        id_jet BIGINT,
        id_onclick BIGINT,
        id_marketplace VARCHAR(100),
        
        -- Campo comum (o que conecta tudo)
        numero_marketplace VARCHAR(100) NOT NULL UNIQUE,
        
        -- Marketplace origem
        marketplace_origem VARCHAR(50),
        
        -- Metadados
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Tabela pedidos_mapeamento criada com sucesso!');

    // ✅ CRIAR ÍNDICES
    console.log('🔄 Criando índices...');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_numero_marketplace 
      ON pedidos_mapeamento(numero_marketplace);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_id_anymarket 
      ON pedidos_mapeamento(id_anymarket);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_id_jet 
      ON pedidos_mapeamento(id_jet);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_id_onclick 
      ON pedidos_mapeamento(id_onclick);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_marketplace_origem 
      ON pedidos_mapeamento(marketplace_origem);
    `);

    console.log('✅ Índices criados com sucesso!');

  } catch (error) {
    console.error('❌ Erro ao criar tabela pedidos_mapeamento:', error.message);
    throw error;
  }
}

async function down() {
  try {
    console.log('🔄 Removendo tabela pedidos_mapeamento...');

    await pool.query(`
      DROP TABLE IF EXISTS pedidos_mapeamento CASCADE;
    `);

    console.log('✅ Tabela pedidos_mapeamento removida com sucesso!');

  } catch (error) {
    console.error('❌ Erro ao remover tabela pedidos_mapeamento:', error.message);
    throw error;
  }
}

module.exports = { up, down };