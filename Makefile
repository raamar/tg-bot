up:
	docker compose up --build

up-prod:
	docker compose -f docker-compose.prod.yml up --build -d

down:
	docker compose down

restart:
	docker compose restart

down-hard:
	@read -p "⚠️  Это удалит все данные! Продолжить? (y/N): " confirm && \
	if [ "$$confirm" = "y" ]; then \
		docker compose down -v; \
	else \
		echo "Операция отменена."; \
	fi

studio:
	docker compose exec bot npx prisma studio

logs:
	docker compose logs -f --tail=100

include .env
export

DOMAIN ?= $(PUBLIC_DOMAIN)
EMAIL ?= $(CERTBOT_EMAIL)

cert-init:
	@echo "🔐 Generating initial certificate for domain: $(DOMAIN)"
	docker compose -f docker-compose.prod.yml run --rm certbot certonly \
		--webroot -w /var/www/certbot \
		--email $(EMAIL) \
		--agree-tos --no-eff-email \
		-d $(DOMAIN)
