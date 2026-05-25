// services/jet-api.js
const axios = require('axios');

const API_KEY = process.env.JET_API_TOKEN;

if (!API_KEY) {
  console.warn('⚠️ Aviso: JET_API_TOKEN não configurado. As buscas de pedidos falharão.');
}

const BASE_URL = 'https://openapi.plataformaneo.com.br/order/api/v1/id';
const cachePedidos = new Map();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function buscarDetalhesPedido(idOrder, tentativa = 1) {
  const maxTentativas = 3;

  // Verifica cache
  if (cachePedidos.has(idOrder)) {
    const cached = cachePedidos.get(idOrder);
    if (Date.now() - cached.timestamp < 86400000) {
      console.log(`📦 Pedido ${idOrder} veio do cache`);
      return cached.dados;  // ✅ Retorna JSON completo
    }
  }

  const url = `${BASE_URL}/${idOrder}`;

  for (let tentativaAtual = 1; tentativaAtual <= maxTentativas; tentativaAtual++) {
    try {
      console.log(`🔍 Buscando pedido ${idOrder} (tentativa ${tentativaAtual}/${maxTentativas})...`);
      const inicio = Date.now();

      const response = await axios({
        method: 'GET',
        url: url,
        headers: {
          'apiKey': API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });

      const tempo = Date.now() - inicio;

      if (response.data) {
        console.log(`✅ Pedido ${idOrder} obtido em ${tempo / 1000}s`);
        const dados = response.data.result || response.data;
        
        // ✅ SALVA O JSON COMPLETO NO CACHE
        cachePedidos.set(idOrder, { dados: dados, timestamp: Date.now() });
        return dados;  // ✅ Retorna JSON completo
      }

    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED';
      const status = error.response?.status;

      if (isTimeout) {
        console.log(`⏳ Timeout na tentativa ${tentativaAtual}, aguardando 3s...`);
        await delay(3000);
        continue;
      }

      if (status === 404 && tentativaAtual < maxTentativas) {
        console.log(`⚠️ Pedido ${idOrder} não encontrado (404), aguardando e tentando novamente...`);
        await delay(3000);
        continue;
      }

      if (tentativaAtual === maxTentativas) {
        console.error(`❌ Erro ao buscar pedido ${idOrder}:`, isTimeout ? 'Timeout' : (status || error.message));
      }
    }
  }

  return null;
}

// ⚠️ FUNÇÃO MANTIDA APENAS PARA EXTRAIR O numero_marketplace E OUTROS CAMPOS ESSENCIAIS
// (NÃO SERÁ MAIS USADA PARA POPULAR O dados_completos)
function extrairInfoRelevante(detalhes) {
  if (!detalhes) return null;

  return {
    id: detalhes.idOrder,
    numero_marketplace: detalhes.marketPlaceNumberOrder,
    marketplace: detalhes.marketPlaceName,
    status: detalhes.historyListOrderStatus?.[0]?.statusCode || 'DESCONHECIDO'
    // Apenas o essencial para o sistema funcionar!
  };
}

function statusCache() {
  const total = cachePedidos.size;
  console.log(`📊 Cache: ${total} pedido${total !== 1 ? 's' : ''} armazenado${total !== 1 ? 's' : ''}`);
}

const jetApi = {
  buscarDetalhesPedido,
  extrairInfoRelevante,
  statusCache
};

module.exports = jetApi;