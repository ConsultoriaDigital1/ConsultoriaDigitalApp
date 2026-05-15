# Despliegue VPS

## 1. Preparar la base PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib nodejs npm nginx
sudo -u postgres psql
```

```sql
CREATE DATABASE consultoria_digital;
CREATE USER consultoria_user WITH ENCRYPTED PASSWORD 'CAMBIAR_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE consultoria_digital TO consultoria_user;
\q
```

## 2. Subir y preparar el repo

```bash
git clone URL_DEL_REPO /var/www/consultoria-digital
cd /var/www/consultoria-digital
cp .env.example .env
nano .env
npm ci
npm run db:schema
npm run db:seed
```

Usuarios iniciales:

- `admin` / `Motomipasion1`
- `juan` / `pass123`
- `ana` / `pass123`

Cambia esas contrasenas al entrar.

## 3. Levantar Node con PM2

```bash
sudo npm i -g pm2
pm2 start server.js --name consultoria-digital
pm2 save
pm2 startup
```

## 4. Nginx

```nginx
server {
  server_name tu-dominio.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tu-dominio.com
```

En produccion usa:

```env
NODE_ENV=production
COOKIE_SECURE=true
SESSION_SECRET=pega_aqui_el_resultado_de_openssl_rand_hex_32
```

Genera el secreto con:

```bash
openssl rand -hex 32
```
