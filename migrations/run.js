const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const runMigrations = async () => {
  try {
    console.log('🔄 Iniciando migrations...');

    // Ler o arquivo SQL
    const sqlPath = path.join(__dirname, '001-initial-schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Executar cada statement
    const statements = sql.split(';').filter(s => s.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await pool.query(statement);
          console.log('✅ Executado:', statement.substring(0, 50) + '...');
        } catch (error) {
          // Ignorar erros de "já existe" (código 42P07)
          if (error.code === '42P07') {
            console.log('⏭️  Já existe:', statement.substring(0, 50) + '...');
          } else {
            throw error;
          }
        }
      }
    }

    
    console.log('✅ Migrations concluídas com sucesso!');
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Erro nas migrations:', error.message);
    process.exit(1);
  }
};

runMigrations();