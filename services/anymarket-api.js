const axios = require('axios');

const anymarketApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      const response = await axios.get(
        `https://api.anymarket.com.br/v2/orders/${pedidoId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.ANYMARKET_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      console.error(`❌ Erro ao buscar pedido AnyMarket ${pedidoId}:`, error.message);
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;
    
    try {
      return {
        id: dados.id,
        cliente: dados.customer?.name || dados.Customer?.Name || 'N/A',
        email: dados.customer?.email || dados.Customer?.Email || 'N/A',
        telefone: dados.customer?.phone || dados.Customer?.Phone || 'N/A',
        status: dados.status || dados.Status,
        valor_total: dados.totalAmount || dados.TotalAmount || 0,
        data_pedido: dados.createdAt || dados.CreatedAt,
        marketplace: dados.marketplace || 'N/A',
        endereco: {
          rua: dados.shippingAddress?.street || dados.ShippingAddress?.Street,
          numero: dados.shippingAddress?.number || dados.ShippingAddress?.Number,
          cidade: dados.shippingAddress?.city || dados.ShippingAddress?.City,
          estado: dados.shippingAddress?.state || dados.ShippingAddress?.State,
          cep: dados.shippingAddress?.zipCode || dados.ShippingAddress?.ZipCode
        },
        produtos: (dados.products || dados.Products || []).map(item => ({
          sku: item.sku || item.Sku,
          nome: item.name || item.Name,
          quantidade: item.quantity || item.Quantity,
          preco: item.price || item.Price
        })),
        rastreamento: dados.trackingNumber || dados.TrackingNumber || null
      };
    } catch (error) {
      console.error('❌ Erro ao extrair info AnyMarket:', error.message);
      return null;
    }
  }
};

module.exports = anymarketApi;