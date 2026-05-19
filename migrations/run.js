const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const runMigrations = async () => {
  try {
    console.log('🔄 Iniciando migrations...');

    const sqlPath = path.join(__dirname, '001-initial-schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await pool.query(sql);

    console.log('✅ Migrations concluídas com sucesso!');
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro nas migrations:', error.message);
    process.exit(1);
  }
};

runMigrations();