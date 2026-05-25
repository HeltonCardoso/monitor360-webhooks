// services/anymarket-api.js
const axios = require('axios');

const API_KEY = process.env.ANYMARKET_API_KEY;
const BASE_URL = 'https://api.anymarket.com.br/v2';

if (!API_KEY) {
  console.warn('⚠️ Aviso: ANYMARKET_API_KEY não configurado.');
}

const anymarketApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      const url = `${BASE_URL}/orders/${pedidoId}`;
      
      console.log(`🔍 Consultando AnyMarket: ${url}`);

      const response = await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'gumgaToken': API_KEY
        },
        timeout: 60000
      });

      if (response.data) {
        console.log(`✅ Pedido AnyMarket ${pedidoId} encontrado`);
        
        // ✅ AGORA RETORNA O JSON COMPLETO DIRETAMENTE
        // A função extrairInfoRelevante será usada APENAS para extrair o numero_marketplace
        return response.data;
      }

      return null;

    } catch (error) {
      console.error(
        `❌ Erro ao buscar pedido AnyMarket ${pedidoId}:`,
        error.response?.status,
        error.message
      );
      return null;
    }
  },

  // ⚠️ FUNÇÃO MANTIDA APENAS PARA EXTRAIR O numero_marketplace E OUTROS CAMPOS ESSENCIAIS
  // (NÃO SERÁ MAIS USADA PARA POPULAR O dados_completos)
  extrairInfoRelevante(dados) {
    if (!dados) return null;

    try {
      return {
        // IDs - ESSENCIAIS PARA O SISTEMA
        id_anymarket: dados.id,
        numero_marketplace: dados.marketPlaceId,
        marketplace_number: dados.marketPlaceNumber || dados.marketPlaceId,
        marketplace: dados.marketPlace,
        
        // Status - ESSENCIAIS
        status: dados.status || 'DESCONHECIDO',
        status_marketplace: dados.marketPlaceStatus || 'DESCONHECIDO',
        
        // ME2 detection (usado para anomalias)
        produtos: (dados.items || []).map(item => ({
          shippingtype: item.shippings?.[0]?.shippingtype || ''
        }))
      };

    } catch (error) {
      console.error('❌ Erro ao extrair info AnyMarket:', error.message);
      return null;
    }
  }
};

module.exports = anymarketApi;