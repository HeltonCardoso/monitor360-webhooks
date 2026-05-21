// routes/dashboard.js
const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/api/metricas', dashboardController.getMetricasGerais);
router.get('/api/anomalias', dashboardController.getAnomalias);
router.get('/api/pedidos', dashboardController.getPedidosPipeline);
router.get('/api/pedidos/:numeroMarketplace', dashboardController.getPedidoDetalhes);
router.get('/api/grafico/status', dashboardController.getGraficoStatusPorPlataforma);
router.patch('/api/anomalias/:id/resolver', dashboardController.resolverAnomalia);

router.get('/', (req, res) => res.render('dashboard'));
router.get('/pedidos', (req, res) => res.render('pedidos'));
router.get('/anomalias', (req, res) => res.render('anomalias'));
router.get('/pedidos/:numeroMarketplace', (req, res) =>
  res.render('pedido-detalhes', { numeroMarketplace: req.params.numeroMarketplace })
);

module.exports = router;