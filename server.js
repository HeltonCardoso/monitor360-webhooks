const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.static('public'));
app.use('/', dashboardRoutes);

// Rota raiz
app.get('/', (req, res) => {
  res.json({ 
    message: 'Monitor360 Webhooks API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      webhooks: {
        anymarket: '/webhooks/anymarket',
        jet: '/webhooks/jet',
        onclick: '/webhooks/onclick'
      }
    }
  });
});

// Rotas
app.use('/webhooks', webhookRoutes);
app.use('/health', healthRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});