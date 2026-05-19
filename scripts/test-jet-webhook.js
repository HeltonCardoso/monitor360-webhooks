const pool = require('../config/database');

const testJetWebhook = async () => {
  try {
    console.log('🔍 Buscando webhooks da JET no banco...\n');

    // Buscar todos os webhooks da JET
    const result = await pool.query(
      `SELECT 
        pedido_id,
        status,
        timestamp,
        payload,
        payload->>'Id' AS id_interno,
        payload->>'Event' AS evento,
        payload->>'EventOccurredAt' AS data_evento,
        payload->>'IdVersion' AS id_version,
        payload->>'IdCompany' AS id_company
      FROM tracking_events 
      WHERE origem = 'JET'
      ORDER BY timestamp DESC
      LIMIT 5`
    );

    if (result.rows.length === 0) {
      console.log('❌ Nenhum webhook da JET encontrado no banco');
      process.exit(0);
    }

    console.log(`✅ Encontrados ${result.rows.length} webhooks da JET:\n`);

    result.rows.forEach((row, index) => {
      console.log(`\n📌 Webhook ${index + 1}:`);
      console.log(`   Pedido ID: ${row.pedido_id}`);
      console.log(`   Status: ${row.status}`);
      console.log(`   ID Interno: ${row.id_interno}`);
      console.log(`   Evento: ${row.evento}`);
      console.log(`   Data: ${row.data_evento}`);
      console.log(`   ID Version: ${row.id_version}`);
      console.log(`   ID Company: ${row.id_company}`);
      console.log(`   Payload Completo:`);
      console.log(`   ${JSON.stringify(row.payload, null, 2)}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
};

testJetWebhook();