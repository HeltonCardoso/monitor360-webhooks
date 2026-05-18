const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/database');

// POST /webhooks/jet
router.post('/jet', async (req, res) => {
  try {
    console.log('📥 WEBHOOK JET RECEBIDO!');
    console.log('Timestamp:', new Date().toLocaleString('pt-BR'));
    console.log('Body:', JSON.stringify(req.body).substring(0, 200));

    const eventId = uuidv4();
    const { pedido_id, status, timestamp } = req.body;

    // Responder IMEDIATAMENTE (200 = Accepted)
    res.status(200).json({ 
      success: true, 
      eventId,
      message: 'Webhook JET recebido'
    });

    // Processar em background (não bloqueia a resposta)
    if (pedido_id && status) {
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [eventId, pedido_id, 'JET', status, new Date(timestamp || Date.now()), JSON.stringify(req.body)]
      );
      console.log('✅ Evento JET armazenado:', pedido_id);
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook JET:', error.message);
    // Responder mesmo com erro
    res.status(200).json({ success: true, message: 'Recebido' });
  }
});

// POST /webhooks/anymarket
router.post('/anymarket', async (req, res) => {
  try {
    console.log('📥 WEBHOOK ANYMARKET RECEBIDO!');
    console.log('Timestamp:', new Date().toLocaleString('pt-BR'));
    console.log('Body:', JSON.stringify(req.body).substring(0, 200));

    const eventId = uuidv4();
    const { pedido_id, status, timestamp, marketplace } = req.body;

    // Responder IMEDIATAMENTE
    res.status(200).json({ 
      success: true, 
      eventId,
      message: 'Webhook AnyMarket recebido'
    });

    // Processar em background
    if (pedido_id && status) {
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [eventId, pedido_id, 'ANYMARKET', status, new Date(timestamp || Date.now()), JSON.stringify(req.body)]
      );
      console.log('✅ Evento AnyMarket armazenado:', pedido_id);
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook AnyMarket:', error.message);
    res.status(200).json({ success: true, message: 'Recebido' });
  }
});

// POST /webhooks/onlick
router.post('/onlick', async (req, res) => {
  try {
    console.log('📥 WEBHOOK ONLICK RECEBIDO!');
    console.log('Timestamp:', new Date().toLocaleString('pt-BR'));
    console.log('Body:', JSON.stringify(req.body).substring(0, 200));

    const eventId = uuidv4();
    const { pedido_id, status, timestamp, invoice_number } = req.body;

    // Responder IMEDIATAMENTE
    res.status(200).json({ 
      success: true, 
      eventId,
      message: 'Webhook Onlick recebido'
    });

    // Processar em background
    if (pedido_id && status) {
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [eventId, pedido_id, 'ONLICK', status, new Date(timestamp || Date.now()), JSON.stringify(req.body)]
      );
      console.log('✅ Evento Onlick armazenado:', pedido_id);
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook Onlick:', error.message);
    res.status(200).json({ success: true, message: 'Recebido' });
  }
});

module.exports = router;