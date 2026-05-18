const express = require('express');
const router = express.Router();
const {
  processAnyMarketEvent,
  processJETEvent,
  processOnlickEvent
} = require('../services/webhook-processor');

router.post('/jet', async (req, res) => {
  try {
    console.log('📥 WEBHOOK JET RECEBIDO!');
    res.status(200).json({ success: true });
    
    // Processar em background
    await processJETEvent(req.body);
  } catch (error) {
    console.error('❌ Erro:', error.message);
  }
});

router.post('/anymarket', async (req, res) => {
  try {
    console.log('📥 WEBHOOK ANYMARKET RECEBIDO!');
    res.status(200).json({ success: true });
    
    // Processar em background
    await processAnyMarketEvent(req.body);
  } catch (error) {
    console.error('❌ Erro:', error.message);
  }
});

router.post('/onlick', async (req, res) => {
  try {
    console.log('📥 WEBHOOK ONLICK RECEBIDO!');
    res.status(200).json({ success: true });
    
    // Processar em background
    await processOnlickEvent(req.body);
  } catch (error) {
    console.error('❌ Erro:', error.message);
  }
});

module.exports = router;