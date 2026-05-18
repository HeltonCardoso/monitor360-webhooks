const axios = require('axios');

const jetApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      const response = await axios.get(
        `https://api.jet.com.br/pedidos/${pedidoId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.JET_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      console.error(`❌ Erro ao buscar pedido JET ${pedidoId}:`, error.message);
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;
    
    try {
      return {
        id: dados.Id || dados.id,
        cliente: dados.Customer?.Name || dados.customer?.name || 'N/A',
        email: dados.Customer?.Email || dados.customer?.email || 'N/A',
        telefone: dados.Customer?.Phone || dados.customer?.phone || 'N/A',
        status: dados.Status || dados.status,
        valor_total: dados.TotalAmount || dados.totalAmount || 0,
        data_pedido: dados.CreatedAt || dados.createdAt,
        endereco: {
          rua: dados.ShippingAddress?.Street || dados.shippingAddress?.street,
          numero: dados.ShippingAddress?.Number || dados.shippingAddress?.number,
          cidade: dados.ShippingAddress?.City || dados.shippingAddress?.city,
          estado: dados.ShippingAddress?.State || dados.shippingAddress?.state,
          cep: dados.ShippingAddress?.ZipCode || dados.shippingAddress?.zipCode
        },
        produtos: (dados.Items || dados.items || []).map(item => ({
          sku: item.Sku || item.sku,
          nome: item.Name || item.name,
          quantidade: item.Quantity || item.quantity,
          preco: item.Price || item.price
        })),
        rastreamento: dados.TrackingNumber || dados.trackingNumber || null
      };
    } catch (error) {
      console.error('❌ Erro ao extrair info JET:', error.message);
      return null;
    }
  }
};

module.exports = jetApi;