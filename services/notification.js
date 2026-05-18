const axios = require('axios');

const sendAlert = async (message, severity = 'WARNING') => {
  try {
    // Slack
    if (process.env.SLACK_WEBHOOK_URL) {
      const color = severity === 'CRITICAL' ? 'danger' : 'warning';
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        attachments: [{
          color,
          title: `[${severity}] Monitor360 Alert`,
          text: message,
          ts: Math.floor(Date.now() / 1000)
        }]
      });
    }

    // Email (implementar com nodemailer se necessário)
    console.log(`[${severity}] ${message}`);
  } catch (error) {
    console.error('Erro ao enviar notificação:', error);
  }
};

module.exports = {
  sendAlert
};