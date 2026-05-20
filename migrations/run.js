// migrations/run.js
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const runMigrations = async () => {
  try {
    console.log('🔄 Iniciando migrations...');

    // Garante que a tabela de controle existe
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations_executadas (
        id SERIAL PRIMARY KEY,
        arquivo VARCHAR(255) UNIQUE NOT NULL,
        executado_em TIMESTAMP DEFAULT NOW()
      )
    `);

    // Lê todos os .sql da pasta migrations em ordem
    const migrationDir = __dirname;
    const arquivos = fs.readdirSync(migrationDir)
      .filter(f => f.endsWith('.sql'))
      .sort(); // garante ordem: 001, 002, 003...

    for (const arquivo of arquivos) {
      // Verifica se já foi executado
      const { rows } = await pool.query(
        'SELECT id FROM migrations_executadas WHERE arquivo = $1',
        [arquivo]
      );

      if (rows.length > 0) {
        console.log(`⏭️  ${arquivo} já executado, pulando...`);
        continue;
      }

      // Executa o arquivo SQL
      console.log(`▶️  Executando ${arquivo}...`);
      const sql = fs.readFileSync(path.join(migrationDir, arquivo), 'utf8');
      await pool.query(sql);

      // Registra como executado
      await pool.query(
        'INSERT INTO migrations_executadas (arquivo) VALUES ($1)',
        [arquivo]
      );

      console.log(`✅ ${arquivo} concluído`);
    }

    console.log('✅ Todas as migrations concluídas!');
    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ Erro nas migrations:', error.message);
    process.exit(1);
  }
};

runMigrations();