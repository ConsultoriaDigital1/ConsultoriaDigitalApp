module.exports = {
  apps: [{
    name: 'consultoria-digital',
    script: './server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '750M',
    exp_backoff_restart_delay: 100,
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
