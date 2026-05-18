const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/database');
const webhookProcessor = require('../services/webhook-processor');

// Middleware de validação de assinatura
const validateWebhookSignature = (secret) => {
  return (req, res, next) => {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    
    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature or timestamp' });
    }

    // Validar timestamp (máximo 5 minutos de diferença)
    const now = Date.now();
    const webhookTime = parseInt(timestamp);
    if (Math.abs(now - webhookTime) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Timestamp expired' });
    }

    // Validar assinatura
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  };
};

// POST /webhooks/anymarket
router.post('/anymarket', 
  validateWebhookSignature(process.env.WEBHOOK_SECRET_ANYMARKET),
  async (req, res) => {
    try {
      const eventId = uuidv4();
      const { pedido_id, status, timestamp, marketplace } = req.body;

      // Armazenar evento bruto
      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [eventId, pedido_id, 'ANYMARKET', status, new Date(timestamp), JSON.stringify(req.body)]
      );

      // Processar e detectar anomalias
      await webhookProcessor.processAnyMarketEvent(pedido_id, status, marketplace);

      res.status(202).json({ 
        success: true, 
        eventId,
        message: 'Webhook recebido e processado'
      });
    } catch (error) {
      console.error('Erro ao processar webhook AnyMarket:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /webhooks/jet
router.post('/jet',
  validateWebhookSignature(process.env.WEBHOOK_SECRET_JET),
  async (req, res) => {
    try {
      const eventId = uuidv4();
      const { pedido_id, status, timestamp } = req.body;

      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [eventId, pedido_id, 'JET', status, new Date(timestamp), JSON.stringify(req.body)]
      );

      await webhookProcessor.processJETEvent(pedido_id, status);

      res.status(202).json({ 
        success: true, 
        eventId,
        message: 'Webhook JET processado'
      });
    } catch (error) {
      console.error('Erro ao processar webhook JET:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /webhooks/onlick
router.post('/onlick',
  validateWebhookSignature(process.env.WEBHOOK_SECRET_ONLICK),
  async (req, res) => {
    try {
      const eventId = uuidv4();
      const { pedido_id, status, timestamp, invoice_number } = req.body;

      await pool.query(
        `INSERT INTO tracking_events 
         (id, pedido_id, origem, status, timestamp, payload) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [eventId, pedido_id, 'ONLICK', status, new Date(timestamp), JSON.stringify(req.body)]
      );

      await webhookProcessor.processOnlickEvent(pedido_id, status, invoice_number);

      res.status(202).json({ 
        success: true, 
        eventId,
        message: 'Webhook Onlick processado'
      });
    } catch (error) {
      console.error('Erro ao processar webhook Onlick:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;