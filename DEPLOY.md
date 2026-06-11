# Despliegue VPS

## 0. Auto-deploy con GitHub Actions

Cada push a `main` ejecuta `.github/workflows/deploy.yml`: chequea sintaxis y luego entra por SSH al VPS para hacer `git pull`, `npm ci` y `pm2 restart`.

Para activarlo, en GitHub → Settings del repo:

1. **Secrets and variables → Actions → Secrets**:
   - `VPS_HOST`: IP o dominio del VPS
   - `VPS_USER`: usuario SSH (ej. `deploy`)
   - `VPS_SSH_KEY`: clave privada SSH (contenido completo, generada con `ssh-keygen -t ed25519`; la publica va en `~/.ssh/authorized_keys` del VPS)
   - `VPS_PORT` (opcional): puerto SSH si no es 22
2. **Secrets and variables → Actions → Variables**: crear `DEPLOY_ENABLED` con valor `true`. Mientras no exista, el workflow solo corre el chequeo de sintaxis y se salta el deploy.

El workflow asume que el repo ya esta clonado en `/var/www/consultoria-digital` y que PM2 corre el proceso `consultoria-digital` (pasos 2 y 3 de abajo). Tambien se puede disparar a mano desde la pestana Actions ("Run workflow").

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
GOOGLE_CALENDAR_CTZ=America/Argentina/Buenos_Aires
GOOGLE_CALENDAR_MARKETING_ID=
GOOGLE_CALENDAR_DESARROLLO_ID=
GOOGLE_CALENDAR_ADMIN_ID=
```

Genera el secreto con:

```bash
openssl rand -hex 32
```
