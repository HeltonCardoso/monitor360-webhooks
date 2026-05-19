const axios = require('axios');

const anymarketApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      const url = `https://api.anymarket.com.br/v2/orders/${pedidoId}`;
      const token = process.env.ANYMARKET_API_KEY;
      
      console.log(`🔍 Consultando AnyMarket: ${url}`);
      
      const response = await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'gumgaToken': token  // ✅ MUDE AQUI
        },
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      console.error(`❌ Erro ao buscar pedido AnyMarket ${pedidoId}:`, error.response?.status, error.message);
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;
    
    try {
      return {
        id: dados.id,
        cliente: dados.customer?.name || 'N/A',
        email: dados.customer?.email || 'N/A',
        telefone: dados.customer?.phone || 'N/A',
        status: dados.status,
        valor_total: dados.totalAmount || 0,
        data_pedido: dados.createdAt,
        marketplace: dados.marketplace || 'N/A',
        endereco: {
          rua: dados.shippingAddress?.street,
          numero: dados.shippingAddress?.number,
          cidade: dados.shippingAddress?.city,
          estado: dados.shippingAddress?.state,
          cep: dados.shippingAddress?.zipCode
        },
        produtos: (dados.products || []).map(item => ({
          sku: item.sku,
          nome: item.name,
          quantidade: item.quantity,
          preco: item.price
        })),
        rastreamento: dados.trackingNumber || null
      };
    } catch (error) {
      console.error('❌ Erro ao extrair info AnyMarket:', error.message);
      return null;
    }
  }
};

module.exports = anymarketApi;