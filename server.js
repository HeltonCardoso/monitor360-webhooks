const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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