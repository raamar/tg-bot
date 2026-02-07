# Nogi Bot

## Private Registry (SSH Tunnel)

This project supports building images locally and pushing to a private registry running on the server via an SSH tunnel.

### Server: run registry

```yaml
services:
  registry:
    image: registry:2
    container_name: private-registry
    restart: always
    ports:
      - '127.0.0.1:5000:5000'
    volumes:
      - /opt/registry:/var/lib/registry
```

### Docker daemon config (required)

Add the following to `/etc/docker/daemon.json` on **both**:

- your local machine (pushes via SSH tunnel to `localhost:5000`)
- the server (pulls from `localhost:5000`)

```json
{
  "insecure-registries": ["localhost:5000"]
}
```

Then restart Docker:

```bash
systemctl restart docker
```

### Build + push all images

Use the helper script:

```bash
./scripts/push_all.sh <ssh_alias|user@host> [ssh_port]
```

Example:

```bash
./scripts/push_all.sh root@1.2.3.4 22
```

### Deploy on server

After pushing:

```bash
docker compose -f docker-compose.prod.yml up -d
```

### Distribution basic auth (Traefik)

To protect the distribution service with basic auth, generate an htpasswd string and put it in `.env` as `DISTRIBUTION_PASSWORD`.

Example (admin + random password):

```bash
PASS=$(openssl rand -base64 12)
HASH=$(openssl passwd -apr1 "$PASS")
echo "Login: admin"
echo "Password: $PASS"
echo "DISTRIBUTION_PASSWORD=admin:$HASH"
```
