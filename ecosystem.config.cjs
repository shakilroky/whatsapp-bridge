module.exports = {
  apps: [
    {
      name: "nexora-whatsapp-bridge",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3300,
        WP_WEBHOOK_URL: "https://metromaa.com/wp-json/socialsync/v1/webhook",
        WP_VERIFY_TOKEN: "my_secret_token_123"
      }
    }
  ]
};
